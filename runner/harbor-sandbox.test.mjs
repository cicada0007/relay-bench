// runner/harbor-bench.mjs: each trial's sandbox time capped and priced, the stage stopped before its sandboxes could
// pass their cap, and counted Codex trials held until a smoke showed Codex's traffic in the meter. Harbor here is a
// fake on disk that writes a trial's result.json; no key, sandbox or model is used.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { E2B_USD_PER_SECOND } from "../scripts/draft-spend.mjs";
import { codexSmoke, loadBenchmark, meteredWebsocketLines, pinnedCodexVersion, runStage, sandboxCost, sandboxPlan, trialRecord } from "./harbor-bench.mjs";
import { sizeFactor } from "./task-meta.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const quiet = () => {};

test("a trial's sandbox is priced at E2B's published price, scaled up for a task that asks for more", () => {
	assert.equal(sizeFactor(null), 1);
	assert.equal(sizeFactor({ cpus: 1, memoryMb: 2048 }), 1, "a smaller task keeps the 2 vCPU, 4 GiB price: never less than E2B bills");
	assert.equal(sizeFactor({ cpus: 4, memoryMb: 8192 }), 2);
	assert.equal(sizeFactor({ cpus: 1, memoryMb: 16384 }), 4);
	const small = sandboxPlan({ benchmark: "terminal-bench-2-1", task: "terminal-bench/fix-git", trialCapUsd: 0.25 });
	assert.equal(small.factor, 1);
	assert.equal(small.usdPerSecond, E2B_USD_PER_SECOND);
	assert.equal(small.seconds, Math.floor(0.25 / E2B_USD_PER_SECOND));
	const large = sandboxPlan({ benchmark: "terminal-bench-2-1", task: "terminal-bench/caffe-cifar-10", trialCapUsd: 0.25 });
	assert.equal(large.factor, 2, "4 vCPU and 8 GiB, from the task's own metadata");
	assert.ok(large.seconds <= small.seconds / 2 + 1);
	const swe = sandboxPlan({ benchmark: "swebench-verified", task: "swe-bench/astropy__astropy-12907", trialCapUsd: 0.25 });
	assert.equal(swe.factor, 1, "a task without metadata is priced at the round's size");
	assert.deepEqual(sandboxCost(10_000, E2B_USD_PER_SECOND), { seconds: 10, usd: 10 * E2B_USD_PER_SECOND });
});

test("a trial stopped at its sandbox cap is the tool's limit once the tool started, and ours before that", () => {
	const bench = loadBenchmark("swebench-verified");
	const job = { test: "swebench-verified-claude-haiku-5-5", task: "swe-bench/astropy__astropy-12907", tool: "relay", model: "claude-haiku-5-5", rep: 1 };
	const sandbox = { seconds: 5400, usd: 0.2484, factor: 1, capUsd: 0.25 };
	const started = { trial_name: "t", exception_info: { exception_type: "CancelledError" }, agent_execution: { started_at: "2026-10-24T10:00:00Z" }, agent_result: { metadata: { meter: { costUsd: 0.3, refusedAtCap: 0 } } } };
	const capped = trialRecord({ bench, job, jobName: "j", code: 130, text: "", started: "s", result: started, capUsd: 1, sandbox, stoppedAtSandboxCap: true });
	assert.equal(capped.stoppedAtSandboxCap, true);
	assert.equal(capped.infra, false, "the same limit for every tool, as the spend cap is");
	assert.equal(capped.solved, false);
	assert.deepEqual(capped.sandbox, sandbox);
	assert.equal(capped.usage.costUsd, 0.3);
	const early = trialRecord({ bench, job, jobName: "j", code: 130, text: "", started: "s", result: { trial_name: "t", exception_info: { exception_type: "CancelledError" } }, capUsd: 1, sandbox, stoppedAtSandboxCap: true });
	assert.equal(early.infra, true, "the sandbox ran out before the tool started: ours, run again once");
	const plain = trialRecord({ bench, job, jobName: "j", code: 0, text: "", started: "s", result: { ...started, exception_info: null, verifier_result: { rewards: { reward: 1 } } }, capUsd: 1, sandbox });
	assert.equal(plain.stoppedAtSandboxCap, false);
	assert.equal(plain.solved, true);
});

/** A stage folder with one Codex trial and its meter log. */
function smokeStage(root, { test = "dev-swebench-openai", version = "0.163.0", lines = [], infra = false, tool = "codex" } = {}) {
	const stage = join(root, test);
	const trial = join(stage, "jobs", "job1", "trial1", "agent");
	mkdirSync(trial, { recursive: true });
	writeFileSync(join(trial, "meter.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
	writeFileSync(join(stage, "records.jsonl"), `${JSON.stringify({ test, tool, task: "swe-bench/astropy__astropy-12907", jobName: "job1", trialName: "trial1", infra, agent: { name: "codex", version } })}\n`);
	return stage;
}

test("the Codex smoke counts only a dev trial of the pinned Codex whose meter saw WebSocket traffic with a cost", () => {
	assert.equal(pinnedCodexVersion(), "0.163.0");
	const metered = { transport: "websocket", provider: "openai", status: 200, costUsd: 0.001 };
	assert.equal(meteredWebsocketLines(`${JSON.stringify(metered)}\n{"transport":"websocket","status":429}\nnot json\n{"transport":"http","costUsd":1}`), 1);
	const empty = mkdtempSync(join(tmpdir(), "smoke-none-"));
	assert.deepEqual([codexSmoke({ dirs: [empty, join(empty, "missing")] }).ok, codexSmoke({ dirs: [empty] }).why], [false, "no Codex smoke trial was found"]);
	const http = mkdtempSync(join(tmpdir(), "smoke-http-"));
	smokeStage(http, { lines: [{ transport: "http", costUsd: 0.01 }, { transport: "websocket", status: 0, error: "refused" }] });
	assert.match(codexSmoke({ dirs: [http] }).why, /no WebSocket line with a cost/);
	const old = mkdtempSync(join(tmpdir(), "smoke-old-"));
	smokeStage(old, { version: "0.150.0", lines: [metered] });
	assert.match(codexSmoke({ dirs: [old] }).why, /Codex 0\.150\.0, not the pinned 0\.163\.0/);
	const lost = mkdtempSync(join(tmpdir(), "smoke-lost-"));
	smokeStage(lost, { infra: true, lines: [metered] });
	smokeStage(lost, { test: "swebench-verified-gpt-6-luna", lines: [metered] });
	assert.equal(codexSmoke({ dirs: [lost] }).ok, false, "an infrastructure failure and a counted trial are not the smoke");
	const good = mkdtempSync(join(tmpdir(), "smoke-good-"));
	const stage = smokeStage(good, { lines: [metered, metered] });
	const found = codexSmoke({ dirs: [good] });
	assert.equal(found.ok, true);
	assert.deepEqual([found.found.stage, found.found.lines, found.found.version], [stage, 2, "0.163.0"]);
	assert.equal(codexSmoke({ dirs: [stage] }).ok, true, "a stage folder itself may be named");
});

test("a counted Codex stage refuses to start before the smoke, and says so on a free dry run", async () => {
	const none = mkdtempSync(join(tmpdir(), "smoke-empty-"));
	const args = { bench: "swebench-verified", tools: "relay,codex", model: "gpt-6-luna", trials: "1", "cap-usd": "1", "stage-cap-usd": "5", "e2b-cap-usd": "2", out: `runs/test-codex-${process.pid}`, concurrency: "1", "codex-smoke": [none], sample: "2" };
	const lines = [];
	const plan = await runStage({ ...args, "dry-run": true }, { log: (l) => lines.push(l), smokeDirs: [none] });
	assert.equal(plan.codex.ok, false);
	assert.ok(lines.some((l) => /Codex's counted trials wait: no Codex smoke trial was found\. Run the one-trial smoke first/.test(l)));
	await assert.rejects(runStage(args, { log: quiet, smokeDirs: [none], harbor: "/nonexistent/harbor" }), /Codex's traffic has not been seen by the meter/);
	const good = mkdtempSync(join(tmpdir(), "smoke-ok-"));
	smokeStage(good, { lines: [{ transport: "websocket", costUsd: 0.002 }] });
	const ready = await runStage({ ...args, "dry-run": true }, { log: (l) => lines.push(l), smokeDirs: [good] });
	assert.equal(ready.codex.ok, true);
	assert.ok(lines.some((l) => /Codex's traffic reached the meter in the smoke: 1 metered WebSocket lines/.test(l)));
	const dev = await runStage({ ...args, test: "dev-codex", tasks: "astropy__astropy-12907", sample: undefined, "dry-run": true }, { log: quiet, smokeDirs: [none] });
	assert.equal(dev.codex, null, "a dev stage is the smoke: it needs none");
	const anthropic = await runStage({ ...args, tools: "relay,claude-code", model: "claude-haiku-5-5", "dry-run": true }, { log: quiet, smokeDirs: [none] });
	assert.equal(anthropic.codex, null);
	await assert.rejects(runStage({ ...args, "e2b-cap-usd": undefined, tools: "relay,claude-code", model: "claude-haiku-5-5" }, { log: quiet }), /--e2b-cap-usd is required/);
});

/**
 * A fake Harbor: `--version` prints the pin; `run` writes the trial's result.json as Harbor does, by what `plan`
 * (task name -> "solve" | "fail" | "hang" | "hang-hard") says. A hanging trial stops on SIGINT, writing a cancelled
 * result as Harbor does when it stops a trial's sandbox; "hang-hard" ignores it.
 */
function fakeHarbor(plan) {
	const dir = mkdtempSync(join(tmpdir(), "fake-harbor-"));
	writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
	const bin = join(dir, "harbor");
	writeFileSync(
		bin,
		`#!${process.execPath}
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("0.24.0"); process.exit(0); }
const at = (f) => argv[argv.indexOf(f) + 1];
const plan = JSON.parse(readFileSync(join(__dirname, "plan.json"), "utf8"));
const task = at("-i");
const mode = plan[task] ?? "solve";
const trial = join(at("-o"), at("--job-name"), "trial");
mkdirSync(join(trial, "agent"), { recursive: true });
const started = new Date().toISOString();
const write = (extra) => writeFileSync(join(trial, "result.json"), JSON.stringify({ trial_name: "trial", started_at: started, finished_at: new Date().toISOString(), agent_info: { name: "x", version: "1" }, agent_result: { metadata: { meter: { costUsd: 0.01, input: 1, output: 1, refusedAtCap: 0 } } }, ...extra }));
if (mode === "solve" || mode === "fail") {
	write({ agent_execution: { started_at: started, finished_at: new Date().toISOString() }, verifier_result: { rewards: { reward: mode === "solve" ? 1 : 0 } } });
	process.exit(0);
}
process.on("SIGINT", () => {
	if (mode === "hang-hard") return;
	write({ agent_execution: { started_at: started }, exception_info: { exception_type: "CancelledError" } });
	process.exit(130);
});
setInterval(() => {}, 1000);
`,
	);
	chmodSync(bin, 0o755);
	return bin;
}

const withKeys = async (fn) => {
	const keep = { a: process.env.RELAY_BENCH_ANTHROPIC_KEY, e: process.env.E2B_API_KEY };
	process.env.RELAY_BENCH_ANTHROPIC_KEY = "not-a-real-key";
	process.env.E2B_API_KEY = "not-a-real-key";
	try {
		return await fn();
	} finally {
		for (const [name, value] of [["RELAY_BENCH_ANTHROPIC_KEY", keep.a], ["E2B_API_KEY", keep.e]]) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
};
const readJsonl = (path) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("a trial is stopped at its sandbox cap and recorded with its sandbox cost beside its model cost", async () => {
	const out = `runs/test-harbor-sandbox-${process.pid}`;
	const tasks = loadBenchmark("terminal-bench-2-1").tasks.slice(0, 2).map((t) => t.name);
	const harbor = fakeHarbor({ [tasks[0]]: "solve", [tasks[1]]: "hang" });
	try {
		await withKeys(() =>
			runStage(
				{ bench: "terminal-bench-2-1", test: "dev-sandbox", tasks: tasks.join(","), tools: "relay", model: "claude-haiku-5-5", trials: "1", "cap-usd": "1", "stage-cap-usd": "5", "e2b-cap-usd": "1", "e2b-trial-cap-usd": "0.0001", out, concurrency: "2" },
				{ harbor, log: quiet, hardStopMs: 10_000 },
			),
		);
		const stage = join(ROOT, out, "dev-sandbox");
		const records = new Map(readJsonl(join(stage, "records.jsonl")).map((r) => [r.task, r]));
		const solved = records.get(tasks[0]);
		assert.equal(solved.solved, true);
		assert.equal(solved.stoppedAtSandboxCap, false);
		assert.ok(solved.sandbox.usd > 0 && solved.sandbox.usd < 0.0001);
		assert.equal(solved.sandbox.capUsd, 0.0001);
		const capped = records.get(tasks[1]);
		assert.equal(capped.stoppedAtSandboxCap, true, "stopped at 2 seconds, what $0.0001 buys");
		assert.equal(capped.infra, false);
		assert.equal(capped.exception, "CancelledError");
		assert.ok(capped.sandbox.seconds >= 2 && capped.sandbox.seconds < 10, `${capped.sandbox.seconds}`);
		assert.ok(Math.abs(capped.sandbox.usd - capped.sandbox.seconds * E2B_USD_PER_SECOND) < 1e-5);
		const spend = readJsonl(join(stage, "spend.jsonl"));
		assert.equal(spend.length, 2, "a trial stopped at its cap is not run again");
		for (const s of spend) assert.ok(typeof s.sandboxUsd === "number" && typeof s.sandboxSeconds === "number");
	} finally {
		rmSync(join(ROOT, out), { recursive: true, force: true });
	}
});

test("a stage stops before its sandboxes could pass their cap, and at once when Harbor does not stop a trial", async () => {
	const out = `runs/test-harbor-stage-${process.pid}`;
	const tasks = loadBenchmark("terminal-bench-2-1").tasks.slice(0, 4).map((t) => t.name);
	try {
		const lines = [];
		const harbor = fakeHarbor(Object.fromEntries(tasks.map((t) => [t, "hang"])));
		const result = await withKeys(() =>
			runStage(
				{ bench: "terminal-bench-2-1", test: "dev-stage-cap", tasks: tasks.join(","), tools: "relay", model: "claude-haiku-5-5", trials: "1", "cap-usd": "1", "stage-cap-usd": "5", "e2b-cap-usd": "0.00025", "e2b-trial-cap-usd": "0.0001", out, concurrency: "1" },
				{ harbor, log: (l) => lines.push(l), hardStopMs: 10_000 },
			),
		);
		assert.match(result.stopped, /the next trial could take the stage's sandboxes past their \$0\.00025 cap/);
		const records = readJsonl(join(ROOT, out, "dev-stage-cap", "records.jsonl"));
		assert.equal(records.length, 2, "two trials at their $0.0001 cap fit $0.00025; a third could pass it");
		assert.ok(records.reduce((s, r) => s + r.sandbox.usd, 0) <= 0.00025);
		assert.ok(lines.some((l) => /^stopped: /.test(l)));

		const hard = fakeHarbor(Object.fromEntries(tasks.map((t) => [t, "hang-hard"])));
		const killed = await withKeys(() =>
			runStage(
				{ bench: "terminal-bench-2-1", test: "dev-hard-stop", tasks: tasks.join(","), tools: "relay", model: "claude-haiku-5-5", trials: "1", "cap-usd": "1", "stage-cap-usd": "5", "e2b-cap-usd": "1", "e2b-trial-cap-usd": "0.0001", out, concurrency: "1" },
				{ harbor: hard, log: quiet, hardStopMs: 300 },
			),
		);
		assert.match(killed.stopped, /did not stop .* within \d+ seconds of its sandbox cap and was killed; its E2B sandbox may still be running/);
		assert.equal(readJsonl(join(ROOT, out, "dev-hard-stop", "records.jsonl")).length, 1, "nothing more starts");
	} finally {
		rmSync(join(ROOT, out), { recursive: true, force: true });
	}
});

test("the runner's own folders are not left behind by these tests", () => {
	assert.equal(existsSync(join(ROOT, `runs/test-harbor-sandbox-${process.pid}`)), false);
});
