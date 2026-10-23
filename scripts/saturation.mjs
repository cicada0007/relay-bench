#!/usr/bin/env node
// Saturation (TIERS.md, "The living exam"): when the champion passes 90% or more of a tier's latest runs at one level,
// that level no longer tells releases apart. It is flagged, and a draft queue opens for the next, harder level, so the
// exam gets harder by itself. Humans still approve every task; this only opens the queue.
//
// A level is a band of mined changes by size (LEVELS below): level 1 is any candidate the miner keeps, level 2 a change
// of at least 120 lines over at least 2 source files, level 3 at least 250 lines over at least 4. A task's level is in
// its task.json ("level", 1 when absent; scripts/draft-task.mjs --level writes it).
//
//   node scripts/saturation.mjs --records ../relay-exam/runs/gate/records.jsonl --tasks-dir ../relay-exam/tasks \
//     --tool relay@0.6.121 [--exam ../relay-exam] [--json]
//
// With --exam, a saturated level opens <exam>/queue/harder.json (once per tier and level). Free: it reads records only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readTasks } from "../runner/stage-tasks.mjs";

export const SATURATION = Object.freeze({ threshold: 0.9, runs: 50 });
export const LEVELS = Object.freeze([
	Object.freeze({ level: 2, minChangedLines: 120, minSourceFiles: 2 }),
	Object.freeze({ level: 3, minChangedLines: 250, minSourceFiles: 4 }),
]);

/** A mined candidate's level: the highest whose size it reaches. */
export function levelOf(candidate) {
	let level = 1;
	for (const l of LEVELS) {
		if ((candidate.changedLines ?? 0) >= l.minChangedLines && (candidate.files?.source?.length ?? 0) >= l.minSourceFiles) level = l.level;
	}
	return level;
}

/**
 * Per tier and level, the champion's pass rate over its latest `runs` graded runs (a run passes when it meets every
 * requirement), and whether that is at or above `threshold`. `tasks` maps a task id to its task.json.
 */
export function saturation(records, tasks, { tool, threshold = SATURATION.threshold, runs = SATURATION.runs } = {}) {
	const groups = new Map();
	const graded = records
		.filter((r) => r.tool === tool && typeof r.score?.share === "number")
		.map((r, i) => ({ r, i }))
		.sort((a, b) => String(a.r.finishedAt ?? "").localeCompare(String(b.r.finishedAt ?? "")) || a.i - b.i)
		.map(({ r }) => r);
	for (const r of graded) {
		const task = tasks.get(r.task);
		const key = `${task?.tier ?? "practice"}|${task?.level ?? 1}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(r);
	}
	return [...groups]
		.map(([key, rs]) => {
			const [tier, level] = key.split("|");
			const latest = rs.slice(-runs);
			const passed = latest.filter((r) => r.score.share === 1).length;
			const passRate = latest.length ? passed / latest.length : 0;
			return { tier, level: Number(level), runs: latest.length, passed, passRate, saturated: latest.length >= runs && passRate >= threshold };
		})
		.sort((a, b) => a.tier.localeCompare(b.tier) || a.level - b.level);
}

export const harderPath = (exam) => join(exam, "queue", "harder.json");

/** The harder levels opened so far: { opened: [{ tier, level, fromLevel, passRate, runs, openedAt, criteria }] }. */
export function readHarder(exam) {
	const path = harderPath(exam);
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { opened: [] };
}

/** The highest level open for drafting on a tier: 1 until a harder one is opened. */
export function openLevel(exam, tier) {
	return Math.max(1, ...readHarder(exam).opened.filter((o) => o.tier === tier).map((o) => o.level));
}

/** Opens the next level's draft queue for each saturated level not opened before; returns what it opened. */
export function openHarder(exam, results, { now = new Date(), write = true } = {}) {
	const harder = readHarder(exam);
	const opened = [];
	for (const s of results.filter((x) => x.saturated)) {
		const next = s.level + 1;
		if (harder.opened.some((o) => o.tier === s.tier && o.level >= next)) continue;
		const criteria = LEVELS.find((l) => l.level === next) ?? null;
		const entry = { tier: s.tier, level: next, fromLevel: s.level, passRate: s.passRate, runs: s.runs, openedAt: now.toISOString(), criteria };
		harder.opened.push(entry);
		opened.push(entry);
	}
	if (write && opened.length) {
		mkdirSync(dirname(harderPath(exam)), { recursive: true });
		writeFileSync(harderPath(exam), `${JSON.stringify(harder, null, 2)}\n`);
	}
	return opened;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values } = parseArgs({ options: { records: { type: "string" }, "tasks-dir": { type: "string" }, tool: { type: "string" }, exam: { type: "string" }, json: { type: "boolean", default: false } } });
	for (const name of ["records", "tasks-dir", "tool"]) if (!values[name]) throw new Error(`--${name} is required`);
	const records = readFileSync(resolve(values.records), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const results = saturation(records, readTasks(resolve(values["tasks-dir"])), { tool: values.tool });
	const opened = values.exam ? openHarder(resolve(values.exam), results) : [];
	if (values.json) console.log(JSON.stringify({ results, opened }, null, 2));
	else {
		for (const s of results) console.log(`${s.tier} level ${s.level}: ${s.passed} of ${s.runs} latest runs passed (${(100 * s.passRate).toFixed(1)}%)${s.saturated ? ", saturated" : ""}`);
		for (const o of opened) console.log(`opened a draft queue for ${o.tier} level ${o.level}`);
	}
}
