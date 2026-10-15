#!/usr/bin/env node
// Runs inside the sandbox after a Relay run: merges Relay's verified task branches onto the starting branch in plan
// order, in a fresh clone at <out>, as a reviewer would. Prints one JSON line: planned, verified, merged, conflicts.
// Usage: node relay-merge.mjs <work> <out>
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [work, out] = process.argv.slice(2);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const root = join(homedir(), ".relay/agent/supervisor/local");
const queues = existsSync(root) ? readdirSync(root).map((name) => join(root, name, "queue.json")).filter(existsSync) : [];
const queue = queues.map((path) => JSON.parse(readFileSync(path, "utf8"))).find((q) => !q.repo || q.repo === work || q.repoPath === work) ?? (queues[0] ? JSON.parse(readFileSync(queues[0], "utf8")) : undefined);

git("/home/user", "clone", "-q", work, out);
git(out, "config", "user.name", "judge");
git(out, "config", "user.email", "judge@example.com");
const tasks = [...(queue?.tasks ?? [])].sort((a, b) => a.seq - b.seq);
const merged = [];
const conflicts = [];
for (const task of tasks) {
	if (task.status !== "verified") continue;
	try {
		git(out, "fetch", "-q", "origin", `${task.branch}:${task.branch}`);
		git(out, "merge", "-q", "--no-edit", task.branch);
		merged.push(task.id);
	} catch (error) {
		conflicts.push({ task: task.id, detail: String(error.stdout ?? error.message).split("\n").slice(0, 3).join(" ") });
		try {
			git(out, "merge", "--abort");
		} catch {}
	}
}
console.log(
	JSON.stringify({
		planned: tasks.length,
		verified: tasks.filter((t) => t.status === "verified").length,
		statuses: Object.fromEntries(tasks.map((t) => [t.id, t.status])),
		merged,
		conflicts,
	}),
);
