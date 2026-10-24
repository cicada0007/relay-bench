// The meta-harness picker: given several finished attempts at one task, choose the one most likely to be right.
//
// An attempt is shown to the picker as evidence only: the actions it took and what came back (a transcript), or the
// change it made and the project's own checks on it (a patch). Never what the harness wrote about its own work: its
// prose, its final message and its reasoning are dropped before the picker sees anything. The picker never sees a
// benchmark's hidden tests or their results.
//
// The attempts are shown in an order fixed by the task, not by which harness made them, and unnamed (A, B, ...), so the
// picker cannot prefer a harness by name or by position.
import { createHash } from "node:crypto";

/** Characters of evidence per attempt, at most (about 12,000 tokens). */
export const ATTEMPT_BUDGET_CHARS = 48_000;
const CALL_CHARS = 1_200;
const OUTPUT_HEAD_CHARS = 500;
const OUTPUT_TAIL_CHARS = 1_000;
const FIRST_STEPS_KEPT = 4;

const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n)} [… ${s.length - n} more characters]`);
function clipMiddle(s, head, tail) {
	if (s.length <= head + tail) return s;
	return `${s.slice(0, head)}\n[… ${s.length - head - tail} characters …]\n${s.slice(-tail)}`;
}

/** One action as the picker reads it: the call, then what came back. */
function renderStep(step, n) {
	const call = clip(step.call.trim(), CALL_CHARS);
	const output = step.output === undefined ? "(no output recorded)" : clipMiddle(String(step.output).trim(), OUTPUT_HEAD_CHARS, OUTPUT_TAIL_CHARS) || "(empty)";
	return `[${n}] ${call}\n→ ${output}`;
}

/**
 * The actions as one log within `budget` characters. When they do not fit, the first few stay (what the attempt found)
 * and then as many of the last as fit (the state it left), with the gap marked.
 */
export function workLog(steps, budget = ATTEMPT_BUDGET_CHARS) {
	if (!steps.length) return "(no actions recorded)";
	const rendered = steps.map((s, i) => renderStep(s, i + 1));
	const total = rendered.reduce((n, r) => n + r.length + 2, 0);
	if (total <= budget) return rendered.join("\n\n");
	const head = rendered.slice(0, FIRST_STEPS_KEPT);
	let used = head.reduce((n, r) => n + r.length + 2, 0) + 80;
	const tail = [];
	for (let i = rendered.length - 1; i >= FIRST_STEPS_KEPT; i--) {
		if (used + rendered[i].length + 2 > budget) break;
		tail.unshift(rendered[i]);
		used += rendered[i].length + 2;
	}
	const omitted = rendered.length - head.length - tail.length;
	return [...head, `[… ${omitted} actions omitted …]`, ...tail].join("\n\n");
}

/** A short form of a tool call's arguments: the command or code when there is one, else the path and sizes. */
function describeCall(name, args = {}) {
	if (typeof args === "string") return `${name}: ${args}`;
	const command = args.command ?? args.cmd ?? args.code ?? args.script;
	if (typeof command === "string") return `${name}: ${command}`;
	const path = args.file_path ?? args.path ?? args.filePath;
	if (typeof args.content === "string") return `${name} ${path ?? ""} (${args.content.length} characters):\n${args.content}`;
	if (typeof args.old_string === "string" || typeof args.oldText === "string") {
		return `${name} ${path ?? ""}:\n- ${args.old_string ?? args.oldText}\n+ ${args.new_string ?? args.newText ?? ""}`;
	}
	return `${name} ${JSON.stringify(args)}`;
}

const textOf = (content) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((c) => (typeof c === "string" ? c : (c.text ?? c.content ?? ""))).join("\n")
			: content === undefined || content === null
				? ""
				: JSON.stringify(content);

/** Actions from an ATIF trajectory (Harbor's trajectory.json: Claude Code, Codex, and others). Prose is dropped. */
export function stepsFromTrajectory(trajectory) {
	const steps = [];
	for (const step of trajectory.steps ?? []) {
		if (step.source !== "agent") continue;
		const results = new Map((step.observation?.results ?? []).map((r) => [r.source_call_id, r.content]));
		for (const call of step.tool_calls ?? []) {
			steps.push({ call: describeCall(call.function_name, call.arguments), output: results.has(call.tool_call_id) ? textOf(results.get(call.tool_call_id)) : undefined });
		}
	}
	return steps;
}

/**
 * Actions from a Relay session file or its event stream (`relay --mode json`: the same messages, as message_end
 * events), one JSON entry per line. Assistant text and thinking are dropped.
 */
export function stepsFromRelaySession(jsonl) {
	const steps = [];
	const byId = new Map();
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const m = entry.type === "message" || entry.type === "message_end" ? entry.message : null;
		if (!m) continue;
		if (m.role === "assistant") {
			for (const c of m.content ?? []) {
				if (c.type !== "toolCall") continue;
				const step = { call: describeCall(c.name, c.arguments), output: undefined };
				byId.set(c.id, step);
				steps.push(step);
			}
		} else if (m.role === "toolResult") {
			const step = byId.get(m.toolCallId);
			if (step) step.output = textOf(m.content);
		}
	}
	return steps;
}

/** Actions from Claude Code's stream-json output (`claude -p --output-format stream-json`). Prose is dropped. */
export function stepsFromClaudeStream(text) {
	const steps = [];
	const byId = new Map();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const content = entry.message?.content;
		if (!Array.isArray(content)) continue;
		for (const c of content) {
			if (entry.type === "assistant" && c.type === "tool_use") {
				const step = { call: describeCall(c.name, c.input), output: undefined };
				byId.set(c.id, step);
				steps.push(step);
			} else if (entry.type === "user" && c.type === "tool_result") {
				const step = byId.get(c.tool_use_id);
				if (step) step.output = textOf(c.content);
			}
		}
	}
	return steps;
}

/**
 * Actions from Codex's event stream (`codex exec --json`, Harbor's codex.txt), for a trial whose trajectory.json was not
 * written: each finished command, file change, tool call or search. Codex's messages and reasoning are dropped.
 */
export function stepsFromCodexEvents(text) {
	const steps = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		const item = event.type === "item.completed" ? event.item : null;
		if (!item) continue;
		if (item.type === "command_execution") {
			const exit = typeof item.exit_code === "number" ? `\n(exit code ${item.exit_code})` : "";
			steps.push({ call: `shell: ${item.command ?? ""}`, output: `${item.aggregated_output ?? ""}${exit}` });
		} else if (item.type === "file_change") {
			const changes = (item.changes ?? []).map((c) => `${c.kind ?? "change"} ${c.path ?? "?"}`).join(", ");
			steps.push({ call: `file_change: ${changes}`, output: item.status ?? undefined });
		} else if (item.type === "mcp_tool_call") {
			steps.push({ call: describeCall(`${item.server ?? "mcp"}.${item.tool ?? "tool"}`, item.arguments ?? {}), output: item.result === undefined ? undefined : textOf(item.result?.content ?? item.result) });
		} else if (item.type === "web_search") {
			steps.push({ call: `web_search: ${item.query ?? ""}`, output: undefined });
		}
	}
	return steps;
}

/** Files a patch changes that say nothing about whether the work is right: lockfiles and a harness's own notes. */
const NOISE_PATH = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$|^\.(relay|claude|codex)\//;

/** A git patch with the noise files removed, within `budget` characters (each file's diff kept whole while it fits). */
export function patchEvidence(patch, budget = ATTEMPT_BUDGET_CHARS) {
	const files = patch.split(/(?=^diff --git )/m).filter((f) => f.startsWith("diff --git "));
	const kept = files.filter((f) => !NOISE_PATH.test(f.match(/^diff --git a\/(\S+)/)?.[1] ?? ""));
	if (!kept.length) return "(the attempt changed no files)";
	const out = [];
	let used = 0;
	const skipped = [];
	for (const f of kept) {
		if (used + f.length <= budget) {
			out.push(f);
			used += f.length;
		} else skipped.push(f.match(/^diff --git a\/(\S+)/)?.[1] ?? "?");
	}
	if (skipped.length) out.push(`[… diffs not shown for lack of room: ${skipped.join(", ")}]`);
	return out.join("");
}

export const PICKER_INSTRUCTIONS = `You choose between attempts at one software task. Each attempt worked in its own fresh copy of the same environment.

You are shown the task and, for each attempt, only evidence: the actions it took and what the environment returned, or the change it made and the results of the project's own checks. You are not shown what any attempt said about its own work. Treat a success message printed by an attempt's own script as a claim, not a proof, unless the output shows it checked the exact thing the task asks for.

After the attempts finished, a hidden test suite checked each one's final result against the task. Choose the attempt most likely to pass it.

Weigh: the exact names, paths, formats and values the task asks for; whether the attempt ran what it built and saw correct output; whether a later action undid or broke earlier work; whether it left the final state the task requires; any requirement it skipped or got wrong. Prefer evidence over effort: a long attempt is not better for being long.

Answer with JSON only, no other text: {"pick": "<letter>", "confidence": <number from 0.5 to 1>, "reason": "<one sentence>"}`;

/** The letters shown for attempts, in the order shown. */
export const LETTERS = "ABCDEFGH";

/** The order to show `n` attempts for a task: a permutation fixed by the task's key, so it does not favor any harness. */
export function showOrder(key, n) {
	const order = [...Array(n).keys()];
	const h = createHash("sha256").update(String(key)).digest();
	for (let i = n - 1; i > 0; i--) {
		const j = h[i % h.length] % (i + 1);
		[order[i], order[j]] = [order[j], order[i]];
	}
	return order;
}

/** The picker's input: the task, then each attempt's evidence under its letter, in the given order. */
export function pickerInput(task, evidence, order) {
	const parts = [`# The task\n\n${task.trim()}`];
	order.forEach((index, shown) => parts.push(`# Attempt ${LETTERS[shown]}\n\n${evidence[index]}`));
	parts.push(`Which attempt is most likely to pass the hidden tests? Answer with JSON only.`);
	return parts.join("\n\n");
}

/** The picker's answer as { shown, confidence, reason }, or null when it named no attempt shown. */
export function parsePick(text, n) {
	const json = String(text ?? "").match(/\{[\s\S]*\}/)?.[0];
	if (!json) return null;
	let answer;
	try {
		answer = JSON.parse(json);
	} catch {
		return null;
	}
	const shown = LETTERS.indexOf(String(answer.pick ?? "").trim().toUpperCase());
	if (shown < 0 || shown >= n) return null;
	const confidence = Number(answer.confidence);
	return { shown, confidence: Number.isFinite(confidence) ? confidence : null, reason: String(answer.reason ?? "").slice(0, 400) };
}

/**
 * Picks one of `evidence` (strings, one per attempt) for `task`. `complete({ instructions, input })` is the model call;
 * it returns { text }. Returns { index, confidence, reason, reply } where index is into `evidence`, or index null when
 * the answer named no attempt.
 */
export async function pick({ key, task, evidence, complete }) {
	const order = showOrder(key, evidence.length);
	const reply = await complete({ instructions: PICKER_INSTRUCTIONS, input: pickerInput(task, evidence, order) });
	const answer = parsePick(reply.text, evidence.length);
	return answer ? { index: order[answer.shown], confidence: answer.confidence, reason: answer.reason, reply } : { index: null, confidence: null, reason: null, reply };
}
