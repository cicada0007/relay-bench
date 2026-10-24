// Made-up runs for the meta-harness's and the scoreboard's tests: a Harbor stage (records and the transcripts each tool
// leaves) and an exam stage (run-stage records, patches and tasks). Nothing here is a real result.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const write = (path, text) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
};
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

/**
 * A Harbor stage folder `<stageDir>` with one trial per entry of `trials`: { task, tool, rep, solved, costUsd, wallMs,
 * infra, transcript, action } where transcript is "trajectory" (Claude Code, Codex), "session" (Relay), "codex-events"
 * or "none". Each transcript holds the task's words and one action (by default naming the tool and trial).
 */
export function fakeHarborStage(stageDir, { test, model, benchmark, trials }) {
	const records = [];
	for (const t of trials) {
		const short = t.task.split("/").pop();
		const jobName = `${test}-${short}-${t.tool}-r${t.rep}`;
		const trialName = `${short}__${t.tool}${t.rep}`;
		const agent = join(stageDir, "jobs", jobName, trialName, "agent");
		const words = `Fix the bug in ${short}.`;
		const action = t.action ?? `run ${t.tool} ${t.rep} on ${short}`;
		const transcript = t.transcript ?? (t.tool === "relay" ? "session" : "trajectory");
		if (transcript === "trajectory") {
			write(join(agent, "trajectory.json"), JSON.stringify({ steps: [{ source: "user", message: words }, { source: "agent", message: "All tests pass. Done!", tool_calls: [{ tool_call_id: "1", function_name: "Bash", arguments: { command: action } }], observation: { results: [{ source_call_id: "1", content: "ok" }] } }] }));
		} else if (transcript === "session") {
			write(join(agent, "sessions", "s.jsonl"), jsonl([{ type: "message", message: { role: "user", content: [{ type: "text", text: words }] } }, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Finished, it works." }, { type: "toolCall", id: "c", name: "bash", arguments: { command: action } }] } }, { type: "message", message: { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "ok" }] } }]));
		} else if (transcript === "codex-events") {
			write(join(agent, "codex.txt"), jsonl([{ type: "thread.started" }, { type: "item.completed", item: { type: "agent_message", text: "Done, all good." } }, { type: "item.completed", item: { type: "command_execution", command: action, aggregated_output: "ok", exit_code: 0 } }, { type: "turn.completed" }]));
		}
		records.push({
			test,
			benchmark,
			task: t.task,
			tool: t.tool,
			model,
			rep: t.rep,
			jobName,
			trialName: t.infra ? null : trialName,
			agent: { name: t.tool, version: t.version ?? { relay: "0.6.121", "claude-code": "2.1.300", codex: "0.163.0" }[t.tool] },
			reward: t.infra ? null : t.solved ? 1 : 0,
			solved: !t.infra && !!t.solved,
			exception: t.infra ? "SandboxException" : null,
			infra: !!t.infra,
			stoppedAtCap: false,
			usage: t.infra ? null : { costUsd: t.costUsd ?? 0.1 },
			wallMs: t.wallMs ?? 60_000,
			startedAt: t.startedAt ?? "2026-10-20T10:00:00Z",
		});
	}
	write(join(stageDir, "records.jsonl"), jsonl(records));
	return records;
}

/**
 * An exam: `<examDir>/tasks/<id>/{task.json,request.md}` (tier exam) and `<examDir>/runs/bar/records.jsonl` with one
 * run-stage record per entry of `runs` ({ test, task, tool, rep, share, costUsd }), each with its patch.
 */
export function fakeExam(examDir, { runs, model = "claude-haiku-5-5" }) {
	for (const task of new Set(runs.map((r) => r.task))) {
		write(join(examDir, "tasks", task, "task.json"), JSON.stringify({ id: task, kind: "everyday", tier: "exam" }));
		write(join(examDir, "tasks", task, "request.md"), `Change ${task}.\n`);
	}
	const records = runs.map((r) => {
		const runId = `${r.test}-${r.task}-${r.tool}-r${r.rep}`;
		write(join(examDir, "runs", "bar", runId, "result.patch.gz"), gzipSync(`diff --git a/src/${r.task}.js b/src/${r.task}.js\n+change ${r.tool} ${r.rep}\n`));
		return { test: r.test, task: r.task, tool: r.tool, model: r.model ?? model, rep: r.rep, runId, score: { share: r.share }, judge: { gates: { test: true } }, usage: { costUsd: r.costUsd ?? 0.2 }, wallMs: 120_000, startedAt: "2026-10-21T09:00:00Z" };
	});
	write(join(examDir, "runs", "bar", "records.jsonl"), jsonl(records));
	return records;
}

/** A picker that keeps the attempt whose evidence holds the text `prefer`, else A. It records every input it was shown. */
export function fakePicker(prefer, { model = "gpt-6.1-sol" } = {}) {
	const inputs = [];
	return {
		inputs,
		complete: async ({ input }) => {
			inputs.push(input);
			const parts = input.split(/^# Attempt /m).slice(1);
			const i = parts.findIndex((p) => p.includes(prefer));
			const letter = i === -1 ? "A" : parts[i][0];
			return { text: JSON.stringify({ pick: letter, confidence: 0.8, reason: "ran it" }), usage: { input_tokens: 2000, output_tokens: 100 }, model };
		},
	};
}
