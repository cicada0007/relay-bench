#!/usr/bin/env node
// Round 1's results as one JSON file for the results page: results/round-1.json.
//
// Every number comes from the round's own analysis code, imported, not re-derived: runner/analyze.mjs (tests A, B, D),
// runner/tb21-analyze.mjs (test F) and runner/longctx-analyze.mjs (test G). The only arithmetic here is counting runs,
// adding costs, and test D's per-fault "finished with nobody" counts. No task contents are written: no request, judge,
// repository, answer or per-task score, only each test's totals per tool.
//
// Tests still running are exported with the records they have so far and marked "in progress". A test is "complete"
// when its stage log ended (the runner printed "finished" or "stopped:"), or when every planned run has a record.
//
//   node scripts/export-results.mjs [--out runs/round-1] [--to results/round-1.json]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { analyze, loadRecords, RESAMPLES, SEED } from "../runner/analyze.mjs";
import { analyzeLongctx } from "../runner/longctx-analyze.mjs";
import { analyzeTb21 } from "../runner/tb21-analyze.mjs";
import { DATASET, DATASET_REF, HARBOR_VERSION } from "../runner/tb21.mjs";
import { PINS, TEMPLATE_NAME } from "../sandbox/template.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const { values: args } = parseArgs({
	options: { out: { type: "string", default: "runs/round-1" }, to: { type: "string", default: "results/round-1.json" } },
});
const OUT = join(ROOT, args.out);
const REPO = "https://github.com/cicada0007/relay-bench";

const TOOL_NAMES = { relay: "Relay", "claude-code": "Claude Code", "prime-agent": "Prime Agent", hermes: "Hermes" };
const TOOL_ORDER = ["relay", "claude-code", "prime-agent", "hermes"];
const byToolOrder = (obj) =>
	Object.fromEntries(Object.entries(obj).sort(([a], [b]) => TOOL_ORDER.indexOf(a) - TOOL_ORDER.indexOf(b)));

const jsonl = (path) =>
	existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const cost = (records) => sum(records.map((r) => r.usage?.costUsd ?? 0));

/** Did the stage log for `test` end? The last "stage <test>:" / "test <test>:" header must be followed by its end line. */
function stageLog(file, test) {
	const path = join(OUT, file);
	if (!existsSync(path)) return { ended: false, endLine: null };
	const lines = readFileSync(path, "utf8").split("\n");
	const header = new RegExp(`^(stage|test) ${test}: `);
	let last = -1;
	lines.forEach((l, i) => {
		if (header.test(l)) last = i;
	});
	if (last < 0) return { ended: false, endLine: null };
	for (let i = last + 1; i < lines.length; i++) {
		if (/^(stage|test) \S+: /.test(lines[i])) break;
		if (new RegExp(`^(stage|test) ${test} finished`).test(lines[i]) || lines[i].startsWith("stopped:"))
			return { ended: true, endLine: lines[i].trim() };
	}
	return { ended: false, endLine: null };
}

const status = (log, done, planned) => (log.ended || done >= planned ? "complete" : "in progress");

/** analyze.mjs's per-tool summary, in the page's shape. */
function fromAnalyze(result) {
	const tools = {};
	for (const [tool, s] of Object.entries(result.toolSummary)) {
		tools[tool] = {
			name: TOOL_NAMES[tool] ?? tool,
			tasks: s.tasks,
			runs: s.runs,
			score: s.score,
			checksPassed: s.checksPassed,
			allRunsPass: s.allRunsPass,
			saidDoneButFailed: s.saidDoneButFailed,
			costUsd: s.costUsd,
			costPerSolvedUsd: s.costPerSolvedUsd,
			medianMinutes: s.medianMinutes,
		};
	}
	return { tools: byToolOrder(tools), comparisons: comparisonsOut(result.comparisons) };
}

function comparisonsOut(comparisons) {
	const out = {};
	for (const [tool, c] of Object.entries(comparisons)) {
		out[tool] = {
			name: TOOL_NAMES[tool] ?? tool,
			tasks: c.tasks ?? c.items,
			difference: c.difference,
			low: c.low,
			high: c.high,
			word: c.word,
		};
	}
	return byToolOrder(out);
}

/** Runs the plan called for that have no record: task ids and tool names only. */
function runsNotMade(records, tools, reps) {
	const tasks = [...new Set(records.map((r) => r.task))].sort();
	const have = new Set(records.map((r) => `${r.task}|${r.tool}|${r.rep}`));
	const missing = [];
	for (let rep = 1; rep <= reps; rep++)
		for (const task of tasks) for (const tool of tools) if (!have.has(`${task}|${tool}|${rep}`)) missing.push({ task, tool, rep });
	return missing;
}

const tests = [];

// ---- Test A: the primary test.
{
	const records = loadRecords(args.out, "A");
	const log = stageLog("A.log", "A");
	const planned = 108;
	tests.push({
		id: "A",
		title: "Long requests, Sonnet 5.5",
		primary: true,
		model: "claude-sonnet-5-5",
		measure: "requirements met",
		measureNote: "The share of a request's 6 parts the hidden judge passes; checks passed is the share of the judge's individual checks.",
		unit: "task",
		status: status(log, records.length, planned),
		stageLogEnd: log.endLine,
		plannedRuns: planned,
		runs: records.length,
		capUsd: 190,
		spentUsd: cost(records),
		runsNotMade: runsNotMade(records, ["relay", "prime-agent", "claude-code"], 3),
		notes: [
			`Test A stopped at its $190 cap after ${records.length} of ${planned} runs: the next run could have taken it past the cap. The founders chose to keep the cap. The runs not made are the third repetition of the last two tasks in the run order, for every tool, so every comparison is still on the same tasks for every tool.`,
		],
		...fromAnalyze(analyze(records)),
	});
}

// ---- Test B: everyday changes (3 runs each) and long requests (once each), Haiku 5.5. Analyzed apart and together.
{
	const all = loadRecords(args.out, "B");
	const log = stageLog("BD.log", "B");
	const parts = [
		{ id: "B-everyday", kind: "everyday", title: "Everyday changes, Haiku 5.5", planned: 144, reps: 3, measure: "solved" },
		{ id: "B-long", kind: "long", title: "Long requests, Haiku 5.5", planned: 48, reps: 1, measure: "requirements met" },
	];
	for (const p of parts) {
		const records = all.filter((r) => r.taskKind === p.kind);
		// BD.log holds both B stages; B is complete only once both have every run (or the log ended after the second).
		const done = records.length >= p.planned;
		tests.push({
			id: p.id,
			test: "B",
			title: p.title,
			primary: false,
			model: "claude-haiku-5-5",
			measure: p.measure,
			unit: "task",
			status: done || log.ended ? "complete" : "in progress",
			plannedRuns: p.planned,
			runs: records.length,
			runsNotMade: runsNotMade(records, ["relay", "prime-agent", "claude-code", "hermes"], p.reps),
			spentUsd: cost(records),
			...fromAnalyze(analyze(records)),
		});
	}
	tests.push({
		id: "B",
		title: "Test B as one test (everyday changes and long requests together)",
		primary: false,
		combined: true,
		model: "claude-haiku-5-5",
		measure: "solved or requirements met",
		unit: "task",
		status: log.ended && all.length >= 192 ? "complete" : "in progress",
		stageLogEnd: log.endLine,
		plannedRuns: 192,
		runs: all.length,
		capUsd: 80,
		spentUsd: cost(all),
		notes: ["The analysis run on test B whole (node runner/analyze.mjs --test B), as the pre-registration defines the test."],
		...fromAnalyze(analyze(all)),
	});
}

// ---- Test D: faults during one long request, Haiku 5.5.
{
	const records = loadRecords(args.out, "D");
	const log = stageLog("BD.log", "D");
	const planned = 24;
	const faults = ["kill", "network", "errors"];
	const perFault = {};
	for (const tool of TOOL_ORDER) {
		const mine = records.filter((r) => r.tool === tool);
		if (!mine.length) continue;
		perFault[tool] = { name: TOOL_NAMES[tool] };
		for (const fault of faults) {
			const runs = mine.filter((r) => r.fault?.kind === fault);
			perFault[tool][fault] = {
				runs: runs.length,
				// The run ended with the judge passing every part, and nobody acted: every run in this test is unattended.
				finishedWithNobody: runs.filter((r) => r.score?.share === 1).length,
				restarts: sum(runs.map((r) => r.restarts ?? 0)),
			};
		}
	}
	tests.push({
		id: "D",
		title: "Faults during a long request, Haiku 5.5",
		primary: false,
		model: "claude-haiku-5-5",
		measure: "requirements met",
		unit: "task",
		status: status(log, records.length, planned),
		stageLogEnd: log.endLine,
		plannedRuns: planned,
		runs: records.length,
		capUsd: 25,
		spentUsd: cost(records),
		faults: {
			kill: "The tool's process group is killed once (SIGKILL), 120 seconds after its first model request.",
			network: "For 10 minutes, starting 120 seconds after the first model request, every model request's connection is dropped.",
			errors: "For 10 minutes, starting 120 seconds after the first model request, every model request is answered 529 overloaded_error.",
		},
		finishedWithNobody: perFault,
		finishedWithNobodyRule: "The run ended with the judge passing all 6 parts and no person acting. Every tool runs inside the same restart loop, which runs the tool's own resume command up to 3 times.",
		notes: ["Test D runs one long request, so there is no interval over tasks: the comparisons are left out and each fault's runs are shown."],
		...fromAnalyze(analyze(records)),
	});
}

// ---- Test F: Terminal-Bench 2.1 through Harbor, Haiku 5.5.
{
	const records = jsonl(join(OUT, "F", "records.jsonl")).filter((r) => r.test === "F");
	const log = stageLog("F.log", "F");
	const planned = 356;
	const trialsDone = new Set(records.map((r) => `${r.task}|${r.tool}|${r.rep}`)).size;
	const result = analyzeTb21(records);
	const tools = {};
	for (const [tool, s] of Object.entries(result.tools)) {
		tools[tool] = {
			name: TOOL_NAMES[tool] ?? tool,
			tasks: s.tasks,
			runs: s.trials,
			score: s.solvedShare,
			scoreLow: s.low,
			scoreHigh: s.high,
			checksPassed: null,
			allRunsPass: s.allTrialsSolved,
			saidDoneButFailed: null,
			costUsd: s.costUsd,
			costPerSolvedUsd: s.costPerSolvedUsd,
			medianMinutes: s.medianMinutes,
			stoppedAtCap: s.stoppedAtCap,
			unmeteredTrials: s.unmeteredTrials,
		};
	}
	tests.push({
		id: "F",
		title: "Terminal-Bench 2.1, Haiku 5.5",
		primary: false,
		model: "claude-haiku-5-5",
		measure: "solved",
		unit: "task",
		status: log.ended || trialsDone >= planned ? "complete" : "in progress",
		stageLogEnd: log.endLine,
		plannedRuns: planned,
		runs: trialsDone,
		capUsd: 45,
		spentUsd: sum(jsonl(join(OUT, "F", "spend.jsonl")).map((s) => s.chargedUsd ?? 0)),
		droppedTasks: result.dropped,
		notes: [
			"89 public tasks, 2 trials per task per tool. Harbor reports no 'said done' signal, so said done but failed is not measured here.",
			"A task whose infrastructure failed twice is dropped for every tool, and listed.",
			"Spend includes every attempt, retries included (F/spend.jsonl).",
		],
		tools: byToolOrder(tools),
		comparisons: comparisonsOut(result.comparisons),
	});
}

// ---- Test G: two long-context sets, Haiku 5.5, one run per item.
{
	const records = jsonl(join(OUT, "G", "records.jsonl")).filter((r) => r.test === "G");
	const log = stageLog("G.log", "G");
	const result = analyzeLongctx(records);
	const sets = { oolong: "OOLONG (yahoo, 128k)", longbench: "LongBench v2" };
	for (const [set, title] of Object.entries(sets)) {
		const r = result[set];
		if (!r) continue;
		const setRecords = records.filter((x) => x.set === set);
		const tools = {};
		for (const [tool, s] of Object.entries(r.tools)) {
			const solved = setRecords.filter((x) => x.tool === tool && !r.droppedItems.includes(x.item) && x.score === 1).length;
			tools[tool] = {
				name: TOOL_NAMES[tool] ?? tool,
				tasks: s.items,
				runs: s.items,
				score: s.score,
				checksPassed: null,
				allRunsPass: null,
				saidDoneButFailed: null,
				costUsd: s.costUsd,
				costPerItemUsd: s.costPerItemUsd,
				costPerSolvedUsd: solved ? s.costUsd / solved : null,
				medianMinutes: s.medianMinutes,
				unparsed: s.unparsed,
				outputTokens: s.outputTokens,
				stoppedAtCap: s.stoppedAtCap,
				timedOut: s.timedOut,
			};
		}
		tests.push({
			id: `G-${set}`,
			test: "G",
			title: `${title}, Haiku 5.5`,
			primary: false,
			model: "claude-haiku-5-5",
			measure: "solved",
			unit: "item",
			status: log.ended || setRecords.length >= 150 ? "complete" : "in progress",
			stageLogEnd: log.endLine,
			plannedRuns: 150,
			runs: setRecords.length,
			spentUsd: cost(setRecords),
			droppedItems: r.droppedItems,
			notes: [
				"One run per item, scored by the benchmark's own published scorer; no model judges. Cost per solved counts items scored 1.",
			],
			tools: byToolOrder(tools),
			comparisons: comparisonsOut(r.comparisons),
		});
	}
}

const pilotUsd = 19.52;
const spendByTest = {
	pilot: pilotUsd,
	A: tests.find((t) => t.id === "A").spentUsd,
	B: tests.find((t) => t.id === "B").spentUsd,
	D: tests.find((t) => t.id === "D").spentUsd,
	F: tests.find((t) => t.id === "F").spentUsd,
	G: sum(jsonl(join(OUT, "G", "spend.jsonl")).map((s) => s.chargedUsd ?? 0)),
};

const commit = (() => {
	try {
		return execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	} catch {
		return null;
	}
})();

const output = {
	round: 1,
	generatedAt: new Date().toISOString(),
	status: tests.every((t) => t.status === "complete") ? "complete" : "in progress",
	repository: REPO,
	commit,
	preregistration: `${REPO}/blob/main/PREREGISTRATION.md`,
	statistics: {
		unit: "The task (an item in test G). A tool's score on a task is its mean over that task's runs.",
		comparison: "The mean over tasks both tools ran of (Relay's score minus the other tool's score), in points.",
		interval: `95% percentile bootstrap over tasks, ${RESAMPLES} resamples, seed ${SEED}.`,
		words: [
			{ rule: "Entirely above +15 points", word: "much better" },
			{ rule: "Entirely above 0", word: "better" },
			{ rule: "Includes 0", word: "no clear difference" },
			{ rule: "Entirely below 0", word: "worse" },
		],
		primary: "Test A, requirements met: Relay against Claude Code and Relay against Prime Agent. Everything else is secondary.",
	},
	measures: {
		score: "Requirements met (long requests) or solved (everyday changes, Terminal-Bench, long-context sets), percent.",
		checksPassed: "The share of the judge's individual checks a run passes (long requests, secondary), percent.",
		allRunsPass: "The share of tasks where every run succeeded, percent.",
		saidDoneButFailed: "The share of runs where the tool reported success and the judge failed it, percent.",
		costPerSolvedUsd: "Metered cost divided by successful runs (every part met, or solved).",
		medianMinutes: "Median wall time of a run.",
	},
	tests,
	testsNotRun: [
		{ id: "C", title: "GPT-6.1 Sol and GPT-6 Luna", reason: "Not run: the round has no OpenAI credit (amendment 3)." },
		{
			id: "E",
			title: "Learning",
			reason: "Not run: it needs a Relay change (lessons that can be held still) and 60 further tasks (amendment 3).",
		},
	],
	cuts: [
		"Test B runs the 12 long requests once each instead of 3 times; the 12 everyday changes run 3 times (amendment 2).",
		"Test D runs one long request instead of two (amendment 2).",
		`Test A was not shrunk; it stopped at its $190 cap after ${tests.find((t) => t.id === "A").runs} of 108 runs.`,
	],
	pilotTasks: {
		tasks: ["node-spreadsheet", "py-mini-sql"],
		note: "The large pilot ran on these two long requests and found four Relay defects, fixed in Relay 0.6.118 before the round (amendment 2).",
	},
	pins: {
		sandboxTemplate: TEMPLATE_NAME,
		...PINS,
		terminalBench: { harbor: HARBOR_VERSION, dataset: `${DATASET}@${DATASET_REF}` },
		longContext: Object.fromEntries(
			Object.entries(JSON.parse(readFileSync(join(ROOT, "runner", "longctx-manifest.json"), "utf8")).sets).map(([k, v]) => [
				k,
				{ dataset: v.source.dataset, revision: v.source.revision, scorer: `${v.scorer.repo}@${v.scorer.commit}` },
			]),
		),
	},
	spend: {
		note: "Metered model spend in US dollars, from the round's meter. The pilot figure is amendment 2's.",
		budgetUsd: 400,
		byTest: spendByTest,
		totalUsd: sum(Object.values(spendByTest)),
	},
};

const to = join(ROOT, args.to);
mkdirSync(dirname(to), { recursive: true });
writeFileSync(to, `${JSON.stringify(output, null, 2)}\n`);
console.log(`wrote ${args.to}: ${tests.map((t) => `${t.id} ${t.runs}/${t.plannedRuns} ${t.status}`).join(", ")}; spend $${output.spend.totalUsd.toFixed(2)}`);
