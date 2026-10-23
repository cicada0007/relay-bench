// Anchor sets (runner/anchors.mjs), on throwaway task folders.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { anchorFingerprint, anchorProblems, anchorsPathFor, loadAnchors, makeAnchors, writeAnchors } from "./anchors.mjs";

function tasks(n) {
	const root = mkdtempSync(join(tmpdir(), "anchors-"));
	const dir = join(root, "tasks");
	for (let i = 0; i < n; i++) {
		const t = join(dir, `t-${i}`);
		mkdirSync(join(t, "repo"), { recursive: true });
		mkdirSync(join(t, "judge"), { recursive: true });
		writeFileSync(join(t, "task.json"), JSON.stringify({ id: `t-${i}`, kind: "everyday", tier: "exam" }));
		writeFileSync(join(t, "request.md"), `Task ${i}.\n`);
		writeFileSync(join(t, "repo", "a.py"), "x = 1\n");
		writeFileSync(join(t, "judge", "judge.mjs"), `// judge ${i}\n`);
	}
	return dir;
}
const ids = (n) => Array.from({ length: n }, (_, i) => `t-${i}`);

test("an anchor set is made once, fingerprinted without naming a task, and never replaced", () => {
	const dir = tasks(22);
	const manifest = makeAnchors({ tasksDir: dir, ids: ids(20), version: "anchors-v1", now: new Date("2026-10-23T00:00:00Z") });
	const path = anchorsPathFor(dir, "anchors-v1");
	writeAnchors(path, manifest);
	const loaded = loadAnchors(path);
	assert.equal(loaded.ids.length, 20);
	assert.match(loaded.fingerprint, /^[0-9a-f]{64}$/);
	assert.equal(loaded.fingerprint, anchorFingerprint(manifest));
	assert.ok(!loaded.fingerprint.includes("t-1"));
	assert.throws(() => writeAnchors(path, manifest), /never changes, make anchors-v2/);
	assert.deepEqual(anchorProblems(loaded.manifest, dir), []);
});

test("an anchor task that changes makes the set unusable", () => {
	const dir = tasks(20);
	const manifest = makeAnchors({ tasksDir: dir, ids: ids(20), version: "anchors-v1" });
	writeFileSync(join(dir, "t-3", "judge", "judge.mjs"), "// fixed judge\n");
	assert.deepEqual(anchorProblems(manifest, dir), ["t-3: judge changed since anchors-v1"]);
});

test("an anchor set needs 20 tasks that exist and a version name", () => {
	const dir = tasks(20);
	assert.throws(() => makeAnchors({ tasksDir: dir, ids: ids(19), version: "anchors-v1" }), /at least 20/);
	assert.throws(() => makeAnchors({ tasksDir: dir, ids: [...ids(19), "nope"], version: "anchors-v1" }), /no task nope/);
	assert.throws(() => makeAnchors({ tasksDir: dir, ids: ids(20), version: "v1" }), /anchors-v1/);
});
