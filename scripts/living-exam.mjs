#!/usr/bin/env node
// The living exam's weekly pipeline (TIERS.md, "The living exam"): new post-cutoff tasks every week, drafted by another
// model family, approved by a person, locked; and a harder level opened when one is saturated. Relay proposes tasks;
// humans approve them; Relay never grades its own exam.
//
//   node scripts/living-exam.mjs --exam ../relay-exam --cutoff 2026-07-01 \
//     [--mine] [--limit 50] [--spend-cap 2] [--records ../relay-exam/runs/gate/records.jsonl --tool relay@0.6.121] \
//     [--from <step>] [--dry-run]
//
// The steps, in order. Each runs only when its inputs exist, and says why when it does not:
//   mine           search GitHub for candidates (scripts/mine-tasks.mjs, free, read-only). Only with --mine, since
//                  another miner may already be writing candidates.jsonl; it is called with its usual command line.
//   filter         candidates not drafted, not rejected before, each given its level (scripts/saturation.mjs).
//   contamination  scan them against everything the loop can see and against their dates (scripts/contamination.mjs);
//                  contaminated ones are rejected, with the reasons.
//   draft          PAID: one OpenAI call per candidate that passes its judge check (scripts/draft-task.mjs). Without
//                  --spend-cap the pipeline stops here and says what is waiting. With it, it drafts while the estimate
//                  ($0.05 a candidate, the upper end in RUNBOOK.md) stays within the cap. Only open levels are drafted.
//   approve        the drafted tasks no person has approved yet, each scanned again with its request; builds the
//                  local review page (scripts/build-review-page.mjs). A person approves (scripts/approve-task.mjs).
//   lock           when approved tasks differ from the lock, lock the exam again (scripts/lock-tasks.mjs).
//   saturation     with --records and --tool: open a harder level's queue when a level is passed 90% or more.
// --from <step> starts at a later step (for example --from approve, to queue last week's drafts without drafting).
// Everything it writes goes in <exam>/queue/ (or the exam's own files, through the scripts above), never here.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readTasks } from "../runner/stage-tasks.mjs";
import { approvalProblems, isSealed } from "./approve-task.mjs";
import { corpusFor, readCandidates, scan } from "./contamination.mjs";
import { lockDifferences } from "./lock-tasks.mjs";
import { levelOf, openHarder, openLevel, saturation } from "./saturation.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
export const STEPS = Object.freeze(["mine", "filter", "contamination", "draft", "approve", "lock", "saturation"]);
/** The most one drafting attempt is expected to cost (RUNBOOK.md: $0.01 to $0.05 a call). */
export const DRAFT_COST_USD = 0.05;

const readJsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Runs a script of this repository with node and the given arguments. */
export function nodeScript(script, args, env = process.env) {
	const r = spawnSync(process.execPath, [join(ROOT, script), ...args], { encoding: "utf8", env });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * The pipeline. `exec(script, args)` runs one of this repository's scripts (nodeScript by default; tests pass a fake).
 * `root` is the public repository whose files the contamination scan treats as loop-visible (this one by default).
 * Returns [{ step, status: "ran" | "skipped" | "stopped", why, ... }]; a "stopped" step ends the run.
 */
export async function runPipeline({ exam, cutoff, mine = false, limit = 50, spendCap = null, records = null, tool = null, from = "mine", dryRun = false, env = process.env, exec = nodeScript, now = new Date(), root = ROOT }) {
	if (!STEPS.includes(from)) throw new Error(`--from must be one of ${STEPS.join(", ")}`);
	const insideRepo = relative(ROOT, resolve(exam));
	if (!insideRepo.startsWith("..") && !isAbsolute(insideRepo)) throw new Error(`the exam lives outside this public repository; ${exam} is inside it`);
	const tasksDir = join(exam, "tasks");
	const queue = join(exam, "queue");
	const candidatesPath = join(exam, "candidates.jsonl");
	const write = (name, rows) => {
		if (dryRun) return;
		mkdirSync(queue, { recursive: true });
		writeFileSync(join(queue, name), rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
	};
	const reject = (rows) => {
		if (dryRun || !rows.length) return;
		mkdirSync(queue, { recursive: true });
		appendFileSync(join(queue, "rejected.jsonl"), rows.map((r) => `${JSON.stringify({ ...r, at: now.toISOString() })}\n`).join(""));
	};
	const report = [];
	const done = (step, status, why, extra = {}) => report.push({ step, status, why, ...extra });
	const at = (step) => STEPS.indexOf(step) >= STEPS.indexOf(from);
	const drafted = () => new Set(existsSync(tasksDir) ? readdirSync(tasksDir).filter((id) => existsSync(join(tasksDir, id, "task.json"))) : []);

	if (at("mine")) {
		if (!mine) done("mine", "skipped", "not asked (--mine): candidates.jsonl is read as it is");
		else if (!cutoff) done("mine", "skipped", "needs --cutoff, the latest training cutoff of the models tested");
		else if (!env.GITHUB_TOKEN && !env.GH_TOKEN) done("mine", "skipped", "needs GITHUB_TOKEN in the environment");
		else if (dryRun) done("mine", "skipped", "dry run");
		else {
			const r = exec("scripts/mine-tasks.mjs", ["--cutoff", cutoff, "--out", candidatesPath, "--limit", String(limit)]);
			done("mine", r.status === 0 ? "ran" : "stopped", r.status === 0 ? (r.stdout.trim().split("\n").pop() ?? "") : `mine-tasks exited ${r.status}`);
			if (r.status !== 0) return report;
		}
	}

	const candidates = readCandidates(candidatesPath);
	let filtered = [];
	if (at("filter")) {
		if (!candidates.length) done("filter", "skipped", "no candidates yet (candidates.jsonl)");
		else {
			const rejected = new Set(readJsonl(join(queue, "rejected.jsonl")).map((r) => r.id));
			const have = drafted();
			filtered = candidates.filter((c) => !have.has(c.id) && !rejected.has(c.id)).map((c) => ({ ...c, level: levelOf(c) }));
			write("filtered.jsonl", filtered);
			done("filter", "ran", `${filtered.length} of ${candidates.length} candidates are new`, { count: filtered.length });
		}
	} else filtered = readJsonl(join(queue, "filtered.jsonl"));

	let clean = [];
	if (at("contamination")) {
		if (!filtered.length) done("contamination", "skipped", "no new candidates to scan");
		else if (!cutoff) done("contamination", "skipped", "needs --cutoff to check the candidates' dates");
		else {
			const corpus = await corpusFor({ exam, candidates, root });
			const results = filtered.map((c) => ({ ...scan(c, corpus, { cutoff }), level: c.level }));
			clean = filtered.filter((c, i) => results[i].clean);
			write("contamination.jsonl", results.map((r) => ({ ...r, at: now.toISOString() })));
			write("clean.jsonl", clean);
			reject(results.filter((r) => !r.clean).map((r) => ({ id: r.id, step: "contamination", reasons: r.hits.map((h) => `${h.kind}: ${h.detail}`) })));
			done("contamination", "ran", `${clean.length} clean, ${results.length - clean.length} rejected`, { clean: clean.length, rejected: results.length - clean.length });
		}
	} else clean = readJsonl(join(queue, "clean.jsonl"));

	if (at("draft")) {
		const have = drafted();
		const waiting = clean.filter((c) => !have.has(c.id));
		const open = openLevel(exam, "exam");
		const ready = waiting.filter((c) => (c.level ?? 1) <= open);
		const held = waiting.length - ready.length;
		write("draft.jsonl", waiting.map((c) => ({ id: c.id, level: c.level ?? 1, open: (c.level ?? 1) <= open })));
		if (!ready.length) done("draft", "skipped", held ? `${held} candidates wait for a harder level to open` : "nothing to draft");
		else if (spendCap === null) {
			done("draft", "stopped", `${ready.length} candidates wait for drafting, a paid step (one OpenAI call each, at most about $${(ready.length * DRAFT_COST_USD).toFixed(2)}); run again with --spend-cap <usd>`, { waiting: ready.length });
			return report;
		} else if (!env.OPENAI_API_KEY) {
			done("draft", "stopped", "needs OPENAI_API_KEY in the environment for the drafting model");
			return report;
		} else if (dryRun) done("draft", "skipped", `dry run: would draft up to ${Math.min(ready.length, Math.floor(spendCap / DRAFT_COST_USD))} within $${spendCap}`);
		else {
			let spent = 0;
			let ok = 0;
			const failed = [];
			for (const c of ready) {
				if (spent + DRAFT_COST_USD > spendCap + 1e-9) break;
				spent += DRAFT_COST_USD;
				const r = exec("scripts/draft-task.mjs", ["--candidate", c.id, "--candidates", candidatesPath, "--tasks-dir", tasksDir, "--tier", "exam", "--level", String(c.level ?? 1)]);
				if (r.status === 0) ok++;
				else failed.push({ id: c.id, step: "draft", reasons: [(r.stderr.trim().split("\n").find((l) => /Error|error:/.test(l)) ?? r.stderr.trim().split("\n").pop() ?? `exit ${r.status}`).slice(0, 300)] });
			}
			reject(failed);
			done("draft", "ran", `drafted ${ok}, ${failed.length} could not be drafted; at most $${spent.toFixed(2)} of $${spendCap}`, { drafted: ok, failed: failed.length, spentEstimateUsd: spent });
		}
	}

	if (at("approve")) {
		const tasks = existsSync(tasksDir) ? readTasks(tasksDir) : new Map();
		const pending = [...tasks].filter(([, t]) => isSealed(t) && !t.approvedBy);
		if (!pending.length) done("approve", "skipped", "no drafted task waits for a person");
		else {
			const corpus = await corpusFor({ exam, candidates, root });
			const rows = pending.map(([id, t]) => {
				const request = existsSync(join(tasksDir, id, "request.md")) ? readFileSync(join(tasksDir, id, "request.md"), "utf8") : "";
				const r = scan({ ...t, request }, corpus, { cutoff: cutoff ?? t.source?.cutoff ?? "1970-01-01" });
				return { id, level: t.level ?? 1, draftedBy: t.draftedBy ?? null, clean: r.clean, hits: r.hits };
			});
			write("approve.jsonl", rows);
			let page = "";
			if (!dryRun && rows.some((r) => r.clean)) {
				const r = exec("scripts/build-review-page.mjs", ["--tasks-dir", tasksDir]);
				page = r.status === 0 ? "; review page built" : `; the review page failed (exit ${r.status})`;
			}
			const dirty = rows.filter((r) => !r.clean).length;
			done("approve", "ran", `${rows.length - dirty} tasks wait for a person's approval${dirty ? `, ${dirty} failed the scan (remove them)` : ""}${page}`, { waiting: rows.length - dirty, contaminated: dirty });
		}
	}

	if (at("lock")) {
		const tasks = existsSync(tasksDir) ? readTasks(tasksDir) : new Map();
		const approved = [...tasks].filter(([, t]) => isSealed(t) && approvalProblems(t).length === 0).map(([id]) => id);
		const differ = approved.length ? lockDifferences(approved, tasksDir) : [];
		if (!approved.length) done("lock", "skipped", "no approved task yet");
		else if (!differ.length) done("lock", "skipped", "the lock already matches every approved task");
		else if (dryRun) done("lock", "skipped", `dry run: ${differ.length} differences from the lock`);
		else {
			const r = exec("scripts/lock-tasks.mjs", ["--tasks-dir", tasksDir]);
			done("lock", r.status === 0 ? "ran" : "stopped", r.status === 0 ? `locked; ${differ.length} differences recorded` : `lock-tasks exited ${r.status}`);
			if (r.status !== 0) return report;
		}
	}

	if (at("saturation")) {
		if (!records || !tool) done("saturation", "skipped", "needs --records and --tool (the champion)");
		else {
			const rs = records.flatMap((p) => readJsonl(p));
			const results = saturation(rs, existsSync(tasksDir) ? readTasks(tasksDir) : new Map(), { tool });
			const opened = openHarder(exam, results, { now, write: !dryRun });
			write("saturation.jsonl", results.map((r) => ({ ...r, tool, at: now.toISOString() })));
			done("saturation", "ran", `${results.filter((r) => r.saturated).length} saturated levels; opened ${opened.map((o) => `${o.tier} level ${o.level}`).join(", ") || "none"}`, { opened });
		}
	}
	return report;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values } = parseArgs({
		options: {
			exam: { type: "string" },
			cutoff: { type: "string" },
			mine: { type: "boolean", default: false },
			limit: { type: "string", default: "50" },
			"spend-cap": { type: "string" },
			records: { type: "string", multiple: true },
			tool: { type: "string" },
			from: { type: "string", default: "mine" },
			"dry-run": { type: "boolean", default: false },
		},
	});
	if (!values.exam) throw new Error("--exam is required: the private exam repository, such as ../relay-exam");
	if (values.cutoff && Number.isNaN(Date.parse(values.cutoff))) throw new Error("--cutoff is a date, YYYY-MM-DD");
	const spendCap = values["spend-cap"] === undefined ? null : Number(values["spend-cap"]);
	if (spendCap !== null && !(spendCap >= 0)) throw new Error("--spend-cap is a number of dollars");
	const report = await runPipeline({
		exam: resolve(values.exam),
		cutoff: values.cutoff,
		mine: values.mine,
		limit: Number(values.limit),
		spendCap,
		records: values.records?.map((p) => resolve(p)) ?? null,
		tool: values.tool,
		from: values.from,
		dryRun: values["dry-run"],
	});
	for (const r of report) console.log(`${r.step.padEnd(14)} ${r.status.padEnd(8)} ${r.why}`);
	process.exitCode = report.some((r) => r.status === "stopped") ? 3 : 0;
}
