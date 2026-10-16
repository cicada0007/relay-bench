#!/usr/bin/env node
// Test F (PREREGISTRATION.md): Terminal-Bench 2.1, the full public set, Relay against Claude Code on one model, through
// Harbor, the benchmark's official runner, with tasks in E2B sandboxes. Each trial is its own Harbor job (one task, one
// tool, one attempt), so this script decides when each one starts and can hold the stage to its cap.
//
//   node runner/tb21.mjs --tools relay,claude-code --trials 2 --model claude-haiku-5-5 --stage-cap-usd 45 --out runs/round-1
//
// - Pinned: Harbor HARBOR_VERSION and the dataset version DATASET_REF (runner/tb21-tasks.json lists its 89 tasks).
//   Relay and Claude Code versions are pinned in harbor-agents/relay_bench_agents.py, the two Harbor agents.
// - Cost: every trial's model traffic goes through the round's meter inside the task container (meter/meter.mjs, the
//   same for both tools), which also stops a trial at --cap-usd. The stage starts a trial only while
//   (spent + trials in flight x --cap-usd + --cap-usd) stays within --stage-cap-usd; when even one more trial alone could
//   pass it, it stops. Spend is the sum of every attempt's metered cost (<out>/F/spend.jsonl), retries included; an
//   attempt whose meter log was lost counts as its full cap.
// - Resume: run the same command again; trials already in <out>/F/records.jsonl are skipped.
// - A trial that ends without a grade because of our infrastructure (sandbox build, install, Harbor, or a provider
//   outage the tool could not ride out) is run again once and logged; if it fails again it is recorded as an
//   infrastructure failure, and the analysis drops that task for every tool (PREREGISTRATION.md, "Runs that break").
// - Keys: the model key is read from RELAY_BENCH_ANTHROPIC_KEY by Harbor itself (`--ae ANTHROPIC_API_KEY=${...}`), so it
//   never appears on a command line or in a file. Harbor runs with a clean environment, so nothing else from this
//   shell (such as an ANTHROPIC_BASE_URL) reaches a task container.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = new URL("..", import.meta.url).pathname;
export const HARBOR_VERSION = "0.24.0";
const TASKS = JSON.parse(readFileSync(join(ROOT, "runner", "tb21-tasks.json"), "utf8"));
export const DATASET = TASKS.dataset;
export const DATASET_REF = TASKS.ref;
/** Harbor agent import paths, from harbor-agents/ on PYTHONPATH. */
export const AGENTS = { relay: "relay_bench_agents:Relay", "claude-code": "relay_bench_agents:BenchClaudeCode" };

/** Agent exceptions that mean the provider or our setup failed, not the tool, unless the run was stopped at its cap. */
const PROVIDER_FAILURES = new Set([
	"ApiOverloadedError",
	"ApiInternalServerError",
	"ApiConnectionClosedError",
	"ApiRateLimitError",
	"ApiUsageLimitError",
	"NetworkConnectionError",
	"AgentAuthenticationError",
	"ModelNotFoundError",
]);

/** Endings that are the tool's own: it ran out of time, stopped with an error, or left the verifier hanging. */
const TOOL_ENDINGS = new Set([
	"AgentTimeoutError",
	"VerifierTimeoutError",
	"NonZeroAgentExitCodeError",
	"UnknownApiError",
	"ContextWindowExceededError",
	"OutputTokenExceededError",
	"AgentSafetyRefusalError",
	"ApiResponseStalledError",
]);

const mask = (s) => String(s).replace(/(sk-ant-|e2b_)[A-Za-z0-9_-]{4,}/g, "$1[MASKED]");

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values: args } = parseArgs({
		options: {
			tools: { type: "string", default: "relay,claude-code" },
			trials: { type: "string", default: "2" },
			model: { type: "string", default: "claude-haiku-5-5" },
			"stage-cap-usd": { type: "string" },
			"cap-usd": { type: "string", default: "1" },
			concurrency: { type: "string", default: "4" },
			out: { type: "string", default: "runs/round-1" },
			test: { type: "string", default: "F" },
			// Development only: a comma list of task names (with or without "terminal-bench/") in place of the full set.
			tasks: { type: "string" },
			"dry-run": { type: "boolean", default: false },
		},
	});
	if (!args["stage-cap-usd"]) throw new Error("--stage-cap-usd is required");
	for (const tool of args.tools.split(",")) if (!AGENTS[tool]) throw new Error(`unknown tool ${tool}; known: ${Object.keys(AGENTS).join(", ")}`);
	if (args.tasks && args.test === "F") throw new Error("--tasks is for development runs; give them a --test other than F");
	await runStage(args);
}

function harborEnv() {
	for (const name of ["RELAY_BENCH_ANTHROPIC_KEY", "E2B_API_KEY"]) if (!process.env[name]) throw new Error(`${name} is not set`);
	return {
		PATH: `${join(homedir(), ".local", "bin")}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
		HOME: homedir(),
		...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
		LANG: "en_US.UTF-8",
		PYTHONPATH: join(ROOT, "harbor-agents"),
		RELAY_BENCH_ANTHROPIC_KEY: process.env.RELAY_BENCH_ANTHROPIC_KEY,
		E2B_API_KEY: process.env.E2B_API_KEY,
	};
}

function readJsonl(path) {
	return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

async function runStage(args) {
	const env = harborEnv();
	const version = spawnSync("harbor", ["--version"], { env, encoding: "utf8" });
	if (version.stdout?.trim() !== HARBOR_VERSION) {
		throw new Error(`Harbor ${HARBOR_VERSION} is pinned; found ${version.stdout?.trim() || version.stderr?.trim() || "none"}. ` +
			`Install it with: uv tool install 'harbor[e2b]==${HARBOR_VERSION}'`);
	}

	const stageDir = join(ROOT, args.out, args.test);
	const jobsDir = join(stageDir, "jobs");
	mkdirSync(jobsDir, { recursive: true });
	const recordsPath = join(stageDir, "records.jsonl");
	const spendPath = join(stageDir, "spend.jsonl");
	const tools = args.tools.split(",");
	const capUsd = Number(args["cap-usd"]);
	const stageCap = Number(args["stage-cap-usd"]);
	const known = new Set(TASKS.tasks.map((t) => t.name));
	const tasks = args.tasks
		? args.tasks.split(",").map((t) => (t.includes("/") ? t : `terminal-bench/${t}`))
		: TASKS.tasks.map((t) => t.name);
	for (const t of tasks) if (!known.has(t)) throw new Error(`${t} is not in ${DATASET}@${DATASET_REF}`);

	const short = (task) => task.split("/").pop();
	const key = (j) => `${args.test}|${j.task}|${j.tool}|${args.model}|r${j.rep}`;
	const jobs = [];
	// Repetition, then task, then tool: a stage cut short still compares the tools on the same tasks.
	for (let rep = 1; rep <= Number(args.trials); rep++) for (const task of tasks) for (const tool of tools) jobs.push({ task, tool, rep });
	const done = new Set(readJsonl(recordsPath).map((r) => `${r.test}|${r.task}|${r.tool}|${r.model}|r${r.rep}`));
	const pending = jobs.filter((j) => !done.has(key(j)));
	const spent = () => readJsonl(spendPath).reduce((s, a) => s + a.chargedUsd, 0);

	console.log(
		`test ${args.test}: ${DATASET}@${DATASET_REF.slice(0, 19)}…, ${tasks.length} tasks × ${tools.join(", ")} × ${args.trials} trials = ` +
			`${jobs.length} trials, ${jobs.length - pending.length} done, ${pending.length} to go; spent $${spent().toFixed(4)} of $${stageCap}`,
	);
	if (args["dry-run"]) {
		for (const j of pending.slice(0, 20)) console.log(`  would run ${key(j)}`);
		return;
	}

	/** One Harbor job: one task, one tool, one attempt. Resolves with what that attempt left. */
	function attempt(job, n) {
		const jobName = `${args.test}-${short(job.task)}-${job.tool}-r${job.rep}-a${n}-${Date.now().toString(36)}`;
		const argv = [
			"run",
			"-d", `${DATASET}@${DATASET_REF}`,
			"-i", job.task,
			"-a", AGENTS[job.tool],
			"-m", `anthropic/${args.model}`,
			"--ae", "ANTHROPIC_API_KEY=${RELAY_BENCH_ANTHROPIC_KEY}",
			"--ak", `cap_usd=${capUsd}`,
			"--env", "e2b",
			"-k", "1", "-n", "1",
			"-o", jobsDir,
			"--job-name", jobName,
			"-y", "-q",
		];
		return new Promise((resolve) => {
			const started = new Date().toISOString();
			const child = spawn("harbor", argv, { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
			let text = "";
			child.stdout.on("data", (c) => (text += c));
			child.stderr.on("data", (c) => (text += c));
			child.on("close", (code) => resolve(readTrial({ job, jobName, code, text: mask(text), started })));
		});
	}

	function readTrial({ job, jobName, code, text, started }) {
		const jobDir = join(jobsDir, jobName);
		const trialDir = existsSync(jobDir)
			? readdirSync(jobDir).map((d) => join(jobDir, d)).find((d) => existsSync(join(d, "result.json")))
			: undefined;
		const result = trialDir ? JSON.parse(readFileSync(join(trialDir, "result.json"), "utf8")) : undefined;
		const meter = result?.agent_result?.metadata?.meter ?? null;
		const exception = result?.exception_info?.exception_type ?? null;
		const reward = result?.verifier_result?.rewards?.reward;
		const graded = typeof reward === "number";
		const stoppedAtCap = (meter?.refusedAtCap ?? 0) > 0;
		// Ours, not the tool's: no result at all; a provider failure the tool could not ride out (unless the trial
		// was stopped at its cap, which is the tool's limit); or no grade for any reason other than the tool's own.
		const infra =
			!result ||
			(PROVIDER_FAILURES.has(exception) && !stoppedAtCap && reward !== 1) ||
			(!graded && !stoppedAtCap && !TOOL_ENDINGS.has(exception));
		const ms = (t) => (t?.started_at && t?.finished_at ? Date.parse(t.finished_at) - Date.parse(t.started_at) : null);
		return {
			test: args.test,
			task: job.task,
			tool: job.tool,
			model: args.model,
			rep: job.rep,
			jobName,
			trialName: result?.trial_name ?? null,
			harborExit: code,
			harborVersion: HARBOR_VERSION,
			dataset: `${DATASET}@${DATASET_REF}`,
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
				// Trials in flight might each spend up to their cap; wait for them, and stop only when even one more trial
				// alone could pass the stage cap.
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
			for (let n = 1; n <= 2; n++) {
				record = await attempt(job, n);
				appendFileSync(spendPath, `${JSON.stringify({ key: key(job), jobName: record.jobName, metered: record.usage !== null, chargedUsd: record.usage ? record.usage.costUsd : capUsd })}\n`);
				if (!record.infra) break;
				appendFileSync(join(stageDir, "infra-failures.log"), `${new Date().toISOString()} ${key(job)} attempt ${n} (${record.exception ?? "no result"})\n${record.tail ?? ""}\n\n`);
			}
			appendFileSync(recordsPath, `${JSON.stringify(record)}\n`);
			warmed.add(job.task);
			inFlightTasks.set(job.task, inFlightTasks.get(job.task) - 1);
			inFlight--;
			const cost = record.usage ? `$${record.usage.costUsd.toFixed(4)}` : "cost unknown";
			const outcome = record.infra ? `infrastructure failure (${record.exception ?? "no result"})` : record.solved ? "solved" : `not solved${record.exception ? ` (${record.exception})` : ""}`;
			console.log(`[${new Date().toISOString().slice(11, 19)}] ${key(job)}: ${outcome}, ${cost} | stage $${spent().toFixed(4)}`);
		}
	});
	await Promise.all(workers);
	console.log(stopped ? `stopped: ${stopped}` : `test ${args.test} finished: $${spent().toFixed(4)} spent`);
}
