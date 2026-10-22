// The bar (RUNBOOK.md, "The bar: five tools on the exam") as one JSON file for the website: numbers only. Every number
// comes from runner/analyze.mjs, the round's own analysis: the task is the unit, each comparison is Relay minus the other
// tool over the tasks both ran, with PREREGISTRATION.md's 95% interval (a bootstrap over tasks, 10,000 resamples, seed
// 20261015). It differs from the round-1 export in two ways, both on purpose:
// - no words: no "better", "worse" or "no clear difference" field, only the difference and its interval;
// - no task names: the exam is sealed (TIERS.md), so runs not made and tasks dropped are counted, never listed.
import { analyze, RESAMPLES, SEED } from "../runner/analyze.mjs";

/** The Relay release the bar measures; the runbook's commands use the same arm. */
export const BAR_RELAY = "relay@0.6.121";

/** The bar's stages, as the runbook runs them. `sample` is the spot check's fixed draw of exam tasks. */
export const BAR_STAGES = Object.freeze([
	{ id: "bar-1-haiku", title: "The exam, Claude Haiku 5.5", model: "claude-haiku-5-5", provider: "anthropic", tools: ["relay", "claude-code", "prime-agent", "hermes"] },
	{ id: "bar-1-openai", title: "The exam, GPT-6 Luna", model: "gpt-6-luna", provider: "openai", tools: ["relay", "codex"] },
	{ id: "bar-1-sonnet", title: "Spot check, 100 exam tasks, Claude Sonnet 5.5", model: "claude-sonnet-5-5", provider: "anthropic", tools: ["relay", "claude-code", "prime-agent"], sample: 100 },
]);

const NAMES = { "claude-code": "Claude Code", "prime-agent": "Prime Agent", hermes: "Hermes", codex: "Codex" };
const nameOf = (tool, relay) => (tool === relay ? `Relay ${relay.split("@")[1] ?? ""}`.trim() : (NAMES[tool] ?? tool));
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

/** How many runs a stage's plan called for that have no record: over the tasks it has records for, every tool, every rep. */
function runsNotMade(records, tools, reps) {
	const tasks = new Set(records.map((r) => r.task));
	const have = new Set(records.map((r) => `${r.task}|${r.tool}|${r.rep}`));
	let missing = 0;
	for (let rep = 1; rep <= reps; rep++) for (const task of tasks) for (const tool of tools) if (!have.has(`${task}|${tool}|${rep}`)) missing++;
	return missing;
}

/** One stage's numbers, in the page's shape. */
export function stageResult(stage, records, { relay = BAR_RELAY, reps = 1 } = {}) {
	const tools = stage.tools.map((t) => (t === "relay" ? relay : t));
	const result = analyze(records, { relay });
	const notMade = runsNotMade(records, tools, reps);
	const out = {
		id: stage.id,
		title: stage.title,
		model: stage.model,
		provider: stage.provider,
		measure: "requirements met",
		measureNote: "The share of a task's parts the hidden judge passes; an exam task drafted from one issue has one part, so this is the share solved.",
		unit: "task",
		status: records.length === 0 ? "not run yet" : notMade === 0 ? "complete" : "in progress",
		tasks: new Set(records.map((r) => r.task)).size,
		runs: records.length,
		runsNotMade: notMade,
		...(stage.sample ? { sample: stage.sample } : {}),
		spentUsd: sum(records.map((r) => r.usage?.costUsd ?? 0)),
		tools: {},
		comparisons: {},
	};
	for (const tool of tools) {
		const s = result.toolSummary[tool];
		out.tools[tool] = {
			name: nameOf(tool, relay),
			tasks: s?.tasks ?? 0,
			runs: s?.runs ?? 0,
			score: s?.score ?? null,
			allRunsPass: s?.allRunsPass ?? null,
			saidDoneButFailed: s?.saidDoneButFailed ?? null,
			costUsd: s?.costUsd ?? 0,
			costPerSolvedUsd: s?.costPerSolvedUsd ?? null,
			medianMinutes: s?.medianMinutes ?? null,
		};
	}
	for (const [tool, c] of Object.entries(result.comparisons)) {
		out.comparisons[tool] = { name: nameOf(tool, relay), tasks: c.tasks, difference: c.difference, low: c.low, high: c.high };
	}
	return out;
}

/** The whole bar: every stage, the statistics and what each number means; no task contents, no words. */
export function barResults(recordsByStage, { relay = BAR_RELAY, generatedAt = new Date().toISOString(), commit = null, repository = "https://github.com/cicada0007/relay-bench" } = {}) {
	const stages = BAR_STAGES.map((stage) => stageResult(stage, recordsByStage[stage.id] ?? [], { relay }));
	return {
		bar: 1,
		generatedAt,
		status: stages.every((s) => s.status === "complete") ? "complete" : stages.every((s) => s.status === "not run yet") ? "not run yet" : "in progress",
		repository,
		commit,
		relay,
		tiers: `${repository}/blob/main/TIERS.md`,
		preregistration: `${repository}/blob/main/PREREGISTRATION.md`,
		statistics: {
			unit: "The task. A tool's score on a task is its mean over that task's runs.",
			comparison: `The mean over tasks both tools ran of (${nameOf(relay, relay)}'s score minus the other tool's score), in points.`,
			interval: `95% percentile bootstrap over tasks, ${RESAMPLES} resamples, seed ${SEED}.`,
		},
		measures: {
			score: "Requirements met, percent: the share of a task's parts the hidden judge passes.",
			allRunsPass: "The share of tasks where every run succeeded, percent.",
			saidDoneButFailed: "The share of runs where the tool reported success and the judge failed it, percent.",
			costPerSolvedUsd: "Metered cost divided by runs that met every part.",
			medianMinutes: "Median wall time of a run.",
		},
		sameModel: "Each stage runs every tool on the same model, tasks and limits. Codex runs on an OpenAI model, so its stage runs Relay on that same model.",
		stages,
	};
}
