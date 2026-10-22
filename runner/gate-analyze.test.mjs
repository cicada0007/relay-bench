import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT, gate } from "./gate-analyze.mjs";

const CHAMP = "relay@0.6.121";
const CAND = "relay@0.6.122";

/** One graded run. `share` is requirements met (0 to 1). */
function run(tool, task, share, { kind = "everyday", cost = 0.1, wallMs = 60_000, falseDone = false } = {}) {
	return { tool, task, taskKind: kind, score: { share }, usage: { costUsd: cost }, wallMs, saidDoneButFailed: falseDone };
}

/** `n` tasks where the champion scores `champ` and the candidate `champ + delta(i)`, one run each. */
function pairs(n, champ, delta, options = {}) {
	const records = [];
	for (let i = 0; i < n; i++) {
		const task = `t${i}`;
		records.push(run(CHAMP, task, champ, options.champ));
		records.push(run(CAND, task, Math.max(0, Math.min(1, champ + delta(i))), options.cand));
	}
	return records;
}

const verdict = (records) => gate(records, { champion: CHAMP, candidate: CAND });

test("too few shared tasks is unresolved", () => {
	const v = verdict(pairs(10, 0.5, () => 0.2));
	assert.equal(v.status, "UNRESOLVED");
	assert.equal(v.exitCode, EXIT.UNRESOLVED);
	assert.equal(v.tasks, 10);
});

test("a clearly better candidate passes as better", () => {
	const v = verdict(pairs(30, 0.5, (i) => 0.2 + (i % 3) * 0.05));
	assert.equal(v.status, "PASS");
	assert.equal(v.label, "better");
	assert.ok(v.low > 0);
});

test("a clearly worse candidate is blocked", () => {
	const v = verdict(pairs(30, 0.6, (i) => -0.2 - (i % 3) * 0.05));
	assert.equal(v.status, "BLOCK");
	assert.equal(v.label, "worse");
	assert.equal(v.exitCode, EXIT.BLOCK);
});

test("the same score passes as no worse when the interval is tight", () => {
	const v = verdict(pairs(40, 0.5, (i) => (i % 2 ? 0.02 : -0.02)));
	assert.equal(v.status, "PASS");
	assert.equal(v.label, "no worse");
});

test("a noisy, slightly lower candidate is unresolved", () => {
	const v = verdict(pairs(20, 0.5, (i) => (i % 2 ? 0.3 : -0.4)));
	assert.equal(v.status, "UNRESOLVED");
	assert.equal(v.label, "not enough evidence");
});

test("costing more than 5% more blocks a better candidate", () => {
	const v = verdict(pairs(30, 0.5, () => 0.2, { champ: { cost: 1 }, cand: { cost: 1.2 } }));
	assert.equal(v.status, "BLOCK");
	assert.equal(v.label, "costs more");
	assert.ok(Math.abs(v.costRatio - 1.2) < 1e-9);
});

test("taking more than 10% longer blocks", () => {
	const v = verdict(pairs(30, 0.5, () => 0.2, { champ: { wallMs: 100 }, cand: { wallMs: 120 } }));
	assert.equal(v.label, "slower");
});

test("more false done blocks", () => {
	const v = verdict(pairs(30, 0.5, () => 0.2, { cand: { falseDone: true } }));
	assert.equal(v.label, 'more false "done"');
});

test("a kind of task that got much worse blocks, even when the total looks fine", () => {
	const records = [
		...pairs(30, 0.4, () => 0.25, { champ: { kind: "everyday" }, cand: { kind: "everyday" } }),
		...pairs(10, 0.9, () => -0.4, { champ: { kind: "long" }, cand: { kind: "long" } }).map((r) => ({ ...r, task: `long-${r.task}` })),
	];
	const v = verdict(records);
	assert.equal(v.status, "BLOCK");
	assert.equal(v.label, "worse on long tasks");
	assert.equal(v.kinds.long.tasks, 10);
});

test("runs our infrastructure lost are left out", () => {
	const records = pairs(25, 0.5, () => 0.2);
	records.push({ tool: CAND, task: "t0", taskKind: "everyday" });
	const v = verdict(records);
	assert.equal(v.runs.candidate, 25);
});

test("the result says the smallest change it could see", () => {
	const v = verdict(pairs(30, 0.5, (i) => (i % 2 ? 0.1 : -0.1)));
	assert.ok(v.detectablePoints > 0);
});
