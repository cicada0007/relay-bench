// scripts/approve-many.mjs: approve-task's own code for every drafted task but the ones left out, for a person at a
// terminal only. Its command line is run here only without a terminal, where it must refuse.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { approveAll, planApprovals, terminalProblems } from "./approve-many.mjs";

const SCRIPT = new URL("./approve-many.mjs", import.meta.url).pathname;

function exam() {
	const root = mkdtempSync(join(tmpdir(), "approve-many-"));
	const tasks = join(root, "tasks");
	const put = (id, task) => {
		mkdirSync(join(tasks, id), { recursive: true });
		writeFileSync(join(tasks, id, "task.json"), JSON.stringify({ id, kind: "everyday", ...task }));
	};
	for (let i = 0; i < 4; i++) put(`d${i}`, { tier: "exam", draftedBy: "openai/gpt-6-luna" });
	put("done", { tier: "exam", draftedBy: "openai/gpt-6-luna", approvedBy: "sathwik", approvedAt: "2026-10-20T00:00:00.000Z" });
	put("practice", { draftedBy: "openai/gpt-6-luna" });
	return { root, tasks };
}

test("without an interactive terminal it refuses and approves nothing", () => {
	const e = exam();
	const before = readFileSync(join(e.tasks, "d0", "task.json"), "utf8");
	const r = spawnSync(process.execPath, [SCRIPT, "--by", "arnav", "--tasks-dir", e.tasks], { encoding: "utf8", input: "4\n" });
	assert.equal(r.status, 2, r.stdout + r.stderr);
	assert.match(r.stderr, /needs a person at an interactive terminal; it approves nothing when run by a program or an agent/);
	assert.equal(readFileSync(join(e.tasks, "d0", "task.json"), "utf8"), before);
	assert.deepEqual(terminalProblems({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: {} }), []);
	assert.equal(terminalProblems({ stdin: { isTTY: true }, stdout: { isTTY: undefined }, env: {} }).length, 1);
	assert.match(terminalProblems({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: { CI: "true" } }).join(), /CI/);
});

test("it plans every drafted sealed task but the ones left out, refuses unknown ids and drafters, and writes as approve-task does", () => {
	const e = exam();
	const plan = planApprovals(e.tasks, { except: ["d2"], by: "arnav" });
	assert.deepEqual(plan.chosen, ["d0", "d1", "d3"]);
	assert.deepEqual(plan.left, ["d2"]);
	assert.deepEqual(plan.refused, []);
	assert.throws(() => planApprovals(e.tasks, { except: ["d9"], by: "arnav" }), /not in .*: d9/);
	assert.match(planApprovals(e.tasks, { by: "openai/gpt-6-luna" }).refused.join("; "), /its drafter cannot approve it/);
	const now = new Date("2026-10-24T12:00:00Z");
	const done = approveAll(e.tasks, plan.chosen, "arnav", now);
	assert.deepEqual(done.map((d) => d.id), ["d0", "d1", "d3"]);
	const task = JSON.parse(readFileSync(join(e.tasks, "d1", "task.json"), "utf8"));
	assert.equal(task.approvedBy, "arnav");
	assert.equal(task.approvedAt, now.toISOString());
	assert.equal(JSON.parse(readFileSync(join(e.tasks, "d2", "task.json"), "utf8")).approvedBy, undefined);
	assert.deepEqual(planApprovals(e.tasks, { by: "arnav" }).chosen, ["d2"], "approved tasks are not asked again");
});
