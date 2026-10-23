// The leak budget (runner/exposure.mjs), on a throwaway exam folder.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { budgetPathFor, budgetProblems, exposureCounts, exposurePathFor, LEAK_BUDGET, loadBudget, readExposures, recordExposure } from "./exposure.mjs";

function exam() {
	const root = mkdtempSync(join(tmpdir(), "exposure-"));
	mkdirSync(join(root, "tasks"));
	return join(root, "tasks");
}

test("runs and reads are counted per task; a repeated read with the same key counts once", () => {
	const tasks = exam();
	const path = exposurePathFor(tasks);
	recordExposure(path, { kind: "run", tier: "exam", tasks: ["a"], test: "g" });
	recordExposure(path, { kind: "run", tier: "exam", tasks: ["a"], test: "g" });
	recordExposure(path, { kind: "read", tier: "exam", tasks: ["a", "b"], key: "gate:g:look1" });
	recordExposure(path, { kind: "read", tier: "exam", tasks: ["a", "b"], key: "gate:g:look1" });
	const { counts } = exposureCounts(readExposures(path));
	assert.deepEqual(counts.get("a"), { tier: "exam", runs: 2, reads: 1 });
	assert.deepEqual(counts.get("b"), { tier: "exam", runs: 0, reads: 1 });
	assert.throws(() => recordExposure(path, { kind: "run", tier: "practice", tasks: ["p"] }), /sealed/);
	assert.throws(() => recordExposure(path, { kind: "peek", tier: "exam", tasks: ["a"] }), /run or a read/);
});

test("a stage or a read that would pass the budget is refused, naming the task", () => {
	const budget = { exam: { runsPerTask: 2, readsPerTask: 1 }, check: LEAK_BUDGET.check };
	const entries = [
		{ kind: "run", tier: "exam", tasks: ["a"] },
		{ kind: "read", tier: "exam", tasks: ["a"], key: "k1" },
	];
	assert.deepEqual(budgetProblems({ entries, add: [{ kind: "run", tier: "exam", tasks: ["a"] }], budget }), []);
	assert.match(budgetProblems({ entries, add: [{ kind: "run", tier: "exam", tasks: ["a"] }, { kind: "run", tier: "exam", tasks: ["a"] }], budget })[0], /a would be shown to 3 runs; its budget is 2/);
	assert.match(budgetProblems({ entries, add: [{ kind: "read", tier: "exam", tasks: ["a"], key: "k2" }], budget })[0], /a would be read 2 times; its budget is 1/);
	assert.deepEqual(budgetProblems({ entries, add: [{ kind: "read", tier: "exam", tasks: ["a"], key: "k1" }], budget }), [], "the same look read again costs nothing");
	assert.deepEqual(budgetProblems({ entries, add: [{ kind: "run", tier: "practice", tasks: ["p"] }], budget }), [], "practice is not budgeted");
});

test("a budget can be lowered beside the exam, never raised past twice the default", () => {
	const tasks = exam();
	assert.deepEqual(loadBudget(tasks), JSON.parse(JSON.stringify(LEAK_BUDGET)));
	writeFileSync(budgetPathFor(tasks), JSON.stringify({ exam: { readsPerTask: 10 } }));
	assert.equal(loadBudget(tasks).exam.readsPerTask, 10);
	assert.equal(loadBudget(tasks).exam.runsPerTask, LEAK_BUDGET.exam.runsPerTask);
	writeFileSync(budgetPathFor(tasks), JSON.stringify({ check: { runsPerTask: 1000 } }));
	assert.throws(() => loadBudget(tasks), /from 0 to 80/);
});
