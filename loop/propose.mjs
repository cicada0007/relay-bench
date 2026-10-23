// Propose: from the clusters, changes to Relay, one lane each, every one a diff a reviewer can read.
//
// - Rules lanes (config, routing, memory, architecture) change relay.arch values from the loop's own table below: one
//   step at a time, inside fixed bounds, and only when a cluster or a measured gap calls for it. A value Relay reads
//   from relay.arch ("Set here", D-91) is changed in relay.arch.json; a value the generator reads from code is changed
//   in that code too when it is a plain constant, and otherwise the proposal names the code that holds it.
// - Writer lanes (prompts and skills, tools) have a model write the change to one prompt's text: paid, so they wait
//   for a cap. The loop applies what it writes to the champion's source itself, keeps only a change inside that
//   prompt's declaration, and refuses one that names anything from a practice task (it would learn the task, not the
//   skill).
// - The exam lane proposes kinds of task the exam should mine more of, into the exam's approval queue. A task the loop
//   picked would be one it has seen, so it never proposes a task itself, and it never approves anything.
// Every proposal is checked against its lane and the invariants (loop/lanes.mjs) before it is kept.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { changedPaths, getPath, serializeLike, setPath, unifiedDiff, under } from "./diff.mjs";
import { codeHome, LANE_ORDER, LANES, proposalProblems, SET_HERE, symbolSpan } from "./lanes.mjs";
import { WRITER_MAX_TOKENS, worstCostUsd } from "./writer.mjs";

/**
 * The rules lanes' table: which clusters move which relay.arch value, by one step, within bounds. `step` returns the
 * new value, or null when the value is already at its bound.
 */
export const RULES = Object.freeze([
	{
		id: "request-check-once-more",
		lane: "config",
		symptoms: ["false-done"],
		path: "queue.requestCheck.maxChecks",
		step: (v) => (Number.isInteger(v) && v < 4 ? v + 1 : null),
		words: "check a claim of done against the request once more before the task is verified (D-75)",
		expect: "fewer runs that say they are done while requirements are unmet",
	},
	{
		id: "stuck-one-turn-later",
		lane: "config",
		symptoms: ["stuck"],
		path: "queue.stuck",
		step: (v) => (v && Number.isInteger(v.idleTurns) && v.idleTurns < 8 ? { ...v, idleTurns: v.idleTurns + 1, repeatedActions: Math.min(8, (v.repeatedActions ?? 3) + 1) } : null),
		words: "wait one more turn before a session is called stuck (D-17, D-43)",
		expect: "fewer tasks stopped as stuck that would have finished",
	},
	{
		id: "third-attempt",
		lane: "config",
		symptoms: ["parked-after-retries"],
		path: "queue.maxAttempts",
		step: (v) => (Number.isInteger(v) && v < 3 ? v + 1 : null),
		words: "give a task whose checks failed on both attempts a third one (D-11)",
		expect: "fewer tasks parked after failing their checks",
	},
	{
		id: "more-turns",
		lane: "config",
		symptoms: ["budget-turns"],
		path: "budgets.turnsPerAttempt",
		step: (v) => (Number.isInteger(v) && v < 200 ? Math.min(200, Math.ceil((v * 1.25) / 10) * 10) : null),
		words: "a quarter more turns per attempt (D-08)",
		expect: "fewer attempts that end because their turns ran out",
	},
	{
		id: "smaller-plans",
		lane: "config",
		symptoms: ["merge-conflict"],
		path: "queue.plan.maxTasks",
		step: (v) => (Number.isInteger(v) && v > 4 ? Math.max(4, v - 2) : null),
		words: "plan a request into at most two fewer tasks (D-47), so fewer branches have to merge",
		expect: "fewer runs whose task branches conflict",
	},
	{
		id: "one-level-deeper",
		lane: "architecture",
		symptoms: ["timeout"],
		kinds: ["long"],
		path: "subAgents.maxDepth",
		step: (v, arch) => {
			const ceiling = arch?.budgets?.releaseCeilings?.maxSubagentDepth;
			const bound = Math.min(4, Number.isFinite(ceiling) ? ceiling : 4);
			return Number.isInteger(v) && v < bound ? v + 1 : null;
		},
		words: "let sub-agents nest one level deeper, so a long request is split into more parts that run side by side",
		expect: "fewer long requests that run out of time",
	},
	{
		id: "children-on-fast",
		lane: "architecture",
		symptoms: ["spend-cap"],
		path: "subAgents.childTier",
		step: (v) => (v === "strong" ? "fast" : null),
		words: "run a child agent on the fast tier when its parent names none (D-60)",
		expect: "fewer runs that reach their spend cap",
	},
]);

/** Which prompt a writer lane edits for a symptom (relay.arch prompt ids). */
export const PROMPT_FOR = Object.freeze({
	"false-done": "queue.requestCheck",
	unmet: "queue.plan",
	regression: "queue.attempt",
	"gate-failed": "queue.retry",
	blocked: "queue.blockedRetry",
	"no-plan": "queue.plan",
	stuck: "queue.handoff",
	"scope-failed": "queue.attempt",
	unsolved: "tool.ipython",
});

/** The risk of one change: low for a limit moved one step in relay.arch, medium for what a model is told, which model
 *  works or a value held in code, high for how Relay is put together. */
export function riskOf(p) {
	if (p.lane === "architecture") return p.change?.path === "topology" ? "high" : "medium";
	if (p.lane === "config") return p.change?.setHere ? "low" : "medium";
	return "medium";
}

const RISK_ORDER = ["low", "medium", "high"];
export const maxRisk = (risks) => risks.reduce((a, b) => (RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a), "low");

const fmt = (v) => (typeof v === "object" ? JSON.stringify(v) : String(v));

/** A plain constant's value changed in its source: `export const NAME = 12;` -> the new number. Null when the
 *  declaration is not a plain number. */
export function constantPatch(source, file, symbol, value) {
	if (!Number.isInteger(value)) return null;
	const re = new RegExp(`^(export\\s+const\\s+${symbol}\\s*(?::[^=]+)?=\\s*)(\\d+)(\\s*;?\\s*)$`, "m");
	const matches = source.match(new RegExp(re.source, "gm"));
	if (!matches || matches.length !== 1) return null;
	const after = source.replace(re, (_, a, _n, c) => `${a}${value}${c}`);
	return unifiedDiff(source, after, { path: file });
}

/**
 * One rules-lane proposal from a change to relay.arch: the relay.arch.json diff, plus the code's when the value lives
 * in a plain constant the loop can read (`sources(file)` returns the champion's text, or null).
 */
export function archProposal({ cycle, lane, rule, path, value, arch, archText, sources = () => null, clusters = [], evidence = {}, words, expect }) {
	const from = getPath(arch, path);
	const after = setPath(arch, path, value);
	const patches = [unifiedDiff(archText, serializeLike(after, archText), { path: "relay.arch.json" })];
	const setHere = SET_HERE.some((p) => under(path, p));
	const home = setHere ? null : codeHome(path);
	let code = null;
	if (home) {
		const source = sources(home.file);
		const codePatch = typeof source === "string" && typeof value === "number" ? constantPatch(source, home.file, home.symbol, value) : null;
		if (codePatch) patches.push(codePatch);
		code = { file: home.file, symbol: home.symbol, patched: Boolean(codePatch) };
	}
	const p = {
		id: `${cycle}-${lane}-${rule}`,
		lane,
		rule,
		title: `${LANES[lane].label}: ${path} ${fmt(from)} → ${fmt(value)}`,
		words,
		expect,
		change: { kind: "arch", path, from, to: value, setHere, code },
		clusters: clusters.map((c) => c.id),
		evidence,
		patch: patches.join(""),
		touches: { arch: changedPaths(arch, after), files: ["relay.arch.json", ...(code?.patched ? [code.file] : [])] },
		after,
		apply: applySteps({ setHere, code }),
		costUsd: 0,
	};
	p.risk = riskOf(p);
	return p;
}

function applySteps({ setHere, code }) {
	if (setHere) return ["git apply <this patch>", "npm run arch (writes relay.arch's new version and hash, and compiles the value in)"];
	if (code?.patched) return ["git apply <this patch>", "npm run arch (the generator reads the new value from the code)"];
	return [`change ${code?.file ?? "the code"} ${code?.symbol ?? ""} to the new value by hand`.trim(), "git apply <this patch> for relay.arch.json", "npm run arch -- --check (fails until the code holds the new value)"];
}

/**
 * The rules lanes' candidates, from the clusters and the measured gaps. Returns { candidates, notes }: notes say why a
 * rule that matched proposed nothing (already at its bound, not in this relay.arch).
 */
export function ruleCandidates({ cycle, analysis, arch, archText, settings, sources = () => null }) {
	const candidates = [];
	const notes = [];
	const on = (lane) => settings.lanes?.[lane]?.enabled !== false && (settings.lanes?.[lane]?.proposals ?? 0) > 0;
	for (const rule of RULES) {
		if (!on(rule.lane)) continue;
		const hits = analysis.clusters.filter((c) => rule.symptoms.includes(c.symptom) && (!rule.kinds || rule.kinds.includes(c.kind)));
		if (!hits.length) continue;
		const from = getPath(arch, rule.path);
		if (from === undefined) {
			notes.push(`${rule.id}: this relay.arch has no ${rule.path}`);
			continue;
		}
		const value = rule.step(from, arch);
		if (value === null) {
			notes.push(`${rule.id}: ${rule.path} is already at the loop's bound (${fmt(from)})`);
			continue;
		}
		const runs = hits.reduce((s, c) => s + c.runs, 0);
		const tasks = new Set(hits.flatMap((c) => c.tasks)).size;
		candidates.push({ ...archProposal({ cycle, lane: rule.lane, rule: rule.id, path: rule.path, value, arch, archText, sources, clusters: hits, evidence: { runs, tasks }, words: rule.words, expect: rule.expect }), weight: runs });
	}

	// Routing: a row of the suitability table that sends tasks to the fast tier, measured against the strong tier on
	// runs of one queue task (where the run's grade is the task's).
	const { minSamples = 5, gapPoints = 15 } = settings.routing ?? {};
	if (on("routing")) {
		const rows = Object.values(analysis.routes ?? {});
		const strong = rows.filter((r) => r.tier === "strong");
		const strongTasks = strong.reduce((s, r) => s + r.tasks, 0);
		const strongMean = strongTasks ? strong.reduce((s, r) => s + r.meanShare * r.tasks, 0) / strongTasks : null;
		for (const r of rows.filter((x) => x.tier === "fast" && x.tasks >= minSamples)) {
			if (strongTasks < minSamples || strongMean === null) break;
			const gap = 100 * (strongMean - r.meanShare);
			if (gap < gapPoints) continue;
			const table = arch.routing?.suitability ?? [];
			const index = table.findIndex((row) => row.id === r.row);
			if (index === -1 || table[index].tier !== "fast") {
				notes.push(`route-to-strong: row ${r.row} is not a fast row of this relay.arch's table`);
				continue;
			}
			const value = table.map((row, i) => (i === index ? { ...row, tier: "strong" } : row));
			const evidence = { row: r.row, fastTasks: r.tasks, fastMeanPoints: 100 * r.meanShare, strongTasks, strongMeanPoints: 100 * strongMean, gapPoints: gap };
			candidates.push({
				...archProposal({ cycle, lane: "routing", rule: `route-${r.row}-to-strong`, path: "routing.suitability", value, arch, archText, sources, evidence, words: `send the table's ${r.row} row to the strong tier: its tasks met ${(100 * r.meanShare).toFixed(1)} points on fast against ${(100 * strongMean).toFixed(1)} on strong (D-46)`, expect: `the ${r.row} row's tasks meet more requirements, at a higher cost per task` }),
				weight: r.tasks,
			});
		}
	}

	// Memory: the standing learning ablation's arms (TEAM-15). Without both arms measured there is nothing to go on.
	if (on("memory")) {
		const a = analysis.learning ?? {};
		const every = getPath(arch, "memory.autoRefine.everyTurns");
		if (!a.on || !a.off || a.on.tasks < minSamples || a.off.tasks < minSamples) {
			notes.push("memory: the learning ablation has not measured both arms (it is off unless a person turns it on, TEAM-15)");
		} else if (Number.isInteger(every)) {
			const lift = 100 * (a.on.meanShare - a.off.meanShare);
			const value = lift <= -gapPoints ? Math.min(100, every * 2) : lift >= gapPoints ? Math.max(10, Math.round(every / 2)) : null;
			if (value !== null && value !== every) {
				const auto = { ...getPath(arch, "memory.autoRefine"), everyTurns: value };
				candidates.push({
					...archProposal({ cycle, lane: "memory", rule: lift < 0 ? "refine-less-often" : "refine-more-often", path: "memory.autoRefine", value: auto, arch, archText, sources, evidence: { onTasks: a.on.tasks, onMeanPoints: 100 * a.on.meanShare, offTasks: a.off.tasks, offMeanPoints: 100 * a.off.meanShare, liftPoints: lift }, words: `refine every ${value} turns, not ${every}: tasks with learning on met ${lift.toFixed(1)} points against learning off`, expect: "the ablation's gap closes in learning's favour" }),
					weight: a.on.tasks + a.off.tasks,
				});
			}
		}
	}
	return { candidates, notes };
}

/** What a writer lane would write this cycle: one target per prompt, from the largest cluster that names it. */
export function writerTargets({ analysis, arch, settings }) {
	const targets = new Map();
	for (const c of analysis.clusters) {
		const id = PROMPT_FOR[c.symptom];
		if (!id) continue;
		const lane = id.startsWith("tool.") ? "tools" : "prompts";
		if (!c.lanes.includes(lane)) continue;
		if (settings.lanes?.[lane]?.enabled === false || (settings.lanes?.[lane]?.proposals ?? 0) < 1) continue;
		const prompt = (arch?.prompts ?? []).find((p) => p.id === id);
		if (!prompt) continue;
		const key = `${lane}|${id}`;
		const t = targets.get(key) ?? { lane, prompt, clusters: [] };
		t.clusters.push(c);
		targets.set(key, t);
	}
	return [...targets.values()].sort((a, b) => b.clusters.reduce((s, c) => s + c.runs, 0) - a.clusters.reduce((s, c) => s + c.runs, 0));
}

const WRITER_SYSTEM = [
	"You improve one prompt of Relay, a harness that runs coding agents on people's repositories.",
	"You are shown where Relay's runs fail, the prompt's purpose, and the prompt's source code.",
	"Write the smallest change to the prompt's words that would answer the failures in general: one idea, a sentence or two.",
	"Change only the text of the prompt's declaration. Keep its code, structure and interpolations as they are.",
	"Never name a task, a project, a file, a function or an example from the failures: write a rule any repository would need.",
	"Answer with one unified diff in git's format against the file as shown, with paths from the repository root, and nothing else.",
].join("\n");

/** The writer's input for one target, with the prompt's declaration and the lines around it numbered as in the file. */
export function writerInput({ target, source }) {
	const span = symbolSpan(source, target.prompt.symbol);
	const lines = source.split("\n");
	const [from, to] = span ?? [1, Math.min(lines.length, 200)];
	const shown = lines.slice(Math.max(0, from - 4), Math.min(lines.length, to + 3));
	const failures = target.clusters
		.map((c) => `- ${c.words}: ${c.runs} runs on ${c.tasks.length} tasks (${c.kind})${c.notes.length ? `\n  the judge's notes, for the shape of the failures only:\n${c.notes.map((n) => `    ${n}`).join("\n")}` : ""}`)
		.join("\n");
	const prompt = [
		`Failures on tasks Relay may study:\n${failures}`,
		`The prompt: ${target.prompt.id}: ${target.prompt.words}`,
		`It is ${target.prompt.symbol} in ${target.prompt.file}, lines ${from} to ${to}. The file, from line ${Math.max(1, from - 3)}:`,
		"```",
		shown.join("\n"),
		"```",
	].join("\n\n");
	return { system: WRITER_SYSTEM, prompt, span, worstUsd: (model) => worstCostUsd({ model, inputChars: WRITER_SYSTEM.length + prompt.length, maxTokens: WRITER_MAX_TOKENS }) };
}

/** The diff in a model's answer: the first fenced block or the whole text, from its first `diff --git` or `--- a/`. */
export function extractDiff(text) {
	const fenced = /```(?:diff|patch)?\n([\s\S]*?)```/.exec(text);
	const body = fenced ? fenced[1] : text;
	const at = body.search(/^(diff --git |--- a\/)/m);
	if (at === -1) return null;
	let diff = body.slice(at);
	if (!diff.startsWith("diff --git ")) {
		const m = /^--- a\/(\S+)/.exec(diff);
		if (m) diff = `diff --git a/${m[1]} b/${m[1]}\n${diff}`;
	}
	return diff.endsWith("\n") ? diff : `${diff}\n`;
}

/** The file after a patch, applied with git outside any repository; null when it does not apply. */
export function applyToText(file, source, patch) {
	const dir = mkdtempSync(join(tmpdir(), "loop-apply-"));
	try {
		mkdirSync(join(dir, dirname(file)), { recursive: true });
		writeFileSync(join(dir, file), source);
		writeFileSync(join(dir, "change.patch"), patch);
		const r = spawnSync("git", ["apply", "--recount", "--unidiff-zero", "--whitespace=nowarn", "change.patch"], { cwd: dir, encoding: "utf8" });
		if (r.status !== 0) return null;
		return readFileSync(join(dir, file), "utf8");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Names from the failures' notes that a change added: a sign it learned a task, not a skill. */
export function overfitProblems({ added, source, clusters }) {
	const code = /\b[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*\b|\b[A-Za-z0-9]*_[A-Za-z0-9_]+\b|\b[A-Z][A-Z0-9]{2,}\b/g;
	const named = new Set();
	for (const c of clusters) {
		for (const t of c.tasks) if (added.includes(t)) named.add(t);
		for (const n of c.notes) for (const m of n.match(code) ?? []) if (!source.includes(m) && added.includes(m)) named.add(m);
	}
	return [...named].map((n) => `the change names "${n}", from a practice task's failures`);
}

/**
 * One writer-lane proposal: the model writes, the loop applies it to the champion's source and keeps the change as
 * its own diff. Returns { proposal } or { refused: [why], costUsd }.
 */
export async function writeProposal({ cycle, target, source, writer, arch }) {
	const input = writerInput({ target, source });
	const answer = await writer.write({ system: input.system, prompt: input.prompt });
	const cost = answer.costUsd ?? 0;
	const why = [];
	if (answer.refused) why.push("the writer declined");
	if (answer.truncated) why.push("the writer's answer was cut off at its limit");
	const diff = why.length ? null : extractDiff(answer.text ?? "");
	if (!why.length && !diff) why.push("the writer's answer holds no diff");
	const after = diff ? applyToText(target.prompt.file, source, diff) : null;
	if (diff && after === null) why.push(`the writer's diff does not apply to ${target.prompt.file} at the champion`);
	if (after !== null && after === source) why.push("the writer's diff changes nothing");
	if (why.length) return { refused: why, costUsd: cost };
	const patch = unifiedDiff(source, after, { path: target.prompt.file });
	const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
	const p = {
		id: `${cycle}-${target.lane}-${target.prompt.id}`,
		lane: target.lane,
		rule: `write-${target.prompt.id}`,
		title: `${LANES[target.lane].label}: ${target.prompt.id} (${target.prompt.symbol})`,
		words: `rewrite part of ${target.prompt.id}, ${target.prompt.words.replace(/\.$/, "").toLowerCase()}, for: ${target.clusters.map((c) => c.words).join("; ")}`,
		expect: `fewer runs with ${target.clusters.map((c) => c.symptom).join(", ")}`,
		change: { kind: "source", file: target.prompt.file, symbol: target.prompt.symbol, prompt: target.prompt.id, writer: answer.model ?? writer.model ?? null },
		clusters: target.clusters.map((c) => c.id),
		evidence: { runs: target.clusters.reduce((s, c) => s + c.runs, 0), tasks: new Set(target.clusters.flatMap((c) => c.tasks)).size },
		patch,
		touches: { arch: [], files: [target.prompt.file] },
		apply: ["git apply <this patch>", "npm run arch (records the prompt's new hash and relay.arch's new version)"],
		costUsd: cost,
	};
	p.risk = riskOf(p);
	const problems = [...proposalProblems(p, { arch, sources: { [target.prompt.file]: source } }), ...overfitProblems({ added, source, clusters: target.clusters })];
	if (problems.length) return { refused: problems, costUsd: cost, proposal: p };
	return { proposal: p };
}

const LANGUAGE_OF = { python3: "python", python: "python", node: "javascript", nodejs: "javascript" };

/**
 * The exam lane: kinds of task the exam should mine more of, one per language and kind with a cluster behind it. Each
 * goes to the exam's approval queue for a person; none is approved, and none names a task.
 */
export function examProposals({ cycle, analysis, settings }) {
	const limit = settings.lanes?.exam?.enabled === false ? 0 : (settings.lanes?.exam?.proposals ?? 0);
	const wanted = new Map();
	for (const c of analysis.clusters) {
		if (c.kind === "public" || !c.lanes.length) continue;
		for (const stack of c.stacks) {
			const language = LANGUAGE_OF[stack];
			if (!language) continue;
			const key = `${language}|${c.kind}`;
			const w = wanted.get(key) ?? { language, kind: c.kind, clusters: [], runs: 0 };
			w.clusters.push(c.id);
			w.runs += c.runs;
			wanted.set(key, w);
		}
	}
	return [...wanted.values()]
		.sort((a, b) => b.runs - a.runs || a.language.localeCompare(b.language))
		.slice(0, limit)
		.map((w) => ({
			id: `${cycle}-exam-${w.language}-${w.kind}`,
			lane: "exam",
			proposedBy: "relay-loop",
			cycle,
			wanted: { language: w.language, kind: w.kind, minLevel: w.kind === "long" ? 2 : 1 },
			mineArgs: ["--languages", w.language],
			why: `practice runs fail on ${w.kind} ${w.language} tasks (${w.runs} failing runs across ${w.clusters.length} clusters); the exam should be able to see a change there`,
			clusters: w.clusters,
			status: "waiting for a person",
			approvedBy: null,
		}));
}

/** Why an exam proposal cannot be queued; empty when it can. The loop proposes only: it never approves, never drafts. */
export function examProposalProblems(p) {
	const problems = [];
	if (p.lane !== "exam") problems.push("not an exam proposal");
	if (p.approvedBy != null || p.approvedAt != null) problems.push("the loop never approves an exam task; a person does (scripts/approve-task.mjs)");
	if (p.tier || p.task || p.source?.pr || p.source?.issue) problems.push("the loop proposes kinds of task to mine, never a task it has seen");
	if (p.status !== "waiting for a person") problems.push("an exam proposal waits for a person");
	return problems;
}

/**
 * Checks every candidate and keeps, per lane, the settings' number of them, heaviest evidence first. Returns
 * { proposals, refused: [{ id, lane, title, problems }], held: [ids kept back by the lane's limit] }.
 */
export function selectProposals(candidates, { settings, arch, sources = () => null }) {
	const proposals = [];
	const refused = [];
	const held = [];
	for (const lane of LANE_ORDER) {
		const limit = settings.lanes?.[lane]?.enabled === false ? 0 : (settings.lanes?.[lane]?.proposals ?? 0);
		const mine = candidates.filter((c) => c.lane === lane).sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.id.localeCompare(b.id));
		for (const c of mine) {
			const files = c.touches?.files ?? [];
			const texts = Object.fromEntries(files.filter((f) => f !== "relay.arch.json").map((f) => [f, sources(f)]));
			const problems = proposalProblems(c, { arch, sources: texts });
			if (problems.length) refused.push({ id: c.id, lane, title: c.title, problems });
			else if (proposals.filter((p) => p.lane === lane).length < limit) proposals.push(c);
			else held.push(c.id);
		}
	}
	return { proposals, refused, held };
}
