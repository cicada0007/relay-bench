#!/usr/bin/env node
// Checks that a task is usable: its judge fails every requirement on the starting repo and passes every requirement and
// gate on the reference solution, with R0 (nothing that worked before broke) holding on both.
// Usage: node scripts/validate-task.mjs [--tasks-dir <dir>] [--e2b] [--spend <ledger>] <task-id> [<task-id> ...]
// --tasks-dir is another tasks folder, such as the private exam's (TIERS.md); the default is this repository's tasks/.
//
// An exam or check task's repository is someone else's code, mined from a public pull request, so its judge runs in an
// E2B sandbox (scripts/e2b-judge.mjs), never on this machine; that needs E2B_API_KEY, and each sandbox is counted against
// the E2B cap in the drafting ledger (--spend; by default drafting/spend.json beside the tasks folder; --e2b-cap-usd sets
// the cap). --e2b judges practice tasks there too. --local-judge judges every task here, for tests only.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isSealed } from "./approve-task.mjs";
import { openLedger, SpendCapError } from "./draft-spend.mjs";
import { openE2BJudge, openLocalJudge } from "./e2b-judge.mjs";

const root = join(new URL(".", import.meta.url).pathname, "..");
const { values: options, positionals: ids } = parseArgs({
	options: {
		"tasks-dir": { type: "string" },
		e2b: { type: "boolean", default: false },
		"local-judge": { type: "boolean", default: false },
		spend: { type: "string" },
		"e2b-cap-usd": { type: "string" },
	},
	allowPositionals: true,
});
const tasksDir = resolve(options["tasks-dir"] ?? join(root, "tasks"));
if (ids.length === 0) {
	console.error("usage: node scripts/validate-task.mjs [--tasks-dir <dir>] [--e2b] [--spend <ledger>] <task-id> [<task-id> ...]");
	process.exit(2);
}
if (options.e2b && options["local-judge"]) {
	console.error("--e2b and --local-judge cannot both be given");
	process.exit(2);
}
let ledger;
const ledgerFor = () => (ledger ??= openLedger(resolve(options.spend ?? join(dirname(tasksDir), "drafting", "spend.json")), { caps: { e2b: options["e2b-cap-usd"] } }));

/** Where this task's judge runs: in E2B for an exam or check task (or with --e2b), here only for a practice task. */
function judgeFor(task, taskDir, id) {
	const inE2B = !options["local-judge"] && (options.e2b || isSealed(task));
	if (!inE2B) return openLocalJudge({ dir: taskDir, label: id });
	if (!process.env.E2B_API_KEY) throw new Error(`${id} is a${task.tier === "exam" ? "n" : ""} ${task.tier ?? "practice"} task: its judge runs someone else's code, so it runs in an E2B sandbox; set E2B_API_KEY`);
	return openE2BJudge({ dir: taskDir, label: id, purpose: "validate", ledger: ledgerFor(), minutes: 20, log: (line) => console.log(line) });
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
		let judge;
		try {
			judge = await judgeFor(task, taskDir, id);
		} catch (error) {
			console.error(error instanceof SpendCapError ? `spend cap: ${error.message}` : error.message);
			process.exit(error instanceof SpendCapError ? 3 : 1);
		}
		const started = Date.now();
		let base;
		let reference;
		try {
			base = await judge.run("repo", { checkout: true });
			reference = await judge.run("reference", { checkout: true });
		} catch (error) {
			problems.push(String(error.message).slice(0, 500));
			base = reference = {};
		} finally {
			await judge.close();
		}
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
