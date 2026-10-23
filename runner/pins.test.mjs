// Graders pinned per release (runner/pins.mjs).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { currentTasks, lockPathFor } from "../scripts/lock-tasks.mjs";
import { gradedBy, makePin, pinFingerprint, pinPathFor, pinProblems, writePin } from "./pins.mjs";

function exam() {
	const tasks = join(mkdtempSync(join(tmpdir(), "pins-")), "tasks");
	for (const id of ["a", "b"]) {
		mkdirSync(join(tasks, id, "repo"), { recursive: true });
		mkdirSync(join(tasks, id, "judge"), { recursive: true });
		writeFileSync(join(tasks, id, "task.json"), JSON.stringify({ id, kind: "everyday", tier: "exam", draftedBy: "openai/x", approvedBy: "arnav", approvedAt: "2026-10-23" }));
		writeFileSync(join(tasks, id, "request.md"), "Do it.\n");
		writeFileSync(join(tasks, id, "judge", "judge.mjs"), `// ${id}\n`);
	}
	return tasks;
}

test("a pin is made from the lock, once, and names its judges by fingerprint", () => {
	const tasks = exam();
	assert.throws(() => makePin({ tasksDir: tasks, release: "0.6.122" }), /lock the exam/);
	writeFileSync(lockPathFor(tasks), JSON.stringify({ tasks: currentTasks(tasks) }));
	const pin = makePin({ tasksDir: tasks, release: "0.6.122" });
	assert.deepEqual(Object.keys(pin.tasks), ["a", "b"]);
	writePin(pinPathFor(tasks, "0.6.122"), pin);
	assert.throws(() => writePin(pinPathFor(tasks, "0.6.122"), pin), /pinned once/);
	assert.match(pinFingerprint(pin), /^[0-9a-f]{64}$/);
	writeFileSync(join(tasks, "a", "judge", "judge.mjs"), "// fixed\n");
	assert.throws(() => makePin({ tasksDir: tasks, release: "0.6.123" }), /judges differ from the lock for a/);
	assert.throws(() => pinPathFor(tasks, "../x"), /not a release id/);
});

test("runs graded by another judge, or by an unrecorded re-grade, do not match the pin", () => {
	const pin = { release: "0.6.122", tasks: { a: "h-a", b: "h-b" } };
	const run = (task, extra) => ({ task, score: { share: 1 }, taskHashes: { judge: `h-${task}` }, ...extra });
	assert.deepEqual(pinProblems([run("a"), run("b"), { task: "a" }], pin), []);
	assert.equal(gradedBy(run("a", { rejudgedAt: "x", judgeTreeHash: "h2" })), "h2");
	assert.deepEqual(pinProblems([run("a", { rejudgedAt: "x", judgeTreeHash: "h2" })], pin), ["a: graded by a judge other than the one pinned for 0.6.122"]);
	assert.deepEqual(pinProblems([run("a", { rejudgedAt: "x" })], pin), ["a: a run carries no judge fingerprint"]);
	assert.deepEqual(pinProblems([run("c")], pin), ["c: not pinned for 0.6.122"]);
});
