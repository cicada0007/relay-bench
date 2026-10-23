// The null-change test (GATE.md, amendment 1): the gate's own math, run look by look on simulated gates where the
// truth is known, accepts what it should not less often than alpha. runner/gate-null.mjs runs every scenario with more
// gates; this runs the smaller ones, enough to fail if the math drifts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RULES } from "./gate-analyze.mjs";
import { falseAcceptRates, SCENARIOS } from "./gate-null.mjs";

const SIMS = 2000;
const chosen = SCENARIOS.filter((s) => s.tasks <= 100 && !(s.tasks === 100 && s.reps === 2));

for (const [i, scenario] of chosen.entries()) {
	test(`false accepts stay under alpha: ${scenario.name}`, () => {
		const r = falseAcceptRates(scenario, { sims: SIMS, seed: 20261015 + i });
		const under = (rate, what) => assert.ok(rate.rate < RULES.alpha, `${what}: ${(100 * rate.rate).toFixed(2)}% of ${SIMS} is not under ${100 * RULES.alpha}%`);
		under(r.sameVersion.falseBetter, "same version, PASS better");
		under(r.fivePointsWorse.everyTaskALittle, "5 points worse on every task, any PASS");
		under(r.fivePointsWorse.aFewTasksBroken, "5 points worse from a few broken tasks, any PASS");
		// A same version is sometimes passed as no worse, never as better more than alpha allows; blocks stay near alpha.
		assert.ok(r.sameVersion.falseBlock.rate < 2 * RULES.alpha, `same version, BLOCK: ${r.sameVersion.falseBlock.rate}`);
	});
}

test("three looks with O'Brien-Fleming spending err no more than one look; three plain peeks err more", () => {
	const fixed = { spending: "fixed", looks: 1, plannedTasks: null };
	const scenario = (design) => ({ name: "60 tasks", tasks: 60, reps: 1, spread: "mixed", design });
	const once = falseAcceptRates(scenario(fixed), { sims: SIMS, seed: 7 });
	const spent = falseAcceptRates(scenario({ spending: "obrien-fleming", looks: 3, plannedTasks: 60 }), { sims: SIMS, seed: 7 });
	const peeked = falseAcceptRates(scenario(fixed), { sims: SIMS, seed: 7, peeks: 3 });
	assert.ok(spent.fivePointsWorse.everyTaskALittle.rate < RULES.alpha);
	assert.ok(spent.sameVersion.falseBlock.rate < RULES.alpha);
	// Reading a one-look gate at 20, 40 and 60 tasks and stopping at the first verdict: the reason for spending at all.
	assert.ok(peeked.fivePointsWorse.everyTaskALittle.rate > once.fivePointsWorse.everyTaskALittle.rate);
	assert.ok(peeked.sameVersion.falseBlock.rate > 2 * once.sameVersion.falseBlock.rate);
});
