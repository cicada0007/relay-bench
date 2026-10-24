// runner/harbor-bench.mjs: the plan of a stage on SWE-bench Verified, SWE-bench Pro or Terminal-Bench 2.1, with no
// Harbor job started and no key needed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { AGENTS, BENCHMARKS, checkTools, chooseTasks, harborArgv, HARBOR_VERSION, loadBenchmark, planStage, recordKey, trialRecord } from "./harbor-bench.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

test("every benchmark is pinned to one dataset version by its digest, with its full task list", () => {
	const sizes = { "terminal-bench-2-1": 89, "swebench-verified": 500, "swebench-pro": 731 };
	for (const id of Object.keys(BENCHMARKS)) {
		const bench = loadBenchmark(id);
		assert.match(bench.ref, /^sha256:[0-9a-f]{64}$/, id);
		assert.equal(bench.tasks.length, sizes[id], id);
		for (const t of bench.tasks) assert.match(t.ref, /^sha256:[0-9a-f]{64}$/);
		assert.equal(new Set(bench.tasks.map((t) => t.name)).size, bench.tasks.length, `${id} lists a task twice`);
	}
	assert.equal(loadBenchmark("swebench-verified").dataset, "swe-bench/swe-bench-verified");
	assert.equal(loadBenchmark("swebench-pro").dataset, "scale-ai/swe-bench-pro");
	assert.throws(() => loadBenchmark("terminal-bench-4-0"), /unknown benchmark/);
});

test("a tool runs only its own provider's models: Codex on OpenAI, Claude Code on Anthropic, Relay on both", () => {
	assert.equal(checkTools(["relay", "claude-code"], "claude-haiku-5-5"), "anthropic");
	assert.equal(checkTools(["relay", "codex"], "gpt-6-luna"), "openai");
	assert.throws(() => checkTools(["codex"], "claude-haiku-5-5"), /codex does not run anthropic/);
	assert.throws(() => checkTools(["claude-code"], "gpt-6-luna"), /claude-code does not run openai/);
	assert.throws(() => checkTools(["hermes"], "claude-haiku-5-5"), /unknown tool hermes/);
	assert.deepEqual(Object.keys(AGENTS), ["relay", "claude-code", "codex"]);
});

test("the plan runs repetition first, then task, then tool, and skips what is recorded", () => {
	const plan = planStage({ test: "swebench-verified", model: "claude-haiku-5-5", tasks: ["swe-bench/a", "swe-bench/b"], tools: ["relay", "claude-code"], trials: 2 });
	assert.equal(plan.jobs.length, 8);
	assert.deepEqual(plan.jobs.slice(0, 4).map((j) => `${j.rep} ${j.task} ${j.tool}`), ["1 swe-bench/a relay", "1 swe-bench/a claude-code", "1 swe-bench/b relay", "1 swe-bench/b claude-code"]);
	const done = new Set([recordKey({ test: "swebench-verified", task: "swe-bench/a", tool: "relay", model: "claude-haiku-5-5", rep: 1 })]);
	const resumed = planStage({ test: "swebench-verified", model: "claude-haiku-5-5", tasks: ["swe-bench/a", "swe-bench/b"], tools: ["relay", "claude-code"], trials: 2, done });
	assert.equal(resumed.pending.length, 7);
	assert.ok(!resumed.pending.some((j) => j.task === "swe-bench/a" && j.tool === "relay" && j.rep === 1));
});

test("a development task list needs a dev- test name, and a sample is a fixed draw", () => {
	const bench = loadBenchmark("swebench-verified");
	assert.throws(() => chooseTasks(bench, { tasks: "astropy__astropy-12907", test: "swebench-verified" }), /development runs/);
	assert.deepEqual(chooseTasks(bench, { tasks: "astropy__astropy-12907", test: "dev-swe" }), ["swe-bench/astropy__astropy-12907"]);
	assert.throws(() => chooseTasks(bench, { tasks: "not-a-task", test: "dev-swe" }), /is not in swe-bench\/swe-bench-verified@sha256/);
	const a = chooseTasks(bench, { sample: "50", test: "swebench-verified" });
	assert.equal(a.length, 50);
	assert.deepEqual(a, chooseTasks(bench, { sample: "50", test: "swebench-verified" }));
	assert.throws(() => chooseTasks(bench, { sample: "0", test: "swebench-verified" }), /whole number/);
});

test("one Harbor job is pinned to the dataset digest, one task, one tool, the model's provider, and names the key only by reference", () => {
	const bench = loadBenchmark("swebench-pro");
	const job = { test: "swebench-pro", task: bench.tasks[0].name, tool: "codex", model: "gpt-6-luna", rep: 1 };
	const argv = harborArgv({ bench, job, provider: "openai", capUsd: 1, jobsDir: "/x/jobs", jobName: "j1" });
	const at = (flag) => argv[argv.indexOf(flag) + 1];
	assert.equal(at("-d"), `scale-ai/swe-bench-pro@${bench.ref}`);
	assert.equal(at("-i"), bench.tasks[0].name);
	assert.equal(at("-a"), "relay_bench_agents:BenchCodex");
	assert.equal(at("-m"), "openai/gpt-6-luna");
	assert.equal(at("--ae"), "OPENAI_API_KEY=${RELAY_BENCH_OPENAI_KEY}");
	assert.equal(at("--ak"), "cap_usd=1");
	assert.equal(at("--env"), "e2b");
	assert.deepEqual([at("-k"), at("-n")], ["1", "1"]);
	const anthropic = harborArgv({ bench, job: { ...job, tool: "relay", model: "claude-haiku-5-5" }, provider: "anthropic", capUsd: 0.5, jobsDir: "/x", jobName: "j2" });
	assert.equal(anthropic[anthropic.indexOf("--ae") + 1], "ANTHROPIC_API_KEY=${RELAY_BENCH_ANTHROPIC_KEY}");
	assert.equal(anthropic[anthropic.indexOf("-a") + 1], "relay_bench_agents:Relay");
});

test("a trial's record has test F's shape, and an infrastructure failure keeps its tail", () => {
	const bench = loadBenchmark("swebench-verified");
	const job = { test: "swebench-verified", task: "swe-bench/astropy__astropy-12907", tool: "relay", model: "claude-haiku-5-5", rep: 1 };
	const ran = { started_at: "2026-10-24T10:00:00Z", finished_at: "2026-10-24T10:06:00Z" };
	const result = { trial_name: "t1", agent_execution: ran, verifier_result: { rewards: { reward: 1 } }, agent_result: { metadata: { meter: { costUsd: 0.12, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, requests: 3, refusedAtCap: 0 } } } };
	const r = trialRecord({ bench, job, jobName: "j", code: 0, text: "", started: "2026-10-24T10:00:00Z", result, capUsd: 1 });
	for (const field of ["test", "task", "tool", "model", "rep", "jobName", "trialName", "harborVersion", "dataset", "reward", "solved", "exception", "infra", "stoppedAtCap", "usage", "capUsd", "wallMs", "startedAt", "finishedAt"]) assert.ok(field in r, field);
	assert.equal(r.solved, true);
	assert.equal(r.wallMs, 360_000);
	assert.equal(r.usage.costUsd, 0.12);
	assert.equal(r.harborVersion, HARBOR_VERSION);
	assert.equal(r.benchmark, "swebench-verified");
	const broken = trialRecord({ bench, job, jobName: "j", code: 1, text: "x".repeat(2000), started: "s", result: undefined, capUsd: 1 });
	assert.equal(broken.infra, true);
	assert.equal(broken.solved, false);
	assert.equal(broken.tail.length, 1500);
});

test("a dry run prints the plan and the most it could cost, with no key and no Harbor", () => {
	const env = { PATH: process.env.PATH, HOME: "/nonexistent" };
	const out = spawnSync(process.execPath, ["runner/harbor-bench.mjs", "--bench", "swebench-verified", "--tools", "relay,claude-code", "--model", "claude-haiku-5-5", "--sample", "10", "--cap-usd", "1", "--stage-cap-usd", "15", "--out", "runs/test-dry-run", "--dry-run"], { cwd: ROOT, env, encoding: "utf8" });
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stdout, /10 tasks × relay, claude-code × 1 trials on claude-haiku-5-5 = 20 trials, 0 done, 20 to go/);
	assert.match(out.stdout, /at most \$15\.00 in all/);
	assert.match(out.stdout, /would run swebench-verified\|swe-bench\//);
	const refused = spawnSync(process.execPath, ["runner/harbor-bench.mjs", "--bench", "swebench-pro", "--tools", "codex", "--model", "claude-haiku-5-5", "--stage-cap-usd", "5", "--dry-run"], { cwd: ROOT, env, encoding: "utf8" });
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /codex does not run anthropic models/);
});
