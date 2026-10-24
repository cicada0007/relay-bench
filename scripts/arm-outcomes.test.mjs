// scripts/arm-outcomes.mjs: made-up Harbor stages and the picker's answers written as the harness router's arm
// outcomes, each line checked against the import format the harness documents. Nothing is asked of any model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeHarborStage, fakePicker } from "../meta/fakes.mjs";
import { showOrder } from "../meta/pick.mjs";
import { buildGroups, defaultArms, harborLoader, runPicks } from "../meta/pick-groups.mjs";
import { loadBenchmark } from "../runner/harbor-bench.mjs";
import {
	armOutcomeProblem,
	buildArmOutcomes,
	DIFFICULTIES,
	difficultyOf,
	endingOf,
	HARNESS_IDS,
	kindOf,
	parseOutcomeLines,
	PULL_OUTCOMES,
	runKey,
	STRATEGIES,
	TASK_KINDS,
	taskMetaFromCache,
	taskMetaText,
	taskProfile,
	tomlMeta,
	writeArmOutcomes,
} from "./arm-outcomes.mjs";
import { openLedger } from "./draft-spend.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
// A checkout of the harness, read with git show only (RELAY_HARNESS_CHECKOUT, else beside this one); skipped without it.
const HARNESS = process.env.RELAY_HARNESS_CHECKOUT ?? join(ROOT, "..", "prime-agent-main");
const quiet = () => {};
const readJsonl = (path) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));

/** The documented example line, from the harness's docs/queue.md ("The router"), on one line. */
const DOC_EXAMPLE = '{"at":"2026-10-17T09:12:00.000Z","projectKey":"bench/terminal-bench","taskId":"tb-fix-git","kind":"bug","difficulty":"hard","arm":{"harness":"claude-code","model":"default","strategy":"direct","budgetUsd":4,"where":"local"},"ending":"finished","verified":true,"picked":true,"costUsd":2.31,"durationMs":412000}';

test("the import format is the harness's: the documented example passes, and a wrong line is named in its words", () => {
	assert.equal(armOutcomeProblem(JSON.parse(DOC_EXAMPLE)), null);
	const ok = JSON.parse(DOC_EXAMPLE);
	const bad = (patch) => armOutcomeProblem({ ...ok, ...patch });
	assert.equal(bad({ at: "yesterday" }), "at is not a time");
	assert.equal(bad({ kind: "fix" }), "kind is not one of bug, feature, refactor, test, docs, chore, other");
	assert.equal(bad({ difficulty: "15 min - 1 hour" }), "difficulty is not one of easy, medium, hard");
	assert.equal(bad({ arm: { ...ok.arm, harness: "prime-agent" } }), "arm.harness is not one of relay, claude-code, codex");
	assert.equal(bad({ arm: { ...ok.arm, where: "docker" } }), "arm.where is not local or e2b");
	assert.equal(bad({ ending: "solved" }), "ending is not one of finished, stopped-at-budget, timed-out, failed");
	assert.equal(bad({ pullRequest: "open" }), "pullRequest is not one of merged, merged-after-edits, closed, reverted");
	assert.equal(bad({ costUsd: -1 }), "costUsd is not an amount");
	assert.equal(bad({ armId: "" }), "armId is empty");
	const parsed = parseOutcomeLines(`${DOC_EXAMPLE}\n\nnot json\n${JSON.stringify({ ...ok, picked: "yes" })}\n`);
	assert.equal(parsed.outcomes.length, 1);
	assert.deepEqual(parsed.problems, ["line 3: it is not JSON", "line 4: picked is not true or false"]);
});

test("the format's lists match the harness's own, when its checkout is beside this one", { skip: !existsSync(join(HARNESS, ".git")) && "no harness checkout beside this one" }, () => {
	const show = spawnSync("git", ["-C", HARNESS, "show", "origin/main:packages/coding-agent/src/core/meta/router/store.ts"], { encoding: "utf8" });
	assert.equal(show.status, 0, show.stderr);
	const list = (name) => {
		const m = new RegExp(`(?:export )?const ${name} = \\[([\\s\\S]*?)\\]`).exec(show.stdout);
		assert.ok(m, name);
		return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
	};
	assert.deepEqual(list("HARNESS_IDS"), [...HARNESS_IDS]);
	assert.deepEqual(list("TASK_KINDS"), [...TASK_KINDS]);
	assert.deepEqual(list("DIFFICULTIES"), [...DIFFICULTIES]);
	assert.deepEqual(list("STRATEGIES"), [...STRATEGIES]);
	assert.deepEqual(list("PULL_OUTCOMES"), [...PULL_OUTCOMES]);
	const docs = spawnSync("git", ["-C", HARNESS, "show", "origin/main:packages/coding-agent/docs/queue.md"], { encoding: "utf8" });
	assert.ok(docs.stdout.includes(DOC_EXAMPLE), "the documented example is the one this test checks");
});

test("kind and difficulty come from the task's metadata, else the documented defaults", () => {
	assert.deepEqual(taskProfile("terminal-bench-2-1", "terminal-bench/build-cython-ext"), { kind: "bug", difficulty: "medium", from: { kind: "metadata", difficulty: "metadata" } });
	assert.deepEqual(taskProfile("terminal-bench-2-1", "terminal-bench/bn-fit-modify"), { kind: "other", difficulty: "hard", from: { kind: "default", difficulty: "metadata" } });
	assert.deepEqual(taskProfile("swebench-verified", "swe-bench/astropy__astropy-12907"), { kind: "bug", difficulty: "medium", from: { kind: "default", difficulty: "default" } });
	assert.deepEqual(taskProfile("swebench-pro", "scale-ai/p1"), { kind: "other", difficulty: "medium", from: { kind: "default", difficulty: "default" } });
	assert.equal(difficultyOf("<15 min fix"), "easy");
	assert.equal(difficultyOf("1-4 hours"), "hard");
	assert.equal(difficultyOf("Hard"), "hard");
	assert.equal(difficultyOf("unknown"), null);
	assert.equal(kindOf({ categories: ["core_feat"] }), "feature");
	assert.equal(kindOf({ category: "security" }), null);
	const meta = { "swebench-verified": { tasks: { "swe-bench/x": { difficulty: "15 min - 1 hour", category: "major_bug" } } } };
	assert.deepEqual(taskProfile("swebench-verified", "swe-bench/x", meta), { kind: "bug", difficulty: "medium", from: { kind: "metadata", difficulty: "metadata" } });
	assert.equal(endingOf({ stoppedAtCap: true }), "stopped-at-budget");
	assert.equal(endingOf({ stoppedAtSandboxCap: true, exception: "CancelledError" }), "stopped-at-budget");
	assert.equal(endingOf({ exception: "AgentTimeoutError" }), "timed-out");
	assert.equal(endingOf({ exception: "NonZeroAgentExitCodeError" }), "failed");
	assert.equal(endingOf({ exception: null }), "finished");
});

/**
 * A Terminal-Bench stage (Relay and Claude Code) with: a task both solved, a task only Relay solved, a task only Claude
 * Code solved, and a task whose infrastructure failed; the picker answered the split groups, preferring Relay's. And a
 * SWE-bench Pro stage (Relay and Codex) whose split group the picker has not answered.
 */
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "arm-outcomes-"));
	const runsDir = join(root, "runs");
	const tb = join(runsDir, "scoreboard", "terminal-bench-2-1-claude-haiku-5-5");
	const [both, relayOnly, ccOnly, broken] = ["terminal-bench/build-cython-ext", "terminal-bench/bn-fit-modify", "terminal-bench/fix-git", "terminal-bench/regex-log"];
	const at = (minute) => `2026-10-20T10:${String(minute).padStart(2, "0")}:00Z`;
	const tbRecords = fakeHarborStage(tb, {
		test: "terminal-bench-2-1-claude-haiku-5-5",
		model: "claude-haiku-5-5",
		benchmark: "terminal-bench-2-1",
		trials: [
			{ task: both, tool: "relay", rep: 1, solved: true, costUsd: 0.02, startedAt: at(1) },
			{ task: both, tool: "claude-code", rep: 1, solved: true, costUsd: 0.04, startedAt: at(2) },
			{ task: relayOnly, tool: "relay", rep: 1, solved: true, costUsd: 0.03, startedAt: at(3) },
			{ task: relayOnly, tool: "claude-code", rep: 1, solved: false, costUsd: 0.05, startedAt: at(4) },
			{ task: ccOnly, tool: "relay", rep: 1, solved: false, costUsd: 0.02, startedAt: at(5) },
			{ task: ccOnly, tool: "claude-code", rep: 1, solved: true, costUsd: 0.06, startedAt: at(6) },
			{ task: broken, tool: "relay", rep: 1, infra: true, startedAt: at(7) },
			{ task: broken, tool: "claude-code", rep: 1, solved: true, startedAt: at(8) },
		],
	});
	const records = readJsonl(join(tb, "records.jsonl")).map((r) => ({ ...r, capUsd: 1, ...(r.task === ccOnly && r.tool === "relay" ? { stoppedAtCap: true } : {}) }));
	writeFileSync(join(tb, "records.jsonl"), records.map((r) => `${JSON.stringify(r)}\n`).join(""));
	const { groups } = buildGroups(records, defaultArms(records));
	await runPicks({ groups, loader: harborLoader(tb), benchModel: "claude-haiku-5-5", test: "tb", model: fakePicker("run relay "), ledger: openLedger(join(root, "spend.json"), { caps: { openai: 1 } }), out: join(tb, "meta", "picks-gpt-6.1-sol-medium.jsonl"), ask: "split", log: quiet });
	const pro = join(runsDir, "scoreboard", "swebench-pro-gpt-6-luna");
	const [p1, p2] = loadBenchmark("swebench-pro").tasks.slice(0, 2).map((t) => t.name);
	fakeHarborStage(pro, {
		test: "swebench-pro-gpt-6-luna",
		model: "gpt-6-luna",
		benchmark: "swebench-pro",
		trials: [
			{ task: p1, tool: "relay", rep: 1, solved: false, startedAt: at(10) },
			{ task: p1, tool: "codex", rep: 1, solved: true, startedAt: at(11), transcript: "codex-events" },
			{ task: p2, tool: "relay", rep: 1, solved: true, startedAt: at(12) },
			{ task: p2, tool: "codex", rep: 1, solved: true, startedAt: at(13), transcript: "codex-events" },
		],
	});
	return { root, runsDir, tasks: { both, relayOnly, ccOnly, broken, p1, p2 }, tbRecords };
}

const runsOf = (lines) => {
	const runs = new Map();
	for (const l of lines) {
		if (!runs.has(runKey(l))) runs.set(runKey(l), []);
		runs.get(runKey(l)).push(l);
	}
	return [...runs.values()];
};

test("each picker group is one run, an arm a line; each of Relay's trials is a one-arm run; what is not decided is counted", async () => {
	const { runsDir, tasks } = await fixture();
	const built = await buildArmOutcomes({ runsDir, sources: [{ benchmark: "terminal-bench-2-1", stage: "scoreboard/terminal-bench-2-1-claude-haiku-5-5" }, { benchmark: "swebench-pro", stage: "scoreboard/swebench-pro-gpt-6-luna" }, { benchmark: "exam", stage: "scoreboard/none" }] });
	assert.deepEqual(built.problems, []);
	for (const l of built.lines) assert.equal(armOutcomeProblem(l), null);
	const [tb, pro] = built.stages;
	assert.deepEqual([tb.relayAlone, tb.groups, tb.groupsWritten, tb.droppedTasks], [3, 3, 3, 1], "the task whose infrastructure failed is left out for every tool");
	assert.deepEqual([pro.relayAlone, pro.groups, pro.groupsWritten, pro.groupsNotDecided], [2, 2, 1, 1], "the split group nobody picked yet is counted, not guessed");
	assert.equal(built.stages.length, 2, "the exam is never written here");
	assert.ok(!built.lines.some((l) => l.taskId.startsWith(tasks.broken)));

	const runs = runsOf(built.lines);
	const run = (task, set) => runs.find((ls) => ls[0].taskId === `${task} r1 ${set}`);
	// One Relay arm: picked exactly when the benchmark's grade passed.
	for (const ls of runs.filter((r) => r.length === 1)) {
		assert.equal(ls[0].arm.harness, "relay");
		assert.equal(ls[0].picked, ls[0].verified);
	}
	// A split group: the picker kept Relay's attempt.
	const split = run(tasks.relayOnly, "claude-code+relay");
	assert.deepEqual(split.map((l) => [l.arm.harness, l.verified, l.picked]), [["claude-code", false, false], ["relay", true, true]]);
	assert.equal(new Set(split.map((l) => l.at)).size, 1);
	assert.equal(split[0].at, "2026-10-20T10:03:00.000Z", "the run starts with its first attempt");
	assert.deepEqual(split.map((l) => l.armId), ["a1", "a2"]);
	const wrong = run(tasks.ccOnly, "claude-code+relay");
	assert.deepEqual(wrong.map((l) => [l.arm.harness, l.verified, l.picked, l.ending]), [["claude-code", true, false, "finished"], ["relay", false, true, "stopped-at-budget"]], "the picker kept Relay's failed attempt: not proven");
	// Every attempt solved it and the picker was not asked: the attempt it would have been shown first is picked.
	const unanimous = run(tasks.both, "claude-code+relay");
	const first = showOrder(`${tasks.both}|r1`, 2)[0];
	assert.deepEqual(unanimous.map((l) => l.picked), [first === 0, first === 1]);
	assert.ok(unanimous.some((l) => l.verified && l.picked));
	// Kind and difficulty from the task's metadata; the arm as it ran.
	assert.deepEqual([unanimous[0].kind, unanimous[0].difficulty], ["bug", "medium"]);
	assert.deepEqual([split[0].kind, split[0].difficulty], ["other", "hard"]);
	assert.deepEqual(split[1].arm, { harness: "relay", model: "anthropic/claude-haiku-5-5", strategy: "direct", budgetUsd: 1, where: "e2b" });
	assert.equal(split[1].costUsd, 0.03);
	assert.equal(split[1].durationMs, 60_000);
	assert.equal(split[0].projectKey, "bench/terminal-bench-2-1");
	// SWE-bench Pro: Codex beside Relay only, never alone.
	const proRun = run(tasks.p2, "codex+relay");
	assert.deepEqual(proRun.map((l) => [l.arm.harness, l.arm.model, l.kind]), [["codex", "openai/gpt-6-luna", "other"], ["relay", "openai/gpt-6-luna", "other"]]);
	assert.ok(!runs.some((ls) => ls.length === 1 && ls[0].arm.harness !== "relay"));
});

test("the file is written only when every line is in the import format, and the command line checks a file", async () => {
	const { root, runsDir } = await fixture();
	const built = await buildArmOutcomes({ runsDir });
	assert.ok(built.lines.length > 0, "every stage under runs/scoreboard/ is read");
	const path = join(root, "results", "arm-outcomes.jsonl");
	writeArmOutcomes(path, built);
	const back = parseOutcomeLines(readFileSync(path, "utf8"));
	assert.deepEqual([back.outcomes.length, back.problems], [built.lines.length, []]);
	const refused = join(root, "refused.jsonl");
	assert.throws(() => writeArmOutcomes(refused, { lines: built.lines, problems: ["line 2: kind is not one of ..."] }), /nothing was written/);
	assert.equal(existsSync(refused), false);

	const env = { PATH: process.env.PATH, HOME: root };
	const checked = spawnSync(process.execPath, ["scripts/arm-outcomes.mjs", "--check", path], { cwd: ROOT, encoding: "utf8", env });
	assert.equal(checked.status, 0, checked.stderr);
	assert.match(checked.stdout, new RegExp(`^${built.lines.length} arm outcomes in the import format`));
	const broken = join(root, "broken.jsonl");
	writeFileSync(broken, `${readFileSync(path, "utf8")}{"at":"x"}\n`);
	const no = spawnSync(process.execPath, ["scripts/arm-outcomes.mjs", "--check", broken], { cwd: ROOT, encoding: "utf8", env });
	assert.equal(no.status, 1);
	assert.match(no.stdout, new RegExp(`line ${built.lines.length + 1}: at is not a time`));
	const to = join(root, "dry.jsonl");
	const dry = spawnSync(process.execPath, ["scripts/arm-outcomes.mjs", "--runs", runsDir, "--to", to, "--dry-run"], { cwd: ROOT, encoding: "utf8", env });
	assert.equal(dry.status, 0, dry.stderr);
	assert.match(dry.stdout, /arm outcomes; dry run, nothing written/);
	assert.equal(existsSync(to), false);
	const wrote = spawnSync(process.execPath, ["scripts/arm-outcomes.mjs", "--runs", runsDir, "--to", to], { cwd: ROOT, encoding: "utf8", env });
	assert.equal(wrote.status, 0, wrote.stderr);
	assert.match(wrote.stdout, /relay router learn --import/);
	assert.equal(readFileSync(to, "utf8"), readFileSync(path, "utf8"));
});

test("task metadata is read from Harbor's task cache only at each task's pinned digest", () => {
	const cache = mkdtempSync(join(tmpdir(), "harbor-cache-"));
	const [a, b] = loadBenchmark("terminal-bench-2-1").tasks;
	const put = (task, digest, text) => {
		const [org, name] = task.split("/");
		const dir = join(cache, "packages", org, name, digest);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "task.toml"), text);
	};
	const toml = (difficulty) => `[task]\nname = "x"\n\n[metadata]\ndifficulty = "${difficulty}"\ncategory = "debugging"\n\n[environment]\ncpus = 4\nmemory_mb = 8192\n\n[environment.env]\n`;
	put(a.name, a.ref.replace("sha256:", ""), toml("hard"));
	put(b.name, "0".repeat(64), toml("easy"));
	assert.deepEqual(tomlMeta(toml("hard")), { difficulty: "hard", category: "debugging", cpus: 4, memoryMb: 8192 });
	const { meta, counts } = taskMetaFromCache({ cache, written: "2026-10-24" });
	assert.deepEqual(counts["terminal-bench-2-1"], { found: 1, of: 89 });
	assert.deepEqual(Object.keys(meta["terminal-bench-2-1"].tasks), [a.name], "a task at another digest is not read");
	assert.equal(meta["swebench-verified"], undefined);
	const text = taskMetaText(meta);
	assert.deepEqual(JSON.parse(text), meta);
	assert.equal(text.split("\n").filter((l) => l.includes(a.name)).length, 1, "one task a line");
	const pinned = JSON.parse(readFileSync(join(ROOT, "runner", "task-meta.json"), "utf8"));
	assert.equal(Object.keys(pinned["terminal-bench-2-1"].tasks).length, 89, "every Terminal-Bench 2.1 task's metadata is pinned here");
	assert.equal(pinned["terminal-bench-2-1"].dataset, `${loadBenchmark("terminal-bench-2-1").dataset}@${loadBenchmark("terminal-bench-2-1").ref}`);
});
