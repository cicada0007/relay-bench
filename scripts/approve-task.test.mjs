// Approving exam tasks, and the lock refusing unapproved ones: on throwaway task folders, no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { approvalProblems, approve, sameAuthor } from "./approve-task.mjs";
import { currentTasks, lockDifferences, lockPathFor } from "./lock-tasks.mjs";

const drafted = { id: "x-1", kind: "everyday", tier: "exam", draftedBy: "openai/gpt-6.1-sol-2026-09-30" };

test("a founder who did not draft a task approves it", () => {
	const task = approve(drafted, "arnav", new Date("2026-10-23T10:00:00Z"));
	assert.equal(task.approvedBy, "arnav");
	assert.equal(task.approvedAt, "2026-10-23T10:00:00.000Z");
	assert.deepEqual(approvalProblems(task), []);
});

test("approval is refused to the drafter, without a drafter, twice, and outside the sealed tiers", () => {
	assert.throws(() => approve({ ...drafted, draftedBy: "arnav" }, "Arnav "), /its drafter cannot approve it/);
	assert.throws(() => approve(drafted, "gpt-6.1-sol-2026-09-30"), /its drafter cannot approve it/);
	assert.throws(() => approve({ ...drafted, draftedBy: undefined }, "arnav"), /no drafter on record/);
	assert.throws(() => approve(approve(drafted, "arnav"), "sathwik"), /already approved, by arnav/);
	assert.throws(() => approve({ id: "p", kind: "long" }, "arnav"), /practice task/);
	assert.throws(() => approve(drafted, " "), /--by/);
	assert.ok(sameAuthor("openai/gpt-x", "GPT-X"));
	assert.ok(!sameAuthor("", ""));
});

test("only sealed tasks need approval, and a self-approval does not count", () => {
	assert.deepEqual(approvalProblems({ id: "p", kind: "long" }), []);
	assert.deepEqual(approvalProblems(drafted), ["not approved (scripts/approve-task.mjs)"]);
	assert.deepEqual(approvalProblems({ ...drafted, draftedBy: "arnav", approvedBy: "arnav", approvedAt: "2026-10-23" }), ["approved by its own drafter, arnav"]);
});

function examFolder() {
	const root = mkdtempSync(join(tmpdir(), "exam-"));
	const tasks = join(root, "tasks");
	for (const [id, extra] of [["a-1", {}], ["b-2", { approvedBy: "arnav", approvedAt: "2026-10-23T00:00:00Z" }]]) {
		const dir = join(tasks, id);
		mkdirSync(join(dir, "repo"), { recursive: true });
		mkdirSync(join(dir, "judge"), { recursive: true });
		writeFileSync(join(dir, "repo", "a.py"), "x = 1\n");
		writeFileSync(join(dir, "judge", "judge.mjs"), "// judge\n");
		writeFileSync(join(dir, "request.md"), "Do it.\n");
		writeFileSync(join(dir, "task.json"), JSON.stringify({ ...drafted, id, ...extra }));
	}
	return { root, tasks };
}

test("the lock records approvals, and an unapproved exam task is a difference a counted run refuses", () => {
	const { root, tasks } = examFolder();
	try {
		const now = currentTasks(tasks);
		assert.equal(now["a-1"].tier, "exam");
		assert.equal(now["a-1"].approvedBy, null);
		assert.equal(now["b-2"].approvedBy, "arnav");
		writeFileSync(lockPathFor(tasks), JSON.stringify({ lockedAt: "2026-10-23", tasks: now }));
		assert.deepEqual(lockDifferences(["b-2"], tasks), []);
		assert.deepEqual(lockDifferences(["a-1", "b-2"], tasks), [{ id: "a-1", what: "not approved (scripts/approve-task.mjs)" }]);
		// Approving after the lock changes task.json, so the task must be locked again.
		const path = join(tasks, "a-1", "task.json");
		writeFileSync(path, JSON.stringify(approve(JSON.parse(readFileSync(path, "utf8")), "arnav")));
		assert.deepEqual(lockDifferences(["a-1"], tasks), [{ id: "a-1", what: "task changed" }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the command line writes the approval into task.json", () => {
	const { root, tasks } = examFolder();
	try {
		const script = new URL("./approve-task.mjs", import.meta.url).pathname;
		const out = execFileSync(process.execPath, [script, "a-1", "--by", "sathwik", "--tasks-dir", tasks], { encoding: "utf8" });
		assert.match(out, /a-1: approved by sathwik/);
		const task = JSON.parse(readFileSync(join(tasks, "a-1", "task.json"), "utf8"));
		assert.equal(task.approvedBy, "sathwik");
		assert.throws(() => execFileSync(process.execPath, [script, "a-1", "--by", "arnav", "--tasks-dir", tasks], { stdio: "pipe" }));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
