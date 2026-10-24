// meta/pick.mjs and meta/pick-exam.mjs: the picker sees evidence only, blind to the harness, and the exam scores it
// from what the grader already said.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { openLedger } from "../scripts/draft-spend.mjs";
import { parsePick, patchEvidence, pick, showOrder, stepsFromClaudeStream, stepsFromRelaySession, stepsFromTrajectory, workLog } from "./pick.mjs";
import { runExam } from "./pick-exam.mjs";

test("a work log over budget keeps the first actions and the last, and says how many it left out", () => {
	const steps = Array.from({ length: 60 }, (_, i) => ({ call: `bash: step ${i + 1}`, output: "x".repeat(400) }));
	const log = workLog(steps, 6_000);
	assert.ok(log.length <= 6_000);
	assert.match(log, /^\[1\] bash: step 1/);
	assert.match(log, /\[4\] bash: step 4/);
	assert.doesNotMatch(log, /\[5\] bash: step 5\n/);
	assert.match(log, /\[60\] bash: step 60/);
	assert.match(log, /\[… \d+ actions omitted …\]/);
	assert.equal(workLog([]), "(no actions recorded)");
});

test("a long output keeps its start and its end", () => {
	const log = workLog([{ call: "bash: make", output: `START${"m".repeat(5_000)}END` }]);
	assert.match(log, /START/);
	assert.match(log, /END/);
	assert.match(log, /characters …\]/);
});

test("from a trajectory the picker gets calls and outputs, never the agent's own words", () => {
	const steps = stepsFromTrajectory({
		steps: [
			{ source: "user", message: "Do the task." },
			{ source: "agent", message: "I will check R.", tool_calls: [{ tool_call_id: "t1", function_name: "Bash", arguments: { command: "which R" } }], observation: { results: [{ source_call_id: "t1", content: "R: command not found" }] } },
			{ source: "agent", message: "All 29 tests pass. Done!" },
		],
	});
	assert.deepEqual(steps, [{ call: "Bash: which R", output: "R: command not found" }]);
	assert.doesNotMatch(JSON.stringify(steps), /Done|tests pass|I will/);
});

test("from a Relay session the picker gets tool calls and their results, never text or thinking", () => {
	const lines = [
		{ type: "session" },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "Do the task." }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret plan" }, { type: "text", text: "Finished, everything works." }, { type: "toolCall", id: "c1", name: "ipython", arguments: { code: "print(1)" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "1" }] } },
	];
	const steps = stepsFromRelaySession(`${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`);
	assert.deepEqual(steps, [{ call: "ipython: print(1)", output: "1" }]);
});

test("Relay's event stream and Claude Code's stream give the same kind of actions", () => {
	const events = [
		{ type: "message_update", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "partial" } }] } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }, { type: "toolCall", id: "c1", name: "ipython", arguments: { code: "ls" } }] } },
		{ type: "message_end", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "a.txt" }] } },
	];
	assert.deepEqual(stepsFromRelaySession(events.map((e) => JSON.stringify(e)).join("\n")), [{ call: "ipython: ls", output: "a.txt" }]);
	const stream = [
		{ type: "system", subtype: "init" },
		{ type: "assistant", message: { content: [{ type: "text", text: "All good." }, { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/app/x.py", content: "print(1)" } }] } },
		{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "File created" }] } },
		{ type: "result", subtype: "success", result: "Finished, all tests pass." },
	];
	const steps = stepsFromClaudeStream(stream.map((e) => JSON.stringify(e)).join("\n"));
	assert.deepEqual(steps, [{ call: "Write /app/x.py (8 characters):\nprint(1)", output: "File created" }]);
	assert.doesNotMatch(JSON.stringify(steps), /All good|Finished/);
});

test("a patch loses lockfiles and a harness's own notes, and keeps the code", () => {
	const patch = [
		"diff --git a/.relay/reports/x.md b/.relay/reports/x.md\n+all done\n",
		"diff --git a/package-lock.json b/package-lock.json\n+lock\n",
		"diff --git a/src/a.js b/src/a.js\n+export const a = 1;\n",
	].join("");
	const shown = patchEvidence(patch);
	assert.match(shown, /src\/a\.js/);
	assert.doesNotMatch(shown, /all done|lock\n/);
	assert.equal(patchEvidence("diff --git a/.relay/r.md b/.relay/r.md\n+x\n"), "(the attempt changed no files)");
	assert.match(patchEvidence(`diff --git a/a b/a\n${"+x\n".repeat(50)}diff --git a/b b/b\n${"+y\n".repeat(50)}`, 200), /not shown for lack of room: b/);
});

test("the show order is fixed by the task and does not favor the first attempt", () => {
	assert.deepEqual(showOrder("t|r1", 2), showOrder("t|r1", 2));
	let firstShownFirst = 0;
	for (let i = 0; i < 400; i++) {
		const order = showOrder(`task-${i}|r1`, 2);
		assert.deepEqual([...order].sort(), [0, 1]);
		if (order[0] === 0) firstShownFirst++;
	}
	assert.ok(firstShownFirst > 160 && firstShownFirst < 240, `attempt 0 shown first ${firstShownFirst} of 400 times`);
});

test("an answer is read from JSON anywhere in the reply, and a letter not shown is no answer", () => {
	assert.deepEqual(parsePick('Here: {"pick": "b", "confidence": 0.8, "reason": "ran it"}', 2), { shown: 1, confidence: 0.8, reason: "ran it" });
	assert.equal(parsePick('{"pick": "C"}', 2), null);
	assert.equal(parsePick("A", 2), null);
	assert.equal(parsePick("{not json}", 2), null);
});

test("pick maps the letter it was shown back to the attempt it stands for", async () => {
	const key = [...Array(50).keys()].map((i) => `k${i}`).find((k) => showOrder(k, 2)[0] === 1);
	let seen = "";
	const result = await pick({ key, task: "T", evidence: ["first", "second"], complete: async ({ input }) => ((seen = input), { text: '{"pick":"A","confidence":0.9,"reason":"r"}' }) });
	assert.ok(seen.indexOf("second") < seen.indexOf("first"), "attempt 1 is shown as A");
	assert.equal(result.index, 1);
});

/** A round with two Terminal-Bench tasks (one split, one not) and one test A request (split). */
function fakeRound() {
	const root = mkdtempSync(join(tmpdir(), "pick-exam-"));
	const round = join(root, "round-1");
	const tasks = join(root, "tasks");
	const tb = [];
	const trial = (task, tool, rep, solved) => {
		const jobName = `F-${task}-${tool}-r${rep}`, trialName = `${task}__x`;
		const agent = join(round, "F", "jobs", jobName, trialName, "agent");
		mkdirSync(join(agent, "sessions"), { recursive: true });
		if (tool === "claude-code") {
			writeFileSync(join(agent, "trajectory.json"), JSON.stringify({ steps: [{ source: "user", message: `Task ${task}` }, { source: "agent", message: "ok", tool_calls: [{ tool_call_id: "1", function_name: "Bash", arguments: { command: `run ${tool} ${rep}` } }], observation: { results: [{ source_call_id: "1", content: "out" }] } }] }));
		} else {
			writeFileSync(join(agent, "sessions", "s.jsonl"), [{ type: "message", message: { role: "user", content: [{ type: "text", text: `Task ${task}` }] } }, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "ipython", arguments: { code: `run ${tool} ${rep}` } }] } }].map((l) => JSON.stringify(l)).join("\n"));
		}
		tb.push({ test: "F", task: `terminal-bench/${task}`, tool, rep, jobName, trialName, solved, infra: false, usage: { costUsd: 0.1 } });
	};
	for (const rep of [1, 2]) {
		trial("split", "claude-code", rep, rep === 1);
		trial("split", "relay", rep, true);
		trial("same", "claude-code", rep, true);
		trial("same", "relay", rep, true);
	}
	tb.push({ test: "F", task: "terminal-bench/broken", tool: "relay", rep: 1, infra: true, solved: false });
	writeFileSync(join(round, "F", "records.jsonl"), `${tb.map((r) => JSON.stringify(r)).join("\n")}\n`);
	const a = [];
	for (const tool of ["claude-code", "relay"]) {
		const runId = `A-req-${tool}-r1`;
		mkdirSync(join(round, runId), { recursive: true });
		writeFileSync(join(round, runId, "result.patch.gz"), gzipSync(`diff --git a/src/${tool}.js b/src/${tool}.js\n+change by ${tool}\n`));
		a.push({ test: "A", task: "req", tool, rep: 1, runId, score: { share: tool === "relay" ? 1 : 0.5 }, judge: { gates: { test: true, lint: true } }, usage: { costUsd: 1 } });
	}
	writeFileSync(join(round, "records.jsonl"), `${a.map((r) => JSON.stringify(r)).join("\n")}\n`);
	mkdirSync(join(tasks, "req"), { recursive: true });
	writeFileSync(join(tasks, "req", "request.md"), "Make the change.\n");
	return { root, round, tasks };
}

test("the exam asks only about pairs the grader split, scores the picks, and reuses answers on a second run", async () => {
	const { root, round, tasks } = fakeRound();
	const asked = [];
	// A picker that always chooses the attempt whose evidence names Relay.
	const model = {
		complete: async ({ input }) => {
			asked.push(input);
			const a = input.indexOf("# Attempt A"), b = input.indexOf("# Attempt B");
			const aText = input.slice(a, b);
			return { text: JSON.stringify({ pick: /relay/.test(aText) ? "A" : "B", confidence: 0.9, reason: "r" }), usage: { input_tokens: 1000, output_tokens: 100 }, model: "gpt-6-luna" };
		},
	};
	const ledger = openLedger(join(root, "spend.json"), { caps: { openai: 1 } });
	const out = join(root, "out.jsonl");
	const args = { round, tasksDirs: [tasks], families: ["tb-relay-cc", "tb-cc-cc", "a-relay-cc"], dropped: [], model, modelId: "gpt-6-luna", effort: "low", ledger, out, log: () => {} };
	const first = await runExam(args);
	// Split pairs: tb-relay-cc split|r2 (CC failed, Relay solved), tb-cc-cc split (r1 solved, r2 failed), a-relay-cc req|r1.
	assert.equal(asked.length, 3);
	assert.ok(asked.every((input) => !/"solved"|share|outcome/.test(input)), "the picker never sees a grade");
	const s = first.summary;
	assert.equal(s["tb-relay-cc"].pairs, 4);
	assert.equal(s["tb-relay-cc"].base, 75);
	assert.equal(s["tb-relay-cc"].meta, 100);
	assert.equal(s["tb-relay-cc"].perfect, 100);
	assert.equal(s["a-relay-cc"].base, 50);
	assert.equal(s["a-relay-cc"].meta, 100);
	assert.equal(s["tb-cc-cc"].pairs, 2);
	assert.equal(first.complete, true);
	assert.ok(ledger.totals().openai.spentUsd > 0);
	assert.equal(readFileSync(out, "utf8").trim().split("\n").length, 3);
	const second = await runExam(args);
	assert.equal(asked.length, 3, "a second run reuses every answer");
	assert.deepEqual(second.summary, first.summary);
});

test("a split pair whose attempt kept no actions is left out, and an answer naming nothing is asked once more", async () => {
	const { root, round, tasks } = fakeRound();
	const records = readFileSync(join(round, "F", "records.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const lost = records.find((r) => r.task === "terminal-bench/split" && r.tool === "relay" && r.rep === 2);
	const { rmSync } = await import("node:fs");
	rmSync(join(round, "F", "jobs", lost.jobName), { recursive: true });
	let calls = 0;
	const model = { complete: async () => (calls++, { text: calls === 1 ? "I cannot decide." : '{"pick":"A","confidence":0.6,"reason":"r"}', usage: { input_tokens: 10, output_tokens: 10 }, model: "gpt-6-luna" }) };
	const ledger = openLedger(join(root, "spend.json"), { caps: { openai: 1 } });
	const result = await runExam({ round, tasksDirs: [tasks], families: ["tb-relay-cc", "tb-cc-cc"], dropped: [], model, modelId: "gpt-6-luna", effort: "low", ledger, out: join(root, "out.jsonl"), concurrency: 1, log: () => {} });
	assert.deepEqual(result.left.map((l) => l.key), ["terminal-bench/split|r2"]);
	assert.equal(result.summary["tb-relay-cc"].pairs, 3, "the left-out pair counts in no score");
	assert.equal(calls, 2, "the cc-cc pair is asked twice: once with no answer, once more");
	assert.equal(result.summary["tb-cc-cc"].unanswered, 0);
	assert.equal(result.complete, true);
});

test("with no spending cap the exam calls nothing", async () => {
	const { root, round, tasks } = fakeRound();
	let calls = 0;
	const model = { complete: async () => (calls++, { text: '{"pick":"A"}' }) };
	const ledger = openLedger(join(root, "spend.json"));
	const result = await runExam({ round, tasksDirs: [tasks], families: ["tb-relay-cc"], dropped: [], model, modelId: "gpt-6-luna", effort: "low", ledger, out: join(root, "out.jsonl"), log: () => {} });
	assert.equal(calls, 0);
	assert.equal(result.complete, false);
});
