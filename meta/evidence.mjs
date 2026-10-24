// What the picker may be shown of one finished attempt, read from what its run kept: the actions it took and what came
// back (a Harbor trial: Terminal-Bench, SWE-bench), or its patch and the project's own checks (a run-stage run: the long
// requests, the exam). Never what the tool said about its own work, and never the grade (meta/pick.mjs).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { ATTEMPT_BUDGET_CHARS, patchEvidence, stepsFromClaudeStream, stepsFromCodexEvents, stepsFromRelaySession, stepsFromTrajectory } from "./pick.mjs";

/** The agent folder of one Harbor trial, under its stage folder (<out>/<test>). */
export const trialAgentDir = (stageDir, r) => join(stageDir, "jobs", r.jobName, r.trialName, "agent");

const firstUserText = (entries) => {
	for (const e of entries) {
		const m = e.message;
		if (m?.role !== "user") continue;
		const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n") : "";
		if (text.trim()) return text;
	}
	return null;
};
const parseLines = (text, prefix) =>
	text
		.split("\n")
		.filter((l) => l.startsWith(prefix))
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);

/**
 * A Harbor trial's actions and the task's words, from whichever transcript it kept: Harbor's trajectory.json (Claude
 * Code, Codex), Claude Code's stream (claude-code.txt), Codex's event stream (codex.txt), Relay's session files, or
 * Relay's event stream (relay.jsonl). `kept` is false when it kept none of them.
 */
export function harborAttempt(stageDir, r) {
	if (!r.jobName || !r.trialName) return { kept: false, task: null, steps: [] };
	const dir = trialAgentDir(stageDir, r);
	const at = (f) => join(dir, f);
	if (existsSync(at("trajectory.json"))) {
		const trajectory = JSON.parse(readFileSync(at("trajectory.json"), "utf8"));
		const task = trajectory.steps?.find((s) => s.source === "user")?.message;
		return { kept: true, task: typeof task === "string" ? task : null, steps: stepsFromTrajectory(trajectory) };
	}
	if (existsSync(at("claude-code.txt"))) return { kept: true, task: null, steps: stepsFromClaudeStream(readFileSync(at("claude-code.txt"), "utf8")) };
	if (existsSync(at("codex.txt"))) return { kept: true, task: null, steps: stepsFromCodexEvents(readFileSync(at("codex.txt"), "utf8")) };
	const sessions = at("sessions");
	const files = existsSync(sessions) ? readdirSync(sessions).filter((f) => f.endsWith(".jsonl")).sort() : [];
	if (files.length) {
		const texts = files.map((f) => readFileSync(join(sessions, f), "utf8"));
		return { kept: true, task: firstUserText(texts.flatMap((t) => parseLines(t, '{"type":"message"'))), steps: texts.flatMap((t) => stepsFromRelaySession(t)) };
	}
	if (existsSync(at("relay.jsonl"))) {
		const ends = parseLines(readFileSync(at("relay.jsonl"), "utf8"), '{"type":"message_end"');
		return { kept: true, task: firstUserText(ends), steps: stepsFromRelaySession(ends.map((e) => JSON.stringify(e)).join("\n")) };
	}
	return { kept: false, task: null, steps: [] };
}

/** A run-stage run's evidence: its patch without noise files, and the project's own checks on it. */
export function patchAttempt(out, r) {
	const patchPath = join(out, r.runId, "result.patch.gz");
	const patch = existsSync(patchPath) ? gunzipSync(readFileSync(patchPath)).toString("utf8") : "";
	const gates = r.judge?.gates ?? {};
	const checks = Object.entries(gates)
		.map(([name, ok]) => `${name}: ${ok ? "passed" : "failed"}`)
		.join(", ");
	return `The project's own checks on the result: ${checks || "none recorded"}.\n\nThe change:\n\n${patchEvidence(patch, ATTEMPT_BUDGET_CHARS)}`;
}
