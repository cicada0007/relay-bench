#!/usr/bin/env node
// Harness watch: a new Claude Code or Codex is tried on the exam the week it comes out, as model watch
// (scripts/model-watch.mjs) does for a new model.
//
// Each check reads the latest published version of each harness the benchmark runs beside Relay from the npm registry
// (one free, read-only request per package: @anthropic-ai/claude-code and @openai/codex, their `latest` tag) and
// compares it with the version the benchmark pins (harbor-agents/relay_bench_agents.py, the same as
// sandbox/template.mjs) and the versions the scoreboard already shows (results/scoreboard.json). For a version newer
// than the pin that the scoreboard does not show and no earlier check queued, it plans one exam stage: the bar's stage
// that harness runs in (scripts/export-bar.mjs BAR_STAGES: Claude Code in "The exam, Claude Haiku 5.5", Codex in "The
// exam, GPT-6 Luna"), with that stage's model, tasks, repetitions, caps, run-at-once count and Relay, and the new
// version as `<tool>@<version>` (runner/arms.mjs installs it over the image's own at the start of each run). The stage
// has its own name, `<stage>-<tool>-<version>`, so its spend counts against its own stage cap, and its records go
// beside the bar's, where the scoreboard reads them.
//
// The plan is queued for a person, one line in <exam>/queue/harness-watch.jsonl, with the smoke run and the command
// that start it and the most they could cost. Nothing paid runs here, ever: a person starts the stage. Each check also
// gives one plain line per harness for the week's notes.
//
//   node scripts/harness-watch.mjs [--exam ../relay-exam] [--scoreboard results/scoreboard.json] [--week 2026-W44] \
//     [--registry https://registry.npmjs.org] [--dry-run] [--json]
//
// --dry-run reads the registry and prints the plan, and queues nothing. The weekly job (loop/autopilot.mjs) runs the
// same check once a week: its lines go into the cycle's notes and the week's report.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isoWeek } from "../loop/cycle.mjs";
import { TOOL_PACKAGES, TOOL_VERSION_PATTERN } from "../runner/arms.mjs";
import { selectTasks } from "../runner/stage-tasks.mjs";
import { BAR_RELAY, BAR_STAGES } from "./export-bar.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
export const REGISTRY = "https://registry.npmjs.org";
export const QUEUE_FILE = "harness-watch.jsonl";

/**
 * The harnesses watched: the npm package, the constant that pins it in the Harbor agents and the key in the image's
 * pins (sandbox/template.mjs PINS), and the bar's stage a new version is tried in.
 */
export const WATCHED = Object.freeze([
	{ tool: "claude-code", name: "Claude Code", npm: TOOL_PACKAGES["claude-code"].npm, agentsPin: "CLAUDE_CODE_VERSION", imagePin: "claudeCode", stage: "bar-1-haiku" },
	{ tool: "codex", name: "Codex", npm: TOOL_PACKAGES.codex.npm, agentsPin: "CODEX_VERSION", imagePin: "codex", stage: "bar-1-openai" },
]);

const readJsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const money = (x) => `$${x.toFixed(2)}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso) => {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? null : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/**
 * The bar stage, harness and version a harness watch stage's name gives (`bar-1-haiku-claude-code-2.1.310`), or null:
 * the scoreboard reads such a stage beside the bar's own.
 */
export function harnessStageOf(test) {
	const m = /^(.+)-(claude-code|codex)-(\d+\.\d+\.\d+)$/.exec(String(test ?? ""));
	const stage = m ? BAR_STAGES.find((s) => s.id === m[1]) : null;
	return stage ? { stage, tool: m[2], version: m[3] } : null;
}

/** -1, 0 or 1: `a` against `b`, two x.y.z versions. */
export function compareVersions(a, b) {
	const x = String(a).split(".").map(Number);
	const y = String(b).split(".").map(Number);
	for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
	return 0;
}

/** The versions the benchmark pins: the Harbor agents' constants and the image's, read from their files. */
export function pinnedVersions(root = ROOT) {
	const agents = readFileSync(join(root, "harbor-agents", "relay_bench_agents.py"), "utf8");
	const image = readFileSync(join(root, "sandbox", "template.mjs"), "utf8");
	const out = {};
	for (const w of WATCHED) {
		out[w.tool] = {
			agents: new RegExp(`^${w.agentsPin} = "([^"]+)"`, "m").exec(agents)?.[1] ?? null,
			image: new RegExp(`^\\s*${w.imagePin}: "([^"]+)"`, "m").exec(image)?.[1] ?? null,
		};
	}
	return out;
}

/**
 * The versions of `tool` the scoreboard shows: from an entry's id (`claude-code@2.1.310`) or the version in its name
 * ("Claude Code 2.1.300", the version Harbor recorded).
 */
export function scoreboardVersions(board, tool) {
	const found = new Set();
	const name = WATCHED.find((w) => w.tool === tool)?.name;
	for (const b of board?.benchmarks ?? []) {
		for (const run of b.runs ?? []) {
			for (const e of run.entries ?? []) {
				const [base, version] = String(e.id ?? "").split("@");
				if (base !== tool) continue;
				if (version && TOOL_VERSION_PATTERN.test(version)) found.add(version);
				const named = name && String(e.name ?? "").startsWith(`${name} `) ? String(e.name).slice(name.length + 1) : null;
				if (named && TOOL_VERSION_PATTERN.test(named)) found.add(named);
			}
		}
	}
	return [...found].sort(compareVersions);
}

/**
 * The latest published version of an npm package and when it was published: `dist-tags.latest` and `time[latest]` of
 * its registry document. `fetch` is the one network call; tests pass a fake. Returns { version, publishedAt } or
 * { error }.
 */
export async function latestPublished(npm, { fetch = globalThis.fetch, registry = REGISTRY } = {}) {
	if (typeof fetch !== "function") return { error: "no way to read the npm registry was given" };
	const url = `${registry}/${npm.replace("/", "%2f")}`;
	try {
		const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
		if (!res.ok) return { error: `the registry answered ${res.status} for ${npm}` };
		const doc = await res.json();
		const version = doc?.["dist-tags"]?.latest;
		if (!TOOL_VERSION_PATTERN.test(version ?? "")) return { error: `the registry's latest ${npm} is ${JSON.stringify(version ?? null)}, not a version` };
		return { version, publishedAt: doc.time?.[version] ?? null };
	} catch (error) {
		return { error: `the registry could not be read for ${npm} (${error instanceof Error ? error.message : String(error)})` };
	}
}

/** The exam's folder as the commands name it: `../relay-exam` for a folder beside this one (the commands run from here), else its full path. */
const shown = (path) => (/^\.\.\/[^/]+$/.test(relative(ROOT, path)) ? relative(ROOT, path) : path);

/**
 * The exam stage for one new version: the bar's stage the harness runs in, with the new version in its place beside
 * the bar's Relay, under its own name. `examTasks` is how many exam tasks it would run (null when the exam is not here).
 */
export function planStage({ watched, version, examDir, examTasks = null, relay = BAR_RELAY }) {
	const stage = BAR_STAGES.find((s) => s.id === watched.stage);
	if (!stage?.run) throw new Error(`no bar stage ${watched.stage} with its run settings in scripts/export-bar.mjs`);
	const arm = `${watched.tool}@${version}`;
	const test = `${stage.id}-${watched.tool}-${version}`;
	const tools = [relay, arm];
	const exam = shown(resolve(examDir));
	const { reps, capUsd, stageCapUsd, e2bCapUsd, concurrency } = stage.run;
	const args = [
		"--test", test,
		"--model", stage.model,
		"--tools", tools.join(","),
		"--tasks", "tier:exam",
		"--tasks-dir", `${exam}/tasks`,
		...(stage.sample ? ["--sample", String(stage.sample)] : []),
		"--reps", String(reps),
		"--cap-usd", String(capUsd),
		"--stage-cap-usd", String(stageCapUsd),
		"--e2b-cap-usd", String(e2bCapUsd),
		"--concurrency", String(concurrency),
		"--out", `${exam}/runs/bar`,
	];
	const tasks = examTasks === null ? null : stage.sample ? Math.min(stage.sample, examTasks) : examTasks;
	const runs = tasks === null ? null : tasks * tools.length * reps;
	// The dev smoke the runbook asks for before a tool's counted runs, about $0.10: it finishes, and its traffic is metered.
	const smoke = ["--task", "smoke-add", "--tasks-dir", "dev-tasks", "--tool", arm, "--model", stage.model, "--cap-usd", "0.2", "--test", "dev", "--out", "runs/dev"];
	return {
		id: arm,
		tool: watched.tool,
		name: watched.name,
		version,
		test,
		from: stage.id,
		fromTitle: stage.title,
		model: stage.model,
		tools,
		tasks,
		runs,
		reps,
		capUsd,
		stageCapUsd,
		e2bCapUsd,
		mostUsd: runs === null ? stageCapUsd : Math.min(stageCapUsd, runs * capUsd),
		mostSandboxUsd: e2bCapUsd,
		smoke: { script: "runner/run-one.mjs", args: smoke, command: `node runner/run-one.mjs ${smoke.join(" ")}`, mostUsd: 0.2 },
		stage: { script: "runner/run-stage.mjs", args, command: `node runner/run-stage.mjs ${args.join(" ")}`, dryRun: `node runner/run-stage.mjs ${args.join(" ")} --dry-run` },
	};
}

/** How far a queued stage got: its runs and tasks in the bar's records, read from the exam (free). */
export function stageProgress(entry, { examDir }) {
	const rows = readJsonl(join(resolve(examDir), "runs", "bar", "records.jsonl")).filter((r) => r.test === entry.test);
	return { runs: rows.length, tasks: new Set(rows.map((r) => r.task)).size, planned: entry.runs ?? null };
}

/** A queued version in a few words, for the release's lines: numbers only. */
export function triedWords(entry, progress) {
	const what = `${entry.name} ${entry.version}`;
	if (!progress?.runs) return `${what} (its exam stage is queued for a person)`;
	return `${what} (its exam stage has ${progress.runs}${progress.planned ? ` of ${progress.planned}` : ""} runs, on ${progress.tasks} tasks)`;
}

/**
 * One check. Reads each watched harness's latest version (`fetch`), compares it with the pins, the scoreboard and the
 * queue, and queues an exam stage for each new version unless `write` is false. Returns { week, checkedAt, tools,
 * queued, lines, problems, queuePath }: `tools` one row per harness, `queued` the stages queued by this check, `lines`
 * one plain line per harness for the week's notes.
 */
export async function watchHarnesses({ fetch = globalThis.fetch, registry = REGISTRY, root = ROOT, scoreboardPath = join(root, "results", "scoreboard.json"), examDir = join(root, "..", "relay-exam"), week = isoWeek(), now = new Date(), write = true } = {}) {
	const pins = pinnedVersions(root);
	const board = existsSync(scoreboardPath) ? JSON.parse(readFileSync(scoreboardPath, "utf8")) : null;
	const exam = resolve(examDir);
	const queueDir = join(exam, "queue");
	const queuePath = join(queueDir, QUEUE_FILE);
	const examHere = existsSync(exam);
	const tasksDir = join(exam, "tasks");
	const examTasks = existsSync(tasksDir) ? selectTasks("tier:exam", tasksDir).length : null;
	const earlier = readJsonl(queuePath);
	const problems = [];
	const tools = [];
	const queued = [];
	const lines = [];
	for (const w of WATCHED) {
		const pin = pins[w.tool];
		if (pin.agents !== pin.image) problems.push(`${w.name} is pinned at ${pin.agents ?? "nothing"} in harbor-agents/relay_bench_agents.py and at ${pin.image ?? "nothing"} in sandbox/template.mjs; they should be the same`);
		const pinned = pin.agents ?? pin.image;
		const onBoard = scoreboardVersions(board, w.tool);
		const latest = await latestPublished(w.npm, { fetch, registry });
		const row = { tool: w.tool, name: w.name, npm: w.npm, pinned, onScoreboard: onBoard, latest: latest.version ?? null, publishedAt: latest.publishedAt ?? null };
		const came = latest.publishedAt && day(latest.publishedAt) ? ` came out on ${day(latest.publishedAt)}` : " is out";
		if (latest.error) {
			tools.push({ ...row, status: "unread", why: latest.error });
			lines.push(`${w.name}: ${latest.error}, so its latest version was not checked this week`);
			continue;
		}
		if (pinned && compareVersions(latest.version, pinned) <= 0) {
			tools.push({ ...row, status: "pinned" });
			lines.push(`${w.name}: ${latest.version} is the latest published version${latest.version === pinned ? " and the one the benchmark pins" : `, and the benchmark pins ${pinned}`}; nothing new`);
			continue;
		}
		if (onBoard.includes(latest.version)) {
			tools.push({ ...row, status: "on the scoreboard" });
			lines.push(`${w.name}: ${latest.version} is the latest published version, and the scoreboard shows it already`);
			continue;
		}
		const before = earlier.find((e) => e.id === `${w.tool}@${latest.version}`);
		if (before) {
			const progress = stageProgress(before, { examDir: exam });
			tools.push({ ...row, status: "queued earlier", entry: before.id, test: before.test, progress });
			lines.push(`${w.name} ${latest.version}${came}; its exam stage ${before.test} was queued in ${before.week} and ${progress.runs ? `has ${progress.runs} runs on ${progress.tasks} tasks` : "waits for a person"}`);
			continue;
		}
		const plan = planStage({ watched: w, version: latest.version, examDir: exam, examTasks });
		const entry = { ...plan, week, queuedAt: now.toISOString(), publishedAt: latest.publishedAt, pinned, status: "waiting for a person" };
		const where = !write ? "planned (a dry run, so not queued)" : examHere ? "queued for a person" : `planned but not queued: there is no exam at ${exam}`;
		if (write && examHere) {
			mkdirSync(queueDir, { recursive: true });
			appendFileSync(queuePath, `${JSON.stringify(entry)}\n`);
			queued.push(entry);
		}
		tools.push({ ...row, status: write && examHere ? "queued" : "planned", entry: entry.id, test: entry.test, plan: entry });
		lines.push(`${w.name} ${latest.version}${came} (the benchmark pins ${pinned ?? "none"}): its exam stage ${entry.test} is ${where}, at most ${money(entry.mostUsd)} of model spend and ${money(entry.mostSandboxUsd)} of sandbox time; nothing ran`);
	}
	for (const p of problems) lines.push(p);
	return { week, checkedAt: now.toISOString(), tools, queued, lines, problems, queuePath: examHere ? queuePath : null };
}

/**
 * The harness versions a week tried for the first time: the stages this check queued, and an earlier week's stage that
 * has runs now and is not on the scoreboard yet, each with how far it got.
 */
export function triedThisWeek(result, { examDir, queuePath = result?.queuePath ?? null }) {
	const earlier = queuePath ? readJsonl(queuePath) : [];
	const out = [];
	for (const t of result?.tools ?? []) {
		const entry = t.status === "queued" ? t.plan : t.status === "queued earlier" && t.progress?.runs ? earlier.find((e) => e.id === t.entry) : null;
		if (entry) out.push({ id: entry.id, name: entry.name, version: entry.version, test: entry.test, words: triedWords(entry, stageProgress(entry, { examDir })) });
	}
	return out;
}

/** The check in words, for a person at a terminal. */
export function describeWatch(result) {
	const L = [`Harness watch, week ${result.week}:`];
	for (const line of result.lines) L.push(`  ${line}`);
	for (const t of result.tools.filter((x) => x.plan)) {
		L.push(`  ${t.name} ${t.latest}: first the smoke, about $0.20 at most: ${t.plan.smoke.command}`);
		L.push(`  then the stage${t.plan.runs === null ? "" : ` (${t.plan.runs} runs: ${t.plan.tasks} exam tasks × ${t.plan.tools.length} tools × ${t.plan.reps})`}: ${t.plan.stage.command}`);
		L.push(`  see it first, free: ${t.plan.stage.dryRun}`);
	}
	if (result.queuePath && result.queued.length) L.push(`  queued in ${result.queuePath}`);
	return L;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values } = parseArgs({
		options: {
			exam: { type: "string", default: join(ROOT, "..", "relay-exam") },
			scoreboard: { type: "string", default: join(ROOT, "results", "scoreboard.json") },
			week: { type: "string" },
			// Another npm registry (a mirror); the default is npm's own.
			registry: { type: "string", default: REGISTRY },
			"dry-run": { type: "boolean", default: false },
			json: { type: "boolean", default: false },
		},
	});
	const result = await watchHarnesses({ registry: values.registry.replace(/\/$/, ""), examDir: resolve(values.exam), scoreboardPath: resolve(values.scoreboard), week: values.week ?? isoWeek(), write: !values["dry-run"] });
	if (values.json) console.log(JSON.stringify(result, null, 2));
	else for (const line of describeWatch(result)) console.log(line);
	process.exitCode = result.tools.some((t) => t.status === "unread") || result.problems.length ? 1 : 0;
}
