#!/usr/bin/env node
// The autopilot (AUTOPILOT.md): the week's improvement cycle, carried to a pull request in the harness when the exam's
// gate passes, so the one human step per release is the founder's click on Merge.
//
//   node loop/autopilot.mjs --spend-cap 20 --signed-by <name> [--keychain relay-openai] [--model gpt-6-luna] \
//     [--harness ../prime-agent-main] [--exam ../relay-exam] [--records <records.jsonl> ...] [--tasks-dir <dir> ...] \
//     [--champion 0.6.121] [--cycle 2026-W44] [--out runs/loop] [--work <dir>] [--ledger ledger/ledger.json]
//   node loop/autopilot.mjs --after-merge <pr>            record the release that holds a merged pull request
//   node loop/autopilot.mjs --install-schedule weekly --spend-cap 20 --signed-by <name> [...]   the weekly job (macOS)
//   node loop/autopilot.mjs --remove-schedule
//
// One week, in order; each step says ran, skipped, stopped or failed, and why:
//   money         without --spend-cap nothing runs: it prints the most the week could cost and exits 3
//   pull request  last week's pull request: while it waits for a person, or is merged but in no release yet, the week
//                 stops before anything paid (one pull request at a time; each cycle is measured against the release
//                 that holds the one before)
//   harness       origin/main, fixed for the cycle; the champion (the release that holds the last merged change, else
//                 --champion, else the harness's own version); this week's build version
//   ready         the exam has at least 20 approved, locked tasks and an anchor set; a person approved the loop's
//                 settings; the keys and the disk are there. If not, the cycle's free steps run, and the week stops
//                 with one plain sentence
//   cycle         loop/cycle.mjs: meta, analyze, propose (the writer lanes are paid), exam
//   build         each proposal's Relay, built in a harness worktree (git apply, npm run arch, npm run build,
//                 npm run release:pack): a local tarball, never published (loop/build.mjs)
//   prescreen     loop/cycle.mjs again: each build against the champion on the dev set, then the check tier (PAID),
//                 then the package (PR_BODY.md, release.patch, lanes.json, ledger-preview.json)
//   release       the packaged release, built the same way at origin/main, with npm run check, and committed
//   gate          runner/gate.mjs on the exam (PAID): the local build against the champion, look by look within the cap,
//                 --combined when the release holds two lanes or more
//   ledger        on PASS only: scripts/ledger.mjs write, which reads the gate again from its records
//   pull request  on PASS only: the branch pushed and a pull request opened in the harness, label no-linear
// On BLOCK or UNRESOLVED it writes the report and opens nothing. It never merges, releases or publishes.
//
// Output: <out>/<cycle>/autopilot/report.md (plain words, numbers only for results), state.json, PR_BODY.md; and
// <out>/autopilot.json, the champion and the autopilot's pull requests across weeks. Exit codes: 0 done (a pull request
// opened, or nothing to propose), 1 a step failed, 3 no --spend-cap, 4 waiting on a person or a release, 10 the gate
// blocked, 20 the gate is unresolved.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { lookSize } from "../runner/gate-analyze.mjs";
import { anchorProblems, loadAnchors } from "../runner/anchors.mjs";
import { isLocalBuild, providerOf, RELAY_VERSION_PATTERN } from "../runner/arms.mjs";
import { readTasks } from "../runner/stage-tasks.mjs";
import { approvalProblems } from "../scripts/approve-task.mjs";
import { readLedger } from "../scripts/ledger.mjs";
import { lockDifferences } from "../scripts/lock-tasks.mjs";
import { addWorktree, applyPatch, BuildError, buildEnv, buildRelay, buildVersion, commitTree, freeGb, keepPackage, linkNodeModules, sh, sha256File } from "./build.mjs";
import { isoWeek, runCycle } from "./cycle.mjs";
import { LANES } from "./lanes.mjs";
import { loadSettings, PAID_LANES, SETTINGS_PATH } from "./meta.mjs";
import { describeChange } from "./package.mjs";
import { crontabLine, LABEL, plist, plistPath, scheduleArgs } from "./schedule.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
export const HARNESS_REPO = "cicada0007/relay-harness";
/** The run's key, by the model's provider (runner/run-one.mjs KEY_ENV). */
export const KEY_ENV = Object.freeze({ anthropic: "RELAY_BENCH_ANTHROPIC_KEY", openai: "RELAY_BENCH_OPENAI_KEY" });
export const EXIT = Object.freeze({ DONE: 0, FAILED: 1, NO_CAP: 3, WAITING: 4, BLOCK: 10, UNRESOLVED: 20 });

/** The gate's settings for a weekly release (estimates for the founders to confirm, as loop/settings.json's are). */
export const GATE_DEFAULTS = Object.freeze({
	/** The most exam tasks one gate plans; the exam's approved, locked tasks up to this. */
	maxTasks: 120,
	/** From this many planned tasks the gate takes three looks (O'Brien-Fleming), so a broken build stops early. */
	sequentialFrom: 60,
	looks: 3,
	reps: 1,
	/** The meter's cap on one run's model spend. */
	capUsdPerRun: 1,
	/** Sandbox time per look, on top of the model cap. */
	e2bUsdPerLook: 20,
	minApproved: 20,
});

export const DEFAULTS = Object.freeze({
	out: join(ROOT, "runs", "loop"),
	settingsPath: SETTINGS_PATH,
	harness: resolve(ROOT, "..", "prime-agent-main"),
	exam: resolve(ROOT, "..", "relay-exam"),
	repo: HARNESS_REPO,
	model: "gpt-6-luna",
	label: "no-linear",
	minFreeGb: 3,
	work: join(tmpdir(), "relay-autopilot"),
	gate: GATE_DEFAULTS,
});

const readJson = (path, fallback = null) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback);
const writeJson = (path, value) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const readJsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const money = (x) => `$${(x ?? 0).toFixed(2)}`;
const f = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : x.toFixed(d));
const signed = (x, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "–");
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const E2B_USD_PER_SECOND = 0.000046;

/** The autopilot's state across weeks: the champion, and its pull requests. */
export const globalPath = (out) => join(out, "autopilot.json");
export const readGlobal = (out) => readJson(globalPath(out), { champion: null, prs: [] });

/** The newest anchor set beside the exam's tasks, anchors-vN with the largest N, or null. */
export function newestAnchors(examDir) {
	const dir = join(examDir, "anchors");
	if (!existsSync(dir)) return null;
	const found = readdirSync(dir)
		.map((file) => /^anchors-v(\d+)\.json$/.exec(file))
		.filter(Boolean)
		.sort((a, b) => Number(b[1]) - Number(a[1]));
	return found.length ? join(dir, found[0][0]) : null;
}

/**
 * Whether the exam can gate a release: at least `minApproved` exam tasks approved by a founder who did not draft them,
 * the same tasks matching their lock, and an anchor set that still matches its tasks. `sentence` says, in one plain
 * sentence, what is missing.
 */
export function examReadiness(examDir, { minApproved = GATE_DEFAULTS.minApproved } = {}) {
	const tasksDir = join(examDir, "tasks");
	if (!existsSync(tasksDir)) return { ok: false, approved: 0, sentence: `There is no exam at ${tasksDir}, so this week stops before anything paid.` };
	const exam = [...readTasks(tasksDir)].filter(([, t]) => t.tier === "exam");
	const approved = exam.filter(([, t]) => !approvalProblems(t).length).map(([id]) => id);
	const base = { tasksDir, drafted: exam.length, approved: approved.length };
	if (approved.length < minApproved) {
		return { ...base, ok: false, sentence: `The exam has ${plural(approved.length, "approved task")} and the gate needs ${minApproved}, so this week stops before anything paid.` };
	}
	const differ = new Set(lockDifferences(approved, tasksDir).map((d) => d.id));
	const usable = differ.has("*") ? [] : approved.filter((id) => !differ.has(id));
	if (usable.length < minApproved) {
		return { ...base, ok: false, usable, sentence: `The exam has ${approved.length} approved tasks but ${usable.length} match their lock, so this week stops before anything paid: node scripts/lock-tasks.mjs --tasks-dir ${tasksDir}.` };
	}
	const anchors = newestAnchors(examDir);
	if (!anchors) {
		return { ...base, ok: false, usable, sentence: `The exam has ${usable.length} approved, locked tasks and no anchor set, so this week stops before anything paid: node scripts/anchors.mjs create --version anchors-v1 --tasks-dir ${tasksDir} --sample ${Math.min(40, usable.length)}.` };
	}
	const set = loadAnchors(anchors);
	const problems = anchorProblems(set.manifest, tasksDir);
	if (problems.length) return { ...base, ok: false, usable, sentence: `The anchor set ${set.version} no longer matches its tasks, so this week stops before anything paid: make a new version with scripts/anchors.mjs.` };
	return { ...base, ok: true, usable, anchors, sentence: null };
}

/** The gate's design for an exam of `tasks` usable tasks: one look under `sequentialFrom` tasks, else three. */
export function gateDesign(tasks, gate = GATE_DEFAULTS) {
	const planned = Math.min(gate.maxTasks, tasks);
	return planned >= gate.sequentialFrom ? { spending: "obrien-fleming", looks: gate.looks, plannedTasks: planned } : { spending: "fixed", looks: 1, plannedTasks: planned };
}

/** The most one week could cost: the paid lanes' budgets (writers and pre-screens), the gate's runs, and sandbox time. */
export function worstWeek({ settings, tasks = null, gate = GATE_DEFAULTS }) {
	const lanes = PAID_LANES.filter((l) => settings.lanes[l]?.enabled).reduce((s, l) => s + settings.lanes[l].budgetUsd, 0);
	const design = gateDesign(tasks ?? gate.maxTasks, gate);
	const gateUsd = design.plannedTasks * 2 * gate.reps * gate.capUsdPerRun;
	// Pre-screen sandboxes: one cap for the cycle's dev runs and one for its check-tier runs (run-stage counts per folder).
	const sandbox = 2 * settings.prescreen.e2bCapUsd + design.looks * gate.e2bUsdPerLook;
	return { modelUsd: lanes + gateUsd, lanesUsd: lanes, gateUsd, sandboxUsd: sandbox, design, tasks };
}

export const describeWorst = (w) =>
	`the most this week could cost is ${money(w.modelUsd)} of model spend (${money(w.lanesUsd)} for the loop's lanes, ${money(w.gateUsd)} for a gate of ${w.design.plannedTasks} exam tasks) plus ${money(w.sandboxUsd)} of sandbox time`;

/** The model dollars a test's runs spent so far in a runs folder, and the folder's sandbox dollars (run-stage's own count). */
function runsSpend(out, test) {
	const rows = readJsonl(join(out, "records.jsonl"));
	return {
		test: rows.filter((r) => r.test === test).reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0),
		sandbox: rows.reduce((s, r) => s + ((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000 || 0) * E2B_USD_PER_SECOND, 0),
		graded: new Set(rows.filter((r) => r.test === test && typeof r.score?.share === "number").map((r) => `${r.task}|${r.tool}`)).size,
	};
}
const cycleSpend = (dir) => readJsonl(join(dir, "spend.jsonl")).reduce((s, e) => s + (e.usd ?? 0), 0);

const semver = (v) => v.replace(/^v/, "").split(/[.-]/).slice(0, 3).map(Number);
const newer = (a, b) => {
	const [x, y] = [semver(a), semver(b)];
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
	return false;
};

/** The first stable release whose tag holds `commit`, newer than `after`, or null. */
export function releaseHolding({ commit, after, o, ops }) {
	const list = ops.run("gh", ["release", "list", "--repo", o.repo, "--json", "tagName,isDraft,isPrerelease", "--limit", "100"]);
	if (list.status !== 0) throw new Error(`gh release list failed: ${(list.stderr || list.stdout).trim().split("\n")[0]}`);
	const tags = JSON.parse(list.stdout || "[]")
		.filter((r) => !r.isDraft && !r.isPrerelease && /^v\d+\.\d+\.\d+$/.test(r.tagName))
		.map((r) => r.tagName)
		.filter((t) => !after || newer(t, after))
		.sort((a, b) => (newer(a, b) ? 1 : newer(b, a) ? -1 : 0));
	if (!tags.length) return null;
	ops.run("git", ["-C", o.harness, "fetch", "--quiet", "--tags", "origin", "main"]);
	for (const tag of tags) if (ops.run("git", ["-C", o.harness, "merge-base", "--is-ancestor", commit, tag]).status === 0) return tag.slice(1);
	return null;
}

/**
 * One autopilot pull request, read again: open, closed, merged, or released (a release holds its merge commit, and that
 * release becomes the champion). Changes `rec` and `g` in place; returns rec.status.
 */
export function checkPullRequest(rec, g, o, ops) {
	if (["closed", "released"].includes(rec.status)) return rec.status;
	const view = ops.run("gh", ["pr", "view", String(rec.number), "--repo", o.repo, "--json", "number,state,mergedAt,mergeCommit,url"]);
	if (view.status !== 0) throw new Error(`gh pr view ${rec.number} failed: ${(view.stderr || view.stdout).trim().split("\n")[0]}`);
	const pr = JSON.parse(view.stdout);
	rec.url = pr.url ?? rec.url;
	if (pr.state === "OPEN") return (rec.status = "open");
	if (pr.state === "CLOSED") return (rec.status = "closed");
	rec.mergeCommit = pr.mergeCommit?.oid ?? rec.mergeCommit ?? null;
	rec.mergedAt = pr.mergedAt ?? rec.mergedAt ?? null;
	const release = rec.mergeCommit ? releaseHolding({ commit: rec.mergeCommit, after: rec.champion ?? g.champion?.version ?? null, o, ops }) : null;
	if (!release) return (rec.status = "merged");
	rec.release = release;
	g.champion = { version: release, holds: rec.build ?? null, pr: rec.number, mergeCommit: rec.mergeCommit, at: ops.now().toISOString() };
	return (rec.status = "released");
}

/** --after-merge <pr>: records the release that holds a merged pull request as the next cycle's champion. */
export function afterMerge(number, o, ops) {
	const g = readGlobal(o.out);
	let rec = g.prs.find((p) => p.number === Number(number));
	if (!rec) {
		rec = { number: Number(number), url: null, cycle: null, build: null, status: "open", note: "not opened by the autopilot" };
		g.prs.push(rec);
	}
	const status = checkPullRequest(rec, g, o, ops);
	writeJson(globalPath(o.out), g);
	const words = {
		open: `Pull request #${rec.number} is not merged yet; nothing was recorded.`,
		closed: `Pull request #${rec.number} was closed without a merge; the champion stays ${g.champion?.version ?? "as it was"}.`,
		merged: `Pull request #${rec.number} is merged and no release holds it yet, so the champion stays ${g.champion?.version ?? "as it was"}; the weekly run checks again.`,
		released: `Relay ${rec.release} holds pull request #${rec.number}${rec.build ? ` (the local build ${rec.build})` : ""}; it is the champion for the next cycle.`,
	};
	ops.log(words[status]);
	return { status, champion: g.champion, message: words[status] };
}

/** The gate's arguments for this week's build, without its two caps (each look adds its own). */
export function gateArgs({ st, o, ready, dir, design }) {
	const lanes = join(dir, "release", "lanes.json");
	// A release that changes the router is judged with the meta-harness on for both arms (GATE.md, amendment 5).
	const meta = readJson(join(dir, "cycle.json"))?.package?.relayMeta === true;
	return [
		"--run",
		"--test", `gate-${st.build}`,
		"--champion", st.champion,
		"--candidate", st.build,
		"--candidate-package", st.release.package,
		"--tier", "exam",
		"--tasks-dir", ready.tasksDir,
		"--tasks", ready.usable.join(","),
		"--anchors", ready.anchors,
		...(design.looks > 1 ? ["--looks", String(design.looks), "--spending", design.spending] : []),
		"--plan-tasks", String(design.plannedTasks),
		...(existsSync(lanes) ? ["--combined", lanes] : []),
		...(meta ? ["--relay-meta"] : []),
		"--model", o.model,
		"--reps", String(o.gate.reps),
		"--cap-usd", String(o.gate.capUsdPerRun),
		"--out", join(o.exam, "runs", "gate"),
	];
}

const RULE_WORDS = {
	better: "the whole interval is above 0",
	"no worse": "the interval's low end is above -5",
	worse: "the whole interval is below 0",
	"costs more": "the cost ratio is above 1.05",
	slower: "the time ratio is above 1.10",
	'more false "done"': 'the false "done" difference is above +5 points',
	"safety flag": "a candidate run carries a safety flag",
	"leak budget spent": "the leak budget is spent",
	"graders not pinned": "a run was graded by a judge other than the pinned one",
	"build differs": "a candidate run did not install the gated build",
	"too few tasks": "fewer than 20 tasks have a grade for both",
	"anchors not all scored": "an anchor task has no grade for both",
	"not enough evidence": "the interval's low end is at or below -5 at the last look",
	continue: "no boundary was crossed at this look",
};
/** The gate's rule in plain, neutral words: numbers and thresholds, never better or worse. */
export const ruleWords = (label) => RULE_WORDS[label] ?? (/^worse on (.+) tasks$/.test(label ?? "") ? `the interval on ${label.replace(/^worse on | tasks$/g, "")} tasks is below -5` : String(label ?? "–"));

/** The gate's numbers, for the pull request and the report. */
export function gateLines(r) {
	const L = [];
	L.push(`- Verdict: ${r.status} (exit ${r.exitCode}) at look ${r.look?.index ?? "–"} of ${r.design?.looks ?? "–"}; the rule: ${ruleWords(r.label)}.`);
	L.push(`- Tasks graded for both: ${r.tasks} (planned ${r.design?.plannedTasks ?? "–"}); runs ${r.runs?.candidate ?? "–"} candidate, ${r.runs?.champion ?? "–"} champion.`);
	L.push(`- Requirements met, candidate minus champion: ${signed(r.difference)} points, interval ${f(r.low)} to ${f(r.high)}.`);
	for (const [kind, k] of Object.entries(r.kinds ?? {})) L.push(`- ${kind}: ${signed(k.difference)} points, ${f(k.low)} to ${f(k.high)}, ${k.tasks} tasks${k.judged ? "" : " (too few to judge alone)"}.`);
	if (r.anchors) L.push(`- Anchors ${r.anchors.version}: ${f(r.anchors.champion)} and ${f(r.anchors.candidate)} points (champion, candidate), ${signed(r.anchors.difference)}, 95% interval ${f(r.anchors.low)} to ${f(r.anchors.high)}, ${r.anchors.tasks} of ${r.anchors.planned} tasks.`);
	L.push(`- Cost ratio ${f(r.costRatio, 3)}; time ratio ${f(r.timeRatio, 3)}; false "done" ${f(r.falseDone?.candidate)}% and ${f(r.falseDone?.champion)}% (candidate, champion).`);
	L.push(`- Safety flags: ${r.safety?.candidate?.total ?? "–"} candidate runs, ${r.safety?.champion?.total ?? "–"} champion runs.`);
	if (r.look) L.push(`- Alpha spent: ${f(100 * r.look.spent, 3)}% of 2.5%; the smallest change this look could see: ${f(r.detectablePoints)} points.`);
	return L;
}

/** The pull request's body: the package's PR_BODY.md, then what the autopilot measured and wrote. Numbers only. */
export function pullRequestBody({ prBody, st, result, ledgerLine, o, cycle, dir, spend }) {
	const cut = prBody.indexOf("\n## How it is judged");
	const head = (cut === -1 ? prBody : prBody.slice(0, cut)).trimEnd();
	const gateCmd = [
		`node runner/gate.mjs --test gate-${st.build} --champion ${st.champion} --candidate ${st.build} \\`,
		`  --candidate-package runs/loop/${cycle}/release/relay-${st.build}.tgz --tier exam \\`,
		`  --tasks-dir ../relay-exam/tasks --out ../relay-exam/runs/gate --anchors ../relay-exam/anchors/${result.anchors?.version ?? "<version>"}.json${existsSync(join(dir, "release", "lanes.json")) ? ` \\\n  --combined runs/loop/${cycle}/release/lanes.json` : ""}${readJson(join(dir, "cycle.json"))?.package?.relayMeta === true ? " --relay-meta" : ""}`,
	].join("\n");
	const L = [
		head,
		"",
		"## The gate on the exam",
		"",
		...gateLines(result),
		"",
		`The candidate is the local build \`${st.build}\`: package \`relay-worker-${st.build}.tgz\`, sha256 \`${st.release.sha256}\`. It was built from this pull request's head commit \`${st.release.commit}\`, which is origin/main at \`${st.base}\` with \`release.patch\` applied, after \`npm run arch\` and \`npm run check\` passed. The champion is relay@${st.champion}. Every candidate run installed that package; the gate refuses a look in which one did not (GATE.md, amendment 4).`,
		"",
		`Model spend this week: ${money(spend.total)} of the ${money(o.spendCap)} cap (${money(spend.cycle)} for the cycle's writers and pre-screens, ${money(spend.gate)} for the gate), plus about ${money(spend.sandbox)} of sandbox time.`,
		"",
		"## The ledger entry",
		"",
		`Written by \`node scripts/ledger.mjs write\`, which read the gate again from its records: ${ledgerLine}`,
		"",
		"## Roll back",
		"",
		"- Before merging: close this pull request. Nothing is released, and the next weekly run starts again from origin/main.",
		`- After merging, before a release: \`git revert -m 1 <merge commit>\` and \`npm run arch\`; relay@${st.champion} stays the release people have.`,
		"- After a release that holds it: the same revert, then the next release, gated again; the switch-off list (D-80) withdraws a release already out.",
		"",
		"## Reproduce",
		"",
		"In relay-bench, beside `../relay-exam` and `../prime-agent-main`:",
		"",
		"```",
		"# the gate's verdict, read again from its records (free)",
		gateCmd,
		"node scripts/ledger.mjs verify",
		"",
		"# the build, in a scratch worktree of the harness",
		`git -C ../prime-agent-main worktree add --detach /tmp/relay-${st.build} ${st.release.commit}`,
		`cd /tmp/relay-${st.build} && npm run arch && npm run check && npm run build`,
		`npm run release:pack -- --channel stable --base-url https://relayevals.com/harness --version ${st.build}`,
		`shasum -a 256 packages/coding-agent/release/artifacts/relay-worker-${st.build}.tgz`,
		"",
		"# the whole week again, resuming what is done (paid steps need the cap)",
		`node loop/autopilot.mjs --cycle ${cycle} --spend-cap <usd> --signed-by <name> --champion ${st.champion}`,
		"```",
		"",
		"Opened by the Relay autopilot (relay-bench `loop/autopilot.mjs`) after the gate on the exam passed. Merging is the one step for a person; the autopilot never merges, releases or publishes.",
		"",
	];
	return L.join("\n");
}

/** The week in plain words: what Relay learned about itself, what it proposed, tested and spent, and whether a pull request waits. */
export function weeklyReport({ cycle, steps, cs, st, g, o, exitCode }) {
	const L = [`# Relay autopilot, week ${cycle}`, ""];
	const pr = g.prs.find((p) => p.cycle === cycle && p.url);
	L.push(pr ? `**A pull request waits for you:** ${pr.url}. Merging it is the one step; the autopilot never merges or releases.` : `**No pull request this week.** ${steps.at(-1)?.why ?? ""}`, "");
	const a = cs?.analysis;
	L.push("## What Relay learned about itself", "");
	if (!a) L.push("Nothing was studied this week.");
	else {
		L.push(`It read ${a.runs} runs of Relay: ${a.graded} graded, ${a.failing} failing, ${a.lost} lost, ${a.publicRuns} on public tasks.`);
		if (!a.clusters.length) L.push("No failure came up often enough to act on.");
		else {
			L.push(`It found ${plural(a.clusters.length, "way")} it keeps failing:`, "");
			for (const c of a.clusters) L.push(`- ${c.words}${c.kind ? ` (${c.kind} tasks)` : ""}: ${c.runs} runs on ${c.tasks.length} tasks.`);
		}
	}
	L.push("", "## What it proposed", "");
	const proposals = cs?.proposals ?? [];
	if (!proposals.length) L.push("No change this week.");
	for (const p of proposals) L.push(`- ${LANES[p.lane]?.label ?? p.lane}: ${describeChange(p)}. ${p.words}.`);
	if (cs?.refused?.length) L.push("", `${plural(cs.refused.length, "proposal")} broke a rule of its lane and ${cs.refused.length === 1 ? "was" : "were"} refused.`);
	const early = steps.some((s) => s.step === "ready" && s.status === "stopped");
	if (cs?.waitingWrites?.length) L.push("", `${plural(cs.waitingWrites.length, "written change")} waited${early ? " for the paid steps" : `: ${cs.waitingWrites[0].why}`}.`);
	L.push("", "## What it tested", "");
	const builds = Object.entries(st.builds ?? {});
	if (builds.length) L.push(`Builds: ${builds.filter(([, b]) => b.status === "built").length} of ${builds.length} built${builds.some(([, b]) => b.status === "failed") ? `; failed: ${builds.filter(([, b]) => b.status === "failed").map(([id, b]) => `${id} (${b.why.split("\n")[0]})`).join("; ")}` : ""}.`);
	const results = Object.values(cs?.prescreen?.results ?? {});
	for (const r of results) {
		const d = r.dev;
		L.push(`- Pre-screen of ${r.id}: ${r.status}${d ? `; dev set ${signed(d.difference)} points, interval ${f(d.low)} to ${f(d.high)}, over ${d.tasks} tasks` : ""}${r.selection ? `; check tier: ${r.selection.status}` : ""}.`);
	}
	if (st.release?.sha256) L.push(`- The release: built from origin/main \`${st.base.slice(0, 10)}\` plus ${cs?.package?.lanes?.length ?? "–"} lane change(s), \`npm run check\` passed; local build ${st.build}, sha256 ${st.release.sha256.slice(0, 12)}.`);
	else if (st.releaseFailed) L.push(`- The release did not build: ${st.releaseFailed.split("\n")[0]}`);
	if (st.gate?.result) L.push("", "The gate on the exam:", "", ...gateLines(st.gate.result));
	if (!results.length && !st.gate) L.push("Nothing was run.");
	L.push("", "## What it cost", "");
	const cycleUsd = st.spend.filter((e) => e.step === "cycle").reduce((s, e) => s + e.usd, 0);
	const gateUsd = st.spend.filter((e) => e.step === "gate").reduce((s, e) => s + e.usd, 0);
	const sandbox = st.spend.reduce((s, e) => s + (e.sandboxUsd ?? 0), 0) + results.reduce((s, r) => s + (r.dev?.sandboxUsd ?? 0), 0);
	L.push(`- Model spend: ${money(cycleUsd + gateUsd)} (${money(cycleUsd)} for the cycle's writers and pre-screens, ${money(gateUsd)} for the gate), within this command's cap of ${money(o.spendCap)}.`);
	L.push(`- Sandbox time: about ${money(sandbox)}.`);
	L.push("", "## Steps", "");
	for (const s of steps) L.push(`- **${s.step}**, ${s.status}: ${s.why}`);
	L.push("", `Exit code ${exitCode}.`, "");
	return L.join("\n");
}

/**
 * One week. Every side effect goes through `ops`: { run(cmd, args, opts), node(script, args, opts), freeGb(path),
 * now(), log(line), link(main, wt), env }. Tests fake every one; the command line passes the real ones.
 * Returns { cycle, steps, exitCode, report, state }.
 */
export async function runWeek(options, ops) {
	const o = { ...DEFAULTS, ...options, gate: { ...GATE_DEFAULTS, ...(options.gate ?? {}) } };
	const now = ops.now();
	const cycle = o.cycle ?? isoWeek(now);
	const dir = join(o.out, cycle);
	const apDir = join(dir, "autopilot");
	const statePath = join(apDir, "state.json");
	const st = readJson(statePath, { cycle, createdAt: now.toISOString(), spend: [] });
	const g = readGlobal(o.out);
	const steps = [];
	const env = ops.env ?? process.env;
	let spentNow = 0;
	const capLeft = () => Math.max(0, o.spendCap - spentNow);
	const addSpend = (step, usd, sandboxUsd = 0) => {
		spentNow += usd;
		st.spend.push({ at: ops.now().toISOString(), step, usd, sandboxUsd });
	};
	const done = (step, status, why, extra = {}) => {
		steps.push({ step, status, why, ...extra });
		ops.log(`${step.padEnd(13)}${status.padEnd(9)}${why}`);
	};
	const save = () => {
		writeJson(statePath, st);
		writeJson(globalPath(o.out), g);
	};
	const { settings, approval } = loadSettings(o.settingsPath);
	const finish = (exitCode, { write = true } = {}) => {
		let report = null;
		if (write) {
			save();
			report = weeklyReport({ cycle, steps, cs: readJson(join(dir, "cycle.json")), st, g, o, exitCode });
			writeFileSync(join(apDir, "report.md"), report);
			ops.log(`report: ${join(apDir, "report.md")}`);
		}
		return { cycle, steps, exitCode, report, state: st, global: g };
	};

	// money
	if (o.spendCap === null || o.spendCap === undefined) {
		const ready = examReadiness(o.exam, o.gate);
		const tasks = ready.usable?.length ?? (ready.drafted ? Math.max(ready.drafted, o.gate.minApproved) : null);
		const w = worstWeek({ settings, tasks, gate: o.gate });
		done("money", "stopped", `no --spend-cap was given, so nothing ran; ${describeWorst(w)}. Run again with --spend-cap <usd>.`, { worst: w });
		return finish(EXIT.NO_CAP, { write: false });
	}
	if (!(o.spendCap > 0)) throw new Error("--spend-cap is a number of dollars above 0");

	// last week's pull request
	try {
		for (const rec of g.prs) checkPullRequest(rec, g, o, ops);
	} catch (error) {
		done("pull request", "stopped", `the autopilot's earlier pull requests could not be read (${error.message}), so nothing paid runs`);
		return finish(EXIT.WAITING);
	}
	const open = g.prs.find((p) => p.status === "open");
	if (open) {
		done("pull request", "stopped", `pull request #${open.number} (${open.url}) from ${open.cycle ?? "an earlier week"} still waits for a person, so this week spends nothing until it is merged or closed.`);
		return finish(EXIT.WAITING);
	}
	const unreleased = g.prs.find((p) => p.status === "merged");
	if (unreleased) {
		done("pull request", "stopped", `pull request #${unreleased.number} is merged and no release holds it yet, so this week waits: the next cycle is measured against the release that holds it.`);
		return finish(EXIT.WAITING);
	}
	done("pull request", "ran", g.prs.length ? `none waits; the champion is ${g.champion?.version ?? "not recorded yet"}` : "none opened yet");

	// harness
	if (!st.base) {
		const fetched = ops.run("git", ["-C", o.harness, "fetch", "--quiet", "origin", "main"]);
		if (fetched.status !== 0) {
			done("harness", "failed", `git fetch origin main failed in ${o.harness}: ${(fetched.stderr || fetched.stdout).trim().split("\n")[0]}`);
			return finish(EXIT.FAILED);
		}
		const base = ops.run("git", ["-C", o.harness, "rev-parse", "origin/main"]);
		const pkg = ops.run("git", ["-C", o.harness, "show", "origin/main:package.json"]);
		if (base.status !== 0 || pkg.status !== 0) {
			done("harness", "failed", `origin/main could not be read in ${o.harness}`);
			return finish(EXIT.FAILED);
		}
		st.base = base.stdout.trim();
		st.harnessVersion = JSON.parse(pkg.stdout).version;
		st.build = buildVersion(st.harnessVersion, cycle);
	}
	st.champion ??= o.champion ?? g.champion?.version ?? st.harnessVersion;
	if (!RELAY_VERSION_PATTERN.test(st.champion)) {
		done("harness", "failed", `the champion must be a released Relay version, such as 0.6.121, not ${st.champion}`);
		return finish(EXIT.FAILED);
	}
	if (!isLocalBuild(st.build)) throw new Error(`not a local build version: ${st.build}`);
	done("harness", "ran", `origin/main at ${st.base.slice(0, 10)} (Relay ${st.harnessVersion}); the champion is relay@${st.champion}; this week's build is ${st.build}`);

	const cycleRun = (spendCap) =>
		runCycle({
			cycle,
			out: o.out,
			settingsPath: o.settingsPath,
			records: o.records,
			tasksDirs: o.tasksDirs,
			harness: o.harness,
			harnessRef: st.base,
			champion: st.champion,
			model: o.model,
			exam: o.exam,
			teaching: o.teaching ?? null,
			armOutcomes: o.armOutcomes ?? null,
			packages: join(dir, "packages"),
			ledgerPath: o.ledgerPath,
			spendCap,
			release: st.build,
			exec: ops.node,
			env,
			now,
			log: (line) => ops.log(`  ${line}`),
		});

	// ready: the exam, a person's approval of the loop's settings, the keys, the disk
	const ready = examReadiness(o.exam, o.gate);
	const keyName = KEY_ENV[providerOf(o.model)];
	const blockers = [];
	if (!ready.ok) blockers.push(ready.sentence);
	if (approval.length) blockers.push("No person has approved the loop's settings, so this week stops before anything paid: node loop/meta.mjs approve --by <name>.");
	if (!o.signedBy) blockers.push("No one is named to sign the ledger, so this week stops before anything paid: pass --signed-by <your name>.");
	if (!env[keyName]) blockers.push(`The runs need ${keyName}${o.keychain ? `, and the Keychain item ${o.keychain} gave none` : " (or --keychain <service>)"}, so this week stops before anything paid.`);
	if (!env.E2B_API_KEY) blockers.push("The runs need E2B_API_KEY in the environment, so this week stops before anything paid.");
	const free = ops.freeGb(o.work);
	if (free < o.minFreeGb) blockers.push(`The disk has ${f(free)} GB free and the builds need ${o.minFreeGb} GB, so this week stops before anything paid.`);
	if (blockers.length) {
		try {
			const r = await cycleRun(null);
			done("cycle", "ran", `the free steps only: ${r.steps.filter((s) => s.status === "ran").map((s) => s.step).join(", ") || "none"}`);
		} catch (error) {
			done("cycle", "failed", error.message);
		}
		done("ready", "stopped", blockers[0], { blockers });
		const out = finish(EXIT.WAITING);
		ops.log(blockers[0]);
		return out;
	}
	done("ready", "ran", `${ready.usable.length} approved, locked exam tasks, anchors ${loadAnchors(ready.anchors).version}; the loop's settings approved; ${f(free)} GB free`);

	// cycle: the free steps and the writers
	let r1;
	try {
		const before = cycleSpend(dir);
		r1 = await cycleRun(capLeft());
		addSpend("cycle", cycleSpend(dir) - before);
	} catch (error) {
		done("cycle", "failed", error.message);
		return finish(EXIT.FAILED);
	}
	const stopped1 = r1.steps.find((s) => s.status === "stopped");
	if (stopped1) {
		done("cycle", "stopped", `${stopped1.step}: ${stopped1.why}`);
		return finish(EXIT.WAITING);
	}
	const proposals = r1.state.proposals ?? [];
	done("cycle", "ran", `${plural(proposals.length, "proposal")}; ${money(spentNow)} spent so far`);
	if (!proposals.length) {
		done("build", "skipped", "no proposal this week, so nothing to build or gate.");
		return finish(EXIT.DONE);
	}

	// build: each proposal's Relay, for its pre-screen
	st.builds ??= {};
	const home = join(o.work, "home");
	mkdirSync(home, { recursive: true });
	const benv = buildEnv({ home, env });
	const results1 = r1.state.prescreen?.results ?? {};
	for (const [i, p] of proposals.entries()) {
		const pkg = join(dir, "packages", `${p.id}.tgz`);
		if (existsSync(pkg) || st.builds[p.id]?.status === "failed" || ["passed", "dropped", "held"].includes(results1[p.id]?.status)) continue;
		const version = `${st.build}.${i + 1}`;
		let wt = null;
		try {
			wt = addWorktreeSafe({ ops, o, dir: join(o.work, `wt-${cycle}-${i + 1}`), base: st.base });
			applyPatch({ run: ops.run, dir: wt.dir, patch: join(dir, "proposals", `${p.id}.patch`) });
			const built = buildRelay({ run: ops.run, dir: wt.dir, version, env: benv, log: ops.log });
			st.builds[p.id] = { status: "built", version, sha256: keepPackage(built.tgz, pkg), steps: built.steps };
		} catch (error) {
			st.builds[p.id] = { status: "failed", version, why: error.message };
		} finally {
			wt?.remove();
		}
		save();
	}
	const builds = Object.values(st.builds);
	const failed = Object.entries(st.builds).filter(([, b]) => b.status === "failed");
	done("build", builds.some((b) => b.status === "built") ? "ran" : "stopped", `${builds.filter((b) => b.status === "built").length} of ${proposals.length} proposals built${failed.length ? `; ${failed.map(([id, b]) => `${id}: ${b.why.split("\n")[0]}`).join("; ")}` : ""}`);

	// prescreen and package
	let r2;
	try {
		const before = cycleSpend(dir);
		r2 = await cycleRun(capLeft());
		addSpend("cycle", cycleSpend(dir) - before);
	} catch (error) {
		done("prescreen", "failed", error.message);
		return finish(EXIT.FAILED);
	}
	const pre = r2.steps.find((s) => s.step === "prescreen");
	done("prescreen", pre?.status === "ran" ? "ran" : pre?.status ?? "skipped", pre?.why ?? "no proposal to pre-screen");
	const pkgStep = r2.steps.find((s) => s.step === "package");
	if (!r2.state.package) {
		done("package", pkgStep?.status ?? "skipped", `${pkgStep?.why ?? "no release was packaged"}, so nothing goes to the gate this week.`);
		return finish(EXIT.DONE);
	}
	done("package", "ran", pkgStep.why);

	// release: the packaged release, built at origin/main, checked, committed
	if (!st.release?.sha256) {
		const releaseDir = join(dir, "release");
		const ref = `refs/relay-autopilot/${cycle}`;
		let wt = null;
		try {
			wt = addWorktreeSafe({ ops, o, dir: join(o.work, `wt-${cycle}-release`), base: st.base });
			applyPatch({ run: ops.run, dir: wt.dir, patch: join(releaseDir, "release.patch") });
			const built = buildRelay({
				run: ops.run,
				dir: wt.dir,
				version: st.build,
				env: benv,
				check: true,
				log: ops.log,
				commit: () => commitTree({ run: ops.run, dir: wt.dir, harness: o.harness, ref, message: `${(readFileSync(join(releaseDir, "PR_BODY.md"), "utf8").split("\n")[0] ?? "").replace(/^#\s*/, "")}\n\nThe improvement loop's release for cycle ${cycle}, from relay-bench runs/loop/${cycle}/release/release.patch, after npm run arch and npm run check.` }),
			});
			const packagePath = join(releaseDir, `relay-${st.build}.tgz`);
			st.release = { version: st.build, package: packagePath, sha256: keepPackage(built.tgz, packagePath), commit: built.commit, ref, base: st.base, patchSha256: sha256File(join(releaseDir, "release.patch")), steps: built.steps };
			delete st.releaseFailed;
		} catch (error) {
			st.releaseFailed = error.message;
			done("release", "failed", `${error instanceof BuildError ? error.message.split("\n")[0] : error.message}; no pull request.`);
			return finish(EXIT.FAILED);
		} finally {
			wt?.remove();
		}
		save();
	}
	done("release", "ran", `${st.build} built from ${st.release.commit.slice(0, 10)} (origin/main ${st.base.slice(0, 10)} plus release.patch), npm run check passed; sha256 ${st.release.sha256.slice(0, 12)}`);

	// gate: the exam, look by look, within the cap
	const design = gateDesign(ready.usable.length, o.gate);
	const test = `gate-${st.build}`;
	const gateOut = join(o.exam, "runs", "gate");
	const args = gateArgs({ st, o, ready, dir, design });
	const looksPath = join(gateOut, `${test}.looks.json`);
	const resultPath = join(gateOut, `${test}.gate.json`);
	let result = st.gate?.result ?? null;
	for (let guard = 0; guard < design.looks + 2; guard++) {
		const looks = readJson(looksPath);
		if (looks?.decided) {
			result = readJson(resultPath);
			break;
		}
		const look = (looks?.looks?.length ?? 0) + 1;
		const newRuns = (lookSize(design, look) - (look > 1 ? lookSize(design, look - 1) : 0)) * 2 * o.gate.reps;
		const worst = newRuns * o.gate.capUsdPerRun;
		if (capLeft() < o.gate.capUsdPerRun) {
			done("gate", "stopped", `the cap has ${money(capLeft())} left, less than one run's ${money(o.gate.capUsdPerRun)}, before look ${look}; run again with a cap to go on.`);
			break;
		}
		const before = runsSpend(gateOut, test);
		const stageCap = before.test + Math.min(capLeft(), worst);
		const e2bCap = before.sandbox + o.gate.e2bUsdPerLook;
		ops.log(`gate look ${look}: up to ${newRuns} runs, at most ${money(Math.min(capLeft(), worst))} of model spend and ${money(o.gate.e2bUsdPerLook)} of sandbox time`);
		const ran = ops.node("runner/gate.mjs", [...args, "--stage-cap-usd", stageCap.toFixed(4), "--e2b-cap-usd", e2bCap.toFixed(4)], { stream: true });
		const after = runsSpend(gateOut, test);
		addSpend("gate", after.test - before.test, after.sandbox - before.sandbox);
		save();
		if (![0, 10, 20].includes(ran.status)) {
			done("gate", "failed", `runner/gate.mjs exited ${ran.status}: ${(ran.stderr || ran.stdout || "").trim().split("\n").pop()}`);
			return finish(EXIT.FAILED);
		}
		result = readJson(resultPath);
		if (!result?.continue || readJson(looksPath)?.decided) break;
		if (after.graded === before.graded) {
			done("gate", "stopped", `look ${look} added no graded run (the stage stopped at a cap), so the gate waits; run again to go on.`);
			break;
		}
	}
	if (!result) return finish(EXIT.UNRESOLVED);
	st.gate = { test, out: gateOut, status: result.status, label: result.label, exitCode: result.exitCode, final: Boolean(readJson(looksPath)?.decided), result };
	save();
	done("gate", "ran", `${result.status} (exit ${result.exitCode}) at look ${result.look?.index ?? "–"} of ${design.looks}: ${signed(result.difference)} points, interval ${f(result.low)} to ${f(result.high)}, over ${result.tasks} tasks; the rule: ${ruleWords(result.label)}`);
	if (result.status !== "PASS") {
		// The release's commit is kept (a hidden ref) while the gate may still go on; a decided gate lets it go.
		if (st.gate.final) ops.run("git", ["-C", o.harness, "update-ref", "-d", st.release.ref]);
		done("pull request", "skipped", `the gate gave ${result.status}${result.status === "UNRESOLVED" && !st.gate.final ? " between looks" : ""}, so no pull request is opened and no ledger entry is written.`);
		return finish(result.status === "BLOCK" ? EXIT.BLOCK : EXIT.UNRESOLVED);
	}

	// ledger: on PASS only, read again from the records by scripts/ledger.mjs
	if (!st.ledger?.written) {
		const last = readLedger(o.ledgerPath).entries.at(-1);
		const chain = last ? (g.champion?.holds && g.champion.holds === last.release ? ["--follows", last.release] : last.release !== st.champion ? ["--chain-start"] : []) : [];
		const lr = ops.node("scripts/ledger.mjs", ["write", "--test", test, "--out", gateOut, "--tasks-dir", ready.tasksDir, "--anchors", ready.anchors, "--signed-by", o.signedBy, ...chain, ...(o.ledgerPath ? ["--ledger", o.ledgerPath] : [])]);
		if (lr.status !== 0) {
			done("ledger", "failed", `scripts/ledger.mjs refused: ${(lr.stderr || lr.stdout).trim().split("\n")[0]}; no pull request.`);
			return finish(EXIT.FAILED);
		}
		st.ledger = { written: true, line: lr.stdout.trim().split("\n").pop(), chain };
		save();
	}
	done("ledger", "ran", st.ledger.line);

	// pull request: on PASS only
	if (!st.pr?.url) {
		const branch = `loop/${cycle}`;
		const pushed = ops.run("git", ["-C", o.harness, "push", "origin", `${st.release.commit}:refs/heads/${branch}`]);
		if (pushed.status !== 0) {
			done("pull request", "failed", `git push of ${branch} failed: ${(pushed.stderr || pushed.stdout).trim().split("\n").pop()}`);
			return finish(EXIT.FAILED);
		}
		const prBody = readFileSync(join(dir, "release", "PR_BODY.md"), "utf8");
		const cycleSpent = st.spend.filter((e) => e.step === "cycle").reduce((s, e) => s + e.usd, 0);
		const gateSpent = st.spend.filter((e) => e.step === "gate").reduce((s, e) => s + e.usd, 0);
		const sandbox = st.spend.reduce((s, e) => s + (e.sandboxUsd ?? 0), 0);
		const body = pullRequestBody({ prBody, st, result, ledgerLine: st.ledger.line, o, cycle, dir, spend: { total: cycleSpent + gateSpent, cycle: cycleSpent, gate: gateSpent, sandbox } });
		const bodyPath = join(apDir, "PR_BODY.md");
		writeFileSync(bodyPath, body);
		const title = (prBody.split("\n")[0] ?? `Relay loop, cycle ${cycle}`).replace(/^#\s*/, "");
		const created = ops.run("gh", ["pr", "create", "--repo", o.repo, "--base", "main", "--head", branch, "--title", title, "--body-file", bodyPath, "--label", o.label]);
		if (created.status !== 0) {
			done("pull request", "failed", `gh pr create failed: ${(created.stderr || created.stdout).trim().split("\n").pop()}`);
			return finish(EXIT.FAILED);
		}
		const url = created.stdout.trim().split("\n").pop();
		const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? Number.NaN);
		st.pr = { url, number, branch };
		g.prs.push({ number, url, cycle, build: st.build, branch, commit: st.release.commit, champion: st.champion, status: "open", openedAt: ops.now().toISOString() });
		ops.run("git", ["-C", o.harness, "update-ref", "-d", st.release.ref]);
		save();
	}
	done("pull request", "ran", `opened ${st.pr.url}; merging it is the one step for a person`);
	return finish(EXIT.DONE);
}

function addWorktreeSafe({ ops, o, dir, base }) {
	return addWorktree({ run: ops.run, harness: o.harness, dir, base, link: ops.link ?? linkNodeModules });
}

/** --install-schedule weekly: writes the launchd agent and loads it; prints the crontab line for Linux. */
export function installSchedule(options, ops) {
	const o = { ...DEFAULTS, ...options };
	const args = scheduleArgs({ spendCap: o.spendCap, signedBy: o.signedBy, keychain: o.keychain ?? "relay-openai", extra: o.scheduleExtra ?? [] });
	const node = o.node ?? process.execPath;
	const logDir = o.logDir ?? join(ROOT, "runs", "autopilot");
	const text = plist({ bench: ROOT.replace(/\/$/, ""), node, args, logDir });
	const path = o.plist ?? plistPath(o.home ?? homedir());
	mkdirSync(dirname(path), { recursive: true });
	mkdirSync(logDir, { recursive: true });
	writeFileSync(path, text);
	ops.log(`wrote ${path}: every Monday at 06:00, node loop/autopilot.mjs ${args.join(" ")}`);
	if (o.load !== false) {
		const uid = String(process.getuid?.() ?? "");
		ops.run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
		const loaded = ops.run("launchctl", ["bootstrap", `gui/${uid}`, path]);
		ops.log(loaded.status === 0 ? "loaded it with launchctl; it runs next Monday" : `launchctl bootstrap failed: ${(loaded.stderr || "").trim()}; load it with: launchctl bootstrap gui/${uid} ${path}`);
	}
	ops.log(`On Linux, the same job as a crontab line (keys in ~/.relay-autopilot.env, chmod 600):\n${crontabLine({ bench: ROOT.replace(/\/$/, ""), node, args })}`);
	return { path, text, args };
}

/** The real side effects, for the command line. */
export function realOps({ log = (line) => console.log(line) } = {}) {
	return {
		run: sh,
		node: (script, args, { stream = false } = {}) => {
			const r = spawnSync(process.execPath, [join(ROOT, script), ...args], { encoding: "utf8", env: process.env, stdio: stream ? ["ignore", "inherit", "inherit"] : "pipe", maxBuffer: 256 * 1024 * 1024 });
			return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
		},
		freeGb,
		now: () => new Date(),
		log,
		link: linkNodeModules,
		env: process.env,
	};
}

/** Reads a Keychain item into the environment of this process only (macOS `security`), never printing it. */
export function keyFromKeychain(service, run = sh) {
	const r = run("security", ["find-generic-password", "-s", service, "-w"]);
	return r.status === 0 ? r.stdout.replace(/\n$/, "") : null;
}

/** The practice records and tasks the round left, when the command names none. */
function defaultInputs() {
	const records = ["runs/round-1/records.jsonl", "runs/round-1/F/records.jsonl", "runs/round-1/G/records.jsonl"].map((p) => join(ROOT, p)).filter((p) => existsSync(p));
	const tasksDirs = ["tasks", "tasks-draft1"].map((p) => join(ROOT, p)).filter((p) => existsSync(p));
	return { records, tasksDirs: tasksDirs.length ? tasksDirs : [join(ROOT, "tasks")] };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values } = parseArgs({
		options: {
			"spend-cap": { type: "string" },
			"signed-by": { type: "string" },
			keychain: { type: "string" },
			model: { type: "string" },
			harness: { type: "string" },
			exam: { type: "string" },
			records: { type: "string", multiple: true },
			"tasks-dir": { type: "string", multiple: true },
			teaching: { type: "string" },
			"arm-outcomes": { type: "string" },
			champion: { type: "string" },
			cycle: { type: "string" },
			out: { type: "string" },
			work: { type: "string" },
			ledger: { type: "string" },
			settings: { type: "string" },
			"after-merge": { type: "string" },
			"install-schedule": { type: "string" },
			"remove-schedule": { type: "boolean", default: false },
		},
	});
	const spendCap = values["spend-cap"] === undefined ? null : Number(values["spend-cap"]);
	if (spendCap !== null && !(spendCap > 0)) throw new Error("--spend-cap is a number of dollars above 0");
	const inputs = defaultInputs();
	const options = {
		spendCap,
		signedBy: values["signed-by"] ?? null,
		keychain: values.keychain ?? null,
		...(values.model ? { model: values.model } : {}),
		...(values.harness ? { harness: resolve(values.harness) } : {}),
		...(values.exam ? { exam: resolve(values.exam) } : {}),
		...(values.out ? { out: resolve(values.out) } : {}),
		...(values.work ? { work: resolve(values.work) } : {}),
		...(values.settings ? { settingsPath: resolve(values.settings) } : {}),
		records: (values.records ?? inputs.records).map((p) => resolve(p)),
		tasksDirs: (values["tasks-dir"] ?? inputs.tasksDirs).map((p) => resolve(p)),
		teaching: values.teaching ? resolve(values.teaching) : null,
		armOutcomes: values["arm-outcomes"] ? resolve(values["arm-outcomes"]) : null,
		champion: values.champion ?? null,
		cycle: values.cycle ?? null,
		ledgerPath: values.ledger ? resolve(values.ledger) : undefined,
	};
	const ops = realOps();
	if (values["install-schedule"] !== undefined) {
		if (values["install-schedule"] !== "weekly") throw new Error("--install-schedule takes weekly");
		const extra = [];
		// Never --champion: after a merge the champion is the release that holds it, which the autopilot records itself.
		for (const [flag, v] of [["--model", values.model], ["--harness", values.harness && resolve(values.harness)], ["--exam", values.exam && resolve(values.exam)], ["--arm-outcomes", values["arm-outcomes"] && resolve(values["arm-outcomes"])]]) if (v) extra.push(flag, v);
		for (const r of values.records ?? []) extra.push("--records", resolve(r));
		for (const t of values["tasks-dir"] ?? []) extra.push("--tasks-dir", resolve(t));
		installSchedule({ ...options, scheduleExtra: extra }, ops);
	} else if (values["remove-schedule"]) {
		const path = plistPath(homedir());
		ops.run("launchctl", ["bootout", `gui/${process.getuid?.()}/${LABEL}`]);
		if (existsSync(path)) rmSync(path);
		ops.log(`removed ${path}; no weekly run is scheduled`);
	} else if (values["after-merge"] !== undefined) {
		const r = afterMerge(values["after-merge"], { ...DEFAULTS, ...options }, ops);
		process.exitCode = r.status === "released" ? 0 : EXIT.WAITING;
	} else {
		if (options.keychain) {
			const name = KEY_ENV[providerOf(options.model ?? DEFAULTS.model)];
			const key = keyFromKeychain(options.keychain);
			if (key) process.env[name] = key;
		}
		const r = await runWeek(options, ops);
		process.exitCode = r.exitCode;
	}
}
