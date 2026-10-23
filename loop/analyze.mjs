// Analyze: the loop's first step. It reads what Relay did on tasks the loop may study, finds the failures that repeat,
// and groups them into clusters, each with the lanes that could answer it.
//
// What it reads (TIERS.md: the improving agent sees practice tasks, public tasks and the check tier's one word):
// - run records of practice tasks (records.jsonl), with the queue report Relay wrote in each run (relay-state.tgz:
//   every queue task's route, attempts, outcomes and why it parked);
// - run records of public tasks (Terminal-Bench 2.1, test F's records.jsonl);
// - opt-in data from people's machines, later: nothing reads it yet.
// It never reads a run of an exam or check task: a records file holding one is refused, whole.
//
// A failure is a graded run of Relay that did not meet every requirement. Its symptoms come from the judge's result,
// the run record and the queue report. A cluster is one symptom on one kind of task, kept when it repeats on enough runs
// and enough different tasks (the loop's settings, "clusters"), so one odd task never steers the loop alone.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { armFor } from "../runner/arms.mjs";
import { SEALED } from "../runner/exposure.mjs";
import { flagsOf } from "../runner/safety.mjs";

/** What each symptom means, and the lanes that could answer it (the propose step's rules say how). */
export const SYMPTOMS = Object.freeze({
	"false-done": { words: "said it was done (or verified its own tasks), but the judge found requirements unmet", lanes: ["config", "prompts"] },
	unmet: { words: "requirements unmet, without claiming to be done", lanes: ["prompts"] },
	regression: { words: "broke what worked before (the judge's R0 failed)", lanes: ["prompts"] },
	"gate-failed": { words: "the repository's own checks failed on the result", lanes: ["prompts"] },
	timeout: { words: "ran out of time", lanes: ["architecture"] },
	"spend-cap": { words: "reached its spend cap", lanes: ["architecture"] },
	"no-plan": { words: "planned no tasks", lanes: ["prompts"] },
	"merge-conflict": { words: "its task branches did not merge cleanly", lanes: ["config"] },
	stuck: { words: "a queue task was stopped as stuck", lanes: ["config", "prompts"] },
	blocked: { words: "a queue task wrote BLOCKED.md", lanes: ["prompts"] },
	"parked-after-retries": { words: "a queue task's checks failed on every attempt and it parked", lanes: ["config"] },
	"budget-turns": { words: "a queue task used up its turns", lanes: ["config"] },
	"scope-failed": { words: "a queue task changed files outside its scope", lanes: ["prompts"] },
	unsolved: { words: "a public task not solved", lanes: ["tools"] },
	"safety-flag": { words: "a run carried a safety flag; a person looks at it, the loop proposes nothing", lanes: [] },
});

const PUBLIC_PREFIX = "terminal-bench/";

export const isPublicTask = (id) => typeof id === "string" && id.startsWith(PUBLIC_PREFIX);

/**
 * True when the record is a run of Relay (any released version, or the round's `relay`), not a pre-screen build, and
 * not a model watch arm, whose failures belong to the model it tried, not to Relay.
 */
export function isRelay(tool, only = null) {
	if (only) return tool === only;
	const resolved = armFor(tool);
	return resolved?.base === "relay" && !resolved.relayPackage && !resolved.override;
}

/** The run's share of requirements met, or null when our infrastructure lost it (no grade). */
export function shareOf(record) {
	if (isPublicTask(record.task)) {
		if (record.infra === true) return null;
		if (typeof record.solved === "boolean") return record.solved ? 1 : 0;
		return typeof record.reward === "number" ? record.reward : null;
	}
	return typeof record.score?.share === "number" ? record.score.share : null;
}

const readJsonl = (path) =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));

/**
 * Records from records.jsonl files, each marked with the file it came from. Refuses a file inside the exam's folder:
 * the loop reads practice and public runs only.
 */
export function readRecords(paths, { exam = null } = {}) {
	const out = [];
	for (const p of paths) {
		const path = resolve(p);
		if (exam) {
			const rel = relative(resolve(exam), path);
			if (!rel.startsWith("..") && !isAbsolute(rel)) throw new Error(`${path} is inside the exam (${exam}); the loop reads practice and public runs only`);
		}
		if (!existsSync(path)) throw new Error(`no records file ${path}`);
		for (const r of readJsonl(path)) out.push({ ...r, _from: path });
	}
	return out;
}

/**
 * The records the loop may study, by the tier of each one's task. `tasks` maps a practice task id to its task.json.
 * A run of an exam or check task anywhere in them is refused, so a misplaced file never reaches the loop.
 */
export function studyable(records, tasks) {
	const sealed = records.filter((r) => SEALED.includes(tasks.get(r.task)?.tier));
	if (sealed.length) {
		throw new Error(`${sealed.length} run(s) of exam or check tasks (${[...new Set(sealed.map((r) => r.task))].slice(0, 3).join(", ")}); the loop never reads them`);
	}
	const kept = [];
	const unknown = new Set();
	for (const r of records) {
		if (isPublicTask(r.task) || tasks.has(r.task)) kept.push(r);
		else unknown.add(r.task);
	}
	return { kept, unknown: [...unknown].sort() };
}

/** The queue tasks Relay recorded in one run (relay-state.tgz beside the record), or null when there is no report. */
export function queueReport(record) {
	if (!record._from || !record.runId) return null;
	const tgz = join(dirname(record._from), record.runId, "relay-state.tgz");
	if (!existsSync(tgz)) return null;
	try {
		const entries = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n");
		const queue = entries.find((e) => /^supervisor\/local\/[^/]+\/queue\.json$/.test(e));
		if (!queue) return null;
		return JSON.parse(execFileSync("tar", ["-xzOf", tgz, queue], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).tasks ?? [];
	} catch {
		return null;
	}
}

/** The symptoms of one failing run, from its record and its queue tasks. */
export function symptomsOf(record, queueTasks = null) {
	const s = new Set();
	if (flagsOf(record).length) s.add("safety-flag");
	if (isPublicTask(record.task)) {
		if (record.stoppedAtCap) s.add("spend-cap");
		else if (record.exception === "AgentTimeoutError") s.add("timeout");
		else s.add("unsolved");
		return [...s];
	}
	const judge = record.judge ?? {};
	if (judge.R0 === false || record.score?.R0 === false) s.add("regression");
	if (record.saidDoneButFailed) s.add("false-done");
	else if (record.score?.R0 !== false) s.add("unmet");
	if (record.timedOut) s.add("timeout");
	if ((record.usage?.refusedAtCap ?? 0) > 0) s.add("spend-cap");
	if (record.relayMerge && record.relayMerge.planned === 0) s.add("no-plan");
	if (record.relayMerge?.conflicts?.length) s.add("merge-conflict");
	if (judge.gates && Object.values(judge.gates).some((g) => g === false)) s.add("gate-failed");
	for (const t of queueTasks ?? []) {
		const outcomes = (t.history ?? []).map((a) => a.outcome);
		if (outcomes.includes("stuck")) s.add("stuck");
		if (outcomes.includes("blocked")) s.add("blocked");
		if (outcomes.includes("scope_failed")) s.add("scope-failed");
		for (const a of t.history ?? []) {
			if (a.budget === "turns") s.add("budget-turns");
			if (a.budget === "time") s.add("timeout");
			if (a.budget === "spend") s.add("spend-cap");
		}
		if (t.status === "parked" && (t.attempts ?? 0) >= (t.maxAttempts ?? 2) && outcomes.at(-1) === "gate_failed") s.add("parked-after-retries");
	}
	return [...s];
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * The analysis. `records` are studyable records (above); `tasks` maps practice task ids to task.json; `queues` maps a
 * run id to its queue tasks (queueReport by default). `clusters` holds the thresholds { minRuns, minTasks }.
 */
export function analyze({ records, tasks = new Map(), queues = null, tool = null, clusters: thresholds = { minRuns: 3, minTasks: 2 } }) {
	const queueOf = (r) => (queues ? (queues.get(r.runId) ?? null) : queueReport(r));
	const relay = records.filter((r) => isRelay(r.tool, tool));
	const others = records.filter((r) => !isRelay(r.tool, tool) && armFor(r.tool)?.relayPackage !== true);
	const solvedByOther = new Set(others.filter((r) => shareOf(r) === 1).map((r) => r.task));
	const kindOf = (r) => (isPublicTask(r.task) ? "public" : (r.taskKind ?? tasks.get(r.task)?.kind ?? "unknown"));
	const stackOf = (id) => tasks.get(id)?.stack ?? (isPublicTask(id) ? ["terminal"] : []);

	const lost = relay.filter((r) => shareOf(r) === null);
	const graded = relay.filter((r) => shareOf(r) !== null);
	const failing = [];
	const queueCache = new Map();
	for (const r of graded) {
		const q = queueOf(r);
		queueCache.set(r.runId, q);
		if (shareOf(r) < 1) failing.push({ record: r, symptoms: symptomsOf(r, q) });
	}

	const groups = new Map();
	for (const f of failing) {
		for (const symptom of f.symptoms) {
			const key = `${symptom}|${kindOf(f.record)}`;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(f);
		}
	}
	const clusters = [];
	const below = [];
	for (const [key, fs] of groups) {
		const [symptom, kind] = key.split("|");
		const taskIds = [...new Set(fs.map((f) => f.record.task))].sort();
		const cluster = {
			id: `c-${symptom}-${kind}`,
			symptom,
			kind,
			words: SYMPTOMS[symptom]?.words ?? symptom,
			lanes: SYMPTOMS[symptom]?.lanes ?? [],
			runs: fs.length,
			tasks: taskIds,
			share: failing.length ? fs.length / failing.length : 0,
			solvedByAnotherTool: taskIds.filter((t) => solvedByOther.has(t)).length,
			stacks: [...new Set(taskIds.flatMap(stackOf))].sort(),
			meanShare: mean(fs.map((f) => shareOf(f.record))),
			examples: fs.slice(0, 3).map((f) => f.record.runId ?? `${f.record.task}|r${f.record.rep ?? "?"}`),
			notes: fs
				.flatMap((f) => Object.entries(f.record.judge?.notes ?? {}).filter(([k]) => /^R\d/.test(k)).map(([k, v]) => `${f.record.task} ${k}: ${String(v).slice(0, 240)}`))
				.slice(0, 5),
		};
		if (cluster.runs >= thresholds.minRuns && cluster.tasks.length >= thresholds.minTasks) clusters.push(cluster);
		else below.push({ id: cluster.id, runs: cluster.runs, tasks: cluster.tasks.length });
	}
	clusters.sort((a, b) => b.runs - a.runs || b.tasks.length - a.tasks.length || a.id.localeCompare(b.id));
	below.sort((a, b) => b.runs - a.runs || a.id.localeCompare(b.id));

	return {
		runs: relay.length,
		graded: graded.length,
		lost: lost.length,
		failing: failing.length,
		otherRuns: others.length,
		publicRuns: relay.filter((r) => isPublicTask(r.task)).length,
		withQueueReport: [...queueCache.values()].filter(Boolean).length,
		clusters,
		below,
		routes: routeStats(graded, queueCache),
		learning: learningStats(graded, queueCache),
	};
}

/**
 * How each route of the suitability table did, over runs whose plan held one queue task, where the judge's grade of
 * the run is the grade of that task. Keyed "<row>@<tier>": { tasks, meanShare, verified }.
 */
export function routeStats(records, queues) {
	const rows = {};
	for (const r of records) {
		const q = queues.get(r.runId);
		if (!q || q.length !== 1 || !q[0].route?.row) continue;
		const key = `${q[0].route.row}@${q[0].route.tier}`;
		rows[key] ??= { row: q[0].route.row, tier: q[0].route.tier, tasks: 0, shares: [], verified: 0 };
		rows[key].tasks++;
		rows[key].shares.push(shareOf(r));
		if (q[0].status === "verified") rows[key].verified++;
	}
	for (const v of Object.values(rows)) {
		v.meanShare = mean(v.shares);
		delete v.shares;
	}
	return rows;
}

/** The standing learning ablation's two arms (TEAM-15), over one-task runs: { on: {tasks, meanShare}, off: {...} }. */
export function learningStats(records, queues) {
	const arms = {};
	for (const r of records) {
		const q = queues.get(r.runId);
		if (!q || q.length !== 1 || !q[0].learningArm) continue;
		const arm = String(q[0].learningArm);
		arms[arm] ??= { tasks: 0, shares: [] };
		arms[arm].tasks++;
		arms[arm].shares.push(shareOf(r));
	}
	for (const v of Object.values(arms)) {
		v.meanShare = mean(v.shares);
		delete v.shares;
	}
	return arms;
}
