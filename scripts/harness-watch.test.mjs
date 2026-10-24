// scripts/harness-watch.mjs: a new Claude Code or Codex on npm is planned as an exam stage with the bar's own pins and
// caps, queued for a person and never run; a version the benchmark pins or the scoreboard shows is not; every check
// gives one plain line per harness. The npm registry is a fake: nothing here reaches a network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BAR_RELAY, BAR_STAGES } from "./export-bar.mjs";
import { compareVersions, harnessStageOf, latestPublished, pinnedVersions, planStage, scoreboardVersions, triedThisWeek, WATCHED, watchHarnesses } from "./harness-watch.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/** The npm registry, made up: each package's latest version and when it was published; `calls` keeps every URL. */
function registry(latest, { calls = [], fail = [] } = {}) {
	return async (url) => {
		calls.push(url);
		const pkg = decodeURIComponent(url.split("/").pop());
		if (fail.includes(pkg)) throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
		const version = latest[pkg];
		if (!version) return { ok: false, status: 404, json: async () => ({}) };
		return { ok: true, status: 200, json: async () => ({ name: pkg, "dist-tags": { latest: version, stable: "1.0.0" }, time: { [version]: "2026-10-23T21:20:46.540Z" } }) };
	};
}

/** An exam with `n` exam tasks (and one check task, which a stage on tier:exam leaves out). */
function exam(n = 30) {
	const root = mkdtempSync(join(tmpdir(), "harness-watch-exam-"));
	for (let i = 0; i < n + 1; i++) {
		const dir = join(root, "tasks", `t${i}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "task.json"), JSON.stringify({ id: `t${i}`, kind: "everyday", tier: i < n ? "exam" : "check" }));
	}
	return root;
}

const NEW = { "@anthropic-ai/claude-code": "2.1.310", "@openai/codex": "0.163.0" };
const noBoard = () => join(mkdtempSync(join(tmpdir(), "harness-watch-board-")), "scoreboard.json");

test("the pins are read from the Harbor agents and the image, and they agree", () => {
	const pins = pinnedVersions();
	assert.deepEqual(pins, { "claude-code": { agents: "2.1.300", image: "2.1.300" }, codex: { agents: "0.163.0", image: "0.163.0" } });
	assert.deepEqual(WATCHED.map((w) => [w.tool, w.npm, w.stage]), [["claude-code", "@anthropic-ai/claude-code", "bar-1-haiku"], ["codex", "@openai/codex", "bar-1-openai"]]);
	assert.equal(compareVersions("2.1.310", "2.1.300"), 1);
	assert.equal(compareVersions("0.163.0", "0.163.0"), 0);
	assert.equal(compareVersions("0.99.0", "0.163.0"), -1);
});

test("a new version is planned on the bar's stage, with its pins and caps, queued for a person, and nothing runs", async () => {
	const examDir = exam(30);
	const calls = [];
	const r = await watchHarnesses({ fetch: registry(NEW, { calls }), examDir, scoreboardPath: noBoard(), week: "2026-W44", now: new Date("2026-10-26T06:00:00Z") });
	assert.deepEqual(calls, ["https://registry.npmjs.org/@anthropic-ai%2fclaude-code", "https://registry.npmjs.org/@openai%2fcodex"], "one read of npm per harness, nothing else");
	assert.deepEqual(r.tools.map((t) => [t.tool, t.latest, t.pinned, t.status]), [["claude-code", "2.1.310", "2.1.300", "queued"], ["codex", "0.163.0", "0.163.0", "pinned"]]);
	assert.deepEqual(r.problems, []);

	const [entry] = r.queued;
	const bar = BAR_STAGES.find((s) => s.id === "bar-1-haiku");
	assert.deepEqual([entry.id, entry.test, entry.from, entry.model, entry.week, entry.status], ["claude-code@2.1.310", "bar-1-haiku-claude-code-2.1.310", "bar-1-haiku", "claude-haiku-5-5", "2026-W44", "waiting for a person"]);
	assert.deepEqual(entry.tools, [BAR_RELAY, "claude-code@2.1.310"], "the new version beside the bar's own Relay");
	assert.deepEqual([entry.reps, entry.capUsd, entry.stageCapUsd, entry.e2bCapUsd], [bar.run.reps, bar.run.capUsd, bar.run.stageCapUsd, bar.run.e2bCapUsd], "the bar stage's caps");
	assert.deepEqual([entry.tasks, entry.runs, entry.mostUsd], [30, 60, 60], "30 exam tasks × 2 tools, at $1 a run, within the $250 stage cap");
	const a = entry.stage.args;
	const arg = (name) => a[a.indexOf(name) + 1];
	assert.equal(entry.stage.script, "runner/run-stage.mjs");
	assert.deepEqual([arg("--test"), arg("--model"), arg("--tools"), arg("--tasks"), arg("--reps"), arg("--cap-usd"), arg("--stage-cap-usd"), arg("--e2b-cap-usd"), arg("--concurrency")], ["bar-1-haiku-claude-code-2.1.310", "claude-haiku-5-5", "relay@0.6.121,claude-code@2.1.310", "tier:exam", "1", "1", "250", "120", "6"]);
	assert.equal(arg("--tasks-dir"), join(examDir, "tasks"));
	assert.equal(arg("--out"), join(examDir, "runs", "bar"), "its records go beside the bar's, where the scoreboard reads them");
	assert.match(entry.stage.dryRun, / --dry-run$/);
	assert.match(entry.smoke.command, /^node runner\/run-one\.mjs --task smoke-add --tasks-dir dev-tasks --tool claude-code@2\.1\.310 --model claude-haiku-5-5 --cap-usd 0\.2 --test dev --out runs\/dev$/);

	// Queued in the exam's queue for a person; no stage records were made.
	const queue = readFileSync(join(examDir, "queue", "harness-watch.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(queue.map((q) => q.id), ["claude-code@2.1.310"]);
	assert.equal(existsSync(join(examDir, "runs")), false, "nothing ran");

	// One plain line per harness, for the week's notes.
	assert.deepEqual(r.lines, [
		"Claude Code 2.1.310 came out on 23 Oct 2026 (the benchmark pins 2.1.300): its exam stage bar-1-haiku-claude-code-2.1.310 is queued for a person, at most $60.00 of model spend and $120.00 of sandbox time; nothing ran",
		"Codex: 0.163.0 is the latest published version and the one the benchmark pins; nothing new",
	]);
	assert.deepEqual(triedThisWeek(r, { examDir }).map((t) => t.words), ["Claude Code 2.1.310 (its exam stage is queued for a person)"]);

	// The next check finds it queued and queues nothing twice; once its stage has runs, it is said so, and counts as tried.
	const again = await watchHarnesses({ fetch: registry(NEW), examDir, scoreboardPath: noBoard(), week: "2026-W45" });
	assert.deepEqual(again.queued, []);
	assert.equal(again.tools[0].status, "queued earlier");
	assert.match(again.lines[0], /its exam stage bar-1-haiku-claude-code-2\.1\.310 was queued in 2026-W44 and waits for a person$/);
	assert.deepEqual(triedThisWeek(again, { examDir }), [], "queued last week and not run: not new this week");
	mkdirSync(join(examDir, "runs", "bar"), { recursive: true });
	appendFileSync(join(examDir, "runs", "bar", "records.jsonl"), `${JSON.stringify({ test: "bar-1-haiku-claude-code-2.1.310", task: "t1", tool: "claude-code@2.1.310" })}\n${JSON.stringify({ test: "bar-1-haiku", task: "t1", tool: "claude-code" })}\n`);
	const ran = await watchHarnesses({ fetch: registry(NEW), examDir, scoreboardPath: noBoard(), week: "2026-W45" });
	assert.match(ran.lines[0], /was queued in 2026-W44 and has 1 runs on 1 tasks$/);
	assert.deepEqual(triedThisWeek(ran, { examDir }).map((t) => t.words), ["Claude Code 2.1.310 (its exam stage has 1 of 60 runs, on 1 tasks)"]);
	assert.equal(readFileSync(join(examDir, "queue", "harness-watch.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("a version the scoreboard shows, or one the benchmark pins, plans nothing; an unread registry says so", async () => {
	const examDir = exam(5);
	const board = noBoard();
	writeFileSync(board, JSON.stringify({ benchmarks: [{ runs: [{ entries: [{ id: "claude-code@2.1.310", name: "Claude Code 2.1.310" }, { id: "codex", name: "Codex 0.163.0" }] }] }] }));
	assert.deepEqual(scoreboardVersions(JSON.parse(readFileSync(board, "utf8")), "claude-code"), ["2.1.310"]);
	assert.deepEqual(scoreboardVersions(JSON.parse(readFileSync(board, "utf8")), "codex"), ["0.163.0"]);
	const r = await watchHarnesses({ fetch: registry({ ...NEW, "@openai/codex": "0.160.0" }), examDir, scoreboardPath: board, week: "2026-W44" });
	assert.deepEqual(r.tools.map((t) => t.status), ["on the scoreboard", "pinned"]);
	assert.equal(r.lines[0], "Claude Code: 2.1.310 is the latest published version, and the scoreboard shows it already");
	assert.equal(r.lines[1], "Codex: 0.160.0 is the latest published version, and the benchmark pins 0.163.0; nothing new");
	assert.equal(existsSync(join(examDir, "queue")), false);

	const down = await watchHarnesses({ fetch: registry(NEW, { fail: ["@openai/codex"] }), examDir, scoreboardPath: board, week: "2026-W44" });
	assert.equal(down.tools[1].status, "unread");
	assert.match(down.lines[1], /^Codex: the registry could not be read for @openai\/codex \(getaddrinfo ENOTFOUND registry\.npmjs\.org\), so its latest version was not checked this week$/);
	assert.deepEqual(await latestPublished("@openai/codex", { fetch: async () => ({ ok: true, status: 200, json: async () => ({ "dist-tags": { latest: "next; rm -rf /" } }) }) }), { error: 'the registry\'s latest @openai/codex is "next; rm -rf /", not a version' });
	assert.match((await latestPublished("@openai/codex", { fetch: null })).error, /no way to read the npm registry/);
});

test("a dry run, or a week without the exam here, queues nothing", async () => {
	const examDir = exam(5);
	const dry = await watchHarnesses({ fetch: registry({ ...NEW, "@openai/codex": "0.164.0" }), examDir, scoreboardPath: noBoard(), week: "2026-W44", write: false });
	assert.deepEqual(dry.tools.map((t) => t.status), ["planned", "planned"]);
	assert.equal(dry.tools[1].plan.test, "bar-1-openai-codex-0.164.0");
	assert.deepEqual(dry.tools[1].plan.tools, [BAR_RELAY, "codex@0.164.0"]);
	assert.equal(dry.tools[1].plan.model, "gpt-6-luna");
	assert.match(dry.lines[1], /is planned \(a dry run, so not queued\)/);
	assert.equal(existsSync(join(examDir, "queue")), false);
	const none = join(tmpdir(), "harness-watch-no-exam-here");
	const away = await watchHarnesses({ fetch: registry(NEW), examDir: none, scoreboardPath: noBoard(), week: "2026-W44" });
	assert.match(away.lines[0], /is planned but not queued: there is no exam at /);
	assert.equal(away.tools[0].plan.mostUsd, BAR_STAGES[0].run.stageCapUsd, "without the exam's task count, the stage cap is the most it could cost");
	assert.equal(existsSync(none), false);
});

test("a stage's name says which bar stage, harness and version it is; a stage for the spot check keeps its sample", () => {
	assert.deepEqual(harnessStageOf("bar-1-haiku-claude-code-2.1.310"), { stage: BAR_STAGES[0], tool: "claude-code", version: "2.1.310" });
	assert.equal(harnessStageOf("bar-1-haiku-codex-0.164.0").tool, "codex");
	for (const name of ["bar-1-haiku", "bar-9-haiku-claude-code-2.1.310", "bar-1-haiku-hermes-1.0.0", "bar-1-haiku-claude-code-latest"]) assert.equal(harnessStageOf(name), null, name);
	const spot = planStage({ watched: { ...WATCHED[0], stage: "bar-1-sonnet" }, version: "2.1.310", examDir: join(ROOT, "..", "relay-exam"), examTasks: 400 });
	assert.deepEqual([spot.tasks, spot.runs, spot.mostUsd], [100, 200, 300]);
	assert.ok(spot.stage.args.includes("--sample"));
	assert.equal(spot.stage.args[spot.stage.args.indexOf("--tasks-dir") + 1], "../relay-exam/tasks", "the exam beside this folder, as the runbook names it");
});

test("the command line prints the plan and, on a dry run, queues nothing; a registry it cannot reach exits 1", () => {
	const examDir = exam(3);
	// A registry nobody answers at, so the test stays offline.
	const out = spawnSync(process.execPath, [join(ROOT, "scripts", "harness-watch.mjs"), "--exam", examDir, "--scoreboard", noBoard(), "--registry", "http://127.0.0.1:9", "--week", "2026-W44", "--json"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: examDir } });
	assert.equal(out.status, 1, out.stderr);
	const r = JSON.parse(out.stdout);
	assert.deepEqual(r.tools.map((t) => t.status), ["unread", "unread"]);
	assert.equal(existsSync(join(examDir, "queue")), false);
	const words = spawnSync(process.execPath, [join(ROOT, "scripts", "harness-watch.mjs"), "--exam", examDir, "--scoreboard", noBoard(), "--registry", "http://127.0.0.1:9", "--dry-run"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: examDir } });
	assert.match(words.stdout, /^Harness watch, week \d{4}-W\d{2}:\n  Claude Code: the registry could not be read for @anthropic-ai\/claude-code/);
});
