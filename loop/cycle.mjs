#!/usr/bin/env node
// The improvement loop's weekly cycle (v7, Central: improvement loop; Meta: meta loop). One command chains:
//
//   meta        judge the loop's own settings by gated gain per dollar over the last cycles (free; proposes only)
//   analyze     failure clusters from practice and public runs and Relay's queue reports (free)
//   propose     changes, one lane each, checked against their lane and the invariants: the rules lanes free, the
//               writer lanes (prompts and skills, tools) PAID, one model call each, and taught skills (--teaching,
//               the skill candidates teaching/graduate.mjs wrote; TEACHING.md) free, in the prompts and skills lane
//   exam        kinds of task the exam should mine more of, into the exam's approval queue (free; never approved)
//   prescreen   PAID: each proposal's build against the champion on the dev set (practice), then the selection set
//               (the check tier's one word), within each lane's fixed budget and the command's --spend-cap
//   package     one combined release: the PR body, the patch, the gate's manifest and the ledger entry it would make,
//               written to files; the loop never opens a pull request in relay-harness
//
//   node loop/cycle.mjs --records runs/round-1/records.jsonl [--records runs/round-1/F/records.jsonl] \
//     --harness ../prime-agent-main --harness-ref origin/feat/architecture-as-code --champion 0.6.121 \
//     [--exam ../relay-exam] [--teaching runs/teaching] [--spend-cap 20 | --dry-run] [--cycle 2026-W43] [--out runs/loop]
//
// Without --spend-cap it stops before the first paid step and says what waits and the most it could cost (exit 3).
// --dry-run writes nothing and spends nothing. A cycle run again resumes: its analysis and proposals are fixed at its
// first run, and finished pre-screens are kept. Every paid step also needs the loop's settings approved by a person
// (node loop/meta.mjs approve). Output: <out>/<cycle>/ holds cycle.json, report.md, summary.json, spend.jsonl, one
// patch per proposal, and release/ with the package.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readLedger } from "../scripts/ledger.mjs";
import { readTasks, selectTasks } from "../runner/stage-tasks.mjs";
import { analyze, readRecords, studyable } from "./analyze.mjs";
import { LANE_ORDER, LANES } from "./lanes.mjs";
import { judgeMeta, loadSettings, metaProposals, PAID_LANES, readCycles, SETTINGS_PATH, settingsHash } from "./meta.mjs";
import { describeChange, packageRelease } from "./package.mjs";
import { prescreen, prescreenPlan, wallet } from "./prescreen.mjs";
import { readCandidates } from "../teaching/graduate.mjs";
import { examProposalProblems, examProposals, ruleCandidates, selectProposals, teachingProposals, writeProposal, writerInput, writerTargets } from "./propose.mjs";
import { anthropicWriter, DEFAULT_WRITER_MODEL, writerProblems } from "./writer.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
export const STEPS = Object.freeze(["meta", "analyze", "propose", "exam", "prescreen", "package"]);

/** The ISO week of a date, as a cycle id: 2026-W43. */
export function isoWeek(now = new Date()) {
	const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const day = d.getUTCDay() || 7;
	d.setUTCDate(d.getUTCDate() + 4 - day);
	const year = d.getUTCFullYear();
	const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
	return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Runs a script of this repository with node. */
export function nodeScript(script, args, env = process.env) {
	const r = spawnSync(process.execPath, [join(ROOT, script), ...args], { encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** A file of the harness at a git revision, or null. */
export function gitShow(harness, ref, file) {
	try {
		return execFileSync("git", ["-C", harness, "show", `${ref}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
	} catch {
		return null;
	}
}

const readJsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const insideRepo = (path) => {
	const rel = relative(ROOT, resolve(path));
	return !rel.startsWith("..") && !isAbsolute(rel);
};
const money2 = (x) => `$${(x ?? 0).toFixed(2)}`;
const keep = ({ after, weight, ...p }) => p;
const n = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * One cycle. Every input is an option, so tests run it on made-up data with a fake script runner and a fake writer.
 * Returns { cycle, dir, steps: [{ step, status: "ran" | "skipped" | "stopped", why }], state, report }.
 */
export async function runCycle({
	cycle = isoWeek(),
	out = join(ROOT, "runs", "loop"),
	settingsPath = SETTINGS_PATH,
	records = [],
	tasksDirs = [join(ROOT, "tasks")],
	arch: archPath = null,
	harness = null,
	harnessRef = "HEAD",
	champion = null,
	model = "claude-haiku-5-5",
	exam = null,
	teaching = null,
	packages = null,
	ledgerPath = undefined,
	spendCap = null,
	dryRun = false,
	release = null,
	writer = null,
	writerModel = DEFAULT_WRITER_MODEL,
	exec = nodeScript,
	env = process.env,
	now = new Date(),
	log = () => {},
}) {
	if (!/^\d{4}-W\d{2}$/.test(cycle)) throw new Error(`a cycle is an ISO week such as 2026-W43, not ${cycle}`);
	if (exam && insideRepo(exam)) throw new Error(`the exam lives outside this public repository; ${exam} is inside it`);
	const dir = join(resolve(out), cycle);
	const steps = [];
	const done = (step, status, why, extra = {}) => {
		steps.push({ step, status, why, ...extra });
		log(`${step.padEnd(10)} ${status.padEnd(8)} ${why}`);
	};
	const statePath = join(dir, "cycle.json");
	const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { cycle, createdAt: now.toISOString() };
	const save = () => {
		if (dryRun) return;
		mkdirSync(dir, { recursive: true });
		writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
	};
	const spendPath = join(dir, "spend.jsonl");
	const recordSpend = (entries) => {
		if (dryRun || !entries.length) return;
		mkdirSync(dir, { recursive: true });
		appendFileSync(spendPath, entries.map((e) => `${JSON.stringify({ at: now.toISOString(), ...e })}\n`).join(""));
	};

	const { settings, problems: settingsBad, approval } = loadSettings(resolve(settingsPath));
	let money = wallet({ settings, cap: spendCap, entries: [] });
	if (settingsBad.length) {
		done("meta", "stopped", `the loop's settings cannot be used: ${settingsBad.join("; ")}`);
		return finish();
	}
	state.settingsHash = settingsHash(settings);
	money = wallet({ settings, cap: spendCap, entries: readJsonl(spendPath) });
	const ledger = readLedger(ledgerPath);
	const paidBlock = () => (spendCap === null ? "no --spend-cap was given" : approval.length ? approval[0] : dryRun ? "dry run" : null);

	// relay.arch and the champion's source, read once.
	const sourceCache = new Map();
	const sources = (file) => {
		if (!harness) return null;
		if (!sourceCache.has(file)) sourceCache.set(file, gitShow(harness, harnessRef, file));
		return sourceCache.get(file);
	};
	const archText = archPath ? readFileSync(resolve(archPath), "utf8") : harness ? sources("relay.arch.json") : null;
	const arch = archText ? JSON.parse(archText) : null;

	// meta: free, read-only, and first, so the cycle's report says what the last cycles bought before this one spends.
	{
		const j = judgeMeta({ ledger, cycles: readCycles(resolve(out)).filter((c) => c.cycle !== cycle), settings });
		const proposals = metaProposals(j, settings, { cycle });
		state.meta = { judgement: { ...j, versions: j.versions.map(({ settings: _, ...v }) => v) }, proposals: proposals.map((p) => ({ id: p.id, words: p.words, problems: p.problems })) };
		if (!dryRun) {
			mkdirSync(join(dir, "meta"), { recursive: true });
			for (const p of proposals) writeFileSync(join(dir, "meta", `${p.id}.json`), `${JSON.stringify(p, null, 2)}\n`);
		}
		const why =
			j.cycles < settings.meta.minCycles
				? `${j.cycles} earlier cycles; the meta loop judges from ${settings.meta.minCycles}`
				: `${j.cycles} cycles, ${j.releases.length} gated releases with loop changes, ${j.overall.gainPerDollar === null ? "–" : j.overall.gainPerDollar.toFixed(3)} points a dollar; ${proposals.length} proposals for a person (node loop/meta.mjs approve)`;
		done("meta", "ran", why, { proposals: proposals.length });
	}

	// analyze: fixed at the cycle's first run.
	const tasks = new Map();
	for (const d of tasksDirs) if (existsSync(d)) for (const [id, t] of readTasks(d)) tasks.set(id, t);
	if (!state.analysis) {
		if (!records.length) {
			done("analyze", "skipped", "no records (--records): nothing to study");
			save();
			return finish();
		}
		const read = readRecords(records, { exam });
		const { kept, unknown } = studyable(read, tasks);
		const a = analyze({ records: kept, tasks, clusters: settings.clusters });
		state.analysis = { ...a, records: records.map((p) => resolve(p)), leftOut: unknown };
	}
	const a = state.analysis;
	done("analyze", "ran", `${a.runs} runs of Relay (${a.graded} graded, ${a.lost} lost, ${a.failing} failing, ${a.publicRuns} on public tasks, ${a.withQueueReport} with a queue report); ${a.clusters.length} clusters${a.leftOut.length ? `; ${a.leftOut.length} unknown tasks left out` : ""}`, { clusters: a.clusters.length });

	// propose.
	state.proposals ??= null;
	if (!arch) done("propose", "skipped", "needs relay.arch.json: --harness <dir> [--harness-ref <ref>] or --arch <file> (harness PR #218, D-91)");
	else {
		if (!state.proposals) {
			const { candidates, notes } = ruleCandidates({ cycle, analysis: a, arch, archText, settings, sources });
			// Taught skills: free, in the prompts and skills lane, gated like any other proposal (TEACHING.md).
			const taught = teaching ? teachingProposals({ cycle, ...readCandidates(resolve(teaching)), arch, clusters: a.clusters, settings }) : { candidates: [], refused: [], notes: [] };
			const selected = selectProposals([...candidates, ...taught.candidates], { settings, arch, sources });
			state.proposals = selected.proposals.map(keep);
			state.refused = [...taught.refused, ...selected.refused];
			state.held = selected.held;
			state.notes = [...notes, ...taught.notes];
			state.written = [];
		}
		// Writer lanes: one paid call per target, while its worst case fits.
		const targets = writerTargets({ analysis: a, arch, settings }).filter((t) => !state.written.includes(`${t.lane}|${t.prompt.id}`));
		const waiting = [];
		for (const t of targets) {
			const have = state.proposals.filter((p) => p.lane === t.lane).length;
			if (have >= settings.lanes[t.lane].proposals) continue;
			const source = sources(t.prompt.file);
			if (typeof source !== "string") {
				waiting.push({ target: `${t.lane}|${t.prompt.id}`, why: `needs the champion's ${t.prompt.file} (--harness)` });
				continue;
			}
			const m = writer?.model ?? writerModel;
			const wp = writerProblems(m);
			if (wp.length) {
				waiting.push({ target: `${t.lane}|${t.prompt.id}`, why: wp[0] });
				continue;
			}
			const worst = writerInput({ target: t, source }).worstUsd(m);
			const blocked = paidBlock() ?? money.fits(t.lane, worst);
			if (blocked) {
				waiting.push({ target: `${t.lane}|${t.prompt.id}`, worstUsd: worst, why: blocked });
				continue;
			}
			const w = writer ?? anthropicWriter({ apiKey: env.RELAY_BENCH_ANTHROPIC_KEY, model: m });
			const r = await writeProposal({ cycle, target: t, source, writer: w, arch });
			const entry = money.add({ lane: t.lane, step: "write", proposal: `${cycle}-${t.lane}-${t.prompt.id}`, usd: r.costUsd ?? 0 });
			recordSpend([entry]);
			state.written.push(`${t.lane}|${t.prompt.id}`);
			if (r.refused) state.refused.push({ id: `${cycle}-${t.lane}-${t.prompt.id}`, lane: t.lane, title: `${LANES[t.lane].label}: ${t.prompt.id}`, problems: r.refused });
			else state.proposals.push(keep(r.proposal));
		}
		state.waitingWrites = waiting;
		if (!dryRun) {
			mkdirSync(join(dir, "proposals"), { recursive: true });
			for (const p of state.proposals) {
				writeFileSync(join(dir, "proposals", `${p.id}.patch`), p.patch);
				writeFileSync(join(dir, "proposals", `${p.id}.json`), `${JSON.stringify(p, null, 2)}\n`);
			}
		}
		save();
		const byLane = LANE_ORDER.map((l) => [l, state.proposals.filter((p) => p.lane === l).length]).filter(([, n]) => n);
		const paidWaiting = waiting.filter((w) => Number.isFinite(w.worstUsd));
		done(
			"propose",
			"ran",
			`${n(state.proposals.length, "proposal")} (${byLane.map(([l, n]) => `${l} ${n}`).join(", ") || "none"}), ${state.refused.length} refused${waiting.length ? `; ${n(waiting.length, "writer change")} ${waiting.length === 1 ? "waits" : "wait"}${paidWaiting.length ? ` (paid, at most ${money2(paidWaiting.reduce((s, w) => s + w.worstUsd, 0))})` : ""}` : ""}`,
		);
	}

	// exam: kinds of task to mine, for a person.
	{
		const ps = examProposals({ cycle, analysis: a, settings }).filter((p) => !examProposalProblems(p).length);
		state.exam = ps;
		let queued = 0;
		if (exam && !dryRun && ps.length) {
			const path = join(exam, "queue", "loop-proposals.jsonl");
			const have = new Set(readJsonl(path).map((p) => p.id));
			const fresh = ps.filter((p) => !have.has(p.id));
			if (fresh.length) {
				mkdirSync(dirname(path), { recursive: true });
				appendFileSync(path, fresh.map((p) => `${JSON.stringify({ ...p, at: now.toISOString() })}\n`).join(""));
			}
			queued = fresh.length;
		}
		save();
		done("exam", ps.length ? "ran" : "skipped", ps.length ? `${ps.length} kind${ps.length === 1 ? "" : "s"} of task to mine more of${exam ? (dryRun ? "; dry run, not queued" : `; ${queued} new in the exam's approval queue (queue/loop-proposals.jsonl)`) : "; no --exam, kept in the cycle only"}; a person approves or drops each` : "no cluster names a kind of practice task");
	}

	// prescreen: paid.
	const toScreen = state.proposals ?? [];
	state.prescreen ??= { results: {}, queries: 0 };
	if (!toScreen.length) done("prescreen", "skipped", "no proposal to pre-screen");
	else {
		const practiceTasksDir = tasksDirs[0];
		const devTasks = existsSync(practiceTasksDir) ? selectTasks(settings.prescreen.devTasks, practiceTasksDir).filter((id) => !["exam", "check"].includes(tasks.get(id)?.tier)) : [];
		const checkTasks = exam && existsSync(join(exam, "tasks")) ? [...readTasks(join(exam, "tasks"))].filter(([, t]) => t.tier === "check").map(([id]) => id) : [];
		const plan = prescreenPlan({ devTasks, checkTasks, settings });
		const pending = toScreen.filter((p) => !["passed", "dropped", "held"].includes(state.prescreen.results[p.id]?.status));
		const most = LANE_ORDER.reduce((s, l) => s + Math.min(money.laneLeft(l), pending.filter((p) => p.lane === l).length * plan.worstUsd), 0);
		const blocked = paidBlock() ?? (champion ? null : "needs --champion, the released Relay the builds are measured against");
		if (!devTasks.length) done("prescreen", "stopped", `no practice task matches ${settings.prescreen.devTasks} in ${practiceTasksDir}`);
		else if (dryRun) done("prescreen", "skipped", `dry run: ${n(pending.length, "proposal")} would be pre-screened (${plan.devRuns} dev runs and ${plan.selectionRuns} selection runs each), at most ${money2(most)} within the lanes' budgets`);
		else if (blocked) {
			done("prescreen", "stopped", `${n(pending.length, "proposal")} ${pending.length === 1 ? "waits" : "wait"} for a pre-screen, a paid step (${plan.devRuns} dev runs and ${plan.selectionRuns} selection runs each, at most ${money2(most)} within the lanes' budgets): ${blocked}${blocked === "no --spend-cap was given" ? "; run again with --spend-cap <usd>" : ""}`, { waiting: pending.length, mostUsd: most });
		} else {
			const r = await prescreen({ proposals: toScreen, cycleDir: dir, settings, money, champion, model, practiceTasksDir, devTasks, exam, packages: packages ?? join(dir, "packages"), exec, done: state.prescreen.results, queriesSoFar: state.prescreen.queries, log });
			recordSpend(r.spend);
			for (const x of r.results) state.prescreen.results[x.id] = x;
			state.prescreen.queries = r.queries;
			save();
			const count = (s) => r.results.filter((x) => x.status === s).length;
			done("prescreen", "ran", `${count("passed")} passed, ${count("dropped")} dropped, ${count("held")} held, ${count("waiting")} waiting for a build, ${count("refused")} refused; ${money2(money.commandSpent())} spent of the ${money2(spendCap)} cap; ${r.queries} check-tier queries this cycle`);
		}
	}

	// package: the release, written down.
	if (steps.at(-1)?.status !== "stopped") {
		const results = Object.values(state.prescreen.results);
		if (!results.some((r) => r.status === "passed")) done("package", "skipped", "no proposal passed its pre-screen");
		else {
			const rel = release ?? "<the beta version>";
			const pkg = packageRelease({ cycle, cycleDir: dir, results, proposals: toScreen, arch, archText, sources, ledger, champion, release: rel, model, write: !dryRun });
			if (pkg.empty) done("package", "skipped", pkg.empty);
			else {
				state.package = { lanes: pkg.lanes, risk: pkg.risk, held: pkg.held, files: pkg.files };
				save();
				done("package", "ran", `one release of ${pkg.lanes.length} lane${pkg.lanes.length === 1 ? "" : "s"} (${pkg.lanes.map((l) => l.lane).join(", ")}), risk ${pkg.risk}; ${dryRun ? "dry run, nothing written" : `written to ${pkg.dir}`}; not opened anywhere`);
			}
		}
	}
	return finish();

	function finish() {
		const report = cycleReport({ cycle, steps, state, settings, approval, money, spendCap, dryRun });
		if (!dryRun && state.settingsHash) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "report.md"), report);
			writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summaryOf({ cycle, state, settings, money, now }), null, 2)}\n`);
		}
		return { cycle, dir, steps, state, report };
	}
}

/** What the meta loop reads of a cycle: what it found, spent and packaged, under which settings. */
export function summaryOf({ cycle, state, settings, money, now }) {
	const results = Object.values(state.prescreen?.results ?? {});
	const lanes = {};
	for (const lane of LANE_ORDER) {
		const proposals = (state.proposals ?? []).filter((p) => p.lane === lane).length;
		lanes[lane] = {
			proposals,
			prescreened: results.filter((r) => r.lane === lane && ["passed", "dropped"].includes(r.status)).length,
			passed: results.filter((r) => r.lane === lane && r.status === "passed").length,
			atLimit: proposals >= (settings.lanes[lane]?.proposals ?? 0) && proposals > 0,
		};
	}
	return {
		cycle,
		at: now.toISOString(),
		settingsHash: state.settingsHash,
		settings: { lanes: settings.lanes, clusters: settings.clusters },
		clusters: state.analysis?.clusters?.length ?? 0,
		spend: Object.fromEntries(LANE_ORDER.map((l) => [l, money.laneSpent(l)])),
		lanes,
		packaged: (state.package?.lanes ?? []).map((l) => l.change),
	};
}

/** The cycle in plain words, numbers only. */
export function cycleReport({ cycle, steps, state, settings, approval, money, spendCap, dryRun }) {
	const L = [];
	L.push(`# Relay improvement loop, cycle ${cycle}`, "");
	L.push(`${dryRun ? "A dry run: nothing was written or spent. " : ""}Settings ${String(state.settingsHash ?? "–").slice(0, 12)}, ${approval.length ? approval[0] : `approved by ${settings.approved.by}`}. Spend cap: ${spendCap === null ? "none given, so nothing paid ran" : money2(spendCap)}.`, "");
	L.push("## Steps", "");
	for (const s of steps) L.push(`- **${s.step}**, ${s.status}: ${s.why}`);
	L.push("");
	const a = state.analysis;
	if (a) {
		L.push("## Failure clusters", "");
		if (!a.clusters.length) L.push(`None reached ${settings.clusters.minRuns} runs on ${settings.clusters.minTasks} tasks.`);
		for (const c of a.clusters) L.push(`- ${c.id}: ${c.words}. ${c.runs} runs on ${c.tasks.length} tasks; ${c.solvedByAnotherTool} of those tasks solved by another tool; lanes: ${c.lanes.join(", ") || "none (a person looks)"}.`);
		if (a.below?.length) L.push("", `Below the thresholds: ${a.below.slice(0, 8).map((b) => `${b.id} (${b.runs} runs, ${b.tasks} tasks)`).join(", ")}.`);
		L.push("");
	}
	if (state.proposals) {
		L.push("## Proposals", "");
		if (!state.proposals.length) L.push("None.");
		for (const p of state.proposals) {
			const r = state.prescreen?.results?.[p.id];
			L.push(`- **${p.id}** (${LANES[p.lane].label}, risk ${p.risk}): ${describeChange(p)}. ${p.words}. Evidence: ${p.change?.kind === "skill" ? `${p.evidence?.machines ?? "–"} machines, ${p.evidence?.passes ?? "–"} passing uses there` : `${p.evidence?.runs ?? "–"} runs on ${p.evidence?.tasks ?? "–"} tasks`}.${r ? ` Pre-screen: ${r.status}${r.dev ? `, dev ${r.dev.difference?.toFixed(1) ?? "–"} points (${r.dev.low?.toFixed(1) ?? "–"} to ${r.dev.high?.toFixed(1) ?? "–"}) over ${r.dev.tasks} tasks` : ""}${r.selection ? `, selection ${r.selection.status}` : ""}${r.why?.length ? `; ${r.why.join("; ")}` : ""}.` : ""}`);
		}
		if (state.refused?.length) {
			L.push("", "Refused:", "");
			for (const r of state.refused) L.push(`- ${r.id}: ${r.problems.join("; ")}`);
		}
		if (state.waitingWrites?.length) {
			L.push("", "Waiting for the writer:", "");
			for (const w of state.waitingWrites) L.push(`- ${w.target}${Number.isFinite(w.worstUsd) ? ` (at most ${money2(w.worstUsd)})` : ""}: ${w.why}`);
		}
		if (state.notes?.length) L.push("", `Notes: ${state.notes.join("; ")}.`);
		L.push("");
	}
	if (state.exam?.length) {
		L.push("## Exam proposals, for a person", "");
		for (const e of state.exam) L.push(`- ${e.id}: mine more ${e.wanted.kind} ${e.wanted.language} tasks (level ${e.wanted.minLevel} and up). ${e.why}.`);
		L.push("");
	}
	if (state.meta?.proposals?.length) {
		L.push("## Meta proposals, for a person", "");
		for (const p of state.meta.proposals) L.push(`- ${p.id}: ${p.words}${p.problems.length ? ` (refused: ${p.problems.join("; ")})` : ""}`);
		L.push("");
	}
	L.push("## Money this cycle", "");
	for (const lane of PAID_LANES) {
		const b = settings.lanes[lane];
		if (!b.enabled && !money.laneSpent(lane)) continue;
		L.push(`- ${lane}: ${money2(money.laneSpent(lane))} of ${money2(b.budgetUsd)}${b.enabled ? "" : " (lane off)"}`);
	}
	L.push("");
	if (state.package) L.push("## Release", "", `Lanes ${state.package.lanes.map((l) => l.lane).join(", ")}, risk ${state.package.risk}. Files: ${state.package.files.join(", ") || "none written"}.`, "");
	return L.join("\n");
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values } = parseArgs({
		options: {
			cycle: { type: "string" },
			out: { type: "string", default: join(ROOT, "runs", "loop") },
			settings: { type: "string", default: SETTINGS_PATH },
			records: { type: "string", multiple: true },
			"tasks-dir": { type: "string", multiple: true },
			arch: { type: "string" },
			harness: { type: "string" },
			"harness-ref": { type: "string", default: "HEAD" },
			champion: { type: "string" },
			model: { type: "string", default: "claude-haiku-5-5" },
			exam: { type: "string" },
			teaching: { type: "string" },
			packages: { type: "string" },
			ledger: { type: "string" },
			"spend-cap": { type: "string" },
			"dry-run": { type: "boolean", default: false },
			release: { type: "string" },
			"writer-model": { type: "string", default: DEFAULT_WRITER_MODEL },
		},
	});
	const spendCap = values["spend-cap"] === undefined ? null : Number(values["spend-cap"]);
	if (spendCap !== null && !(spendCap >= 0)) throw new Error("--spend-cap is a number of dollars");
	if (values["dry-run"] && spendCap !== null) throw new Error("--dry-run spends nothing; leave out --spend-cap");
	const result = await runCycle({
		cycle: values.cycle ?? isoWeek(),
		out: resolve(values.out),
		settingsPath: resolve(values.settings),
		records: values.records ?? [],
		tasksDirs: (values["tasks-dir"] ?? [join(ROOT, "tasks")]).map((d) => resolve(d)),
		arch: values.arch ?? null,
		harness: values.harness ? resolve(values.harness) : null,
		harnessRef: values["harness-ref"],
		champion: values.champion ?? null,
		model: values.model,
		exam: values.exam ? resolve(values.exam) : null,
		teaching: values.teaching ? resolve(values.teaching) : null,
		packages: values.packages ? resolve(values.packages) : null,
		ledgerPath: values.ledger ? resolve(values.ledger) : undefined,
		spendCap,
		dryRun: values["dry-run"],
		release: values.release ?? null,
		writerModel: values["writer-model"],
		log: (line) => console.log(line),
	});
	console.log(result.steps.some((s) => s.status === "stopped") ? `stopped before a paid step; ${values["dry-run"] ? "dry run" : `report: ${join(result.dir, "report.md")}`}` : `cycle ${result.cycle} done; ${values["dry-run"] ? "dry run" : `report: ${join(result.dir, "report.md")}`}`);
	process.exitCode = result.steps.some((s) => s.status === "stopped") ? 3 : 0;
}
