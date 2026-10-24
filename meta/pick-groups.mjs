#!/usr/bin/env node
// The meta-harness as a scored entry: the picker (meta/pick.mjs) over each task's attempts in any records file, for any
// set of arms, so "Relay meta-harness" is scored from the same trials the single tools ran.
//
// A group is one task's attempts, one per arm: by default the arms' attempts with the same trial number (Relay's and
// Claude Code's r1, then their r2), or, with arms that name a trial (claude-code#1,claude-code#2), one group per task.
// The picker sees each attempt's evidence only (meta/evidence.mjs), unnamed and in an order fixed by the group, never
// a grade and never which tool made it. The meta-harness's grade on a group is the grade of the attempt it chose.
//
// - Asked about: every group (`--ask every`, the default), as in use, where no grade is known. `--ask split` asks only
//   about groups the grader split, where the choice changes the score (round 1's exam did this); the picker's cost on
//   the other groups is then estimated from the asked calls' mean and reported as an estimate.
// - Counted: a task with an infrastructure failure for any tool is dropped for every entry, as in the analysis. A group
//   missing an arm's attempt is not formed. A group where an attempt kept no record of its actions is left out of the
//   entry and counted (round 1's rule). An answer that names no attempt is asked once more, then counts as the worse.
// - Cost: the meta-harness pays for every arm's attempt plus the picker; its time on a group is its slowest attempt
//   (the arms run side by side) plus the picker's own time when it was measured.
// - Paid: picker calls are OpenAI calls, bounded and counted in a spend ledger with its own cap (scripts/draft-spend.mjs);
//   with no cap nothing is called. Answers are kept in the picks file and reused while the evidence shown is the same,
//   also from another file (`--reuse`, such as round 1's exam answers), so a second run costs nothing more.
// - Sealed tasks (the exam): each call shows the task to a model, so it is counted beside the exam as a run against the
//   leak budget (runner/exposure.mjs) before it is made, and a call that would pass the budget is not made.
//
//   node meta/pick-groups.mjs --records runs/scoreboard/swebench-verified/records.jsonl --model claude-haiku-5-5 --dry-run
//   node meta/pick-groups.mjs --records runs/round-1/F/records.jsonl --model claude-haiku-5-5 --arms claude-code,relay \
//     --ask split --reuse runs/meta/pick-exam-gpt-6.1-sol-medium.jsonl
//   node meta/pick-groups.mjs --records ... --model ... --keychain relay-openai --openai-cap-usd 4      (PAID)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { bootstrap } from "../runner/analyze.mjs";
import { budgetProblems, exposurePathFor, loadBudget, readExposures, recordExposure, SEALED } from "../runner/exposure.mjs";
import { readTasks } from "../runner/stage-tasks.mjs";
import { maxCallUsd, openaiCostUsd, openLedger, SpendCapError, usageSummary } from "../scripts/draft-spend.mjs";
import { openaiClient } from "../scripts/draft-task.mjs";
import { harborAttempt, patchAttempt } from "./evidence.mjs";
import { LETTERS, pick, PICKER_INSTRUCTIONS, pickerInput, showOrder, workLog } from "./pick.mjs";

export const PICKER_MODEL = "gpt-6.1-sol";
export const PICKER_EFFORT = "medium";
const MAX_OUTPUT_TOKENS = 4_000;

/** The single tools a meta-harness is made of, in the order its attempts are listed (the show order is shuffled). */
export const ARM_ORDER = Object.freeze(["claude-code", "codex", "relay", "prime-agent", "hermes"]);

const readJsonl = (path) =>
	existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l))
		: [];

/** A record's grade, 0..1: requirements met (run-stage) or solved (Harbor). */
export const outcomeOf = (r) => (typeof r.score?.share === "number" ? r.score.share : r.solved ? 1 : 0);
const baseTool = (tool) => tool.split("@")[0];

/** `relay,claude-code` or `claude-code#1,claude-code#2`: each arm a tool, optionally pinned to one trial number. */
export function parseArms(spec) {
	const arms = spec
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => {
			const [tool, rep] = s.split("#");
			return { tool, rep: rep === undefined ? null : Number(rep), label: s };
		});
	if (arms.length < 2) throw new Error("a meta-harness needs at least two arms");
	if (arms.length > LETTERS.length) throw new Error(`at most ${LETTERS.length} arms`);
	const pinned = arms.filter((a) => a.rep !== null).length;
	if (pinned && pinned !== arms.length) throw new Error("either every arm names a trial (tool#n) or none does");
	if (arms.some((a) => a.rep !== null && !(Number.isInteger(a.rep) && a.rep > 0))) throw new Error("a trial number is a whole number from 1");
	if (new Set(arms.map((a) => a.label)).size !== arms.length) throw new Error("an arm is named twice");
	return arms;
}

/** The default arms: every tool with records, in ARM_ORDER (tools it does not name last, by name). */
export function defaultArms(records) {
	const tools = [...new Set(records.map((r) => r.tool))];
	const rank = (t) => (ARM_ORDER.includes(baseTool(t)) ? ARM_ORDER.indexOf(baseTool(t)) : ARM_ORDER.length);
	return tools.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((tool) => ({ tool, rep: null, label: tool }));
}

/** Tasks dropped for every tool: an infrastructure failure was recorded for one of them (PREREGISTRATION.md). */
export const droppedTasks = (records) => [...new Set(records.filter((r) => r.infra).map((r) => r.task))].sort();

/**
 * Every group the arms form over `records` (one benchmark, one model): { key, task, rep, attempts: [{ label, record,
 * outcome, costUsd, wallMs }] }, and the groups not formed because an arm's attempt is missing.
 */
export function buildGroups(records, arms) {
	const dropped = droppedTasks(records);
	const counted = records.filter((r) => !r.infra && !dropped.includes(r.task));
	const by = new Map(counted.map((r) => [`${r.task}|${r.tool}|${r.rep}`, r]));
	const tasks = [...new Set(counted.map((r) => r.task))].sort();
	const pinned = arms[0].rep !== null;
	const groups = [];
	const missing = [];
	const attempt = (r, label) => ({ label, record: r, outcome: outcomeOf(r), costUsd: r.usage?.costUsd ?? 0, wallMs: r.wallMs ?? null });
	for (const task of tasks) {
		const reps = pinned ? [null] : [...new Set(counted.filter((r) => r.task === task && arms.some((a) => a.tool === r.tool)).map((r) => r.rep))].sort((a, b) => a - b);
		for (const rep of reps) {
			const found = arms.map((a) => by.get(`${task}|${a.tool}|${pinned ? a.rep : rep}`));
			const key = pinned ? `${task}|${arms.map((a) => a.label).join("+")}` : `${task}|r${rep}`;
			if (found.some((r) => !r)) {
				missing.push({ key, arms: arms.filter((_, i) => !found[i]).map((a) => a.label) });
				continue;
			}
			groups.push({ key, task, rep, attempts: found.map((r, i) => attempt(r, pinned ? arms[i].label : `${r.tool} r${r.rep}`)) });
		}
	}
	return { groups, missing, dropped };
}

/**
 * How a group's attempts are read: `harbor` (a Harbor stage folder: the actions and what came back) or `patch` (a
 * run-stage folder and its tasks folders: the change and the project's checks, and the task's request.md).
 */
export function harborLoader(stageDir) {
	return {
		kind: "harbor",
		input(group) {
			const loaded = group.attempts.map((a) => harborAttempt(stageDir, a.record));
			if (loaded.some((l) => !l.kept)) return { left: "an attempt kept no record of its actions" };
			const task = loaded.find((l) => l.task)?.task;
			if (!task) return { problem: "no transcript holds the task's words" };
			return { task, evidence: loaded.map((l) => workLog(l.steps)) };
		},
	};
}

export function patchLoader(out, tasksDirs) {
	return {
		kind: "patch",
		input(group) {
			const requestPath = tasksDirs.map((d) => join(d, group.task, "request.md")).find((p) => existsSync(p));
			if (!requestPath) return { problem: "no request.md for this task" };
			return { task: readFileSync(requestPath, "utf8"), evidence: group.attempts.map((a) => patchAttempt(out, a.record)) };
		},
	};
}

const hashInput = (text) => createHash("sha256").update(PICKER_INSTRUCTIONS).update(text).digest("hex").slice(0, 16);

/** Runs `fn` over `items` with at most `n` at once. */
async function pool(items, n, fn) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (next < items.length) await fn(items[next++]);
		}),
	);
}

/**
 * Picks over `groups`. Returns { rows, left, toCall, boundUsd, complete }: one row per group with a decided outcome
 * ({ key, task, labels, outcomes, costs, wallMs, split, asked, picked, metaOutcome, pickerUsd, pickerMs, ... }), the
 * groups left out, and how many calls were still needed. Calls only when not `dryRun` and the ledger has a cap.
 * `sealed` ({ tasksDir, test, tierOf }) counts each call on an exam or check task against the leak budget.
 */
export async function runPicks({ groups, loader, benchModel, test, modelId = PICKER_MODEL, effort = PICKER_EFFORT, model, ledger, out, reuse = [], ask = "every", dryRun = false, concurrency = 4, sealed = null, log = console.log }) {
	if (!["every", "split"].includes(ask)) throw new Error(`--ask is every or split, not ${ask}`);
	const answers = new Map();
	for (const row of [...reuse, ...(out ? readJsonl(out) : [])]) {
		if (row.model === modelId && row.effort === effort && row.inputHash && row.picked !== null && row.picked !== undefined) answers.set(`${row.key}|${row.inputHash}`, row);
	}
	const rows = [];
	const left = [];
	const toCall = [];
	let boundUsd = 0;
	for (const group of groups) {
		const outcomes = group.attempts.map((a) => a.outcome);
		const row = {
			test,
			benchModel,
			key: group.key,
			task: group.task,
			labels: group.attempts.map((a) => a.label),
			outcomes,
			costs: group.attempts.map((a) => a.costUsd),
			wallMs: group.attempts.map((a) => a.wallMs),
			split: new Set(outcomes).size > 1,
			model: modelId,
			effort,
		};
		const input = loader.input(group);
		const text = input.task ? pickerInput(input.task, input.evidence, showOrder(group.key, input.evidence.length)) : null;
		const inputHash = text ? hashInput(text) : null;
		const known = inputHash ? answers.get(`${group.key}|${inputHash}`) : null;
		if (known) {
			const metaOutcome = known.picked === null ? Math.min(...outcomes) : outcomes[known.picked];
			rows.push({ ...row, inputHash, asked: true, picked: known.picked, confidence: known.confidence ?? null, reason: known.reason ?? null, metaOutcome, pickerUsd: known.pickerUsd ?? 0, pickerMs: known.pickerMs ?? null, reported: known.reported ?? null, reused: true });
			continue;
		}
		if (!row.split && (ask === "split" || !text)) {
			// Every choice scores the same here; the picker's cost on it is estimated (metaEntry).
			rows.push({ ...row, asked: false, picked: null, metaOutcome: outcomes[0], pickerUsd: 0, pickerMs: null });
			continue;
		}
		if (input.left) {
			left.push({ key: group.key, why: input.left });
			continue;
		}
		if (input.problem) {
			rows.push({ ...row, asked: false, picked: null, metaOutcome: Math.min(...outcomes), pickerUsd: 0, pickerMs: null, problem: input.problem });
			log(`${group.key}: not shown (${input.problem}); counted as the worse attempt`);
			continue;
		}
		boundUsd += 2 * (maxCallUsd(modelId, { inputBytes: Buffer.byteLength(PICKER_INSTRUCTIONS) + Buffer.byteLength(text), maxOutputTokens: MAX_OUTPUT_TOKENS }) ?? Number.NaN);
		toCall.push({ group, row: { ...row, inputHash }, input });
	}
	log(`${groups.length} groups; ${rows.length} decided, ${toCall.length} to ask ${modelId} (${effort}), at most $${boundUsd.toFixed(2)} together (a second ask included); ${left.length} left out: an attempt kept no record of its actions`);
	const order = new Map(groups.map((g, i) => [g.key, i]));
	const result = () => ({
		rows: rows.sort((a, b) => order.get(a.key) - order.get(b.key)),
		left,
		toCall: toCall.length,
		boundUsd,
		complete: rows.length + left.length === groups.length,
		needsCap: !dryRun && !ledger && toCall.length > 0,
	});
	if (dryRun) return result();
	// Answers reused from another file are copied into this one, so it holds every answer its entry counts.
	if (out) {
		const have = new Set(readJsonl(out).map((o) => `${o.key}|${o.inputHash}`));
		writeRows(out, rows.filter((r) => r.reused && !have.has(`${r.key}|${r.inputHash}`)));
	}
	if (toCall.length === 0 || !ledger) return result();

	const exposure = sealed ? { path: exposurePathFor(sealed.tasksDir), budget: loadBudget(sealed.tasksDir) } : null;
	await pool(toCall, concurrency, async ({ group, row, input }) => {
		const tier = sealed?.tierOf.get(group.task);
		const shown = exposure && SEALED.includes(tier) ? { kind: "run", tier, tasks: [group.task], test, tool: "meta-picker", by: "meta-pick" } : null;
		let costUsd = 0;
		let ms = 0;
		const complete = async ({ instructions, input: text }) => {
			if (shown) {
				const problems = budgetProblems({ entries: readExposures(exposure.path), add: [shown], budget: exposure.budget });
				if (problems.length) throw new SpendCapError(`leak budget: ${problems[0]}`);
				recordExposure(exposure.path, shown);
			}
			const bound = maxCallUsd(modelId, { inputBytes: Buffer.byteLength(instructions) + Buffer.byteLength(text), maxOutputTokens: MAX_OUTPUT_TOKENS });
			const entry = ledger.reserve("openai", { boundUsd: bound, candidate: `pick ${test} ${group.key}`, model: modelId, effort, maxOutputTokens: MAX_OUTPUT_TOKENS });
			const started = Date.now();
			let reply;
			try {
				reply = await model.complete({ model: modelId, instructions, input: text, maxOutputTokens: MAX_OUTPUT_TOKENS, effort });
			} catch (error) {
				const refused = error.status >= 400 && error.status < 500;
				ledger.settle("openai", entry, { ...(refused ? { costUsd: 0 } : {}), outcome: "error", why: String(error.message).slice(0, 300) });
				throw error;
			}
			ms += Date.now() - started;
			const cost = openaiCostUsd(reply.usage, reply.model ?? modelId, reply.serviceTier) ?? 0;
			costUsd += cost;
			ledger.settle("openai", entry, { costUsd: cost, reported: reply.model, status: reply.status, usage: reply.usage ? usageSummary(reply.usage) : null, outcome: "answered" });
			return reply;
		};
		let picked;
		try {
			picked = await pick({ key: group.key, task: input.task, evidence: input.evidence, complete });
			if (picked.index === null) picked = await pick({ key: group.key, task: input.task, evidence: input.evidence, complete });
		} catch (error) {
			if (error instanceof SpendCapError) {
				log(`${error.message}; ${group.key} not asked`);
				return;
			}
			log(`${group.key}: the call failed (${String(error.message).slice(0, 200)}); not counted, run again to retry`);
			return;
		}
		const metaOutcome = picked.index === null ? Math.min(...row.outcomes) : row.outcomes[picked.index];
		const r = { ...row, asked: true, picked: picked.index, confidence: picked.confidence, reason: picked.reason, metaOutcome, pickerUsd: costUsd, pickerMs: ms, reported: picked.reply.model ?? null };
		rows.push(r);
		if (out) writeRows(out, [r]);
		log(`${group.key}: picked ${picked.index === null ? "nothing" : row.labels[picked.index]}, $${costUsd.toFixed(4)}`);
	});
	toCall.splice(0, toCall.length, ...toCall.filter(({ group }) => !rows.some((r) => r.key === group.key)));
	return result();
}

function writeRows(out, rows) {
	if (!rows.length) return;
	mkdirSync(dirname(out), { recursive: true });
	appendFileSync(out, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const median = (xs) => {
	const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : null;
};

/**
 * The meta-harness's numbers from its decided groups, in the same terms as a single tool's: score (mean over tasks of
 * the task's mean chosen grade, percent) with the 95% bootstrap interval over tasks, cost (every arm's attempts plus the
 * picker, measured, plus the picker's estimated cost on groups not asked), cost per solved group, and median minutes.
 * `groups` is every group formed, so groups not yet decided are counted.
 */
export function metaEntry({ rows, groups, left = [], arms, picker = { model: PICKER_MODEL, effort: PICKER_EFFORT } }) {
	const byTask = new Map();
	for (const r of rows) {
		if (!byTask.has(r.task)) byTask.set(r.task, []);
		byTask.get(r.task).push(r);
	}
	const scores = [...byTask.values()].map((rs) => 100 * mean(rs.map((r) => r.metaOutcome)));
	const asked = rows.filter((r) => r.asked);
	const notAsked = rows.filter((r) => !r.asked && !r.problem);
	const pickerUsd = asked.reduce((s, r) => s + (r.pickerUsd ?? 0), 0);
	const perAsk = asked.length ? pickerUsd / asked.length : null;
	const pickerEstimatedUsd = notAsked.length && perAsk !== null ? perAsk * notAsked.length : 0;
	const attemptsUsd = rows.reduce((s, r) => s + r.costs.reduce((a, b) => a + b, 0), 0);
	const costUsd = attemptsUsd + pickerUsd + pickerEstimatedUsd;
	const solved = rows.filter((r) => r.metaOutcome === 1).length;
	const decided = rows.length + left.length;
	const answered = asked.filter((r) => r.picked !== null);
	return {
		kind: "meta",
		arms: arms.map((a) => a.label),
		picker,
		tasks: byTask.size,
		groups: rows.length,
		groupsLeftOut: left.length,
		groupsNotDecided: Math.max(0, (groups?.length ?? decided) - decided),
		score: scores.length ? mean(scores) : null,
		...(scores.length > 1 ? bootstrap(scores) : { low: null, high: null }),
		costUsd,
		attemptsUsd,
		pickerUsd,
		pickerEstimatedUsd,
		groupsAsked: asked.length,
		groupsPickerEstimated: pickerEstimatedUsd ? notAsked.length : 0,
		costPerSolvedUsd: solved ? costUsd / solved : null,
		medianMinutes: (() => {
			const m = median(rows.map((r) => Math.max(...r.wallMs.map((w) => w ?? 0)) + (r.pickerMs ?? 0)));
			return m === null ? null : m / 60_000;
		})(),
		splitGroups: rows.filter((r) => r.split).length,
		pickedTopGraded: answered.filter((r) => r.split && r.outcomes[r.picked] === Math.max(...r.outcomes)).length,
		unanswered: asked.filter((r) => r.picked === null).length,
		bestPossible: rows.length ? mean([...byTask.values()].map((rs) => 100 * mean(rs.map((r) => Math.max(...r.outcomes))))) : null,
	};
}

/** Reads a Keychain item (macOS `security`), never printing it. */
function keyFromKeychain(service) {
	try {
		return execFileSync("security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\n$/, "");
	} catch {
		return null;
	}
}

/** The picks file beside a stage's records: <stage>/meta/picks-<picker model>-<effort>.jsonl. */
export const picksPath = (recordsPath, modelId = PICKER_MODEL, effort = PICKER_EFFORT) => join(dirname(recordsPath), "meta", `picks-${modelId}-${effort}.jsonl`);

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values } = parseArgs({
		options: {
			records: { type: "string" },
			model: { type: "string" },
			test: { type: "string" },
			arms: { type: "string" },
			ask: { type: "string", default: "every" },
			"tasks-dir": { type: "string", multiple: true },
			"picker-model": { type: "string", default: PICKER_MODEL },
			effort: { type: "string", default: PICKER_EFFORT },
			reuse: { type: "string", multiple: true },
			out: { type: "string" },
			spend: { type: "string" },
			"openai-cap-usd": { type: "string" },
			keychain: { type: "string" },
			concurrency: { type: "string", default: "4" },
			"dry-run": { type: "boolean", default: false },
		},
	});
	if (!values.records || !values.model) throw new Error("--records <records.jsonl> and --model <the benchmark's model> are required");
	const recordsPath = resolve(values.records);
	let records = readJsonl(recordsPath).filter((r) => r.model === values.model && (!values.test || r.test === values.test));
	if (!records.length) throw new Error(`no records for ${values.model}${values.test ? ` in test ${values.test}` : ""} in ${values.records}`);
	const harbor = records.some((r) => r.jobName && r.trialName);
	const tests = [...new Set(records.map((r) => r.test))];
	if (tests.length > 1) throw new Error(`the records hold several tests (${tests.join(", ")}); choose one with --test`);
	const arms = values.arms ? parseArms(values.arms) : defaultArms(records);
	records = records.filter((r) => arms.some((a) => a.tool === r.tool));
	const { groups, missing, dropped } = buildGroups(records, arms);
	const tasksDirs = values["tasks-dir"] ?? [];
	if (!harbor && !tasksDirs.length) throw new Error("these are run-stage records: give --tasks-dir for the tasks' request.md");
	const loader = harbor ? harborLoader(dirname(recordsPath)) : patchLoader(dirname(recordsPath), tasksDirs);
	const tierOf = new Map(tasksDirs.flatMap((d) => (existsSync(d) ? [...readTasks(d)].map(([id, t]) => [id, t.tier]) : [])));
	const sealedDir = tasksDirs.find((d) => existsSync(d) && [...readTasks(d).values()].some((t) => SEALED.includes(t.tier)));
	const out = values.out ?? picksPath(recordsPath, values["picker-model"], values.effort);
	const reuse = (values.reuse ?? []).flatMap((p) => readJsonl(resolve(p)));
	console.log(`${values.model}, arms ${arms.map((a) => a.label).join(" + ")}: ${groups.length} groups over ${new Set(groups.map((g) => g.task)).size} tasks; ${missing.length} not formed (an arm's attempt is missing); ${dropped.length} tasks dropped for every tool`);
	let model = null;
	let ledger = null;
	if (!values["dry-run"] && values["openai-cap-usd"]) {
		if (values.keychain && !process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = keyFromKeychain(values.keychain) ?? "";
		model = openaiClient({ apiKey: process.env.OPENAI_API_KEY });
		ledger = openLedger(values.spend ?? join(dirname(out), "pick-spend.json"), { caps: { openai: values["openai-cap-usd"] } });
	}
	const test = tests[0];
	const result = await runPicks({
		groups, loader, benchModel: values.model, test, modelId: values["picker-model"], effort: values.effort, model, ledger, out, reuse,
		ask: values.ask, dryRun: values["dry-run"], concurrency: Number(values.concurrency),
		sealed: sealedDir ? { tasksDir: sealedDir, test, tierOf } : null,
	});
	if (values["dry-run"]) process.exit(0);
	if (result.needsCap) console.log(`nothing called: ${result.toCall} picker calls are paid; add --openai-cap-usd <usd> (and --keychain <service>) after a founder's yes`);
	const entry = metaEntry({ rows: result.rows, groups, left: result.left, arms, picker: { model: values["picker-model"], effort: values.effort } });
	const pct = (v) => (v === null ? "–" : `${v.toFixed(1)}%`);
	console.log(`\nRelay meta-harness (${entry.arms.join(" + ")}): ${pct(entry.score)} (95% interval ${pct(entry.low)} to ${pct(entry.high)}) over ${entry.tasks} tasks, ${entry.groups} groups`);
	console.log(`  cost $${entry.costUsd.toFixed(2)}: attempts $${entry.attemptsUsd.toFixed(2)} + picker $${entry.pickerUsd.toFixed(2)}${entry.pickerEstimatedUsd ? ` + picker estimated on ${entry.groupsPickerEstimated} groups not asked $${entry.pickerEstimatedUsd.toFixed(2)}` : ""}`);
	if (!result.complete) console.log(`  ${groups.length - result.rows.length - result.left.length} groups not decided yet; run the same command again (answers already given are reused)`);
	console.log(`picks: ${out}`);
}
