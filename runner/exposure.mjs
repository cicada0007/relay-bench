// The leak budget (GATE.md amendment 1, TIERS.md): every time a sealed task (exam or check tier) is shown to a run, and
// every time a result that depends on it is read, it is counted in a log beside the exam. Past its budget a task is
// spent: a stage refuses to run it, the gate refuses to give a verdict that counts it, and the check tier refuses to
// answer about it. A spent task is replaced by fresh ones (the living exam), never reset.
//
// The log is `exposure.jsonl` beside the tasks folder, and the budget `leak-budget.json` beside it (the defaults below
// when there is none), so both stay private with the exam. One line per event:
//   { "at": "...", "kind": "run" | "read", "tier": "exam", "tasks": ["id", ...], "test": "...", "by": "run-stage", "key": "..." }
// A read with a key counts once however often it is repeated: reading the same look of the same gate again shows nothing new.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * How often one sealed task may be exposed. `runsPerTask`: runs that saw its request and repository (a gate of two
 * arms and one run each uses 2; anchors use 2 every release). `readsPerTask`: results read that depend on it (a gate's
 * look, a check-tier answer), each of which tells whoever reads it a little about the task.
 */
export const LEAK_BUDGET = Object.freeze({
	exam: Object.freeze({ runsPerTask: 40, readsPerTask: 26 }),
	check: Object.freeze({ runsPerTask: 40, readsPerTask: 52 }),
});

export const SEALED = Object.freeze(Object.keys(LEAK_BUDGET));

export const exposurePathFor = (tasksDir) => join(dirname(resolve(tasksDir)), "exposure.jsonl");
export const budgetPathFor = (tasksDir) => join(dirname(resolve(tasksDir)), "leak-budget.json");

/** The budget for a tasks folder: its leak-budget.json over the defaults. A budget can be lowered there, not raised
 *  past twice the default, so a typo cannot open the exam. */
export function loadBudget(tasksDir) {
	const path = budgetPathFor(tasksDir);
	const own = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
	const budget = {};
	for (const [tier, limits] of Object.entries(LEAK_BUDGET)) {
		budget[tier] = {};
		for (const [name, value] of Object.entries(limits)) {
			const set = own?.[tier]?.[name];
			if (set === undefined) budget[tier][name] = value;
			else if (!Number.isInteger(set) || set < 0 || set > 2 * value) throw new Error(`${path}: ${tier}.${name} must be a whole number from 0 to ${2 * value}`);
			else budget[tier][name] = set;
		}
	}
	return budget;
}

export function readExposures(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

export function recordExposure(path, entry, now = new Date()) {
	if (!["run", "read"].includes(entry.kind)) throw new Error(`an exposure is a run or a read, not ${entry.kind}`);
	if (!SEALED.includes(entry.tier)) throw new Error(`only sealed tiers are counted, not ${entry.tier}`);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify({ at: now.toISOString(), ...entry })}\n`);
}

/** Per task: { tier, runs, reads }. Reads with the same key count once. */
export function exposureCounts(entries) {
	const counts = new Map();
	const keys = new Set();
	for (const e of entries) {
		if (e.kind === "read" && e.key) {
			if (keys.has(e.key)) continue;
			keys.add(e.key);
		}
		for (const task of e.tasks ?? []) {
			if (!counts.has(task)) counts.set(task, { tier: e.tier, runs: 0, reads: 0 });
			const c = counts.get(task);
			if (e.kind === "run") c.runs++;
			else if (e.kind === "read") c.reads++;
		}
	}
	return { counts, keys };
}

/**
 * Why these new exposures would pass the budget; empty when they fit. `add` is a list of planned entries
 * ({ kind, tier, tasks, key }); tasks already past their budget count as problems too.
 */
export function budgetProblems({ entries, add = [], budget = LEAK_BUDGET }) {
	const { counts, keys } = exposureCounts(entries);
	const after = new Map([...counts].map(([t, c]) => [t, { ...c }]));
	for (const e of add) {
		if (!SEALED.includes(e.tier)) continue;
		if (e.kind === "read" && e.key && keys.has(e.key)) continue;
		for (const task of e.tasks ?? []) {
			if (!after.has(task)) after.set(task, { tier: e.tier, runs: 0, reads: 0 });
			after.get(task)[e.kind === "run" ? "runs" : "reads"]++;
		}
	}
	const touched = new Set(add.flatMap((e) => e.tasks ?? []));
	const problems = [];
	for (const task of [...touched].sort()) {
		const c = after.get(task);
		const limits = budget[c?.tier];
		if (!limits) continue;
		if (c.runs > limits.runsPerTask) problems.push(`${task} would be shown to ${c.runs} runs; its budget is ${limits.runsPerTask}`);
		if (c.reads > limits.readsPerTask) problems.push(`${task} would be read ${c.reads} times; its budget is ${limits.readsPerTask}`);
	}
	return problems;
}
