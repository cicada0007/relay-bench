#!/usr/bin/env node
// A founder's approval of every drafted exam task at once, except the ones named (TIERS.md: every exam task "is
// approved by a founder who did not write it"). Each task is approved by approve-task's own code (scripts/approve-task.mjs),
// so every one of its refusals still holds; then the exam is locked again (scripts/lock-tasks.mjs), because approving
// changes task.json and a counted run refuses a task that differs from its lock.
//
//   node scripts/approve-many.mjs --by <name> --tasks-dir ../relay-exam/tasks [--except id1,id2]
//
// For a person at a terminal only. It refuses to run without an interactive terminal on both ends, and it asks the
// person to type how many tasks it will approve; anything else approves nothing. An agent never runs it: approving is
// the founder's reading of each task, which no program does for them.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { readTasks } from "../runner/stage-tasks.mjs";
import { approvalProblems, approve, isSealed } from "./approve-task.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/** Why this process may not approve anything: it needs a person at an interactive terminal. Empty when it may. */
export function terminalProblems({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
	const problems = [];
	if (!stdin.isTTY || !stdout.isTTY) problems.push("approve-many needs a person at an interactive terminal; it approves nothing when run by a program or an agent");
	if (env.CI) problems.push("approve-many does not run in CI");
	return problems;
}

/** The drafted exam and check tasks waiting for approval, minus `except`; unknown ids in `except` are refused. */
export function planApprovals(tasksDir, { except = [], by }) {
	const tasks = readTasks(tasksDir);
	const unknown = except.filter((id) => !tasks.has(id));
	if (unknown.length) throw new Error(`--except names tasks that are not in ${tasksDir}: ${unknown.join(", ")}`);
	const waiting = [...tasks].filter(([, t]) => isSealed(t) && !t.approvedBy && t.draftedBy).map(([id]) => id);
	const chosen = waiting.filter((id) => !except.includes(id));
	// approve() refuses its own cases (its drafter, no drafter, another tier); check them all before writing any.
	const refused = [];
	for (const id of chosen) {
		try {
			approve(tasks.get(id), by);
		} catch (error) {
			refused.push(`${id}: ${error.message}`);
		}
	}
	return { chosen, left: waiting.filter((id) => except.includes(id)), refused, tasks };
}

/** Approves each chosen task with approve-task's code and writes its task.json as approve-task does. */
export function approveAll(tasksDir, chosen, by, now = new Date()) {
	const done = [];
	for (const id of chosen) {
		const path = join(tasksDir, id, "task.json");
		const approved = approve(JSON.parse(readFileSync(path, "utf8")), by, now);
		writeFileSync(path, `${JSON.stringify(approved, null, 2)}\n`);
		done.push({ id, by: approved.approvedBy, at: approved.approvedAt });
	}
	return done;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values } = parseArgs({ options: { by: { type: "string" }, "tasks-dir": { type: "string", default: join(ROOT, "..", "relay-exam", "tasks") }, except: { type: "string", default: "" } } });
	const blocked = terminalProblems();
	if (blocked.length) {
		for (const p of blocked) console.error(p);
		process.exit(2);
	}
	if (!values.by?.trim()) throw new Error("--by <name> is required: the founder approving the tasks");
	const tasksDir = resolve(values["tasks-dir"]);
	if (!existsSync(tasksDir)) throw new Error(`no tasks folder at ${tasksDir}`);
	const except = values.except.split(",").map((s) => s.trim()).filter(Boolean);
	const plan = planApprovals(tasksDir, { except, by: values.by });
	if (plan.refused.length) {
		for (const r of plan.refused) console.error(r);
		console.error("nothing was approved: leave these out with --except, or fix them");
		process.exit(1);
	}
	if (!plan.chosen.length) {
		console.log(`No drafted task waits for approval in ${tasksDir}${plan.left.length ? ` (left out: ${plan.left.join(", ")})` : ""}.`);
		process.exit(0);
	}
	console.log(`${plan.chosen.length} drafted tasks would be approved by ${values.by.trim()}:`);
	for (const id of plan.chosen) console.log(`  ${id}  (${plan.tasks.get(id).tier}, ${plan.tasks.get(id).kind ?? "–"}, drafted by ${plan.tasks.get(id).draftedBy})`);
	if (plan.left.length) console.log(`Left out: ${plan.left.join(", ")}`);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const typed = (await rl.question(`Type ${plan.chosen.length} to approve them, anything else to stop: `)).trim();
	rl.close();
	if (typed !== String(plan.chosen.length)) {
		console.log("Nothing was approved.");
		process.exit(1);
	}
	for (const d of approveAll(tasksDir, plan.chosen, values.by)) console.log(`${d.id}: approved by ${d.by} at ${d.at}`);
	const lock = spawnSync(process.execPath, [join(ROOT, "scripts", "lock-tasks.mjs"), "--tasks-dir", tasksDir], { stdio: "inherit" });
	if (lock.status !== 0) console.error(`locking failed; lock the exam yourself: node scripts/lock-tasks.mjs --tasks-dir ${tasksDir}`);
	const stillWaiting = [...readTasks(tasksDir)].filter(([, t]) => isSealed(t) && approvalProblems(t).length).length;
	console.log(`Approved ${plan.chosen.length}; ${stillWaiting} exam or check task${stillWaiting === 1 ? "" : "s"} still not approved. Commit the exam repository's tasks and TASKS.lock.json.`);
}
