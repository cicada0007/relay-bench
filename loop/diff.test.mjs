// loop/diff.mjs: its diffs are git's format (git apply takes them and rebuilds the new text), and its JSON paths,
// hunk ranges and globs say exactly what a change touches.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { changedPaths, globToRegExp, hunkRanges, serializeLike, setPath, unifiedDiff } from "./diff.mjs";
import { fakeArch, fakeArchText } from "./fakes.mjs";

function gitApply(file, before, patch) {
	const dir = mkdtempSync(join(tmpdir(), "loop-diff-"));
	mkdirSync(join(dir, dirname(file)), { recursive: true });
	writeFileSync(join(dir, file), before);
	writeFileSync(join(dir, "p.patch"), patch);
	const r = spawnSync("git", ["apply", "p.patch"], { cwd: dir, encoding: "utf8" });
	return { status: r.status, stderr: r.stderr, text: r.status === 0 ? readFileSync(join(dir, file), "utf8") : null };
}

test("a unified diff applies with git and gives the new text, edits near and far apart, at the ends too", () => {
	const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
	const before = `${lines.join("\n")}\n`;
	const edited = [...lines];
	edited[0] = "first, changed";
	edited.splice(10, 1, "ten a", "ten b");
	edited.splice(13, 2);
	edited[40] = "forty, changed";
	edited.push("added at the end");
	const after = `${edited.join("\n")}\n`;
	const patch = unifiedDiff(before, after, { path: "src/a.txt" });
	assert.match(patch, /^diff --git a\/src\/a.txt b\/src\/a.txt\n--- a\/src\/a.txt\n\+\+\+ b\/src\/a.txt\n@@ -1,/);
	const applied = gitApply("src/a.txt", before, patch);
	assert.equal(applied.status, 0, applied.stderr);
	assert.equal(applied.text, after);
	assert.equal(unifiedDiff(before, before, { path: "x" }), "");
	// A line taken out before the line put in, as git writes it.
	assert.match(unifiedDiff("a\nb\nc\n", "a\nB\nc\n", { path: "x" }), /-b\n\+B\n/);
});

test("relay.arch is written back in its own format, so a one-value change is a one-line diff", () => {
	const text = fakeArchText();
	assert.equal(serializeLike(JSON.parse(text), text), text);
	const after = setPath(fakeArch(), "queue.requestCheck.maxChecks", 3);
	const patch = unifiedDiff(text, serializeLike(after, text), { path: "relay.arch.json" });
	assert.equal(patch.split("\n").filter((l) => /^[-+][^-+]/.test(l)).length, 2);
	assert.equal(gitApply("relay.arch.json", text, patch).text, serializeLike(after, text));
});

test("changed paths name each leaf that moved; arrays are one value", () => {
	const a = fakeArch();
	let b = setPath(a, "queue.stuck.idleTurns", 4);
	b = setPath(b, "routing.suitability", [...a.routing.suitability].reverse());
	assert.deepEqual(changedPaths(a, b), ["queue.stuck.idleTurns", "routing.suitability"]);
	assert.deepEqual(changedPaths(a, structuredClone(a)), []);
	assert.equal(a.queue.stuck.idleTurns, 3, "setPath leaves the original alone");
});

test("hunk ranges and globs", () => {
	const patch = unifiedDiff("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", "a\nb\nc\nd\nE\nf\ng\nh\ni\nj\n", { path: "x.ts" });
	assert.deepEqual(hunkRanges(patch), { "x.ts": [[2, 8]] });
	assert.ok(globToRegExp("**/judge/**").test("tasks/a/judge/judge.mjs"));
	assert.ok(globToRegExp("**/judge/**").test("judge/x.mjs"));
	assert.ok(globToRegExp("runner/gate*.mjs").test("runner/gate-analyze.mjs"));
	assert.ok(!globToRegExp("runner/gate*.mjs").test("runner/sub/gate.mjs"));
	assert.ok(!globToRegExp("queue/**").test("packages/coding-agent/src/core/queue/task-runner.ts"));
});
