#!/usr/bin/env node
// The picker exam: would a meta-harness have beaten Claude Code in round 1?
//
// Round 1 ran Relay and Claude Code on the same tasks and kept every attempt: its transcript (Terminal-Bench 2.1, test
// F) or its patch (long requests, test A), and the hidden grader's verdict. This puts the picker (meta/pick.mjs) in
// front of pairs of those attempts and scores what it chose, without running any harness again:
//
//   tb-relay-cc   Terminal-Bench, Relay and Claude Code on the same task and trial number
//   tb-cc-cc      Terminal-Bench, Claude Code's two trials of the same task
//   a-relay-cc    test A, Relay and Claude Code on the same request and run number
//
// The meta-harness score of a pair is the grader's score of the attempt the picker chose. When both attempts got the
// same grade, every choice scores the same, so the picker is not called for that pair (its score is exact without it);
// only pairs the grader split cost a call. An answer that names no attempt is asked once more, then counts as the worse
// of the two. A split pair where one attempt kept no record of its actions (the runner lost its transcript) cannot be
// shown fairly, so it is left out of every score, and the count is reported.
//
// Each pair is scored against Claude Code alone (its own attempt, or its first trial) and against a perfect pick (the
// better attempt, which only the grader knows). Picker calls are paid OpenAI calls, bounded and counted in a spend
// ledger with its own cap (scripts/draft-spend.mjs); with no cap set, nothing is called. Answers are kept in the output
// file and reused on a second run while the evidence shown is the same, so a run that stops can be run again at no
// extra cost.
//
//   node meta/pick-exam.mjs --dry-run                       pairs and the most it could cost, no calls
//   node meta/pick-exam.mjs --keychain relay-openai --openai-cap-usd 4 [--model gpt-6.1-sol] [--effort medium]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { maxCallUsd, openaiCostUsd, openLedger, SpendCapError, usageSummary } from "../scripts/draft-spend.mjs";
import { openaiClient } from "../scripts/draft-task.mjs";
import { harborAttempt, patchAttempt } from "./evidence.mjs";
import { pick, PICKER_INSTRUCTIONS, pickerInput, showOrder, workLog } from "./pick.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
export const FAMILIES = Object.freeze(["tb-relay-cc", "tb-cc-cc", "a-relay-cc"]);
const MAX_OUTPUT_TOKENS = 4_000;

const readJsonl = (path) =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));

/**
 * A Terminal-Bench attempt's actions and the task's words, from whichever transcript the trial kept (meta/evidence.mjs).
 * `kept` is false when it kept none of them.
 */
export const tbAttempt = (round, r) => harborAttempt(join(round, "F"), r);

/** A test A attempt's evidence: its patch without noise files, and the project's own checks on it. */
export const aAttempt = (round, r) => patchAttempt(round, r);

/**
 * Every pair of every family asked for, as { family, key, task, attempts: [{ label, outcome, costUsd, evidence() }],
 * base } where `base` is the attempt that stands for Claude Code alone. Outcomes are 0..1.
 */
export function buildPairs({ round, tasksDirs, families, dropped = [] }) {
	const pairs = [];
	if (families.some((f) => f.startsWith("tb-"))) {
		const tb = readJsonl(join(round, "F", "records.jsonl")).filter((r) => !r.infra && !dropped.includes(r.task));
		const by = new Map();
		for (const r of tb) by.set(`${r.task}|${r.tool}|${r.rep}`, r);
		const tasks = [...new Set(tb.map((r) => r.task))].sort();
		const attempt = (r) => ({ label: `${r.tool} r${r.rep}`, outcome: r.solved ? 1 : 0, costUsd: r.usage?.costUsd ?? 0, load: () => tbAttempt(round, r) });
		for (const task of tasks) {
			const trials = tb.filter((r) => r.task === task).map((r) => () => tbAttempt(round, r));
			if (families.includes("tb-relay-cc")) {
				for (const rep of [1, 2]) {
					const relay = by.get(`${task}|relay|${rep}`), cc = by.get(`${task}|claude-code|${rep}`);
					if (relay && cc) pairs.push({ family: "tb-relay-cc", key: `${task}|r${rep}`, trials, attempts: [attempt(cc), attempt(relay)], base: 0 });
				}
			}
			if (families.includes("tb-cc-cc")) {
				const one = by.get(`${task}|claude-code|1`), two = by.get(`${task}|claude-code|2`);
				if (one && two) pairs.push({ family: "tb-cc-cc", key: `${task}|cc`, trials, attempts: [attempt(one), attempt(two)], base: 0 });
			}
		}
	}
	if (families.includes("a-relay-cc")) {
		const a = readJsonl(join(round, "records.jsonl")).filter((r) => r.test === "A" && typeof r.score?.share === "number");
		const by = new Map();
		for (const r of a) by.set(`${r.task}|${r.tool}|${r.rep}`, r);
		const groups = [...new Set(a.map((r) => `${r.task}|${r.rep}`))].sort();
		for (const g of groups) {
			const [task, rep] = g.split("|");
			const relay = by.get(`${task}|relay|${rep}`), cc = by.get(`${task}|claude-code|${rep}`);
			if (!relay || !cc) continue;
			const requestPath = tasksDirs.map((d) => join(d, task, "request.md")).find((p) => existsSync(p));
			const attempt = (r) => ({ label: `${r.tool} r${r.rep}`, outcome: r.score.share, costUsd: r.usage?.costUsd ?? 0, load: () => ({ evidence: aAttempt(round, r) }) });
			pairs.push({ family: "a-relay-cc", key: `${task}|r${rep}`, requestPath, attempts: [attempt(cc), attempt(relay)], base: 0 });
		}
	}
	return pairs;
}

/**
 * The picker's input for one pair: { task, evidence[] }, or { left } when an attempt kept no record of its actions, or
 * { problem } when the task's words were not found.
 */
export function pairInput(pair) {
	if (pair.family === "a-relay-cc") {
		if (!pair.requestPath) return { problem: "no request.md for this task" };
		return { task: readFileSync(pair.requestPath, "utf8"), evidence: pair.attempts.map((a) => a.load().evidence) };
	}
	const loaded = pair.attempts.map((a) => a.load());
	if (loaded.some((l) => !l.kept)) return { left: "an attempt kept no record of its actions" };
	let task = loaded.find((l) => l.task)?.task;
	for (const trial of pair.trials ?? []) {
		if (task) break;
		task = trial().task;
	}
	if (!task) return { problem: "no transcript holds the task's words" };
	return { task, evidence: loaded.map((l) => workLog(l.steps)) };
}

/** The scores of a family's pairs: meta (the picks), base (Claude Code alone), perfect, and how the picker did. */
export function summarize(rows) {
	const out = {};
	for (const family of [...new Set(rows.map((r) => r.family))]) {
		const rs = rows.filter((r) => r.family === family);
		const mean = (f) => (100 * rs.reduce((s, r) => s + f(r), 0)) / rs.length;
		const split = rs.filter((r) => r.split);
		const answered = split.filter((r) => r.picked !== null);
		out[family] = {
			pairs: rs.length,
			splitPairs: split.length,
			meta: mean((r) => r.metaOutcome),
			base: mean((r) => r.outcomes[r.base]),
			perfect: mean((r) => Math.max(...r.outcomes)),
			pickedBetter: answered.filter((r) => r.outcomes[r.picked] === Math.max(...r.outcomes)).length,
			pickedBase: answered.filter((r) => r.picked === r.base).length,
			unanswered: split.length - answered.length,
			pickerUsd: rs.reduce((s, r) => s + (r.pickerUsd ?? 0), 0),
			baseUsd: rs.reduce((s, r) => s + r.costs[r.base], 0),
			bothUsd: rs.reduce((s, r) => s + r.costs.reduce((a, b) => a + b, 0), 0),
		};
	}
	return out;
}

/** Runs `fn` over `items` with at most `n` at once. */
async function pool(items, n, fn) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (next < items.length) await fn(items[next++]);
		}),
	);
}

/** Reads a Keychain item (macOS `security`), never printing it. */
function keyFromKeychain(service) {
	try {
		return execFileSync("security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\n$/, "");
	} catch {
		return null;
	}
}

const pct = (v) => `${v.toFixed(1)}%`;
const usd = (v) => `$${v.toFixed(2)}`;

export async function runExam({ round, tasksDirs, families, dropped, model, modelId, effort, ledger, out, dryRun, concurrency = 4, log = console.log }) {
	const pairs = buildPairs({ round, tasksDirs, families, dropped });
	const done = new Map();
	if (existsSync(out)) for (const row of readJsonl(out)) if (row.model === modelId && row.effort === effort && row.inputHash) done.set(`${row.family}|${row.key}|${row.inputHash}`, row);
	const rows = [];
	const left = [];
	const toCall = [];
	let boundUsd = 0;
	for (const pair of pairs) {
		const outcomes = pair.attempts.map((a) => a.outcome);
		const row = { family: pair.family, key: pair.key, labels: pair.attempts.map((a) => a.label), outcomes, costs: pair.attempts.map((a) => a.costUsd), base: pair.base, split: new Set(outcomes).size > 1, model: modelId, effort };
		if (!row.split) {
			rows.push({ ...row, picked: null, metaOutcome: outcomes[0], pickerUsd: 0 });
			continue;
		}
		const input = pairInput(pair);
		if (input.left) {
			left.push({ family: pair.family, key: pair.key, why: input.left });
			continue;
		}
		if (input.problem) {
			rows.push({ ...row, picked: null, metaOutcome: Math.min(...outcomes), pickerUsd: 0, problem: input.problem });
			log(`${pair.family} ${pair.key}: not shown (${input.problem}); counted as the worse attempt`);
			continue;
		}
		const text = pickerInput(input.task, input.evidence, showOrder(pair.key, input.evidence.length));
		const inputHash = createHash("sha256").update(PICKER_INSTRUCTIONS).update(text).digest("hex").slice(0, 16);
		const reuse = done.get(`${pair.family}|${pair.key}|${inputHash}`);
		if (reuse && reuse.picked !== null) {
			rows.push(reuse);
			continue;
		}
		boundUsd += 2 * (maxCallUsd(modelId, { inputBytes: Buffer.byteLength(PICKER_INSTRUCTIONS) + Buffer.byteLength(text), maxOutputTokens: MAX_OUTPUT_TOKENS }) ?? Number.NaN);
		toCall.push({ pair, row: { ...row, inputHash }, input });
	}
	const answered = rows.filter((r) => r.split).length;
	log(`${pairs.length} pairs; ${answered} split pairs already answered, ${toCall.length} to ask ${modelId} (${effort}), at most ${usd(boundUsd)} together (a second ask included); ${left.length} left out: an attempt kept no record of its actions`);
	if (dryRun) return { pairs, rows, left, toCall: toCall.length, boundUsd };

	mkdirSync(dirname(out), { recursive: true });
	await pool(toCall, concurrency, async ({ pair, row, input }) => {
		let costUsd = 0;
		const complete = async ({ instructions, input: text }) => {
			const boundUsd = maxCallUsd(modelId, { inputBytes: Buffer.byteLength(instructions) + Buffer.byteLength(text), maxOutputTokens: MAX_OUTPUT_TOKENS });
			const entry = ledger.reserve("openai", { boundUsd, candidate: `pick ${pair.family} ${pair.key}`, model: modelId, effort, maxOutputTokens: MAX_OUTPUT_TOKENS });
			let reply;
			try {
				reply = await model.complete({ model: modelId, instructions, input: text, maxOutputTokens: MAX_OUTPUT_TOKENS, effort });
			} catch (error) {
				const refused = error.status >= 400 && error.status < 500;
				ledger.settle("openai", entry, { ...(refused ? { costUsd: 0 } : {}), outcome: "error", why: String(error.message).slice(0, 300) });
				throw error;
			}
			const cost = openaiCostUsd(reply.usage, reply.model ?? modelId, reply.serviceTier) ?? 0;
			costUsd += cost;
			ledger.settle("openai", entry, { costUsd: cost, reported: reply.model, status: reply.status, usage: reply.usage ? usageSummary(reply.usage) : null, outcome: "answered" });
			return reply;
		};
		let picked;
		try {
			picked = await pick({ key: pair.key, task: input.task, evidence: input.evidence, complete });
			if (picked.index === null) picked = await pick({ key: pair.key, task: input.task, evidence: input.evidence, complete });
		} catch (error) {
			if (error instanceof SpendCapError) {
				log(`spend cap: ${error.message}; ${pair.family} ${pair.key} not asked`);
				return;
			}
			log(`${pair.family} ${pair.key}: the call failed (${String(error.message).slice(0, 200)}); not counted, run again to retry`);
			return;
		}
		const metaOutcome = picked.index === null ? Math.min(...row.outcomes) : row.outcomes[picked.index];
		const r = { ...row, picked: picked.index, confidence: picked.confidence, reason: picked.reason, metaOutcome, pickerUsd: costUsd, reported: picked.reply.model };
		rows.push(r);
		appendFileSync(out, `${JSON.stringify(r)}\n`);
		const right = picked.index !== null && row.outcomes[picked.index] === Math.max(...row.outcomes);
		log(`${pair.family} ${pair.key}: picked ${picked.index === null ? "nothing" : row.labels[picked.index]} (${right ? "the better one" : "the worse one"}), ${usd(costUsd)}`);
	});
	const splitTotal = pairs.filter((p) => new Set(p.attempts.map((a) => a.outcome)).size > 1).length;
	return { pairs, rows, left, complete: rows.filter((r) => r.split).length + left.length === splitTotal, summary: summarize(rows) };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values } = parseArgs({
		options: {
			round: { type: "string" },
			"tasks-dir": { type: "string", multiple: true },
			families: { type: "string" },
			model: { type: "string", default: "gpt-6.1-sol" },
			effort: { type: "string", default: "medium" },
			spend: { type: "string" },
			"openai-cap-usd": { type: "string" },
			keychain: { type: "string" },
			out: { type: "string" },
			concurrency: { type: "string", default: "4" },
			"dry-run": { type: "boolean", default: false },
		},
	});
	const round = values.round ?? join(ROOT, "runs", "round-1");
	const tasksDirs = values["tasks-dir"] ?? [join(ROOT, "tasks")];
	const families = values.families ? values.families.split(",") : [...FAMILIES];
	for (const f of families) if (!FAMILIES.includes(f)) throw new Error(`unknown family ${f}; known: ${FAMILIES.join(", ")}`);
	const results = JSON.parse(readFileSync(join(ROOT, "results", "round-1.json"), "utf8"));
	const dropped = results.tests.find((t) => t.id === "F")?.droppedTasks ?? [];
	const meta = join(ROOT, "runs", "meta");
	const out = values.out ?? join(meta, `pick-exam-${values.model}-${values.effort}.jsonl`);
	let model = null, ledger = null;
	if (!values["dry-run"]) {
		if (values.keychain && !process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = keyFromKeychain(values.keychain) ?? "";
		model = openaiClient({ apiKey: process.env.OPENAI_API_KEY });
		ledger = openLedger(values.spend ?? join(meta, "pick-spend.json"), { caps: { openai: values["openai-cap-usd"] } });
	}
	const result = await runExam({ round, tasksDirs, families, dropped, model, modelId: values.model, effort: values.effort, ledger, out, dryRun: values["dry-run"], concurrency: Number(values.concurrency) });
	if (values["dry-run"]) process.exit(0);
	console.log("");
	for (const [family, s] of Object.entries(result.summary)) {
		console.log(`${family}: ${s.pairs} pairs, ${s.splitPairs} split by the grader`);
		console.log(`  Claude Code alone      ${pct(s.base)}  ${usd(s.baseUsd)}`);
		console.log(`  meta-harness (picker)  ${pct(s.meta)}  ${usd(s.bothUsd + s.pickerUsd)} (both attempts ${usd(s.bothUsd)} + picker ${usd(s.pickerUsd)})`);
		console.log(`  perfect pick           ${pct(s.perfect)}`);
		console.log(`  on split pairs: picked the better attempt ${s.pickedBetter} of ${s.splitPairs - s.unanswered}, picked Claude Code's ${s.pickedBase}${s.unanswered ? `, ${s.unanswered} unanswered` : ""}`);
	}
	for (const l of result.left) console.log(`left out: ${l.family} ${l.key} (${l.why})`);
	if (!result.complete) console.log("\nnot every split pair was answered; run the same command again to finish (answers already given are reused)");
	const t = ledger.totals();
	console.log(`\npicker spend so far (${ledger.path}): OpenAI $${t.openai.spentUsd.toFixed(4)} of $${t.openai.capUsd ?? "no cap"}`);
}
