#!/usr/bin/env node
// Locks the round's tasks before the first counted run: writes TASKS.lock.json with a content fingerprint of every
// task's task.json, request, starting repository and judge. The lock is committed publicly while the tasks stay private
// (six are the holdout), so anyone can check later that the published tasks are the ones that were run. run-stage.mjs
// refuses a counted test when a task no longer matches its lock, and every run record carries the same fingerprints.
//
//   node scripts/lock-tasks.mjs            writes TASKS.lock.json from tasks/
//   node scripts/lock-tasks.mjs --check    exits 1 if any task differs from the lock
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { taskHashes } from "../runner/judge.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const TASKS = join(ROOT, "tasks");
const LOCK = join(ROOT, "TASKS.lock.json");

export function currentTasks() {
	const tasks = {};
	for (const id of readdirSync(TASKS).sort()) {
		const dir = join(TASKS, id);
		if (!existsSync(join(dir, "task.json"))) continue;
		const task = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
		tasks[id] = { kind: task.kind, private: task.private === true, hashes: taskHashes(dir) };
	}
	return tasks;
}

/** The tasks whose content differs from the lock, with what differs; empty when every task matches. */
export function lockDifferences(ids) {
	if (!existsSync(LOCK)) return [{ id: "*", what: "TASKS.lock.json does not exist" }];
	const lock = JSON.parse(readFileSync(LOCK, "utf8")).tasks;
	const now = currentTasks();
	const differences = [];
	for (const id of ids ?? Object.keys(lock)) {
		if (!lock[id]) differences.push({ id, what: "not in the lock" });
		else if (!now[id]) differences.push({ id, what: "missing from tasks/" });
		else {
			for (const part of Object.keys(lock[id].hashes)) {
				if (lock[id].hashes[part] !== now[id].hashes[part]) differences.push({ id, what: `${part} changed` });
			}
		}
	}
	return differences;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	if (process.argv.includes("--check")) {
		const differences = lockDifferences();
		for (const d of differences) console.log(`${d.id}: ${d.what}`);
		console.log(differences.length ? "the tasks differ from TASKS.lock.json" : "every task matches TASKS.lock.json");
		process.exit(differences.length ? 1 : 0);
	}
	const tasks = currentTasks();
	writeFileSync(LOCK, `${JSON.stringify({ lockedAt: new Date().toISOString(), tasks }, null, 2)}\n`);
	console.log(`TASKS.lock.json: ${Object.keys(tasks).length} tasks locked`);
}
