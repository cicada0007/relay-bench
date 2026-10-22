#!/usr/bin/env node
// A founder's approval of one exam task (TIERS.md: every exam task "is approved by a founder who did not write it").
// Writes "approvedBy" and "approvedAt" into the task's task.json. It refuses a task whose drafter is the approver, a
// task with no drafter on record, a task outside the exam and check tiers, and a task already approved. Approving
// changes task.json, so lock the exam after approving (scripts/lock-tasks.mjs --tasks-dir); a counted run refuses an
// exam or check task that is not approved (lockDifferences in lock-tasks.mjs).
//
//   node scripts/approve-task.mjs <id> --by <name> [--tasks-dir ../relay-exam/tasks]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = new URL("..", import.meta.url).pathname;
/** The tiers whose tasks must be approved: the sealed ones (TIERS.md). */
export const SEALED_TIERS = Object.freeze(["exam", "check"]);
export const isSealed = (task) => SEALED_TIERS.includes(task?.tier);

const person = (name) => String(name ?? "").trim().toLowerCase();
/** The same author, also when one side carries a provider prefix ("openai/gpt-6.1-sol" and "gpt-6.1-sol"). */
export function sameAuthor(a, b) {
	const x = person(a);
	const y = person(b);
	return Boolean(x) && (x === y || x.split("/").pop() === y.split("/").pop());
}

/** Why a task does not count as approved; empty when it does, or when its tier needs no approval. */
export function approvalProblems(task) {
	if (!isSealed(task)) return [];
	const problems = [];
	if (!task.draftedBy) problems.push("no drafter on record (draftedBy)");
	if (!task.approvedBy || !task.approvedAt) problems.push("not approved (scripts/approve-task.mjs)");
	else if (sameAuthor(task.approvedBy, task.draftedBy)) problems.push(`approved by its own drafter, ${task.approvedBy}`);
	return problems;
}

/** The task with the approval added, or an error saying why it cannot be approved. */
export function approve(task, by, now = new Date()) {
	if (!person(by)) throw new Error("--by <name> is required: the founder approving the task");
	if (!isSealed(task)) throw new Error(`${task.id} is a ${task.tier ?? "practice"} task; only exam and check tasks are approved`);
	if (!task.draftedBy) throw new Error(`${task.id} has no drafter on record (draftedBy), so nobody can show they did not write it`);
	if (sameAuthor(by, task.draftedBy)) throw new Error(`${task.id} was drafted by ${task.draftedBy}; its drafter cannot approve it`);
	if (task.approvedBy) throw new Error(`${task.id} is already approved, by ${task.approvedBy} at ${task.approvedAt}`);
	return { ...task, approvedBy: String(by).trim(), approvedAt: now.toISOString() };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values, positionals } = parseArgs({
		options: { by: { type: "string" }, "tasks-dir": { type: "string", default: join(ROOT, "..", "relay-exam", "tasks") } },
		allowPositionals: true,
	});
	const [id] = positionals;
	if (!id || positionals.length > 1) throw new Error("usage: node scripts/approve-task.mjs <id> --by <name> [--tasks-dir <exam>/tasks]");
	const path = join(resolve(values["tasks-dir"]), id, "task.json");
	if (!existsSync(path)) throw new Error(`no task.json at ${path}`);
	const approved = approve(JSON.parse(readFileSync(path, "utf8")), values.by);
	writeFileSync(path, `${JSON.stringify(approved, null, 2)}\n`);
	console.log(`${id}: approved by ${approved.approvedBy} at ${approved.approvedAt}. Lock the exam again before a counted run.`);
}
