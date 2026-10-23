#!/usr/bin/env node
// Model watch (relay-harness D-93): a new model in Relay's catalogue sits the exam before Relay's routing uses it.
//
// Given the new model, this plans the exam gate (GATE.md) with that model as the candidate arm against the champion
// configuration. The candidate is the champion's release with the new model on every tier (the benchmark runs Relay on
// one model) or on the one tier --tier names; the champion is the same release on its own model, the ledger's last
// release unless --champion says. Everything else is the gate's: the tasks, the anchors, the looks, the verdict rules,
// the leak budget and the pinned graders.
//
//   node scripts/model-watch.mjs --model anthropic/claude-sonnet-6 [--tier all|decider|strong|fast] \
//     [--exam ../relay-exam] [--anchors anchors-v1] [--champion 0.6.121 --champion-model claude-haiku-5-5] \
//     [--looks 3] [--plan-tasks 120] [--reps 1] [--cap-usd 2] [--e2b-cap-usd 20] \
//     [--relay-dir ~/.relay/agent | none] [--json] [--spend-cap 60]
//
// A DRY RUN BY DEFAULT. Without --spend-cap it prints the plan: both arms, the tasks, the runs of the next look, the
// most they could cost, and the gate command it would run; it spends nothing and writes nothing. --spend-cap <usd> runs
// the gate's next look (paid, never more than the cap on model spend, plus --e2b-cap-usd on sandboxes) and reads its
// verdict. A paid run is refused when the meter has no price for a model, since the meter is every run's spend cap.
//
// Once the gate has decided (PASS, BLOCK, or UNRESOLVED at its last look), it writes the result as a small hashed file:
// <exam>/runs/model-watch/<test>.exam.json and, for a gate on the exam, a copy where the harness reads it,
// <relay-dir>/model-watch/exams/ (default $RELAY_CODING_AGENT_DIR, else ~/.relay/agent; --relay-dir none skips it). The
// hash is SHA-256 of the file as canonical JSON without its own sha256; the harness refuses a file whose hash does not
// hold, and lets routing use the model only on a PASS. A gate still between looks writes nothing: run the same command
// again for the next look.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MODEL_ARM_TIERS, modelArm, providerOf, RELAY_VERSION_PATTERN } from "../runner/arms.mjs";
import { lookSize } from "../runner/gate-analyze.mjs";
import { meterPrices } from "../runner/meter-price.mjs";
import { selectTasks } from "../runner/stage-tasks.mjs";
import { canonical, readLedger } from "./ledger.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const GATE = "runner/gate.mjs";

/** The format of the file the harness reads (relay-harness core/model-watch.ts MODEL_EXAM_FORMAT). */
export const MODEL_EXAM_FORMAT = "relay-model-exam/1";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** SHA-256 of an exam result as canonical JSON, without its own sha256: what the harness checks. */
export function examHash(body) {
	const { sha256: _own, ...rest } = body;
	return sha256(canonical(rest));
}

/** `anthropic/claude-sonnet-6` from `anthropic/claude-sonnet-6` or `claude-sonnet-6`: the model as the harness names it. */
export function modelName(model) {
	const value = String(model ?? "").trim();
	const slash = value.indexOf("/");
	const id = slash === -1 ? value : value.slice(slash + 1);
	if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) throw new Error(`--model must be a model id such as anthropic/claude-sonnet-6, not ${model}`);
	const provider = slash === -1 ? providerOf(id) : value.slice(0, slash);
	return { name: `${provider}/${id}`, provider, id };
}

/** Where the harness reads exam results on this machine. */
export function defaultRelayDir(env = process.env) {
	const dir = env.RELAY_CODING_AGENT_DIR;
	return dir ? dir.replace(/^~(?=$|\/)/, homedir()) : join(homedir(), ".relay", "agent");
}

/** The file name of a model's result in the harness's folder: anthropic__claude-sonnet-6.json. */
export const resultFileName = (name) => `${name.replace(/[^A-Za-z0-9.-]+/g, "__")}.json`;

const insideRepo = (path) => {
	const rel = relative(ROOT, resolve(path));
	return !rel.startsWith("..") && !isAbsolute(rel);
};

/** The newest anchor set beside the exam's tasks, anchors-vN with the largest N, or null. */
function newestAnchors(examDir) {
	const dir = join(examDir, "anchors");
	if (!existsSync(dir)) return null;
	const versions = readdirSync(dir)
		.map((file) => /^anchors-v(\d+)\.json$/.exec(file))
		.filter(Boolean)
		.sort((a, b) => Number(b[1]) - Number(a[1]));
	return versions.length ? join(dir, versions[0][0]) : null;
}

const positive = (value, name, { integer = false } = {}) => {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) throw new Error(`--${name} must be a ${integer ? "whole " : ""}number above 0`);
	return n;
};

/**
 * The plan of the next look: both arms, the tasks, the design, the runs and what they could cost, the gate's command,
 * and why a paid run would be refused. Spends nothing and writes nothing.
 */
export function planModelWatch(options, { prices = meterPrices, ledgerPath } = {}) {
	const { name, provider, id } = modelName(options.model);
	const tier = options.tier ?? "all";
	if (!MODEL_ARM_TIERS.includes(tier)) throw new Error(`--tier must be one of ${MODEL_ARM_TIERS.join(", ")}`);
	const ledger = readLedger(ledgerPath);
	const last = ledger.entries.at(-1);
	const champion = options.champion ?? last?.release;
	if (!champion) throw new Error("the ledger has no release yet: name the champion with --champion <version> --champion-model <id>");
	if (!RELAY_VERSION_PATTERN.test(champion)) throw new Error(`--champion must be a released Relay version, such as 0.6.121, not ${champion}`);
	const fromLedger = options.champion === undefined || options.champion === last?.release;
	const championModel = options.championModel ?? (fromLedger && last?.model && !last.model.includes("+") ? last.model : undefined);
	if (!championModel) throw new Error(`name the model the champion runs on with --champion-model, such as claude-haiku-5-5`);
	if (championModel === id) throw new Error(`${id} is already the champion's model; there is nothing to examine`);
	const benchProvider = providerOf(id);
	if (providerOf(championModel) !== benchProvider) {
		throw new Error(`${id} is an ${benchProvider} model and the champion runs ${championModel}, an ${providerOf(championModel)} one: both arms of a run share one key, so examine it against a ${benchProvider} champion model`);
	}
	const testTier = options.examTier ?? "exam";
	const examDir = resolve(options.exam ?? join(ROOT, "..", "relay-exam"));
	if (insideRepo(examDir)) throw new Error(`the exam lives outside this public repository; ${examDir} is inside it`);
	const tasksDir = options.tasksDir ? resolve(options.tasksDir) : join(examDir, "tasks");
	if (!existsSync(tasksDir)) throw new Error(`no exam tasks at ${tasksDir}: check out the private exam beside this repository, or pass --exam`);
	const anchors = options.anchors
		? resolve(options.anchors.endsWith(".json") ? options.anchors : join(examDir, "anchors", `${options.anchors}.json`))
		: testTier === "exam"
			? newestAnchors(examDir)
			: null;
	if (testTier === "exam" && !anchors) throw new Error(`a gate on the exam scores an anchor set: make one with scripts/anchors.mjs, or pass --anchors`);
	if (anchors && !existsSync(anchors)) throw new Error(`no anchor set at ${anchors}`);
	const ids = selectTasks(`tier:${testTier}`, tasksDir);
	const looks = options.looks === undefined ? 3 : positive(options.looks, "looks", { integer: true });
	const plannedTasks = Math.min(options.planTasks === undefined ? 120 : positive(options.planTasks, "plan-tasks", { integer: true }), ids.length);
	if (plannedTasks < 20) throw new Error(`the ${testTier} has ${ids.length} tasks; the gate needs at least 20`);
	const design = looks === 1 ? { spending: "fixed", looks: 1, plannedTasks } : { spending: "obrien-fleming", looks, plannedTasks };
	const reps = options.reps === undefined ? 1 : positive(options.reps, "reps", { integer: true });
	const capUsd = options.capUsd === undefined ? 2 : positive(options.capUsd, "cap-usd");
	const e2bCapUsd = options.e2bCapUsd === undefined ? 20 : positive(options.e2bCapUsd, "e2b-cap-usd");
	const spendCap = options.spendCap === undefined || options.spendCap === null ? null : positive(options.spendCap, "spend-cap");
	const out = resolve(options.out ?? join(examDir, "runs", "model-watch"));
	if (insideRepo(out)) throw new Error(`the exam's runs are written outside this public repository; ${out} is inside it`);
	const candidateSpec = modelArm(champion, tier, id);
	const test = `model-${id}${tier === "all" ? "" : `-${tier}`}-on-${champion}`;
	const statePath = join(out, `${test}.looks.json`);
	const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
	const look = (state?.looks?.length ?? 0) + 1;
	const lookTasks = lookSize(design, look);
	const runs = lookTasks * 2 * reps;
	const worstUsd = runs * capUsd;
	const priced = prices([championModel, id]);
	const refusals = [];
	for (const model of [championModel, id]) {
		if (!priced[model]) refusals.push(`the meter has no price for ${model}, so it could not hold the runs to their spend cap; add its list price to PRICES in meter/meter.mjs first`);
	}
	if (state?.decided) refusals.push(`this gate already stopped at look ${state.decided.look} with ${state.decided.status} (${state.decided.label}); nothing more runs`);
	const gateArgs = [
		"--run",
		"--test", test,
		"--champion", champion,
		"--candidate", candidateSpec,
		"--model", championModel,
		"--tier", testTier,
		"--tasks-dir", tasksDir,
		...(anchors ? ["--anchors", anchors] : []),
		"--looks", String(design.looks),
		"--plan-tasks", String(design.plannedTasks),
		"--reps", String(reps),
		"--cap-usd", String(capUsd),
		"--stage-cap-usd", String(spendCap ?? Math.min(worstUsd, 1e9)),
		"--e2b-cap-usd", String(e2bCapUsd),
		"--out", out,
	];
	return {
		model: name,
		provider,
		id,
		tier,
		champion: { version: champion, model: championModel, arm: `relay@${champion}`, fromLedger },
		candidate: { arm: `relay@${candidateSpec}`, spec: candidateSpec },
		test,
		examTier: testTier,
		tasksDir,
		tasks: ids.length,
		anchors,
		design,
		look,
		lookTasks,
		reps,
		runs,
		capUsd,
		worstUsd,
		e2bCapUsd,
		spendCap,
		prices: { [championModel]: priced[championModel] ?? null, [id]: priced[id] ?? null },
		refusals,
		out,
		relayDir: options.relayDir === "none" ? null : resolve(options.relayDir ?? defaultRelayDir(options.env)),
		gate: { script: GATE, args: gateArgs },
	};
}

/** The plan in words, for a person at a terminal. */
export function describePlan(plan) {
	const money = (x) => `$${x.toFixed(2)}`;
	const on = plan.tier === "all" ? `every tier on ${plan.id}` : `${plan.id} on the ${plan.tier} tier`;
	const lines = [
		`Model watch: ${plan.model}`,
		`  candidate  ${plan.candidate.arm}: Relay ${plan.champion.version} with ${on}`,
		`  champion   ${plan.champion.arm}: Relay ${plan.champion.version} on ${plan.champion.model}${plan.champion.fromLedger ? ", the ledger's last release" : ""}`,
		`  exam       ${plan.tasks} ${plan.examTier} tasks in ${plan.tasksDir}${plan.anchors ? `; anchors ${plan.anchors}` : ""}`,
		`  design     ${plan.design.looks === 1 ? "one look" : `${plan.design.looks} looks (${plan.design.spending})`} at ${plan.design.plannedTasks} tasks; look ${plan.look} reads ${plan.lookTasks}`,
		`  runs       look ${plan.look}: ${plan.lookTasks} tasks × 2 arms × ${plan.reps} = ${plan.runs} runs, at most ${money(plan.capUsd)} each`,
		`  spend      at most ${money(plan.spendCap === null ? plan.worstUsd : Math.min(plan.spendCap, plan.worstUsd))} on models${plan.spendCap === null ? "" : ` (the cap is ${money(plan.spendCap)})`}, and ${money(plan.e2bCapUsd)} on E2B sandboxes`,
	];
	for (const [model, price] of Object.entries(plan.prices)) {
		lines.push(`  meter      ${price ? `prices ${model} at $${price.input} in and $${price.output} out per million tokens` : `has no price for ${model}`}`);
	}
	lines.push(`  gate       node ${plan.gate.script} ${plan.gate.args.join(" ")}`);
	lines.push(`  result     ${join(plan.out, `${plan.test}.exam.json`)}${plan.relayDir && plan.examTier === "exam" ? `, and for the harness ${join(plan.relayDir, "model-watch", "exams", resultFileName(plan.model))}` : ""}`);
	for (const refusal of plan.refusals) lines.push(`  refused    ${refusal}`);
	return lines;
}

/**
 * The hashed result the harness reads, from a gate that has decided: its kept looks (<test>.looks.json) and its last
 * verdict (<test>.gate.json). Null while the gate has not decided.
 */
export function examResult(plan, { now = new Date() } = {}) {
	const gatePath = join(plan.out, `${plan.test}.gate.json`);
	const statePath = join(plan.out, `${plan.test}.looks.json`);
	if (!existsSync(gatePath)) return null;
	const gateText = readFileSync(gatePath, "utf8");
	const result = JSON.parse(gateText);
	const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
	if (!result.final || !["PASS", "BLOCK", "UNRESOLVED"].includes(result.status)) return null;
	if (result.candidate !== plan.candidate.arm || result.champion !== plan.champion.arm) {
		throw new Error(`${gatePath} is a gate of ${result.candidate} against ${result.champion}, not of ${plan.candidate.arm} against ${plan.champion.arm}`);
	}
	const body = {
		format: MODEL_EXAM_FORMAT,
		model: plan.model,
		tiers: [plan.tier],
		verdict: result.status,
		label: result.label,
		champion: plan.champion.arm,
		championModel: `${plan.provider}/${plan.champion.model}`,
		candidate: plan.candidate.arm,
		test: plan.test,
		tier: plan.examTier,
		gate: {
			tasks: result.tasks ?? null,
			difference: result.difference ?? null,
			low: result.low ?? null,
			high: result.high ?? null,
			costRatio: result.costRatio ?? null,
			timeRatio: result.timeRatio ?? null,
			look: result.look?.index ?? null,
			looks: plan.design.looks,
		},
		gateSha256: sha256(gateText),
		decidedAt: state?.decided?.at ?? now.toISOString(),
		writtenAt: now.toISOString(),
	};
	return { ...body, sha256: examHash(body) };
}

/** Writes a result beside the gate's runs and, for a gate on the exam, where the harness reads it. Returns the paths. */
export function writeExamResult(plan, result) {
	const paths = [join(plan.out, `${plan.test}.exam.json`)];
	if (plan.relayDir && plan.examTier === "exam") paths.push(join(plan.relayDir, "model-watch", "exams", resultFileName(plan.model)));
	for (const path of paths) {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
	}
	return paths;
}

/** Runs a script of this repository with node, its output shown as it goes. */
function nodeScript(script, args) {
	const r = spawnSync(process.execPath, [join(ROOT, script), ...args], { stdio: "inherit" });
	return { status: r.status };
}

/**
 * Model watch: a dry run without `spendCap` (the plan, nothing spent), else the gate's next look and, once the gate
 * has decided, the result written. Returns { plan, ran, result, paths, status }.
 */
export function runModelWatch(options, { exec = nodeScript, prices = meterPrices, ledgerPath, now = new Date(), log = console.log } = {}) {
	const plan = planModelWatch(options, { prices, ledgerPath });
	if (plan.spendCap === null) {
		for (const line of describePlan(plan)) log(line);
		log("Dry run: nothing was spent and nothing was written. Run again with --spend-cap <usd> to run this look.");
		return { plan, ran: false, result: null, paths: [], status: "planned" };
	}
	if (plan.refusals.length) throw new Error(`${plan.refusals.join("; ")}; nothing was run`);
	for (const line of describePlan(plan)) log(line);
	const ran = exec(plan.gate.script, plan.gate.args);
	// The gate exits 0, 10 or 20 for its verdict; anything else means the runs or the reading failed.
	if (![0, 10, 20].includes(ran.status)) throw new Error(`the gate stopped with exit ${ran.status}; nothing was written for the harness`);
	const result = examResult(plan, { now });
	if (!result) {
		log(`Look ${plan.look} did not decide the gate. Run the same command again for the next look; nothing was written for the harness.`);
		return { plan, ran: true, result: null, paths: [], status: "continue" };
	}
	const paths = writeExamResult(plan, result);
	log(`${result.verdict} · ${result.label}: ${plan.model} ${result.verdict === "PASS" ? "may now be used by Relay's routing" : "stays out of Relay's routing"}.`);
	for (const path of paths) log(`  wrote ${path}`);
	return { plan, ran: true, result, paths, status: result.verdict };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({
		options: {
			model: { type: "string" },
			tier: { type: "string", default: "all" },
			exam: { type: "string" },
			"tasks-dir": { type: "string" },
			"exam-tier": { type: "string", default: "exam" },
			anchors: { type: "string" },
			champion: { type: "string" },
			"champion-model": { type: "string" },
			looks: { type: "string" },
			"plan-tasks": { type: "string" },
			reps: { type: "string" },
			"cap-usd": { type: "string" },
			"e2b-cap-usd": { type: "string" },
			"spend-cap": { type: "string" },
			out: { type: "string" },
			"relay-dir": { type: "string" },
			json: { type: "boolean", default: false },
		},
	});
	try {
		if (!values.model) throw new Error("--model is required: the new model, such as anthropic/claude-sonnet-6");
		const options = {
			model: values.model,
			tier: values.tier,
			exam: values.exam,
			tasksDir: values["tasks-dir"],
			examTier: values["exam-tier"],
			anchors: values.anchors,
			champion: values.champion,
			championModel: values["champion-model"],
			looks: values.looks,
			planTasks: values["plan-tasks"],
			reps: values.reps,
			capUsd: values["cap-usd"],
			e2bCapUsd: values["e2b-cap-usd"],
			spendCap: values["spend-cap"],
			out: values.out,
			relayDir: values["relay-dir"],
		};
		const done = runModelWatch(options, values.json ? { log: () => {} } : {});
		if (values.json) console.log(JSON.stringify({ status: done.status, plan: done.plan, result: done.result, paths: done.paths }, null, 2));
		process.exitCode = done.status === "BLOCK" ? 10 : done.status === "UNRESOLVED" || done.status === "continue" ? 20 : 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
