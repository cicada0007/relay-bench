// scripts/model-watch.mjs on throwaway folders and made-up records: no model, no sandbox, nothing spent. The paid path
// runs with a stand-in for the gate's runs; one test reads the real gate over made-up records.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ARMS, armFor, modelArm, parseModelArm } from "../runner/arms.mjs";
import { pinPathFor } from "../runner/pins.mjs";
import { writeProblems } from "./ledger.mjs";
import { describePlan, examHash, examResult, MODEL_EXAM_FORMAT, modelName, planModelWatch, resultFileName, runModelWatch } from "./model-watch.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/** The exam the harness's own test hashes too (relay-harness test/model-watch.test.ts): one value, both languages. */
const VECTOR = {
	format: "relay-model-exam/1",
	model: "anthropic/claude-sonnet-6",
	tiers: ["all"],
	verdict: "PASS",
	label: "no worse",
	champion: "relay@0.6.121",
	championModel: "anthropic/claude-haiku-5-5",
	candidate: "relay@0.6.121+all+claude-sonnet-6",
	test: "model-claude-sonnet-6-on-0.6.121",
	tier: "exam",
	gate: { tasks: 120, difference: 1.5, low: -2.1, high: 5, costRatio: 1.02, timeRatio: 0.97, look: 3, looks: 3 },
	gateSha256: "0".repeat(64),
	decidedAt: "2026-10-23T12:00:00.000Z",
	writtenAt: "2026-10-23T12:00:05.000Z",
};
const VECTOR_SHA256 = "84846d3fc4527ea584977b74b5868367be537dc09be44d8a78b968d0661105da";

/** Every model priced but `unpriced`, as the meter would price it. */
const pricesBut =
	(...unpriced) =>
	(models) =>
		Object.fromEntries(models.map((m) => [m, unpriced.includes(m) ? null : { input: 1, output: 5 }]));

/** An exam beside a throwaway folder: `n` tasks of `tier`, an anchor set file, and a ledger with one release. */
function exam(n, tier = "exam") {
	const root = mkdtempSync(join(tmpdir(), "model-watch-"));
	const examDir = join(root, "relay-exam");
	for (let i = 0; i < n; i++) {
		const id = `t${String(i).padStart(3, "0")}`;
		mkdirSync(join(examDir, "tasks", id), { recursive: true });
		writeFileSync(join(examDir, "tasks", id, "task.json"), JSON.stringify({ id, kind: "everyday", tier }));
	}
	mkdirSync(join(examDir, "anchors"), { recursive: true });
	writeFileSync(join(examDir, "anchors", "anchors-v1.json"), "{}");
	writeFileSync(join(examDir, "anchors", "anchors-v2.json"), "{}");
	const ledgerPath = join(root, "ledger.json");
	writeFileSync(ledgerPath, JSON.stringify({ schema: 1, entries: [{ release: "0.6.121", model: "claude-haiku-5-5" }] }));
	return { root, examDir, ledgerPath, relayDir: join(root, "agent") };
}

test("hashes a result as the harness does", () => {
	assert.equal(examHash(VECTOR), VECTOR_SHA256);
	assert.equal(examHash({ ...VECTOR, sha256: "anything" }), VECTOR_SHA256);
	assert.equal(MODEL_EXAM_FORMAT, VECTOR.format);
});

test("a model arm is the champion's release with the new model on a tier, in characters a release id may have", () => {
	assert.equal(modelArm("0.6.121", "all", "claude-sonnet-6"), "0.6.121+all+claude-sonnet-6");
	assert.deepEqual(parseModelArm("0.6.122-beta.3+strong+gpt-6.1-sol"), { version: "0.6.122-beta.3", tier: "strong", model: "gpt-6.1-sol" });
	assert.equal(parseModelArm("0.6.121"), null);
	assert.equal(parseModelArm("0.6.121+best+x"), null);
	assert.throws(() => modelArm("0.6.121", "all", "Not A Model"), /not a model arm/);
	assert.doesNotThrow(() => pinPathFor("/x/tasks", "0.6.121+all+claude-sonnet-6"));

	const arm = armFor("relay@0.6.121+strong+claude-sonnet-6");
	assert.equal(arm.relayVersion, "0.6.121");
	assert.deepEqual(arm.override, { tier: "strong", model: "claude-sonnet-6" });
	assert.equal(armFor("relay@0.6.121").override, undefined);

	const settings = (override) => JSON.parse(ARMS.relay.files({ model: "claude-haiku-5-5", override })["/home/user/.relay/agent/settings.json"]);
	assert.deepEqual(settings(undefined).models.tiers, { decider: "anthropic/claude-haiku-5-5", strong: "anthropic/claude-haiku-5-5", fast: "anthropic/claude-haiku-5-5" });
	assert.deepEqual(settings({ tier: "strong", model: "claude-sonnet-6" }).models.tiers, {
		decider: "anthropic/claude-haiku-5-5",
		strong: "anthropic/claude-sonnet-6",
		fast: "anthropic/claude-haiku-5-5",
	});
	const all = settings({ tier: "all", model: "claude-sonnet-6" });
	assert.equal(all.defaultModel, "claude-sonnet-6");
	assert.deepEqual(Object.values(all.models.tiers), ["anthropic/claude-sonnet-6", "anthropic/claude-sonnet-6", "anthropic/claude-sonnet-6"]);
});

test("names the model as the harness does", () => {
	assert.deepEqual(modelName("claude-sonnet-6"), { name: "anthropic/claude-sonnet-6", provider: "anthropic", id: "claude-sonnet-6" });
	assert.deepEqual(modelName("openai-codex/gpt-7-sol"), { name: "openai-codex/gpt-7-sol", provider: "openai-codex", id: "gpt-7-sol" });
	assert.throws(() => modelName("Claude Sonnet 6"), /must be a model id/);
	assert.equal(resultFileName("anthropic/claude-sonnet-6"), "anthropic__claude-sonnet-6.json");
});

test("the dry run plans the exam gate against the ledger's champion, and spends and writes nothing", () => {
	const e = exam(25);
	const lines = [];
	const exec = () => assert.fail("a dry run never runs the gate");
	const done = runModelWatch(
		{ model: "anthropic/claude-sonnet-6", exam: e.examDir, relayDir: e.relayDir },
		{ exec, prices: pricesBut("claude-sonnet-6"), ledgerPath: e.ledgerPath, log: (line) => lines.push(line) },
	);

	assert.equal(done.status, "planned");
	const { plan } = done;
	assert.equal(plan.candidate.arm, "relay@0.6.121+all+claude-sonnet-6");
	assert.deepEqual(plan.champion, { version: "0.6.121", model: "claude-haiku-5-5", arm: "relay@0.6.121", fromLedger: true });
	assert.equal(plan.test, "model-claude-sonnet-6-on-0.6.121");
	assert.equal(plan.anchors, join(e.examDir, "anchors", "anchors-v2.json"));
	assert.deepEqual(plan.design, { spending: "obrien-fleming", looks: 3, plannedTasks: 25 });
	// Look 1 reads at least the gate's 20 tasks: 20 tasks, two arms, once each, at $2 a run.
	assert.equal(plan.lookTasks, 20);
	assert.equal(plan.runs, 40);
	assert.equal(plan.worstUsd, 80);
	assert.deepEqual(plan.refusals, [
		"the meter has no price for claude-sonnet-6, so it could not hold the runs to their spend cap; add its list price to PRICES in meter/meter.mjs first",
	]);
	const args = plan.gate.args.join(" ");
	assert.match(args, /^--run --test model-claude-sonnet-6-on-0\.6\.121 --champion 0\.6\.121 --candidate 0\.6\.121\+all\+claude-sonnet-6 --model claude-haiku-5-5 --tier exam /);
	assert.match(args, /--looks 3 --plan-tasks 25 --reps 1 --cap-usd 2 --stage-cap-usd 80 --e2b-cap-usd 20/);
	assert.ok(lines.includes("  runs       look 1: 20 tasks × 2 arms × 1 = 40 runs, at most $2.00 each"), lines.join("\n"));
	assert.ok(lines.some((line) => line.startsWith("  refused    the meter has no price for claude-sonnet-6")));
	assert.match(lines.at(-1), /^Dry run: nothing was spent and nothing was written/);
	assert.equal(existsSync(plan.out), false);
	assert.equal(existsSync(e.relayDir), false);
	assert.deepEqual(describePlan(plan).slice(0, 2), [
		"Model watch: anthropic/claude-sonnet-6",
		"  candidate  relay@0.6.121+all+claude-sonnet-6: Relay 0.6.121 with every tier on claude-sonnet-6",
	]);
});

test("refuses what it cannot run, before anything starts", () => {
	const e = exam(25);
	const base = { model: "claude-sonnet-6", exam: e.examDir, relayDir: e.relayDir };
	const plan = (options, more = {}) => planModelWatch({ ...base, ...options }, { prices: pricesBut(), ledgerPath: e.ledgerPath, ...more });
	assert.throws(() => plan({ model: "gpt-7-sol" }), /gpt-7-sol is an openai model and the champion runs claude-haiku-5-5, an anthropic one: both arms of a run share one key/);
	assert.throws(() => plan({ model: "claude-haiku-5-5" }), /already the champion's model/);
	assert.throws(() => plan({ tier: "best" }), /--tier must be one of all, decider, strong, fast/);
	assert.throws(() => plan({ exam: join(ROOT, "dev-tasks") }), /outside this public repository/);
	assert.throws(() => plan({ planTasks: "10" }), /the gate needs at least 20/);
	const empty = join(e.root, "empty-ledger.json");
	writeFileSync(empty, JSON.stringify({ schema: 1, entries: [] }));
	assert.throws(() => plan({}, { ledgerPath: empty }), /name the champion with --champion/);
	assert.throws(() => plan({ champion: "0.6.120" }, { ledgerPath: empty }), /--champion-model/);
	assert.equal(plan({ champion: "0.6.120", championModel: "claude-haiku-5-5" }, { ledgerPath: empty }).champion.fromLedger, false);

	// Paid, the meter's price is required: nothing runs.
	let ran = false;
	assert.throws(
		() =>
			runModelWatch(
				{ ...base, spendCap: "30" },
				{ exec: () => (ran = true), prices: pricesBut("claude-sonnet-6"), ledgerPath: e.ledgerPath, log: () => {} },
			),
		/the meter has no price for claude-sonnet-6.*nothing was run/,
	);
	assert.equal(ran, false);
	assert.throws(() => plan({ spendCap: "0" }), /--spend-cap must be a number above 0/);
});

/** A stand-in for the gate's look: it writes what the gate keeps, as if its runs had ended with `status`. */
function fakeGate(status, { final = true, label = status === "PASS" ? "no worse" : "worse" } = {}) {
	const calls = [];
	const exec = (script, args) => {
		calls.push([script, ...args]);
		const at = (name) => args[args.indexOf(name) + 1];
		const out = at("--out");
		const test = at("--test");
		mkdirSync(out, { recursive: true });
		const result = {
			status,
			label,
			final,
			continue: !final,
			champion: `relay@${at("--champion")}`,
			candidate: `relay@${at("--candidate")}`,
			tasks: 40,
			difference: 1.25,
			low: -3.5,
			high: 6,
			costRatio: 1.01,
			timeRatio: 0.98,
			look: { index: 1 },
		};
		writeFileSync(join(out, `${test}.gate.json`), `${JSON.stringify(result, null, 2)}\n`);
		writeFileSync(
			join(out, `${test}.looks.json`),
			JSON.stringify({ test, looks: [{ index: 1 }], decided: final ? { status, label, look: 1, at: "2026-10-23T12:00:00.000Z" } : null }),
		);
		return { status: { PASS: 0, BLOCK: 10, UNRESOLVED: 20 }[status] };
	};
	return { exec, calls };
}

test("paid, it runs the gate's look and writes a hashed result where the harness reads it", () => {
	const e = exam(25);
	const gate = fakeGate("PASS");
	const done = runModelWatch(
		{ model: "anthropic/claude-sonnet-6", exam: e.examDir, relayDir: e.relayDir, spendCap: "30" },
		{ exec: gate.exec, prices: pricesBut(), ledgerPath: e.ledgerPath, now: new Date("2026-10-23T12:00:05.000Z"), log: () => {} },
	);

	assert.equal(done.status, "PASS");
	assert.equal(gate.calls.length, 1);
	assert.equal(gate.calls[0][0], "runner/gate.mjs");
	assert.ok(gate.calls[0].join(" ").includes("--stage-cap-usd 30"));
	const harnessFile = join(e.relayDir, "model-watch", "exams", "anthropic__claude-sonnet-6.json");
	assert.deepEqual(done.paths, [join(e.examDir, "runs", "model-watch", "model-claude-sonnet-6-on-0.6.121.exam.json"), harnessFile]);
	const written = JSON.parse(readFileSync(harnessFile, "utf8"));
	assert.equal(written.sha256, examHash(written));
	assert.deepEqual(
		{ ...written, gateSha256: "<sha>", sha256: "<sha>" },
		{
			format: "relay-model-exam/1",
			model: "anthropic/claude-sonnet-6",
			tiers: ["all"],
			verdict: "PASS",
			label: "no worse",
			champion: "relay@0.6.121",
			championModel: "anthropic/claude-haiku-5-5",
			candidate: "relay@0.6.121+all+claude-sonnet-6",
			test: "model-claude-sonnet-6-on-0.6.121",
			tier: "exam",
			gate: { tasks: 40, difference: 1.25, low: -3.5, high: 6, costRatio: 1.01, timeRatio: 0.98, look: 1, looks: 3 },
			gateSha256: "<sha>",
			decidedAt: "2026-10-23T12:00:00.000Z",
			writtenAt: "2026-10-23T12:00:05.000Z",
			sha256: "<sha>",
		},
	);
	// Once the gate has decided, nothing more runs.
	const again = planModelWatch({ model: "claude-sonnet-6", exam: e.examDir, relayDir: e.relayDir, spendCap: "30" }, { prices: pricesBut(), ledgerPath: e.ledgerPath });
	assert.match(again.refusals.join(" "), /already stopped at look 1 with PASS/);
});

test("a gate between looks writes nothing for the harness; a BLOCK is written as one", () => {
	const e = exam(25);
	const between = runModelWatch(
		{ model: "claude-sonnet-6", tier: "strong", exam: e.examDir, relayDir: e.relayDir, spendCap: "30" },
		{ exec: fakeGate("UNRESOLVED", { final: false, label: "continue" }).exec, prices: pricesBut(), ledgerPath: e.ledgerPath, log: () => {} },
	);
	assert.equal(between.status, "continue");
	assert.deepEqual(between.paths, []);
	assert.equal(existsSync(join(e.relayDir, "model-watch")), false);
	assert.equal(between.plan.candidate.arm, "relay@0.6.121+strong+claude-sonnet-6");

	const e2 = exam(25);
	const blocked = runModelWatch(
		{ model: "claude-sonnet-6", exam: e2.examDir, relayDir: e2.relayDir, spendCap: "30" },
		{ exec: fakeGate("BLOCK", { label: "costs more" }).exec, prices: pricesBut(), ledgerPath: e2.ledgerPath, log: () => {} },
	);
	assert.equal(blocked.status, "BLOCK");
	assert.equal(JSON.parse(readFileSync(blocked.paths[1], "utf8")).label, "costs more");

	assert.throws(
		() =>
			runModelWatch(
				{ model: "claude-sonnet-6", exam: e2.examDir, relayDir: "none", spendCap: "30", champion: "0.6.121", championModel: "claude-haiku-5-5", tier: "fast" },
				{ exec: () => ({ status: 1 }), prices: pricesBut(), ledgerPath: e2.ledgerPath, log: () => {} },
			),
		/the gate stopped with exit 1; nothing was written for the harness/,
	);
});

test("reads the real gate's verdict on a model arm, and keeps a practice gate away from the harness", () => {
	const e = exam(20, "practice");
	const options = { model: "claude-sonnet-6", exam: e.examDir, examTier: "practice", looks: "1", relayDir: e.relayDir, spendCap: "30" };
	// Instead of the runs, made-up records for both arms; then the real gate reads them, as it does after its runs.
	const exec = (script, args) => {
		const at = (name) => args[args.indexOf(name) + 1];
		const out = at("--out");
		const test = at("--test");
		mkdirSync(out, { recursive: true });
		const lines = [];
		for (let i = 0; i < 20; i++) {
			const task = `t${String(i).padStart(3, "0")}`;
			for (const [tool, share] of [
				[`relay@${at("--champion")}`, 0.2],
				[`relay@${at("--candidate")}`, 0.9],
			]) {
				lines.push(JSON.stringify({ runId: `${test}-${task}-${tool}`, test, task, taskKind: "everyday", tool, rep: 1, score: { share }, usage: { costUsd: 0.1 }, wallMs: 60_000 }));
			}
		}
		appendFileSync(join(out, "records.jsonl"), `${lines.join("\n")}\n`);
		const read = args.filter((arg) => arg !== "--run");
		const r = spawnSync(process.execPath, [join(ROOT, script), ...read], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr + r.stdout);
		return { status: r.status };
	};

	const done = runModelWatch(options, { exec, prices: pricesBut(), ledgerPath: e.ledgerPath, log: () => {} });

	assert.equal(done.status, "PASS");
	assert.equal(done.result.label, "better");
	assert.equal(done.result.tier, "practice");
	assert.equal(done.result.candidate, "relay@0.6.121+all+claude-sonnet-6");
	// Only a gate on the exam reaches the harness.
	assert.equal(done.paths.length, 1);
	assert.equal(existsSync(join(e.relayDir, "model-watch")), false);
});

test("the ledger holds releases only, never a model's exam", () => {
	const state = {
		test: "model-claude-sonnet-6-on-0.6.121",
		tier: "exam",
		champion: "relay@0.6.121",
		candidate: "relay@0.6.121+all+claude-sonnet-6",
		decided: { status: "PASS", label: "no worse", look: 1, at: "2026-10-23T12:00:00.000Z" },
		looks: [],
	};
	const problems = writeProblems({ state, result: null, records: [], ledger: { schema: 1, entries: [] }, signers: ["Arnav"] });
	assert.ok(problems.some((p) => /examined a model, not a release/.test(p)), problems.join("; "));
});

test("a stage refuses a model arm the meter cannot price, or of another provider, before anything runs", () => {
	const root = mkdtempSync(join(tmpdir(), "stage-model-arm-"));
	const tasks = join(root, "tasks");
	mkdirSync(join(tasks, "p1"), { recursive: true });
	writeFileSync(join(tasks, "p1", "task.json"), JSON.stringify({ id: "p1", kind: "everyday" }));
	const stage = (tools) =>
		spawnSync(
			process.execPath,
			[join(ROOT, "runner/run-stage.mjs"), "--test", "dev-model", "--model", "claude-haiku-5-5", "--tools", tools, "--tasks", "p1", "--tasks-dir", tasks, "--reps", "1", "--cap-usd", "1", "--stage-cap-usd", "5", "--out", join(root, "runs"), "--dry-run"],
			{ encoding: "utf8" },
		);
	const unpriced = stage("relay@0.6.121,relay@0.6.121+all+claude-sonnet-6");
	assert.notEqual(unpriced.status, 0);
	assert.match(unpriced.stderr, /the meter has no price for claude-sonnet-6/);
	assert.match(unpriced.stderr, /nothing was run/);
	const other = stage("relay@0.6.121,relay@0.6.121+all+gpt-6-sol");
	assert.match(other.stderr, /gpt-6-sol is not an anthropic model like claude-haiku-5-5/);
	const priced = stage("relay@0.6.121,relay@0.6.121+strong+claude-sonnet-5-5");
	assert.equal(priced.status, 0, priced.stderr);
	assert.match(priced.stdout, /2 runs planned/);
});
