#!/usr/bin/env node
// The compound ledger: one entry per release that passed the gate on the exam, in order, each chained to the one before
// by its hash. Each release only has to be never worse; the ledger adds up what each one gained on the anchors, so the
// quarter's trend shows whether Relay really gets better week by week (GATE.md, "The compound ledger").
//
//   node scripts/ledger.mjs write --test gate-0.6.122 --out ../relay-exam/runs/gate --tasks-dir ../relay-exam/tasks \
//     --anchors ../relay-exam/anchors/anchors-v1.json --signed-by <founder>[,<founder>] [--chain-start | --follows <release>]
//   node scripts/ledger.mjs trend [--quarter 2026-Q4 | --from 2026-10-01 --to 2026-12-31] [--json]
//   node scripts/ledger.mjs verify
//
// `write` never trusts a verdict file. It reads the gate's kept looks (<out>/<test>.looks.json) and the run records,
// computes the deciding look again with the gate's own code, and writes only when that gives PASS. It refuses a gate
// that did not stop with PASS, a gate off the exam, a pilot or dev test, a release already in the ledger, a release whose
// champion is not the ledger's last release (unless --chain-start, or --follows: the champion is the release that shipped
// the last entry's local build, GATE.md amendment 4), any safety flag on the candidate's runs, and a signer who looks
// like a model or an agent: Relay never signs its own release. A local build's entry keeps its package's SHA-256.
//
// The ledger is public and numbers only: no task names (the anchors appear by fingerprint), no words for results.
// --ledger <file> reads or writes another ledger file (the tests use one).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadRecords } from "../runner/analyze.mjs";
import { anchorProblems, loadAnchors } from "../runner/anchors.mjs";
import { loadPin, pinFingerprint, pinPathFor, pinProblems } from "../runner/pins.mjs";
import { isLocalBuild, parseModelArm } from "../runner/arms.mjs";
import { buildProblems, gate } from "../runner/gate-analyze.mjs";
import { flagSummary } from "../runner/safety.mjs";
import { tInv } from "../runner/sequential.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
export const LEDGER_PATH = join(ROOT, "ledger", "ledger.json");
export const SCHEMA = 1;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
/** JSON with keys in sorted order, so a hash does not depend on how an object was built. */
export function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.filter((k) => value[k] !== undefined)
			.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
export const entryHash = (entry) => {
	const { hash, ...rest } = entry;
	return sha256(canonical(rest));
};
const round = (x, d = 4) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : (x ?? null));

export const emptyLedger = () => ({ schema: SCHEMA, entries: [] });
export function readLedger(path = LEDGER_PATH) {
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : emptyLedger();
}

/** Names that are a model, a tool or an agent: none of them may sign a release. */
const NOT_A_PERSON = /^(relay|claude|codex|gpt|openai|anthropic|gemini|hermes|prime[- ]?agent|o\d)\b|\bbot\b|\[bot\]|\bagent\b|^$/i;
export function signerProblems(signers) {
	if (!signers.length) return ["a release needs a founder's signature: --signed-by <name>"];
	const problems = [];
	const seen = new Set();
	for (const s of signers) {
		if (NOT_A_PERSON.test(s)) problems.push(`${s || "(empty)"} looks like a model, a tool or an agent; Relay never signs its own release`);
		if (seen.has(s.toLowerCase())) problems.push(`${s} signs twice`);
		seen.add(s.toLowerCase());
	}
	return problems;
}

/**
 * The deciding look again, from the records, with the gate's own code. `state` is the gate's looks.json; `anchors`
 * the anchor set { version, fingerprint, ids }; `pinned` the release's pinned graders (runner/pins.mjs). Throws when the
 * gate has not decided or its look is not reproducible.
 */
export function regate({ state, records, anchors, pinned = null }) {
	if (!state?.decided) throw new Error("this gate has not decided; only a gate that stopped with PASS goes in the ledger");
	const look = state.looks.find((l) => l.index === state.decided.look);
	if (!look?.taskSet) throw new Error(`look ${state.decided.look} does not list its tasks, so it cannot be read again`);
	const tasks = new Set(look.taskSet);
	const history = state.looks.filter((l) => l.index < look.index).map((l) => l.fraction);
	const combined = state.combined ? { release: state.candidate.split("@")[1], lanes: state.combined } : null;
	const used = records.filter((r) => tasks.has(r.task));
	const pin = pinned ? { release: pinned.release, fingerprint: pinFingerprint(pinned), problems: pinProblems(used, pinned) } : null;
	const build = state.candidatePackage ? { ...state.candidatePackage, problems: buildProblems(used, state.candidate, state.candidatePackage) } : null;
	return gate(used, { champion: state.champion, candidate: state.candidate, design: state.design, history, anchors, combined, pin, build });
}

/** Why this gate cannot go in the ledger; empty when it can. */
export function writeProblems({ state, result, records, ledger, signers, chainStart = false, follows = null }) {
	const problems = ledgerProblems(ledger).map((p) => `the ledger itself: ${p}`);
	if (!state) return [...problems, "no gate state (<test>.looks.json): the gate never looked"];
	if (parseModelArm(state.candidate.split("@")[1])) problems.push("this gate examined a model, not a release: model watch records it (scripts/model-watch.mjs), and the ledger holds releases only");
	if (/^(pilot|dev)/.test(state.test)) problems.push(`${state.test} is a pilot or dev test, not a counted gate`);
	if (state.tier !== "exam") problems.push(`the gate ran on the ${state.tier} tier; only a gate on the exam lets a release be signed (TIERS.md)`);
	if (!state.decided) problems.push("the gate has not decided");
	else if (state.decided.status !== "PASS") problems.push(`the gate stopped with ${state.decided.status}, not PASS`);
	if (result) {
		if (result.status !== "PASS" || !result.final) problems.push(`the records give ${result.status} (${result.label}) at the deciding look, not PASS`);
		else if (state.decided && result.label !== state.decided.label) problems.push(`the records give "${result.label}", the gate kept "${state.decided.label}"`);
		if (!result.anchors?.complete) problems.push("the release's anchors are not all scored");
	}
	const flags = flagSummary(records.filter((r) => r.tool === state.candidate));
	if (flags.total) problems.push(`${flags.total} of the candidate's runs carry a safety flag`);
	const release = state.candidate.split("@")[1];
	const champion = state.champion.split("@")[1];
	if (ledger.entries.some((e) => e.release === release)) problems.push(`${release} is already in the ledger`);
	const last = ledger.entries.at(-1);
	if (chainStart && follows) problems.push("--chain-start begins a new chain and --follows continues one; pass one of them");
	if (follows && !isLocalBuild(follows)) problems.push(`--follows names a local build that a release shipped, such as 0.6.122-loop.2026w44, not ${follows}`);
	else if (follows && last?.release !== follows) problems.push(`--follows ${follows}, but the ledger's last release is ${last?.release ?? "none"}`);
	if (last && last.release !== champion && !chainStart && follows !== last.release) problems.push(`the ledger's last release is ${last.release}, but this gate's champion is ${champion}; pass --follows ${last.release} when ${champion} is the release that shipped it, or --chain-start to begin a new chain`);
	problems.push(...signerProblems(signers));
	return problems;
}

/** The entry for one gated release, numbers only. */
export function entryFor({ state, result, records, signers, chainStart = false, follows = null, now = new Date() }) {
	const tasks = new Set(state.looks.find((l) => l.index === state.decided.look).taskSet);
	const used = records.filter((r) => tasks.has(r.task) && typeof r.score?.share === "number");
	const models = [...new Set(used.map((r) => r.model).filter(Boolean))].sort();
	const a = result.anchors;
	return {
		release: state.candidate.split("@")[1],
		champion: state.champion.split("@")[1],
		...(chainStart ? { chainStart: true } : {}),
		...(follows ? { follows } : {}),
		...(state.candidatePackage ? { build: { sha256: state.candidatePackage.sha256 } } : {}),
		date: state.decided.at.slice(0, 10),
		decidedAt: state.decided.at,
		test: state.test,
		model: models.join("+") || null,
		gate: {
			status: result.status,
			exitCode: result.exitCode,
			look: result.look.index,
			looks: state.design.looks,
			spending: state.design.spending,
			plannedTasks: state.design.plannedTasks,
			alphaSpent: round(result.look.spent, 6),
		},
		exam: { tasks: result.tasks, runs: result.runs, difference: round(result.difference), low: round(result.low), high: round(result.high) },
		anchors: { version: a.version, fingerprint: a.fingerprint, tasks: a.tasks, champion: round(a.champion), candidate: round(a.candidate), difference: round(a.difference), low: round(a.low), high: round(a.high), se: round(a.se) },
		costRatio: round(result.costRatio),
		timeRatio: round(result.timeRatio),
		falseDone: { champion: round(result.falseDone.champion), candidate: round(result.falseDone.candidate) },
		safety: { candidate: result.safety.candidate.counts, champion: result.safety.champion.counts },
		lanes: result.combined?.lanes ?? null,
		graders: result.pin?.fingerprint ?? null,
		signers,
		signedAt: now.toISOString(),
		records: sha256(canonical(used.map((r) => [r.runId ?? null, r.task, r.tool, r.rep ?? null, r.score.share]).sort((x, y) => canonical(x).localeCompare(canonical(y))))),
	};
}

/** The ledger with the entry added at its end, numbered and chained by hash. */
export function appendEntry(ledger, entry) {
	const last = ledger.entries.at(-1);
	const chained = { seq: (last?.seq ?? 0) + 1, ...entry, prev: last?.hash ?? null };
	chained.hash = entryHash(chained);
	return { ...ledger, entries: [...ledger.entries, chained] };
}

/** What is wrong with a ledger: a changed entry, a broken chain, an entry that is not a PASS. Empty when it holds. */
export function ledgerProblems(ledger) {
	const problems = [];
	if (ledger.schema !== SCHEMA) problems.push(`schema ${ledger.schema}, expected ${SCHEMA}`);
	ledger.entries.forEach((e, i) => {
		const prev = ledger.entries[i - 1];
		if (e.seq !== i + 1) problems.push(`entry ${i + 1} is numbered ${e.seq}`);
		if (e.prev !== (prev?.hash ?? null)) problems.push(`entry ${e.seq} does not follow entry ${prev?.seq ?? "none"}`);
		if (e.hash !== entryHash(e)) problems.push(`entry ${e.seq} (${e.release}) was changed after it was written`);
		if (e.gate?.status !== "PASS") problems.push(`entry ${e.seq} (${e.release}) is not a PASS`);
		if (prev && e.champion !== prev.release && !e.chainStart && e.follows !== prev.release) problems.push(`entry ${e.seq}'s champion ${e.champion} is not ${prev.release}`);
		if (e.follows && e.follows !== prev?.release) problems.push(`entry ${e.seq} follows ${e.follows}, which is not the entry before it`);
	});
	return problems;
}

/** A quarter such as 2026-Q4, as the dates it covers. */
export function quarterRange(q) {
	const m = /^(\d{4})-Q([1-4])$/.exec(q ?? "");
	if (!m) throw new Error(`a quarter looks like 2026-Q4, not ${q}`);
	const year = Number(m[1]);
	const first = (Number(m[2]) - 1) * 3;
	const end = new Date(Date.UTC(year, first + 3, 0));
	return { from: `${year}-${String(first + 1).padStart(2, "0")}-01`, to: end.toISOString().slice(0, 10) };
}
const quarterOf = (date) => `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;

/**
 * The trend over the releases dated from `from` to `to`, on the anchors. Each release's anchor gain is a paired
 * difference with its own standard error, and releases are gated on separate runs, so the gains add and so do their
 * variances: cumulative = Σ d_i, se = √(Σ se_i²), 95% interval cumulative ± 1.96 × se. Relative to the first champion's
 * anchor score it is a percent; spread over the weeks the releases span it is a percent a week. The slope of the
 * releases' own anchor scores against time, on one anchor version, is a second reading of the same trend.
 */
export function trend(entries, { from, to }) {
	const window = entries.filter((e) => e.date >= from && e.date <= to);
	const used = window.filter((e) => Number.isFinite(e.anchors?.difference) && Number.isFinite(e.anchors?.se));
	const out = { from, to, releases: window.length, withAnchors: used.length, anchorVersions: [...new Set(used.map((e) => e.anchors.version))] };
	if (!used.length) return { ...out, cumulative: null };
	const cumulative = used.reduce((s, e) => s + e.anchors.difference, 0);
	const se = Math.sqrt(used.reduce((s, e) => s + e.anchors.se ** 2, 0));
	const base = used[0].anchors.champion;
	const days = (Date.parse(used.at(-1).date) - Date.parse(used[0].date)) / 86_400_000;
	const weeks = days / 7 + 1;
	const pct = (x) => (base > 0 ? (100 * x) / base : null);
	const perWeek = (x) => (pct(x) === null ? null : pct(x) / weeks);
	const chainBreaks = used.slice(1).filter((e, i) => e.champion !== used[i].release && e.follows !== used[i].release).map((e) => e.release);
	const result = {
		...out,
		cumulative: { points: cumulative, low: cumulative - 1.96 * se, high: cumulative + 1.96 * se, se },
		perRelease: { points: cumulative / used.length, low: (cumulative - 1.96 * se) / used.length, high: (cumulative + 1.96 * se) / used.length },
		startingAnchorScore: base,
		relative: { percent: pct(cumulative), low: pct(cumulative - 1.96 * se), high: pct(cumulative + 1.96 * se) },
		weeks,
		relativePerWeek: { percent: perWeek(cumulative), low: perWeek(cumulative - 1.96 * se), high: perWeek(cumulative + 1.96 * se) },
		compoundPercent: 100 * (used.reduce((p, e) => p * (e.anchors.champion > 0 ? 1 + e.anchors.difference / e.anchors.champion : 1), 1) - 1),
		chainBreaks,
		slope: null,
	};
	const same = used.filter((e) => e.anchors.version === used.at(-1).anchors.version);
	if (same.length >= 3) {
		const xs = same.map((e) => (Date.parse(e.date) - Date.parse(same[0].date)) / (7 * 86_400_000));
		const ys = same.map((e) => e.anchors.candidate);
		const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
		const my = ys.reduce((s, y) => s + y, 0) / ys.length;
		const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
		if (sxx > 0) {
			const b = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx;
			const resid = ys.reduce((s, y, i) => s + (y - my - b * (xs[i] - mx)) ** 2, 0);
			const seB = Math.sqrt(resid / (xs.length - 2) / sxx);
			const t = tInv(0.975, xs.length - 2);
			result.slope = { pointsPerWeek: b, low: b - t * seB, high: b + t * seB, releases: same.length, anchorVersion: same[0].anchors.version };
		}
	}
	return result;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values, positionals } = parseArgs({
		options: {
			test: { type: "string" },
			out: { type: "string" },
			"tasks-dir": { type: "string" },
			anchors: { type: "string" },
			"signed-by": { type: "string" },
			"chain-start": { type: "boolean", default: false },
			follows: { type: "string" },
			ledger: { type: "string" },
			quarter: { type: "string" },
			from: { type: "string" },
			to: { type: "string" },
			json: { type: "boolean", default: false },
		},
		allowPositionals: true,
	});
	const [command] = positionals;
	const ledgerPath = resolve(values.ledger ?? LEDGER_PATH);
	const ledger = readLedger(ledgerPath);
	const f = (x, d = 2) => (x === null || x === undefined ? "–" : x.toFixed(d));

	if (command === "verify") {
		const problems = ledgerProblems(ledger);
		for (const p of problems) console.log(p);
		console.log(problems.length ? `${ledgerPath}: ${problems.length} problem(s)` : `${ledgerPath}: ${ledger.entries.length} entries, chain holds`);
		process.exit(problems.length ? 1 : 0);
	} else if (command === "trend") {
		const range = values.from || values.to ? { from: values.from ?? "0000-01-01", to: values.to ?? "9999-12-31" } : quarterRange(values.quarter ?? quarterOf(ledger.entries.at(-1)?.date ?? new Date().toISOString().slice(0, 10)));
		const t = trend(ledger.entries, range);
		if (values.json) console.log(JSON.stringify(t, null, 2));
		else if (!t.cumulative) console.log(`${t.from} to ${t.to}: ${t.releases} releases, none with anchors`);
		else {
			console.log(`${t.from} to ${t.to}: ${t.withAnchors} releases on anchors ${t.anchorVersions.join(", ")}, over ${f(t.weeks, 1)} weeks`);
			console.log(`  anchors, summed gain      ${f(t.cumulative.points)} points, 95% interval ${f(t.cumulative.low)} to ${f(t.cumulative.high)}`);
			console.log(`  per release               ${f(t.perRelease.points)} points, ${f(t.perRelease.low)} to ${f(t.perRelease.high)}`);
			console.log(`  of the starting score     ${f(t.relative.percent)}%, ${f(t.relative.low)}% to ${f(t.relative.high)}% (start ${f(t.startingAnchorScore, 1)} points)`);
			console.log(`  per week                  ${f(t.relativePerWeek.percent)}%, ${f(t.relativePerWeek.low)}% to ${f(t.relativePerWeek.high)}%`);
			if (t.slope) console.log(`  slope of anchor scores    ${f(t.slope.pointsPerWeek)} points a week, ${f(t.slope.low)} to ${f(t.slope.high)}, ${t.slope.releases} releases`);
			if (t.chainBreaks.length) console.log(`  chain restarts at         ${t.chainBreaks.join(", ")}`);
		}
	} else if (command === "write") {
		for (const name of ["test", "out", "tasks-dir", "anchors", "signed-by"]) if (!values[name]) throw new Error(`write needs --${name}`);
		const out = resolve(ROOT, values.out);
		const statePath = join(out, `${values.test}.looks.json`);
		const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
		const signers = values["signed-by"].split(",").map((s) => s.trim());
		const records = state ? loadRecords(out, values.test) : [];
		let result = null;
		const problems = [];
		if (state) {
			const set = loadAnchors(resolve(values.anchors));
			if (state.anchors?.fingerprint !== set.fingerprint) problems.push(`the gate scored anchors ${state.anchors?.version ?? "none"}, not ${set.version}`);
			problems.push(...anchorProblems(set.manifest, resolve(values["tasks-dir"])).map((p) => `anchor ${p}`));
			const pinPath = pinPathFor(resolve(values["tasks-dir"]), state.candidate.split("@")[1]);
			const pinned = existsSync(pinPath) ? loadPin(pinPath) : null;
			if (!pinned) problems.push(`no graders are pinned for ${state.candidate.split("@")[1]} (${pinPath})`);
			try {
				result = regate({ state, records, anchors: { version: set.version, fingerprint: set.fingerprint, ids: set.ids }, pinned });
			} catch (error) {
				problems.push(error.message);
			}
		}
		problems.push(...writeProblems({ state, result, records, ledger, signers, chainStart: values["chain-start"], follows: values.follows ?? null }));
		if (problems.length) {
			for (const p of problems) console.error(p);
			console.error(`nothing was written to ${ledgerPath}`);
			process.exit(1);
		}
		const next = appendEntry(ledger, entryFor({ state, result, records, signers, chainStart: values["chain-start"], follows: values.follows ?? null }));
		writeFileSync(ledgerPath, `${JSON.stringify(next, null, 2)}\n`);
		const e = next.entries.at(-1);
		console.log(`${ledgerPath}: entry ${e.seq}, ${e.release} over ${e.champion}, anchors ${f(e.anchors.difference)} points (${f(e.anchors.low)} to ${f(e.anchors.high)}), signed by ${signers.join(", ")}`);
	} else {
		throw new Error("usage: node scripts/ledger.mjs write|trend|verify (see the top of this file)");
	}
}
