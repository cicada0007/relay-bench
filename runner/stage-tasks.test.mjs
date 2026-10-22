import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { insideRepo, ROOT, sampleIds, sealedProblems, selectTasks } from "./stage-tasks.mjs";

function folder(tasks, parent = tmpdir()) {
	const dir = mkdtempSync(join(parent, "stage-tasks-"));
	for (const [id, task] of Object.entries(tasks)) {
		mkdirSync(join(dir, id));
		writeFileSync(join(dir, id, "task.json"), JSON.stringify({ id, ...task }));
	}
	return dir;
}

test("tasks are chosen by id, kind and tier, in the order given, once each", () => {
	const dir = folder({ a: { kind: "long" }, b: { kind: "everyday", tier: "exam" }, c: { kind: "everyday", tier: "check" }, d: { kind: "everyday" } });
	try {
		assert.deepEqual(selectTasks("kind:long", dir), ["a"]);
		assert.deepEqual(selectTasks("tier:exam", dir), ["b"]);
		assert.deepEqual(selectTasks("tier:practice", dir), ["a", "d"]);
		assert.deepEqual(selectTasks("d,kind:everyday", dir), ["d", "b", "c"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("exam and check tasks run only from, and into, folders outside this public repository", () => {
	const outside = folder({ b: { kind: "everyday", tier: "exam" }, p: { kind: "everyday" } });
	const inside = folder({ b: { kind: "everyday", tier: "exam" } }, ROOT);
	try {
		assert.deepEqual(sealedProblems({ ids: ["b"], tasksDir: outside, out: join(outside, "..", "runs") }), []);
		assert.match(sealedProblems({ ids: ["b"], tasksDir: outside, out: join(ROOT, "runs", "bar") })[0], /must be written outside/);
		assert.match(sealedProblems({ ids: ["b"], tasksDir: inside, out: join(tmpdir(), "runs") })[0], /inside this public repository/);
		// Practice tasks may run anywhere.
		assert.deepEqual(sealedProblems({ ids: ["p"], tasksDir: outside, out: join(ROOT, "runs") }), []);
		assert.ok(insideRepo(join(ROOT, "runs")));
		assert.ok(!insideRepo(join(ROOT, "..", "relay-exam", "runs")));
	} finally {
		rmSync(outside, { recursive: true, force: true });
		rmSync(inside, { recursive: true, force: true });
	}
});

test("a sample is a fixed draw: the same ids and seed give the same tasks, whatever order they came in", () => {
	const ids = Array.from({ length: 400 }, (_, i) => `t-${String(i).padStart(3, "0")}`);
	const a = sampleIds(ids, 100);
	assert.equal(a.length, 100);
	assert.equal(new Set(a).size, 100);
	assert.deepEqual(a, [...a].sort());
	assert.deepEqual(sampleIds([...ids].reverse(), 100), a);
	assert.notDeepEqual(sampleIds(ids, 100, 7), a);
	assert.deepEqual(sampleIds(ids.slice(0, 3), 100), ids.slice(0, 3));
});
