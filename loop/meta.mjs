#!/usr/bin/env node
// The meta loop: the improvement loop's own settings are a lane of their own (v7, Meta: "better at getting better").
//
// The settings (loop/settings.json): each lane's fixed budget per cycle, whether it runs, how many proposals it keeps,
// and the cluster thresholds. A change to them is judged by gated gain per dollar over the last N cycles: the anchor
// gain of every release in the compound ledger that holds a loop change, shared out equally between the lanes it
// changed, divided by what those lanes spent in the cycles' pre-screens and writing. Only a gate on the exam puts a
// release in the ledger, so a gain the gate never saw counts for nothing.
//
// The meta loop proposes; it never applies. A proposal is a diff to loop/settings.json that a person approves with
// `node loop/meta.mjs approve`, which records who did; a cycle refuses every paid step while the settings differ from
// what a person approved. It may move budget between lanes, turn a lane off, change how many proposals a lane keeps and
// the cluster thresholds, never raise the total budget, never turn the runtime lane on, and never touch the pre-screen's
// sizes or its own rules, which a person changes by hand.
//
//   node loop/meta.mjs judge [--out runs/loop] [--ledger ledger/ledger.json] [--settings loop/settings.json] [--json]
//   node loop/meta.mjs approve --by <name> [--proposal <meta-proposal.json>] [--settings loop/settings.json]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readLedger, signerProblems } from "../scripts/ledger.mjs";
import { canonical, changedPaths, getPath, setPath, sha256, unifiedDiff } from "./diff.mjs";
import { LANE_ORDER, LANES } from "./lanes.mjs";
import { cycleOfChange } from "./package.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
export const SETTINGS_PATH = join(ROOT, "loop", "settings.json");

/** The settings the meta loop may change, as path patterns. */
export const META_KEYS = Object.freeze([/^lanes\.[a-z]+\.(enabled|budgetUsd|proposals)$/, /^clusters\.(minRuns|minTasks)$/]);
/** Lanes that spend: the meta loop moves budget between these only. */
export const PAID_LANES = Object.freeze(LANE_ORDER.filter((l) => ["rules", "writer"].includes(LANES[l].how)));

const strip = ({ approved, ...rest }) => rest;
export const settingsHash = (settings) => sha256(canonical(strip(settings)));
export const serializeSettings = (s) => `${JSON.stringify(s, null, "\t")}\n`;

export function loadSettings(path = SETTINGS_PATH) {
	const settings = JSON.parse(readFileSync(path, "utf8"));
	return { settings, hash: settingsHash(settings), problems: settingsProblems(settings), approval: approvalProblems(settings) };
}

/** What is wrong with the settings' shape; empty when they can be used. */
export function settingsProblems(s) {
	const problems = [];
	for (const lane of LANE_ORDER) {
		const l = s.lanes?.[lane];
		if (!l) {
			problems.push(`lanes.${lane} is missing`);
			continue;
		}
		if (typeof l.enabled !== "boolean") problems.push(`lanes.${lane}.enabled must be true or false`);
		if (!(Number.isFinite(l.budgetUsd) && l.budgetUsd >= 0)) problems.push(`lanes.${lane}.budgetUsd must be a number of dollars`);
		if (!(Number.isInteger(l.proposals) && l.proposals >= 0 && l.proposals <= 5)) problems.push(`lanes.${lane}.proposals must be a whole number from 0 to 5`);
	}
	for (const lane of Object.keys(s.lanes ?? {})) if (!LANE_ORDER.includes(lane)) problems.push(`lanes.${lane} is not a lane`);
	if (s.lanes?.runtime?.enabled) problems.push("the runtime lane is documented only; it cannot be turned on yet");
	for (const k of ["minRuns", "minTasks"]) if (!(Number.isInteger(s.clusters?.[k]) && s.clusters[k] >= 2)) problems.push(`clusters.${k} must be a whole number of at least 2`);
	const p = s.prescreen ?? {};
	for (const k of ["devReps", "selectionReps", "concurrency", "maxSelectionQueries"]) if (!(Number.isInteger(p[k]) && p[k] >= 1)) problems.push(`prescreen.${k} must be a whole number of at least 1`);
	for (const k of ["capUsdPerRun", "e2bCapUsd"]) if (!(Number.isFinite(p[k]) && p[k] > 0)) problems.push(`prescreen.${k} must be a number above 0`);
	if (typeof p.devTasks !== "string" || !p.devTasks) problems.push("prescreen.devTasks must name the practice tasks, such as kind:everyday");
	for (const k of ["windowCycles", "minCycles"]) if (!(Number.isInteger(s.meta?.[k]) && s.meta[k] >= 1)) problems.push(`meta.${k} must be a whole number of at least 1`);
	return problems;
}

/** Why a cycle may not spend under these settings; empty when a person approved them as they are. */
export function approvalProblems(s) {
	if (!s.approved?.by) return ["no person has approved the loop's settings yet: node loop/meta.mjs approve --by <name>"];
	if (s.approved.hash !== settingsHash(s)) return [`the loop's settings changed after ${s.approved.by} approved them; a person approves them again`];
	return [];
}

/** Why a proposed change to the settings is not the meta loop's to make; empty when it is. */
export function metaProblems(before, after) {
	const problems = [];
	for (const p of changedPaths(strip(before), strip(after))) if (!META_KEYS.some((re) => re.test(p))) problems.push(`${p} is not the meta loop's to change; a person changes it by hand`);
	const total = (s) => LANE_ORDER.reduce((sum, l) => sum + (s.lanes?.[l]?.budgetUsd ?? 0), 0);
	if (total(after) > total(before) + 1e-9) problems.push(`it raises the loop's budget from $${total(before).toFixed(2)} to $${total(after).toFixed(2)} a cycle; only a person raises it`);
	problems.push(...settingsProblems(after));
	return problems;
}

/** Every cycle the loop has summed up (<out>/<cycle>/summary.json), oldest first. */
export function readCycles(out) {
	if (!existsSync(out)) return [];
	return readdirSync(out)
		.filter((d) => /^\d{4}-W\d{2}$/.test(d) && existsSync(join(out, d, "summary.json")))
		.sort()
		.map((d) => JSON.parse(readFileSync(join(out, d, "summary.json"), "utf8")));
}

/** A ledger entry's gated gain, in points: the anchors' gain, or the exam's when the entry has no anchors. */
export const gainOf = (entry) => (Number.isFinite(entry.anchors?.difference) ? entry.anchors.difference : Number.isFinite(entry.exam?.difference) ? entry.exam.difference : 0);

const per = (gain, spend) => (spend > 0 ? gain / spend : null);

/**
 * Gated gain per dollar over the last `windowCycles` cycles, per lane, overall and per settings version. Each ledger
 * entry's gain is shared equally between the loop lanes it changed, and counted for the cycle its changes name.
 */
export function judgeMeta({ ledger, cycles, settings }) {
	const window = cycles.slice(-settings.meta.windowCycles);
	const inWindow = new Set(window.map((c) => c.cycle));
	const gainByCycleLane = new Map();
	const releases = [];
	for (const e of ledger.entries ?? []) {
		const loopLanes = (e.lanes ?? []).filter((l) => inWindow.has(cycleOfChange(l.change)));
		if (!loopLanes.length) continue;
		const g = gainOf(e) / loopLanes.length;
		releases.push({ release: e.release, gainPoints: gainOf(e), lanes: loopLanes.map((l) => l.lane) });
		for (const l of loopLanes) {
			const key = `${cycleOfChange(l.change)}|${l.lane}`;
			gainByCycleLane.set(key, (gainByCycleLane.get(key) ?? 0) + g);
		}
	}
	const lanes = {};
	for (const lane of PAID_LANES) {
		const spend = window.reduce((s, c) => s + (c.spend?.[lane] ?? 0), 0);
		const gain = window.reduce((s, c) => s + (gainByCycleLane.get(`${c.cycle}|${lane}`) ?? 0), 0);
		const ran = window.filter((c) => c.lanes?.[lane]);
		const prescreened = ran.reduce((s, c) => s + (c.lanes[lane].prescreened ?? 0), 0);
		const passed = ran.reduce((s, c) => s + (c.lanes[lane].passed ?? 0), 0);
		lanes[lane] = {
			spendUsd: spend,
			gainPoints: gain,
			gainPerDollar: per(gain, spend),
			cycles: ran.length,
			prescreened,
			passed,
			atLimit: ran.filter((c) => c.lanes[lane].atLimit).length,
		};
	}
	const spend = Object.values(lanes).reduce((s, l) => s + l.spendUsd, 0);
	const gain = Object.values(lanes).reduce((s, l) => s + l.gainPoints, 0);
	const versions = [];
	for (const c of window) {
		let v = versions.find((x) => x.hash === c.settingsHash);
		if (!v) versions.push((v = { hash: c.settingsHash, settings: c.settings, cycles: 0, spendUsd: 0, gainPoints: 0, last: c.cycle }));
		v.cycles++;
		v.last = c.cycle;
		v.spendUsd += Object.values(c.spend ?? {}).reduce((s, x) => s + x, 0);
		v.gainPoints += PAID_LANES.reduce((s, l) => s + (gainByCycleLane.get(`${c.cycle}|${l}`) ?? 0), 0);
	}
	for (const v of versions) v.gainPerDollar = per(v.gainPoints, v.spendUsd);
	return { cycles: window.length, from: window[0]?.cycle ?? null, to: window.at(-1)?.cycle ?? null, releases, lanes, overall: { spendUsd: spend, gainPoints: gain, gainPerDollar: per(gain, spend) }, versions, clustersFound: window.map((c) => c.clusters ?? 0) };
}

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * The meta loop's proposals from a judgement: each a diff to loop/settings.json, with the numbers it rests on. None
 * is applied. With fewer than `minCycles` cycles there is nothing to judge.
 */
export function metaProposals(j, settings, { cycle = "meta" } = {}) {
	const m = settings.meta;
	const before = strip(settings);
	const base = settingsHash(settings);
	const out = [];
	const make = (rule, words, after, evidence) => {
		const problems = metaProblems(before, after);
		out.push({ id: `${cycle}-meta-${rule}`, lane: "meta", rule, words, evidence, base, after, diff: unifiedDiff(serializeSettings(before), serializeSettings(after), { path: "loop/settings.json" }), problems });
	};
	if (j.cycles < m.minCycles) return out;
	const lanes = Object.entries(j.lanes).filter(([l]) => settings.lanes[l]?.enabled);

	// The current settings against the version before them, each over at least minCycles cycles.
	const cur = j.versions.find((v) => v.hash === settingsHash(settings));
	const prev = [...j.versions].reverse().find((v) => v.hash !== cur?.hash);
	if (cur && prev && cur.cycles >= m.minCycles && prev.cycles >= m.minCycles && cur.gainPerDollar !== null && prev.gainPerDollar !== null && cur.gainPerDollar < prev.gainPerDollar && prev.settings) {
		let after = before;
		for (const p of changedPaths(before, { ...before, lanes: prev.settings.lanes, clusters: prev.settings.clusters })) {
			if (META_KEYS.some((re) => re.test(p))) after = setPath(after, p, getPath(prev.settings, p));
		}
		make("roll-back", `go back to the settings before the last change: they gained ${prev.gainPerDollar.toFixed(3)} points a dollar over ${prev.cycles} cycles, the current ones ${cur.gainPerDollar.toFixed(3)} over ${cur.cycles}`, after, { current: cur, previous: { ...prev, settings: undefined } });
	}

	const measured = lanes.filter(([, l]) => l.spendUsd >= m.minSpendUsd && l.gainPerDollar !== null);
	const best = [...measured].sort((a, b) => b[1].gainPerDollar - a[1].gainPerDollar)[0];
	// A lane that spent and bought no gated gain over enough cycles is turned off, its budget moved to the best lane.
	for (const [lane, l] of measured) {
		if (l.cycles >= m.minCycles && l.gainPoints <= 0 && settings.lanes[lane].budgetUsd > 0) {
			let after = setPath(before, `lanes.${lane}.enabled`, false);
			after = setPath(after, `lanes.${lane}.budgetUsd`, 0);
			if (best && best[0] !== lane && best[1].gainPoints > 0) after = setPath(after, `lanes.${best[0]}.budgetUsd`, round2(settings.lanes[best[0]].budgetUsd + settings.lanes[lane].budgetUsd));
			make(`off-${lane}`, `turn the ${lane} lane off: it spent $${l.spendUsd.toFixed(2)} over ${l.cycles} cycles and no release it changed gained on the exam`, after, { lane, ...l });
		}
	}
	// Budget from the lane with the lowest gain per dollar to the one with the highest. The total stays the same.
	const ranked = [...measured].filter(([, l]) => l.gainPoints > 0).sort((a, b) => a[1].gainPerDollar - b[1].gainPerDollar);
	if (ranked.length >= 2) {
		const [low, lowL] = ranked[0];
		const [high, highL] = ranked.at(-1);
		const move = round2(settings.lanes[low].budgetUsd * (m.shift ?? 0.25));
		if (highL.gainPerDollar > lowL.gainPerDollar && move > 0) {
			let after = setPath(before, `lanes.${low}.budgetUsd`, round2(settings.lanes[low].budgetUsd - move));
			after = setPath(after, `lanes.${high}.budgetUsd`, round2(settings.lanes[high].budgetUsd + move));
			const projected = (s) => ranked.reduce((sum, [l, x]) => sum + x.gainPerDollar * s.lanes[l].budgetUsd, 0);
			make(`move-${low}-to-${high}`, `move $${move.toFixed(2)} a cycle from ${low} (${lowL.gainPerDollar.toFixed(3)} points a dollar) to ${high} (${highL.gainPerDollar.toFixed(3)})`, after, { from: { lane: low, ...lowL }, to: { lane: high, ...highL }, projectedPointsPerCycle: { before: projected(before), after: projected(after) } });
		}
	}
	// A lane whose proposals keep passing, at its limit most cycles, and at or above the loop's gain per dollar keeps one more.
	for (const [lane, l] of lanes) {
		const cap = settings.lanes[lane].proposals;
		if (l.prescreened >= 2 && l.passed / l.prescreened >= 0.5 && l.atLimit * 2 >= l.cycles && l.gainPerDollar !== null && j.overall.gainPerDollar !== null && l.gainPerDollar >= j.overall.gainPerDollar && cap < 3) {
			make(`more-${lane}`, `let ${lane} keep ${cap + 1} proposals a cycle: ${l.passed} of its ${l.prescreened} passed their pre-screen and it was at its limit in ${l.atLimit} of ${l.cycles} cycles`, setPath(before, `lanes.${lane}.proposals`, cap + 1), { lane, ...l });
		}
	}
	// No cluster for minCycles cycles running: the threshold may be too high to see anything.
	const recent = j.clustersFound.slice(-m.minCycles);
	if (recent.length >= m.minCycles && recent.every((n) => n === 0) && settings.clusters.minRuns > 2) {
		make("fewer-runs-per-cluster", `keep a cluster at ${settings.clusters.minRuns - 1} runs, not ${settings.clusters.minRuns}: the last ${m.minCycles} cycles found none`, setPath(before, "clusters.minRuns", settings.clusters.minRuns - 1), { clustersFound: recent });
	}
	return out;
}

/** The settings with a person's approval recorded: of a meta proposal (which must be based on these settings), or of the
 *  settings as a person left them. Refuses a signer that is a model, a tool or an agent. */
export function approve(settings, { by, proposal = null, now = new Date() }) {
	const problems = signerProblems([by ?? ""]);
	let after = strip(settings);
	if (proposal) {
		if (proposal.base !== settingsHash(settings)) problems.push("the settings changed since this proposal was made; judge again");
		problems.push(...metaProblems(settings, proposal.after));
		after = strip(proposal.after);
	} else problems.push(...settingsProblems(after));
	if (problems.length) return { problems };
	return { settings: { ...after, approved: { by, at: now.toISOString(), hash: settingsHash(after), ...(proposal ? { proposal: proposal.id } : {}) } }, problems: [] };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values, positionals } = parseArgs({
		options: { out: { type: "string", default: join(ROOT, "runs", "loop") }, ledger: { type: "string" }, settings: { type: "string", default: SETTINGS_PATH }, by: { type: "string" }, proposal: { type: "string" }, json: { type: "boolean", default: false } },
		allowPositionals: true,
	});
	const [command] = positionals;
	const settingsPath = resolve(values.settings);
	const { settings } = loadSettings(settingsPath);
	if (command === "judge") {
		const j = judgeMeta({ ledger: readLedger(values.ledger ? resolve(values.ledger) : undefined), cycles: readCycles(resolve(values.out)), settings });
		const proposals = metaProposals(j, settings);
		if (values.json) console.log(JSON.stringify({ judgement: j, proposals }, null, 2));
		else {
			const f = (x, d = 3) => (x === null || x === undefined ? "–" : x.toFixed(d));
			console.log(`${j.cycles} cycles (${j.from ?? "–"} to ${j.to ?? "–"}), ${j.releases.length} gated releases with loop changes; ${f(j.overall.gainPoints, 2)} points for $${f(j.overall.spendUsd, 2)}: ${f(j.overall.gainPerDollar)} points a dollar`);
			for (const [lane, l] of Object.entries(j.lanes)) console.log(`  ${lane.padEnd(13)} $${f(l.spendUsd, 2).padStart(7)}  ${f(l.gainPoints, 2).padStart(6)} points  ${f(l.gainPerDollar).padStart(6)} a dollar  ${l.passed}/${l.prescreened} pre-screens passed`);
			if (!proposals.length) console.log(j.cycles < settings.meta.minCycles ? `no proposal: the meta loop judges from ${settings.meta.minCycles} cycles` : "no proposal");
			for (const p of proposals) console.log(`proposal ${p.id}: ${p.words}${p.problems.length ? ` (refused: ${p.problems.join("; ")})` : ""}`);
		}
	} else if (command === "approve") {
		const proposal = values.proposal ? JSON.parse(readFileSync(resolve(values.proposal), "utf8")) : null;
		const r = approve(settings, { by: values.by, proposal });
		if (r.problems.length) {
			for (const p of r.problems) console.error(p);
			console.error(`nothing was written to ${settingsPath}`);
			process.exit(1);
		}
		writeFileSync(settingsPath, serializeSettings(r.settings));
		console.log(`${settingsPath}: approved by ${values.by}${proposal ? ` (${proposal.id})` : ""}, hash ${r.settings.approved.hash.slice(0, 12)}`);
	} else {
		throw new Error("usage: node loop/meta.mjs judge|approve (see the top of this file)");
	}
}
