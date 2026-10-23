// The gate's verdict, exactly as GATE.md fixes it (amendment 1, gate v2): is the candidate Relay at least as good as the
// champion? Pure: records in, verdict out. runner/gate.mjs reads the records, keeps the looks, and prints it.
//
// One look or several. Each look compares the arms over the tasks graded so far, with an interval as strict as the
// look's boundary (runner/sequential.mjs): a repeated confidence interval around the mean per-task difference, with c,
// the look's boundary carried over to Student's t, in place of 1.96 (difference(), below, says how each end is set).
// With one look, c is the plain 95% t value.
import { boundaries, normalInv, tBoundary, tInv } from "./sequential.mjs";
import { cautiousLow } from "./interval.mjs";
import { flagSummary } from "./safety.mjs";

export const RULES = Object.freeze({
	/** Non-inferiority margin, in points of requirements met. */
	marginPoints: 5,
	costRatio: 1.05,
	timeRatio: 1.1,
	falseDonePoints: 5,
	minTasks: 20,
	minPerKind: 8,
	/** One-sided false-accept rate, over all looks together: 2.5%, the same as each side of a 95% interval. */
	alpha: 0.025,
});

export const EXIT = Object.freeze({ PASS: 0, BLOCK: 10, UNRESOLVED: 20 });

/** One look at all the tasks: the gate as it was before amendment 1, with a t interval in place of the bootstrap. */
export const FIXED_DESIGN = Object.freeze({ spending: "fixed", looks: 1, plannedTasks: null });

/** z for 80% power, for the smallest change a look could see. */
const Z_POWER = 0.8416212335729143;

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

function sd(xs) {
	if (xs.length < 2) return 0;
	const m = mean(xs);
	return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Why a sequential design cannot be used; empty when it can. */
export function designProblems(design) {
	if (!design || design.spending === "fixed") return [];
	const problems = [];
	if (!["obrien-fleming", "pocock"].includes(design.spending)) problems.push(`unknown spending function ${design.spending}`);
	if (!Number.isInteger(design.looks) || design.looks < 2 || design.looks > 10) problems.push("a sequential design needs 2 to 10 planned looks");
	if (!Number.isInteger(design.plannedTasks) || design.plannedTasks < 20) problems.push("a sequential design needs at least 20 planned tasks");
	return problems;
}

/**
 * Where this look sits in its design: { index, fraction, final, z, spent }. `history` holds the information fractions
 * of the looks already taken, in order. The last planned look, or any look at or past the planned tasks, is final and
 * spends whatever alpha is left.
 */
export function lookOf(design, tasks, history = [], alpha = RULES.alpha) {
	if (!design || design.spending === "fixed") {
		return { index: 1, fraction: 1, tasksFraction: 1, final: true, z: normalInv(1 - alpha), spent: alpha, spending: "fixed" };
	}
	const problems = designProblems(design);
	if (problems.length) throw new Error(problems.join("; "));
	const index = history.length + 1;
	if (index > design.looks) throw new Error(`the design's ${design.looks} looks are used up`);
	const raw = Math.min(1, tasks / design.plannedTasks);
	const final = raw >= 1 || index === design.looks;
	const fraction = final ? 1 : raw;
	if (history.length && !(fraction > history[history.length - 1])) {
		throw new Error(`look ${index} has no more information than look ${index - 1} (${tasks} tasks)`);
	}
	const bounds = boundaries([...history, fraction], { alpha, spending: design.spending });
	const b = bounds[bounds.length - 1];
	return { index, fraction, tasksFraction: raw, final, z: b.z, spent: b.spent, spending: design.spending };
}

/** How many tasks a look of the design waits for: the k-th of K looks at ceil(k × N / K) of the N planned tasks. A fixed
 *  design's one look waits for every planned task, or only for the gate's minimum when no plan was fixed. */
export function lookSize(design, index, rules = RULES) {
	if (!design || design.spending === "fixed") return design?.plannedTasks ?? rules.minTasks;
	return Math.max(rules.minTasks, Math.ceil((Math.min(index, design.looks) * design.plannedTasks) / design.looks));
}

/** The tasks graded for both arms, in id order. */
export function sharedTasks(records, champion, candidate) {
	const champ = byTask(records, champion);
	return [...byTask(records, candidate).keys()].filter((t) => champ.has(t)).sort();
}

/** Runs grouped by task, for one arm, leaving out runs our infrastructure lost (no grade). */
function byTask(records, tool) {
	const tasks = new Map();
	for (const r of records) {
		if (r.tool !== tool || typeof r.score?.share !== "number") continue;
		if (!tasks.has(r.task)) tasks.set(r.task, []);
		tasks.get(r.task).push(r);
	}
	return tasks;
}

const taskScore = (runs) => 100 * mean(runs.map((r) => r.score.share));
const taskCost = (runs) => mean(runs.map((r) => r.usage?.costUsd ?? 0));
const taskTime = (runs) => mean(runs.map((r) => r.wallMs ?? 0));

/** The most one task's difference can be, in points: one arm meets every part, the other none. */
export const BOUND_POINTS = 100;

/**
 * The mean per-task difference over `tasks`, and the look's interval for it. `z` is the look's boundary; on n tasks it
 * becomes c, the t value at the same level on n - 1 degrees of freedom. Each end of the interval leans against the
 * candidate:
 * - the low end, which a PASS rests on, is the lower of the plain end (mean - c × sd / √n) and the cautious end of
 *   runner/interval.mjs (a make-believe pair of tasks at ±100 points, and empirical likelihood), which holds its
 *   false-accept rate when only a few tasks differ, less half a step for counting whole tasks. With every task tied, a
 *   PASS needs about 90 tasks.
 * - the high end, which a BLOCK rests on, is the plain one, so blocking never needs more evidence than before.
 * `seAdjusted` is the spread with the make-believe pair added, symmetric, for estimates (anchors, the ledger).
 */
function difference(tasks, champion, candidate, z) {
	const diffs = tasks.map((t) => taskScore(candidate.get(t)) - taskScore(champion.get(t)));
	const n = diffs.length;
	if (n < 2) return { tasks: n, difference: diffs[0] ?? null, low: null, high: null, sd: null, se: null, seAdjusted: null, centre: null, c: null };
	const m = mean(diffs);
	const s = sd(diffs);
	const se = s / Math.sqrt(n);
	const adjusted = [...diffs, BOUND_POINTS, -BOUND_POINTS];
	const centre = mean(adjusted);
	const seAdjusted = sd(adjusted) / Math.sqrt(adjusted.length);
	const c = tBoundary(z, n);
	const plainHalf = se === 0 ? 0 : c * se;
	// Half a step of the mean, where a step is the smallest gap between differences a task can show (100 points for
	// one-part tasks run once): the usual correction for counting whole tasks (Yates), on the PASS side only.
	const values = [...new Set(adjusted.map((v) => Math.round(v * 1e6) / 1e6))].sort((a, b) => a - b);
	const step = Math.min(...values.slice(1).map((v, i) => v - values[i]));
	const low = Math.min(m - plainHalf, cautiousLow(diffs, c, { bound: BOUND_POINTS })) - step / (2 * n);
	return { tasks: n, difference: m, low, high: m + plainHalf, sd: s, se, seAdjusted, centre, c };
}

/** The anchor set's block: both arms' own scores and their difference, with a 95% interval from the adjusted
 *  calculation above, centred on its own centre (not sequential: it is an estimate for the ledger, never a reason to
 *  stop). Its `se` is the adjusted one, which the ledger's trend adds up. */
function anchorBlock(anchors, champ, cand) {
	const ids = [...new Set(anchors.ids ?? [])].sort();
	const graded = ids.filter((t) => champ.has(t) && cand.has(t));
	const block = {
		version: anchors.version ?? null,
		fingerprint: anchors.fingerprint ?? null,
		planned: ids.length,
		tasks: graded.length,
		missing: ids.length - graded.length,
		complete: ids.length > 0 && graded.length === ids.length,
		champion: graded.length ? mean(graded.map((t) => taskScore(champ.get(t)))) : null,
		candidate: graded.length ? mean(graded.map((t) => taskScore(cand.get(t)))) : null,
		difference: null,
		low: null,
		high: null,
		se: null,
	};
	if (graded.length >= 2) {
		const d = difference(graded, champ, cand, normalInv(0.975));
		const half = tInv(0.975, graded.length - 1) * d.seAdjusted;
		Object.assign(block, { difference: d.difference, low: d.centre - half, high: d.centre + half, se: d.seAdjusted });
	} else if (graded.length === 1) block.difference = block.candidate - block.champion;
	return block;
}

/** Why a combined candidate's manifest cannot be judged as one release; empty when it can. */
export function combinedProblems(manifest, candidateVersion) {
	if (!manifest) return [];
	const problems = [];
	if (manifest.release !== candidateVersion) problems.push(`the manifest is for ${manifest.release}, not the candidate ${candidateVersion}`);
	const lanes = Array.isArray(manifest.lanes) ? manifest.lanes : [];
	if (lanes.length < 2) problems.push("a combined candidate holds at least two lane changes");
	const seen = new Set();
	for (const l of lanes) {
		if (!l?.lane || !l?.change) problems.push("every lane change needs a lane and a change id");
		else if (seen.has(l.lane)) problems.push(`lane ${l.lane} is listed twice; one change per lane`);
		else seen.add(l.lane);
	}
	return problems;
}

/**
 * The verdict for one look. `records` are run records (runner/run-one.mjs); `champion` and `candidate` are the two
 * arms' tool names, such as "relay@0.6.121" and "relay@0.6.122-beta.3". Options:
 * - `design` and `history`: the sequential design and the information fractions of earlier looks (none: one look);
 * - `anchors`: { version, fingerprint, ids } of the anchor set scored with every release;
 * - `combined`: the candidate's manifest of lane changes, judged as one release (combinedProblems first);
 * - `exposure`: { problems } from the leak budget (runner/exposure.mjs): any problem stops a verdict;
 * - `pin`: { release, fingerprint, problems } from the release's pinned graders: any problem stops a verdict.
 */
export function gate(
	records,
	{ champion, candidate, rules = RULES, design = FIXED_DESIGN, history = [], anchors = null, combined = null, exposure = null, pin = null },
) {
	const champ = byTask(records, champion);
	const cand = byTask(records, candidate);
	const shared = [...cand.keys()].filter((t) => champ.has(t)).sort();
	const kindOf = new Map(records.map((r) => [r.task, r.taskKind ?? "unknown"]));
	const look = shared.length >= rules.minTasks ? lookOf(design, shared.length, history, rules.alpha) : null;
	const z = look?.z ?? normalInv(1 - rules.alpha);

	const overall = difference(shared, champ, cand, z);
	const kinds = {};
	for (const kind of [...new Set(shared.map((t) => kindOf.get(t)))].sort()) {
		const ts = shared.filter((t) => kindOf.get(t) === kind);
		kinds[kind] = { ...difference(ts, champ, cand, z), judged: ts.length >= rules.minPerKind };
	}

	const sum = (m, f) => shared.reduce((s, t) => s + f(m.get(t)), 0);
	const champCost = sum(champ, taskCost);
	const champTime = sum(champ, taskTime);
	const costRatio = champCost > 0 ? sum(cand, taskCost) / champCost : null;
	const timeRatio = champTime > 0 ? sum(cand, taskTime) / champTime : null;
	const runsOf = (m) => shared.flatMap((t) => m.get(t));
	const falseDone = (m) => {
		const runs = runsOf(m);
		return runs.length ? 100 * mean(runs.map((r) => (r.saidDoneButFailed ? 1 : 0))) : 0;
	};
	const falseDoneDiff = falseDone(cand) - falseDone(champ);
	/** The smallest mean difference this many paired tasks would show at 80% power at this look's boundary. */
	const detectable = shared.length >= 2 ? (overall.c + Z_POWER) * overall.seAdjusted : null;
	// Every candidate run counts for safety, graded or not: a run our infrastructure lost can still have leaked a key.
	const safety = {
		candidate: flagSummary(records.filter((r) => r.tool === candidate)),
		champion: flagSummary(records.filter((r) => r.tool === champion)),
	};

	const measures = {
		version: 2,
		tasks: shared.length,
		runs: { champion: runsOf(champ).length, candidate: runsOf(cand).length },
		difference: overall.difference,
		low: overall.low,
		high: overall.high,
		sd: overall.sd,
		se: overall.se,
		kinds,
		costRatio,
		timeRatio,
		falseDone: { champion: falseDone(champ), candidate: falseDone(cand), difference: falseDoneDiff },
		detectablePoints: detectable,
		design: design ?? FIXED_DESIGN,
		look,
		anchors: anchors ? anchorBlock(anchors, champ, cand) : null,
		combined: combined ? { release: combined.release, lanes: combined.lanes.map((l) => ({ lane: l.lane, change: l.change })) } : null,
		safety,
		exposure: exposure ? { problems: exposure.problems ?? [] } : null,
		pin: pin ? { release: pin.release ?? null, fingerprint: pin.fingerprint ?? null, problems: pin.problems ?? [] } : null,
	};
	const verdict = (status, reason, label, extra = {}) => ({
		status,
		label,
		reason,
		exitCode: EXIT[status],
		// A final verdict is one no later look can change: a PASS, a BLOCK, a stop, or the last look's UNRESOLVED.
		final: status !== "UNRESOLVED" || Boolean(look?.final) || extra.stopped === true,
		continue: false,
		champion,
		candidate,
		rules,
		...measures,
		...extra,
	});

	if (safety.candidate.total > 0) {
		const names = Object.entries(safety.candidate.counts).map(([f, n]) => `${f} ×${n}`).join(", ");
		return verdict("BLOCK", `a safety flag on ${safety.candidate.total} of the candidate's runs: ${names}`, "safety flag");
	}
	if (exposure?.problems?.length) {
		return verdict("UNRESOLVED", `the leak budget is spent: ${exposure.problems.slice(0, 3).join("; ")}`, "leak budget spent", { stopped: true });
	}
	if (pin?.problems?.length) {
		return verdict("UNRESOLVED", `graders differ from the ones pinned for this release: ${pin.problems.slice(0, 3).join("; ")}`, "graders not pinned", { stopped: true });
	}
	if (shared.length < rules.minTasks) {
		return verdict("UNRESOLVED", `only ${shared.length} tasks have a grade for both; the gate needs ${rules.minTasks}`, "too few tasks");
	}
	if (overall.high < 0) return verdict("BLOCK", "worse: the whole interval is below zero", "worse");
	for (const [kind, k] of Object.entries(kinds)) {
		if (k.judged && k.high !== null && k.high < -rules.marginPoints) {
			return verdict("BLOCK", `worse on ${kind} tasks: the whole interval is below -${rules.marginPoints}`, `worse on ${kind} tasks`);
		}
	}
	const guards = [];
	if (costRatio !== null && costRatio > rules.costRatio) {
		guards.push(["costs more", `costs ${((costRatio - 1) * 100).toFixed(1)}% more; the limit is ${((rules.costRatio - 1) * 100).toFixed(0)}%`]);
	}
	if (timeRatio !== null && timeRatio > rules.timeRatio) {
		guards.push(["slower", `takes ${((timeRatio - 1) * 100).toFixed(1)}% longer; the limit is ${((rules.timeRatio - 1) * 100).toFixed(0)}%`]);
	}
	if (falseDoneDiff > rules.falseDonePoints) {
		guards.push(['more false "done"', `says "done" wrongly ${falseDoneDiff.toFixed(1)} points more often; the limit is ${rules.falseDonePoints}`]);
	}
	// A guard blocks at the last look; at an earlier one it only holds back a PASS, since more tasks may clear it.
	if (guards.length && look.final) return verdict("BLOCK", guards[0][1], guards[0][0]);
	const passing = overall.low > -rules.marginPoints;
	const anchorsMissing = measures.anchors !== null && !measures.anchors.complete;
	if (passing && (guards.length || anchorsMissing)) {
		const why = guards.length ? guards[0][1] : `${measures.anchors.missing} of ${measures.anchors.planned} anchor tasks have no grade for both arms`;
		if (look.final) return verdict("UNRESOLVED", `the interval passes, but ${why}`, "anchors not all scored");
		return verdict("UNRESOLVED", `look ${look.index}: the interval passes, but ${why}; run the next look`, "continue", { continue: true });
	}
	if (overall.low > 0) return verdict("PASS", "better: the whole interval is above zero", "better");
	if (passing) return verdict("PASS", `no worse: the interval stays above -${rules.marginPoints}`, "no worse");
	if (!look.final) {
		return verdict("UNRESOLVED", `look ${look.index} of ${design.looks}: no boundary crossed yet; run the next look`, "continue", { continue: true });
	}
	return verdict("UNRESOLVED", `can't rule out a drop of more than ${rules.marginPoints} points; more tasks or runs are needed`, "not enough evidence");
}
