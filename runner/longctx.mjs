#!/usr/bin/env node
// Test G (PREREGISTRATION.md): two long-context benchmarks from Prime Agent's published same-model table, a fixed
// sample of each (runner/longctx-manifest.json, drawn by runner/longctx-data.mjs), one run per item per tool.
//
//   node runner/longctx.mjs --tools relay,claude-code,prime-agent --per-set 50 --model claude-haiku-5-5 \
//     --cap-usd 0.5 --stage-cap-usd 25 --concurrency 4 --out runs/round-1
//
// Each run: a fresh sandbox from the round's image, the item's long context written to /home/user/work/context.txt,
// and the question (with a pointer to that file) as the prompt to the tool's own non-interactive mode (`relay -p`,
// `claude -p`, `prime-agent -p`), every model tier on the test model as runner/arms.mjs sets them. Model traffic goes
// through the round's meter at api.anthropic.com inside the sandbox (runner/sandbox-meter.mjs), which also stops the
// run at --cap-usd. The tool's final printed answer is scored with the benchmark's own rule (runner/longctx-score.mjs).
//
// - Order: item, then set, then tool, so a stage cut short still compares the tools on the same items.
// - Cost: a run starts only while (spent + runs in flight x --cap-usd + --cap-usd) stays within --stage-cap-usd; when
//   even one more run alone could pass it, the stage stops. Spend is every attempt's metered cost (<stage>/spend.jsonl),
//   retries included; an attempt whose meter log was lost counts as its full cap.
// - Resume: run the same command again; runs already in <out>/<test>/records.jsonl are skipped.
// - A run that ends without an answer because of our infrastructure (the sandbox, the meter, or provider errors the
//   tool could not ride out) is run again once and logged; if it fails again it is recorded as an infrastructure
//   failure and the analysis drops that item for every tool (PREREGISTRATION.md, "Runs that break").
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { Sandbox } from "e2b";
import { PINS, RUN_PATH, TEMPLATE_NAME } from "../sandbox/template.mjs";
import { ARMS } from "./arms.mjs";
import { BASE_ENV, sh, sha } from "./judge.mjs";
import { loadRows, MANIFEST_PATH } from "./longctx-data.mjs";
import { scoreItem } from "./longctx-score.mjs";
import { readMeter, startMeter, TRUST_ENV } from "./sandbox-meter.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
export const WORK = "/home/user/work";
export const CONTEXT_FILE = `${WORK}/context.txt`;
const PROMPT_FILE = "/home/user/prompt.txt";
export const SETS = ["oolong", "longbench"];

const mask = (s) => String(s).replace(/(sk-ant-|e2b_)[A-Za-z0-9_-]{4,}/g, "$1[MASKED]");

/** The prompt each tool gets: the benchmark's own question, told where its context is. */
export function promptFor(set, row) {
	if (set === "oolong") {
		// OOLONG's own eval puts the context in the system prompt and the question ("In the above data, ...") after it.
		return `The data for this question is in the file ${CONTEXT_FILE}; "the above data" below means the contents of that file.\n\n${row.question}`;
	}
	// LongBench v2's own zero-shot template (prompts/0shot.txt), with the <text> block replaced by the file.
	return (
		`Please read the text in the file ${CONTEXT_FILE} and answer the question below.\n\n` +
		`What is the correct answer to this question: ${row.question.trim()}\n` +
		`Choices:\n(A) ${row.choices.A.trim()}\n(B) ${row.choices.B.trim()}\n(C) ${row.choices.C.trim()}\n(D) ${row.choices.D.trim()}\n\n` +
		`Format your response as follows: "The correct answer is (insert answer here)".`
	);
}

/** Each tool's own non-interactive mode, with its final answer printed to stdout (text output, the default). */
export const COMMANDS = {
	relay: () => `relay -p -- "$(cat ${PROMPT_FILE})" < /dev/null`,
	"claude-code": ({ model }) => `claude -p "$(cat ${PROMPT_FILE})" --model ${model} --dangerously-skip-permissions < /dev/null`,
	"prime-agent": ({ model }) => `prime-agent -p --model anthropic/${model} -- "$(cat ${PROMPT_FILE})" < /dev/null`,
};

function readJsonl(path) {
	return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values: args } = parseArgs({
		options: {
			tools: { type: "string", default: "relay,claude-code,prime-agent" },
			sets: { type: "string", default: SETS.join(",") },
			"per-set": { type: "string", default: "50" },
			model: { type: "string", default: "claude-haiku-5-5" },
			"cap-usd": { type: "string", default: "0.5" },
			"stage-cap-usd": { type: "string" },
			"time-limit-min": { type: "string", default: "30" },
			concurrency: { type: "string", default: "4" },
			out: { type: "string", default: "runs/round-1" },
			test: { type: "string", default: "G" },
			"dry-run": { type: "boolean", default: false },
		},
	});
	if (!args["stage-cap-usd"]) throw new Error("--stage-cap-usd is required");
	for (const tool of args.tools.split(",")) if (!COMMANDS[tool]) throw new Error(`unknown tool ${tool}; known: ${Object.keys(COMMANDS).join(", ")}`);
	for (const set of args.sets.split(",")) if (!SETS.includes(set)) throw new Error(`unknown set ${set}; known: ${SETS.join(", ")}`);
	const counted = !/^(pilot|dev)/.test(args.test);
	if (counted && !["25", "50"].includes(args["per-set"])) throw new Error("a counted test G runs 50 items per set, or 25 if the round shrinks");
	if (counted && args.sets !== SETS.join(",")) throw new Error("a counted test G runs both sets");
	await runStage(args);
}

async function runStage(args) {
	for (const name of ["RELAY_BENCH_ANTHROPIC_KEY", "E2B_API_KEY"]) if (!process.env[name]) throw new Error(`${name} is not set`);
	const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
	const rows = loadRows();
	const sets = args.sets.split(",");
	const tools = args.tools.split(",");
	const perSet = Number(args["per-set"]);
	const capUsd = Number(args["cap-usd"]);
	const stageCap = Number(args["stage-cap-usd"]);
	const stageDir = join(ROOT, args.out, args.test);
	mkdirSync(stageDir, { recursive: true });
	const recordsPath = join(stageDir, "records.jsonl");
	const spendPath = join(stageDir, "spend.jsonl");

	// The items, checked against the manifest: the same context and question the manifest was drawn from.
	const items = {};
	for (const set of sets) {
		const byId = new Map(rows[set].map((r) => [r.id, r]));
		items[set] = manifest.sets[set].items.slice(0, perSet).map((m) => {
			const row = byId.get(m.id);
			if (!row || sha(row.context) !== m.contextSha256) throw new Error(`${set} ${m.id} differs from the manifest; run node runner/longctx-data.mjs --check`);
			return { manifest: m, row };
		});
	}

	const key = (j) => `${args.test}|${j.set}|${j.item}|${j.tool}|${args.model}`;
	const jobs = [];
	for (let i = 0; i < perSet; i++)
		for (const set of sets) if (items[set][i]) for (const tool of tools) jobs.push({ set, index: i, item: items[set][i].manifest.id, tool });
	const done = new Set(readJsonl(recordsPath).map((r) => `${r.test}|${r.set}|${r.item}|${r.tool}|${r.model}`));
	const pending = jobs.filter((j) => !done.has(key(j)));
	const spent = () => readJsonl(spendPath).reduce((s, a) => s + a.chargedUsd, 0);

	console.log(
		`test ${args.test}: ${sets.map((s) => `${s} ${items[s].length}`).join(", ")} items × ${tools.join(", ")} = ${jobs.length} runs, ` +
			`${jobs.length - pending.length} done, ${pending.length} to go; spent $${spent().toFixed(4)} of $${stageCap}`,
	);
	if (args["dry-run"]) {
		for (const j of pending.slice(0, 20)) console.log(`  would run ${key(j)}`);
		return;
	}

	/** One attempt at one run. Resolves with its record, or with an infrastructure failure. */
	async function attempt(job, n) {
		const { row, manifest: m } = items[job.set][job.index];
		const runId = `${args.test}-${job.set}-${job.item}-${job.tool}-a${n}-${randomBytes(3).toString("hex")}`;
		const runDir = join(stageDir, runId);
		mkdirSync(runDir, { recursive: true });
		const prompt = promptFor(job.set, row);
		const record = {
			runId,
			test: args.test,
			set: job.set,
			item: job.item,
			tool: job.tool,
			model: args.model,
			attempt: n,
			capUsd,
			limitMinutes: Number(args["time-limit-min"]),
			pins: PINS,
			template: TEMPLATE_NAME,
			datasetRevision: manifest.sets[job.set].source.revision,
			contextSha256: m.contextSha256,
			promptSha256: sha(prompt),
			startedAt: new Date().toISOString(),
		};
		let meter;
		let infra;
		let sandbox;
		try {
			sandbox = await Sandbox.create(TEMPLATE_NAME, {
				timeoutMs: (record.limitMinutes + 15) * 60_000,
				metadata: { relayBench: runId },
			});
			record.sandbox = sandbox.sandboxId;
			const mk = await sh(sandbox, `mkdir -p ${WORK}`);
			if (mk.exitCode !== 0) throw new Error(`setup failed: ${mk.stderr.slice(-300)}`);
			await sandbox.files.write(CONTEXT_FILE, row.context);
			await sandbox.files.write(PROMPT_FILE, prompt);
			const arm = ARMS[job.tool];
			for (const [path, content] of Object.entries(arm.files({ model: args.model }))) await sandbox.files.write(path, content);
			const sizes = await sh(sandbox, `wc -c < ${CONTEXT_FILE}`);
			if (Number(sizes.stdout.trim()) !== Buffer.byteLength(row.context)) throw new Error("the context file was not written whole");
			record.meterSha256 = await startMeter(sandbox, capUsd);
			record.meterMode = "intercept";

			const command = COMMANDS[job.tool]({ model: args.model });
			record.command = command;
			const started = Date.now();
			const run = await sh(sandbox, command, {
				cwd: WORK,
				timeoutMs: record.limitMinutes * 60_000,
				envs: { ...BASE_ENV, ...TRUST_ENV, ...arm.env({ model: args.model }), ANTHROPIC_API_KEY: process.env.RELAY_BENCH_ANTHROPIC_KEY },
			});
			record.wallMs = Date.now() - started;
			record.exitCode = run.exitCode;
			record.timedOut = run.exitCode === null && /timeout|deadline/i.test(`${run.error} ${run.stderr}`);
			writeFileSync(join(runDir, "tool.stdout.gz"), gzipSync(mask(run.stdout)));
			writeFileSync(join(runDir, "tool.stderr.gz"), gzipSync(mask(run.stderr)));
			meter = await readMeter(sandbox);
			writeFileSync(join(runDir, "meter.jsonl"), meter.text);
			record.usage = meter.usage;
			record.answer = run.stdout.trim().slice(-4000);
			// No answer, and the provider's errors (not the tool, and not the cap) were the last thing it saw.
			const noAnswer = record.answer === "";
			if (noAnswer && record.usage.refusedAtCap === 0 && (meter.lastModelStatus === 0 || meter.lastModelStatus >= 500)) {
				infra = `provider errors (${record.usage.providerErrors}), last status ${meter.lastModelStatus}`;
			}
		} catch (error) {
			infra = mask(error?.stack ?? error).slice(0, 1500);
		} finally {
			if (sandbox) await sandbox.kill().catch(() => {});
		}
		// A run whose meter log was lost after the tool started counts as its full cap.
		const chargedUsd = meter ? meter.usage.costUsd : record.command ? capUsd : 0;
		appendFileSync(spendPath, `${JSON.stringify({ key: key(job), runId, attempt: n, chargedUsd, metered: Boolean(meter) })}\n`);
		record.finishedAt = new Date().toISOString();
		if (infra) {
			record.infra = infra;
			writeFileSync(join(runDir, "record.json"), JSON.stringify(record, null, 2));
			return { infra, record };
		}
		const graded = scoreItem(job.set, m, record.answer);
		record.score = graded.score;
		record.parsed = graded.parsed;
		record.gold = graded.gold;
		writeFileSync(join(runDir, "record.json"), JSON.stringify(record, null, 2));
		return { record };
	}

	let inFlight = 0;
	let stopped = "";
	const queue = [...pending];
	const workers = Array.from({ length: Number(args.concurrency) }, async () => {
		while (queue.length && !stopped) {
			if (spent() + (inFlight + 1) * capUsd > stageCap) {
				// Runs in flight might each spend up to their cap; wait for them, and stop only when even one more run
				// alone could pass the stage cap.
				if (inFlight === 0) {
					stopped = `the next run could take the stage past its $${stageCap} cap`;
					break;
				}
				await new Promise((r) => setTimeout(r, 10_000));
				continue;
			}
			const job = queue.shift();
			inFlight++;
			let result = await attempt(job, 1);
			if (result.infra) {
				appendFileSync(join(stageDir, "infra-failures.log"), `${new Date().toISOString()} ${key(job)} attempt 1\n${result.infra}\n\n`);
				// The retry keeps this run's place in the reservation; it waits while runs in flight could take it past
				// the cap, and leaves the run for a resume if even it alone could.
				while (spent() + inFlight * capUsd > stageCap && inFlight > 1) await new Promise((r) => setTimeout(r, 10_000));
				if (spent() + capUsd > stageCap) {
					inFlight--;
					stopped = `the retry of ${key(job)} could take the stage past its $${stageCap} cap`;
					break;
				}
				result = await attempt(job, 2);
				if (result.infra) {
					appendFileSync(join(stageDir, "infra-failures.log"), `${new Date().toISOString()} ${key(job)} attempt 2: dropped\n${result.infra}\n\n`);
				}
			}
			// An item whose run failed twice for our reasons is recorded as such; the analysis drops it for every tool.
			appendFileSync(recordsPath, `${JSON.stringify(result.record)}\n`);
			inFlight--;
			const r = result.record;
			console.log(
				`[${new Date().toISOString().slice(11, 19)}] ${key(job)}: ` +
					(r.infra ? `infrastructure failure` : `score ${r.score} (parsed ${JSON.stringify(r.parsed)}, gold ${JSON.stringify(r.gold)})`) +
					`, $${(r.usage?.costUsd ?? 0).toFixed(4)}, ${Math.round((r.wallMs ?? 0) / 1000)}s, models ${r.usage?.modelsSeen?.join("+") ?? "-"}` +
					`  | stage $${spent().toFixed(4)}`,
			);
		}
	});
	await Promise.all(workers);
	console.log(stopped ? `stopped: ${stopped}` : `test ${args.test} finished: $${spent().toFixed(4)} spent`);
}
