#!/usr/bin/env node
// One benchmark run: one tool, one task, one model, one repetition. Works the task in a fresh sandbox through the
// meter, collects what the tool left, then grades it with the hidden judge in a second fresh sandbox the tool never saw.
// Appends one record to <out>/records.jsonl and keeps the run's logs, metered usage and patch under <out>/<run-id>/.
//
//   RELAY_BENCH_ANTHROPIC_KEY=... E2B_API_KEY=... node runner/run-one.mjs \
//     --task py-ledger --tool claude-code --model claude-haiku-5-5 --rep 1 --cap-usd 1 --test pilot --out runs/round-1
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { Sandbox } from "e2b";
import { PINS, RUN_PATH, TEMPLATE_NAME } from "../sandbox/template.mjs";
import { ARMS, REQUEST, saidDone, WORK } from "./arms.mjs";

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
	},
});
for (const name of ["task", "tool", "model", "cap-usd"]) {
	if (!args[name]) throw new Error(`--${name} is required`);
}
const arm = ARMS[args.tool];
if (!arm) throw new Error(`unknown tool ${args.tool}; known: ${Object.keys(ARMS).join(", ")}`);
const key = process.env.RELAY_BENCH_ANTHROPIC_KEY;
if (!key) throw new Error("RELAY_BENCH_ANTHROPIC_KEY is not set");

const taskDir = join(args["tasks-dir"], args.task);
const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
const request = readFileSync(join(taskDir, "request.md"), "utf8");
const runId = `${args.test}-${args.task}-${args.tool}-${args.model}-r${args.rep}-${randomBytes(3).toString("hex")}`;
const out = join(ROOT, args.out);
const runDir = join(out, runId);
mkdirSync(runDir, { recursive: true });

// macOS tar adds AppleDouble "._*" files for extended attributes; in the Linux sandbox they look like broken test files
// (the first large pilot's R0 failed on judge-r0/._*.test.js for every tool). COPYFILE_DISABLE stops them; the
// exclude also drops any already on disk.
const tar = (dir) =>
	execFileSync("tar", ["-czf", "-", "--exclude", ".DS_Store", "--exclude", "._*", "--exclude", "node_modules", "-C", dir, "."], {
		maxBuffer: 256 * 1024 * 1024,
		env: { ...process.env, COPYFILE_DISABLE: "1" },
	});
const sha = (data) => createHash("sha256").update(data).digest("hex");
const BASE_ENV = { DO_NOT_TRACK: "1", PATH: RUN_PATH, HOME: "/home/user", TERM: "dumb", CI: "1" };
/** Where each runtime looks for trusted certificates; with the run's authority added (sandbox/meter-intercept.sh), every
 *  tool reaches the meter at api.anthropic.com as if it were the provider. Node reads NODE_EXTRA_CA_CERTS; Python's
 *  ssl, httpx and requests read the system bundle through these two. */
const TRUST_ENV = {
	NODE_EXTRA_CA_CERTS: "/usr/local/share/ca-certificates/relay-bench-meter.crt",
	SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
	REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
};
const METER_DIR = "/var/lib/relay-bench";

async function sh(sandbox, command, options = {}) {
	try {
		// Sandbox commands run in a login shell, which resets PATH from the system profile, so set it in the command.
		const r = await sandbox.commands.run(`export PATH=${RUN_PATH}; ${command}`, { envs: BASE_ENV, ...options });
		return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
	} catch (error) {
		// A non-zero exit is thrown as a CommandExitError carrying the result; a timeout carries no exit code.
		return { exitCode: error.exitCode ?? null, stdout: error.stdout ?? "", stderr: error.stderr || String(error.message ?? error), error: error.name };
	}
}

const record = {
	runId,
	test: args.test,
	task: args.task,
	taskKind: task.kind,
	tool: args.tool,
	model: args.model,
	rep: Number(args.rep),
	capUsd: Number(args["cap-usd"]),
	limitMinutes: task.timeLimitMinutes,
	pins: PINS,
	template: TEMPLATE_NAME,
	startedAt: new Date().toISOString(),
};

const repoTar = tar(join(taskDir, "repo"));
record.repoSha256 = sha(repoTar);
record.requestSha256 = sha(request);

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
	const setup = await sh(
		work,
		`mkdir -p ${WORK} && tar -xzf /home/user/repo.tgz -C ${WORK} && cd ${WORK} && ` +
			"git config --global user.name 'Benchmark' && git config --global user.email 'bench@example.com' && " +
			"git config --global init.defaultBranch main && git init -q && git add -A && git commit -q -m start",
	);
	if (setup.exitCode !== 0) throw new Error(`setup failed: ${setup.stderr.slice(-400)}`);
	for (const [path, content] of Object.entries(arm.files({ model: args.model }))) await work.files.write(path, content);

	// The meter runs as root at api.anthropic.com inside this sandbox, so no tool's endpoint setting changes, and its
	// log sits in a root-owned folder the tool can read but not rewrite.
	const intercept = await sh(work, "sh /opt/relay-bench/meter-intercept.sh", { user: "root" });
	if (intercept.exitCode !== 0) throw new Error(`the meter's certificate setup failed: ${intercept.stderr.slice(-400)}`);
	const meterLog = `${METER_DIR}/meter.jsonl`;
	await work.commands.run(
		`export PATH=${RUN_PATH}; node /opt/relay-bench/meter.mjs --port 443 --tls-cert /root/meter-tls/meter.crt ` +
			`--tls-key /root/meter-tls/meter.key --upstream https://api.anthropic.com --resolve-upstream-by-dns ` +
			`--plain-port 8787 --log ${meterLog} --cap-usd ${args["cap-usd"]} > ${METER_DIR}/meter.out 2>&1`,
		{ background: true, envs: BASE_ENV, user: "root" },
	);
	// Checked the way the tools will see it: as the sandbox user, by name, through the hosts file and the run's certificate.
	const up = await sh(
		work,
		`for i in $(seq 1 50); do curl -s -o /dev/null https://api.anthropic.com/ && exit 0; sleep 0.1; done; cat ${METER_DIR}/meter.out; exit 1`,
	);
	if (up.exitCode !== 0) throw new Error(`the meter did not start: ${up.stdout.slice(-400)}`);
	record.meterMode = "intercept";

	const command = arm.command({ model: args.model, gates: task.gates, limitMinutes: task.timeLimitMinutes, capUsd: args["cap-usd"] });
	record.command = command;
	const toolStarted = Date.now();
	const run = await sh(work, command, {
		cwd: WORK,
		timeoutMs: task.timeLimitMinutes * 60_000,
		envs: { ...BASE_ENV, ...TRUST_ENV, ...arm.env({ model: args.model }), ANTHROPIC_API_KEY: key },
	});
	record.wallMs = Date.now() - toolStarted;
	record.exitCode = run.exitCode;
	record.timedOut = run.exitCode === null && /timeout|deadline/i.test(`${run.error} ${run.stderr}`);
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
		input: priced.reduce((s, l) => s + l.input, 0),
		output: priced.reduce((s, l) => s + l.output, 0),
		cacheRead: priced.reduce((s, l) => s + l.cacheRead, 0),
		cacheWrite: priced.reduce((s, l) => s + l.cacheWrite, 0),
		costUsd: priced.reduce((s, l) => s + l.costUsd, 0),
		modelsSeen: [...new Set(lines.map((l) => l.model).filter(Boolean))],
		effortsAsked: [...new Set(lines.map((l) => l.effort ?? l.thinking).filter(Boolean))],
		unpricedModels: [...new Set(lines.filter((l) => l.model && l.costUsd === undefined).map((l) => l.model))],
	};
} finally {
	await work.kill().catch(() => {});
}

// The judge works on a clean copy, in a sandbox the tool never saw.
const judgeBox = await Sandbox.create(TEMPLATE_NAME, { timeoutMs: 30 * 60_000, metadata: { relayBench: `${runId}-judge` } });
record.judgeSandbox = judgeBox.sandboxId;
try {
	await judgeBox.files.write("/home/user/result.tgz", resultTar);
	const judgeTar = tar(join(taskDir, "judge"));
	record.judgeSha256 = sha(judgeTar);
	await judgeBox.files.write("/home/user/judge.tgz", judgeTar);
	const prep = await sh(
		judgeBox,
		"mkdir -p /home/user/checkout /home/user/judge && tar -xzf /home/user/result.tgz -C /home/user/checkout && " +
			"tar -xzf /home/user/judge.tgz -C /home/user/judge && cd /home/user/checkout && " +
			"git config --global user.name judge && git config --global user.email judge@example.com && " +
			"git init -q -b main && git add -A && git commit -q -m result",
	);
	if (prep.exitCode !== 0) throw new Error(`judge setup failed: ${prep.stderr.slice(-400)}`);
	const judged = await sh(judgeBox, "node /home/user/judge/judge.mjs /home/user/checkout", { timeoutMs: 15 * 60_000 });
	const line = judged.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
	try {
		record.judge = JSON.parse(line);
	} catch {
		record.judge = { error: "judge printed no JSON", stderr: judged.stderr.slice(-600) };
	}
} finally {
	await judgeBox.kill().catch(() => {});
}

const reqs = record.judge?.requirements ?? {};
const met = task.requirements.filter((r) => reqs[r] === true && record.judge?.R0 === true).length;
record.score = { requirementsMet: met, requirements: task.requirements.length, share: met / task.requirements.length, R0: record.judge?.R0 === true };
// Secondary measure: the share of the judge's individual checks passed, counted only when R0 holds, like the parts.
const checks = Object.values(record.judge?.checks ?? {}).filter((c) => Array.isArray(c) && c.length === 2);
if (checks.length) {
	const total = checks.reduce((s, c) => s + c[1], 0);
	const passed = record.score.R0 ? checks.reduce((s, c) => s + c[0], 0) : 0;
	record.score.checks = { passed, total, share: total ? passed / total : 0 };
}
record.saidDoneButFailed = record.saidDone === true && met < task.requirements.length;
record.finishedAt = new Date().toISOString();
appendFileSync(join(out, "records.jsonl"), `${JSON.stringify(record)}\n`);
writeFileSync(join(runDir, "record.json"), JSON.stringify(record, null, 2));
console.log(
	`${runId}: ${met}/${task.requirements.length} met, said done ${record.saidDone}, ` +
		`$${record.usage?.costUsd?.toFixed(4)}, ${Math.round((record.wallMs ?? 0) / 1000)}s, models ${record.usage?.modelsSeen?.join("+")}`,
);
