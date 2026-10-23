// Made-up data for the loop's tests: a small relay.arch shaped like the harness's (D-91), the champion's source files
// it names, practice tasks, run records, an exam with check tasks, and a fake run-stage. Nothing here is real; no test
// that uses it spends anything or reaches a network.
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeLike } from "./diff.mjs";

export function fakeArch() {
	return {
		$schema: "./relay.arch.schema.json",
		$comment: "Made up for the loop's tests.",
		version: 3,
		hash: "f".repeat(64),
		prompts: [
			{ id: "queue.requestCheck", words: "The check of a claim of done against the request.", file: "src/queue/request-check.ts", symbol: "REQUEST_CHECK_PROMPT", chars: 120, sha256: "a".repeat(64) },
			{ id: "queue.plan", words: "The planner's instructions for splitting a request into tasks.", file: "src/queue/decider.ts", symbol: "PLAN_PROMPT", chars: 90, sha256: "b".repeat(64) },
			{ id: "tool.ipython", words: "The ipython tool as the model sees it.", file: "src/tools/ipython.ts", symbol: "IPYTHON_TOOL", chars: 80, sha256: "c".repeat(64) },
		],
		skills: [{ name: "edit", dir: "skills/edit", files: 2, sha256: "d".repeat(64) }],
		tools: { builtIn: ["ipython"], queueTask: ["ask_decider"] },
		routing: {
			tiers: { decider: ["anthropic/model-top"], strong: ["anthropic/model-mid"], fast: ["anthropic/model-small"] },
			suitability: [
				{ id: "high-risk", when: [{ risk: ["high"] }], tier: "strong", reviewAtDone: true },
				{ id: "small-low-risk", when: [{ size: ["S", "M"], risk: ["low"] }], tier: "fast" },
				{ id: "large-or-cross-file", when: [{ size: ["L"] }, { crossFile: true }], tier: "strong" },
			],
			deciderShare: 0.15,
			refusalHoldHours: 6,
			newSessionsPlan: true,
		},
		subAgents: { maxDepth: 2, childTier: "strong" },
		memory: { learningMode: "on", refineKinds: ["prompt", "memory", "skill"], autoRefine: { enabled: true, everyTurns: 25, onCompact: true, cooldownMinutes: 20 } },
		queue: {
			maxAttempts: 2,
			maxRecoveries: 2,
			requestCheck: { maxChecks: 2, maxUnmet: 8, diffChars: 60000 },
			stuck: { idleTurns: 3, repeatedActions: 3, alternationWindow: 6, repeatedErrors: 3, errorWindowTurns: 8 },
			plan: { maxTasks: 12, maxDoneCriteria: 8, filesShown: 400 },
			rules: [],
		},
		checks: { gates: ["test", "lint", "build"], scopeAllow: ["**"], scopeDeny: [".git/**", "**/.env"], inSessionRetries: 3, gateTimeoutMinutes: 20, setupGuardMinutes: 10 },
		budgets: { turnsPerAttempt: 80, tokensPerAttempt: 50000000, firstRunSpendCap: { perTaskUsd: 25, perDayUsd: 100 }, releaseCeilings: { maxUsdPerTask: null, maxMinutesPerTask: 720, maxSubagentDepth: 3, egress: null } },
		topology: [{ id: "worker", words: "A queue task's session.", runsOn: "the strong or fast tier", prompts: ["queue.requestCheck"] }],
		selfModel: { minSamples: 5, blindSpots: [] },
	};
}

export const fakeArchText = () => serializeLike(fakeArch(), "{\n\t\"x\"");

/** The champion's source files the fake relay.arch names, and the code that holds two of its values. */
export const SOURCES = Object.freeze({
	"packages/supervisor/src/store.ts": [
		'import { word } from "./words.js";',
		"",
		"/** One attempt, and one retry. */",
		"export const MAX_ATTEMPTS = 2;",
		"",
		"/** Turns per attempt. */",
		"export const DEFAULT_TURN_BUDGET = 80;",
		"",
		"/** Runs that may die during one attempt. */",
		"export const MAX_RECOVERIES = 2;",
		"",
		"export function attemptsLeft(task) {",
		"\treturn MAX_ATTEMPTS - task.attempts + word.length;",
		"}",
		"",
	].join("\n"),
	"packages/supervisor/src/route.ts": ["/** Tasks in one plan. */", "export const MAX_PLANNED_TASKS = 12;", "", "/** Done-criteria per task. */", "export const MAX_DONE_CRITERIA = 8;", ""].join("\n"),
	"src/queue/request-check.ts": [
		'import { other } from "./other.js";',
		"",
		"/** What the check is told. */",
		"export const REQUEST_CHECK_PROMPT = [",
		'\t"You check one task before it is verified.",',
		'\t"Read the request detail by detail.",',
		'].join("\\n");',
		"",
		"export function checkRequest(input) {",
		"\treturn other(input, REQUEST_CHECK_PROMPT);",
		"}",
		"",
	].join("\n"),
	"src/queue/decider.ts": ["export const PLAN_PROMPT = [", '\t"Split the request into tasks.",', '].join("\\n");', "", "export function plan() {", "\treturn PLAN_PROMPT;", "}", ""].join("\n"),
	"src/tools/ipython.ts": ["export const IPYTHON_TOOL = {", '\tname: "ipython",', '\tdescription: "Run Python in a kernel.",', "};", "", "export function run() {", "\treturn IPYTHON_TOOL;", "}", ""].join("\n"),
});
export const sources = (file) => SOURCES[file] ?? null;

/** A throwaway folder of practice tasks: `n` everyday ones and `long` long ones, Python. */
export function practiceTasks({ everyday = 6, long = 4 } = {}) {
	const root = mkdtempSync(join(tmpdir(), "loop-practice-"));
	const tasks = join(root, "tasks");
	const ids = [];
	const make = (id, kind) => {
		mkdirSync(join(tasks, id, "repo"), { recursive: true });
		writeFileSync(join(tasks, id, "task.json"), JSON.stringify({ id, kind, stack: ["python3"], requirements: ["R1"], timeLimitMinutes: kind === "long" ? 180 : 45 }));
		ids.push(id);
	};
	for (let i = 0; i < everyday; i++) make(`py-e${i}`, "everyday");
	for (let i = 0; i < long; i++) make(`py-l${i}`, "long");
	return { root, tasks, ids };
}

let seq = 0;
/** One practice run record, as runner/run-one.mjs writes them. */
export function record({ task, kind = "everyday", tool = "relay@0.6.121", test = "B", rep = 1, share = 0, R0 = true, saidDoneButFailed = false, notes = {}, extra = {} }) {
	seq++;
	return {
		runId: `${test}-${task}-${tool}-r${rep}-${seq}`,
		test,
		task,
		taskKind: kind,
		tool,
		model: "claude-haiku-5-5",
		rep,
		score: { share, R0, requirementsMet: share === 1 ? 1 : 0, requirements: 1 },
		judge: { R0, requirements: { R1: share === 1 }, gates: { test: true }, notes },
		saidDoneButFailed,
		usage: { costUsd: 0.05, refusedAtCap: 0 },
		wallMs: 60_000,
		startedAt: "2026-10-20T10:00:00.000Z",
		finishedAt: "2026-10-20T10:01:00.000Z",
		...extra,
	};
}

export function writeRecords(dir, records) {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "records.jsonl");
	appendFileSync(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
	return path;
}

/** A throwaway exam with `check` check-tier tasks and a few exam tasks. */
export function examWithCheck({ check = 25, examTasks = 2 } = {}) {
	const root = mkdtempSync(join(tmpdir(), "loop-exam-"));
	const tasks = join(root, "tasks");
	for (let i = 0; i < check; i++) {
		const id = `chk${String(i).padStart(2, "0")}`;
		mkdirSync(join(tasks, id), { recursive: true });
		writeFileSync(join(tasks, id, "task.json"), JSON.stringify({ id, kind: "everyday", tier: "check" }));
	}
	for (let i = 0; i < examTasks; i++) {
		const id = `ex${i}`;
		mkdirSync(join(tasks, id), { recursive: true });
		writeFileSync(join(tasks, id, "task.json"), JSON.stringify({ id, kind: "everyday", tier: "exam" }));
	}
	return { root, tasks };
}

const argOf = (args, name) => args[args.indexOf(name) + 1];

/**
 * A fake script runner. run-stage writes a record per task × tool × rep, the candidate (relay@pkg) scoring
 * `candidate(task)` and the champion `champion(task)`, and prints the stage's spend; every other script runs for real
 * when `real` names it. Every call is kept in `calls`.
 */
export function fakeExec({ calls = [], candidate = () => 1, champion = () => 0.5, real = {}, costUsd = 0.05 } = {}) {
	return (script, args) => {
		calls.push([script, ...args]);
		if (script === "runner/run-stage.mjs") {
			const test = argOf(args, "--test");
			const out = argOf(args, "--out");
			const tools = argOf(args, "--tools").split(",");
			const reps = Number(argOf(args, "--reps"));
			const spec = argOf(args, "--tasks");
			const tasksDir = argOf(args, "--tasks-dir");
			const ids = spec.startsWith("tier:") ? real.tierIds?.(tasksDir, spec.slice(5)) ?? [] : spec.split(",");
			const rows = [];
			for (let rep = 1; rep <= reps; rep++) {
				for (const task of ids) {
					for (const tool of tools) rows.push(record({ task, tool, test, rep, share: tool === "relay@pkg" ? candidate(task) : champion(task), extra: { usage: { costUsd, refusedAtCap: 0 } } }));
				}
			}
			writeRecords(out, rows);
			return { status: 0, stdout: `stage ${test}: planned\nstage ${test} finished: $${(rows.length * costUsd).toFixed(2)} spent\n`, stderr: "" };
		}
		if (real[script]) return real[script](args);
		return { status: 0, stdout: "ok\n", stderr: "" };
	};
}

/** A fake writer: returns `diff(prompt)` as its answer, at a fixed cost. */
export function fakeWriter({ diff, costUsd = 0.04, model = "claude-opus-5-5", calls = [] }) {
	return {
		model,
		async write(input) {
			calls.push(input);
			return { text: typeof diff === "function" ? diff(input) : diff, costUsd, model, usage: { input_tokens: 1000, output_tokens: 500 } };
		},
	};
}
