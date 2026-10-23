#!/usr/bin/env node
// Grades runs again with the task's current judge. Used when a judge is fixed (for example to accept a reasonable reading
// of the request it wrongly refused): TASK_FORMAT.md requires the fix to apply to every tool alike, so this re-grades
// every run of that task in the test, never a chosen few. records.jsonl is never edited; each new grade is appended to
// rejudged.jsonl with the reason and the judge's fingerprint, and analyze.mjs uses the latest grade of each run.
//
//   node runner/rejudge.mjs --out runs/round-1 --test A --task py-mini-sql --reason "R3.4 accepted both NULL orders"
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { judgeResult, scoreOf, treeHash } from "./judge.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const { values: args } = parseArgs({
	options: {
		out: { type: "string", default: "runs/round-1" },
		test: { type: "string" },
		task: { type: "string" },
		reason: { type: "string" },
		"tasks-dir": { type: "string", default: join(ROOT, "tasks") },
		concurrency: { type: "string", default: "4" },
	},
});
for (const name of ["test", "task", "reason"]) if (!args[name]) throw new Error(`--${name} is required`);

const out = join(ROOT, args.out);
const taskDir = join(args["tasks-dir"], args.task);
const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
const records = readFileSync(join(out, "records.jsonl"), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l))
	.filter((r) => r.test === args.test && r.task === args.task);
const missing = records.filter((r) => !existsSync(join(out, r.runId, "result.tgz")));
if (missing.length) {
	// Every run of the task is re-graded or none is: a partial re-grade would treat the tools differently.
	throw new Error(`no result.tgz for ${missing.length} run(s), e.g. ${missing[0].runId}; nothing re-graded`);
}
console.log(`re-grading ${records.length} runs of ${args.task} in test ${args.test}: ${args.reason}`);

const queue = [...records];
await Promise.all(
	Array.from({ length: Number(args.concurrency) }, async () => {
		while (queue.length) {
			const record = queue.shift();
			const graded = await judgeResult(readFileSync(join(out, record.runId, "result.tgz")), taskDir, `${record.runId}-rejudge`);
			const { score, saidDoneButFailed } = scoreOf(task, graded.judge, record.saidDone);
			// The judge's content fingerprint, the same as TASKS.lock.json's, so a release's pinned graders can be checked.
			const judgeTreeHash = treeHash(join(taskDir, "judge"));
			appendFileSync(
				join(out, "rejudged.jsonl"),
				`${JSON.stringify({ runId: record.runId, rejudgedAt: new Date().toISOString(), reason: args.reason, ...graded, judgeTreeHash, score, saidDoneButFailed })}\n`,
			);
			console.log(`${record.runId}: ${record.score?.requirementsMet}/${task.requirements.length} -> ${score.requirementsMet}/${task.requirements.length}`);
		}
	}),
);
