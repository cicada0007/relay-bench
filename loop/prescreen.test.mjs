// loop/prescreen.mjs with a fake run-stage and the real check-tier door: every selection query is counted, and a
// pre-screen that would pass the leak budget, the cycle's query limit, its lane's budget or the spend cap runs nothing.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exposurePathFor, readExposures } from "../runner/exposure.mjs";
import { readTasks } from "../runner/stage-tasks.mjs";
import { nodeScript } from "./cycle.mjs";
import { examWithCheck, fakeExec, practiceTasks } from "./fakes.mjs";
import { prescreen, prescreenPlan, stageSpent, wallet } from "./prescreen.mjs";

const SETTINGS = JSON.parse(readFileSync(new URL("./settings.json", import.meta.url), "utf8"));
const tierIds = (dir, tier) => [...readTasks(dir)].filter(([, t]) => t.tier === tier).map(([id]) => id);
const realDoor = { tierIds, "scripts/check-query.mjs": (args) => nodeScript("scripts/check-query.mjs", args) };

function setup({ settings = SETTINGS, cap = 20, proposals = [{ id: "2026-W43-config-x", lane: "config" }, { id: "2026-W43-routing-y", lane: "routing" }], built = true, exam = examWithCheck() } = {}) {
	const p = practiceTasks({ everyday: 6, long: 0 });
	const cycleDir = mkdtempSync(join(tmpdir(), "loop-cycle-"));
	const packages = join(cycleDir, "packages");
	mkdirSync(packages, { recursive: true });
	if (built) for (const x of proposals) writeFileSync(join(packages, `${x.id}.tgz`), "a made-up build");
	return { p, cycleDir, packages, exam, proposals, settings, money: wallet({ settings, cap }) };
}
const run = (s, exec, extra = {}) =>
	prescreen({ proposals: s.proposals, cycleDir: s.cycleDir, settings: s.settings, money: s.money, champion: "0.6.121", model: "claude-haiku-5-5", practiceTasksDir: s.p.tasks, devTasks: s.p.ids, exam: s.exam?.root ?? null, packages: s.packages, exec, ...extra });
const stages = (calls) => calls.filter((c) => c[0] === "runner/run-stage.mjs");
const arg = (call, name) => call[call.indexOf(name) + 1];

test("a pre-screen runs the dev set, then asks the check tier once; each query is counted, and the cycle's limit holds", async () => {
	const settings = { ...SETTINGS, prescreen: { ...SETTINGS.prescreen, maxSelectionQueries: 1 } };
	const s = setup({ settings });
	const calls = [];
	const r = await run(s, fakeExec({ calls, candidate: () => 1, champion: () => 0.5, real: realDoor }));
	const [first, second] = r.results;
	assert.equal(first.status, "passed", JSON.stringify(first));
	assert.equal(first.dev.tasks, 6);
	assert.equal(first.dev.difference, 50);
	assert.equal(first.selection.status, "pass");
	assert.equal(first.selection.query, 1);
	assert.equal(second.status, "held");
	assert.match(second.selection.why, /asked the check tier 1 times, its limit/);
	assert.equal(r.queries, 1);
	// The dev stage ran on practice with the build as relay@pkg, in a dev test, within the lane and the cap.
	const dev = stages(calls)[0];
	assert.equal(arg(dev, "--tools"), "relay@0.6.121,relay@pkg");
	assert.match(arg(dev, "--test"), /^dev-loop-/);
	assert.equal(Number(arg(dev, "--stage-cap-usd")), Math.min(6, 20, 6 * 2 * 0.25));
	// One selection stage (on the check tier, written beside the exam) and one answer from the door.
	assert.equal(stages(calls).length, 3);
	assert.equal(arg(stages(calls)[1], "--tasks"), "tier:check");
	assert.ok(arg(stages(calls)[1], "--out").startsWith(s.exam.root));
	assert.equal(calls.filter((c) => c[0] === "scripts/check-query.mjs").length, 1);
	const reads = readExposures(exposurePathFor(s.exam.tasks)).filter((e) => e.kind === "read");
	assert.equal(reads.length, 1);
	assert.equal(reads[0].tasks.length, 25);
	// What it spent: the dev set's records, and what the selection stage printed.
	assert.ok(Math.abs(first.spentUsd - (12 * 0.05 + 50 * 0.05)) < 1e-9);
	assert.equal(r.spend.length, 2 + 1);
});

test("a selection that would pass the leak budget runs nothing on the check tier", async () => {
	for (const budget of [{ check: { readsPerTask: 0 } }, { check: { runsPerTask: 1 } }]) {
		const exam = examWithCheck();
		writeFileSync(join(exam.root, "leak-budget.json"), JSON.stringify(budget));
		const s = setup({ exam, proposals: [{ id: "2026-W43-config-x", lane: "config" }] });
		const calls = [];
		const r = await run(s, fakeExec({ calls, real: realDoor }));
		assert.equal(r.results[0].status, "held");
		assert.match(r.results[0].selection.why, /leak budget would be passed/);
		assert.equal(stages(calls).length, 1, "the dev set only");
		assert.equal(calls.filter((c) => c[0] === "scripts/check-query.mjs").length, 0);
		assert.equal(existsSync(exposurePathFor(exam.tasks)), false);
		assert.equal(r.queries, 0);
	}
});

test("nothing runs past a lane's budget or the spend cap, or without a build", async () => {
	const tight = { ...SETTINGS, lanes: { ...SETTINGS.lanes, config: { ...SETTINGS.lanes.config, budgetUsd: 0.2 } } };
	let calls = [];
	let r = await run(setup({ settings: tight, proposals: [{ id: "2026-W43-config-x", lane: "config" }] }), fakeExec({ calls }));
	assert.equal(r.results[0].status, "refused");
	assert.match(r.results[0].why[0], /config lane has \$0.20 of its \$0.20 left this cycle, less than one run's cap/);
	assert.equal(calls.length, 0);

	calls = [];
	r = await run(setup({ cap: 0.1, proposals: [{ id: "2026-W43-config-x", lane: "config" }] }), fakeExec({ calls }));
	assert.match(r.results[0].why[0], /--spend-cap of \$0.10/);
	assert.equal(calls.length, 0);

	calls = [];
	r = await run(setup({ cap: null, proposals: [{ id: "2026-W43-config-x", lane: "config" }] }), fakeExec({ calls }));
	assert.match(r.results[0].why[0], /no --spend-cap/);
	assert.equal(calls.length, 0);

	calls = [];
	r = await run(setup({ built: false, proposals: [{ id: "2026-W43-config-x", lane: "config" }] }), fakeExec({ calls }));
	assert.equal(r.results[0].status, "waiting");
	assert.match(r.results[0].why[0], /waiting for a build/);
	assert.equal(calls.length, 0);

	// Money a lane spent earlier in the cycle counts against it.
	const s = setup({ proposals: [{ id: "2026-W43-config-x", lane: "config" }] });
	s.money = wallet({ settings: SETTINGS, cap: 20, entries: [{ lane: "config", usd: 5.9 }] });
	calls = [];
	r = await run(s, fakeExec({ calls }));
	assert.equal(r.results[0].status, "refused");
});

test("a build the dev set reads as below the champion is dropped before the check tier is asked", async () => {
	const s = setup({ proposals: [{ id: "2026-W43-config-x", lane: "config" }] });
	const calls = [];
	const r = await run(s, fakeExec({ calls, candidate: () => 0, champion: () => 1, real: realDoor }));
	assert.equal(r.results[0].status, "dropped");
	assert.match(r.results[0].why.join("; "), /whole interval on the dev set is below zero/);
	assert.equal(stages(calls).length, 1);
	assert.equal(r.queries, 0);
	// A pre-screen run again keeps what it decided.
	const again = await run(s, fakeExec({ calls: [] }), { done: { [r.results[0].id]: r.results[0] } });
	assert.equal(again.results[0].status, "dropped");
});

test("without a check tier the dev set decides, and the plan says what one pre-screen can cost", async () => {
	const s = setup({ exam: null, proposals: [{ id: "2026-W43-config-x", lane: "config" }] });
	const r = await run(s, fakeExec({}));
	assert.equal(r.results[0].status, "passed");
	assert.equal(r.results[0].selection.status, "not available");
	assert.deepEqual(prescreenPlan({ devTasks: ["a", "b"], checkTasks: ["c"], settings: SETTINGS }), { devRuns: 4, selectionRuns: 2, worstUsd: 6 * 0.25 });
	assert.equal(stageSpent("x\n[10:00:00] ok  | stage $1.25\nstopped: the next run could take the stage past its 2 cap\n"), 1.25);
	assert.equal(stageSpent("stage t finished: $3.50 spent\n"), 3.5);
	assert.equal(stageSpent("nothing"), null);
});
