// meta/pick-groups.mjs: the meta-harness scored from any records file and any arms, the picker blind to grades and
// tools, its cost counted, sealed tasks counted against the leak budget.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readTasks } from "../runner/stage-tasks.mjs";
import { openLedger } from "../scripts/draft-spend.mjs";
import { harborAttempt } from "./evidence.mjs";
import { fakeExam, fakeHarborStage, fakePicker } from "./fakes.mjs";
import { buildGroups, defaultArms, harborLoader, metaEntry, parseArms, patchLoader, runPicks } from "./pick-groups.mjs";
import { stepsFromCodexEvents } from "./pick.mjs";

const quiet = () => {};
const T = (task) => `swe-bench/${task}`;

/** t1 and t2 split once each, t3's infrastructure failed (dropped for every tool). */
function stage() {
	const root = mkdtempSync(join(tmpdir(), "pick-groups-"));
	const stageDir = join(root, "scoreboard", "swebench-verified");
	const records = fakeHarborStage(stageDir, {
		test: "swebench-verified",
		model: "claude-haiku-5-5",
		benchmark: "swebench-verified",
		trials: [
			{ task: T("t1"), tool: "relay", rep: 1, solved: true },
			{ task: T("t1"), tool: "claude-code", rep: 1, solved: false },
			{ task: T("t1"), tool: "relay", rep: 2, solved: true },
			{ task: T("t1"), tool: "claude-code", rep: 2, solved: true },
			{ task: T("t2"), tool: "relay", rep: 1, solved: false },
			{ task: T("t2"), tool: "claude-code", rep: 1, solved: false },
			{ task: T("t2"), tool: "relay", rep: 2, solved: false },
			{ task: T("t2"), tool: "claude-code", rep: 2, solved: true },
			{ task: T("t3"), tool: "relay", rep: 1, infra: true },
			{ task: T("t3"), tool: "claude-code", rep: 1, solved: true },
		],
	});
	return { root, stageDir, records };
}

test("arms are tools, or tools pinned to a trial, never a mix", () => {
	assert.deepEqual(parseArms("claude-code,relay").map((a) => [a.tool, a.rep]), [["claude-code", null], ["relay", null]]);
	assert.deepEqual(parseArms("claude-code#1,claude-code#2").map((a) => [a.tool, a.rep]), [["claude-code", 1], ["claude-code", 2]]);
	assert.throws(() => parseArms("relay"), /at least two arms/);
	assert.throws(() => parseArms("relay#1,claude-code"), /either every arm/);
	assert.throws(() => parseArms("relay,relay"), /named twice/);
	assert.deepEqual(defaultArms([{ tool: "relay@0.6.121" }, { tool: "codex" }, { tool: "claude-code" }]).map((a) => a.tool), ["claude-code", "codex", "relay@0.6.121"]);
});

test("groups pair the arms' attempts by trial, drop a task whose infrastructure failed, and count a missing attempt", () => {
	const { records } = stage();
	const arms = parseArms("claude-code,relay");
	const { groups, missing, dropped } = buildGroups(records, arms);
	assert.deepEqual(dropped, [T("t3")]);
	assert.deepEqual(groups.map((g) => g.key), [`${T("t1")}|r1`, `${T("t1")}|r2`, `${T("t2")}|r1`, `${T("t2")}|r2`]);
	assert.deepEqual(groups[0].attempts.map((a) => [a.label, a.outcome]), [["claude-code r1", 0], ["relay r1", 1]]);
	const without = buildGroups(records.filter((r) => !(r.task === T("t2") && r.tool === "relay" && r.rep === 2)), arms);
	assert.deepEqual(without.missing, [{ key: `${T("t2")}|r2`, arms: ["relay"] }]);
	assert.equal(missing.length, 0);
	const pinned = buildGroups(records, parseArms("claude-code#1,claude-code#2"));
	assert.deepEqual(pinned.groups.map((g) => g.key), [`${T("t1")}|claude-code#1+claude-code#2`, `${T("t2")}|claude-code#1+claude-code#2`]);
	const three = buildGroups([...records, ...records.filter((r) => r.tool === "relay").map((r) => ({ ...r, tool: "codex" }))], parseArms("claude-code,codex,relay"));
	assert.equal(three.groups[0].attempts.length, 3);
});

test("asked about every group, the picker never sees a grade or a tool's name, and its choice is scored with its cost", async () => {
	const root = mkdtempSync(join(tmpdir(), "pick-blind-"));
	const stageDir = join(root, "stage");
	const records = fakeHarborStage(stageDir, {
		test: "swebench-verified",
		model: "claude-haiku-5-5",
		benchmark: "swebench-verified",
		trials: [
			{ task: T("a"), tool: "relay", rep: 1, solved: true, action: "pytest -q passes 12" },
			{ task: T("a"), tool: "claude-code", rep: 1, solved: false, action: "edit setup.cfg only" },
			{ task: T("b"), tool: "relay", rep: 1, solved: true, action: "pytest -q passes 3" },
			{ task: T("b"), tool: "claude-code", rep: 1, solved: true, action: "pytest -q passes 4" },
		],
	});
	const arms = parseArms("claude-code,relay");
	const { groups } = buildGroups(records, arms);
	const picker = fakePicker("pytest -q passes 12");
	const ledger = openLedger(join(root, "spend.json"), { caps: { openai: 1 } });
	const out = join(stageDir, "meta", "picks.jsonl");
	const result = await runPicks({ groups, loader: harborLoader(stageDir), benchModel: "claude-haiku-5-5", test: "swebench-verified", model: picker, ledger, out, log: quiet });
	assert.equal(picker.inputs.length, 2, "every group is asked, the unsplit one too");
	for (const input of picker.inputs) {
		assert.doesNotMatch(input, /claude-code|relay|solved|reward|"share"|outcome/i);
		assert.doesNotMatch(input, /All tests pass|Done!|Finished, it works/, "no tool's words about its own work");
	}
	const a = result.rows.find((r) => r.key === `${T("a")}|r1`);
	assert.equal(a.labels[a.picked], "relay r1");
	assert.equal(a.metaOutcome, 1);
	const entry = metaEntry({ rows: result.rows, groups, left: result.left, arms });
	assert.equal(entry.score, 100);
	assert.equal(entry.groupsAsked, 2);
	assert.equal(entry.pickerEstimatedUsd, 0);
	assert.ok(entry.pickerUsd > 0);
	assert.ok(Math.abs(entry.costUsd - (0.4 + entry.pickerUsd)) < 1e-9, "every attempt plus the picker");
	assert.equal(entry.costPerSolvedUsd, entry.costUsd / 2);
	assert.ok(ledger.totals().openai.spentUsd > 0);
	assert.equal(readFileSync(out, "utf8").trim().split("\n").length, 2);
	const again = await runPicks({ groups, loader: harborLoader(stageDir), benchModel: "claude-haiku-5-5", test: "swebench-verified", model: picker, ledger, out, log: quiet });
	assert.equal(picker.inputs.length, 2, "a second run reuses every answer");
	assert.deepEqual(again.rows.map((r) => r.metaOutcome), result.rows.map((r) => r.metaOutcome));
});

test("asked only about split groups, the score is the same and the picker's cost on the rest is estimated", async () => {
	const { root, stageDir, records } = stage();
	const arms = parseArms("claude-code,relay");
	const { groups } = buildGroups(records, arms);
	const run = async (ask, dir) => {
		const picker = fakePicker("run relay ");
		const result = await runPicks({ groups, loader: harborLoader(stageDir), benchModel: "m", test: "x", model: picker, ledger: openLedger(join(root, `${dir}.json`), { caps: { openai: 1 } }), out: join(root, dir, "picks.jsonl"), ask, log: quiet });
		return { picker, entry: metaEntry({ rows: result.rows, groups, left: result.left, arms }) };
	};
	const every = await run("every", "every");
	const split = await run("split", "split");
	assert.equal(every.picker.inputs.length, 4);
	assert.equal(split.picker.inputs.length, 2);
	// t1: relay right in r1, r2 unsplit solved -> 100; t2: relay wrong in r2, r1 unsplit failed -> 0.
	assert.equal(every.entry.score, 50);
	assert.equal(split.entry.score, 50);
	assert.equal(split.entry.groupsPickerEstimated, 2);
	assert.ok(Math.abs(split.entry.pickerEstimatedUsd - split.entry.pickerUsd) < 1e-12, "two asked, two estimated at the asked mean");
	assert.ok(Math.abs(split.entry.costUsd - every.entry.costUsd) < 1e-9);
	assert.equal(every.entry.attemptsUsd, 0.8);
	assert.equal(every.entry.splitGroups, 2);
	assert.equal(every.entry.pickedTopGraded, 1);
	assert.equal(every.entry.bestPossible, 75, "the grader's choice: t1 100, t2 50");
	assert.ok(Math.abs(every.entry.medianMinutes - 1) < 0.01, "the slowest attempt (1 minute) plus the picker's measured time");
});

test("answers from another file count when the evidence is the same, so nothing is asked again", async () => {
	const { root, stageDir, records } = stage();
	const arms = parseArms("claude-code,relay");
	const { groups } = buildGroups(records, arms);
	const first = await runPicks({ groups, loader: harborLoader(stageDir), benchModel: "m", test: "x", model: fakePicker("run relay "), ledger: openLedger(join(root, "s.json"), { caps: { openai: 1 } }), out: join(root, "elsewhere.jsonl"), ask: "split", log: quiet });
	const reuse = readFileSync(join(root, "elsewhere.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const picker = fakePicker("run relay ");
	const out = join(stageDir, "meta", "picks.jsonl");
	const second = await runPicks({ groups, loader: harborLoader(stageDir), benchModel: "m", test: "x", model: picker, ledger: null, out, reuse, ask: "split", log: quiet });
	assert.equal(picker.inputs.length, 0);
	assert.equal(second.toCall, 0);
	assert.equal(second.complete, true);
	assert.deepEqual(second.rows.map((r) => r.metaOutcome), first.rows.map((r) => r.metaOutcome));
	assert.equal(readFileSync(out, "utf8").trim().split("\n").length, 2, "the reused answers are copied beside the stage");
});

test("with no spending cap nothing is asked; a split group with no record of actions is left out", async () => {
	const root = mkdtempSync(join(tmpdir(), "pick-left-"));
	const stageDir = join(root, "stage");
	const records = fakeHarborStage(stageDir, {
		test: "s",
		model: "m",
		benchmark: "b",
		trials: [
			{ task: T("a"), tool: "relay", rep: 1, solved: true, transcript: "none" },
			{ task: T("a"), tool: "claude-code", rep: 1, solved: false },
			{ task: T("b"), tool: "relay", rep: 1, solved: true, transcript: "none" },
			{ task: T("b"), tool: "claude-code", rep: 1, solved: true },
			{ task: T("c"), tool: "relay", rep: 1, solved: true },
			{ task: T("c"), tool: "claude-code", rep: 1, solved: false },
		],
	});
	const arms = parseArms("claude-code,relay");
	const { groups } = buildGroups(records, arms);
	const picker = fakePicker("run relay ");
	const result = await runPicks({ groups, loader: harborLoader(stageDir), benchModel: "m", test: "s", model: picker, ledger: null, out: join(root, "p.jsonl"), log: quiet });
	assert.equal(picker.inputs.length, 0);
	assert.equal(result.needsCap, true);
	assert.equal(result.complete, false);
	assert.deepEqual(result.left.map((l) => l.key), [`${T("a")}|r1`]);
	assert.deepEqual(result.rows.map((r) => r.key), [`${T("b")}|r1`], "an unsplit group is decided without a call, whatever its transcripts");
	const entry = metaEntry({ rows: result.rows, groups, left: result.left, arms });
	assert.equal(entry.groupsLeftOut, 1);
	assert.equal(entry.groupsNotDecided, 1);
});

test("Codex's event stream gives its commands and their output, never its messages", () => {
	const root = mkdtempSync(join(tmpdir(), "pick-codex-"));
	const [r] = fakeHarborStage(join(root, "s"), { test: "s", model: "gpt-6-luna", benchmark: "b", trials: [{ task: T("a"), tool: "codex", rep: 1, solved: true, transcript: "codex-events" }] });
	const attempt = harborAttempt(join(root, "s"), r);
	assert.equal(attempt.kept, true);
	assert.deepEqual(attempt.steps, [{ call: "shell: run codex 1 on a", output: "ok\n(exit code 0)" }]);
	const steps = stepsFromCodexEvents(
		[
			{ type: "item.completed", item: { type: "reasoning", text: "secret plan" } },
			{ type: "item.completed", item: { type: "file_change", changes: [{ path: "src/a.py", kind: "update" }], status: "completed" } },
			{ type: "item.started", item: { type: "command_execution", command: "partial" } },
		]
			.map((e) => JSON.stringify(e))
			.join("\n"),
	);
	assert.deepEqual(steps, [{ call: "file_change: update src/a.py", output: "completed" }]);
});

test("on the sealed exam each call is counted against the leak budget first, and a spent budget stops the call", async () => {
	const root = mkdtempSync(join(tmpdir(), "pick-exam-sealed-"));
	const examDir = join(root, "relay-exam");
	const records = fakeExam(examDir, {
		runs: [
			{ test: "bar-1-haiku", task: "e1", tool: "relay@0.6.121", rep: 1, share: 1 },
			{ test: "bar-1-haiku", task: "e1", tool: "claude-code", rep: 1, share: 0 },
			{ test: "bar-1-haiku", task: "e2", tool: "relay@0.6.121", rep: 1, share: 0 },
			{ test: "bar-1-haiku", task: "e2", tool: "claude-code", rep: 1, share: 1 },
		],
	});
	const tasksDir = join(examDir, "tasks");
	const runsDir = join(examDir, "runs", "bar");
	const arms = defaultArms(records);
	const { groups } = buildGroups(records, arms);
	const tierOf = new Map([...readTasks(tasksDir)].map(([id, t]) => [id, t.tier]));
	const sealed = { tasksDir, test: "bar-1-haiku", tierOf };
	const picker = fakePicker("change relay@0.6.121 ");
	const result = await runPicks({ groups, loader: patchLoader(runsDir, [tasksDir]), benchModel: "claude-haiku-5-5", test: "bar-1-haiku", model: picker, ledger: openLedger(join(root, "s.json"), { caps: { openai: 1 } }), out: join(runsDir, "meta", "p.jsonl"), sealed, log: quiet });
	assert.equal(picker.inputs.length, 2);
	assert.match(picker.inputs[0], /The project's own checks on the result: test: passed/);
	const exposures = readFileSync(join(examDir, "exposure.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(exposures.map((e) => [e.kind, e.tier, e.tasks[0], e.by]), [["run", "exam", "e1", "meta-pick"], ["run", "exam", "e2", "meta-pick"]]);
	assert.equal(metaEntry({ rows: result.rows, groups, arms }).score, 50);

	writeFileSync(join(examDir, "leak-budget.json"), JSON.stringify({ exam: { runsPerTask: 0 } }));
	const blocked = fakePicker("x");
	const none = await runPicks({ groups, loader: patchLoader(runsDir, [tasksDir]), benchModel: "claude-haiku-5-5", test: "bar-1-haiku", model: blocked, ledger: openLedger(join(root, "s2.json"), { caps: { openai: 1 } }), out: join(root, "p2.jsonl"), sealed, log: quiet });
	assert.equal(blocked.inputs.length, 0);
	assert.equal(none.rows.length, 0);
	assert.equal(existsSync(join(root, "p2.jsonl")), false);
});
