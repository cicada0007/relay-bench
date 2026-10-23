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
		const result = await draftTask({ candidate: candidateFor(up, "javascript"), tasksDir, modelId: "gpt-test", model: f.model, github: f.github, now: new Date("2026-10-23T00:00:00Z") });
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
		await draftTask({ candidate: candidateFor(up, "python"), tasksDir, model: f.model, github: f.github, tier: "check" });
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
			draftTask({ candidate: candidateFor(up, "javascript"), tasksDir, model: f.model, github: f.github }),
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
		await assert.rejects(draftTask({ candidate: candidateFor(up, "javascript"), tasksDir, model: f.model, github: f.github }), /no test fails before the fix/);
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
