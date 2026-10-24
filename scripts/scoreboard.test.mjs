// scripts/scoreboard.mjs: the scoreboard built from made-up records of every benchmark, the meta-harness scored from
// the picker's answers already given, numbers only, no exam task names, and the history carried week to week.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { plist } from "../loop/schedule.mjs";
import { fakeExam, fakeHarborStage, fakePicker } from "../meta/fakes.mjs";
import { buildGroups, defaultArms, harborLoader, patchLoader, runPicks } from "../meta/pick-groups.mjs";
import { loadBenchmark } from "../runner/harbor-bench.mjs";
import { openLedger } from "./draft-spend.mjs";
import { buildScoreboard, difference, SCHEDULE_LABEL, scheduleArgsFor, toolEntry } from "./scoreboard.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const quiet = () => {};

/** Two public benchmarks (one per provider), each with its picks answered, and the exam's Haiku stage. */
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "scoreboard-"));
	const runsDir = join(root, "runs");
	const examDir = join(root, "relay-exam");
	const trials = (tools, plan) => plan.flatMap(([task, rep, solvedBy]) => tools.map((tool) => ({ task, tool, rep, solved: solvedBy.includes(tool), costUsd: tool === "relay" ? 0.1 : 0.2, wallMs: tool === "relay" ? 60_000 : 120_000 })));
	const verified = join(runsDir, "scoreboard", "swebench-verified");
	const verifiedTasks = ["swe-bench/v1", "swe-bench/v2", "swe-bench/v3"];
	fakeHarborStage(verified, {
		test: "swebench-verified",
		model: "claude-haiku-5-5",
		benchmark: "swebench-verified",
		trials: trials(["relay", "claude-code"], [
			["swe-bench/v1", 1, ["relay"]],
			["swe-bench/v2", 1, ["claude-code"]],
			["swe-bench/v3", 1, ["relay", "claude-code"]],
		]),
	});
	writeFileSync(join(verified, "sample.json"), JSON.stringify({ tasks: verifiedTasks }));
	const pro = join(runsDir, "scoreboard", "swebench-pro");
	fakeHarborStage(pro, {
		test: "swebench-pro",
		model: "gpt-6-luna",
		benchmark: "swebench-pro",
		trials: [
			...trials(["relay", "codex"], [
				["scale-ai/p1", 1, ["codex"]],
				["scale-ai/p2", 1, []],
			]),
			{ task: "scale-ai/p3", tool: "relay", rep: 1, infra: true },
			{ task: "scale-ai/p3", tool: "codex", rep: 1, solved: true },
		],
	});
	writeFileSync(join(pro, "sample.json"), JSON.stringify({ tasks: ["scale-ai/p1", "scale-ai/p2", "scale-ai/p3"] }));
	const exam = fakeExam(examDir, {
		runs: [
			{ test: "bar-1-haiku", task: "sealed-task-alpha", tool: "relay@0.6.121", rep: 1, share: 1 },
			{ test: "bar-1-haiku", task: "sealed-task-alpha", tool: "claude-code", rep: 1, share: 0 },
			{ test: "bar-1-haiku", task: "sealed-task-beta", tool: "relay@0.6.121", rep: 1, share: 1 },
			{ test: "bar-1-haiku", task: "sealed-task-beta", tool: "claude-code", rep: 1, share: 1 },
		],
	});
	// The picker's answers, given before the build (the build asks for none): it keeps Relay's attempt in Verified and
	// Pro, and Claude Code's on the exam.
	const answer = async (stageDir, records, loader, prefer, test) => {
		const { groups } = buildGroups(records, defaultArms(records));
		await runPicks({ groups, loader, benchModel: records[0].model, test, model: fakePicker(prefer), ledger: openLedger(join(root, `${test}.spend.json`), { caps: { openai: 1 } }), out: join(stageDir, "meta", "picks-gpt-6.1-sol-medium.jsonl"), ask: "split", log: quiet });
	};
	const { readFileSync } = await import("node:fs");
	const recordsOf = (dir) => readFileSync(join(dir, "records.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	await answer(verified, recordsOf(verified), harborLoader(verified), "run relay ", "swebench-verified");
	await answer(pro, recordsOf(pro), harborLoader(pro), "run relay ", "swebench-pro");
	await answer(join(examDir, "runs", "bar"), exam, patchLoader(join(examDir, "runs", "bar"), [join(examDir, "tasks")]), "change claude-code ", "bar-1-haiku");
	return { root, runsDir, examDir };
}

const entry = (run, id) => run.entries.find((e) => e.id === id);

test("each benchmark and model has every tool's score with its interval, cost per solved task and time, and the meta-harness", async () => {
	const { runsDir, examDir } = await fixture();
	const board = await buildScoreboard({ runsDir, examDir, week: "2026-W43", generatedAt: "2026-10-24T00:00:00Z" });
	assert.deepEqual(board.benchmarks.map((b) => [b.id, b.status]), [["terminal-bench-2-1", "not run yet"], ["swebench-verified", "complete"], ["swebench-pro", "complete"], ["exam", "complete"]]);

	const verified = board.benchmarks[1];
	assert.equal(verified.dataset, "swe-bench/swe-bench-verified@sha256:b934b0cc3dc800fe945eaf9f1623329db97ee3133c706d20644524c7759fb341");
	assert.equal(verified.tasksInSet, 500);
	const run = verified.runs[0];
	assert.equal(run.modelName, "Claude Haiku 5.5");
	assert.equal(run.sample, 3);
	assert.deepEqual(run.entries.map((e) => [e.id, e.name]), [["relay", "Relay 0.6.121"], ["claude-code", "Claude Code 2.1.300"], ["meta", "Relay meta-harness"]]);
	const relay = entry(run, "relay");
	assert.ok(Math.abs(relay.score - 200 / 3) < 1e-9);
	assert.equal(typeof relay.low, "number");
	assert.equal(typeof relay.high, "number");
	assert.ok(relay.low <= relay.score && relay.score <= relay.high);
	assert.ok(Math.abs(relay.costPerSolvedUsd - 0.3 / 2) < 1e-12);
	assert.equal(relay.medianMinutes, 1);
	// The picker kept Relay's attempt on both split tasks: right on v1, wrong on v2; v3 both solved.
	const meta = entry(run, "meta");
	assert.ok(Math.abs(meta.score - 200 / 3) < 1e-9);
	assert.deepEqual(meta.arms, ["claude-code", "relay"]);
	assert.equal(meta.groupsAsked, 2);
	assert.equal(meta.groupsPickerEstimated, 1);
	assert.ok(Math.abs(meta.attemptsUsd - 0.9) < 1e-12, "every attempt of every group");
	assert.ok(meta.costUsd > meta.attemptsUsd);
	assert.equal(meta.costPerSolvedUsd, meta.costUsd / 2);
	assert.ok(meta.medianMinutes >= 2, "its time is its slowest attempt");
	const d = run.differences.find((x) => x.of === "meta" && x.minus === "claude-code");
	assert.equal(d.tasks, 3);
	assert.ok(Math.abs(d.points - (200 / 3 - 200 / 3)) < 1e-9);
	assert.ok(run.differences.some((x) => x.of === "relay" && x.minus === "claude-code"));

	const pro = board.benchmarks[2].runs[0];
	assert.equal(pro.model, "gpt-6-luna");
	assert.deepEqual(pro.entries.map((e) => e.name), ["Relay 0.6.121", "Codex 0.163.0", "Relay meta-harness"]);
	assert.deepEqual(pro.droppedTasks, ["scale-ai/p3"], "a task whose infrastructure failed is dropped for every entry");
	assert.equal(entry(pro, "codex").tasks, 2);
	assert.equal(entry(pro, "meta").score, 0, "the picker kept Relay's failed attempt on p1");
});

test("the sealed exam is counts and scores only, and the file has no words for results", async () => {
	const { runsDir, examDir } = await fixture();
	const board = await buildScoreboard({ runsDir, examDir, week: "2026-W43" });
	const exam = board.benchmarks.find((b) => b.id === "exam");
	assert.equal(exam.kind, "sealed");
	const run = exam.runs[0];
	assert.equal(run.test, "bar-1-haiku");
	assert.equal(run.droppedTaskCount, 0);
	assert.equal("droppedTasks" in run, false);
	assert.doesNotMatch(JSON.stringify(exam), /sealed-task/);
	assert.deepEqual(run.entries.map((e) => e.name), ["Relay 0.6.121", "Claude Code", "Relay meta-harness"]);
	assert.equal(entry(run, "meta").score, 50);
	assert.doesNotMatch(JSON.stringify(board), /\b(better|worse|beats?|wins?|loses?|clear difference|outperform\w*)\b/i);
	assert.deepEqual(board.notInRegistry.map((n) => n.name), ["Terminal-Bench 4.0"]);
});

test("a group the picker has not answered is counted, not guessed, and the run stays in progress", async () => {
	const root = mkdtempSync(join(tmpdir(), "scoreboard-open-"));
	const runsDir = join(root, "runs");
	const stage = join(runsDir, "scoreboard", "swebench-verified");
	const [v1, v2] = loadBenchmark("swebench-verified").tasks.map((t) => t.name);
	fakeHarborStage(stage, {
		test: "swebench-verified",
		model: "claude-haiku-5-5",
		benchmark: "swebench-verified",
		trials: [
			{ task: v1, tool: "relay", rep: 1, solved: true },
			{ task: v1, tool: "claude-code", rep: 1, solved: false },
			{ task: v2, tool: "relay", rep: 1, solved: true },
			{ task: v2, tool: "claude-code", rep: 1, solved: true },
		],
	});
	const board = await buildScoreboard({ runsDir, examDir: join(root, "none"), week: "2026-W44" });
	const run = board.benchmarks[1].runs[0];
	assert.equal(run.status, "in progress", "the full set of 500 tasks is planned and the split group is not picked");
	assert.equal(run.trialsNotMade, 2 * 498);
	const meta = entry(run, "meta");
	assert.equal(meta.groupsNotDecided, 1);
	assert.equal(meta.groups, 1);
	assert.equal(meta.score, 100, "over the one group decided without a call");
	assert.equal(board.benchmarks[3].status, "not run yet");
});

test("every week adds its lines to the history and replaces the same week's", async () => {
	const { runsDir, examDir } = await fixture();
	const first = await buildScoreboard({ runsDir, examDir, week: "2026-W43" });
	const previous = { history: [{ week: "2026-W42", benchmark: "swebench-verified", entry: "relay", score: 10 }, ...first.history] };
	const next = await buildScoreboard({ runsDir, examDir, week: "2026-W43", previous });
	assert.deepEqual([...new Set(next.history.map((h) => h.week))], ["2026-W42", "2026-W43"]);
	assert.equal(next.history.filter((h) => h.week === "2026-W43").length, first.history.length);
	assert.ok(first.history.some((h) => h.entry === "meta" && h.benchmark === "exam"));
});

test("a tool's entry and a difference follow the round's rules", () => {
	const recs = [
		{ task: "a", rep: 1, solved: true, usage: { costUsd: 1 }, wallMs: 60_000 },
		{ task: "a", rep: 2, solved: false, usage: { costUsd: 1 }, wallMs: 120_000 },
		{ task: "b", rep: 1, solved: true, usage: null, wallMs: 180_000 },
	];
	const e = toolEntry("relay", recs);
	assert.equal(e.score, 75, "the mean over tasks of each task's mean over trials");
	assert.equal(e.allTrialsSolved, 50);
	assert.equal(e.costPerSolvedUsd, 1);
	assert.equal(e.unmeteredTrials, 1);
	assert.equal(e.medianMinutes, 2);
	assert.equal(difference(new Map([["a", 100]]), new Map([["a", 0]])), null, "one shared task has no interval");
	const d = difference(new Map([["a", 100], ["b", 50], ["c", 0]]), new Map([["a", 0], ["b", 50], ["d", 0]]));
	assert.equal(d.tasks, 2);
	assert.equal(d.points, 50);
});

test("the weekly job carries no key and runs the scoreboard only; the command line writes nothing on a dry run", async () => {
	assert.deepEqual(scheduleArgsFor(), ["--weekly"]);
	assert.throws(() => scheduleArgsFor(["OPENAI_API_KEY=sk-abcdefghijk"]), /never carries a key/);
	const text = plist({ bench: "/b", node: "/n/node", args: scheduleArgsFor(), logDir: "/b/runs/scoreboard", when: { weekday: 1, hour: 7, minute: 0 }, script: "scripts/scoreboard.mjs", label: SCHEDULE_LABEL });
	assert.match(text, /<string>\/b\/scripts\/scoreboard\.mjs<\/string>/);
	assert.match(text, /com\.relayevals\.relay-scoreboard/);
	assert.match(text, /<key>Hour<\/key>\n\t\t<integer>7<\/integer>/);
	const { runsDir, examDir, root } = await fixture();
	const to = join(root, "board.json");
	const out = spawnSync(process.execPath, ["scripts/scoreboard.mjs", "--runs", runsDir, "--exam", examDir, "--to", to, "--dry-run"], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root } });
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stdout, /SWE-bench Verified: complete/);
	assert.match(out.stdout, /Relay meta-harness/);
	assert.equal(existsSync(to), false);
	const wrote = spawnSync(process.execPath, ["scripts/scoreboard.mjs", "--runs", runsDir, "--exam", examDir, "--to", to, "--week", "2026-W43"], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root } });
	assert.equal(wrote.status, 0, wrote.stderr);
	assert.ok(existsSync(to));
});
