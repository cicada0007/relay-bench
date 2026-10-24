// loop/learned.mjs: what the week's release learned, in one or two plain sentences, numbers only: the change it ships
// and its measured result (the gate's once it ran, else the pre-screen's), the router rows it changes and the harness
// versions tried for the first time; and the changelog fragment that carries them into the release.
import assert from "node:assert/strict";
import { test } from "node:test";
import { changeWords, fragmentDiffs, fragmentPath, leafChanges, learnedLines, measuredWords } from "./learned.mjs";

const config = { id: "2026-W44-config-x", lane: "config", change: { kind: "arch", path: "queue.requestCheck", from: { maxChecks: 2, maxUnmet: 8 }, to: { maxChecks: 3, maxUnmet: 8 } } };
const router = {
	id: "2026-W44-routing-router-hard-bug",
	lane: "routing",
	change: {
		kind: "arch",
		path: "router.table",
		summary: "the hard-bug row from one Relay attempt to two attempts at once, Relay and Claude Code",
		row: { id: "hard-bug", from: [{ harness: "relay", strategy: "direct" }], to: [{ harness: "relay", strategy: "direct" }, { harness: "claude-code", strategy: "direct", otherwise: { harness: "relay", strategy: "reproduce-first" } }] },
	},
};
const skill = { id: "s", lane: "prompts", change: { kind: "skill", skill: "read-the-tests-first", file: "skills/read-the-tests-first/SKILL.md" } };
const prompt = { id: "p", lane: "prompts", change: { kind: "prompt", file: "src/queue/request-check.ts", symbol: "REQUEST_CHECK_PROMPT", prompt: "queue.requestCheck" } };
const dev = (id, difference, low, high) => ({ id, status: "passed", dev: { tasks: 24, difference, low, high } });
const RESULT_WORDS = /\b(better|worse|beats?|beaten|outperform\w*|wins?|won|loses?|lost|best|worst|improv\w*|regress\w*|clear difference)\b/i;

test("each kind of change in a few words: a value of relay.arch, a router row, a skill, a prompt", () => {
	assert.deepEqual(leafChanges("queue.requestCheck", config.change.from, config.change.to), [{ path: "queue.requestCheck.maxChecks", from: 2, to: 3 }]);
	assert.deepEqual(leafChanges("a", { b: 1 }, { b: 1, c: [1] }), [{ path: "a.c", from: undefined, to: [1] }]);
	assert.equal(changeWords(config), "to set queue.requestCheck.maxChecks from 2 to 3");
	assert.equal(changeWords(router), "to start two attempts at once, Relay and Claude Code, on its router's hard-bug row, where it started one Relay attempt");
	assert.equal(changeWords(skill), "a new skill, read-the-tests-first, from lessons people chose to share");
	assert.equal(changeWords(prompt), "new words for its queue.requestCheck prompt");
	assert.equal(changeWords({ change: { kind: "arch", path: "x", from: { a: 1, b: 1, c: 1 }, to: { a: 2, b: 2, c: 2 } } }), "to set x.a from 1 to 2 and x.b from 1 to 2 and 1 more of x");
});

test("the measured result: the gate's on the exam once it ran, else each lane's pre-screen, with its interval", () => {
	assert.equal(measuredWords({ chosen: [config], results: [dev(config.id, 2.5, -1.2, 6.2)], champion: "0.6.121" }), "its pre-screen measured +2.5 points (interval -1.2 to 6.2, 24 practice tasks) against relay@0.6.121");
	assert.equal(
		measuredWords({ chosen: [config, router], results: [dev(config.id, 2.5, -1.2, 6.2), dev(router.id, -0.4, -3, 2)] }),
		"its pre-screens measured +2.5 points (interval -1.2 to 6.2, 24 practice tasks) and -0.4 points (interval -3.0 to 2.0, 24 practice tasks)",
	);
	assert.equal(measuredWords({ chosen: [config], results: [], gate: { difference: 1.2, low: -0.8, high: 3.1, tasks: 120, status: "PASS" }, champion: "0.6.121" }), "the gate on the exam measured +1.2 points of requirements met against relay@0.6.121 (interval -0.8 to 3.1, 120 tasks, PASS)");
	assert.equal(measuredWords({ chosen: [config], results: [] }), "nothing has measured it yet");
});

test("one or two plain sentences: the change and its result, then the router rows it changes and the new harness versions", () => {
	const gate = { difference: 1.2, low: -0.8, high: 3.1, tasks: 120, status: "PASS" };
	const lines = learnedLines({ cycle: "2026-W44", chosen: [config, router], results: [], gate, champion: "0.6.121", harnesses: ["Claude Code 2.1.310 (its exam stage is queued for a person)"] });
	assert.deepEqual(lines, [
		"In week 2026-W44 Relay learned to set queue.requestCheck.maxChecks from 2 to 3 and to start two attempts at once, Relay and Claude Code, on its router's hard-bug row, where it started one Relay attempt; the gate on the exam measured +1.2 points of requirements met against relay@0.6.121 (interval -0.8 to 3.1, 120 tasks, PASS).",
		"It changes the router's hard-bug row, and this week's new harness version is Claude Code 2.1.310 (its exam stage is queued for a person).",
	]);
	assert.equal(learnedLines({ cycle: "2026-W44", chosen: [config], results: [dev(config.id, 2.5, -1.2, 6.2)], harnesses: [] })[1], "It changes no row of the router's starting table, and no new harness version came out this week.");
	assert.equal(learnedLines({ cycle: "2026-W44", chosen: [skill] })[1], "It changes no row of the router's starting table.", "no harness watch ran: nothing said about harnesses");
	assert.match(learnedLines({ cycle: "2026-W44", chosen: [config], harnesses: ["A 1.0.0 (x)", "B 2.0.0 (y)"] })[1], /this week's new harness versions are A 1\.0\.0 \(x\) and B 2\.0\.0 \(y\)\.$/);
	assert.deepEqual(learnedLines({ cycle: "2026-W44", chosen: [] }), []);
	for (const line of lines) assert.doesNotMatch(line, RESULT_WORDS);
});

test("the changelog fragment: Relay's package always, another package when the patch changes its src, never over a file", () => {
	const readme = new Set(["packages/coding-agent/.changes/README.md", "packages/ai/.changes/README.md", "packages/tui/.changes/README.md"]);
	const sources = (file) => (readme.has(file) ? "# Changelog fragments\n" : null);
	const lines = ["In week 2026-W44 Relay learned x.", "It changes no row of the router's starting table."];
	const only = fragmentDiffs({ cycle: "2026-W44", lines, patch: "diff --git a/relay.arch.json b/relay.arch.json\n", sources });
	assert.deepEqual(only.files, ["packages/coding-agent/.changes/loop-2026-w44.md"]);
	assert.equal(only.text, "- In week 2026-W44 Relay learned x. It changes no row of the router's starting table.\n");
	assert.match(only.patch, /^diff --git a\/packages\/coding-agent\/\.changes\/loop-2026-w44\.md b\/packages\/coding-agent\/\.changes\/loop-2026-w44\.md\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/packages\/coding-agent\/\.changes\/loop-2026-w44\.md\n@@ -0,0 \+1,1 @@\n\+- In week 2026-W44/);
	const ai = fragmentDiffs({ cycle: "2026-W44", lines, patch: "diff --git a/packages/ai/src/x.ts b/packages/ai/src/x.ts\ndiff --git a/packages/agent/src/y.ts b/packages/agent/src/y.ts\n", sources });
	assert.deepEqual(ai.files, ["packages/coding-agent/.changes/loop-2026-w44.md", "packages/ai/.changes/loop-2026-w44.md"], "agent keeps no fragments here");
	const taken = (file) => (file === fragmentPath("coding-agent", "2026-W44") ? "- someone's\n" : sources(file));
	assert.deepEqual(fragmentDiffs({ cycle: "2026-W44", lines, patch: "", sources: taken }).files, []);
	assert.deepEqual(fragmentDiffs({ cycle: "2026-W44", lines, patch: "", sources: () => null }).files, [], "a harness without fragments gets none");
	assert.deepEqual(fragmentDiffs({ cycle: "2026-W44", lines: [], patch: "", sources }).files, []);
});
