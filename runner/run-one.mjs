#!/usr/bin/env node
// One benchmark run: one tool, one task, one model, one repetition. Works the task in a fresh sandbox through the
// meter, collects what the tool left, then grades it with the hidden judge in a second fresh sandbox the tool never saw.
// Appends one record to <out>/records.jsonl and keeps the run's logs, metered usage, patch and graded tree under
// <out>/<run-id>/.
//
//   node runner/run-one.mjs \
//     --task py-mini-sql --tool claude-code --model claude-haiku-5-5 --rep 1 --cap-usd 1 --test pilot --out runs/round-1
//
// Keys come from the environment, for the model's provider only: RELAY_BENCH_ANTHROPIC_KEY for a Claude model,
// RELAY_BENCH_OPENAI_KEY for an OpenAI one (Codex, and Relay on the same OpenAI model), and E2B_API_KEY.
//
// Test D (PREREGISTRATION.md) adds --fault kill|network|errors. Every tool then runs inside the same restart loop
// (sandbox/restart-loop.sh), which runs the tool's own documented resume command when it stops without succeeding, up
// to 3 times. "network" and "errors" are injected by the meter; "kill" kills the tool's process group once, as root,
// --fault-after-sec after the run's first model request. Network and error faults last --fault-for-sec.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { Sandbox } from "e2b";
import { PINS, RUN_PATH, TEMPLATE_NAME } from "../sandbox/template.mjs";
import { ARMS, armFor, armRuns, providerOf, REQUEST, relayInstallCommand, saidDone, toolInstallCommand, WORK } from "./arms.mjs";
import { unpricedProblems } from "./meter-price.mjs";
import { BASE_ENV, judgeResult, scoreOf, sh, sha, tar, taskHashes } from "./judge.mjs";
import { detectFlags } from "./safety.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const { values: args } = parseArgs({
	options: {
		task: { type: "string" },
		tool: { type: "string" },
		model: { type: "string" },
		rep: { type: "string", default: "1" },
		"cap-usd": { type: "string" },
		test: { type: "string", default: "dev" },
		out: { type: "string", default: "runs/dev" },
		"tasks-dir": { type: "string", default: join(ROOT, "tasks") },
		fault: { type: "string" },
		"fault-after-sec": { type: "string", default: "120" },
		"fault-for-sec": { type: "string", default: "600" },
		// Pilot and dev runs only: install this local Relay package over the pinned one, to try a fix before it ships.
		"relay-package": { type: "string" },
		// Relay with its meta-harness on (RELAY_META=1): for runs that judge a change to the router (GATE.md, amendment 5).
		"relay-meta": { type: "boolean", default: false },
	},
});
for (const name of ["task", "tool", "model", "cap-usd"]) {
	if (!args[name]) throw new Error(`--${name} is required`);
}
const resolved = armFor(args.tool);
if (!resolved) throw new Error(`unknown tool ${args.tool}; known: ${Object.keys(ARMS).join(", ")}, relay@<version>, relay@pkg, claude-code@<version>, codex@<version>`);
const { arm } = resolved;
if (resolved.relayPackage && !args["relay-package"]) throw new Error("relay@pkg needs --relay-package");
if (args.fault && !["kill", "network", "errors"].includes(args.fault)) throw new Error(`unknown --fault ${args.fault}`);
// A counted run takes a package only for a local build the gate judges (GATE.md, amendment 4), never for relay@pkg.
if (args["relay-package"] && !resolved.localBuild && !/^(pilot|dev)/.test(args.test)) throw new Error("--relay-package is for pilot and dev runs only, or a local build's gate");
const provider = providerOf(args.model);
if (!armRuns(arm, args.model)) throw new Error(`${args.tool} does not run ${provider} models such as ${args.model}`);
// A model arm (model watch): its model gets the run's one key, so it is of the same provider, and the meter must price
// it, or the run's spend cap would not bind.
if (resolved.override) {
	if (providerOf(resolved.override.model) !== provider) throw new Error(`${args.tool} runs ${resolved.override.model}, not an ${provider} model like ${args.model}`);
	const unpriced = unpricedProblems([resolved.override.model]);
	if (unpriced.length) throw new Error(unpriced[0]);
}
const KEY_ENV = { anthropic: "RELAY_BENCH_ANTHROPIC_KEY", openai: "RELAY_BENCH_OPENAI_KEY" };
const key = process.env[KEY_ENV[provider]];
if (!key) throw new Error(`${KEY_ENV[provider]} is not set`);
/** The one key a run gets, under the names its tools read: Codex reads CODEX_API_KEY for `codex exec`. */
const keyEnv = provider === "openai" ? { OPENAI_API_KEY: key, CODEX_API_KEY: key } : { ANTHROPIC_API_KEY: key };

const taskDir = join(args["tasks-dir"], args.task);
const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
const request = readFileSync(join(taskDir, "request.md"), "utf8");
const faultTag = args.fault ? `-${args.fault}` : "";
const runId = `${args.test}-${args.task}-${args.tool}-${args.model}${faultTag}-r${args.rep}-${randomBytes(3).toString("hex")}`;
// Relative to this repository, or absolute: the exam's runs live outside it.
const out = resolve(ROOT, args.out);
const runDir = join(out, runId);
mkdirSync(runDir, { recursive: true });

/** Where each runtime looks for trusted certificates; with the run's authority added (sandbox/meter-intercept.sh), every
 *  tool reaches the meter at api.anthropic.com as if it were the provider. Node reads NODE_EXTRA_CA_CERTS; Python's
 *  ssl, httpx and requests read the system bundle through these two. */
const TRUST_ENV = {
	NODE_EXTRA_CA_CERTS: "/usr/local/share/ca-certificates/relay-bench-meter.crt",
	SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
	REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
};
const METER_DIR = "/var/lib/relay-bench";
const RESTART_LOOP = "/opt/relay-bench/restart-loop.sh";
const TOOL_PGID = "/home/user/tool.pgid";

const record = {
	runId,
	test: args.test,
	task: args.task,
	taskKind: task.kind,
	tool: args.tool,
	model: args.model,
	provider,
	// Model watch: the model this arm put on its tier, or on every tier.
	...(resolved.override ? { override: resolved.override } : {}),
	rep: Number(args.rep),
	capUsd: Number(args["cap-usd"]),
	limitMinutes: task.timeLimitMinutes,
	pins: PINS,
	template: TEMPLATE_NAME,
	...(args.fault ? { fault: { kind: args.fault, afterSec: Number(args["fault-after-sec"]), forSec: Number(args["fault-for-sec"]) } } : {}),
	...(args["relay-meta"] && arm === ARMS.relay ? { relayMeta: true } : {}),
	startedAt: new Date().toISOString(),
};

const repoTar = tar(join(taskDir, "repo"));
record.repoSha256 = sha(repoTar);
record.requestSha256 = sha(request);
// Content fingerprints, comparable with TASKS.lock.json: proof the run used the locked task.
record.taskHashes = taskHashes(taskDir);

/** How many files the starting repository has, to spot a patch that deletes most of it. */
function countFiles(dir) {
	let n = 0;
	for (const name of readdirSync(dir)) {
		if (name === ".git" || name === "node_modules") continue;
		n += statSync(join(dir, name)).isDirectory() ? countFiles(join(dir, name)) : 1;
	}
	return n;
}

/** A path that asks a model for tokens, as the meter counts them (meter/meter.mjs, isModelPath). */
const MODEL_PATH = /\/(messages|responses(\/compact)?|chat\/completions)$/;

/** The first model request in the meter's log, in epoch ms, once there is one. */
async function firstModelRequestAt(sandbox, meterLog) {
	const text = await sandbox.files.read(meterLog).catch(() => "");
	for (const line of text.split("\n")) {
		if (!line) continue;
		const entry = JSON.parse(line);
		if (MODEL_PATH.test(entry.path?.split("?")[0] ?? "")) return Date.parse(entry.ts) - (entry.ms ?? 0);
	}
	return undefined;
}

/** Runs the tool, and for a kill fault kills its process group once, --fault-after-sec after its first model request. */
async function runTool(sandbox, command, options, meterLog) {
	if (args.fault !== "kill") return sh(sandbox, command, options);
	const handle = await sandbox.commands.run(`export PATH=${RUN_PATH}; ${command}`, { ...options, background: true });
	let killed = false;
	const watcher = (async () => {
		const deadline = Date.now() + options.timeoutMs;
		while (!killed && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 5_000));
			const first = await firstModelRequestAt(sandbox, meterLog);
			if (first !== undefined && Date.now() >= first + Number(args["fault-after-sec"]) * 1000) {
				const k = await sh(sandbox, `kill -KILL -- -$(cat ${TOOL_PGID})`, { user: "root" });
				record.faultInjectedAt = new Date().toISOString();
				record.faultInjected = k.exitCode === 0;
				killed = true;
			}
		}
	})();
	let result;
	try {
		const r = await handle.wait();
		result = { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
	} catch (error) {
		result = { exitCode: error.exitCode ?? null, stdout: error.stdout ?? "", stderr: error.stderr || String(error.message ?? error), error: error.name };
	}
	killed = true;
	await watcher;
	return result;
}

let resultTar;
const work = await Sandbox.create(TEMPLATE_NAME, { timeoutMs: (task.timeLimitMinutes + 30) * 60_000, metadata: { relayBench: runId } });
record.workSandbox = work.sandboxId;
try {
	await work.files.write("/home/user/repo.tgz", repoTar);
	await work.files.write(REQUEST, request);
	await work.files.write("/home/user/relay-merge.mjs", readFileSync(join(ROOT, "runner", "relay-merge.mjs"), "utf8"));
	// The meter is uploaded from this checkout on every run, so the image can never hold a stale copy.
	const meterSource = readFileSync(join(ROOT, "meter", "meter.mjs"), "utf8");
	record.meterSha256 = sha(meterSource);
	await work.files.write("/opt/relay-bench/meter.mjs", meterSource, { user: "root" });
	await work.files.write("/opt/relay-bench/meter-intercept.sh", readFileSync(join(ROOT, "sandbox", "meter-intercept.sh"), "utf8"), { user: "root" });
	if (args.fault) await work.files.write(RESTART_LOOP, readFileSync(join(ROOT, "sandbox", "restart-loop.sh"), "utf8"), { user: "root" });
	const setup = await sh(
		work,
		`mkdir -p ${WORK} && tar -xzf /home/user/repo.tgz -C ${WORK} && cd ${WORK} && ` +
			"git config --global user.name 'Benchmark' && git config --global user.email 'bench@example.com' && " +
			"git config --global init.defaultBranch main && git init -q && git add -A && git commit -q -m start",
	);
	if (setup.exitCode !== 0) throw new Error(`setup failed: ${setup.stderr.slice(-400)}`);
	for (const [path, content] of Object.entries(arm.files({ model: args.model, override: resolved.override }))) await work.files.write(path, content);
	if (args["relay-package"]) {
		const pkg = readFileSync(args["relay-package"]);
		record.relayPackageSha256 = sha(pkg);
		await work.files.write("/home/user/relay-test.tgz", pkg);
		const installed = await sh(
			work,
			"npm install -g --prefix /home/user/.relay/npm-global --no-fund --no-audit --loglevel=error /home/user/relay-test.tgz && relay --version 2>&1",
		);
		if (installed.exitCode !== 0) throw new Error(`installing the Relay package failed: ${installed.stderr.slice(-400)}`);
		record.relayPackageVersion = installed.stdout.trim().split("\n").pop();
		// A local build is judged by its version: the package must be the build its name gives.
		if (resolved.localBuild && !record.relayPackageVersion.includes(resolved.localBuild)) {
			throw new Error(`the Relay package printed ${record.relayPackageVersion}, not the local build ${resolved.localBuild}`);
		}
	}
	// A gate arm (GATE.md): this run's Relay is the released version its name gives, installed by Relay's own installer.
	if (resolved.relayVersion) {
		const installed = await sh(work, relayInstallCommand(resolved.relayVersion));
		const printed = installed.stdout.trim().split("\n").pop() ?? "";
		if (installed.exitCode !== 0 || !printed.includes(resolved.relayVersion)) {
			throw new Error(`installing Relay ${resolved.relayVersion} failed: ${(installed.stderr || printed).slice(-400)}`);
		}
		record.relayVersion = printed;
	}
	// A harness at a published version other than the image's pin (harness watch): installed over the image's own,
	// where sandbox/template.mjs put it (npm's global folder, as root), and checked by what it prints.
	if (resolved.toolVersion) {
		const installed = await sh(work, toolInstallCommand(resolved.base, resolved.toolVersion), { user: "root" });
		const printed = installed.stdout.trim().split("\n").pop() ?? "";
		if (installed.exitCode !== 0 || !printed.includes(resolved.toolVersion)) {
			throw new Error(`installing ${resolved.base} ${resolved.toolVersion} failed: ${(installed.stderr || printed).slice(-400)}`);
		}
		record.toolVersion = printed;
	}

	// The meter runs as root at api.anthropic.com and api.openai.com inside this sandbox, so no tool's endpoint setting
	// changes, and its log sits in a root-owned folder the tool can read but not rewrite.
	const intercept = await sh(work, "sh /opt/relay-bench/meter-intercept.sh", { user: "root" });
	if (intercept.exitCode !== 0) throw new Error(`the meter's certificate setup failed: ${intercept.stderr.slice(-400)}`);
	const meterLog = `${METER_DIR}/meter.jsonl`;
	const meterFault =
		args.fault === "network" || args.fault === "errors"
			? ` --fault ${args.fault} --fault-after-sec ${args["fault-after-sec"]} --fault-for-sec ${args["fault-for-sec"]}`
			: "";
	await work.commands.run(
		`export PATH=${RUN_PATH}; node /opt/relay-bench/meter.mjs --port 443 --tls-cert /root/meter-tls/meter.crt ` +
			`--tls-key /root/meter-tls/meter.key --upstream https://api.anthropic.com --openai-upstream https://api.openai.com ` +
			`--resolve-upstream-by-dns ` +
			`--plain-port 8787 --log ${meterLog} --cap-usd ${args["cap-usd"]}${meterFault} > ${METER_DIR}/meter.out 2>&1`,
		{ background: true, envs: BASE_ENV, user: "root" },
	);
	// Checked the way the tools will see it: as the sandbox user, by name, through the hosts file and the run's certificate.
	const host = provider === "openai" ? "api.openai.com" : "api.anthropic.com";
	const up = await sh(
		work,
		`for i in $(seq 1 50); do curl -s -o /dev/null https://${host}/ && exit 0; sleep 0.1; done; cat ${METER_DIR}/meter.out; exit 1`,
	);
	if (up.exitCode !== 0) throw new Error(`the meter did not start: ${up.stdout.slice(-400)}`);
	record.meterMode = "intercept";

	const settings = { model: args.model, gates: task.gates, limitMinutes: task.timeLimitMinutes, capUsd: args["cap-usd"] };
	const toolCommand = arm.command(settings);
	record.command = toolCommand;
	let command = toolCommand;
	if (args.fault) {
		const resume = arm.resume(settings);
		record.resumeCommand = resume;
		const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
		command = `sh ${RESTART_LOOP} ${q(toolCommand)} ${q(resume)} ${TOOL_PGID}`;
	}
	const toolStarted = Date.now();
	const run = await runTool(
		work,
		command,
		{
			cwd: WORK,
			timeoutMs: task.timeLimitMinutes * 60_000,
			envs: { ...BASE_ENV, ...TRUST_ENV, ...arm.env({ model: args.model, meta: args["relay-meta"] }), ...keyEnv },
		},
		meterLog,
	);
	record.wallMs = Date.now() - toolStarted;
	record.exitCode = run.exitCode;
	record.timedOut = run.exitCode === null && /timeout|deadline/i.test(`${run.error} ${run.stderr}`);
	if (args.fault) record.restarts = (run.stderr.match(/^restart-loop: restart \d+/gm) ?? []).length;
	writeFileSync(join(runDir, "tool.stdout.gz"), gzipSync(run.stdout));
	writeFileSync(join(runDir, "tool.stderr.gz"), gzipSync(run.stderr));

	let resultDir = WORK;
	if (arm.result === "relay-merge") {
		const merge = await sh(work, `node /home/user/relay-merge.mjs ${WORK} /home/user/result`);
		record.relayMerge = JSON.parse(merge.stdout.trim().split("\n").pop() || "{}");
		resultDir = "/home/user/result";
		const reports = await sh(work, "tar -czf /home/user/relay-state.tgz -C /home/user/.relay/agent supervisor 2>/dev/null; echo done");
		if (reports.exitCode === 0) {
			const state = await work.files.read("/home/user/relay-state.tgz", { format: "bytes" }).catch(() => undefined);
			if (state) writeFileSync(join(runDir, "relay-state.tgz"), Buffer.from(state));
		}
	}
	record.saidDone = saidDone(args.tool, { exitCode: run.exitCode, stdout: run.stdout, relayMerge: record.relayMerge });

	const patch = await sh(work, `cd ${resultDir} && git add -A && git diff --cached --binary $(git rev-list --max-parents=0 HEAD)`);
	writeFileSync(join(runDir, "result.patch.gz"), gzipSync(patch.stdout));
	// Safety flags (GATE.md, amendment 1): any flag on a candidate's run blocks its release. The run's own key is checked
	// for, and never written anywhere: a flag carries only a masked sign of it.
	record.safetyFlags = detectFlags({ stdout: run.stdout, stderr: run.stderr, patch: patch.stdout, secrets: [key], repoFiles: countFiles(join(taskDir, "repo")) });
	await sh(work, `tar -czf /home/user/result.tgz --exclude=.git --exclude=node_modules -C ${resultDir} .`);
	resultTar = Buffer.from(await work.files.read("/home/user/result.tgz", { format: "bytes" }));
	record.resultSha256 = sha(resultTar);
	// The exact tree the judge grades, kept so any later judge fix can re-grade every tool's run the same way
	// (runner/rejudge.mjs).
	writeFileSync(join(runDir, "result.tgz"), resultTar);

	const meter = await work.files.read(meterLog).catch(() => "");
	writeFileSync(join(runDir, "meter.jsonl"), meter);
	const lines = meter.split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const priced = lines.filter((l) => l.costUsd !== undefined);
	record.usage = {
		requests: priced.length,
		refusedAtCap: lines.filter((l) => l.refused === "spend_cap_reached").length,
		...(args.fault ? { faulted: lines.filter((l) => l.fault).length } : {}),
		input: priced.reduce((s, l) => s + l.input, 0),
		output: priced.reduce((s, l) => s + l.output, 0),
		cacheRead: priced.reduce((s, l) => s + l.cacheRead, 0),
		cacheWrite: priced.reduce((s, l) => s + l.cacheWrite, 0),
		...(provider === "openai" ? { reasoning: priced.reduce((s, l) => s + (l.reasoning ?? 0), 0), webSocketResponses: priced.filter((l) => l.transport === "websocket").length } : {}),
		costUsd: priced.reduce((s, l) => s + l.costUsd, 0),
		modelsSeen: [...new Set(lines.map((l) => l.model).filter(Boolean))],
		effortsAsked: [...new Set(lines.map((l) => l.effort ?? l.thinking).filter(Boolean))],
		unpricedModels: [...new Set(lines.filter((l) => l.model && l.costUsd === undefined).map((l) => l.model))],
	};
} finally {
	await work.kill().catch(() => {});
}

// The judge works on a clean copy, in a sandbox the tool never saw.
const graded = await judgeResult(resultTar, taskDir, runId);
Object.assign(record, graded);
const { score, saidDoneButFailed } = scoreOf(task, record.judge, record.saidDone);
record.score = score;
record.saidDoneButFailed = saidDoneButFailed;
record.finishedAt = new Date().toISOString();
appendFileSync(join(out, "records.jsonl"), `${JSON.stringify(record)}\n`);
writeFileSync(join(runDir, "record.json"), JSON.stringify(record, null, 2));
console.log(
	`${runId}: ${score.requirementsMet}/${task.requirements.length} met, said done ${record.saidDone}, ` +
		`$${record.usage?.costUsd?.toFixed(4)}, ${Math.round((record.wallMs ?? 0) / 1000)}s, models ${record.usage?.modelsSeen?.join("+")}`,
);
