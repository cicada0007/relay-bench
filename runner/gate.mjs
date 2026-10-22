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
// --dry-run with --run lists the runs it would start and spends nothing.
// Exit codes: 0 PASS, 10 BLOCK, 20 UNRESOLVED (GATE.md).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadRecords } from "./analyze.mjs";
import { RELAY_VERSION_PATTERN } from "./arms.mjs";
import { gate } from "./gate-analyze.mjs";

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
	},
});
for (const name of ["test", "champion", "candidate"]) if (!args[name]) throw new Error(`--${name} is required`);
for (const name of ["champion", "candidate"]) {
	if (!RELAY_VERSION_PATTERN.test(args[name])) throw new Error(`--${name} must be a released Relay version, such as 0.6.121`);
}
if (args.champion === args.candidate) throw new Error("--champion and --candidate are the same version");
const champion = `relay@${args.champion}`;
const candidate = `relay@${args.candidate}`;

/** TIERS.md: the exam's tasks never sit inside this public repository, so a gate on the exam refuses a folder in it. */
function tasksDir() {
	if (args.tier === "practice") return resolve(args["tasks-dir"] ?? join(ROOT, "tasks"));
	if (args.tier !== "exam" && args.tier !== "check") throw new Error(`unknown --tier ${args.tier}; known: practice, check, exam`);
	if (!args["tasks-dir"]) throw new Error(`--tier ${args.tier} needs --tasks-dir, the private exam repository's tasks folder`);
	const dir = resolve(args["tasks-dir"]);
	const inside = relative(ROOT, dir);
	if (!inside.startsWith("..") && !isAbsolute(inside)) {
		throw new Error(`the ${args.tier} tasks must live outside this public repository; ${dir} is inside it`);
	}
	return dir;
}

if (args.run) {
	for (const name of ["model", "cap-usd", "stage-cap-usd", "e2b-cap-usd"]) if (!args[name]) throw new Error(`--run needs --${name}`);
	const stage = spawnSync(
		process.execPath,
		[
			join(ROOT, "runner/run-stage.mjs"),
			"--test", args.test,
			"--model", args.model,
			"--tools", `${champion},${candidate}`,
			"--tasks", args.tasks ?? (args.tier === "practice" ? "kind:everyday,kind:long" : `tier:${args.tier}`),
			"--tasks-dir", tasksDir(),
			"--reps", args.reps,
			"--cap-usd", args["cap-usd"],
			"--stage-cap-usd", args["stage-cap-usd"],
			"--e2b-cap-usd", args["e2b-cap-usd"],
			"--concurrency", args.concurrency,
			"--out", args.out,
			...(args["dry-run"] ? ["--dry-run"] : []),
		],
		{ stdio: "inherit" },
	);
	if (args["dry-run"]) process.exit(stage.status ?? 1);
	if (stage.status !== 0) {
		console.error(`the runs stopped (exit ${stage.status}); reading what finished`);
	}
}

const result = gate(loadRecords(args.out, args.test), { champion, candidate });
mkdirSync(join(ROOT, args.out), { recursive: true });
writeFileSync(join(ROOT, args.out, `${args.test}.gate.json`), `${JSON.stringify(result, null, 2)}\n`);

if (args.json) {
	console.log(JSON.stringify(result, null, 2));
} else {
	const f = (x, d = 1) => (x === null || x === undefined ? "–" : x.toFixed(d));
	console.log(`${result.status} · ${result.label}`);
	console.log(`${candidate} against ${champion}: ${result.reason}`);
	console.log(`  requirements met  ${f(result.difference)} points, 95% interval ${f(result.low)} to ${f(result.high)}, over ${result.tasks} tasks`);
	for (const [kind, k] of Object.entries(result.kinds)) {
		console.log(`  ${kind.padEnd(16)}  ${f(k.difference)} points, ${f(k.low)} to ${f(k.high)}, ${k.tasks} tasks${k.judged ? "" : " (too few to judge alone)"}`);
	}
	console.log(`  cost              ${result.costRatio === null ? "–" : `${f((result.costRatio - 1) * 100)}%`}`);
	console.log(`  time              ${result.timeRatio === null ? "–" : `${f((result.timeRatio - 1) * 100)}%`}`);
	console.log(`  false "done"      ${f(result.falseDone.candidate)}% against ${f(result.falseDone.champion)}%`);
	console.log(`  smallest change this gate could see: ${result.detectablePoints === null ? "–" : `${f(result.detectablePoints)} points`}`);
}
process.exitCode = result.exitCode;
