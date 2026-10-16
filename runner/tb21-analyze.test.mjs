import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeTb21 } from "./tb21-analyze.mjs";

const trial = (tool, task, solved, extra = {}) => ({ tool, task, solved, usage: { costUsd: 0.01 }, wallMs: 60_000, ...extra });

test("solved share is a mean over tasks of each task's mean over trials", () => {
	const { tools } = analyzeTb21([
		trial("relay", "a", true), trial("relay", "a", false),
		trial("relay", "b", true), trial("relay", "b", true),
		trial("claude-code", "a", false), trial("claude-code", "a", false),
		trial("claude-code", "b", true), trial("claude-code", "b", false),
	]);
	assert.equal(tools.relay.solvedShare, 75);
	assert.equal(tools["claude-code"].solvedShare, 25);
	assert.equal(tools.relay.allTrialsSolved, 50);
	assert.equal(tools.relay.costPerSolvedUsd, 0.04 / 3);
});

test("a task with an infrastructure failure is dropped for every tool", () => {
	const { tools, dropped, comparisons } = analyzeTb21([
		trial("relay", "a", true), trial("claude-code", "a", false),
		trial("relay", "b", false), trial("claude-code", "b", true),
		trial("relay", "c", true), trial("claude-code", "c", false, { infra: true }),
	]);
	assert.deepEqual(dropped, ["c"]);
	assert.equal(tools.relay.tasks, 2);
	assert.equal(tools["claude-code"].tasks, 2);
	assert.equal(comparisons["claude-code"].tasks, 2);
	assert.equal(comparisons["claude-code"].difference, 0);
});
