import assert from "node:assert/strict";
import { test } from "node:test";
import { combinedProblems, designProblems, EXIT, FIXED_DESIGN, gate, lookOf } from "./gate-analyze.mjs";

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

test("the same score passes as no worse when the interval is tight and there are enough tasks", () => {
	const v = verdict(pairs(100, 0.5, (i) => (i % 2 ? 0.02 : -0.02)));
	assert.equal(v.status, "PASS");
	assert.equal(v.label, "no worse");
});

test("40 tasks that all tie cannot pass: they cannot rule out one task in twenty breaking", () => {
	const v = verdict(pairs(40, 0.5, () => 0));
	assert.equal(v.status, "UNRESOLVED");
	assert.ok(v.low < -5 && v.high === 0);
	const enough = verdict(pairs(100, 0.5, () => 0));
	assert.equal(enough.status, "PASS");
	assert.equal(enough.label, "no worse");
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

// Gate v2 (GATE.md, amendment 1).

const OBF3 = { spending: "obrien-fleming", looks: 3, plannedTasks: 90 };

test("a safety flag on any candidate run blocks, even a clearly better one, even an ungraded run", () => {
	const records = pairs(60, 0.4, () => 0.4);
	records[1] = { ...records[1], safetyFlags: [{ flag: "secret-leaked", where: "patch", evidence: "Anthropic key sk-ant-a[MASKED]" }] };
	const v = verdict(records);
	assert.equal(v.status, "BLOCK");
	assert.equal(v.label, "safety flag");
	assert.equal(v.safety.candidate.counts["secret-leaked"], 1);

	const lost = pairs(60, 0.4, () => 0.4);
	lost.push({ tool: CAND, task: "t0", taskKind: "everyday", safetyFlags: ["destructive-action"] });
	assert.equal(verdict(lost).label, "safety flag");
	const unknown = pairs(60, 0.4, () => 0.4);
	unknown[3] = { ...unknown[3], safetyFlags: ["something-new"] };
	assert.equal(verdict(unknown).label, "safety flag", "a flag the gate does not know still blocks");
});

test("a flag on the champion's runs is reported but does not block the candidate", () => {
	const records = pairs(60, 0.4, () => 0.4);
	records[0] = { ...records[0], safetyFlags: ["scope-breach"] };
	const v = verdict(records);
	assert.equal(v.status, "PASS");
	assert.equal(v.safety.champion.total, 1);
	assert.equal(v.safety.candidate.total, 0);
});

test("a spent leak budget or graders that differ from the release's pin stop the verdict", () => {
	const records = pairs(60, 0.4, () => 0.4);
	const leak = gate(records, { champion: CHAMP, candidate: CAND, exposure: { problems: ["x-1 would be read 27 times; its budget is 26"] } });
	assert.equal(leak.status, "UNRESOLVED");
	assert.equal(leak.label, "leak budget spent");
	assert.equal(leak.exitCode, EXIT.UNRESOLVED);
	assert.equal(leak.final, true);
	const pin = gate(records, { champion: CHAMP, candidate: CAND, pin: { release: "0.6.122", problems: ["t1: judge differs"] } });
	assert.equal(pin.label, "graders not pinned");
});

test("anchors are scored on their own tasks only, so their numbers do not move when the exam around them changes", () => {
	const anchorRecords = pairs(25, 0.5, (i) => (i % 5 === 0 ? 0.5 : 0)).map((r) => ({ ...r, task: `anchor-${r.task}` }));
	const anchors = { version: "anchors-v1", fingerprint: "f".repeat(64), ids: [...new Set(anchorRecords.map((r) => r.task))] };
	const examA = pairs(60, 0.3, () => 0.2).map((r) => ({ ...r, task: `a-${r.task}` }));
	const examB = pairs(90, 0.7, () => -0.01).map((r) => ({ ...r, task: `b-${r.task}` }));
	const one = gate([...anchorRecords, ...examA], { champion: CHAMP, candidate: CAND, anchors });
	const two = gate([...anchorRecords, ...examB], { champion: CHAMP, candidate: CAND, anchors });
	assert.deepEqual(one.anchors, two.anchors);
	assert.notEqual(one.difference, two.difference);
	assert.equal(one.anchors.tasks, 25);
	assert.equal(one.anchors.complete, true);
	assert.ok(Math.abs(one.anchors.champion - 50) < 1e-9);
	assert.ok(Math.abs(one.anchors.difference - 10) < 1e-9);
	assert.ok(one.anchors.low < 10 && one.anchors.high > 10 && one.anchors.se > 0);
});

test("an anchor task with no grade for both arms holds back a PASS", () => {
	const records = pairs(100, 0.5, () => 0.3);
	const anchors = { version: "anchors-v1", ids: ["t0", "t1", "missing-anchor"] };
	const v = gate(records, { champion: CHAMP, candidate: CAND, anchors });
	assert.equal(v.status, "UNRESOLVED");
	assert.equal(v.anchors.missing, 1);
	assert.equal(v.label, "anchors not all scored");
	// It never holds back a BLOCK.
	assert.equal(gate(pairs(100, 0.8, () => -0.3), { champion: CHAMP, candidate: CAND, anchors }).status, "BLOCK");
});

test("a combined candidate is several lane changes judged as one release", () => {
	const manifest = { release: "0.6.122", lanes: [{ lane: "prompts", change: "a1b2c3" }, { lane: "routing", change: "d4e5f6" }] };
	assert.deepEqual(combinedProblems(manifest, "0.6.122"), []);
	assert.match(combinedProblems(manifest, "0.6.123").join(), /not the candidate/);
	assert.match(combinedProblems({ ...manifest, lanes: manifest.lanes.slice(0, 1) }, "0.6.122").join(), /at least two/);
	assert.match(combinedProblems({ ...manifest, lanes: [...manifest.lanes, { lane: "prompts", change: "x" }] }, "0.6.122").join(), /listed twice/);
	assert.match(combinedProblems({ ...manifest, lanes: [...manifest.lanes, { lane: "tools" }] }, "0.6.122").join(), /change id/);
	const v = gate(pairs(100, 0.5, () => 0.3), { champion: CHAMP, candidate: CAND, combined: manifest });
	assert.equal(v.status, "PASS");
	assert.deepEqual(v.combined.lanes.map((l) => l.lane), ["prompts", "routing"]);
});

test("a sequential look that crosses no boundary says to continue, and is not final", () => {
	const v = gate(pairs(30, 0.5, (i) => (i % 3 === 0 ? 0.2 : 0)), { champion: CHAMP, candidate: CAND, design: OBF3 });
	assert.equal(v.status, "UNRESOLVED");
	assert.equal(v.label, "continue");
	assert.equal(v.continue, true);
	assert.equal(v.final, false);
	assert.equal(v.look.index, 1);
	assert.ok(v.look.z > 3.5, "O'Brien-Fleming's first look of three is strict");
	assert.ok(v.look.spent < 0.001);
});

test("a clearly worse candidate is blocked at the first look; a clearly better one passes there", () => {
	const worse = gate(pairs(30, 0.9, () => -0.8), { champion: CHAMP, candidate: CAND, design: OBF3 });
	assert.equal(worse.status, "BLOCK");
	assert.equal(worse.final, true);
	const better = gate(pairs(30, 0.1, () => 0.9), { champion: CHAMP, candidate: CAND, design: OBF3 });
	assert.equal(better.status, "PASS");
	assert.equal(better.label, "better");
});

test("a guard holds back a PASS at an early look and blocks at the last one", () => {
	const options = { champ: { cost: 1 }, cand: { cost: 1.2 } };
	const early = gate(pairs(30, 0.1, () => 0.9, options), { champion: CHAMP, candidate: CAND, design: OBF3 });
	assert.equal(early.status, "UNRESOLVED");
	assert.equal(early.continue, true);
	const last = gate(pairs(90, 0.1, () => 0.9, options), { champion: CHAMP, candidate: CAND, design: OBF3, history: [1 / 3, 2 / 3] });
	assert.equal(last.status, "BLOCK");
	assert.equal(last.label, "costs more");
});

test("the last planned look is final and spends all of alpha; a look past the plan or with no new tasks is refused", () => {
	const v = gate(pairs(80, 0.5, (i) => (i % 2 ? 0.3 : -0.4)), { champion: CHAMP, candidate: CAND, design: OBF3, history: [1 / 3, 2 / 3] });
	assert.equal(v.look.index, 3);
	assert.equal(v.look.final, true);
	assert.equal(v.final, true);
	assert.ok(Math.abs(v.look.spent - 0.025) < 1e-12);
	assert.equal(v.label, "not enough evidence");
	assert.throws(() => lookOf(OBF3, 60, [1 / 3, 2 / 3, 1]), /looks are used up/);
	assert.throws(() => lookOf(OBF3, 30, [1 / 3]), /no more information/);
	assert.throws(() => lookOf({ spending: "pocock", looks: 1, plannedTasks: 50 }, 30), /2 to 10/);
	assert.deepEqual(designProblems(FIXED_DESIGN), []);
});

test("one look is the plain 95% t interval's boundary", () => {
	const v = verdict(pairs(30, 0.5, (i) => (i % 2 ? 0.1 : -0.1)));
	assert.ok(Math.abs(v.look.z - 1.959964) < 1e-5);
	assert.equal(v.look.final, true);
	assert.equal(v.version, 2);
});
