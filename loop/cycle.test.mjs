// loop/cycle.mjs, the weekly cycle, on made-up runs with a fake writer and a fake run-stage: it stops before every
// paid step without a cap or a person's approval, writes nothing on a dry run, and with both runs analyze → propose →
// pre-screen → package to files, opening nothing anywhere.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readTasks } from "../runner/stage-tasks.mjs";
import { isoWeek, nodeScript, runCycle } from "./cycle.mjs";
import { examWithCheck, fakeArchText, fakeExec, fakeWriter, practiceTasks, record, SOURCES, writeRecords } from "./fakes.mjs";
import { approve, serializeSettings } from "./meta.mjs";

const SETTINGS = JSON.parse(readFileSync(new URL("./settings.json", import.meta.url), "utf8"));
const CYCLE = new URL("./cycle.mjs", import.meta.url).pathname;
const tierIds = (dir, tier) => [...readTasks(dir)].filter(([, t]) => t.tier === tier).map(([id]) => id);
const realDoor = { tierIds, "scripts/check-query.mjs": (args) => nodeScript("scripts/check-query.mjs", args) };

/** A throwaway harness: a git repository holding the fake relay.arch.json and the sources it names. */
function fakeHarness() {
	const dir = mkdtempSync(join(tmpdir(), "loop-harness-"));
	writeFileSync(join(dir, "relay.arch.json"), fakeArchText());
	for (const [file, text] of Object.entries(SOURCES)) {
		mkdirSync(join(dir, dirname(file)), { recursive: true });
		writeFileSync(join(dir, file), text);
	}
	const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git("commit", "-q", "-m", "champion");
	return dir;
}

function world({ approved = true } = {}) {
	const p = practiceTasks({ everyday: 6, long: 4 });
	const runs = join(p.root, "runs");
	const rs = [
		...["py-l0", "py-l1", "py-l2"].map((task) => record({ task, kind: "long", share: 0.5, saidDoneButFailed: true })),
		...["py-l1", "py-l2", "py-l3"].map((task) => record({ task, kind: "long", share: 0, extra: { timedOut: true } })),
		...["py-e0", "py-e1", "py-e2"].map((task) => record({ task, share: 1 })),
	];
	const records = writeRecords(runs, rs);
	const pub = writeRecords(join(runs, "F"), ["a", "b", "c"].map((t) => ({ test: "F", task: `terminal-bench/${t}`, tool: "relay", solved: false, infra: false, runId: `F-${t}` })));
	const settingsPath = join(p.root, "settings.json");
	writeFileSync(settingsPath, serializeSettings(approved ? approve(SETTINGS, { by: "arnav" }).settings : SETTINGS));
	const diff = (input) => {
		const m = /It is (\S+) in (\S+), lines (\d+) to (\d+)/.exec(input.prompt);
		const [, , file, , to] = m;
		const lines = SOURCES[file].split("\n");
		const at = Number(to) - 1;
		return `--- a/${file}\n+++ b/${file}\n@@ -${at},1 +${at},2 @@\n ${lines[at - 1]}\n+\t"Say what you checked, case by case.",\n`;
	};
	return { p, records: [records, pub], settingsPath, harness: fakeHarness(), out: join(p.root, "loop"), diff };
}
const base = (w, over = {}) => ({ cycle: "2026-W43", out: w.out, settingsPath: w.settingsPath, records: w.records, tasksDirs: [w.p.tasks], harness: w.harness, harnessRef: "HEAD", champion: "0.6.121", ...over });
const statuses = (r) => r.steps.map((s) => `${s.step}:${s.status}`);

test("without a spend cap the cycle stops before the first paid step, and says what waits and the most it could cost", async () => {
	const w = world();
	const calls = [];
	const writes = [];
	const r = await runCycle(base(w, { exec: fakeExec({ calls }), writer: fakeWriter({ diff: w.diff, calls: writes }) }));
	assert.deepEqual(statuses(r), ["meta:ran", "analyze:ran", "propose:ran", "exam:ran", "prescreen:stopped"]);
	assert.deepEqual(calls, [], "no stage ran");
	assert.deepEqual(writes, [], "no model was asked");
	const pre = r.steps.at(-1);
	assert.match(pre.why, /proposals wait for a pre-screen, a paid step \(12 dev runs and 0 selection runs each, at most \$\d+\.\d\d within the lanes' budgets\): no --spend-cap was given; run again with --spend-cap/);
	assert.ok(r.state.waitingWrites.length >= 2);
	assert.ok(r.state.waitingWrites.every((x) => x.worstUsd > 0 && /no --spend-cap/.test(x.why)));
	// Free work is done and kept: the rules lanes' proposals, with their patches, and the report.
	assert.ok(r.state.proposals.some((p) => p.lane === "config"));
	assert.ok(r.state.proposals.some((p) => p.lane === "architecture"));
	assert.ok(existsSync(join(r.dir, "proposals", `${r.state.proposals[0].id}.patch`)));
	const report = readFileSync(join(r.dir, "report.md"), "utf8");
	assert.match(report, /## Failure clusters/);
	assert.match(report, /c-false-done-long/);
	assert.match(report, /Waiting for the writer/);
	assert.match(report, /Spend cap: none given, so nothing paid ran/);
	assert.doesNotMatch(report, /\b(better|worse)\b/i);
});

test("a cycle with a cap still stops before paying when no person has approved the loop's settings", async () => {
	const w = world({ approved: false });
	const calls = [];
	const writes = [];
	const r = await runCycle(base(w, { spendCap: 20, exec: fakeExec({ calls }), writer: fakeWriter({ diff: w.diff, calls: writes }) }));
	assert.equal(r.steps.at(-1).status, "stopped");
	assert.match(r.steps.at(-1).why, /no person has approved the loop's settings/);
	assert.deepEqual(calls, []);
	assert.deepEqual(writes, []);
});

test("a dry run writes nothing, spends nothing and queues nothing", async () => {
	const w = world();
	const exam = examWithCheck({ check: 0, examTasks: 1 });
	const calls = [];
	const r = await runCycle(base(w, { dryRun: true, exam: exam.root, exec: fakeExec({ calls }), writer: fakeWriter({ diff: w.diff }) }));
	assert.equal(r.steps.find((s) => s.step === "prescreen").status, "skipped");
	assert.match(r.steps.find((s) => s.step === "prescreen").why, /^dry run/);
	assert.equal(existsSync(r.dir), false);
	assert.equal(existsSync(join(exam.root, "queue")), false);
	assert.deepEqual(calls, []);
	assert.match(r.report, /A dry run: nothing was written or spent/);
});

test("with a cap and a person's approval the cycle pre-screens, packages one release to files, and resumes", async () => {
	const w = world();
	const exam = examWithCheck({ check: 25 });
	// The first run, free: the proposals are fixed and a builder makes each one's package.
	const first = await runCycle(base(w, { exam: exam.root, exec: fakeExec({}), writer: fakeWriter({ diff: w.diff }) }));
	const ids = first.state.proposals.map((p) => p.id);
	const packages = join(first.dir, "packages");
	mkdirSync(packages, { recursive: true });
	for (const id of ids) writeFileSync(join(packages, `${id}.tgz`), "a made-up build");
	// The exam lane queued kinds of task for a person, approved by nobody.
	const queued = readFileSync(join(exam.root, "queue", "loop-proposals.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.ok(queued.length >= 1);
	assert.ok(queued.every((q) => q.approvedBy === null && q.status === "waiting for a person"));

	const calls = [];
	const writes = [];
	const exec = fakeExec({ calls, candidate: () => 1, champion: () => 0.5, real: realDoor });
	const r = await runCycle(base(w, { exam: exam.root, spendCap: 30, release: "0.6.122-beta.1", exec, writer: fakeWriter({ diff: w.diff, calls: writes }) }));
	assert.deepEqual(statuses(r), ["meta:ran", "analyze:ran", "propose:ran", "exam:ran", "prescreen:ran", "package:ran"]);
	assert.ok(writes.length >= 2, "the writer lanes wrote their changes");
	assert.ok(r.state.proposals.some((p) => p.lane === "prompts"));
	assert.ok(r.state.proposals.some((p) => p.lane === "tools"));
	const results = Object.values(r.state.prescreen.results);
	const passed = results.filter((x) => x.status === "passed");
	assert.deepEqual(passed.map((x) => x.lane).sort(), ["architecture", "config"], JSON.stringify(results.map((x) => [x.id, x.status, x.why])));
	// The written proposals had no build yet, so they wait; the rest asked the check tier once each, within the limit.
	assert.ok(results.filter((x) => x.status === "waiting").every((x) => /waiting for a build/.test(x.why[0])));
	assert.ok(r.state.prescreen.queries <= SETTINGS.prescreen.maxSelectionQueries);
	// The package: one change per lane, as files, and nothing run but node scripts of this repository.
	const release = join(r.dir, "release");
	for (const f of ["PR_BODY.md", "release.patch", "lanes.json", "ledger-preview.json"]) assert.ok(existsSync(join(release, f)), f);
	assert.ok(calls.every(([script]) => ["runner/run-stage.mjs", "scripts/check-query.mjs"].includes(script)));
	assert.ok(!calls.some((c) => c.join(" ").includes("gh ")));
	// Money: every lane within its budget, the command within its cap, and the cycle's spend recorded.
	const spend = readFileSync(join(r.dir, "spend.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const total = spend.reduce((s, e) => s + e.usd, 0);
	assert.ok(total > 0 && total <= 30);
	for (const lane of Object.keys(SETTINGS.lanes)) assert.ok(spend.filter((e) => e.lane === lane).reduce((s, e) => s + e.usd, 0) <= SETTINGS.lanes[lane].budgetUsd + 1e-9, lane);
	const summary = JSON.parse(readFileSync(join(r.dir, "summary.json"), "utf8"));
	assert.ok(summary.packaged.length >= 2);
	assert.ok(summary.packaged.every((c) => c.startsWith("loop:2026-W43:")));

	// Run again: finished pre-screens are kept, nothing is written or run twice.
	const again = [];
	const writesAgain = [];
	await runCycle(base(w, { exam: exam.root, spendCap: 30, exec: fakeExec({ calls: again, real: realDoor }), writer: fakeWriter({ diff: w.diff, calls: writesAgain }) }));
	assert.deepEqual(writesAgain, []);
	assert.ok(!again.some((c) => passed.some((x) => c.includes(`dev-loop-${x.id}`))));
});

test("the loop never runs gh or opens a pull request: no source file of it can", () => {
	const dir = new URL(".", import.meta.url).pathname;
	for (const name of readdirSync(dir).filter((n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs"))) {
		const text = readFileSync(join(dir, name), "utf8");
		assert.doesNotMatch(text, /["'`]gh["'`]|\bgh\s+pr\b|api\.github\.com|pulls/, name);
	}
});

test("the command line: a dry run exits 0, a run without a cap exits 3 before paying", () => {
	const w = world();
	const arch = join(w.p.root, "relay.arch.json");
	writeFileSync(arch, fakeArchText());
	const args = ["--settings", w.settingsPath, "--records", w.records[0], "--tasks-dir", w.p.tasks, "--arch", arch, "--champion", "0.6.121", "--out", w.out, "--cycle", "2026-W44"];
	const env = { PATH: process.env.PATH, HOME: process.env.HOME };
	const dry = spawnSync(process.execPath, [CYCLE, ...args, "--dry-run"], { encoding: "utf8", env });
	assert.equal(dry.status, 0, dry.stderr);
	assert.match(dry.stdout, /prescreen\s+skipped\s+dry run/);
	const unpaid = spawnSync(process.execPath, [CYCLE, ...args], { encoding: "utf8", env });
	assert.equal(unpaid.status, 3, unpaid.stderr);
	assert.match(unpaid.stdout, /prescreen\s+stopped/);
	assert.ok(existsSync(join(w.out, "2026-W44", "report.md")));
	assert.match(isoWeek(new Date("2026-10-23T12:00:00Z")), /^2026-W43$/);
	assert.equal(isoWeek(new Date("2027-01-01T00:00:00Z")), "2026-W53");
});
