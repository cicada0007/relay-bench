#!/usr/bin/env node
// The check tier's one door (TIERS.md: the improving agent may see "pass or fail only"). It answers one question, did
// this candidate pass the gate against the champion on the check tasks, with one word: pass or fail. Nothing else is
// printed: no score, no interval, no task names. Every new answer is one read of every check task it covers, counted in
// the exam's exposure log against the leak budget (runner/exposure.mjs). Past the budget it refuses and answers nothing.
// Asking the same question again over the same runs costs nothing and tells nothing new.
//
//   node scripts/check-query.mjs --out ../relay-exam/runs/check --test check-0.6.122 \
//     --champion 0.6.121 --candidate 0.6.122-beta.3 --tasks-dir ../relay-exam/tasks
//
// Exit codes: 0 pass, 1 fail, 2 refused (the budget is spent, or there are no check runs to answer from).
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadRecords } from "../runner/analyze.mjs";
import { budgetProblems, exposureCounts, exposurePathFor, loadBudget, readExposures, recordExposure } from "../runner/exposure.mjs";
import { gate, sharedTasks } from "../runner/gate-analyze.mjs";
import { readTasks } from "../runner/stage-tasks.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * The answer to one check question: { answer: "pass" | "fail" | null, problems, read, repeat, readsLeft }. `tiers` maps
 * task ids to their tier; only check-tier tasks count. Pure: the caller records `read` when the answer is given and the
 * question is new (`repeat` false).
 */
export function checkAnswer({ records, champion, candidate, tiers, entries, budget, test }) {
	const check = records.filter((r) => tiers.get(r.task) === "check");
	const tasks = sharedTasks(check, champion, candidate);
	if (!tasks.length) return { answer: null, problems: ["no check task has a grade for both arms"], read: null, readsLeft: null };
	const read = { kind: "read", tier: "check", tasks, key: `check:${test}:${candidate}:${tasks.length}:${check.length}`, test, by: "check-query" };
	const problems = budgetProblems({ entries, add: [read], budget });
	if (problems.length) return { answer: null, problems, read: null, readsLeft: 0 };
	const { counts, keys } = exposureCounts(entries);
	const repeat = keys.has(read.key);
	const readsLeft = Math.min(...tasks.map((t) => budget.check.readsPerTask - (counts.get(t)?.reads ?? 0) - (repeat ? 0 : 1)));
	const verdict = gate(check, { champion, candidate });
	return { answer: verdict.status === "PASS" ? "pass" : "fail", problems: [], read, repeat, readsLeft };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values } = parseArgs({ options: { out: { type: "string" }, test: { type: "string" }, champion: { type: "string" }, candidate: { type: "string" }, "tasks-dir": { type: "string" } } });
	for (const name of ["out", "test", "champion", "candidate", "tasks-dir"]) if (!values[name]) throw new Error(`--${name} is required`);
	const tasksDir = resolve(values["tasks-dir"]);
	const inside = relative(ROOT, tasksDir);
	if (!inside.startsWith("..") && !isAbsolute(inside)) throw new Error(`the check tier is sealed; ${tasksDir} is inside this public repository`);
	const tiers = new Map([...readTasks(tasksDir)].map(([id, t]) => [id, t.tier]));
	const path = exposurePathFor(tasksDir);
	const result = checkAnswer({
		records: loadRecords(resolve(values.out), values.test),
		champion: `relay@${values.champion}`,
		candidate: `relay@${values.candidate}`,
		tiers,
		entries: readExposures(path),
		budget: loadBudget(tasksDir),
		test: values.test,
	});
	if (!result.answer) {
		console.error(`refused: ${result.problems[0]}`);
		process.exit(2);
	}
	if (!result.repeat) recordExposure(path, result.read);
	console.log(result.answer);
	console.error(`reads left on these check tasks: ${result.readsLeft}`);
	process.exit(result.answer === "pass" ? 0 : 1);
}
