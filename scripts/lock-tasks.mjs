#!/usr/bin/env node
// Locks the round's tasks before the first counted run: writes TASKS.lock.json with a content fingerprint of every
// task's task.json, request, starting repository and judge. The lock is committed publicly while the tasks stay private
// (six are the holdout), so anyone can check later that the published tasks are the ones that were run. run-stage.mjs
// refuses a counted test when a task no longer matches its lock, and every run record carries the same fingerprints.
//
//   node scripts/lock-tasks.mjs            writes TASKS.lock.json from tasks/
//   node scripts/lock-tasks.mjs --check    exits 1 if any task differs from the lock
//   --tasks-dir <dir>                      another tasks folder, such as the private exam's (TIERS.md); its lock is the
//                                          TASKS.lock.json beside that folder, so the exam's lock stays private with it
//
// An exam or check task also needs a founder's approval (scripts/approve-task.mjs). The lock records who approved it,
// and a task that is not approved, or was approved by its own drafter, counts as a difference: a counted run refuses it.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { taskHashes } from "../runner/judge.mjs";
import { approvalProblems, isSealed } from "./approve-task.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const DEFAULT_TASKS = join(ROOT, "tasks");
/** A tasks folder's lock: the TASKS.lock.json beside it. */
export const lockPathFor = (tasksDir) => join(dirname(resolve(tasksDir)), "TASKS.lock.json");

export function currentTasks(tasksDir = DEFAULT_TASKS) {
	const tasks = {};
	for (const id of readdirSync(tasksDir).sort()) {
		const dir = join(tasksDir, id);
		if (!existsSync(join(dir, "task.json"))) continue;
		const task = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
		tasks[id] = {
			kind: task.kind,
			private: task.private === true,
			...(isSealed(task) ? { tier: task.tier, draftedBy: task.draftedBy ?? null, approvedBy: task.approvedBy ?? null } : {}),
			hashes: taskHashes(dir),
		};
	}
	return tasks;
}

/** The tasks whose content differs from the lock, with what differs; empty when every task matches. */
export function lockDifferences(ids, tasksDir = DEFAULT_TASKS) {
	const lockPath = lockPathFor(tasksDir);
	if (!existsSync(lockPath)) return [{ id: "*", what: `${lockPath} does not exist` }];
	const lock = JSON.parse(readFileSync(lockPath, "utf8")).tasks;
	const now = currentTasks(tasksDir);
	const differences = [];
	for (const id of ids ?? Object.keys(lock)) {
		if (!lock[id]) differences.push({ id, what: "not in the lock" });
		else if (!now[id]) differences.push({ id, what: "missing from tasks/" });
		else {
			for (const part of Object.keys(lock[id].hashes)) {
				if (lock[id].hashes[part] !== now[id].hashes[part]) differences.push({ id, what: `${part} changed` });
			}
			const task = JSON.parse(readFileSync(join(tasksDir, id, "task.json"), "utf8"));
			for (const problem of approvalProblems(task)) differences.push({ id, what: problem });
		}
	}
	return differences;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values } = parseArgs({ options: { check: { type: "boolean", default: false }, "tasks-dir": { type: "string" } } });
	const tasksDir = resolve(values["tasks-dir"] ?? DEFAULT_TASKS);
	const lockPath = lockPathFor(tasksDir);
	if (values.check) {
		const differences = lockDifferences(undefined, tasksDir);
		for (const d of differences) console.log(`${d.id}: ${d.what}`);
		console.log(differences.length ? `the tasks differ from ${lockPath}` : `every task matches ${lockPath}`);
		process.exit(differences.length ? 1 : 0);
	}
	const tasks = currentTasks(tasksDir);
	writeFileSync(lockPath, `${JSON.stringify({ lockedAt: new Date().toISOString(), tasks }, null, 2)}\n`);
	console.log(`${lockPath}: ${Object.keys(tasks).length} tasks locked`);
	const unapproved = Object.keys(tasks).filter((id) => tasks[id].tier && approvalProblems(JSON.parse(readFileSync(join(tasksDir, id, "task.json"), "utf8"))).length);
	if (unapproved.length) console.log(`not approved, so a counted run refuses them: ${unapproved.join(", ")}`);
}
