#!/usr/bin/env node
// The gate (GATE.md): is a new Relay at least as good as the current one?
//
// Read a gate that already ran:
//   node runner/gate.mjs --test gate-0.6.122 --champion 0.6.121 --candidate 0.6.122-beta.3 --out runs/gate
// Run it, then read it (paid: it spends up to --stage-cap-usd and --e2b-cap-usd, never more):
//   node runner/gate.mjs --run --test gate-0.6.122 --champion 0.6.121 --candidate 0.6.122-beta.3 \
//     --model claude-haiku-5-5 --tier practice --tasks kind:everyday,kind:long --reps 1 \
//     --cap-usd 1 --stage-cap-usd 40 --e2b-cap-usd 20 --out runs/gate
//
// Gate v2 (GATE.md, amendment 1):
//   --looks 3 --plan-tasks 120 [--spending obrien-fleming|pocock]
//                      a sequential gate: up to 3 looks at 40, 80 and 120 tasks, each with its own boundary, so looking
//                      early never raises the false-accept rate. With --run, each command runs the next look's tasks and
//                      reads it; the gate stops at the first PASS or BLOCK. The design is fixed at the first look.
//   --plan-tasks 120   with one look: the verdict waits until 120 tasks are graded, so a gate is never read early.
//   --anchors <file>   the anchor set scored with every release (runner/anchors.mjs); required for a counted exam gate.
//   --combined <file>  a combined candidate: { "release": "<candidate>", "lanes": [{ "lane": "...", "change": "..." }] },
//                      several lane changes judged as one release, once.
//   --candidate-package <tgz>
//                      the candidate is a local build (GATE.md, amendment 4): --candidate 0.6.122-loop.2026w44, the
//                      package's version, and every candidate run installs this tarball. Its SHA-256 is fixed at the
//                      first look; a look whose candidate runs installed anything else is UNRESOLVED ("build differs").
// On the exam and check tiers every look is counted against the leak budget (runner/exposure.mjs), and every run must
// have been graded by the judges pinned for the candidate (runner/pins.mjs; --run pins them at the first look).
//
// Model watch (scripts/model-watch.mjs): --candidate 0.6.121+all+claude-sonnet-6 judges the champion's release with a
// new model on a tier (or on every tier) against the champion as it is.
//
// --dry-run with --run lists the runs it would start and spends nothing.
// State: <out>/<test>.looks.json (the design, the task order, every look taken), <out>/<test>.gate.json (the last look).
// Exit codes: 0 PASS, 10 BLOCK, 20 UNRESOLVED (GATE.md).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadRecords, rng, SEED } from "./analyze.mjs";
import { anchorProblems, loadAnchors } from "./anchors.mjs";
import { isLocalBuild, parseModelArm, RELAY_VERSION_PATTERN } from "./arms.mjs";
import { budgetProblems, exposurePathFor, loadBudget, readExposures, recordExposure, SEALED } from "./exposure.mjs";
import { buildProblems, combinedProblems, designProblems, EXIT, FIXED_DESIGN, gate, lookSize, RULES, sharedTasks } from "./gate-analyze.mjs";
import { loadPin, makePin, pinFingerprint, pinPathFor, pinProblems, writePin } from "./pins.mjs";
import { readTasks, selectTasks } from "./stage-tasks.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

const { values: args } = parseArgs({
	options: {
		test: { type: "string" },
		champion: { type: "string" },
		candidate: { type: "string" },
		out: { type: "string", default: "runs/gate" },
		json: { type: "boolean", default: false },
		run: { type: "boolean", default: false },
		tier: { type: "string", default: "practice" },
		model: { type: "string" },
		// Practice: every everyday and long task. The exam or check tier: every task of that tier in --tasks-dir.
		tasks: { type: "string" },
		reps: { type: "string", default: "1" },
		"cap-usd": { type: "string" },
		"stage-cap-usd": { type: "string" },
		"e2b-cap-usd": { type: "string" },
		concurrency: { type: "string", default: "4" },
		"tasks-dir": { type: "string" },
		"dry-run": { type: "boolean", default: false },
		looks: { type: "string" },
		"plan-tasks": { type: "string" },
		spending: { type: "string" },
		anchors: { type: "string" },
		combined: { type: "string" },
		"candidate-package": { type: "string" },
	},
});
for (const name of ["test", "champion", "candidate"]) if (!args[name]) throw new Error(`--${name} is required`);
for (const name of ["champion", "candidate"]) {
	// Model watch: the candidate may be the champion's release with a new model on a tier, 0.6.121+all+claude-sonnet-6.
	// The autopilot: a local build with its package, 0.6.122-loop.2026w44 (amendment 4).
	const local = name === "candidate" && isLocalBuild(args[name]);
	if (!RELAY_VERSION_PATTERN.test(args[name]) && !(name === "candidate" && parseModelArm(args[name])) && !local) {
		throw new Error(`--${name} must be a released Relay version, such as 0.6.121${name === "candidate" ? ", one with a model on a tier, such as 0.6.121+all+claude-sonnet-6, or a local build with --candidate-package, such as 0.6.122-loop.2026w44" : ""}`);
	}
}
if (args["candidate-package"] && !isLocalBuild(args.candidate)) throw new Error(`--candidate-package is for a local build, such as 0.6.122-loop.2026w44, not ${args.candidate}`);
if (args.champion === args.candidate) throw new Error("--champion and --candidate are the same version");
const champion = `relay@${args.champion}`;
const candidate = `relay@${args.candidate}`;
const sealed = SEALED.includes(args.tier);
const counted = !/^(pilot|dev)/.test(args.test);
const out = resolve(ROOT, args.out);

/** TIERS.md: the exam's tasks never sit inside this public repository, so a gate on the exam refuses a folder in it. */
function tasksDir() {
	if (args.tier === "practice") return resolve(args["tasks-dir"] ?? join(ROOT, "tasks"));
	if (!sealed) throw new Error(`unknown --tier ${args.tier}; known: practice, check, exam`);
	if (!args["tasks-dir"]) throw new Error(`--tier ${args.tier} needs --tasks-dir, the private exam repository's tasks folder`);
	const dir = resolve(args["tasks-dir"]);
	const inside = relative(ROOT, dir);
	if (!inside.startsWith("..") && !isAbsolute(inside)) {
		throw new Error(`the ${args.tier} tasks must live outside this public repository; ${dir} is inside it`);
	}
	return dir;
}

const int = (name) => {
	const n = Number(args[name]);
	if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a whole number`);
	return n;
};

/** The design the command asks for, or null when it names none. */
function askedDesign() {
	if (!args.looks && !args["plan-tasks"] && !args.spending) return null;
	const looks = args.looks ? int("looks") : 1;
	if (looks === 1) {
		if (args.spending) throw new Error("--spending needs --looks 2 or more");
		return { ...FIXED_DESIGN, plannedTasks: args["plan-tasks"] ? int("plan-tasks") : null };
	}
	if (!args["plan-tasks"]) throw new Error("--looks needs --plan-tasks, the number of tasks the last look reads");
	const design = { spending: args.spending ?? "obrien-fleming", looks, plannedTasks: int("plan-tasks") };
	const problems = designProblems(design);
	if (problems.length) throw new Error(problems.join("; "));
	return design;
}

const statePath = join(out, `${args.test}.looks.json`);
const resultPath = join(out, `${args.test}.gate.json`);
const sameDesign = (a, b) => a.spending === b.spending && a.looks === b.looks && (a.plannedTasks ?? null) === (b.plannedTasks ?? null);
let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
const asked = askedDesign();
if (state) {
	if (state.champion !== champion || state.candidate !== candidate) {
		throw new Error(`${statePath} is a gate of ${state.candidate} against ${state.champion}, not of ${candidate} against ${champion}`);
	}
	if (asked && !sameDesign(asked, state.design)) {
		throw new Error(`this gate's design was fixed at its first look (${JSON.stringify(state.design)}); a design is never changed mid-gate`);
	}
} else {
	state = { test: args.test, champion, candidate, tier: args.tier, design: asked ?? FIXED_DESIGN, createdAt: new Date().toISOString(), order: null, looks: [], decided: null };
}
// A counted gate on the sealed tiers is read at planned looks only: otherwise reading it as runs finish would be looking
// many times without paying for it in alpha.
if (sealed && counted && state.design.plannedTasks == null && !args.run) {
	throw new Error(`a counted ${args.tier} gate fixes its planned tasks before its first look: --plan-tasks (and --looks for a sequential gate)`);
}

const dir = sealed || args.run || args.anchors ? tasksDir() : null;

let anchors = null;
if (args.anchors) {
	const loaded = loadAnchors(resolve(args.anchors));
	const problems = anchorProblems(loaded.manifest, dir);
	if (problems.length) throw new Error(`the anchor set ${loaded.version} no longer matches its tasks; make a new version:\n  ${problems.join("\n  ")}`);
	if (state.anchors && state.anchors.fingerprint !== loaded.fingerprint) throw new Error(`this gate scores the anchor set ${state.anchors.version}; it cannot change mid-gate`);
	anchors = { version: loaded.version, fingerprint: loaded.fingerprint, ids: loaded.ids };
	state.anchors = { version: loaded.version, fingerprint: loaded.fingerprint };
} else if (state.anchors) {
	throw new Error(`this gate scores the anchor set ${state.anchors.version}; pass it again with --anchors`);
}
if (args.tier === "exam" && counted && !anchors) throw new Error("a counted exam gate scores an anchor set with every release: --anchors <exam>/anchors/<version>.json");

let combined = null;
if (args.combined) {
	combined = JSON.parse(readFileSync(resolve(args.combined), "utf8"));
	const problems = combinedProblems(combined, args.candidate);
	if (problems.length) throw new Error(`the combined candidate cannot be judged as one release: ${problems.join("; ")}`);
	if (state.combined && JSON.stringify(state.combined) !== JSON.stringify(combined.lanes)) throw new Error("this gate's lane changes were fixed at its first look");
	state.combined = combined.lanes;
} else if (state.combined) {
	throw new Error("this gate judges a combined candidate; pass its manifest again with --combined");
}

// A local build: the package's hash is fixed at the first look, and a look reads only runs that installed it.
if (isLocalBuild(args.candidate)) {
	if (args["candidate-package"]) {
		const file = resolve(args["candidate-package"]);
		if (!existsSync(file)) throw new Error(`no package at ${file}`);
		const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
		if (state.candidatePackage && state.candidatePackage.sha256 !== sha256) {
			throw new Error(`this gate judges the build ${state.candidatePackage.sha256.slice(0, 12)}; ${file} is ${sha256.slice(0, 12)}, and a build never changes mid-gate`);
		}
		state.candidatePackage = { version: args.candidate, sha256 };
	} else if (!state.candidatePackage) throw new Error(`${args.candidate} is a local build: pass its package with --candidate-package`);
	else if (args.run) throw new Error("--run installs the local build in every candidate run: pass --candidate-package");
}

const saveState = () => {
	mkdirSync(out, { recursive: true });
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
};

/** The tasks in the order the looks take them: anchors first, then the rest in a shuffle seeded 20261015, fixed at the first run. */
function taskOrder() {
	const chosen = selectTasks(args.tasks ?? (args.tier === "practice" ? "kind:everyday,kind:long" : `tier:${args.tier}`), dir);
	const first = anchors ? anchors.ids : [];
	const known = readTasks(dir);
	const missing = first.filter((id) => !known.has(id));
	if (missing.length) throw new Error(`anchor tasks not in ${dir}: ${missing.join(", ")}`);
	const rest = chosen.filter((id) => !first.includes(id)).sort();
	const next = rng(SEED);
	for (let i = rest.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[rest[i], rest[j]] = [rest[j], rest[i]];
	}
	const order = [...first, ...rest];
	const planned = state.design.plannedTasks ?? order.length;
	if (planned > order.length) throw new Error(`the plan needs ${planned} tasks; only ${order.length} are chosen`);
	return order.slice(0, planned);
}

/** The candidate's pinned graders, on the sealed tiers: made at the first --run (not a dry run), read otherwise. */
const pinPath = sealed ? pinPathFor(dir, args.candidate) : null;

if (args.run) {
	if (state.decided) throw new Error(`this gate stopped at look ${state.decided.look} with ${state.decided.status} (${state.decided.label}); nothing was run`);
	for (const name of ["model", "cap-usd", "stage-cap-usd", "e2b-cap-usd"]) if (!args[name]) throw new Error(`--run needs --${name}`);
	if (sealed && !args["dry-run"] && !existsSync(pinPath)) {
		writePin(pinPath, makePin({ tasksDir: dir, release: args.candidate }));
		console.log(`pinned the graders for ${args.candidate}: ${pinPath}`);
	}
	if (!state.order) {
		state.order = taskOrder();
		if (state.design.plannedTasks == null) state.design = { ...state.design, plannedTasks: state.order.length };
	}
	const look = state.looks.length + 1;
	const ids = state.order.slice(0, lookSize(state.design, look));
	if (!args["dry-run"]) saveState();
	console.log(`look ${look}: ${ids.length} of ${state.order.length} planned tasks`);
	const stage = spawnSync(
		process.execPath,
		[
			join(ROOT, "runner/run-stage.mjs"),
			"--test", args.test,
			"--model", args.model,
			"--tools", `${champion},${candidate}`,
			"--tasks", ids.join(","),
			"--tasks-dir", dir,
			"--reps", args.reps,
			"--cap-usd", args["cap-usd"],
			"--stage-cap-usd", args["stage-cap-usd"],
			"--e2b-cap-usd", args["e2b-cap-usd"],
			"--concurrency", args.concurrency,
			"--out", out,
			...(args["candidate-package"] ? ["--relay-package", resolve(args["candidate-package"])] : []),
			...(args["dry-run"] ? ["--dry-run"] : []),
		],
		{ stdio: "inherit" },
	);
	if (args["dry-run"]) process.exit(stage.status ?? 1);
	if (stage.status !== 0) console.error(`the runs stopped (exit ${stage.status}); reading what finished`);
}

const design = state.design;
const f = (x, d = 1) => (x === null || x === undefined ? "–" : x.toFixed(d));

if (state.decided) {
	// A gate that stopped stays stopped: runs added later are not looked at.
	const result = JSON.parse(readFileSync(resultPath, "utf8"));
	if (args.json) console.log(JSON.stringify(result, null, 2));
	else console.log(`${result.status} · ${result.label}\nthis gate stopped at look ${state.decided.look} on ${state.decided.at.slice(0, 10)}; later runs are not counted`);
	process.exit(result.exitCode);
}

const records = loadRecords(out, args.test);
const shared = sharedTasks(records, champion, candidate);
const n = shared.length;
const last = state.looks.at(-1);
/** Looks are kept and alpha is spent only when the gate has a plan; a gate with none reads as before (practice only). */
const planned = design.plannedTasks != null || design.spending !== "fixed";
let index = state.looks.length + 1;
let history = state.looks.map((l) => l.fraction);
if (last && n < last.tasks) throw new Error(`look ${last.index} read ${last.tasks} tasks; only ${n} have a grade for both now, so records are missing`);
const again = Boolean(last && n === last.tasks);
if (again) {
	// The same look read again: nothing new, nothing spent.
	index = last.index;
	history = history.slice(0, -1);
}
const needed = lookSize(design, index);
if (planned && n < needed) {
	const waiting = {
		status: "UNRESOLVED",
		label: `waiting for look ${index}`,
		reason: `${n} of the ${needed} tasks look ${index} reads have a grade for both arms`,
		exitCode: EXIT.UNRESOLVED,
		final: false,
		continue: true,
		tasks: n,
		needed,
	};
	if (args.json) console.log(JSON.stringify(waiting, null, 2));
	else console.log(`${waiting.status} · ${waiting.label}\n${waiting.reason}`);
	process.exit(waiting.exitCode);
}

// The leak budget: this look is one read of every sealed task in it; runs past their budget are refused here too.
let exposure = null;
let reads = [];
if (sealed) {
	const tiers = readTasks(dir);
	const byTier = new Map();
	for (const id of shared) {
		const tier = tiers.get(id)?.tier;
		if (!SEALED.includes(tier)) continue;
		if (!byTier.has(tier)) byTier.set(tier, []);
		byTier.get(tier).push(id);
	}
	reads = [...byTier].map(([tier, tasks]) => ({ kind: "read", tier, tasks, key: `gate:${args.test}:look${index}:${tier}`, test: args.test, by: "gate" }));
	exposure = { problems: budgetProblems({ entries: readExposures(exposurePathFor(dir)), add: reads, budget: loadBudget(dir) }) };
}

let pin = null;
if (sealed && counted) {
	if (!existsSync(pinPath)) throw new Error(`no graders are pinned for ${args.candidate}; pin them before its gate: node scripts/pin-graders.mjs --release ${args.candidate} --tasks-dir ${dir}`);
	const pinned = loadPin(pinPath);
	const inLook = new Set(shared);
	pin = { release: pinned.release, fingerprint: pinFingerprint(pinned), problems: pinProblems(records.filter((r) => inLook.has(r.task)), pinned) };
}

const build = state.candidatePackage
	? { ...state.candidatePackage, problems: buildProblems(records.filter((r) => shared.includes(r.task)), candidate, state.candidatePackage) }
	: null;
const result = gate(records, { champion, candidate, design, history, anchors, combined, exposure, pin, build });
const refused = Boolean(result.exposure?.problems?.length || result.pin?.problems?.length || result.build?.problems?.length);
if (planned && result.look && !refused && !again) {
	for (const e of reads) recordExposure(exposurePathFor(dir), e);
	const at = new Date().toISOString();
	// The look's own tasks are kept, so the ledger can read the same look again from the records (scripts/ledger.mjs).
	state.looks.push({ index, tasks: n, taskSet: shared, fraction: result.look.fraction, z: result.look.z, spent: result.look.spent, status: result.status, label: result.label, at });
	if (result.final) state.decided = { status: result.status, label: result.label, look: index, at };
	saveState();
}
mkdirSync(out, { recursive: true });
writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);

if (args.json) {
	console.log(JSON.stringify(result, null, 2));
} else {
	console.log(`${result.status} · ${result.label}`);
	console.log(`${candidate} against ${champion}: ${result.reason}`);
	if (result.look && design.spending !== "fixed") {
		console.log(`  look ${result.look.index} of ${design.looks} (${design.spending}): ${n} of ${design.plannedTasks} tasks, boundary z ${f(result.look.z, 3)}, alpha spent ${f(100 * result.look.spent, 3)}% of ${f(100 * RULES.alpha, 1)}%`);
	}
	console.log(`  requirements met  ${f(result.difference)} points, interval ${f(result.low)} to ${f(result.high)}, over ${result.tasks} tasks`);
	for (const [kind, k] of Object.entries(result.kinds)) {
		console.log(`  ${kind.padEnd(16)}  ${f(k.difference)} points, ${f(k.low)} to ${f(k.high)}, ${k.tasks} tasks${k.judged ? "" : " (too few to judge alone)"}`);
	}
	if (result.anchors) {
		const a = result.anchors;
		console.log(`  anchors ${a.version}  ${f(a.champion)} and ${f(a.candidate)}: ${f(a.difference)} points, 95% interval ${f(a.low)} to ${f(a.high)}, ${a.tasks} of ${a.planned} tasks`);
	}
	if (result.combined) console.log(`  combined          ${result.combined.lanes.map((l) => `${l.lane} ${l.change}`).join(", ")}`);
	if (result.build) console.log(`  local build       ${result.build.version}, package ${result.build.sha256.slice(0, 12)}`);
	console.log(`  cost              ${result.costRatio === null ? "–" : `${f((result.costRatio - 1) * 100)}%`}`);
	console.log(`  time              ${result.timeRatio === null ? "–" : `${f((result.timeRatio - 1) * 100)}%`}`);
	console.log(`  false "done"      ${f(result.falseDone.candidate)}% against ${f(result.falseDone.champion)}%`);
	console.log(`  safety flags      ${result.safety.candidate.total} candidate runs, ${result.safety.champion.total} champion runs`);
	console.log(`  smallest change this look could see: ${result.detectablePoints === null ? "–" : `${f(result.detectablePoints)} points`}`);
}
process.exitCode = result.exitCode;
