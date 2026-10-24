#!/usr/bin/env node
// The scoreboard: one file, results/scoreboard.json, that says how Relay's meta-harness and each single tool score on
// every public benchmark the bench runs (Terminal-Bench 2.1, SWE-bench Verified, SWE-bench Pro) and on Relay's sealed
// exam, per benchmark and model, rebuilt every week from the records those runs left. Numbers only.
//
// - Every number comes from the trials' own records (runner/harbor-bench.mjs, runner/tb21.mjs, runner/run-stage.mjs) by
//   PREREGISTRATION.md's rules: the task is the unit, a tool's score on a task is its mean over that task's trials, and
//   the 95% interval is the round's bootstrap over tasks (runner/analyze.mjs: 10,000 resamples, seed 20261015). A task
//   whose infrastructure failed twice for any tool is dropped for every entry.
// - "Relay meta-harness" is scored from the same trials the single tools ran: the picker's choice over each task's
//   attempts (meta/pick-groups.mjs), never seeing a grade. Its cost is every attempt's plus the picker's; picker answers
//   are read from each stage's picks file and never asked for here, so building the scoreboard costs nothing. Groups
//   the picker has not answered yet are counted, not guessed.
// - The sealed exam (TIERS.md) is published as counts and scores only: no task names, no per-task numbers.
// - No words for results: no "better", "worse" or "beats", only each number and its interval.
//
//   node scripts/scoreboard.mjs                       builds results/scoreboard.json from runs/ and ../relay-exam
//   node scripts/scoreboard.mjs --dry-run             prints what it would write
//   node scripts/scoreboard.mjs --install-schedule weekly    the weekly job (macOS launchd; prints a crontab line)
//   node scripts/scoreboard.mjs --remove-schedule
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isoWeek } from "../loop/cycle.mjs";
import { crontabLine, plist, plistPath, secretLike } from "../loop/schedule.mjs";
import { buildGroups, defaultArms, droppedTasks, harborLoader, metaEntry, outcomeOf, patchLoader, PICKER_EFFORT, PICKER_MODEL, runPicks } from "../meta/pick-groups.mjs";
import { bootstrap, loadRecords, RESAMPLES, SEED } from "../runner/analyze.mjs";
import { BENCHMARKS, HARBOR_VERSION, loadBenchmark } from "../runner/harbor-bench.mjs";
import { BAR_STAGES } from "./export-bar.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
export const REPOSITORY = "https://github.com/cicada0007/relay-bench";

/**
 * Where each benchmark's records are. `stage` is a Harbor stage folder under the runs folder; `reuse` names picker
 * answers from elsewhere that the entry may count (round 1's exam asked about these same Terminal-Bench pairs).
 */
export const SOURCES = Object.freeze([
	{ benchmark: "terminal-bench-2-1", stage: "round-1/F", label: "Round 1, test F", reuse: ["meta/pick-exam-gpt-6.1-sol-medium.jsonl"] },
	{ benchmark: "terminal-bench-2-1", stage: "scoreboard/terminal-bench-2-1" },
	{ benchmark: "swebench-verified", stage: "scoreboard/swebench-verified" },
	{ benchmark: "swebench-pro", stage: "scoreboard/swebench-pro" },
]);

/** Checked in Harbor's registry on 24 Oct 2026 (Harbor 0.24.0): asked for, and not there as an official release. */
export const NOT_IN_REGISTRY = Object.freeze([
	{
		name: "Terminal-Bench 4.0",
		checked: "2026-10-24",
		harbor: HARBOR_VERSION,
		note: "The terminal-bench organisation publishes terminal-bench, terminal-bench-2 and terminal-bench-2-1 only. The 4.0 copies in the registry belong to a personal account (ryanmarten/terminal-bench-4-no-prebuild, tagged 4.0.0, and ryanmarten/tb4-preview), so the scoreboard does not run them.",
	},
]);

const MODEL_NAMES = {
	"claude-haiku-5-5": "Claude Haiku 5.5",
	"claude-sonnet-5-5": "Claude Sonnet 5.5",
	"claude-opus-5-5": "Claude Opus 5.5",
	"gpt-6-luna": "GPT-6 Luna",
	"gpt-6.1-sol": "GPT-6.1 Sol",
	"gpt-6-sol": "GPT-6 Sol",
	"gpt-6-astra": "GPT-6 Astra",
};
const TOOL_NAMES = { relay: "Relay", "claude-code": "Claude Code", codex: "Codex", "prime-agent": "Prime Agent", hermes: "Hermes" };
const TOOL_ORDER = ["relay", "claude-code", "codex", "prime-agent", "hermes"];
const baseTool = (tool) => tool.split("@")[0];
const rank = (tool) => (TOOL_ORDER.includes(baseTool(tool)) ? TOOL_ORDER.indexOf(baseTool(tool)) : TOOL_ORDER.length);

/** A tool's name with the version its trials ran: from Harbor's agent record, or the arm's own name (relay@0.6.121). */
export function toolName(tool, records) {
	const version = tool.includes("@") ? tool.split("@")[1] : records.find((r) => r.agent?.version)?.agent.version;
	const name = TOOL_NAMES[baseTool(tool)] ?? baseTool(tool);
	return version ? `${name} ${version}` : name;
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const readJsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const byTaskOf = (records) => {
	const tasks = new Map();
	for (const r of records) {
		if (!tasks.has(r.task)) tasks.set(r.task, []);
		tasks.get(r.task).push(r);
	}
	return tasks;
};

/** One single tool's numbers on one run: as runner/tb21-analyze.mjs reports a tool, for any grade. */
export function toolEntry(tool, records) {
	const tasks = byTaskOf(records);
	const scores = [...tasks.values()].map((rs) => 100 * mean(rs.map(outcomeOf)));
	const cost = records.reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0);
	const solves = records.filter((r) => outcomeOf(r) === 1).length;
	const minutes = records.map((r) => r.wallMs ?? 0).sort((a, b) => a - b);
	return {
		id: tool,
		name: toolName(tool, records),
		kind: "tool",
		tasks: tasks.size,
		trials: records.length,
		score: scores.length ? mean(scores) : null,
		...(scores.length > 1 ? bootstrap(scores) : { low: null, high: null }),
		allTrialsSolved: tasks.size ? 100 * mean([...tasks.values()].map((rs) => (rs.every((r) => outcomeOf(r) === 1) ? 1 : 0))) : null,
		costUsd: cost,
		costPerSolvedUsd: solves ? cost / solves : null,
		medianMinutes: minutes.length ? minutes[Math.floor(minutes.length / 2)] / 60_000 : null,
		unmeteredTrials: records.filter((r) => !r.usage).length,
		stoppedAtCap: records.filter((r) => r.stoppedAtCap).length,
	};
}

/** Per task score (percent) of an entry: a tool's mean over its trials, the meta-harness's mean over its groups. */
const taskScores = (pairs) => new Map([...byTaskOf(pairs)].map(([task, rs]) => [task, 100 * mean(rs.map((r) => r.value))]));

/** `a` minus `b` over the tasks both have: mean per-task difference in points and its interval. */
export function difference(a, b) {
	const shared = [...a.keys()].filter((t) => b.has(t)).sort();
	if (shared.length < 2) return null;
	const diffs = shared.map((t) => a.get(t) - b.get(t));
	return { tasks: shared.length, points: mean(diffs), ...bootstrap(diffs) };
}

/**
 * One run (a stage on one model): every tool's entry, the meta-harness's entry when two or more tools ran, and the
 * differences: the meta-harness minus each tool, and Relay minus each other tool. `loader` reads an attempt's evidence
 * for the picker's input; `reuse` holds the picker answers this run may count; nothing is asked.
 */
export async function scoreRun({ records, loader, reuse = [], planned = null, sealed = false }) {
	const dropped = droppedTasks(records);
	const counted = records.filter((r) => !dropped.includes(r.task));
	const tools = [...new Set(counted.map((r) => r.tool))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
	const entries = tools.map((tool) => toolEntry(tool, counted.filter((r) => r.tool === tool)));
	const scores = new Map(tools.map((tool) => [tool, taskScores(counted.filter((r) => r.tool === tool).map((r) => ({ task: r.task, value: outcomeOf(r) })))]));
	if (tools.length >= 2) {
		const arms = defaultArms(counted);
		const { groups } = buildGroups(records, arms);
		const picked = await runPicks({ groups, loader, reuse, ask: "split", dryRun: true, log: () => {} });
		const entry = metaEntry({ rows: picked.rows, groups, left: picked.left, arms });
		entries.push({ id: "meta", name: "Relay meta-harness", ...entry });
		scores.set("meta", taskScores(picked.rows.map((r) => ({ task: r.task, value: r.metaOutcome }))));
	}
	const differences = [];
	const add = (of, minus) => {
		const d = difference(scores.get(of), scores.get(minus));
		if (d) differences.push({ of, minus, ...d });
	};
	if (scores.has("meta")) for (const tool of tools) add("meta", tool);
	const relay = tools.find((t) => baseTool(t) === "relay");
	if (relay) for (const tool of tools) if (tool !== relay) add(relay, tool);
	const reps = Math.max(0, ...records.map((r) => r.rep ?? 1));
	const plannedTasks = planned ?? [...new Set(records.map((r) => r.task))];
	const have = new Set(records.map((r) => `${r.task}|${r.tool}|${r.rep}`));
	let trialsNotMade = 0;
	for (let rep = 1; rep <= reps; rep++) for (const task of plannedTasks) for (const tool of tools) if (!have.has(`${task}|${tool}|${rep}`)) trialsNotMade++;
	const started = records.map((r) => r.startedAt).filter(Boolean).sort();
	return {
		status: records.length === 0 ? "not run yet" : trialsNotMade === 0 && entries.every((e) => e.kind !== "meta" || e.groupsNotDecided === 0) ? "complete" : "in progress",
		tasks: new Set(counted.map((r) => r.task)).size,
		trialsPerTask: reps,
		trialsNotMade,
		...(sealed ? { droppedTaskCount: dropped.length } : { droppedTasks: dropped }),
		firstTrial: started[0]?.slice(0, 10) ?? null,
		lastTrial: started.at(-1)?.slice(0, 10) ?? null,
		entries,
		differences,
	};
}

/** Picker answers a stage may count: its own picks file, and the source's `reuse` files under the runs folder. */
function picksFor(stageDir, runsDir, reuse = []) {
	const own = join(stageDir, "meta", `picks-${PICKER_MODEL}-${PICKER_EFFORT}.jsonl`);
	return [own, ...reuse.map((p) => join(runsDir, p))].flatMap(readJsonl);
}

const runsOf = (records) => {
	const runs = new Map();
	for (const r of records) {
		const id = `${r.test}|${r.model}`;
		if (!runs.has(id)) runs.set(id, []);
		runs.get(id).push(r);
	}
	return runs;
};

const MODEL_ORDER = Object.keys(MODEL_NAMES);
const byModel = (a, b) => MODEL_ORDER.indexOf(a.model) - MODEL_ORDER.indexOf(b.model) || a.test.localeCompare(b.test);

/** One public benchmark: its pinned dataset and every run of it in the runs folder. */
export async function publicBenchmark(id, runsDir, sources = SOURCES) {
	const bench = loadBenchmark(id);
	const out = {
		id,
		title: bench.title,
		kind: "public",
		dataset: `${bench.dataset}@${bench.ref}`,
		datasetRevision: bench.revision,
		harbor: HARBOR_VERSION,
		tasksInSet: bench.tasks.length,
		measure: bench.measure,
		runs: [],
	};
	for (const source of sources.filter((s) => s.benchmark === id)) {
		const stageDir = join(runsDir, source.stage);
		const records = readJsonl(join(stageDir, "records.jsonl"));
		const sample = existsSync(join(stageDir, "sample.json")) ? JSON.parse(readFileSync(join(stageDir, "sample.json"), "utf8")).tasks : null;
		const reuse = picksFor(stageDir, runsDir, source.reuse);
		for (const [, rs] of runsOf(records)) {
			const { test, model } = rs[0];
			const planned = sample ?? (test.startsWith("dev-") ? null : bench.tasks.map((t) => t.name));
			const result = await scoreRun({ records: rs, loader: harborLoader(stageDir), reuse, planned });
			out.runs.push({ test, label: source.label ?? test, model, modelName: MODEL_NAMES[model] ?? model, ...(sample ? { sample: sample.length } : {}), ...result });
		}
	}
	out.runs.sort(byModel);
	out.status = out.runs.length === 0 ? "not run yet" : out.runs.every((r) => r.status === "complete") ? "complete" : "in progress";
	return out;
}

/** Relay's sealed exam: the bar's stages (RUNBOOK.md, "The bar"), numbers only, no task names. */
export async function examBenchmark(examDir) {
	const out = { id: "exam", title: "Relay's sealed exam", kind: "sealed", measure: "requirements met", runs: [] };
	const runsDir = join(examDir, "runs", "bar");
	const tasksDir = join(examDir, "tasks");
	if (existsSync(join(runsDir, "records.jsonl"))) {
		const reuse = readJsonl(join(runsDir, "meta", `picks-${PICKER_MODEL}-${PICKER_EFFORT}.jsonl`));
		for (const stage of BAR_STAGES) {
			const records = loadRecords(runsDir, stage.id);
			if (!records.length) continue;
			const result = await scoreRun({ records, loader: patchLoader(runsDir, [tasksDir]), reuse, sealed: true });
			out.runs.push({ test: stage.id, label: stage.title, model: stage.model, modelName: MODEL_NAMES[stage.model] ?? stage.model, ...(stage.sample ? { sample: stage.sample } : {}), ...result });
		}
	}
	out.runs.sort(byModel);
	out.status = out.runs.length === 0 ? "not run yet" : out.runs.every((r) => r.status === "complete") ? "complete" : "in progress";
	return out;
}

/** This week's headline numbers, one line per entry, for the history the file carries from week to week. */
export function weekRows(week, benchmarks) {
	return benchmarks.flatMap((b) =>
		b.runs.flatMap((run) =>
			run.entries.map((e) => ({ week, benchmark: b.id, test: run.test, model: run.model, entry: e.id, name: e.name, score: e.score, low: e.low, high: e.high, costPerSolvedUsd: e.costPerSolvedUsd })),
		),
	);
}

/** The whole scoreboard. `previous` is last week's file: its history is carried, this week's lines replaced. */
export async function buildScoreboard({ runsDir, examDir, week = isoWeek(), generatedAt = new Date().toISOString(), commit = null, previous = null, sources = SOURCES }) {
	const benchmarks = [];
	for (const id of Object.keys(BENCHMARKS)) benchmarks.push(await publicBenchmark(id, runsDir, sources));
	benchmarks.push(await examBenchmark(examDir));
	const history = [...(previous?.history ?? []).filter((h) => h.week !== week), ...weekRows(week, benchmarks)].sort((a, b) => a.week.localeCompare(b.week));
	return {
		scoreboard: 1,
		week,
		generatedAt,
		repository: REPOSITORY,
		commit,
		preregistration: `${REPOSITORY}/blob/main/PREREGISTRATION.md`,
		statistics: {
			unit: "The task. An entry's score on a task is its mean over that task's trials (the meta-harness: over that task's groups of attempts).",
			interval: `95% percentile bootstrap over tasks, ${RESAMPLES} resamples, seed ${SEED}.`,
			difference: "The mean over the tasks both entries ran of (the first entry's score minus the second's), in points, with the same interval.",
			dropped: "A task where our infrastructure failed twice for any tool is dropped for every entry.",
			sameModel: "Every entry in a run uses the same model, tasks, limits and meter. Claude Code runs Anthropic models and Codex OpenAI models, so each is in the runs of its own provider's models.",
		},
		measures: {
			score: "Solved (Terminal-Bench), resolved (SWE-bench) or requirements met (the exam), percent.",
			allTrialsSolved: "The share of tasks where every trial succeeded, percent.",
			costUsd: "Metered model spend of every trial counted, in dollars.",
			costPerSolvedUsd: "Metered cost divided by the trials (or, for the meta-harness, the groups) that succeeded.",
			medianMinutes: "Median wall time of a trial; for the meta-harness, of its slowest attempt in a group plus the picker's measured time.",
		},
		metaHarness: {
			name: "Relay meta-harness",
			what: "Every single tool in a run works on the same task; the picker reads each attempt's actions and their output (or its change and the project's own checks) and keeps one. Its grade on a task is the grade of the attempt it kept.",
			picker: `${PICKER_MODEL}, ${PICKER_EFFORT} effort (meta/pick.mjs).`,
			blind: "The picker never sees a grade, the hidden tests, any tool's words about its own work, or which tool made which attempt.",
			cost: "Every attempt in the group plus the picker. Where the picker was asked only about groups the grader split, its cost on the other groups is estimated from the asked calls' mean and shown apart.",
			groups: "A group is one task's attempts with the same trial number, one per tool. A group where an attempt kept no record of its actions is left out and counted.",
		},
		notInRegistry: NOT_IN_REGISTRY,
		benchmarks,
		history,
	};
}

/** The weekly job's arguments: no key, ever. */
export function scheduleArgsFor(extra = []) {
	const args = ["--weekly", ...extra];
	for (const a of args) if (secretLike(a)) throw new Error("a schedule never carries a key");
	return args;
}

export const SCHEDULE_LABEL = "com.relayevals.relay-scoreboard";
/** Monday 07:00 local time, an hour after the autopilot's weekly run. */
export const SCHEDULE_WHEN = Object.freeze({ weekday: 1, hour: 7, minute: 0 });

const pct = (v) => (v === null || v === undefined ? "–" : `${v.toFixed(1)}%`);
const usd = (v) => (v === null || v === undefined ? "–" : `$${v.toFixed(3)}`);

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values: args } = parseArgs({
		options: {
			runs: { type: "string", default: join(ROOT, "runs") },
			exam: { type: "string", default: join(ROOT, "..", "relay-exam") },
			to: { type: "string", default: join(ROOT, "results", "scoreboard.json") },
			week: { type: "string" },
			weekly: { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			"install-schedule": { type: "string" },
			"remove-schedule": { type: "boolean", default: false },
		},
	});
	if (args["install-schedule"] !== undefined) {
		if (args["install-schedule"] !== "weekly") throw new Error("--install-schedule takes weekly");
		const bench = ROOT.replace(/\/$/, "");
		const logDir = join(bench, "runs", "scoreboard");
		const schedArgs = scheduleArgsFor();
		const text = plist({ bench, node: process.execPath, args: schedArgs, logDir, when: SCHEDULE_WHEN, script: "scripts/scoreboard.mjs", label: SCHEDULE_LABEL });
		const path = plistPath(homedir(), SCHEDULE_LABEL);
		mkdirSync(dirname(path), { recursive: true });
		mkdirSync(logDir, { recursive: true });
		writeFileSync(path, text);
		console.log(`wrote ${path}: every Monday at 07:00, node scripts/scoreboard.mjs ${schedArgs.join(" ")} (free: it reads records, asks nothing)`);
		const uid = String(process.getuid?.() ?? "");
		spawnSync("launchctl", ["bootout", `gui/${uid}/${SCHEDULE_LABEL}`]);
		const loaded = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, path], { encoding: "utf8" });
		console.log(loaded.status === 0 ? "loaded it with launchctl; it runs next Monday" : `launchctl bootstrap failed; load it with: launchctl bootstrap gui/${uid} ${path}`);
		console.log(`On Linux, the same job as a crontab line:\n${crontabLine({ bench, node: process.execPath, args: schedArgs, when: SCHEDULE_WHEN, envFile: "/dev/null", script: "scripts/scoreboard.mjs", log: "runs/scoreboard/weekly.log" })}`);
		process.exit(0);
	}
	if (args["remove-schedule"]) {
		const path = plistPath(homedir(), SCHEDULE_LABEL);
		spawnSync("launchctl", ["bootout", `gui/${process.getuid?.()}/${SCHEDULE_LABEL}`]);
		if (existsSync(path)) rmSync(path);
		console.log(`removed ${path}`);
		process.exit(0);
	}
	const previous = existsSync(args.to) ? JSON.parse(readFileSync(args.to, "utf8")) : null;
	const commit = (() => {
		try {
			return execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		} catch {
			return null;
		}
	})();
	const board = await buildScoreboard({ runsDir: resolve(args.runs), examDir: resolve(args.exam), week: args.week ?? isoWeek(), commit, previous });
	for (const b of board.benchmarks) {
		console.log(`${b.title}: ${b.status}`);
		for (const run of b.runs) {
			console.log(`  ${run.label}, ${run.modelName}: ${run.status}, ${run.tasks} tasks${run.trialsNotMade ? `, ${run.trialsNotMade} trials not made` : ""}`);
			for (const e of run.entries) console.log(`    ${e.name.padEnd(24)} ${pct(e.score).padStart(6)}  ${pct(e.low)} to ${pct(e.high)}  cost/solved ${usd(e.costPerSolvedUsd)}${e.kind === "meta" && e.groupsNotDecided ? `  (${e.groupsNotDecided} groups not picked yet)` : ""}`);
		}
	}
	if (args["dry-run"]) process.exit(0);
	mkdirSync(dirname(args.to), { recursive: true });
	writeFileSync(args.to, `${JSON.stringify(board, null, 2)}\n`);
	console.log(`wrote ${args.to} (week ${board.week})`);
}
