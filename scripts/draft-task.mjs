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
// The judge check runs the candidate's own tests and gates five times: someone else's code. It runs them in an E2B
// sandbox (scripts/e2b-judge.mjs), never on this machine, whenever E2B_API_KEY is set; without it, draft-task refuses
// to start. --local-judge runs them here instead, for tests with made-up repositories only. The repository is cloned and
// checked out here with git, which runs none of its code.
//
//   node scripts/draft-task.mjs --candidate <id> \
//     --candidates ../relay-exam/candidates.jsonl --tasks-dir ../relay-exam/tasks [--model gpt-6.1-sol] [--tier exam] [--level 1] \
//     [--effort low] [--max-output-tokens 6000] [--spend ../relay-exam/drafting/spend.json] [--openai-cap-usd 8] [--e2b-cap-usd 1]
//
// Every paid call is bounded and counted in the drafting ledger (scripts/draft-spend.mjs; by default drafting/spend.json
// beside the tasks folder). The model call asks for at most --max-output-tokens (reasoning included) at a low or medium
// reasoning effort, so its most possible cost is known before it is made; the call is refused when that could take the
// ledger past its OpenAI cap, and afterwards its real cost is read from the response's usage, a draft the leak check
// refuses included. The sandbox is counted the same way against the E2B cap, at its time limit before it starts and at
// its seconds once it is killed. --openai-cap-usd and --e2b-cap-usd set the caps kept in the ledger; with no cap, nothing
// paid runs. A refused draft is kept in drafting/refused/ beside the ledger, for the people who review the drafts.
//
// The model's key is OPENAI_API_KEY, from the environment. It reads the issue from the GitHub API (GITHUB_TOKEN or
// GH_TOKEN if set; public issues need none) and clones the public repository read-only. Nothing is written to GitHub.
// --tasks-dir must be outside this public repository.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { maxCallUsd, openaiCostUsd, openLedger, SpendCapError, usageSummary } from "./draft-spend.mjs";
import { openE2BJudge, openLocalJudge } from "./e2b-judge.mjs";
import { githubClient, isTestPath, languageOf } from "./mine-tasks.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const JUDGE_TEMPLATE = join(ROOT, "scripts", "exam-judge");
export const DEFAULT_MODEL = "gpt-6.1-sol";
/** The model call's bounds: a request is under 400 words, so this leaves room for the reasoning before it. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 6000;
export const EFFORTS = Object.freeze(["low", "medium"]);
export const DEFAULT_EFFORT = "low";

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

/**
 * OpenAI's Responses API, for the drafting model only. The key comes from the environment and is never printed. Each
 * call is bounded: at most maxOutputTokens (reasoning included), at the given reasoning effort, on the default
 * processing tier. An answer cut short is returned, not thrown, so its usage is still counted.
 */
export function openaiClient({ apiKey, fetch: doFetch = globalThis.fetch, baseUrl = "https://api.openai.com" } = {}) {
	if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
	return {
		async complete({ model, instructions, input, maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS, effort = DEFAULT_EFFORT }) {
			const res = await doFetch(`${baseUrl}/v1/responses`, {
				method: "POST",
				headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
				body: JSON.stringify({
					model,
					instructions,
					input: [{ role: "user", content: [{ type: "input_text", text: input }] }],
					max_output_tokens: maxOutputTokens,
					reasoning: { effort },
					service_tier: "default",
					store: false,
				}),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				const error = new Error(`OpenAI ${res.status}: ${body?.error?.message ?? "no message"}`);
				error.status = res.status;
				throw error;
			}
			const text = (body.output ?? [])
				.filter((o) => o.type === "message")
				.flatMap((o) => o.content ?? [])
				.filter((c) => c.type === "output_text")
				.map((c) => c.text)
				.join("");
			return {
				text,
				model: body.model ?? model,
				usage: body.usage,
				status: body.status,
				incompleteReason: body.incomplete_details?.reason,
				serviceTier: body.service_tier,
			};
		},
	};
}

/**
 * One bounded, counted model call (scripts/draft-spend.mjs): reserved at its most before it is made, refused when that
 * could cross the cap, then settled at what the response's usage says it cost. Returns the reply and the ledger entry.
 */
async function countedCall({ model, modelId, instructions, input, maxOutputTokens, effort, ledger, label }) {
	if (!ledger) return { drafted: await model.complete({ model: modelId, instructions, input, maxOutputTokens, effort }) };
	const boundUsd = maxCallUsd(modelId, { inputBytes: Buffer.byteLength(instructions) + Buffer.byteLength(input), maxOutputTokens });
	if (boundUsd === undefined) throw new Error(`${label}: no list price for ${modelId}, so the call cannot be bounded; it is not made`);
	const entry = ledger.reserve("openai", { boundUsd, candidate: label, model: modelId, effort, maxOutputTokens });
	let drafted;
	try {
		drafted = await model.complete({ model: modelId, instructions, input, maxOutputTokens, effort });
	} catch (error) {
		// A request OpenAI refused outright (4xx) is not billed; any other failure may have been, so it stays counted at
		// its most.
		const refused = error.status >= 400 && error.status < 500;
		ledger.settle("openai", entry, { ...(refused ? { costUsd: 0 } : {}), outcome: "error", why: String(error.message).slice(0, 300) });
		throw error;
	}
	const costUsd = openaiCostUsd(drafted.usage, drafted.model ?? modelId, drafted.serviceTier);
	ledger.settle("openai", entry, {
		costUsd,
		reported: drafted.model,
		serviceTier: drafted.serviceTier,
		status: drafted.status,
		usage: drafted.usage ? usageSummary(drafted.usage) : null,
		outcome: "answered",
	});
	return { drafted, entry, costUsd };
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

/** Lines the fix added outside the tests, for the leak check. */
function addedSourceLines(clone, base, head, files) {
	if (!files.length) return [];
	const diff = git(clone, "diff", "--no-color", "--unified=0", base, head, "--", ...files);
	return diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
}

/**
 * Drafts one task; returns { id, dir, checks, usage, judgeCheck, costUsd }. `model` is the drafting client
 * ({ complete }), `github` a read-only GitHub client ({ get }), and `openJudge` where the judge check runs
 * (scripts/e2b-judge.mjs: openE2BJudge, or openLocalJudge in tests). `ledger` (scripts/draft-spend.mjs) bounds and
 * counts the model call. Builds everything in a scratch folder and moves it into `tasksDir` only when it all works.
 */
export async function draftTask({
	candidate,
	tasksDir,
	modelId = DEFAULT_MODEL,
	tier = "exam",
	level = 1,
	effort = DEFAULT_EFFORT,
	maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
	model,
	github,
	openJudge,
	ledger,
	refusedDir,
	cloneUrl,
	now = new Date(),
	log = () => {},
}) {
	if (!["exam", "check"].includes(tier)) throw new Error(`--tier must be exam or check, not ${tier}`);
	if (!Number.isInteger(level) || level < 1) throw new Error(`--level must be a whole number from 1, not ${level}`);
	if (!EFFORTS.includes(effort)) throw new Error(`--effort must be ${EFFORTS.join(" or ")}, not ${effort}`);
	if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error(`--max-output-tokens must be a whole number from 1, not ${maxOutputTokens}`);
	if (typeof openJudge !== "function") throw new Error("draftTask needs openJudge: where the judge check runs (scripts/e2b-judge.mjs)");
	if (ledger) {
		// Before any sandbox starts: the model call could not be made, so the judge check would be wasted.
		const least = maxCallUsd(modelId, { inputBytes: Buffer.byteLength(REQUEST_INSTRUCTIONS), maxOutputTokens });
		if (least === undefined) throw new Error(`no list price for ${modelId}, so its call cannot be bounded; nothing is drafted`);
		const { openai } = ledger.totals();
		if (typeof openai.capUsd !== "number") throw new SpendCapError(`no OpenAI spending cap is set in ${ledger.path}; a person sets one first (--openai-cap-usd)`);
		if (openai.spentUsd + least > openai.capUsd + 1e-12) throw new SpendCapError(`OpenAI: $${openai.spentUsd.toFixed(4)} counted so far; one more call could cross the $${openai.capUsd.toFixed(2)} cap`);
	}
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
		const configText = () => `${JSON.stringify(config, null, 2)}\n`;
		writeFileSync(join(judgeDir, "judge.json"), configText());
		// From here the candidate's own code runs: in the sandbox, which is killed before the model is called.
		const judge = await openJudge({ dir: staging, label: id, purpose: "draft-judge" });
		let checks;
		let onRepo;
		let onReference;
		let judgeCheck;
		try {
			// Each run is paid sandbox time, so the check stops at the first run that settles it; what it accepts is the same.
			const before = (await judge.run("repo", { outcomes: true })).outcomes ?? {};
			const after = (await judge.run("reference", { outcomes: true })).outcomes ?? {};
			if (Object.keys(after).some((t) => after[t] === "pass" && before[t] !== "pass")) {
				const again = (await judge.run("reference", { outcomes: true })).outcomes ?? {};
				checks = chooseChecks(before, after, again);
			} else checks = chooseChecks(before, after, after);
			if (checks.R1.length) {
				config.checks = { R1: checks.R1, R0: checks.R0 };
				writeFileSync(join(judgeDir, "judge.json"), configText());
				await judge.put("judge/judge.json", configText());
				// The judge as a run will use it: the reference passes everything; the starting repository fails R1 and keeps R0.
				onReference = await judge.run("reference");
				if (onReference.requirements?.R1 === true && onReference.R0 === true && Object.values(onReference.gates ?? {}).every(Boolean)) onRepo = await judge.run("repo");
			}
		} finally {
			judgeCheck = await judge.close();
		}
		log(`${id}: judge check ran ${judgeCheck.where === "e2b" ? `in E2B sandbox ${judgeCheck.sandboxId}` : "on this machine"}, ${judgeCheck.seconds.toFixed(1)}s, $${judgeCheck.costUsd.toFixed(4)}`);
		if (!checks.R1.length) throw new Error(`${id}: no test fails before the fix and passes after it; not usable`);
		const problems = [];
		if (onRepo && (onRepo.requirements?.R1 !== false || onRepo.R0 !== true)) problems.push(`on repo/: R1 ${onRepo.requirements?.R1}, R0 ${onRepo.R0} (${onRepo.notes?.R0 ?? ""})`);
		if (onReference.requirements?.R1 !== true || onReference.R0 !== true) problems.push(`on reference/: R1 ${onReference.requirements?.R1}, R0 ${onReference.R0}`);
		for (const [gate, ok] of Object.entries(onReference.gates ?? {})) if (!ok) problems.push(`gate ${gate} fails on reference/: ${onReference.notes?.[`gate ${gate}`] ?? ""}`);
		if (problems.length) throw new Error(`${id}: the judge does not validate\n  ${problems.join("\n  ")}`);

		// Only now the model call: the issue in, the request out.
		const issue = await github.get(`/repos/${candidate.repo}/issues/${candidate.issue.number}`);
		if (!issue) throw new Error(`${id}: could not read ${candidate.issue.url}`);
		const { drafted, entry, costUsd } = await countedCall({ model, modelId, instructions: REQUEST_INSTRUCTIONS, input: requestInput(issue), maxOutputTokens, effort, ledger, label: id });
		const outcome = (fields) => entry && ledger.update("openai", entry, fields);
		log(`${id}: ${drafted.model ?? modelId} answered (${drafted.status ?? "no status"}), ${drafted.usage?.input_tokens ?? "?"} input and ${drafted.usage?.output_tokens ?? "?"} output tokens${costUsd === undefined ? "" : `, $${costUsd.toFixed(5)}`}`);
		if (drafted.status === "incomplete" || !drafted.text?.trim()) {
			outcome({ outcome: "incomplete", why: drafted.incompleteReason ?? "no text" });
			throw new Error(`${id}: the model's answer was cut short (${drafted.incompleteReason ?? "no text"}); raise --max-output-tokens or lower --effort`);
		}
		const request = `${drafted.text.trim()}\n`;
		const sourceFiles = [...changed.keys()].filter((p) => !isTest(p) && languageOf(p) === lang);
		const leaks = leakProblems(request, { addedLines: addedSourceLines(clone, base, head, sourceFiles), issueNumber: candidate.issue.number, prNumber: candidate.pr.number });
		if (leaks.length) {
			let kept;
			if (refusedDir) {
				mkdirSync(refusedDir, { recursive: true });
				kept = join(refusedDir, `${id}.${modelId}.md`);
				writeFileSync(kept, `<!-- refused by draft-task's leak check:\n${leaks.map((l) => `  - ${l}`).join("\n")}\n-->\n${request}`);
			}
			outcome({ outcome: "refused", why: leaks, ...(kept ? { refusedDraft: kept } : {}) });
			throw new Error(`${id}: the drafted request cannot be used\n  ${leaks.join("\n  ")}`);
		}
		outcome({ outcome: "drafted" });
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
		// verbatimSymlinks: a repository's relative links stay as they are, not rewritten to absolute paths into staging,
		// which is deleted and would leave them dangling (and leak a temp path into the task).
		cpSync(staging, target, { recursive: true, verbatimSymlinks: true });
		log(`${id}: ${checks.R1.length} R1 checks, ${checks.R0.length} R0 checks, ${checks.left.length} left out; drafted by ${task.draftedBy}`);
		return { id, dir: target, checks, usage: drafted.usage, costUsd, judgeCheck };
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
			effort: { type: "string", default: DEFAULT_EFFORT },
			"max-output-tokens": { type: "string", default: String(DEFAULT_MAX_OUTPUT_TOKENS) },
			spend: { type: "string" },
			"openai-cap-usd": { type: "string" },
			"e2b-cap-usd": { type: "string" },
			// Tests with made-up repositories only: run the judge check's tests on this machine instead of in E2B.
			"local-judge": { type: "boolean", default: false },
		},
	});
	for (const name of ["candidate", "candidates", "tasks-dir"]) if (!values[name]) throw new Error(`--${name} is required`);
	const tasksDir = resolve(values["tasks-dir"]);
	const inside = relative(ROOT, tasksDir);
	if (!inside.startsWith("..") && !isAbsolute(inside)) throw new Error(`exam tasks live outside this public repository; ${tasksDir} is inside it`);
	if (!values["local-judge"] && !process.env.E2B_API_KEY) {
		throw new Error("the judge check runs the candidate's own code, so it runs in an E2B sandbox: set E2B_API_KEY (or pass --local-judge, for tests only)");
	}
	const spendPath = resolve(values.spend ?? join(dirname(tasksDir), "drafting", "spend.json"));
	const ledger = openLedger(spendPath, { caps: { openai: values["openai-cap-usd"], e2b: values["e2b-cap-usd"] } });
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
		effort: values.effort,
		maxOutputTokens: Number(values["max-output-tokens"]),
		model: openaiClient({ apiKey: process.env.OPENAI_API_KEY }),
		github: githubClient({ token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN }),
		openJudge: values["local-judge"] ? openLocalJudge : (options) => openE2BJudge({ ...options, ledger, log: (line) => console.log(line) }),
		ledger,
		refusedDir: join(dirname(spendPath), "refused"),
		log: (line) => console.log(line),
	})
		.catch((error) => {
			// A cap reached is not a broken candidate: exit 3, so a loop over candidates knows to stop.
			if (error instanceof SpendCapError) {
				console.error(`spend cap: ${error.message}`);
				process.exitCode = 3;
				return null;
			}
			throw error;
		})
		.finally(() => {
			const t = ledger.totals();
			console.log(`spend so far (${spendPath}): OpenAI $${t.openai.spentUsd.toFixed(4)} of $${t.openai.capUsd ?? "no cap"}, E2B $${t.e2b.spentUsd.toFixed(4)} of $${t.e2b.capUsd ?? "no cap"}`);
		});
	if (!result) process.exit();
	console.log(`drafted ${result.dir}; next: node scripts/validate-task.mjs --tasks-dir ${values["tasks-dir"]} ${result.id}`);
	if (result.usage) console.log(`model usage: ${result.usage.input_tokens ?? "?"} input, ${result.usage.output_tokens ?? "?"} output tokens`);
}
