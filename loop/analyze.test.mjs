// loop/analyze.mjs on made-up runs: failures are clustered by symptom and kind, only when they repeat across tasks;
// the queue report Relay wrote adds its own symptoms; and a run of an exam or check task is never read.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readTasks } from "../runner/stage-tasks.mjs";
import { analyze, queueReport, readRecords, studyable, symptomsOf } from "./analyze.mjs";
import { practiceTasks, record, writeRecords } from "./fakes.mjs";

test("failures that repeat across tasks become clusters; one task's repeats and solved runs do not", () => {
	const p = practiceTasks({ everyday: 4, long: 4 });
	const tasks = readTasks(p.tasks);
	const rs = [
		// Said done but unmet, on three long tasks: a cluster.
		...["py-l0", "py-l1", "py-l2"].map((task) => record({ task, kind: "long", share: 0.5, saidDoneButFailed: true, notes: { R1: `${task} printed the wrong total` } })),
		// Broke what worked, three times on one task: below the tasks threshold.
		...[1, 2, 3].map((rep) => record({ task: "py-e0", rep, share: 0, R0: false })),
		// Solved runs are not failures, and a lost run (no grade) is counted apart.
		record({ task: "py-e1", share: 1 }),
		{ ...record({ task: "py-e2" }), score: undefined },
		// Another tool solved two of the clustered tasks.
		record({ task: "py-l0", kind: "long", tool: "claude-code", share: 1 }),
		record({ task: "py-l1", kind: "long", tool: "claude-code", share: 1 }),
		// A public task: Terminal-Bench records have their own shape.
		...["fix-git", "regex-log", "cobol"].map((t) => ({ test: "F", task: `terminal-bench/${t}`, tool: "relay", solved: false, exception: null, infra: false, runId: `F-${t}` })),
		{ test: "F", task: "terminal-bench/lost", tool: "relay", solved: false, infra: true, runId: "F-lost" },
	];
	const a = analyze({ records: rs, tasks, queues: new Map(), clusters: { minRuns: 3, minTasks: 2 } });
	assert.equal(a.runs, 3 + 3 + 2 + 4);
	assert.equal(a.lost, 2);
	assert.equal(a.failing, 3 + 3 + 3);
	const ids = a.clusters.map((c) => c.id);
	assert.deepEqual(ids.sort(), ["c-false-done-long", "c-unsolved-public"]);
	const fd = a.clusters.find((c) => c.id === "c-false-done-long");
	assert.equal(fd.runs, 3);
	assert.deepEqual(fd.tasks, ["py-l0", "py-l1", "py-l2"]);
	assert.equal(fd.solvedByAnotherTool, 2);
	assert.deepEqual(fd.lanes, ["config", "prompts"]);
	assert.deepEqual(fd.stacks, ["python3"]);
	assert.equal(fd.notes.length, 3);
	assert.ok(a.below.some((b) => b.id === "c-regression-everyday" && b.runs === 3 && b.tasks === 1));
	// The thresholds are the settings': with one task allowed, the regressions are a cluster too.
	assert.ok(analyze({ records: rs, tasks, queues: new Map(), clusters: { minRuns: 3, minTasks: 1 } }).clusters.some((c) => c.id === "c-regression-everyday"));
});

test("the queue report adds symptoms, and one-task runs measure each route and the learning arms", () => {
	const q = (over) => [{ id: "t0001", status: "verified", attempts: 1, maxAttempts: 2, history: [{ outcome: "verified" }], route: { row: "small-low-risk", tier: "fast" }, ...over }];
	assert.deepEqual(symptomsOf(record({ task: "a", share: 0 }), q({ status: "parked", attempts: 2, history: [{ outcome: "gate_failed" }, { outcome: "gate_failed" }] })).sort(), ["parked-after-retries", "unmet"]);
	assert.ok(symptomsOf(record({ task: "a" }), q({ history: [{ outcome: "stuck", budget: "turns" }] })).includes("budget-turns"));
	assert.ok(symptomsOf(record({ task: "a" }), q({ history: [{ outcome: "stuck" }] })).includes("stuck"));
	assert.ok(symptomsOf({ ...record({ task: "a" }), safetyFlags: [{ flag: "secret-leaked" }] }).includes("safety-flag"));

	const rs = [];
	const queues = new Map();
	for (let i = 0; i < 6; i++) {
		const fast = record({ task: `f${i}`, share: i < 2 ? 1 : 0 });
		queues.set(fast.runId, q({ learningArm: i % 2 ? "on" : "off" }));
		const strong = record({ task: `s${i}`, share: 1 });
		queues.set(strong.runId, q({ route: { row: "large-or-cross-file", tier: "strong" } }));
		rs.push(fast, strong);
	}
	const a = analyze({ records: rs, queues, clusters: { minRuns: 3, minTasks: 2 } });
	assert.equal(a.routes["small-low-risk@fast"].tasks, 6);
	assert.ok(Math.abs(a.routes["small-low-risk@fast"].meanShare - 2 / 6) < 1e-9);
	assert.equal(a.routes["large-or-cross-file@strong"].meanShare, 1);
	assert.equal(a.learning.on.tasks, 3);
	assert.equal(a.learning.off.tasks, 3);
});

test("the queue report is read from the run's relay-state.tgz, as runner/run-one.mjs keeps it", () => {
	const root = mkdtempSync(join(tmpdir(), "loop-queue-"));
	const r = record({ task: "py-e0", share: 0 });
	const state = join(root, "state");
	mkdirSync(join(state, "supervisor", "local", "work-1"), { recursive: true });
	writeFileSync(join(state, "supervisor", "local", "work-1", "queue.json"), JSON.stringify({ version: 2, tasks: [{ id: "t0001", status: "parked", attempts: 1, maxAttempts: 2, history: [{ outcome: "stuck" }] }] }));
	const runs = join(root, "runs");
	mkdirSync(join(runs, r.runId), { recursive: true });
	execFileSync("tar", ["-czf", join(runs, r.runId, "relay-state.tgz"), "-C", state, "supervisor"]);
	const path = writeRecords(runs, [r]);
	const [read] = readRecords([path]);
	assert.equal(queueReport(read)[0].history[0].outcome, "stuck");
	assert.ok(symptomsOf(read, queueReport(read)).includes("stuck"));
});

test("a run of an exam or check task is never read, and neither is a records file inside the exam", () => {
	const p = practiceTasks({ everyday: 1, long: 0 });
	mkdirSync(join(p.tasks, "sealed1"), { recursive: true });
	writeFileSync(join(p.tasks, "sealed1", "task.json"), JSON.stringify({ id: "sealed1", kind: "everyday", tier: "check" }));
	const tasks = readTasks(p.tasks);
	assert.throws(() => studyable([record({ task: "py-e0" }), record({ task: "sealed1" })], tasks), /exam or check tasks \(sealed1\); the loop never reads them/);
	const { kept, unknown } = studyable([record({ task: "py-e0" }), record({ task: "mystery" })], tasks);
	assert.equal(kept.length, 1);
	assert.deepEqual(unknown, ["mystery"]);

	const exam = mkdtempSync(join(tmpdir(), "loop-exam-records-"));
	const path = writeRecords(join(exam, "runs", "gate"), [record({ task: "py-e0" })]);
	assert.throws(() => readRecords([path], { exam }), /inside the exam/);
});
