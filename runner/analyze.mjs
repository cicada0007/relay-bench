#!/usr/bin/env node
// The analysis exactly as PREREGISTRATION.md fixes it, applied to one test's records.
// - The unit is the task. A tool's score on a task is its mean over that task's runs.
// - A comparison is the mean over tasks of (Relay's score - the other tool's score) on tasks both ran.
// - 95% interval: bootstrap over tasks, 10,000 resamples, seed 20261015, percentile interval.
// - The word comes from the interval only: much better (> +15 points), better (> 0), no clear difference, worse (< 0).
//
//   node runner/analyze.mjs --out runs/round-1 --test A [--json] [--relay relay@0.6.121]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = new URL("..", import.meta.url).pathname;

export const SEED = 20261015;
export const RESAMPLES = 10_000;

/** mulberry32: a small seeded generator, so anyone re-running the analysis gets the same interval. */
export function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Percentile bootstrap over tasks of the mean of per-task differences. */
export function bootstrap(diffs, seed = SEED, resamples = RESAMPLES) {
	const next = rng(seed);
	const means = new Float64Array(resamples);
	for (let i = 0; i < resamples; i++) {
		let sum = 0;
		for (let j = 0; j < diffs.length; j++) sum += diffs[Math.floor(next() * diffs.length)];
		means[i] = sum / diffs.length;
	}
	means.sort();
	return { low: means[Math.floor(0.025 * resamples)], high: means[Math.ceil(0.975 * resamples) - 1] };
}

/** The pre-registered word for an interval of (Relay - other), in points (0-100). */
export function word({ low, high }) {
	if (low > 15) return "much better";
	if (low > 0) return "better";
	if (high < 0) return "worse";
	return "no clear difference";
}

/** One test's analysis. `relay` names Relay's arm in the records: "relay" in round 1, "relay@<version>" when a stage
 *  ran a released version (the bar on the exam); every comparison is that arm minus each other tool. */
export function analyze(records, { relay: relayTool = "relay" } = {}) {
	const byTool = new Map();
	for (const r of records) {
		if (!byTool.has(r.tool)) byTool.set(r.tool, new Map());
		const tasks = byTool.get(r.tool);
		if (!tasks.has(r.task)) tasks.set(r.task, []);
		tasks.get(r.task).push(r);
	}
	const toolSummary = {};
	for (const [tool, tasks] of byTool) {
		const runs = [...tasks.values()].flat();
		const solved = runs.filter((r) => r.score?.share === 1);
		toolSummary[tool] = {
			tasks: tasks.size,
			runs: runs.length,
			score: 100 * mean([...tasks.values()].map((rs) => mean(rs.map((r) => r.score?.share ?? 0)))),
			checksPassed: runs.some((r) => r.score?.checks)
				? 100 * mean([...tasks.values()].map((rs) => mean(rs.map((r) => r.score?.checks?.share ?? 0))))
				: null,
			allRunsPass: 100 * mean([...tasks.values()].map((rs) => (rs.every((r) => r.score?.share === 1) ? 1 : 0))),
			saidDoneButFailed: 100 * mean(runs.map((r) => (r.saidDoneButFailed ? 1 : 0))),
			costUsd: runs.reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0),
			costPerSolvedUsd: solved.length ? runs.reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0) / solved.length : null,
			medianMinutes: (() => {
				const ms = runs.map((r) => r.wallMs ?? 0).sort((a, b) => a - b);
				return ms.length ? ms[Math.floor(ms.length / 2)] / 60_000 : null;
			})(),
		};
	}
	const relay = byTool.get(relayTool);
	const comparisons = {};
	if (relay) {
		for (const [tool, tasks] of byTool) {
			if (tool === relayTool) continue;
			const shared = [...tasks.keys()].filter((t) => relay.has(t));
			if (shared.length < 2) continue;
			const diffs = shared.map(
				(t) => 100 * (mean(relay.get(t).map((r) => r.score?.share ?? 0)) - mean(tasks.get(t).map((r) => r.score?.share ?? 0))),
			);
			const interval = bootstrap(diffs);
			comparisons[tool] = { tasks: shared.length, difference: mean(diffs), ...interval, word: word(interval) };
		}
	}
	return { toolSummary, comparisons };
}

/** One test's records from <out>/records.jsonl. A run graded again after a judge fix (rejudge.mjs) counts with its latest grade. */
export function loadRecords(out, test) {
	const records = readFileSync(join(ROOT, out, "records.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((r) => r.test === test);
	const rejudgedPath = join(ROOT, out, "rejudged.jsonl");
	if (existsSync(rejudgedPath)) {
		const latest = new Map();
		for (const line of readFileSync(rejudgedPath, "utf8").split("\n").filter(Boolean)) {
			const g = JSON.parse(line);
			latest.set(g.runId, g);
		}
		for (const r of records) {
			const g = latest.get(r.runId);
			if (g) Object.assign(r, { judge: g.judge, score: g.score, saidDoneButFailed: g.saidDoneButFailed, rejudgedAt: g.rejudgedAt });
		}
	}
	return records;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values: args } = parseArgs({
		options: {
			out: { type: "string", default: "runs/round-1" },
			test: { type: "string" },
			json: { type: "boolean", default: false },
			relay: { type: "string", default: "relay" },
		},
	});
	if (!args.test) throw new Error("--test is required");
	const records = loadRecords(args.out, args.test);
	const result = analyze(records, { relay: args.relay });
	if (args.json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		const f = (x, d = 1) => (x === null || x === undefined ? "–" : x.toFixed(d));
		console.log(`Test ${args.test}: ${records.length} runs`);
		console.log("tool          tasks runs  score  checks  all-runs-pass  said-done-failed  cost/solved  median-min");
		for (const [tool, s] of Object.entries(result.toolSummary)) {
			console.log(`${tool.padEnd(13)} ${String(s.tasks).padStart(5)} ${String(s.runs).padStart(4)}  ${f(s.score).padStart(5)}  ${f(s.checksPassed).padStart(6)}  ${f(s.allRunsPass).padStart(13)}  ${f(s.saidDoneButFailed).padStart(16)}  ${s.costPerSolvedUsd === null ? "–" : `$${s.costPerSolvedUsd.toFixed(3)}`.padStart(11)}  ${f(s.medianMinutes).padStart(10)}`);
		}
		for (const [tool, c] of Object.entries(result.comparisons)) {
			console.log(`${args.relay === "relay" ? "Relay" : args.relay} minus ${tool}: ${f(c.difference)} points, 95% interval ${f(c.low)} to ${f(c.high)} over ${c.tasks} tasks: ${c.word}`);
		}
	}
}
