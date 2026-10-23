#!/usr/bin/env node
// Turns one mined candidate (scripts/mine-tasks.mjs) into a task folder in the private exam repository, in
// TASK_FORMAT.md's shape (an everyday change, one part):
//
//   repo/        the repository at the pull request's base commit (where its branch left the base branch)
//   reference/   the repository at the pull request's head: the people's own fix, tests included
//   judge/       a hidden judge built from the pull request's tests (scripts/exam-judge/): R1 is the tests the pull
//                request added or changed that fail on repo/ and pass on reference/; R0 is every test that passed on both
//   request.md   the issue in plain words, written by a model from a DIFFERENT family than the one being improved
//                (OpenAI; TIERS.md "Written by another model family"). The model sees only the issue, never the fix,
//                and its instructions forbid saying how to fix it; the draft is refused if the text still repeats the
//                fix or names the issue or pull request.
//   task.json    with "tier", "draftedBy" (the model id the API reported), "draftedAt" and "source" (issue and pull
//                request URLs, commits, license). A founder who did not draft it approves it later (approve-task.mjs).
//
// The judge is checked before the model is called (it must fail repo/ and pass reference/), so a candidate that cannot
// be judged costs no model call. Then validate the task with validate-task.mjs, as every task is.
//
//   node scripts/draft-task.mjs --candidate <id> \
//     --candidates ../relay-exam/candidates.jsonl --tasks-dir ../relay-exam/tasks [--model gpt-6.1-sol] [--tier exam] [--level 1]
//
// The model's key is OPENAI_API_KEY, from the environment. It reads the issue from the GitHub API (GITHUB_TOKEN or
// GH_TOKEN if set; public issues need none) and clones the public repository read-only. Nothing is written to GitHub.
// --tasks-dir must be outside this public repository.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { githubClient, isTestPath, languageOf } from "./mine-tasks.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const JUDGE_TEMPLATE = join(ROOT, "scripts", "exam-judge");
export const DEFAULT_MODEL = "gpt-6.1-sol";

/** What the drafting model is told. It only ever sees the issue: the fix is never in its input. */
export const REQUEST_INSTRUCTIONS = `You write the task text for a coding test. You are given an issue that someone filed against a software project. Write the request a developer receives: what is wrong or what is wanted, in plain words, so that a careful developer who reads only your text and the project's code can make the change.

Rules:
- Describe the problem or the wanted behaviour, and how someone can tell it is done: what a user runs or calls, and what they should see. Use only what the issue says.
- Never say how to fix it. Do not give code for a fix, a patch, a diff, or the function, line or file to change, unless the issue itself names it as the place where the problem shows. Do not guess at the cause. If the issue suggests a fix, leave the suggestion out and keep only the problem.
- Keep the exact names a user types or sees: commands, options, public function names, error messages, and the inputs and outputs in the issue's examples. Keep a reproduction if the issue has one.
- Do not mention GitHub, the issue, its number or its author, pull requests, commits, the project's maintainers, tests that will be run, a benchmark, or a judge.
- Ignore template boilerplate, links to screenshots, and discussion that does not describe the problem.
- Write plain English in short sentences. Start with one short line that says what to do. Then the details. End with this line: "Add or update tests for the change in the repository's existing test style."
- Under 400 words. Output only the request text, with no preface.`;

/** The model's input: the issue's own title and text, nothing else. */
export const requestInput = (issue) => `Issue title: ${issue.title}\n\nIssue text:\n${(issue.body ?? "").trim()}\n`;

/** Why a drafted request cannot be used: it repeats the fix, or names the issue, the pull request or the judge. */
export function leakProblems(request, { addedLines = [], issueNumber, prNumber } = {}) {
	const problems = [];
	const text = request.trim();
	if (!text) return ["the request is empty"];
	const words = text.split(/\s+/).length;
	if (words > 600) problems.push(`the request has ${words} words; the limit is 600`);
	const squash = (s) => s.replace(/\s+/g, " ").trim();
	const flat = squash(text);
	for (const line of addedLines) {
		const l = squash(line);
		if (l.replace(/\s/g, "").length >= 24 && flat.includes(l)) problems.push(`the request repeats a line the fix added: ${l.slice(0, 120)}`);
	}
	if (/^```diff|^@@ |^\+\+\+ |^--- a\//m.test(text)) problems.push("the request contains a diff");
	if (/github\.com|pull request|\bPR\s*#?\d+|\bcommit\b/i.test(text)) problems.push("the request mentions GitHub, a pull request or a commit");
	for (const n of [issueNumber, prNumber].filter(Boolean)) {
		if (new RegExp(`#${n}\\b`).test(text)) problems.push(`the request names #${n}`);
	}
	if (/\b(judge|benchmark|hidden tests?)\b/i.test(text)) problems.push("the request mentions the judge or the benchmark");
	return problems;
}

/** OpenAI's Responses API, for the drafting model only. The key comes from the environment and is never printed. */
export function openaiClient({ apiKey, fetch: doFetch = globalThis.fetch, baseUrl = "https://api.openai.com" } = {}) {
	if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
	return {
		async complete({ model, instructions, input }) {
			const res = await doFetch(`${baseUrl}/v1/responses`, {
				method: "POST",
				headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
				body: JSON.stringify({ model, instructions, input: [{ role: "user", content: [{ type: "input_text", text: input }] }], store: false }),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(`OpenAI ${res.status}: ${body?.error?.message ?? "no message"}`);
			const text = (body.output ?? [])
				.filter((o) => o.type === "message")
				.flatMap((o) => o.content ?? [])
				.filter((c) => c.type === "output_text")
				.map((c) => c.text)
				.join("");
			return { text, model: body.model ?? model, usage: body.usage };
		},
	};
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }).trim();

/** A test file a runner should run, by the default patterns of `python3 -m unittest discover` and `node --test`. */
export function isRunnableTest(path, stack) {
	const name = basename(path);
	if (/(^|\/)(fixtures?|helpers?|__snapshots__|data)\//.test(path)) return false;
	if (stack === "python") return /^test.*\.py$/.test(name) || /_test\.py$/.test(name);
	return /\.(m|c)?js$/.test(name) && (/(^|[._-])test([._-]|$)|\.spec\./.test(name) || /(^|\/)test\//.test(path));
}

/** The repository's own test command, as its gate: npm test for Node; unittest discovery for Python. */
export function gatesFor(stack, paths) {
	if (stack === "node") return { test: "npm test" };
	const src = paths.some((p) => /^src\/[^/]+\/__init__\.py$/.test(p));
	const dir = ["tests", "test"].find((d) => paths.some((p) => p.startsWith(`${d}/`) && isRunnableTest(p, "python")));
	return { test: `${src ? "PYTHONPATH=src " : ""}python3 -m unittest discover${dir ? ` -s ${dir}` : ""} -q` };
}

/** The checks from three runs of every test: R1 fails before and passes after (twice); R0 passes in all three. */
export function chooseChecks(before, after, again) {
	const R1 = [];
	const R0 = [];
	const left = [];
	for (const id of Object.keys(after).sort()) {
		const steady = after[id] === again[id];
		if (steady && after[id] === "pass" && before[id] === "pass") R0.push(id);
		else if (steady && after[id] === "pass" && before[id] !== "pass") R1.push(id);
		else left.push({ id, why: !steady ? "flaky on the reference" : after[id] === "skip" ? "skipped on the reference" : "fails on the reference" });
	}
	return { R1, R0, left };
}

function checksDoc(task, issueTitle, checks) {
	const lines = [
		`# ${task}: what the judge checks`,
		"",
		"Built from the pull request's own tests (scripts/draft-task.mjs). Each line is one test, run with the hidden copies of",
		"the test files in place (judge/hidden/: the pull request's test files as it left them; judge/original/: the starting",
		"repository's other test files). A part is met only when every one of its tests passes. The judge also runs the gates",
		"from task.json and reports them separately.",
		"",
		"## R0: what worked before still works",
		"",
		...checks.R0.map((id, i) => `- R0.${i + 1} [${id}]`),
		...(checks.R0.length ? [] : ["- (no tests passed both before and after the pull request)"]),
		"",
		`## R1: ${issueTitle}`,
		"",
		"Tests the pull request added or changed that fail on the starting repository and pass on the pull request's result.",
		"",
		...checks.R1.map((id, i) => `- R1.${i + 1} [${id}]`),
	];
	if (checks.left.length) lines.push("", "## Left out", "", ...checks.left.map((l) => `- [${l.id}] ${l.why}`));
	return `${lines.join("\n")}\n`;
}

const runJudge = (judgeDir, checkout, outcomes) => {
	const out = execFileSync(process.execPath, [join(judgeDir, "judge.mjs"), checkout, ...(outcomes ? ["--outcomes"] : [])], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 15 * 60_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	return JSON.parse(out.trim().split("\n").filter(Boolean).pop());
};

/** Lines the fix added outside the tests, for the leak check. */
function addedSourceLines(clone, base, head, files) {
	if (!files.length) return [];
	const diff = git(clone, "diff", "--no-color", "--unified=0", base, head, "--", ...files);
	return diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
}

/**
 * Drafts one task; returns { id, dir, checks }. `model` is the drafting client ({ complete }), `github` a read-only
 * GitHub client ({ get }). Builds everything in a scratch folder and moves it into `tasksDir` only when it all works.
 */
export async function draftTask({ candidate, tasksDir, modelId = DEFAULT_MODEL, tier = "exam", level = 1, model, github, cloneUrl, now = new Date(), log = () => {} }) {
	if (!["exam", "check"].includes(tier)) throw new Error(`--tier must be exam or check, not ${tier}`);
	if (!Number.isInteger(level) || level < 1) throw new Error(`--level must be a whole number from 1, not ${level}`);
	const id = candidate.id;
	if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`not a task id: ${id}`);
	const target = join(tasksDir, id);
	if (existsSync(target)) throw new Error(`${target} already exists`);
	const stack = candidate.language === "python" ? "python" : "node";
	const scratch = mkdtempSync(join(tmpdir(), "draft-task-"));
	try {
		const clone = join(scratch, "clone");
		execFileSync("git", ["clone", "--quiet", "--no-checkout", cloneUrl ?? candidate.cloneUrl ?? `${candidate.repoUrl}.git`, clone], { stdio: "pipe" });
		git(clone, "fetch", "--quiet", "origin", `+refs/pull/${candidate.pr.number}/head:refs/relay/pr`);
		const has = (sha) => {
			try {
				git(clone, "cat-file", "-e", `${sha}^{commit}`);
				return true;
			} catch {
				return false;
			}
		};
		const head = candidate.headCommit && has(candidate.headCommit) ? candidate.headCommit : git(clone, "rev-parse", "refs/relay/pr");
		if (!has(candidate.baseCommit)) git(clone, "fetch", "--quiet", "origin", candidate.baseCommit);
		const base = git(clone, "merge-base", candidate.baseCommit, head);
		log(`${id}: base ${base.slice(0, 12)}, head ${head.slice(0, 12)}`);

		const staging = join(scratch, id);
		for (const [dir, sha] of [["repo", base], ["reference", head]]) {
			mkdirSync(join(staging, dir), { recursive: true });
			git(clone, `--work-tree=${join(staging, dir)}`, "checkout", "-f", sha, "--", ".");
		}
		const lang = stack === "python" ? "python" : "javascript";
		const list = (sha) => git(clone, "ls-tree", "-r", "--name-only", sha).split("\n").filter(Boolean);
		const basePaths = list(base);
		const headPaths = list(head);
		const changed = new Map(
			git(clone, "diff", "--name-status", "--no-renames", base, head)
				.split("\n")
				.filter(Boolean)
				.map((l) => l.split("\t"))
				.map(([status, path]) => [path, status]),
		);
		const isTest = (p) => isTestPath(p) && languageOf(p) === lang;
		const hidden = headPaths.filter((p) => isTest(p) && ["A", "M"].includes(changed.get(p)));
		const original = basePaths.filter((p) => isTest(p) && !changed.has(p));
		const run = [...original, ...hidden].filter((p) => isRunnableTest(p, stack)).sort();
		if (!hidden.some((p) => isRunnableTest(p, stack))) throw new Error(`${id}: the pull request changes no runnable test file`);
		const gates = gatesFor(stack, basePaths);

		// The judge, first with no checks, to read every test's outcome before and after the fix.
		const judgeDir = join(staging, "judge");
		mkdirSync(judgeDir, { recursive: true });
		for (const file of ["judge.mjs", "run-node-tests.mjs", "run_py_tests.py"]) cpSync(join(JUDGE_TEMPLATE, file), join(judgeDir, file));
		for (const [folder, from, files] of [["hidden", "reference", hidden], ["original", "repo", original]]) {
			for (const file of files) {
				mkdirSync(dirname(join(judgeDir, folder, file)), { recursive: true });
				cpSync(join(staging, from, file), join(judgeDir, folder, file));
			}
		}
		const config = {
			task: id,
			stack,
			gates,
			tests: { hidden, original, run },
			...(stack === "python" && basePaths.some((p) => /^src\/[^/]+\/__init__\.py$/.test(p)) ? { pythonPath: ["src"] } : {}),
			checks: { R1: [], R0: [] },
		};
		const writeConfig = () => writeFileSync(join(judgeDir, "judge.json"), `${JSON.stringify(config, null, 2)}\n`);
		writeConfig();
		const before = runJudge(judgeDir, join(staging, "repo"), true).outcomes ?? {};
		const after = runJudge(judgeDir, join(staging, "reference"), true).outcomes ?? {};
		const again = runJudge(judgeDir, join(staging, "reference"), true).outcomes ?? {};
		const checks = chooseChecks(before, after, again);
		if (!checks.R1.length) throw new Error(`${id}: no test fails before the fix and passes after it; not usable`);
		config.checks = { R1: checks.R1, R0: checks.R0 };
		writeConfig();

		// The judge as a run will use it: the starting repository fails R1 and keeps R0; the reference passes everything.
		const onRepo = runJudge(judgeDir, join(staging, "repo"), false);
		const onReference = runJudge(judgeDir, join(staging, "reference"), false);
		const problems = [];
		if (onRepo.requirements?.R1 !== false || onRepo.R0 !== true) problems.push(`on repo/: R1 ${onRepo.requirements?.R1}, R0 ${onRepo.R0} (${onRepo.notes?.R0 ?? ""})`);
		if (onReference.requirements?.R1 !== true || onReference.R0 !== true) problems.push(`on reference/: R1 ${onReference.requirements?.R1}, R0 ${onReference.R0}`);
		for (const [gate, ok] of Object.entries(onReference.gates ?? {})) if (!ok) problems.push(`gate ${gate} fails on reference/: ${onReference.notes?.[`gate ${gate}`] ?? ""}`);
		if (problems.length) throw new Error(`${id}: the judge does not validate\n  ${problems.join("\n  ")}`);

		// Only now the model call: the issue in, the request out.
		const issue = await github.get(`/repos/${candidate.repo}/issues/${candidate.issue.number}`);
		if (!issue) throw new Error(`${id}: could not read ${candidate.issue.url}`);
		const drafted = await model.complete({ model: modelId, instructions: REQUEST_INSTRUCTIONS, input: requestInput(issue) });
		const request = `${drafted.text.trim()}\n`;
		const sourceFiles = [...changed.keys()].filter((p) => !isTest(p) && languageOf(p) === lang);
		const leaks = leakProblems(request, { addedLines: addedSourceLines(clone, base, head, sourceFiles), issueNumber: candidate.issue.number, prNumber: candidate.pr.number });
		if (leaks.length) throw new Error(`${id}: the drafted request cannot be used\n  ${leaks.join("\n  ")}`);
		writeFileSync(join(staging, "request.md"), request);
		writeFileSync(join(judgeDir, "CHECKS.md"), checksDoc(id, issue.title, checks));
		const title = request.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim().slice(0, 120) ?? issue.title;
		const task = {
			id,
			kind: "everyday",
			title,
			stack: stack === "python" ? ["python3"] : ["node22"],
			requirements: ["R1"],
			timeLimitMinutes: 45,
			gates,
			private: true,
			tier,
			// The size band it was mined in (scripts/saturation.mjs): a harder level opens when the one below saturates.
			level,
			draftedBy: `openai/${drafted.model}`,
			draftedAt: now.toISOString(),
			source: {
				repo: candidate.repo,
				issue: candidate.issue.url,
				pr: candidate.pr.url,
				baseCommit: base,
				headCommit: head,
				prBaseCommit: candidate.baseCommit,
				license: candidate.license,
				issueCreatedAt: candidate.issue.createdAt,
				prMergedAt: candidate.pr.mergedAt,
			},
		};
		writeFileSync(join(staging, "task.json"), `${JSON.stringify(task, null, 2)}\n`);
		mkdirSync(tasksDir, { recursive: true });
		cpSync(staging, target, { recursive: true });
		log(`${id}: ${checks.R1.length} R1 checks, ${checks.R0.length} R0 checks, ${checks.left.length} left out; drafted by ${task.draftedBy}`);
		return { id, dir: target, checks, usage: drafted.usage };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values } = parseArgs({
		options: {
			candidate: { type: "string" },
			candidates: { type: "string" },
			"tasks-dir": { type: "string" },
			model: { type: "string", default: DEFAULT_MODEL },
			tier: { type: "string", default: "exam" },
			level: { type: "string", default: "1" },
		},
	});
	for (const name of ["candidate", "candidates", "tasks-dir"]) if (!values[name]) throw new Error(`--${name} is required`);
	const tasksDir = resolve(values["tasks-dir"]);
	const inside = relative(ROOT, tasksDir);
	if (!inside.startsWith("..") && !isAbsolute(inside)) throw new Error(`exam tasks live outside this public repository; ${tasksDir} is inside it`);
	const candidate = readFileSync(resolve(values.candidates), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.find((c) => c.id === values.candidate);
	if (!candidate) throw new Error(`no candidate ${values.candidate} in ${values.candidates}`);
	const result = await draftTask({
		candidate,
		tasksDir,
		modelId: values.model,
		tier: values.tier,
		level: Number(values.level),
		model: openaiClient({ apiKey: process.env.OPENAI_API_KEY }),
		github: githubClient({ token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN }),
		log: (line) => console.log(line),
	});
	console.log(`drafted ${result.dir}; next: node scripts/validate-task.mjs --tasks-dir ${values["tasks-dir"]} ${result.id}`);
	if (result.usage) console.log(`model usage: ${result.usage.input_tokens ?? "?"} input, ${result.usage.output_tokens ?? "?"} output tokens`);
}
