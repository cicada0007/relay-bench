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
//
// --sample <n> runs a fixed sample of n of the chosen tasks (a shuffle seeded 20261015). The sample is saved as
// <out>/<test>.tasks.json on the first real run, and a resumed stage reads it back, so it never changes mid-stage.
//
// --relay-package <tgz> gives the tool relay@pkg a Relay build that is not released (a pre-screen, GATE.md): only that
// tool's runs get it, and only in a test whose name starts with dev or pilot. A local build the gate judges
// (relay@0.6.122-loop.2026w44, GATE.md amendment 4) gets it in a counted test too, and is the only tool that may.
//
// --relay-meta runs every Relay arm with its meta-harness on (RELAY_META=1), the same for every Relay arm of the stage:
// for the runs that judge a change to a value that acts only with it on, such as the router's (GATE.md, amendment 5).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { armFor, armRuns, providerOf } from "./arms.mjs";
import { budgetProblems, exposurePathFor, loadBudget, readExposures, recordExposure, SEALED } from "./exposure.mjs";
import { unpricedProblems } from "./meter-price.mjs";
import { readTasks, sampleIds, sealedProblems, selectTasks } from "./stage-tasks.mjs";

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
		sample: { type: "string" },
		"relay-package": { type: "string" },
		"relay-meta": { type: "boolean", default: false },
	},
});
for (const name of ["test", "model", "cap-usd", "stage-cap-usd"]) if (!args[name]) throw new Error(`--${name} is required`);
// A counted test runs only on locked tasks (scripts/lock-tasks.mjs); pilots and dev runs may use tasks still in work.
const counted = !/^(pilot|dev)/.test(args.test);

/** E2B, 2 vCPU + 4 GiB, checked 15 Oct 2026 at e2b.dev/pricing: $0.000046 per second. */
const E2B_USD_PER_SECOND = 0.000046;
// Relative to this repository, or absolute: the exam's runs live outside it.
const out = resolve(ROOT, args.out);
const recordsPath = join(out, "records.jsonl");
const tools = args.tools.split(",");
// Every tool must run this model's provider; otherwise each of its runs would fail as if our infrastructure had.
for (const tool of tools) {
	const resolved = armFor(tool);
	if (!resolved) throw new Error(`unknown tool ${tool}`);
	if (!armRuns(resolved.arm, args.model)) throw new Error(`${tool} does not run ${providerOf(args.model)} models such as ${args.model}; nothing was run`);
}
// A model arm (model watch) runs its own model: of the stage's provider, since a run gets one key, and priced by the
// meter, since the meter is every run's spend cap and counts an unpriced model as free.
{
	const overrides = tools.map((tool) => armFor(tool).override?.model).filter(Boolean);
	for (const model of overrides) {
		if (providerOf(model) !== providerOf(args.model)) throw new Error(`a model arm's ${model} is not an ${providerOf(args.model)} model like ${args.model}; nothing was run`);
	}
	const problems = overrides.length ? unpricedProblems([...new Set([args.model, ...overrides])]) : [];
	if (problems.length) throw new Error(`${problems.join("; ")}; nothing was run`);
}
// An unreleased build is pre-screened only, never counted (GATE.md, "Released versions only, for a counted gate"),
// except a local build the gate judges by its package's hash (amendment 4).
const packaged = tools.filter((tool) => armFor(tool).relayPackage);
const localBuilds = tools.filter((tool) => armFor(tool).localBuild);
if (packaged.length && !args["relay-package"]) throw new Error(`${packaged[0]} needs --relay-package <tgz>; nothing was run`);
if (packaged.length > 1) throw new Error(`one package per stage, and ${packaged.join(" and ")} would share it; nothing was run`);
if (args["relay-package"] && counted && !localBuilds.length) throw new Error(`--relay-package is for dev and pilot tests only, or a local build's gate, not ${args.test}; nothing was run`);
if (args["relay-package"] && !existsSync(resolve(args["relay-package"]))) throw new Error(`no Relay package at ${args["relay-package"]}; nothing was run`);
const capUsd = Number(args["cap-usd"]);
const stageCap = Number(args["stage-cap-usd"]);
const e2bCap = Number(args["e2b-cap-usd"]);

/** --tasks: a comma list of task ids and kind:<kind> or tier:<tier> selectors (kind:long,tier:exam), in that order;
 *  with --sample, the stage's saved sample of them. */
const samplePath = join(out, `${args.test}.tasks.json`);
const chosen = selectTasks(args.tasks, args["tasks-dir"]);
let sampled;
if (args.sample) {
	const n = Number(args.sample);
	if (!Number.isInteger(n) || n < 1) throw new Error("--sample must be a whole number of tasks");
	sampled = existsSync(samplePath) ? JSON.parse(readFileSync(samplePath, "utf8")).tasks : sampleIds(chosen, n);
	const strays = sampled.filter((id) => !chosen.includes(id));
	if (strays.length) throw new Error(`the saved sample ${samplePath} holds tasks --tasks no longer chooses: ${strays.join(", ")}`);
	if (sampled.length < Math.min(n, chosen.length)) throw new Error(`the saved sample has ${sampled.length} tasks, not ${n}`);
}
const taskIds = () => sampled ?? chosen;
// The exam and check tiers stay sealed (TIERS.md): their tasks come from, and their runs go to, folders outside this
// public repository. This holds for every test, counted or not.
{
	const problems = sealedProblems({ ids: taskIds(), tasksDir: args["tasks-dir"], out });
	if (problems.length) throw new Error(`${problems.join("; ")}; nothing was run`);
}
mkdirSync(out, { recursive: true });
if (sampled && !args["dry-run"] && !existsSync(samplePath)) {
	writeFileSync(samplePath, `${JSON.stringify({ test: args.test, tasks: sampled, from: chosen.length, seed: 20261015, at: new Date().toISOString() }, null, 2)}\n`);
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
		throw new Error(`test ${args.test} is counted and its tasks do not match their lock or are not approved; nothing was run`);
	}
}

const jobs = [];
for (let rep = 1; rep <= Number(args.reps); rep++)
	for (const task of taskIds()) for (const fault of faults) for (const tool of tools) jobs.push({ task, tool, rep, fault });

const done = new Set(records().map(recordKey));
const pending = jobs.filter((j) => !done.has(runKey(j)));

// The leak budget (runner/exposure.mjs): every run of an exam or check task shows it to a tool, so each is counted
// beside the exam before it starts, and a stage that would pass any task's budget runs nothing.
const tierOf = new Map([...readTasks(args["tasks-dir"])].map(([id, t]) => [id, t.tier]));
const exposurePath = exposurePathFor(args["tasks-dir"]);
const budget = loadBudget(args["tasks-dir"]);
const isSealedJob = (j) => SEALED.includes(tierOf.get(j.task));
const exposureOf = (j) => ({ kind: "run", tier: tierOf.get(j.task), tasks: [j.task], test: args.test, tool: j.tool, by: "run-stage" });
{
	const problems = budgetProblems({ entries: readExposures(exposurePath), add: pending.filter(isSealedJob).map(exposureOf), budget });
	if (problems.length) {
		for (const p of problems.slice(0, 20)) console.error(p);
		throw new Error(`test ${args.test} would pass the leak budget of ${problems.length} exposure(s); nothing was run`);
	}
}
/** Counts one attempt at a sealed task, or refuses it when its budget is spent (a retry can need one more). */
function expose(job) {
	if (!isSealedJob(job)) return true;
	const problems = budgetProblems({ entries: readExposures(exposurePath), add: [exposureOf(job)], budget });
	if (problems.length) {
		appendFileSync(join(out, "infra-failures.log"), `${new Date().toISOString()} ${runKey(job)} not run: ${problems[0]}\n\n`);
		return false;
	}
	recordExposure(exposurePath, exposureOf(job));
	return true;
}
const stageSpent = () => records().filter((r) => r.test === args.test).reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0);
const e2bSpent = () =>
	records().reduce((s, r) => s + ((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000) * E2B_USD_PER_SECOND, 0);

console.log(
	`stage ${args.test}: ${jobs.length} runs planned, ${jobs.length - pending.length} already done, ${pending.length} to go; ` +
		`spent $${stageSpent().toFixed(2)} of $${stageCap}; sandboxes about $${e2bSpent().toFixed(2)} of $${e2bCap} for the round`,
);
if (args["relay-meta"]) console.log("every Relay arm runs with its meta-harness on (RELAY_META=1)");
if (args["dry-run"]) {
	for (const j of pending.slice(0, 20)) console.log(`  would run ${runKey(j)}`);
	process.exit(0);
}

function runOne(job) {
	// `done`, not `resolve`: the arguments below use path's `resolve`, which a parameter of that name would hide.
	return new Promise((done) => {
		const child = spawn(
			process.execPath,
			[
				join(ROOT, "runner", "run-one.mjs"),
				"--task", job.task, "--tool", job.tool, "--model", args.model, "--rep", String(job.rep),
				"--cap-usd", String(capUsd), "--test", args.test, "--out", args.out, "--tasks-dir", args["tasks-dir"],
				...(job.fault ? ["--fault", job.fault] : []),
				...(armFor(job.tool).relayPackage ? ["--relay-package", resolve(args["relay-package"])] : []),
				...(args["relay-meta"] ? ["--relay-meta"] : []),
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let text = "";
		child.stdout.on("data", (c) => (text += c));
		child.stderr.on("data", (c) => (text += c));
		child.on("error", (error) => done({ code: null, text: `could not start run-one: ${error.message}` }));
		child.on("close", (code) => done({ code, text: text.replace(/(sk-(?:ant-|proj-|svcacct-|admin-)?|e2b_)[A-Za-z0-9_-]{8,}/g, "$1[MASKED]") }));
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
		if (!expose(job)) continue;
		inFlight++;
		let result = await runOne(job);
		if (!records().some((r) => recordKey(r) === runKey(job)) && expose(job)) {
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
