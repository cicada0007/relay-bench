#!/usr/bin/env node
// Checks that a task is usable: its judge fails every requirement on the starting repo and passes every requirement and
// gate on the reference solution, with R0 (nothing that worked before broke) holding on both.
// Usage: node scripts/validate-task.mjs [--tasks-dir <dir>] <task-id> [<task-id> ...]
// --tasks-dir is another tasks folder, such as the private exam's (TIERS.md); the default is this repository's tasks/.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = join(new URL(".", import.meta.url).pathname, "..");
const { values: options, positionals: ids } = parseArgs({ options: { "tasks-dir": { type: "string" } }, allowPositionals: true });
const tasksDir = resolve(options["tasks-dir"] ?? join(root, "tasks"));
if (ids.length === 0) {
	console.error("usage: node scripts/validate-task.mjs [--tasks-dir <dir>] <task-id> [<task-id> ...]");
	process.exit(2);
}

/** Copies a tree into a fresh git repository, so the judge sees what a tool would leave behind. */
function checkout(from) {
	const dir = mkdtempSync(join(tmpdir(), "relay-bench-"));
	cpSync(from, dir, { recursive: true });
	const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git("-c", "user.name=bench", "-c", "user.email=bench@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "start");
	return dir;
}

function judge(taskDir, tree) {
	const dir = checkout(tree);
	try {
		const out = execFileSync(process.execPath, [join(taskDir, "judge", "judge.mjs"), dir], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10 * 60_000,
		});
		const line = out.trim().split("\n").filter(Boolean).pop();
		return JSON.parse(line);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

let failed = 0;
for (const id of ids) {
	const taskDir = join(tasksDir, id);
	const problems = [];
	for (const part of ["task.json", "request.md", "repo", "judge/judge.mjs", "reference"]) {
		if (!existsSync(join(taskDir, part))) problems.push(`missing ${part}`);
	}
	if (problems.length === 0) {
		const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
		const started = Date.now();
		const base = judge(taskDir, join(taskDir, "repo"));
		const reference = judge(taskDir, join(taskDir, "reference"));
		const seconds = Math.round((Date.now() - started) / 1000);
		for (const r of task.requirements) {
			if (base.requirements?.[r] !== false) problems.push(`${r} is not false on the starting repo`);
			if (reference.requirements?.[r] !== true) problems.push(`${r} is not true on the reference (${reference.notes?.[r] ?? "no note"})`);
		}
		if (base.R0 !== true) problems.push(`R0 fails on the starting repo (${base.notes?.R0 ?? "no note"})`);
		if (reference.R0 !== true) problems.push(`R0 fails on the reference (${reference.notes?.R0 ?? "no note"})`);
		for (const [gate, ok] of Object.entries(reference.gates ?? {})) if (!ok) problems.push(`gate ${gate} fails on the reference`);
		if (seconds > 600) problems.push(`judging took ${seconds}s for two runs; the limit is 5 minutes per run`);
		console.log(`${id}: judged in ${seconds}s`);
	}
	if (problems.length) {
		failed++;
		console.log(`FAIL ${id}\n${problems.map((p) => `  - ${p}`).join("\n")}`);
	} else {
		console.log(`ok   ${id}`);
	}
}
process.exit(failed ? 1 : 0);
