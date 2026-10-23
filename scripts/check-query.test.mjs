// The check tier's door (scripts/check-query.mjs): one word per answer, every new answer counted, none past the budget.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exposurePathFor, readExposures } from "../runner/exposure.mjs";

const SCRIPT = new URL("./check-query.mjs", import.meta.url).pathname;

function setup({ cand = 0.8, n = 100 } = {}) {
	const root = mkdtempSync(join(tmpdir(), "check-query-"));
	const tasks = join(root, "tasks");
	const out = join(root, "runs");
	mkdirSync(out, { recursive: true });
	const lines = [];
	for (let i = 0; i < n + 5; i++) {
		const id = i < n ? `c${i}` : `e${i}`;
		mkdirSync(join(tasks, id), { recursive: true });
		writeFileSync(join(tasks, id, "task.json"), JSON.stringify({ id, kind: "everyday", tier: i < n ? "check" : "exam" }));
		for (const [tool, share] of [
			["relay@0.6.121", 0.2],
			["relay@0.6.122", cand],
		]) lines.push(JSON.stringify({ test: "check-1", task: id, tool, score: { share }, usage: { costUsd: 0.1 }, wallMs: 1 }));
	}
	writeFileSync(join(out, "records.jsonl"), `${lines.join("\n")}\n`);
	return { root, tasks, out };
}
const ask = (s) => spawnSync(process.execPath, [SCRIPT, "--out", s.out, "--test", "check-1", "--champion", "0.6.121", "--candidate", "0.6.122", "--tasks-dir", s.tasks], { encoding: "utf8" });

test("it answers pass or fail and nothing else, counting one read of each check task", () => {
	const s = setup();
	const r = ask(s);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, "pass\n");
	const reads = readExposures(exposurePathFor(s.tasks));
	assert.equal(reads.length, 1);
	assert.equal(reads[0].tier, "check");
	assert.equal(reads[0].tasks.length, 100, "exam tasks are not part of a check answer");
	assert.equal(ask(s).status, 0);
	assert.equal(readExposures(exposurePathFor(s.tasks)).length, 1, "the same question again costs nothing");
	const worse = setup({ cand: 0 });
	const f = ask(worse);
	assert.equal(f.status, 1);
	assert.equal(f.stdout, "fail\n");
});

test("past the budget it refuses and answers nothing", () => {
	const s = setup();
	writeFileSync(join(s.root, "leak-budget.json"), JSON.stringify({ check: { readsPerTask: 0 } }));
	const r = ask(s);
	assert.equal(r.status, 2);
	assert.equal(r.stdout, "");
	assert.match(r.stderr, /refused: c\d+ would be read 1 times; its budget is 0/);
	assert.deepEqual(readExposures(exposurePathFor(s.tasks)), []);
});
