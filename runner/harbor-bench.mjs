#!/usr/bin/env node
// The scoreboard's public benchmarks through Harbor, the benchmarks' official runner, with every task in an E2B sandbox:
// Terminal-Bench 2.1, SWE-bench Verified and SWE-bench Pro, each tool on the same model. It runs a stage the way
// runner/tb21.mjs ran test F, and writes records of the same shape, so the round's analysis, the meta-harness picker
// (meta/pick-groups.mjs) and the scoreboard (scripts/scoreboard.mjs) read every benchmark alike.
//
//   node runner/harbor-bench.mjs --bench swebench-verified --tools relay,claude-code --model claude-haiku-5-5 \
//     --trials 1 --cap-usd 1 --stage-cap-usd 60 --out runs/scoreboard --dry-run
//
// - Pinned: Harbor HARBOR_VERSION and each benchmark's dataset version, by digest (runner/<bench>-tasks.json lists its
//   tasks, written from Harbor's registry by harbor-agents/dataset_tasks.py). Relay, Claude Code, Codex and Node are
//   pinned in harbor-agents/relay_bench_agents.py, the Harbor agents.
// - Same model: every tool runs the one test model, from its provider. Claude Code runs only Anthropic models and Codex
//   only OpenAI models, so Codex is compared with Relay on an OpenAI model (runner/arms.mjs, the same rule as the bar).
// - Cost: every trial's model traffic goes through the round's meter inside the task container, which also stops a
//   trial at --cap-usd. A trial starts only while (spent + trials in flight x --cap-usd + --cap-usd) stays within
//   --stage-cap-usd; when even one more trial alone could pass it, the stage stops. Spend is the sum of every attempt's
//   metered cost (<out>/<test>/spend.jsonl), retries included; an attempt whose meter log was lost counts as its cap.
// - Resume: run the same command again; trials already in <out>/<test>/records.jsonl are skipped. --reclassify applies
//   the current classification to recorded trials first, as in runner/tb21.mjs.
// - A trial that ends without a grade because of our infrastructure is run again once and logged; if it fails again it
//   is recorded as an infrastructure failure, and the analysis drops that task for every tool (PREREGISTRATION.md,
//   "Runs that break"). The classification is runner/tb21.mjs's classifyTrial, unchanged.
// - Keys: Harbor reads the model key itself (`--ae ANTHROPIC_API_KEY=${RELAY_BENCH_ANTHROPIC_KEY}`, or
//   `--ae OPENAI_API_KEY=${RELAY_BENCH_OPENAI_KEY}` on an OpenAI model), so it never appears on a command line or in a
//   file, and runs with a clean environment that carries only that key and E2B_API_KEY.
// - --dry-run prints the plan and the most it could cost, and starts nothing.
//
// Not in Harbor's registry (checked 24 Oct 2026 with Harbor 0.24.0): an official Terminal-Bench 4.0. The terminal-bench
// organisation publishes terminal-bench, terminal-bench-2 and terminal-bench-2-1 only; the 4.0 copies there are a
// personal account's (ryanmarten/terminal-bench-4-no-prebuild, ryanmarten/tb4-preview), so none is listed here.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { providerOf } from "./arms.mjs";
import { sampleIds } from "./stage-tasks.mjs";
import { classifyTrial, HARBOR_VERSION } from "./tb21.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
export { HARBOR_VERSION };

/** The benchmarks this runner knows: each one's pinned task list, written from Harbor's registry. */
export const BENCHMARKS = Object.freeze({
	"terminal-bench-2-1": { title: "Terminal-Bench 2.1", tasksFile: "tb21-tasks.json", measure: "solved" },
	"swebench-verified": { title: "SWE-bench Verified", tasksFile: "swebench-verified-tasks.json", measure: "resolved" },
	"swebench-pro": { title: "SWE-bench Pro", tasksFile: "swebench-pro-tasks.json", measure: "resolved" },
});

/** Harbor agent import paths (harbor-agents/ on PYTHONPATH), and the providers each tool runs. */
export const AGENTS = Object.freeze({
	relay: { path: "relay_bench_agents:Relay", providers: ["anthropic", "openai"] },
	"claude-code": { path: "relay_bench_agents:BenchClaudeCode", providers: ["anthropic"] },
	codex: { path: "relay_bench_agents:BenchCodex", providers: ["openai"] },
});

/** Where each provider's key comes from (this shell) and the name it has inside a trial. */
export const PROVIDER_KEYS = Object.freeze({
	anthropic: { from: "RELAY_BENCH_ANTHROPIC_KEY", as: "ANTHROPIC_API_KEY" },
	openai: { from: "RELAY_BENCH_OPENAI_KEY", as: "OPENAI_API_KEY" },
});

/** A benchmark's pinned task list: { dataset, ref, revision, tasks: [{ name, ref }] }. */
export function loadBenchmark(id, root = ROOT) {
	const bench = BENCHMARKS[id];
	if (!bench) throw new Error(`unknown benchmark ${id}; known: ${Object.keys(BENCHMARKS).join(", ")}`);
	return { id, ...bench, ...JSON.parse(readFileSync(join(root, "runner", bench.tasksFile), "utf8")) };
}

/** The tools a stage may run on `model`: refuses a tool that does not run that model's provider. */
export function checkTools(tools, model) {
	const provider = providerOf(model);
	for (const tool of tools) {
		const agent = AGENTS[tool];
		if (!agent) throw new Error(`unknown tool ${tool}; known: ${Object.keys(AGENTS).join(", ")}`);
		if (!agent.providers.includes(provider)) throw new Error(`${tool} does not run ${provider} models such as ${model}`);
	}
	return provider;
}

/** A record's key, the same as runner/tb21.mjs's: test, task, tool, model, repetition. */
export const recordKey = (r) => `${r.test}|${r.task}|${r.tool}|${r.model}|r${r.rep}`;

/**
 * The stage's plan: every (repetition, task, tool) trial, repetition first so a stage cut short still compares the tools
 * on the same tasks; `pending` leaves out the trials already recorded. `tasks` are full names (`org/name`).
 */
export function planStage({ test, model, tasks, tools, trials, done = new Set() }) {
	const jobs = [];
	for (let rep = 1; rep <= trials; rep++) for (const task of tasks) for (const tool of tools) jobs.push({ test, task, tool, model, rep });
	const pending = jobs.filter((j) => !done.has(recordKey(j)));
	return { jobs, pending };
}

/**
 * The tasks a stage runs: the whole pinned set, a development list (`--tasks`, only under a test name starting with
 * "dev-"), or a fixed sample (`--sample n`: runner/stage-tasks.mjs's seeded draw, the one run-stage uses).
 */
export function chooseTasks(bench, { tasks, sample, test }) {
	const known = bench.tasks.map((t) => t.name);
	const org = known[0]?.split("/")[0];
	let chosen = known;
	if (tasks) {
		if (!test.startsWith("dev-")) throw new Error("--tasks is for development runs; give them a --test that starts with dev-");
		chosen = tasks.split(",").map((t) => (t.includes("/") ? t : `${org}/${t}`));
		for (const t of chosen) if (!known.includes(t)) throw new Error(`${t} is not in ${bench.dataset}@${bench.ref}`);
	}
	if (sample !== undefined) {
		const n = Number(sample);
		if (!Number.isInteger(n) || n < 1) throw new Error("--sample must be a whole number of tasks");
		chosen = sampleIds(chosen, n);
	}
	return chosen;
}

/** The arguments of one Harbor job: one task, one tool, one attempt, on the pinned dataset version. No key in them. */
export function harborArgv({ bench, job, provider, capUsd, jobsDir, jobName }) {
	const key = PROVIDER_KEYS[provider];
	return [
		"run",
		"-d", `${bench.dataset}@${bench.ref}`,
		"-i", job.task,
		"-a", AGENTS[job.tool].path,
		"-m", `${provider}/${job.model}`,
		"--ae", `${key.as}=\${${key.from}}`,
		"--ak", `cap_usd=${capUsd}`,
		"--env", "e2b",
		"-k", "1", "-n", "1",
		"-o", jobsDir,
		"--job-name", jobName,
		"-y", "-q",
	];
}

/** One trial's record from Harbor's result.json, in runner/tb21.mjs's shape, plus the benchmark's id. */
export function trialRecord({ bench, job, jobName, code, text, started, result, capUsd }) {
	const { meter, exception, reward, graded, stoppedAtCap, infra } = classifyTrial(result);
	const ms = (t) => (t?.started_at && t?.finished_at ? Date.parse(t.finished_at) - Date.parse(t.started_at) : null);
	return {
		test: job.test,
		benchmark: bench.id,
		task: job.task,
		tool: job.tool,
		model: job.model,
		rep: job.rep,
		jobName,
		trialName: result?.trial_name ?? null,
		harborExit: code,
		harborVersion: HARBOR_VERSION,
		dataset: `${bench.dataset}@${bench.ref}`,
		taskChecksum: result?.task_checksum ?? null,
		agent: result?.agent_info ?? null,
		reward: graded ? reward : null,
		solved: graded && reward === 1,
		exception,
		infra,
		stoppedAtCap,
		usage: meter
			? { costUsd: meter.costUsd, input: meter.input, output: meter.output, cacheRead: meter.cacheRead, cacheWrite: meter.cacheWrite, requests: meter.requests, models: meter.models, askedModels: meter.askedModels }
			: null,
		toolReported: result?.agent_result?.metadata?.toolReported ?? null,
		capUsd,
		wallMs: ms(result?.agent_execution),
		setupMs: ms(result?.agent_setup),
		startedAt: result?.started_at ?? started,
		finishedAt: result?.finished_at ?? new Date().toISOString(),
		tail: infra ? text.slice(-1500) : undefined,
	};
}

const mask = (s) => String(s).replace(/(sk-ant-|sk-proj-|sk-|e2b_)[A-Za-z0-9_-]{4,}/g, "$1[MASKED]");
const readJsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

function harborEnv(provider) {
	const key = PROVIDER_KEYS[provider].from;
	for (const name of [key, "E2B_API_KEY"]) if (!process.env[name]) throw new Error(`${name} is not set`);
	return {
		PATH: `${join(homedir(), ".local", "bin")}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
		HOME: homedir(),
		...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
		LANG: "en_US.UTF-8",
		PYTHONPATH: join(ROOT, "harbor-agents"),
		[key]: process.env[key],
		E2B_API_KEY: process.env.E2B_API_KEY,
	};
}

/** Re-applies classifyTrial to every recorded trial; a trial it now classes as ours is moved out of records.jsonl. */
function reclassify({ stageDir, jobsDir, recordsPath, dryRun }) {
	const keep = [];
	const moved = [];
	for (const r of readJsonl(recordsPath)) {
		const resultPath = r.trialName ? join(jobsDir, r.jobName, r.trialName, "result.json") : null;
		const result = resultPath && existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : undefined;
		if (!r.infra && result && classifyTrial(result).infra) moved.push(r);
		else keep.push(r);
	}
	for (const r of moved) console.log(`reclassify: ${r.task} ${r.tool} r${r.rep} (${r.exception}) is an infrastructure failure; running it again`);
	if (dryRun || moved.length === 0) return;
	const at = new Date().toISOString();
	const reason = "reclassified: no grade and the tool never started (Harbor agent_execution empty)";
	appendFileSync(join(stageDir, "superseded.jsonl"), moved.map((r) => `${JSON.stringify({ ...r, supersededAt: at, reason })}\n`).join(""));
	for (const r of moved) appendFileSync(join(stageDir, "infra-failures.log"), `${at} ${recordKey(r)} attempt 1 (${r.exception}; ${reason})\n\n`);
	writeFileSync(recordsPath, keep.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

export async function runStage(args) {
	const bench = loadBenchmark(args.bench);
	const tools = args.tools.split(",");
	const provider = checkTools(tools, args.model);
	const test = args.test ?? bench.id;
	const capUsd = Number(args["cap-usd"]);
	const stageCap = Number(args["stage-cap-usd"]);
	if (!(capUsd > 0) || !(stageCap > 0)) throw new Error("--cap-usd and --stage-cap-usd must be amounts above 0");

	const stageDir = join(ROOT, args.out, test);
	const jobsDir = join(stageDir, "jobs");
	const recordsPath = join(stageDir, "records.jsonl");
	const spendPath = join(stageDir, "spend.jsonl");
	const samplePath = join(stageDir, "sample.json");
	const saved = args.sample && existsSync(samplePath) ? JSON.parse(readFileSync(samplePath, "utf8")) : null;
	const tasks = saved ? saved.tasks : chooseTasks(bench, { tasks: args.tasks, sample: args.sample, test });
	if (saved && saved.tasks.length !== Number(args.sample)) throw new Error(`the saved sample ${samplePath} has ${saved.tasks.length} tasks, not ${args.sample}`);
	if (args.reclassify) reclassify({ stageDir, jobsDir, recordsPath, dryRun: args["dry-run"] });
	const retried = new Set(readJsonl(join(stageDir, "superseded.jsonl")).map(recordKey));
	const done = new Set(readJsonl(recordsPath).map(recordKey));
	const { jobs, pending } = planStage({ test, model: args.model, tasks, tools, trials: Number(args.trials), done });
	const spent = () => readJsonl(spendPath).reduce((s, a) => s + a.chargedUsd, 0);
	const mostUsd = Math.min(stageCap, spent() + pending.length * 2 * capUsd);

	console.log(
		`${test}: ${bench.title}, ${bench.dataset}@${bench.ref.slice(0, 19)}…, ${tasks.length} tasks × ${tools.join(", ")} × ${args.trials} trials on ${args.model} = ` +
			`${jobs.length} trials, ${jobs.length - pending.length} done, ${pending.length} to go; spent $${spent().toFixed(4)} of $${stageCap}; ` +
			`at most $${mostUsd.toFixed(2)} in all (each trial at most $${capUsd}, a retry included)`,
	);
	if (args["dry-run"]) {
		for (const j of pending.slice(0, 20)) console.log(`  would run ${recordKey(j)}`);
		if (pending.length > 20) console.log(`  … and ${pending.length - 20} more`);
		return { bench, tasks, jobs, pending, mostUsd };
	}

	const env = harborEnv(provider);
	const version = spawnSync("harbor", ["--version"], { env, encoding: "utf8" });
	if (version.stdout?.trim() !== HARBOR_VERSION) {
		throw new Error(`Harbor ${HARBOR_VERSION} is pinned; found ${version.stdout?.trim() || version.stderr?.trim() || "none"}. ` +
			`Install it with: uv tool install 'harbor[e2b]==${HARBOR_VERSION}'`);
	}
	mkdirSync(jobsDir, { recursive: true });
	if (args.sample && !saved) writeFileSync(samplePath, `${JSON.stringify({ test, tasks, from: bench.tasks.length, seed: 20261015, at: new Date().toISOString() }, null, 2)}\n`);

	const short = (task) => task.split("/").pop().slice(0, 60);
	function attempt(job, n) {
		const jobName = `${test}-${short(job.task)}-${job.tool}-r${job.rep}-a${n}-${Date.now().toString(36)}`;
		const argv = harborArgv({ bench, job, provider, capUsd, jobsDir, jobName });
		return new Promise((resolve) => {
			const started = new Date().toISOString();
			const child = spawn("harbor", argv, { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
			let text = "";
			child.stdout.on("data", (c) => (text += c));
			child.stderr.on("data", (c) => (text += c));
			child.on("close", (code) => {
				const jobDir = join(jobsDir, jobName);
				const trialDir = existsSync(jobDir) ? readdirSync(jobDir).map((d) => join(jobDir, d)).find((d) => existsSync(join(d, "result.json"))) : undefined;
				const result = trialDir ? JSON.parse(readFileSync(join(trialDir, "result.json"), "utf8")) : undefined;
				resolve(trialRecord({ bench, job, jobName, code, text: mask(text), started, result, capUsd }));
			});
		});
	}

	const warmed = new Set(readJsonl(recordsPath).map((r) => r.task));
	const inFlightTasks = new Map();
	let inFlight = 0;
	let stopped = "";
	const queue = [...pending];
	const pickJob = () => {
		// A task's first trial builds its sandbox template; let it finish before a second trial of that task starts.
		const i = queue.findIndex((j) => warmed.has(j.task) || !inFlightTasks.get(j.task));
		return i === -1 ? undefined : queue.splice(i, 1)[0];
	};
	const workers = Array.from({ length: Number(args.concurrency) }, async () => {
		while (queue.length && !stopped) {
			if (spent() + (inFlight + 1) * capUsd > stageCap) {
				if (inFlight === 0) {
					stopped = `the next trial could take the stage past its $${stageCap} cap`;
					break;
				}
				await new Promise((r) => setTimeout(r, 15_000));
				continue;
			}
			const job = pickJob();
			if (!job) {
				await new Promise((r) => setTimeout(r, 5_000));
				continue;
			}
			inFlight++;
			inFlightTasks.set(job.task, (inFlightTasks.get(job.task) ?? 0) + 1);
			let record;
			for (let n = retried.has(recordKey(job)) ? 2 : 1; n <= 2; n++) {
				record = await attempt(job, n);
				appendFileSync(spendPath, `${JSON.stringify({ key: recordKey(job), jobName: record.jobName, metered: record.usage !== null, chargedUsd: record.usage ? record.usage.costUsd : capUsd })}\n`);
				if (!record.infra) break;
				appendFileSync(join(stageDir, "infra-failures.log"), `${new Date().toISOString()} ${recordKey(job)} attempt ${n} (${record.exception ?? "no result"})\n${record.tail ?? ""}\n\n`);
			}
			appendFileSync(recordsPath, `${JSON.stringify(record)}\n`);
			warmed.add(job.task);
			inFlightTasks.set(job.task, inFlightTasks.get(job.task) - 1);
			inFlight--;
			const cost = record.usage ? `$${record.usage.costUsd.toFixed(4)}` : "cost unknown";
			const outcome = record.infra ? `infrastructure failure (${record.exception ?? "no result"})` : record.solved ? "solved" : `not solved${record.exception ? ` (${record.exception})` : ""}`;
			console.log(`[${new Date().toISOString().slice(11, 19)}] ${recordKey(job)}: ${outcome}, ${cost} | stage $${spent().toFixed(4)}`);
		}
	});
	await Promise.all(workers);
	console.log(stopped ? `stopped: ${stopped}` : `${test} finished: $${spent().toFixed(4)} spent`);
	return { bench, tasks, jobs, pending };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values: args } = parseArgs({
		options: {
			bench: { type: "string" },
			tools: { type: "string", default: "relay,claude-code" },
			trials: { type: "string", default: "1" },
			model: { type: "string", default: "claude-haiku-5-5" },
			"stage-cap-usd": { type: "string" },
			"cap-usd": { type: "string", default: "1" },
			concurrency: { type: "string", default: "4" },
			out: { type: "string", default: "runs/scoreboard" },
			// The stage's name; its records go in <out>/<test>/. Defaults to the benchmark's id.
			test: { type: "string" },
			// Development only: a comma list of task names (with or without the dataset's org) in place of the full set.
			tasks: { type: "string" },
			// A fixed sample of n tasks (seeded 20261015), saved as <out>/<test>/sample.json on the first paid run.
			sample: { type: "string" },
			"dry-run": { type: "boolean", default: false },
			reclassify: { type: "boolean", default: false },
		},
	});
	if (!args.bench) throw new Error(`--bench is required: ${Object.keys(BENCHMARKS).join(", ")}`);
	if (!args["stage-cap-usd"]) throw new Error("--stage-cap-usd is required");
	await runStage(args);
}
