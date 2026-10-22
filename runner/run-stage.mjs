#!/usr/bin/env node
// Runs one stage of the round: every task × tool × repetition, a few at a time, each as its own run-one.mjs process.
// Order is repetition, then task, then tool, so a stage cut short still compares the tools on the same tasks.
//
// It never spends past its caps: a run is launched only while (spent + runs in flight × per-run cap + per-run cap) stays
// within --stage-cap-usd, since the meter stops each run at its own cap. Sandbox time is counted the same way against
// --e2b-cap-usd at E2B's price. It resumes: runs already in records.jsonl are skipped. A run that ends without a record
// (our infrastructure failed, not the tool) is retried once and logged, as PREREGISTRATION.md says.
//
//   node runner/run-stage.mjs --test A --model claude-sonnet-5-5 --tools relay,prime-agent,claude-code \
//     --tasks kind:long --reps 3 --cap-usd 10 --stage-cap-usd 170 --e2b-cap-usd 40 --concurrency 4 --out runs/round-1
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = new URL("..", import.meta.url).pathname;
const { values: args } = parseArgs({
	options: {
		test: { type: "string" },
		model: { type: "string" },
		tools: { type: "string", default: "relay,prime-agent,claude-code" },
		tasks: { type: "string", default: "kind:long" },
		reps: { type: "string", default: "3" },
		"cap-usd": { type: "string" },
		"stage-cap-usd": { type: "string" },
		"e2b-cap-usd": { type: "string", default: "100" },
		concurrency: { type: "string", default: "4" },
		out: { type: "string", default: "runs/round-1" },
		"tasks-dir": { type: "string", default: join(ROOT, "tasks") },
		"dry-run": { type: "boolean", default: false },
		faults: { type: "string" },
	},
});
for (const name of ["test", "model", "cap-usd", "stage-cap-usd"]) if (!args[name]) throw new Error(`--${name} is required`);
// A counted test runs only on locked tasks (scripts/lock-tasks.mjs); pilots and dev runs may use tasks still in work.
const counted = !/^(pilot|dev)/.test(args.test);

/** E2B, 2 vCPU + 4 GiB, checked 15 Oct 2026 at e2b.dev/pricing: $0.000046 per second. */
const E2B_USD_PER_SECOND = 0.000046;
const out = join(ROOT, args.out);
mkdirSync(out, { recursive: true });
const recordsPath = join(out, "records.jsonl");
const tools = args.tools.split(",");
const capUsd = Number(args["cap-usd"]);
const stageCap = Number(args["stage-cap-usd"]);
const e2bCap = Number(args["e2b-cap-usd"]);

/** --tasks: a comma list of task ids and kind:<kind> selectors (kind:long,kind:everyday), in that order. */
function taskIds() {
	const all = readdirSync(args["tasks-dir"]).filter((id) => existsSync(join(args["tasks-dir"], id, "task.json"))).sort();
	const kindOf = (id) => JSON.parse(readFileSync(join(args["tasks-dir"], id, "task.json"), "utf8")).kind;
	const ids = [];
	for (const item of args.tasks.split(",")) {
		for (const id of item.startsWith("kind:") ? all.filter((t) => kindOf(t) === item.slice(5)) : [item]) {
			if (!ids.includes(id)) ids.push(id);
		}
	}
	return ids;
}
/** Test D's faults, one run per fault; every other test runs without one. */
const faults = args.faults ? args.faults.split(",") : [undefined];

const runKey = (j) => `${args.test}|${j.task}|${j.tool}|${args.model}|${j.fault ?? ""}|r${j.rep}`;
const records = () =>
	existsSync(recordsPath) ? readFileSync(recordsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const recordKey = (r) => `${r.test}|${r.task}|${r.tool}|${r.model}|${r.fault?.kind ?? ""}|r${r.rep}`;

if (counted) {
	const { lockDifferences } = await import("../scripts/lock-tasks.mjs");
	const differences = lockDifferences(taskIds(), args["tasks-dir"]);
	if (differences.length) {
		for (const d of differences) console.error(`${d.id}: ${d.what}`);
		throw new Error(`test ${args.test} is counted and its tasks do not match their lock; nothing was run`);
	}
}

const jobs = [];
for (let rep = 1; rep <= Number(args.reps); rep++)
	for (const task of taskIds()) for (const fault of faults) for (const tool of tools) jobs.push({ task, tool, rep, fault });

const done = new Set(records().map(recordKey));
const pending = jobs.filter((j) => !done.has(runKey(j)));
const stageSpent = () => records().filter((r) => r.test === args.test).reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0);
const e2bSpent = () =>
	records().reduce((s, r) => s + ((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000) * E2B_USD_PER_SECOND, 0);

console.log(
	`stage ${args.test}: ${jobs.length} runs planned, ${jobs.length - pending.length} already done, ${pending.length} to go; ` +
		`spent $${stageSpent().toFixed(2)} of $${stageCap}; sandboxes about $${e2bSpent().toFixed(2)} of $${e2bCap} for the round`,
);
if (args["dry-run"]) {
	for (const j of pending.slice(0, 20)) console.log(`  would run ${runKey(j)}`);
	process.exit(0);
}

function runOne(job) {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[
				join(ROOT, "runner", "run-one.mjs"),
				"--task", job.task, "--tool", job.tool, "--model", args.model, "--rep", String(job.rep),
				"--cap-usd", String(capUsd), "--test", args.test, "--out", args.out, "--tasks-dir", args["tasks-dir"],
				...(job.fault ? ["--fault", job.fault] : []),
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let text = "";
		child.stdout.on("data", (c) => (text += c));
		child.stderr.on("data", (c) => (text += c));
		child.on("close", (code) => resolve({ code, text: text.replace(/(sk-ant-|e2b_)[A-Za-z0-9_-]{8,}/g, "$1[MASKED]") }));
	});
}

let inFlight = 0;
let stopped = "";
const queue = [...pending];
const workers = Array.from({ length: Number(args.concurrency) }, async () => {
	while (queue.length && !stopped) {
		if (stageSpent() + (inFlight + 1) * capUsd > stageCap) {
			// Runs in flight might each spend up to their cap. Wait for them before deciding: stop only when even one
			// more run alone could pass the stage cap.
			if (inFlight === 0) {
				stopped = `the next run could take the stage past its ${stageCap} cap`;
				break;
			}
			await new Promise((r) => setTimeout(r, 15_000));
			continue;
		}
		if (e2bSpent() > e2bCap) {
			stopped = `sandbox time passed the round's $${e2bCap} cap`;
			break;
		}
		const job = queue.shift();
		inFlight++;
		let result = await runOne(job);
		if (!records().some((r) => recordKey(r) === runKey(job))) {
			appendFileSync(join(out, "infra-failures.log"), `${new Date().toISOString()} ${runKey(job)} attempt 1\n${result.text.slice(-1500)}\n\n`);
			result = await runOne(job);
			if (!records().some((r) => recordKey(r) === runKey(job))) {
				appendFileSync(join(out, "infra-failures.log"), `${new Date().toISOString()} ${runKey(job)} attempt 2: dropped\n${result.text.slice(-1500)}\n\n`);
			}
		}
		inFlight--;
		const last = result.text.trim().split("\n").pop();
		console.log(`[${new Date().toISOString().slice(11, 19)}] ${last}  | stage $${stageSpent().toFixed(2)}`);
	}
});
await Promise.all(workers);
console.log(stopped ? `stopped: ${stopped}` : `stage ${args.test} finished: $${stageSpent().toFixed(2)} spent`);
