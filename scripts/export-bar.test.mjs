// The bar's export for the website, on made-up records: numbers only, no words, and no exam task names.
import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze } from "../runner/analyze.mjs";
import { BAR_RELAY, BAR_STAGES, barResults, stageResult } from "./export-bar.mjs";

const TASKS = Array.from({ length: 24 }, (_, i) => `secret-exam-task-${i}`);
function records(stage, tools, scoreOf) {
	const out = [];
	for (const task of TASKS) {
		for (const tool of tools) {
			const share = scoreOf(tool, task);
			out.push({ runId: `${stage}-${task}-${tool}`, test: stage, task, tool, rep: 1, score: { share, requirementsMet: share, requirements: 1 }, saidDoneButFailed: share < 1 && tool !== "codex", usage: { costUsd: 0.05 }, wallMs: 120_000 });
		}
	}
	return out;
}
const haiku = records("bar-1-haiku", [BAR_RELAY, "claude-code", "prime-agent", "hermes"], (tool, task) => (tool === BAR_RELAY ? Number(task.length % 3 !== 0) : Number(task.length % 2 === 0)));
const openai = records("bar-1-openai", [BAR_RELAY, "codex"], (tool, task) => Number(tool === "codex" ? task.endsWith("1") : !task.endsWith("2")));

test("each stage's comparisons are analyze.mjs's own numbers, Relay's release minus each tool, and nothing else", () => {
	const stage = stageResult(BAR_STAGES[0], haiku);
	const expected = analyze(haiku, { relay: BAR_RELAY }).comparisons;
	assert.deepEqual(Object.keys(stage.comparisons), ["claude-code", "prime-agent", "hermes"]);
	for (const [tool, c] of Object.entries(stage.comparisons)) {
		assert.deepEqual(c, { name: { "claude-code": "Claude Code", "prime-agent": "Prime Agent", hermes: "Hermes" }[tool], tasks: 24, difference: expected[tool].difference, low: expected[tool].low, high: expected[tool].high });
	}
	assert.equal(stage.tools[BAR_RELAY].name, "Relay 0.6.121");
	assert.equal(stage.status, "complete");
	assert.equal(stage.runsNotMade, 0);
	assert.ok(Math.abs(stage.spentUsd - 0.05 * 96) < 1e-9);
});

test("the export holds no words and no task names", () => {
	const out = barResults({ "bar-1-haiku": haiku, "bar-1-openai": openai }, { generatedAt: "2026-10-23T00:00:00Z" });
	const text = JSON.stringify(out);
	for (const word of ["better", "worse", "no clear difference", "word"]) assert.ok(!text.includes(word), word);
	assert.ok(!text.includes("secret-exam-task"), "exam task names never leave the exam");
	assert.equal(out.stages[1].comparisons.codex.name, "Codex");
	assert.equal(out.stages[1].model, "gpt-6-luna");
	assert.equal(out.stages[2].status, "not run yet");
	assert.equal(out.status, "in progress");
	assert.match(out.statistics.interval, /10000 resamples, seed 20261015/);
});

test("a stage cut short says so, with a count of the runs it did not make", () => {
	const partial = haiku.filter((r) => !(r.tool === "hermes" && r.task.endsWith("3")));
	const stage = stageResult(BAR_STAGES[0], partial);
	assert.equal(stage.status, "in progress");
	assert.equal(stage.runsNotMade, 3); // Hermes on tasks 3, 13 and 23
	assert.equal(barResults({}).status, "not run yet");
});
