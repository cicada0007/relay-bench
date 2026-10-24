#!/usr/bin/env node
// Benchmark evidence for the harness's router (relay-harness D-101): the scoreboard's trials and the picker's answers,
// written as arm outcomes in the format `relay router learn --import <file>` reads (the harness's docs/queue.md, "The
// router"), one line per arm per run, to results/arm-outcomes.jsonl. The weekly scoreboard job rebuilds it, free: it
// reads records and picks already made, and asks nothing.
//
// - Read: the same stages the scoreboard reads (round 1's test F, and every stage under runs/scoreboard/), with the
//   same picker answers (each stage's picks file and the sources' `reuse` files). The sealed exam is never written
//   here: this file is public, and the exam's tasks are never named.
// - A run is one task worked once, every arm recorded together; its lines share `projectKey`, `taskId` and `at`.
//   - **Several arms**: one picker group (the tools' attempts with the same trial number on one task), one line per
//     attempt. `picked` is the picker's choice. Where the picker was not asked because every attempt had the same grade
//     (any choice scores the same), the attempt it would have been shown first is marked picked; that order is fixed by
//     the group, never by which tool made the attempt. Where it named none, none is picked.
//   - **One Relay arm**: each of Relay's trials alone, as the starting table's one-arm rows start it. With one attempt
//     the verifier keeps it when it passes, so `picked` is `verified`. Claude Code and Codex are written only beside
//     Relay, in the picker's groups, so an import never makes another harness usable by solving tasks on its own.
// - `verified` is the benchmark's own grade: the hidden tests passed (solved, resolved). `costUsd` is the arm's
//   metered model spend (an unmetered trial counts as its cap), `durationMs` its tool's run time, `arm.budgetUsd` its
//   cap, `arm.where` e2b (every trial ran in an E2B sandbox), `arm.strategy` direct (every tool worked straight at the
//   task) and `arm.model` the trial's model.
// - Kind and difficulty come from the task's own metadata where it has them (runner/task-meta.json, written from
//   Harbor's task files with --write-task-meta), else from the documented defaults in DEFAULTS below.
// - Left out, and counted: tasks dropped for every tool (our infrastructure failed twice), groups the picker has not
//   answered yet, groups where an attempt kept no record of its actions, and groups with a tool the router cannot start.
// - Every line is checked against the import format before anything is written; one bad line writes nothing.
//
//   node scripts/arm-outcomes.mjs                      writes results/arm-outcomes.jsonl from runs/
//   node scripts/arm-outcomes.mjs --dry-run            prints what it would write
//   node scripts/arm-outcomes.mjs --check <file>       checks a file against the import format, line by line
//   node scripts/arm-outcomes.mjs --write-task-meta    rewrites runner/task-meta.json from Harbor's task cache (free)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildGroups, defaultArms, droppedTasks, harborLoader, outcomeOf, runPicks } from "../meta/pick-groups.mjs";
import { showOrder } from "../meta/pick.mjs";
import { providerOf } from "../runner/arms.mjs";
import { BENCHMARKS, loadBenchmark } from "../runner/harbor-bench.mjs";
import { metaOf, readTaskMeta, TASK_META } from "../runner/task-meta.mjs";
import { picksFor, SOURCES, scannedSources } from "./scoreboard-sources.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
export const OUT = join(ROOT, "results", "arm-outcomes.jsonl");
export { readTaskMeta, TASK_META };

// The import format, as relay-harness's core/meta/router/store.ts reads it (parseArmOutcome) at origin/main on
// 24 Oct 2026. arm-outcomes.test.mjs compares these lists with the harness's when its checkout is beside this one.
export const HARNESS_IDS = Object.freeze(["relay", "claude-code", "codex"]);
export const TASK_KINDS = Object.freeze(["bug", "feature", "refactor", "test", "docs", "chore", "other"]);
export const DIFFICULTIES = Object.freeze(["easy", "medium", "hard"]);
export const STRATEGIES = Object.freeze(["direct", "reproduce-first", "plan-first"]);
export const ENDINGS = Object.freeze(["finished", "stopped-at-budget", "timed-out", "failed"]);
export const PULL_OUTCOMES = Object.freeze(["merged", "merged-after-edits", "closed", "reverted"]);

/**
 * What a line says when the task's metadata does not: per benchmark, its kind (SWE-bench Verified's tasks are GitHub
 * issues whose fix makes failing tests pass, so bug fixes; SWE-bench Pro mixes bug fixes and features; Terminal-Bench's
 * tasks are mostly not code changes to a project), and a medium difficulty when the task has none.
 */
export const DEFAULTS = Object.freeze({
	difficulty: "medium",
	kind: Object.freeze({ "terminal-bench-2-1": "other", "swebench-verified": "bug", "swebench-pro": "other" }),
	otherKind: "other",
	strategy: "direct",
	where: "e2b",
});

/** SWE-bench Verified's annotators' time to fix, as its metadata writes it, to a difficulty. */
const FIX_TIME = Object.freeze({ "<15 min fix": "easy", "15 min - 1 hour": "medium", "1-4 hours": "hard", ">4 hours": "hard" });

/** A difficulty from a task's metadata (easy, medium or hard, or SWE-bench's time to fix), or null. */
export function difficultyOf(value) {
	if (typeof value !== "string") return null;
	const v = value.trim().toLowerCase();
	if (DIFFICULTIES.includes(v)) return v;
	return FIX_TIME[value.trim()] ?? null;
}

/** A kind from a task's metadata (its kind, or a category such as Terminal-Bench's "debugging"), or null. */
export function kindOf(meta) {
	if (TASK_KINDS.includes(meta?.kind)) return meta.kind;
	const words = [meta?.category, ...(Array.isArray(meta?.categories) ? meta.categories : [])].filter((w) => typeof w === "string").join(" ").toLowerCase();
	if (!words) return null;
	if (/bug|debug/.test(words)) return "bug";
	if (/feat/.test(words)) return "feature";
	if (/refactor/.test(words)) return "refactor";
	if (/\btests?\b|testing/.test(words)) return "test";
	if (/\bdocs?\b|documentation/.test(words)) return "docs";
	return null;
}

/** A task's kind and difficulty, and where each came from ("metadata" or "default"). */
export function taskProfile(benchmark, task, meta = readTaskMeta()) {
	const m = metaOf(benchmark, task, meta);
	const kind = kindOf(m);
	const difficulty = difficultyOf(m?.difficulty);
	return {
		kind: kind ?? DEFAULTS.kind[benchmark] ?? DEFAULTS.otherKind,
		difficulty: difficulty ?? DEFAULTS.difficulty,
		from: { kind: kind ? "metadata" : "default", difficulty: difficulty ? "metadata" : "default" },
	};
}

/** Why a value is not an arm outcome the harness imports, in its own words, or null when it is one. */
export function armOutcomeProblem(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "it is not an object";
	const text = (from, name) => typeof from[name] === "string" && from[name].length > 0;
	const amount = (from, name) => typeof from[name] === "number" && Number.isFinite(from[name]) && from[name] >= 0;
	const oneOf = (from, name, allowed) => typeof from[name] === "string" && allowed.includes(from[name]);
	if (!text(value, "at") || !Number.isFinite(Date.parse(value.at))) return "at is not a time";
	if (!text(value, "projectKey")) return "projectKey is missing";
	if (!text(value, "taskId")) return "taskId is missing";
	if (!oneOf(value, "kind", TASK_KINDS)) return `kind is not one of ${TASK_KINDS.join(", ")}`;
	if (!oneOf(value, "difficulty", DIFFICULTIES)) return `difficulty is not one of ${DIFFICULTIES.join(", ")}`;
	const arm = value.arm;
	if (!arm || typeof arm !== "object" || Array.isArray(arm)) return "arm is missing";
	if (!oneOf(arm, "harness", HARNESS_IDS)) return `arm.harness is not one of ${HARNESS_IDS.join(", ")}`;
	if (typeof arm.model !== "string" || arm.model === "") return "arm.model is missing";
	if (!oneOf(arm, "strategy", STRATEGIES)) return `arm.strategy is not one of ${STRATEGIES.join(", ")}`;
	if (!amount(arm, "budgetUsd")) return "arm.budgetUsd is not an amount";
	if (!oneOf(arm, "where", ["local", "e2b"])) return "arm.where is not local or e2b";
	if (!oneOf(value, "ending", ENDINGS)) return `ending is not one of ${ENDINGS.join(", ")}`;
	if (typeof value.verified !== "boolean") return "verified is not true or false";
	if (typeof value.picked !== "boolean") return "picked is not true or false";
	if (value.pullRequest !== undefined && !oneOf(value, "pullRequest", PULL_OUTCOMES)) return `pullRequest is not one of ${PULL_OUTCOMES.join(", ")}`;
	if (!amount(value, "costUsd")) return "costUsd is not an amount";
	if (!amount(value, "durationMs")) return "durationMs is not a number of milliseconds";
	if (value.armId !== undefined && !text(value, "armId")) return "armId is empty";
	return null;
}

/** Every arm outcome in JSONL text, and why each other line is not one ("line 3: kind is not one of ..."). */
export function parseOutcomeLines(text) {
	const outcomes = [];
	const problems = [];
	String(text ?? "")
		.split("\n")
		.forEach((raw, i) => {
			if (raw.trim() === "") return;
			let value;
			try {
				value = JSON.parse(raw);
			} catch {
				problems.push(`line ${i + 1}: it is not JSON`);
				return;
			}
			const why = armOutcomeProblem(value);
			if (why) problems.push(`line ${i + 1}: ${why}`);
			else outcomes.push(value);
		});
	return { outcomes, problems };
}

/** The run an outcome belongs to, as the harness groups them (runKey). */
export const runKey = (o) => `${o.projectKey}\u0000${o.taskId}\u0000${o.at}`;

const baseTool = (tool) => String(tool).split("@")[0];
const iso = (t) => {
	const ms = Date.parse(t ?? "");
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** How a trial ended, in the harness's words. */
export function endingOf(r) {
	if (r.stoppedAtCap || r.stoppedAtSandboxCap) return "stopped-at-budget";
	if (r.exception === "AgentTimeoutError") return "timed-out";
	if (r.exception) return "failed";
	return "finished";
}

/** One trial as one arm's line of a run. */
function line({ benchmark, record, run, profile, picked, armId }) {
	const verified = outcomeOf(record) === 1;
	return {
		at: run.at,
		projectKey: `bench/${benchmark}`,
		taskId: run.taskId,
		kind: profile.kind,
		difficulty: profile.difficulty,
		arm: { harness: baseTool(record.tool), model: `${providerOf(record.model)}/${record.model}`, strategy: DEFAULTS.strategy, budgetUsd: record.capUsd ?? 0, where: DEFAULTS.where },
		ending: endingOf(record),
		verified,
		picked,
		costUsd: record.usage ? record.usage.costUsd : (record.capUsd ?? 0),
		durationMs: Math.max(0, record.wallMs ?? 0),
		armId,
	};
}

/**
 * One stage's run (one test on one model): its arm outcomes and what was left out. `rows` are the picker's decided
 * groups (meta/pick-groups.mjs runPicks), `groups` every group formed.
 */
export function stageOutcomes({ benchmark, records, groups, rows, left = [], meta = readTaskMeta() }) {
	const dropped = new Set(droppedTasks(records));
	const lines = [];
	const out = { groups: groups.length, groupsWritten: 0, groupsNotDecided: 0, groupsLeftOut: left.length, groupsOtherTool: 0, relayAlone: 0, droppedTasks: dropped.size, defaults: { kind: 0, difficulty: 0 } };
	const profiles = new Map();
	const profileOf = (task) => {
		if (!profiles.has(task)) {
			const p = taskProfile(benchmark, task, meta);
			profiles.set(task, p);
			if (p.from.kind === "default") out.defaults.kind++;
			if (p.from.difficulty === "default") out.defaults.difficulty++;
		}
		return profiles.get(task);
	};
	// One Relay arm: each of Relay's trials on a counted task.
	for (const r of records) {
		if (r.infra || dropped.has(r.task) || baseTool(r.tool) !== "relay") continue;
		const at = iso(r.startedAt);
		if (!at) continue;
		const verified = outcomeOf(r) === 1;
		lines.push(line({ benchmark, record: r, run: { at, taskId: `${r.task} r${r.rep} relay` }, profile: profileOf(r.task), picked: verified, armId: "a1" }));
		out.relayAlone++;
	}
	// Several arms: one run per decided picker group.
	const byKey = new Map(rows.map((row) => [row.key, row]));
	const leftKeys = new Set(left.map((l) => l.key));
	for (const g of groups) {
		if (leftKeys.has(g.key)) continue;
		const row = byKey.get(g.key);
		if (!row) {
			out.groupsNotDecided++;
			continue;
		}
		if (g.attempts.some((a) => !HARNESS_IDS.includes(baseTool(a.record.tool)))) {
			out.groupsOtherTool++;
			continue;
		}
		const at = g.attempts.map((a) => iso(a.record.startedAt)).filter(Boolean).sort()[0];
		if (!at) continue;
		// The picker's choice; unasked (every attempt graded the same), the attempt shown first; none named, none.
		const chosen = row.asked ? row.picked : row.problem ? null : showOrder(g.key, g.attempts.length)[0];
		const tools = g.attempts.map((a) => baseTool(a.record.tool));
		const run = { at, taskId: `${g.task} r${g.rep ?? 1} ${tools.join("+")}` };
		g.attempts.forEach((a, i) => lines.push(line({ benchmark, record: a.record, run, profile: profileOf(g.task), picked: chosen === i, armId: `a${i + 1}` })));
		out.groupsWritten++;
	}
	return { lines, summary: out };
}

const readJsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);

/**
 * Every public stage the scoreboard reads, as arm outcomes. Returns { lines, stages: [summary per run], problems }.
 * Asks nothing: the picker's answers come from the files the stages already hold.
 */
export async function buildArmOutcomes({ runsDir, sources = null, meta = readTaskMeta() }) {
	const all = sources ?? [...SOURCES, ...scannedSources(runsDir)];
	const lines = [];
	const stages = [];
	for (const source of all) {
		if (!BENCHMARKS[source.benchmark]) continue;
		const stageDir = join(runsDir, source.stage);
		const records = readJsonl(join(stageDir, "records.jsonl"));
		const reuse = picksFor(stageDir, runsDir, source.reuse);
		const runs = new Map();
		for (const r of records) {
			const id = `${r.test}|${r.model}`;
			if (!runs.has(id)) runs.set(id, []);
			runs.get(id).push(r);
		}
		for (const [, rs] of runs) {
			const tools = new Set(rs.map((r) => r.tool));
			let groups = [];
			let rows = [];
			let left = [];
			if (tools.size >= 2) {
				({ groups } = buildGroups(rs, defaultArms(rs)));
				({ rows, left } = await runPicks({ groups, loader: harborLoader(stageDir), reuse, ask: "split", dryRun: true, log: () => {} }));
			}
			const result = stageOutcomes({ benchmark: source.benchmark, records: rs, groups, rows, left, meta });
			lines.push(...result.lines);
			stages.push({ stage: source.stage, benchmark: source.benchmark, test: rs[0].test, model: rs[0].model, lines: result.lines.length, ...result.summary });
		}
	}
	const problems = [];
	const seen = new Map();
	lines.forEach((l, i) => {
		const why = armOutcomeProblem(l);
		if (why) problems.push(`line ${i + 1}: ${why}`);
		const key = `${runKey(l)}\u0000${l.armId}`;
		if (seen.has(key)) problems.push(`line ${i + 1}: the same arm of the same run as line ${seen.get(key) + 1}`);
		seen.set(key, i);
	});
	return { lines, stages, problems };
}

/** Writes the lines, one JSON object a line, after checking every one. Throws, writing nothing, on any problem. */
export function writeArmOutcomes(path, { lines, problems }) {
	if (problems.length) throw new Error(`the arm outcomes are not all in the import format, so nothing was written: ${problems.slice(0, 3).join("; ")}`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
	return path;
}

/** One line per stage, for a person. */
export function describeStages(stages) {
	return stages.map((s) => {
		const parts = [`${s.lines} lines`, `${s.relayAlone} Relay trials alone`, `${s.groupsWritten} of ${s.groups} picker groups`];
		if (s.groupsNotDecided) parts.push(`${s.groupsNotDecided} groups not picked yet`);
		if (s.groupsLeftOut) parts.push(`${s.groupsLeftOut} left out (an attempt kept no record of its actions)`);
		if (s.groupsOtherTool) parts.push(`${s.groupsOtherTool} with a tool the router cannot start`);
		if (s.droppedTasks) parts.push(`${s.droppedTasks} tasks dropped for every tool`);
		if (s.defaults.kind || s.defaults.difficulty) parts.push(`default kind on ${s.defaults.kind} tasks, default difficulty on ${s.defaults.difficulty}`);
		return `${s.stage} (${s.test}, ${s.model}): ${parts.join(", ")}`;
	});
}

/** A task.toml's metadata this file keeps: difficulty, category, and the sandbox's size. */
export function tomlMeta(text) {
	const section = (name) => {
		const m = new RegExp(`^\\[${name}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m").exec(text);
		return m ? m[1] : "";
	};
	const str = (body, key) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(body)?.[1] ?? null;
	const num = (body, key) => {
		const v = new RegExp(`^${key}\\s*=\\s*([\\d.]+)`, "m").exec(body)?.[1];
		return v === undefined ? null : Number(v);
	};
	const metadata = section("metadata");
	const env = section("environment");
	const out = {};
	for (const [k, v] of [["difficulty", str(metadata, "difficulty")], ["category", str(metadata, "category")], ["cpus", num(env, "cpus")], ["memoryMb", num(env, "memory_mb")]]) if (v !== null) out[k] = v;
	return out;
}

/**
 * The pinned tasks' metadata from Harbor's task cache (<cache>/packages/<org>/<name>/<digest>/task.toml), matched by
 * each task's pinned digest, so a task that changed upstream is not read. Returns the file's object and the counts.
 */
export function taskMetaFromCache({ cache = join(homedir(), ".cache", "harbor", "tasks"), written = new Date().toISOString().slice(0, 10) } = {}) {
	const out = { about: "Each pinned task's metadata, from its own task.toml in Harbor's task cache, matched by the task's pinned digest (scripts/arm-outcomes.mjs --write-task-meta). Used for the arm outcomes' kind and difficulty and for sizing a task's sandbox; a task not listed takes the documented defaults." };
	const counts = {};
	for (const id of Object.keys(BENCHMARKS)) {
		const bench = loadBenchmark(id);
		const tasks = {};
		for (const t of bench.tasks) {
			const [org, ...rest] = t.name.split("/");
			const path = join(cache, "packages", org, rest.join("/"), t.ref.replace(/^sha256:/, ""), "task.toml");
			if (existsSync(path)) tasks[t.name] = tomlMeta(readFileSync(path, "utf8"));
		}
		counts[id] = { found: Object.keys(tasks).length, of: bench.tasks.length };
		if (Object.keys(tasks).length) out[id] = { dataset: `${bench.dataset}@${bench.ref}`, written, tasks };
	}
	return { meta: out, counts };
}

/** The metadata file's text: one task a line, so a change to one task is one line of the diff. */
export function taskMetaText(meta) {
	const lines = ["{", `\t"about": ${JSON.stringify(meta.about)}`];
	for (const id of Object.keys(meta).filter((k) => k !== "about")) {
		const b = meta[id];
		lines[lines.length - 1] += ",";
		lines.push(`\t${JSON.stringify(id)}: {`, `\t\t"dataset": ${JSON.stringify(b.dataset)},`, `\t\t"written": ${JSON.stringify(b.written)},`, '\t\t"tasks": {');
		const names = Object.keys(b.tasks).sort();
		names.forEach((n, i) => lines.push(`\t\t\t${JSON.stringify(n)}: ${JSON.stringify(b.tasks[n])}${i < names.length - 1 ? "," : ""}`));
		lines.push("\t\t}", "\t}");
	}
	lines.push("}", "");
	return lines.join("\n");
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values: args } = parseArgs({
		options: {
			runs: { type: "string", default: join(ROOT, "runs") },
			to: { type: "string", default: OUT },
			"dry-run": { type: "boolean", default: false },
			check: { type: "string" },
			"write-task-meta": { type: "boolean", default: false },
			cache: { type: "string" },
		},
	});
	if (args.check) {
		const { outcomes, problems } = parseOutcomeLines(readFileSync(resolve(args.check), "utf8"));
		console.log(`${outcomes.length} arm outcomes in the import format${problems.length ? `; ${problems.length} lines are not:` : ""}`);
		for (const p of problems) console.log(`  ${p}`);
		process.exit(problems.length ? 1 : 0);
	}
	if (args["write-task-meta"]) {
		const { meta, counts } = taskMetaFromCache(args.cache ? { cache: resolve(args.cache) } : {});
		for (const [id, c] of Object.entries(counts)) console.log(`${id}: ${c.found} of ${c.of} tasks found in Harbor's task cache`);
		if (!args["dry-run"]) {
			writeFileSync(TASK_META, taskMetaText(meta));
			console.log(`wrote ${TASK_META}`);
		}
		process.exit(0);
	}
	const built = await buildArmOutcomes({ runsDir: resolve(args.runs) });
	for (const s of describeStages(built.stages)) console.log(s);
	for (const p of built.problems) console.log(`not in the import format: ${p}`);
	if (args["dry-run"]) {
		console.log(`${built.lines.length} arm outcomes; dry run, nothing written`);
		process.exit(built.problems.length ? 1 : 0);
	}
	writeArmOutcomes(resolve(args.to), built);
	console.log(`wrote ${resolve(args.to)}: ${built.lines.length} arm outcomes. A person imports them with: relay router learn --import ${resolve(args.to)}`);
}
