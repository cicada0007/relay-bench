// Saturation (scripts/saturation.mjs): a level passed 90% or more opens the next level's queue, once.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { levelOf, openHarder, openLevel, readHarder, saturation } from "./saturation.mjs";

const TOOL = "relay@0.6.121";
const tasks = new Map([
	["e1", { tier: "exam" }],
	["e2", { tier: "exam", level: 2 }],
	["c1", { tier: "check" }],
]);
const runs = (task, n, passed, tool = TOOL) =>
	Array.from({ length: n }, (_, i) => ({ tool, task, score: { share: i < passed ? 1 : 0.5 }, finishedAt: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T00:00:${String(i % 60).padStart(2, "0")}Z` }));

test("90% of the latest 50 runs saturates a level; fewer runs or a lower rate does not", () => {
	const records = [...runs("e1", 60, 56), ...runs("e2", 40, 40), ...runs("c1", 50, 44), ...runs("e1", 10, 0, "relay@0.6.122")];
	const s = saturation(records, tasks, { tool: TOOL });
	const exam1 = s.find((x) => x.tier === "exam" && x.level === 1);
	assert.equal(exam1.runs, 50);
	assert.ok(exam1.passRate >= 0.9);
	assert.equal(exam1.saturated, true);
	assert.equal(s.find((x) => x.tier === "exam" && x.level === 2).saturated, false, "40 runs are too few");
	assert.equal(s.find((x) => x.tier === "check").saturated, false, "88% is under 90%");
});

test("a saturated level opens the next level's draft queue once", () => {
	const exam = mkdtempSync(join(tmpdir(), "saturation-"));
	assert.equal(openLevel(exam, "exam"), 1);
	const s = saturation(runs("e1", 50, 50), tasks, { tool: TOOL });
	const opened = openHarder(exam, s, { now: new Date("2026-10-23T00:00:00Z") });
	assert.deepEqual(opened.map((o) => [o.tier, o.level, o.fromLevel]), [["exam", 2, 1]]);
	assert.equal(opened[0].criteria.minChangedLines, 120);
	assert.equal(openLevel(exam, "exam"), 2);
	assert.deepEqual(openHarder(exam, s), [], "already open");
	assert.equal(readHarder(exam).opened.length, 1);
});

test("a candidate's level comes from the size of its change", () => {
	assert.equal(levelOf({ changedLines: 30, files: { source: ["a.py"] } }), 1);
	assert.equal(levelOf({ changedLines: 150, files: { source: ["a.py", "b.py"] } }), 2);
	assert.equal(levelOf({ changedLines: 300, files: { source: ["a", "b", "c", "d"] } }), 3);
	assert.equal(levelOf({ changedLines: 300, files: { source: ["a"] } }), 1);
});
