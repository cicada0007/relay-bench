// draft-task on two small local repositories built here (one Node, one Python), each with a "pull request" ref, a fake
// GitHub client and a fake model. No network, no model call. The drafted judge must fail the starting repository and
// pass the reference, and the request must never see the fix.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { chooseChecks, draftTask, gatesFor, isRunnableTest, leakProblems, openaiClient, REQUEST_INSTRUCTIONS } from "./draft-task.mjs";
import { E2B_USD_PER_SECOND, openLedger, SpendCapError } from "./draft-spend.mjs";
import { openE2BJudge, openLocalJudge } from "./e2b-judge.mjs";
import { TEMPLATE_NAME } from "../sandbox/template.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);

const hasPython = (() => {
	try {
		execFileSync("python3", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

function write(dir, files) {
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
}
const g = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** An upstream repository: a base commit, a fix branch published as refs/pull/7/head, and one more commit on main. */
function upstream({ base, fix, later }) {
	const dir = mkdtempSync(join(tmpdir(), "draft-upstream-"));
	g(dir, "init", "-q", "-b", "main");
	write(dir, base);
	g(dir, "add", "-A");
	g(dir, "commit", "-q", "-m", "base");
	g(dir, "checkout", "-q", "-b", "fix");
	write(dir, fix);
	g(dir, "add", "-A");
	g(dir, "commit", "-q", "-m", "fix");
	const head = g(dir, "rev-parse", "HEAD");
	g(dir, "update-ref", "refs/pull/7/head", head);
	g(dir, "checkout", "-q", "main");
	write(dir, later);
	g(dir, "add", "-A");
	g(dir, "commit", "-q", "-m", "later");
	return { dir, head, mainTip: g(dir, "rev-parse", "HEAD") };
}

const NODE = {
	base: {
		"package.json": JSON.stringify({ name: "tiny-math", version: "1.0.0", scripts: { test: "node --test" } }),
		"lib/math.js": "exports.sum = (a, b) => a - b;\nexports.double = (a) => a * 2;\n",
		"test/double.test.js": 'const test = require("node:test");\nconst assert = require("node:assert");\nconst { double } = require("../lib/math.js");\ntest("doubles", () => assert.equal(double(4), 8));\n',
		"test/helpers/numbers.js": "exports.three = 3;\n",
		"README.md": "# tiny-math\n\nRun the tests with npm test.\n",
	},
	fix: {
		"lib/math.js": "exports.sum = (a, b) => a + b; // add the two numbers together\nexports.double = (a) => a * 2;\n",
		"test/sum.test.js":
			'const test = require("node:test");\nconst assert = require("node:assert");\nconst { sum } = require("../lib/math.js");\nconst { three } = require("./helpers/numbers.js");\ntest.describe("sum", () => {\n  test.it("adds two numbers", () => assert.equal(sum(2, three), 5));\n  test.it("adds zero", () => assert.equal(sum(three, 0), 3));\n});\n',
		"test/double.test.js":
			'const test = require("node:test");\nconst assert = require("node:assert");\nconst { double, sum } = require("../lib/math.js");\ntest("doubles", () => assert.equal(double(4), 8));\ntest("double is a sum", () => assert.equal(double(3), sum(3, 3)));\n',
	},
	later: { "CHANGELOG.md": "later work on main\n" },
};

const PYTHON = {
	base: {
		"calc/__init__.py": "",
		"calc/ops.py": "def mean(values):\n    return sum(values) / (len(values) + 1)\n\n\ndef total(values):\n    return sum(values)\n",
		"tests/__init__.py": "",
		"tests/test_total.py": "import unittest\n\nfrom calc.ops import total\n\n\nclass TotalTest(unittest.TestCase):\n    def test_total(self):\n        self.assertEqual(total([1, 2]), 3)\n",
		"tests/test_ops.py": "import unittest\n\nfrom calc.ops import total\n\n\nclass OpsTest(unittest.TestCase):\n    def test_total_empty(self):\n        self.assertEqual(total([]), 0)\n",
	},
	fix: {
		"calc/ops.py": "def mean(values):\n    if not values:\n        raise ValueError('mean of no values')\n    return sum(values) / len(values)\n\n\ndef total(values):\n    return sum(values)\n",
		"tests/test_ops.py":
			"import unittest\n\nfrom calc.ops import mean, total\n\n\nclass OpsTest(unittest.TestCase):\n    def test_total_empty(self):\n        self.assertEqual(total([]), 0)\n\n    def test_mean(self):\n        self.assertEqual(mean([2, 4]), 3)\n\n    def test_mean_empty(self):\n        with self.assertRaises(ValueError):\n            mean([])\n",
	},
	later: { "NOTES.txt": "later\n" },
};

const ISSUE = { number: 3, title: "sum() gives the wrong answer", body: "Calling sum(2, 3) returns -1 instead of 5. I expected the two numbers added together.\n\nI think you could change `a - b` to `a + b`." };

function candidateFor(up, language) {
	return {
		id: `example-${language}-7`,
		repo: "example/tiny",
		repoUrl: "https://github.com/example/tiny",
		cloneUrl: up.dir,
		license: "MIT",
		language,
		baseCommit: up.mainTip,
		headCommit: up.head,
		pr: { number: 7, url: "https://github.com/example/tiny/pull/7", mergedAt: "2026-10-01T00:00:00Z" },
		issue: { number: 3, url: "https://github.com/example/tiny/issues/3", createdAt: "2026-09-30T00:00:00Z" },
	};
}

function fakes(requestText) {
	const calls = [];
	return {
		calls,
		model: {
			async complete(args) {
				calls.push(args);
				return { text: requestText, model: "gpt-test-2026-10-01", usage: { input_tokens: 10, output_tokens: 20 } };
			},
		},
		github: { async get(path) { return path === "/repos/example/tiny/issues/3" ? ISSUE : null; } },
	};
}

function judge(taskDir, tree) {
	const out = execFileSync(process.execPath, [join(taskDir, "judge", "judge.mjs"), join(taskDir, tree)], { encoding: "utf8" });
	return JSON.parse(out.trim().split("\n").pop());
}

test("a Node pull request becomes a task whose judge fails the starting repository and passes the fix", async () => {
	const up = upstream(NODE);
	const tasksDir = mkdtempSync(join(tmpdir(), "draft-tasks-"));
	const f = fakes("Make sum add its two numbers.\n\nCalling `sum(2, 3)` should return 5; today it returns -1.\n\nAdd or update tests for the change in the repository's existing test style.");
	try {
		const result = await draftTask({ candidate: candidateFor(up, "javascript"), tasksDir, modelId: "gpt-test", model: f.model, github: f.github, openJudge: openLocalJudge, now: new Date("2026-10-23T00:00:00Z") });
		const dir = join(tasksDir, "example-javascript-7");
		assert.equal(result.dir, dir);
		const task = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
		assert.equal(task.tier, "exam");
		assert.equal(task.level, 1);
		assert.equal(task.kind, "everyday");
		assert.equal(task.draftedBy, "openai/gpt-test-2026-10-01");
		assert.equal(task.source.issue, "https://github.com/example/tiny/issues/3");
		assert.equal(task.source.pr, "https://github.com/example/tiny/pull/7");
		assert.equal(task.private, true);
		assert.deepEqual(task.gates, { test: "npm test" });
		assert.equal(task.approvedBy, undefined);
		// The merge base, not the later main tip, is the starting point.
		assert.notEqual(task.source.baseCommit, up.mainTip);
		assert.ok(!existsSync(join(dir, "repo", "CHANGELOG.md")));
		assert.ok(!existsSync(join(dir, "repo", "test", "sum.test.js")), "the pull request's tests stay hidden");
		assert.ok(existsSync(join(dir, "judge", "hidden", "test", "sum.test.js")));
		const config = JSON.parse(readFileSync(join(dir, "judge", "judge.json"), "utf8"));
		assert.deepEqual(config.checks.R1, ["test/double.test.js::double is a sum", "test/sum.test.js::sum > adds two numbers"]);
		// A new test that already passes before the fix guards what worked before: it is an R0 check.
		assert.deepEqual(config.checks.R0, ["test/double.test.js::doubles", "test/sum.test.js::sum > adds zero"]);
		assert.ok(!config.tests.run.includes("test/helpers/numbers.js"));
		assert.match(readFileSync(join(dir, "judge", "CHECKS.md"), "utf8"), /R1\.1 \[/);

		const onRepo = judge(dir, "repo");
		assert.deepEqual([onRepo.requirements.R1, onRepo.R0, onRepo.checks.R1], [false, true, [0, 2]]);
		const onReference = judge(dir, "reference");
		assert.deepEqual([onReference.requirements.R1, onReference.R0, onReference.gates.test, onReference.checks.R1], [true, true, true, [2, 2]]);

		// The model saw the issue and the rules, never the fix.
		assert.equal(f.calls.length, 1);
		assert.equal(f.calls[0].instructions, REQUEST_INSTRUCTIONS);
		assert.match(f.calls[0].instructions, /Never say how to fix it/);
		assert.match(f.calls[0].input, /returns -1 instead of 5/);
		assert.doesNotMatch(f.calls[0].input, /add the two numbers together/);
	} finally {
		rmSync(up.dir, { recursive: true, force: true });
		rmSync(tasksDir, { recursive: true, force: true });
	}
});

test("a Python pull request becomes a task too, with changed and unchanged tests kept apart", { skip: !hasPython && "python3 is not installed" }, async () => {
	const up = upstream(PYTHON);
	const tasksDir = mkdtempSync(join(tmpdir(), "draft-tasks-"));
	const f = fakes("Fix mean.\n\n`mean([2, 4])` should be 3, and `mean([])` should raise ValueError.\n");
	try {
		await draftTask({ candidate: candidateFor(up, "python"), tasksDir, model: f.model, github: f.github, openJudge: openLocalJudge, tier: "check" });
		const dir = join(tasksDir, "example-python-7");
		const task = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
		assert.equal(task.tier, "check");
		assert.deepEqual(task.stack, ["python3"]);
		assert.deepEqual(task.gates, { test: "python3 -m unittest discover -s tests -q" });
		const config = JSON.parse(readFileSync(join(dir, "judge", "judge.json"), "utf8"));
		assert.deepEqual(config.checks.R1, ["tests/test_ops.py::OpsTest.test_mean", "tests/test_ops.py::OpsTest.test_mean_empty"]);
		assert.deepEqual(config.checks.R0, ["tests/test_ops.py::OpsTest.test_total_empty", "tests/test_total.py::TotalTest.test_total"]);
		assert.deepEqual(config.tests.original, ["tests/__init__.py", "tests/test_total.py"]);
		const onRepo = judge(dir, "repo");
		assert.deepEqual([onRepo.requirements.R1, onRepo.R0], [false, true]);
		const onReference = judge(dir, "reference");
		assert.deepEqual([onReference.requirements.R1, onReference.R0, onReference.gates.test], [true, true, true]);
	} finally {
		rmSync(up.dir, { recursive: true, force: true });
		rmSync(tasksDir, { recursive: true, force: true });
	}
});

test("a drafted request that repeats the fix is refused and nothing is written", async () => {
	const up = upstream(NODE);
	const tasksDir = mkdtempSync(join(tmpdir(), "draft-tasks-"));
	const f = fakes("Fix sum. Change it to: exports.sum = (a, b) => a + b; // add the two numbers together\n");
	try {
		await assert.rejects(
			draftTask({ candidate: candidateFor(up, "javascript"), tasksDir, model: f.model, github: f.github, openJudge: openLocalJudge }),
			/repeats a line the fix added/,
		);
		assert.ok(!existsSync(join(tasksDir, "example-javascript-7")));
	} finally {
		rmSync(up.dir, { recursive: true, force: true });
		rmSync(tasksDir, { recursive: true, force: true });
	}
});

test("a pull request whose tests already pass before the fix costs no model call", async () => {
	const up = upstream({ ...NODE, fix: { "lib/math.js": NODE.base["lib/math.js"].replace("a * 2", "2 * a"), "test/double.test.js": NODE.base["test/double.test.js"] + "// note\n" } });
	const tasksDir = mkdtempSync(join(tmpdir(), "draft-tasks-"));
	const f = fakes("anything");
	try {
		await assert.rejects(draftTask({ candidate: candidateFor(up, "javascript"), tasksDir, model: f.model, github: f.github, openJudge: openLocalJudge }), /no test fails before the fix/);
		assert.equal(f.calls.length, 0);
	} finally {
		rmSync(up.dir, { recursive: true, force: true });
		rmSync(tasksDir, { recursive: true, force: true });
	}
});

test("the leak check catches diffs, references and the judge", () => {
	assert.deepEqual(leakProblems("Make sum add.\n", {}), []);
	assert.ok(leakProblems("```diff\n-a\n+b\n```", {}).includes("the request contains a diff"));
	assert.ok(leakProblems("See https://github.com/x/y/pull/7", {}).some((p) => /GitHub/.test(p)));
	assert.ok(leakProblems("As in #12, fix it.", { issueNumber: 12 }).includes("the request names #12"));
	assert.ok(leakProblems("The hidden tests check this.", {}).some((p) => /judge/.test(p)));
	assert.deepEqual(leakProblems("short line", { addedLines: ["x = 1"] }), [], "short added lines are not matched");
});

test("checks are chosen from outcomes before and twice after the fix", () => {
	const before = { a: "fail", b: "pass", c: "pass", d: "fail" };
	const after = { a: "pass", b: "pass", c: "fail", d: "pass", e: "skip" };
	const again = { a: "pass", b: "pass", c: "fail", d: "fail", e: "skip" };
	const checks = chooseChecks(before, after, again);
	assert.deepEqual(checks.R1, ["a"]);
	assert.deepEqual(checks.R0, ["b"]);
	assert.deepEqual(checks.left.map((l) => l.id), ["c", "d", "e"]);
});

test("gates and runnable tests follow each language's own defaults", () => {
	assert.deepEqual(gatesFor("python", ["src/pkg/__init__.py", "tests/test_a.py"]), { test: "PYTHONPATH=src python3 -m unittest discover -s tests -q" });
	assert.deepEqual(gatesFor("python", ["pkg/__init__.py", "test_a.py"]), { test: "python3 -m unittest discover -q" });
	assert.ok(isRunnableTest("tests/test_a.py", "python"));
	assert.ok(!isRunnableTest("tests/helpers.py", "python"));
	assert.ok(isRunnableTest("test/a.js", "node"));
	assert.ok(isRunnableTest("lib/a.test.mjs", "node"));
	assert.ok(!isRunnableTest("test/fixtures/a.js", "node"));
});

test("the OpenAI client posts to the Responses API with the key and reads the text back", async () => {
	const sent = [];
	const client = openaiClient({
		apiKey: "sk-test",
		fetch: async (url, init) => {
			sent.push({ url, init });
			return new Response(JSON.stringify({ model: "gpt-x-2026", output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "Do it." }] }], usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200 });
		},
	});
	const reply = await client.complete({ model: "gpt-x", instructions: "rules", input: "issue" });
	assert.equal(reply.text, "Do it.");
	assert.equal(reply.model, "gpt-x-2026");
	assert.equal(sent[0].url, "https://api.openai.com/v1/responses");
	assert.equal(sent[0].init.headers.authorization, "Bearer sk-test");
	assert.equal(JSON.parse(sent[0].init.body).instructions, "rules");
	assert.throws(() => openaiClient({}), /OPENAI_API_KEY/);
});

// ---- The judge check in E2B, and the drafting ledger ----

/**
 * A fake E2B: each sandbox is a scratch folder standing in for /home/user, and its commands run here with sh. It
 * records what each sandbox was created with, every command's environment, and every kill.
 */
function fakeE2B({ failCreate = false } = {}) {
	const seen = { created: [], commands: [], killed: 0, killedAt: [] };
	class Sandbox {
		static async create(template, opts) {
			if (failCreate) throw new Error("no capacity");
			const box = new Sandbox(mkdtempSync(join(tmpdir(), "fake-e2b-")), `fake-${seen.created.length + 1}`);
			seen.created.push({ template, opts });
			return box;
		}
		constructor(home, id) {
			this.home = home;
			this.sandboxId = id;
			const here = (text) => text.replaceAll("/home/user", home);
			this.files = {
				write: async (path, data) => {
					mkdirSync(dirname(here(path)), { recursive: true });
					writeFileSync(here(path), data);
				},
				read: async (path) => readFileSync(here(path), "utf8"),
			};
			this.commands = {
				run: async (command, opts = {}) => {
					seen.commands.push({ command, envs: opts.envs });
					try {
						const stdout = execFileSync("sh", ["-c", here(command.replace(/^export PATH=[^;]*; /, ""))], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
						return { exitCode: 0, stdout, stderr: "" };
					} catch (error) {
						throw Object.assign(new Error("exit"), { exitCode: error.status, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") });
					}
				},
			};
		}
		async kill() {
			seen.killed++;
			seen.killedAt.push(Date.now());
			rmSync(this.home, { recursive: true, force: true });
		}
	}
	return { Sandbox, seen };
}

/** A clock that moves a minute every time it is read, so a sandbox opened and closed lives exactly 60 seconds. */
const minuteClock = () => {
	let t = 0;
	return () => (t += 60_000);
};

const LUNA_REPLY = { model: "gpt-6-luna-2026-09-30", status: "completed", serviceTier: "default", usage: { input_tokens: 900, output_tokens: 700, output_tokens_details: { reasoning_tokens: 400 } } };

function countingFakes(text, reply = LUNA_REPLY, seen) {
	const calls = [];
	return {
		calls,
		model: {
			async complete(args) {
				calls.push({ ...args, killedBefore: seen?.killed ?? 0 });
				return { ...reply, text };
			},
		},
		github: { async get(path) { return path === "/repos/example/tiny/issues/3" ? ISSUE : null; } },
	};
}

test("the judge check runs in an E2B sandbox with no keys, which is killed before the model is called and counted", async () => {
	const up = upstream(NODE);
	const root = mkdtempSync(join(tmpdir(), "draft-e2b-"));
	const tasksDir = join(root, "tasks");
	const e2b = fakeE2B();
	const ledger = openLedger(join(root, "drafting", "spend.json"), { caps: { openai: 1, e2b: 1 } });
	const f = countingFakes("Make sum add its two numbers.\n\nCalling `sum(2, 3)` should return 5; today it returns -1.\n", LUNA_REPLY, e2b.seen);
	const saved = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "sk-must-never-reach-a-sandbox";
	try {
		const result = await draftTask({
			candidate: candidateFor(up, "javascript"),
			tasksDir,
			modelId: "gpt-6-luna",
			effort: "medium",
			maxOutputTokens: 3000,
			model: f.model,
			github: f.github,
			ledger,
			openJudge: (o) => openE2BJudge({ ...o, ledger, Sandbox: e2b.Sandbox, clock: minuteClock() }),
		});
		// One sandbox, from the round's image, with no environment of its own; no command carries a key.
		assert.equal(e2b.seen.created.length, 1);
		assert.equal(e2b.seen.created[0].template, TEMPLATE_NAME);
		assert.deepEqual(e2b.seen.created[0].opts.envs, {});
		const everything = JSON.stringify(e2b.seen);
		assert.doesNotMatch(everything, /sk-must-never/);
		for (const c of e2b.seen.commands) assert.ok(!Object.keys(c.envs ?? {}).some((k) => /KEY|TOKEN|SECRET/.test(k)), c.command);
		// Five judge runs, all in the sandbox: three to read the outcomes, two to check the judge.
		assert.equal(e2b.seen.commands.filter((c) => /judge\/judge\.mjs/.test(c.command)).length, 5);
		assert.equal(e2b.seen.commands.filter((c) => /--outcomes/.test(c.command)).length, 3);
		// Each judge line goes to a file in the sandbox and is read back whole: a pipe cuts a long line at 64 KiB.
		assert.ok(e2b.seen.commands.filter((c) => /judge\/judge\.mjs/.test(c.command)).every((c) => /> \/home\/user\/judge-run-\d+\.out$/.test(c.command)));
		assert.equal(e2b.seen.killed, 1);
		assert.equal(f.calls.length, 1);
		assert.equal(f.calls[0].killedBefore, 1, "the sandbox is gone before the model is called");
		assert.equal(f.calls[0].effort, "medium");
		assert.equal(f.calls[0].maxOutputTokens, 3000);
		assert.deepEqual(result.judgeCheck, { where: "e2b", sandboxId: "fake-1", seconds: 60, costUsd: 60 * E2B_USD_PER_SECOND });

		const config = JSON.parse(readFileSync(join(result.dir, "judge", "judge.json"), "utf8"));
		assert.deepEqual(config.checks.R1, ["test/double.test.js::double is a sum", "test/sum.test.js::sum > adds two numbers"]);

		const book = JSON.parse(readFileSync(ledger.path, "utf8"));
		assert.equal(book.e2b.sandboxes.length, 1);
		assert.deepEqual([book.e2b.sandboxes[0].state, book.e2b.sandboxes[0].seconds, book.e2b.sandboxes[0].sandboxId, book.e2b.sandboxes[0].purpose], ["settled", 60, "fake-1", "draft-judge"]);
		assert.equal(book.openai.calls.length, 1);
		const call = book.openai.calls[0];
		assert.deepEqual([call.state, call.outcome, call.model, call.reported, call.effort, call.maxOutputTokens], ["settled", "drafted", "gpt-6-luna", "gpt-6-luna-2026-09-30", "medium", 3000]);
		assert.equal(call.costUsd, (900 * 0.1 + 700 * 0.5) / 1e6);
		assert.ok(call.boundUsd >= call.costUsd);
		assert.equal(result.costUsd, call.costUsd);

		// The judge's checkout mode, as validate-task.mjs uses it in E2B: the drafted judge fails repo/ and passes reference/.
		const judge = await openE2BJudge({ dir: result.dir, label: "validate", purpose: "validate", ledger, Sandbox: e2b.Sandbox, minutes: 20 });
		const onRepo = await judge.run("repo", { checkout: true });
		const onReference = await judge.run("reference", { checkout: true });
		await judge.close();
		assert.deepEqual([onRepo.requirements.R1, onRepo.R0, onReference.requirements.R1, onReference.R0, onReference.gates.test], [false, true, true, true, true]);
		assert.equal(e2b.seen.killed, 2);
		await assert.rejects(judge.run("../etc"), /not a tree/);
	} finally {
		if (saved === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = saved;
		rmSync(up.dir, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("a candidate that cannot be judged still has its sandbox killed and counted, and costs no model call", async () => {
	const up = upstream({ ...NODE, fix: { "lib/math.js": NODE.base["lib/math.js"].replace("a * 2", "2 * a"), "test/double.test.js": NODE.base["test/double.test.js"] + "// note\n" } });
	const root = mkdtempSync(join(tmpdir(), "draft-e2b-"));
	const e2b = fakeE2B();
	const ledger = openLedger(join(root, "spend.json"), { caps: { openai: 1, e2b: 1 } });
	const f = countingFakes("anything");
	try {
		await assert.rejects(
			draftTask({ candidate: candidateFor(up, "javascript"), tasksDir: join(root, "tasks"), modelId: "gpt-6-luna", model: f.model, github: f.github, ledger, openJudge: (o) => openE2BJudge({ ...o, ledger, Sandbox: e2b.Sandbox, clock: minuteClock() }) }),
			/no test fails before the fix/,
		);
		assert.equal(e2b.seen.killed, 1);
		assert.equal(f.calls.length, 0);
		const t = ledger.totals();
		assert.equal(t.openai.calls, 0);
		assert.equal(t.e2b.sandboxes, 1);
		assert.equal(t.e2b.spentUsd, Math.round(60 * E2B_USD_PER_SECOND * 1e6) / 1e6);
	} finally {
		rmSync(up.dir, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("caps refuse before anything paid starts: no sandbox when E2B is spent, no judge check when OpenAI is", async () => {
	const up = upstream(NODE);
	const root = mkdtempSync(join(tmpdir(), "draft-e2b-"));
	const e2b = fakeE2B();
	const f = countingFakes("Make sum add.\n");
	const opened = [];
	try {
		// E2B: a 30-minute sandbox could cost $0.0828, more than this cap leaves.
		const small = openLedger(join(root, "a.json"), { caps: { openai: 1, e2b: 0.05 } });
		await assert.rejects(
			draftTask({ candidate: candidateFor(up, "javascript"), tasksDir: join(root, "tasks"), modelId: "gpt-6-luna", model: f.model, github: f.github, ledger: small, openJudge: (o) => openE2BJudge({ ...o, ledger: small, Sandbox: e2b.Sandbox }) }),
			(e) => e instanceof SpendCapError && /e2b/.test(e.message),
		);
		assert.equal(e2b.seen.created.length, 0);
		// OpenAI: one more Sol call could cross the cap, so the judge check is never opened.
		const spent = openLedger(join(root, "b.json"), { caps: { openai: 0.05, e2b: 1 } });
		await assert.rejects(
			draftTask({ candidate: candidateFor(up, "javascript"), tasksDir: join(root, "tasks"), modelId: "gpt-6.1-sol", model: f.model, github: f.github, ledger: spent, openJudge: (o) => opened.push(o) }),
			(e) => e instanceof SpendCapError && /OpenAI/.test(e.message),
		);
		// No cap at all refuses too, and a model with no list price cannot be bounded.
		const none = openLedger(join(root, "c.json"));
		await assert.rejects(draftTask({ candidate: candidateFor(up, "javascript"), tasksDir: join(root, "tasks"), modelId: "gpt-6-luna", model: f.model, github: f.github, ledger: none, openJudge: (o) => opened.push(o) }), /no OpenAI spending cap/);
		await assert.rejects(draftTask({ candidate: candidateFor(up, "javascript"), tasksDir: join(root, "tasks"), modelId: "gpt-test", model: f.model, github: f.github, ledger: spent, openJudge: (o) => opened.push(o) }), /no list price for gpt-test/);
		await assert.rejects(draftTask({ candidate: candidateFor(up, "javascript"), tasksDir: join(root, "tasks"), effort: "high", model: f.model, github: f.github, openJudge: openLocalJudge }), /--effort must be low or medium/);
		assert.equal(opened.length, 0);
		assert.equal(f.calls.length, 0);
		// A sandbox that fails to start is still counted for the time it took.
		const failing = fakeE2B({ failCreate: true });
		const ledger = openLedger(join(root, "d.json"), { caps: { openai: 1, e2b: 1 } });
		await assert.rejects(openE2BJudge({ dir: up.dir, label: "x", ledger, Sandbox: failing.Sandbox, clock: minuteClock() }), /could not start an E2B sandbox: no capacity/);
		const entry = JSON.parse(readFileSync(ledger.path, "utf8")).e2b.sandboxes[0];
		assert.deepEqual([entry.state, entry.seconds, entry.error], ["settled", 60, "no capacity"]);
	} finally {
		rmSync(up.dir, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("a draft the leak check refuses is still counted, and kept for the reviewers", async () => {
	const up = upstream(NODE);
	const root = mkdtempSync(join(tmpdir(), "draft-e2b-"));
	const ledger = openLedger(join(root, "drafting", "spend.json"), { caps: { openai: 1, e2b: 1 } });
	const f = countingFakes("Fix sum. Change it to: exports.sum = (a, b) => a + b; // add the two numbers together\n");
	try {
		await assert.rejects(
			draftTask({ candidate: candidateFor(up, "javascript"), tasksDir: join(root, "tasks"), modelId: "gpt-6-luna", model: f.model, github: f.github, ledger, refusedDir: join(root, "drafting", "refused"), openJudge: openLocalJudge }),
			/repeats a line the fix added/,
		);
		const call = JSON.parse(readFileSync(ledger.path, "utf8")).openai.calls[0];
		assert.deepEqual([call.state, call.outcome], ["settled", "refused"]);
		assert.equal(call.costUsd, (900 * 0.1 + 700 * 0.5) / 1e6);
		assert.match(call.why[0], /repeats a line the fix added/);
		const kept = readFileSync(join(root, "drafting", "refused", "example-javascript-7.gpt-6-luna.md"), "utf8");
		assert.match(kept, /refused by draft-task's leak check/);
		assert.match(kept, /a \+ b/);
		assert.equal(call.refusedDraft, join(root, "drafting", "refused", "example-javascript-7.gpt-6-luna.md"));
		assert.ok(!existsSync(join(root, "tasks", "example-javascript-7")));

		// An answer cut short at max_output_tokens is counted too, and nothing is written.
		const cut = countingFakes("", { ...LUNA_REPLY, status: "incomplete", incompleteReason: "max_output_tokens", usage: { input_tokens: 900, output_tokens: 6000 } });
		await assert.rejects(
			draftTask({ candidate: candidateFor(up, "javascript"), tasksDir: join(root, "tasks"), modelId: "gpt-6-luna", model: cut.model, github: cut.github, ledger, openJudge: openLocalJudge }),
			/cut short \(max_output_tokens\)/,
		);
		const second = JSON.parse(readFileSync(ledger.path, "utf8")).openai.calls[1];
		assert.deepEqual([second.state, second.outcome, second.costUsd], ["settled", "incomplete", (900 * 0.1 + 6000 * 0.5) / 1e6]);
		// A request OpenAI turns away (4xx) costs nothing; one that fails any other way stays counted at its most.
		for (const [status, counted] of [[400, 0], [undefined, "bound"]]) {
			const broken = { model: { async complete() { throw Object.assign(new Error(`OpenAI ${status}`), { status }); } }, github: cut.github };
			await assert.rejects(draftTask({ candidate: candidateFor(up, "javascript"), tasksDir: join(root, "tasks"), modelId: "gpt-6-luna", model: broken.model, github: broken.github, ledger, openJudge: openLocalJudge }), /OpenAI/);
			const last = JSON.parse(readFileSync(ledger.path, "utf8")).openai.calls.at(-1);
			if (counted === 0) assert.deepEqual([last.state, last.costUsd, last.outcome], ["settled", 0, "error"]);
			else assert.deepEqual([last.state, last.costUsd, last.outcome], ["unknown", undefined, "error"]);
		}
		const book = JSON.parse(readFileSync(ledger.path, "utf8"));
		assert.equal(book.openai.spentUsd, Math.round(((900 * 0.1 + 700 * 0.5) / 1e6 + (900 * 0.1 + 6000 * 0.5) / 1e6 + book.openai.calls[3].boundUsd) * 1e6) / 1e6);
	} finally {
		rmSync(up.dir, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("the OpenAI client bounds each call and returns an answer cut short instead of throwing", async () => {
	const sent = [];
	const reply = (status, body) => async (url, init) => {
		sent.push(JSON.parse(init.body));
		return new Response(JSON.stringify(body), { status });
	};
	const cut = openaiClient({ apiKey: "sk-test", fetch: reply(200, { model: "gpt-6-luna-x", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, service_tier: "default", output: [{ type: "reasoning" }], usage: { input_tokens: 5, output_tokens: 50 } }) });
	const r = await cut.complete({ model: "gpt-6-luna", instructions: "rules", input: "issue", maxOutputTokens: 50, effort: "medium" });
	assert.deepEqual([r.text, r.status, r.incompleteReason, r.serviceTier, r.usage.output_tokens], ["", "incomplete", "max_output_tokens", "default", 50]);
	assert.deepEqual([sent[0].max_output_tokens, sent[0].reasoning, sent[0].service_tier, sent[0].store], [50, { effort: "medium" }, "default", false]);
	await cut.complete({ model: "gpt-6-luna", instructions: "rules", input: "issue" });
	assert.deepEqual([sent[1].max_output_tokens, sent[1].reasoning.effort], [6000, "low"]);
	const refused = openaiClient({ apiKey: "sk-test", fetch: reply(400, { error: { message: "unknown parameter" } }) });
	await assert.rejects(refused.complete({ model: "m", instructions: "i", input: "x" }), (e) => e.status === 400 && /OpenAI 400: unknown parameter/.test(e.message));
});

test("the command refuses to run the judge check on this machine unless told it is a test", () => {
	const root = mkdtempSync(join(tmpdir(), "draft-cli-"));
	try {
		const env = { ...process.env };
		delete env.E2B_API_KEY;
		const run = (args) => {
			try {
				execFileSync(process.execPath, [join(HERE, "draft-task.mjs"), "--candidate", "x", "--candidates", join(root, "none.jsonl"), "--tasks-dir", join(root, "tasks"), ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
				return "";
			} catch (error) {
				return String(error.stderr);
			}
		};
		assert.match(run([]), /runs in an E2B sandbox: set E2B_API_KEY/);
		// With --local-judge it gets as far as reading the candidates.
		assert.match(run(["--local-judge"]), /ENOENT|no candidate/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("validate-task judges an exam task in E2B only: here it needs --local-judge", async () => {
	const up = upstream(NODE);
	const tasksDir = mkdtempSync(join(tmpdir(), "draft-tasks-"));
	const f = fakes("Make sum add its two numbers.\n\nCalling `sum(2, 3)` should return 5; today it returns -1.\n");
	try {
		await draftTask({ candidate: candidateFor(up, "javascript"), tasksDir, model: f.model, github: f.github, openJudge: openLocalJudge });
		const env = { ...process.env };
		delete env.E2B_API_KEY;
		const validate = (...args) => {
			try {
				return { code: 0, out: execFileSync(process.execPath, [join(HERE, "validate-task.mjs"), "--tasks-dir", tasksDir, ...args, "example-javascript-7"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
			} catch (error) {
				return { code: error.status, out: `${error.stdout}${error.stderr}` };
			}
		};
		const refused = validate();
		assert.equal(refused.code, 1);
		assert.match(refused.out, /an exam task: its judge runs someone else's code, so it runs in an E2B sandbox; set E2B_API_KEY/);
		const local = validate("--local-judge");
		assert.equal(local.code, 0, local.out);
		assert.match(local.out, /ok {3}example-javascript-7/);
	} finally {
		rmSync(up.dir, { recursive: true, force: true });
		rmSync(tasksDir, { recursive: true, force: true });
	}
});
