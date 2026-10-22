// The gate's verdict, exactly as GATE.md fixes it: is the candidate Relay at least as good as the champion?
// Pure: records in, verdict out. runner/gate.mjs reads the records and prints it.
import { bootstrap } from "./analyze.mjs";

export const RULES = Object.freeze({
	/** Non-inferiority margin, in points of requirements met. */
	marginPoints: 5,
	costRatio: 1.05,
	timeRatio: 1.1,
	falseDonePoints: 5,
	minTasks: 20,
	minPerKind: 8,
});

export const EXIT = Object.freeze({ PASS: 0, BLOCK: 10, UNRESOLVED: 20 });

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

function sd(xs) {
	if (xs.length < 2) return 0;
	const m = mean(xs);
	return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
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

function difference(tasks, champion, candidate) {
	const diffs = tasks.map((t) => taskScore(candidate.get(t)) - taskScore(champion.get(t)));
	if (diffs.length < 2) return { tasks: diffs.length, difference: diffs[0] ?? null, low: null, high: null };
	return { tasks: diffs.length, difference: mean(diffs), ...bootstrap(diffs), sd: sd(diffs) };
}

/**
 * The verdict for one gate. `records` are run records (runner/run-one.mjs); `champion` and `candidate` are the two
 * arms' tool names, such as "relay@0.6.121" and "relay@0.6.122-beta.3".
 */
export function gate(records, { champion, candidate, rules = RULES }) {
	const champ = byTask(records, champion);
	const cand = byTask(records, candidate);
	const shared = [...cand.keys()].filter((t) => champ.has(t)).sort();
	const kindOf = new Map(records.map((r) => [r.task, r.taskKind ?? "unknown"]));

	const overall = difference(shared, champ, cand);
	const kinds = {};
	for (const kind of [...new Set(shared.map((t) => kindOf.get(t)))].sort()) {
		const ts = shared.filter((t) => kindOf.get(t) === kind);
		kinds[kind] = { ...difference(ts, champ, cand), judged: ts.length >= rules.minPerKind };
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
	/** The smallest mean difference this many paired tasks would show at 80% power and 95% confidence. */
	const detectable = shared.length >= 2 && overall.sd > 0 ? (1.96 + 0.84) * (overall.sd / Math.sqrt(shared.length)) : null;

	const measures = {
		tasks: shared.length,
		runs: { champion: runsOf(champ).length, candidate: runsOf(cand).length },
		difference: overall.difference,
		low: overall.low,
		high: overall.high,
		kinds,
		costRatio,
		timeRatio,
		falseDone: { champion: falseDone(champ), candidate: falseDone(cand), difference: falseDoneDiff },
		detectablePoints: detectable,
	};
	const verdict = (status, reason, label) => ({ status, label, reason, exitCode: EXIT[status], champion, candidate, rules, ...measures });

	if (shared.length < rules.minTasks) {
		return verdict("UNRESOLVED", `only ${shared.length} tasks have a grade for both; the gate needs ${rules.minTasks}`, "too few tasks");
	}
	if (overall.high < 0) return verdict("BLOCK", `worse: the whole interval is below zero`, "worse");
	for (const [kind, k] of Object.entries(kinds)) {
		if (k.judged && k.high !== null && k.high < -rules.marginPoints) {
			return verdict("BLOCK", `worse on ${kind} tasks: the whole interval is below -${rules.marginPoints}`, `worse on ${kind} tasks`);
		}
	}
	if (costRatio !== null && costRatio > rules.costRatio) {
		return verdict("BLOCK", `costs ${((costRatio - 1) * 100).toFixed(1)}% more; the limit is ${((rules.costRatio - 1) * 100).toFixed(0)}%`, "costs more");
	}
	if (timeRatio !== null && timeRatio > rules.timeRatio) {
		return verdict("BLOCK", `takes ${((timeRatio - 1) * 100).toFixed(1)}% longer; the limit is ${((rules.timeRatio - 1) * 100).toFixed(0)}%`, "slower");
	}
	if (falseDoneDiff > rules.falseDonePoints) {
		return verdict("BLOCK", `says "done" wrongly ${falseDoneDiff.toFixed(1)} points more often; the limit is ${rules.falseDonePoints}`, 'more false "done"');
	}
	if (overall.low > 0) return verdict("PASS", "better: the whole interval is above zero", "better");
	if (overall.low > -rules.marginPoints) return verdict("PASS", `no worse: the interval stays above -${rules.marginPoints}`, "no worse");
	return verdict("UNRESOLVED", `can't rule out a drop of more than ${rules.marginPoints} points; more tasks or runs are needed`, "not enough evidence");
}
