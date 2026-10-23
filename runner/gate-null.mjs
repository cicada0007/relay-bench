#!/usr/bin/env node
// The null-change test (GATE.md, amendment 1): how often does the gate's own math accept what it should not?
//
// It simulates gates where the truth is known and runs each one through runner/gate-analyze.mjs exactly as a real
// gate would, look by look, stopping at the first final verdict:
// - "same version": champion against champion. A PASS labelled "better" is a false accept (a gain recorded that is not
//   there); a BLOCK is a false block.
// - "5 points worse": the candidate is truly 5 points worse. Any PASS is a false accept. It is worse in one of two ways:
//   "every task a little" (each task's chance drops 0.05) or "a few tasks broken" (about 1 task in 10 drops to never
//   solved, chosen at random), which a small sample can miss entirely.
// Each task has its own chance of being solved. "mixed" tasks are often in between; "steady" tasks are almost always
// or almost never solved, as round 1's repeated runs were (most repeats tied). Each run is solved or not (one part),
// or meets a share of five parts.
//
//   node runner/gate-null.mjs [--sims 4000] [--seed 20261015] [--json]
//
// Free: no model, no sandbox. gate-null.test.mjs runs a smaller copy and asserts every false-accept rate stays under
// the gate's alpha.
import { parseArgs } from "node:util";
import { rng, SEED } from "./analyze.mjs";
import { gate, RULES } from "./gate-analyze.mjs";

const CHAMP = "relay@0.6.121";
const CAND = "relay@0.6.122";

/** A draw from Beta(a, a) for a < 1 (U-shaped), by Jöhnk's method. */
function betaU(next, a) {
	for (;;) {
		const x = next() ** (1 / a);
		const y = next() ** (1 / a);
		if (x + y <= 1 && x + y > 0) return x / (x + y);
	}
}

/** How spread out the tasks' chances are: the Beta(a, a) shape. */
export const SPREADS = Object.freeze({ mixed: 0.5, steady: 0.1 });

const ONE = Object.freeze({ spending: "fixed", looks: 1, plannedTasks: null });
/** The planned scenarios: the designs the gate will use, at the sizes it will see. */
export const SCENARIOS = Object.freeze([
	{ name: "one look, 20 tasks, 1 run, mixed", tasks: 20, reps: 1, spread: "mixed", design: ONE },
	{ name: "one look, 40 tasks, 1 run, steady", tasks: 40, reps: 1, spread: "steady", design: ONE },
	{ name: "one look, 60 tasks, 1 run, steady", tasks: 60, reps: 1, spread: "steady", design: ONE },
	{ name: "one look, 100 tasks, 2 runs, mixed", tasks: 100, reps: 2, spread: "mixed", design: ONE },
	{ name: "one look, 40 tasks, 5 parts, mixed", tasks: 40, reps: 1, parts: 5, spread: "mixed", design: ONE },
	{ name: "one look, 400 tasks, 1 run, steady", tasks: 400, reps: 1, spread: "steady", design: ONE },
	{ name: "O'Brien-Fleming, 3 looks to 60, mixed", tasks: 60, reps: 1, spread: "mixed", design: { spending: "obrien-fleming", looks: 3, plannedTasks: 60 } },
	{ name: "O'Brien-Fleming, 3 looks to 120, steady", tasks: 120, reps: 1, spread: "steady", design: { spending: "obrien-fleming", looks: 3, plannedTasks: 120 } },
	{ name: "O'Brien-Fleming, 4 looks to 100, mixed", tasks: 100, reps: 1, spread: "mixed", design: { spending: "obrien-fleming", looks: 4, plannedTasks: 100 } },
	{ name: "Pocock, 3 looks to 60, mixed", tasks: 60, reps: 1, spread: "mixed", design: { spending: "pocock", looks: 3, plannedTasks: 60 } },
]);

/**
 * One simulated gate's records: every task for both arms, `reps` runs each. `worse` is null (same version), "shift"
 * (every task's chance drops by 5 points) or "broken" (a random 1 task in 10 or so drops to 0, for 5 points in all).
 */
export function simulateRecords(next, { tasks, reps, parts = 1, spread = "mixed", worse = null, margin = RULES.marginPoints }) {
	const records = [];
	const a = SPREADS[spread];
	// Chances lie between 0.05 and 1, so a 0.05 drop never needs clipping: the true difference is exactly 5 points.
	const meanChance = 0.05 + 0.95 * 0.5;
	const brokenShare = margin / 100 / meanChance;
	for (let t = 0; t < tasks; t++) {
		const p = 0.05 + 0.95 * betaU(next, a);
		let q = p;
		if (worse === "shift") q = p - margin / 100;
		if (worse === "broken" && next() < brokenShare) q = 0;
		for (const [tool, chance] of [
			[CHAMP, p],
			[CAND, q],
		]) {
			for (let rep = 1; rep <= reps; rep++) {
				let met = 0;
				for (let k = 0; k < parts; k++) if (next() < chance) met++;
				records.push({ tool, task: `t${String(t).padStart(3, "0")}`, taskKind: "everyday", rep, score: { share: met / parts }, usage: { costUsd: 0.1 }, wallMs: 60_000 });
			}
		}
	}
	return records;
}

/**
 * Runs one simulated gate look by look, as gate.mjs would, and returns its first final verdict. `peeks` above 1 reads a
 * one-look design that many times as tasks come in, stopping at the first PASS or BLOCK: what the gate would do with no
 * spending at all, for comparison.
 */
export function runDesign(records, design, rules = RULES, peeks = 1) {
	const fixed = design.spending === "fixed";
	const looks = fixed ? peeks : design.looks;
	const tasks = [...new Set(records.map((r) => r.task))].sort();
	const history = [];
	let verdict;
	for (let k = 1; k <= looks; k++) {
		const n = fixed ? Math.ceil((k * tasks.length) / looks) : Math.ceil((k * design.plannedTasks) / looks);
		const seen = new Set(tasks.slice(0, n));
		verdict = gate(
			records.filter((r) => seen.has(r.task)),
			{ champion: CHAMP, candidate: CAND, design, history: fixed ? [] : history, rules },
		);
		if (fixed ? verdict.status !== "UNRESOLVED" : verdict.final) return verdict;
		if (!fixed && verdict.look) history.push(verdict.look.fraction);
	}
	return verdict;
}

const rate = (k, sims) => ({ rate: k / sims, count: k, sims, se: Math.sqrt(((k / sims) * (1 - k / sims)) / sims) });

/** The error rates of one scenario over `sims` simulated gates of each kind. */
export function falseAcceptRates(scenario, { sims = 4000, seed = SEED, rules = RULES, peeks = 1 } = {}) {
	const next = rng(seed);
	const n = { better: 0, noWorse: 0, block: 0, shift: 0, broken: 0 };
	for (let i = 0; i < sims; i++) {
		const same = runDesign(simulateRecords(next, { ...scenario, margin: rules.marginPoints }), scenario.design, rules, peeks);
		if (same.status === "PASS" && same.label === "better") n.better++;
		if (same.status === "PASS" && same.label === "no worse") n.noWorse++;
		if (same.status === "BLOCK") n.block++;
		for (const worse of ["shift", "broken"]) {
			const v = runDesign(simulateRecords(next, { ...scenario, worse, margin: rules.marginPoints }), scenario.design, rules, peeks);
			if (v.status === "PASS") n[worse]++;
		}
	}
	return {
		scenario: scenario.name,
		alpha: rules.alpha,
		sameVersion: { falseBetter: rate(n.better, sims), falseBlock: rate(n.block, sims), passNoWorse: rate(n.noWorse, sims) },
		fivePointsWorse: { everyTaskALittle: rate(n.shift, sims), aFewTasksBroken: rate(n.broken, sims) },
	};
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values } = parseArgs({ options: { sims: { type: "string", default: "4000" }, seed: { type: "string", default: String(SEED) }, json: { type: "boolean", default: false } } });
	const results = SCENARIOS.map((s, i) => falseAcceptRates(s, { sims: Number(values.sims), seed: Number(values.seed) + i }));
	if (values.json) console.log(JSON.stringify(results, null, 2));
	else {
		const pct = (r) => `${(100 * r.rate).toFixed(2)}% ±${(196 * r.se).toFixed(2)}`.padEnd(14);
		console.log(`over ${values.sims} simulated gates each; alpha is ${(100 * RULES.alpha).toFixed(1)}%. ±: 95% Monte Carlo error.`);
		console.log(`${"".padEnd(42)} same version:                              5 points worse, any PASS:`);
		console.log(`${"".padEnd(42)} PASS better    BLOCK          PASS no worse  every task     a few broken`);
		for (const r of results) {
			const s = r.sameVersion;
			const w = r.fivePointsWorse;
			console.log(`${r.scenario.padEnd(42)} ${pct(s.falseBetter)} ${pct(s.falseBlock)} ${pct(s.passNoWorse)} ${pct(w.everyTaskALittle)} ${pct(w.aFewTasksBroken)}`);
		}
	}
}
