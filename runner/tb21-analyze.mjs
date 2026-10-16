#!/usr/bin/env node
// Test F's results, by the rules PREREGISTRATION.md fixes, from <out>/<test>/records.jsonl (runner/tb21.mjs).
// - The unit is the task. A tool's score on a task is its solved share over that task's trials.
// - Per tool: solved share (mean over tasks), with the 95% bootstrap interval over tasks; metered cost; cost per solve.
// - Relay minus each other tool: the mean over shared tasks of the per-task difference, its interval, and its word.
// - Intervals: runner/analyze.mjs's bootstrap (10,000 resamples, seed 20261015, percentile).
// - A task with an infrastructure failure recorded for any tool is dropped for every tool, and listed.
//
//   node runner/tb21-analyze.mjs --out runs/round-1 [--test F] [--json]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { bootstrap, word } from "./analyze.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

export function analyzeTb21(records) {
	const dropped = [...new Set(records.filter((r) => r.infra).map((r) => r.task))].sort();
	const counted = records.filter((r) => !dropped.includes(r.task));
	const byTool = new Map();
	for (const r of counted) {
		if (!byTool.has(r.tool)) byTool.set(r.tool, new Map());
		const tasks = byTool.get(r.tool);
		if (!tasks.has(r.task)) tasks.set(r.task, []);
		tasks.get(r.task).push(r);
	}
	const taskScore = (rs) => mean(rs.map((r) => (r.solved ? 1 : 0)));
	const tools = {};
	for (const [tool, tasks] of byTool) {
		const trials = [...tasks.values()].flat();
		const scores = [...tasks.values()].map((rs) => 100 * taskScore(rs));
		const cost = trials.reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0);
		const solves = trials.filter((r) => r.solved).length;
		const minutes = trials.map((r) => r.wallMs ?? 0).sort((a, b) => a - b);
		tools[tool] = {
			tasks: tasks.size,
			trials: trials.length,
			solvedShare: mean(scores),
			...(scores.length > 1 ? bootstrap(scores) : { low: null, high: null }),
			allTrialsSolved: 100 * mean([...tasks.values()].map((rs) => (rs.every((r) => r.solved) ? 1 : 0))),
			costUsd: cost,
			costPerSolvedUsd: solves ? cost / solves : null,
			unmeteredTrials: trials.filter((r) => !r.usage).length,
			stoppedAtCap: trials.filter((r) => r.stoppedAtCap).length,
			medianMinutes: minutes.length ? minutes[Math.floor(minutes.length / 2)] / 60_000 : null,
		};
	}
	const comparisons = {};
	const relay = byTool.get("relay");
	if (relay) {
		for (const [tool, tasks] of byTool) {
			if (tool === "relay") continue;
			const shared = [...tasks.keys()].filter((t) => relay.has(t));
			if (shared.length < 2) continue;
			const diffs = shared.map((t) => 100 * (taskScore(relay.get(t)) - taskScore(tasks.get(t))));
			const interval = bootstrap(diffs);
			comparisons[tool] = { tasks: shared.length, difference: mean(diffs), ...interval, word: word(interval) };
		}
	}
	return { tools, comparisons, dropped };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values: args } = parseArgs({
		options: { out: { type: "string", default: "runs/round-1" }, test: { type: "string", default: "F" }, json: { type: "boolean", default: false } },
	});
	const records = readFileSync(join(ROOT, args.out, args.test, "records.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	const result = analyzeTb21(records);
	if (args.json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		const f = (x, d = 1) => (x === null || x === undefined ? "–" : x.toFixed(d));
		const usd = (x) => (x === null || x === undefined ? "–" : `$${x.toFixed(3)}`);
		console.log(`Test ${args.test} (Terminal-Bench 2.1): ${records.length} trials`);
		console.log("tool          tasks trials  solved  95% interval    all-trials  cost      cost/solve  median-min");
		for (const [tool, s] of Object.entries(result.tools)) {
			console.log(
				`${tool.padEnd(13)} ${String(s.tasks).padStart(5)} ${String(s.trials).padStart(6)}  ${f(s.solvedShare).padStart(6)}  ` +
					`${`${f(s.low)} to ${f(s.high)}`.padEnd(14)}  ${f(s.allTrialsSolved).padStart(10)}  ${usd(s.costUsd).padEnd(8)}  ` +
					`${usd(s.costPerSolvedUsd).padStart(10)}  ${f(s.medianMinutes).padStart(10)}` +
					(s.unmeteredTrials ? `  (${s.unmeteredTrials} trials without a meter log)` : ""),
			);
		}
		for (const [tool, c] of Object.entries(result.comparisons)) {
			console.log(`Relay minus ${tool}: ${f(c.difference)} points, 95% interval ${f(c.low)} to ${f(c.high)} over ${c.tasks} tasks: ${c.word}`);
		}
		if (result.dropped.length) console.log(`Dropped for every tool (infrastructure failed twice): ${result.dropped.join(", ")}`);
	}
}
