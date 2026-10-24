// The router in the routing lane (relay-harness D-101): the starting table, the verifier's share and an arm's least
// budget are the routing lane's to change; a set of arms that gave more proven results per dollar in the benchmark's arm
// outcomes becomes a row's proposal; and the runs that judge it turn the meta-harness on for both arms. Made-up arm
// outcomes and a fake run-stage; nothing is run or spent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ARMS } from "../runner/arms.mjs";
import { readTasks } from "../runner/stage-tasks.mjs";
import { armOutcomeProblem } from "../scripts/arm-outcomes.mjs";
import { emptyLedger } from "../scripts/ledger.mjs";
import { gateArgs } from "./autopilot.mjs";
import { nodeScript, runCycle } from "./cycle.mjs";
import { examWithCheck, fakeArch, fakeArchText, fakeArmOutcomes, fakeExec, practiceTasks, record, SOURCES, sources, writeRecords } from "./fakes.mjs";
import { LANES, needsMetaHarness, proposalProblems, SET_HERE, setHereFromSchema } from "./lanes.mjs";
import { approve, serializeSettings } from "./meta.mjs";
import { packageRelease } from "./package.mjs";
import { prescreen, wallet } from "./prescreen.mjs";
import { archProposal, armSetKey, matchingRow, routerCandidates, routerEvidence, rowArms, selectProposals, setWords } from "./propose.mjs";

const SETTINGS = JSON.parse(readFileSync(new URL("./settings.json", import.meta.url), "utf8"));
const ROOT = new URL("..", import.meta.url).pathname;
// A checkout of the harness, read with git show only (RELAY_HARNESS_CHECKOUT, else beside this one); skipped without it.
const HARNESS = process.env.RELAY_HARNESS_CHECKOUT ?? join(ROOT, "..", "prime-agent-main");
const many = { ...SETTINGS, lanes: { ...SETTINGS.lanes, routing: { ...SETTINGS.lanes.routing, proposals: 3 } } };

/** Applies a patch to the champion's files with git, as a reviewer would; returns relay.arch.json after. */
function archAfter(patch, archText) {
	const dir = mkdtempSync(join(tmpdir(), "router-champion-"));
	writeFileSync(join(dir, "relay.arch.json"), archText);
	writeFileSync(join(dir, "p.patch"), patch);
	const r = spawnSync("git", ["apply", "p.patch"], { cwd: dir, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(readFileSync(join(dir, "relay.arch.json"), "utf8"));
}

/**
 * The evidence: on medium tasks two attempts proved 10 of 10 for $0.08 a run against one Relay attempt's 5 of 10 for
 * $0.05 (more a dollar, and more often); on hard tasks one Relay attempt proved 8 of 10 for $0.10 against two attempts'
 * 8 of 10 for $0.40; on easy tasks one attempt is already the most a dollar; hard bug fixes ran only as other sets.
 */
const EVIDENCE = [
	{ kind: "feature", difficulty: "medium", arms: ["relay"], n: 10, proven: 5, costUsd: 0.05 },
	{ kind: "feature", difficulty: "medium", arms: ["relay", "claude-code"], n: 10, proven: 10, costUsd: 0.08 },
	{ kind: "other", difficulty: "hard", arms: ["relay", "claude-code"], n: 10, proven: 8, costUsd: 0.4 },
	{ kind: "other", difficulty: "hard", arms: ["relay"], n: 10, proven: 8, costUsd: 0.1 },
	{ kind: "other", difficulty: "easy", arms: ["relay"], n: 6, proven: 6, costUsd: 0.05 },
	{ kind: "other", difficulty: "easy", arms: ["relay", "claude-code"], n: 6, proven: 6, costUsd: 0.15 },
	{ kind: "bug", difficulty: "hard", arms: ["relay", "claude-code"], n: 8, proven: 6, costUsd: 0.3 },
];

test("the router's starting table, the verifier's share and an arm's least budget are the routing lane's, set in relay.arch", () => {
	assert.ok(LANES.routing.arch.includes("router.table"));
	assert.ok(LANES.routing.arch.includes("router.verifierShare"));
	assert.ok(LANES.routing.arch.includes("router.minArmUsd"));
	assert.ok(LANES.routing.decisions.includes("D-101"));
	for (const p of ["router.table", "router.verifierShare", "router.minArmUsd"]) assert.ok(SET_HERE.includes(p), p);
	const arch = fakeArch();
	const archText = fakeArchText();
	const via = (lane, path, value) => archProposal({ cycle: "2026-W44", lane, rule: "x", path, value, arch, archText, sources, words: "w", expect: "e" });
	assert.deepEqual(proposalProblems(via("routing", "router.verifierShare", 0.25), { arch }), []);
	assert.deepEqual(proposalProblems(via("routing", "router.minArmUsd", 0.25), { arch }), []);
	assert.match(proposalProblems(via("routing", "router.minGain", 0.1), { arch }).join("\n"), /relay\.arch router\.minGain is outside the routing lane/);
	assert.match(proposalProblems(via("routing", "router.provenHarnesses", []), { arch }).join("\n"), /outside the routing lane/);
	assert.match(proposalProblems(via("config", "router.verifierShare", 0.25), { arch }).join("\n"), /outside the config lane/);
	assert.equal(needsMetaHarness(via("routing", "router.minArmUsd", 0.25)), true);
	assert.equal(needsMetaHarness(via("routing", "routing.deciderShare", 0.2)), false);
});

test("every relay.arch value the loop may set here is one the harness's schema marks set here", { skip: !existsSync(join(HARNESS, ".git")) && "no harness checkout beside this one" }, () => {
	const show = spawnSync("git", ["-C", HARNESS, "show", "origin/main:relay.arch.schema.json"], { encoding: "utf8" });
	assert.equal(show.status, 0, show.stderr);
	const schemaSetHere = setHereFromSchema(JSON.parse(show.stdout));
	for (const p of SET_HERE) assert.ok(schemaSetHere.includes(p), `${p} is not set here in the harness's schema`);
});

test("each run counts on the first row its kind and difficulty match, per set of arms, as the harness reads the table", () => {
	const table = fakeArch().router.table;
	assert.equal(matchingRow(table, { kind: "bug", difficulty: "hard" }).id, "hard-bug");
	assert.equal(matchingRow(table, { kind: "feature", difficulty: "hard" }).id, "hard");
	assert.equal(armSetKey([{ harness: "claude-code", strategy: "direct" }, { harness: "relay", strategy: "plan-first" }]), "relay:plan-first,claude-code:direct");
	const outcomes = fakeArmOutcomes(EVIDENCE);
	for (const o of outcomes) assert.equal(armOutcomeProblem(o), null, "the fixtures are in the import format");
	const ev = routerEvidence({ outcomes, table });
	assert.deepEqual([...ev.keys()].sort(), ["easy", "hard", "hard-bug", "medium"]);
	const medium = ev.get("medium");
	assert.deepEqual([...medium.keys()].sort(), ["relay:direct", "relay:direct,claude-code:direct"]);
	const pair = medium.get("relay:direct,claude-code:direct");
	assert.deepEqual([pair.runs, pair.proven, Math.round(pair.costUsd * 100) / 100, pair.tasks.size], [10, 10, 0.8, 10]);
	assert.equal(setWords(pair.arms), "two attempts at once, Relay and Claude Code");
	assert.equal(setWords([{ harness: "relay", strategy: "reproduce-first" }]), "one Relay attempt reproducing the problem first");
});

test("a set of arms that proved more per dollar on a row's tasks becomes that row's proposal; the rest say why not", () => {
	const arch = fakeArch();
	const archText = fakeArchText();
	const outcomes = fakeArmOutcomes(EVIDENCE);
	const { candidates, notes } = routerCandidates({ cycle: "2026-W44", outcomes, arch, archText, settings: many, sources });
	assert.deepEqual(candidates.map((c) => c.rule).sort(), ["router-hard", "router-medium"]);
	assert.ok(notes.some((n) => /^router easy: no set of arms gave more proven results per dollar than its own \(one Relay attempt, 6 of 6\)/.test(n)), notes.join("\n"));
	assert.ok(notes.some((n) => /^router hard-bug: its own arms \(two attempts at once, Relay reproducing the problem first and Claude Code\) have 0 benchmark runs, fewer than 5/.test(n)));

	const medium = candidates.find((c) => c.rule === "router-medium");
	assert.equal(medium.lane, "routing");
	assert.deepEqual(medium.touches, { arch: ["router.table"], files: ["relay.arch.json"] });
	assert.equal(medium.change.setHere, true);
	assert.equal(medium.title, "routing: router.table, the medium row from one Relay attempt to two attempts at once, Relay and Claude Code");
	assert.deepEqual([medium.evidence.own.runs, medium.evidence.own.proven, medium.evidence.proposed.runs, medium.evidence.proposed.proven], [10, 5, 10, 10]);
	assert.ok(medium.evidence.proposed.provenPerDollar > medium.evidence.own.provenPerDollar);
	assert.match(medium.words, /in the benchmark runs they gave 12\.5 proven results a dollar \(10 of 10, about \$0\.080 a task\), against 10\.0 \(5 of 10/);
	assert.deepEqual(proposalProblems(medium, { arch }), []);
	assert.equal(needsMetaHarness(medium), true);
	const after = archAfter(medium.patch, archText);
	const row = after.router.table.find((r) => r.id === "medium");
	assert.deepEqual(row.arms, [{ harness: "relay", strategy: "direct" }, { harness: "claude-code", strategy: "direct", otherwise: { harness: "relay", strategy: "plan-first" } }], "Claude Code's place is taken by Relay planning first when it cannot be used");
	assert.match(row.words, /^In Relay's benchmark runs \(week 2026-W44\), on tasks this row starts, two attempts at once, Relay and Claude Code gave a proven result 10 of 10 times/);
	assert.deepEqual(after.router.table.filter((r) => r.id !== "medium"), arch.router.table.filter((r) => r.id !== "medium"), "only that row moves");
	assert.equal(after.router.verifierShare, 0.2);

	const hard = candidates.find((c) => c.rule === "router-hard");
	const hardRow = archAfter(hard.patch, archText).router.table.find((r) => r.id === "hard");
	assert.deepEqual(hardRow.arms, [{ harness: "relay", strategy: "direct" }], "8 of 10 for $0.10 a run, against 8 of 10 for $0.40");
	assert.equal(hard.evidence.dropPoints, 0);

	// One routing proposal a cycle, the heaviest evidence first; the other is held for a later cycle.
	const one = selectProposals(candidates, { settings: SETTINGS, arch, sources });
	assert.equal(one.proposals.filter((p) => p.lane === "routing").length, 1);
	assert.equal(one.held.length, 1);
	assert.deepEqual(one.refused, []);
});

test("a cheaper set proven more than the gate's margin less often, or too few runs, proposes nothing", () => {
	const arch = fakeArch();
	const archText = fakeArchText();
	const drop = fakeArmOutcomes([
		{ kind: "other", difficulty: "hard", arms: ["relay", "claude-code"], n: 10, proven: 9, costUsd: 0.4 },
		{ kind: "other", difficulty: "hard", arms: ["relay"], n: 10, proven: 6, costUsd: 0.05 },
	]);
	const r = routerCandidates({ cycle: "2026-W44", outcomes: drop, arch, archText, settings: many, sources });
	assert.deepEqual(r.candidates, []);
	assert.ok(r.notes.some((n) => /^router hard: one Relay attempt gave more proven results per dollar, but 30\.0 points less often than its own arms \(6 of 10 against 9 of 10\), past the gate's 5-point margin/.test(n)), r.notes.join("\n"));
	const few = fakeArmOutcomes([
		{ kind: "feature", difficulty: "medium", arms: ["relay"], n: 10, proven: 2, costUsd: 0.05 },
		{ kind: "feature", difficulty: "medium", arms: ["relay", "claude-code"], n: 4, proven: 4, costUsd: 0.06 },
	]);
	assert.deepEqual(routerCandidates({ cycle: "2026-W44", outcomes: few, arch, archText, settings: many, sources }).candidates, [], "4 runs are fewer than the loop's 5");
	const off = { ...many, lanes: { ...many.lanes, routing: { ...many.lanes.routing, enabled: false } } };
	assert.deepEqual(routerCandidates({ cycle: "2026-W44", outcomes: fakeArmOutcomes(EVIDENCE), arch, archText, settings: off, sources }), { candidates: [], notes: [] });
	const { router: _, ...older } = arch;
	assert.deepEqual(routerCandidates({ cycle: "2026-W44", outcomes: fakeArmOutcomes(EVIDENCE), arch: older, archText, settings: many, sources }).notes, ["router: this relay.arch has no router table (relay-harness D-101)"]);
	assert.deepEqual(rowArms([{ harness: "relay", strategy: "reproduce-first" }, { harness: "codex", strategy: "direct" }], { kinds: ["bug"], arms: [] }), [{ harness: "relay", strategy: "reproduce-first" }, { harness: "codex", strategy: "direct", otherwise: { harness: "relay", strategy: "plan-first" } }]);
});

/** A throwaway harness holding the fake relay.arch, as loop/cycle.test.mjs makes one. */
function fakeHarness() {
	const dir = mkdtempSync(join(tmpdir(), "router-harness-"));
	writeFileSync(join(dir, "relay.arch.json"), fakeArchText());
	for (const [file, text] of Object.entries(SOURCES)) {
		mkdirSync(join(dir, dirname(file)), { recursive: true });
		writeFileSync(join(dir, file), text);
	}
	const git = (...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir });
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git("commit", "-q", "-m", "champion");
	return dir;
}

test("the weekly cycle reads the arm outcomes only when given them, and keeps what it read", async () => {
	const p = practiceTasks({ everyday: 6, long: 0 });
	const records = writeRecords(join(p.root, "runs"), ["py-e0", "py-e1", "py-e2"].map((task) => record({ task, share: 1 })));
	const settingsPath = join(p.root, "settings.json");
	writeFileSync(settingsPath, serializeSettings(approve(SETTINGS, { by: "arnav" }).settings));
	const file = join(p.root, "arm-outcomes.jsonl");
	writeFileSync(file, `${fakeArmOutcomes(EVIDENCE).map((l) => JSON.stringify(l)).join("\n")}\n{"not":"an outcome"}\n`);
	const base = { cycle: "2026-W44", settingsPath, records: [records], tasksDirs: [p.tasks], harness: fakeHarness(), harnessRef: "HEAD", champion: "0.6.121", dryRun: true };
	const off = await runCycle({ ...base, out: join(p.root, "loop-off") });
	assert.ok(!(off.state.proposals ?? []).some((x) => x.rule?.startsWith("router-")), "off unless --arm-outcomes is given");
	const on = await runCycle({ ...base, out: join(p.root, "loop-on"), armOutcomes: file });
	const router = on.state.proposals.filter((x) => x.rule?.startsWith("router-"));
	assert.equal(router.length, 1, "the routing lane's one proposal");
	assert.equal(on.state.armOutcomes.outcomes, fakeArmOutcomes(EVIDENCE).length);
	assert.equal(on.state.armOutcomes.leftOut, 1);
	assert.match(on.state.armOutcomes.sha256, /^[0-9a-f]{64}$/);
	assert.ok(on.state.notes.some((n) => /^router: 1 lines of .* are not arm outcomes and were left out \(line \d+: at is not a time\)/.test(n)));
	assert.ok(on.state.held.some((id) => id.includes("router-")), "the other row's proposal waits for a later cycle");
	const missing = await runCycle({ ...base, out: join(p.root, "loop-missing"), armOutcomes: join(p.root, "none.jsonl") });
	assert.ok(missing.state.notes.some((n) => /^router: no arm outcomes at /.test(n)));
});

test("a router proposal is pre-screened and gated with the meta-harness on for both arms; other changes are not", async () => {
	assert.deepEqual(ARMS.relay.env({ meta: true }), { RELAY_META: "1" });
	assert.deepEqual(ARMS.relay.env({ model: "claude-haiku-5-5" }), {});
	assert.deepEqual(ARMS.relay.env(), {});

	const arch = fakeArch();
	const archText = fakeArchText();
	const router = routerCandidates({ cycle: "2026-W44", outcomes: fakeArmOutcomes(EVIDENCE), arch, archText, settings: many, sources }).candidates.find((c) => c.rule === "router-medium");
	const config = archProposal({ cycle: "2026-W44", lane: "config", rule: "x", path: "queue.maxAttempts", value: 3, arch, archText, sources, words: "w", expect: "e" });
	const ps = mkdtempSync(join(tmpdir(), "router-prescreen-"));
	const t = practiceTasks({ everyday: 6, long: 0 });
	const packages = join(ps, "packages");
	mkdirSync(packages, { recursive: true });
	for (const x of [router, config]) writeFileSync(join(packages, `${x.id}.tgz`), "a made-up build");
	const calls = [];
	const exam = examWithCheck();
	const tierIds = (dir, tier) => [...readTasks(dir)].filter(([, v]) => v.tier === tier).map(([id]) => id);
	await prescreen({
		proposals: [router, config],
		cycleDir: ps,
		settings: SETTINGS,
		money: wallet({ settings: SETTINGS, cap: 20 }),
		champion: "0.6.121",
		model: "claude-haiku-5-5",
		practiceTasksDir: t.tasks,
		devTasks: t.ids,
		exam: exam.root,
		packages,
		exec: fakeExec({ calls, candidate: () => 1, champion: () => 0.5, real: { tierIds, "scripts/check-query.mjs": (args) => nodeScript("scripts/check-query.mjs", args) } }),
	});
	const stages = calls.filter((c) => c[0] === "runner/run-stage.mjs");
	const of = (id) => stages.filter((c) => c[c.indexOf("--test") + 1].includes(id));
	assert.ok(of(router.id).length >= 1);
	for (const c of of(router.id)) assert.ok(c.includes("--relay-meta"), "every stage judging the router change");
	for (const c of of(config.id)) assert.ok(!c.includes("--relay-meta"));

	const cycleDir = mkdtempSync(join(tmpdir(), "router-package-"));
	const passed = { id: router.id, lane: "routing", status: "passed", dev: { tasks: 24, difference: 1, low: -2, high: 4, costRatio: 1, timeRatio: 1, safetyFlags: 0 }, selection: { status: "pass", query: 1 } };
	const pkg = packageRelease({ cycle: "2026-W44", cycleDir, results: [passed], proposals: [router], arch, archText, sources, ledger: emptyLedger(), champion: "0.6.121", release: "0.6.122-loop.2026w44", model: "claude-haiku-5-5" });
	assert.equal(pkg.relayMeta, true);
	assert.match(pkg.body, /`router\.table`, the medium row from one Relay attempt to two attempts at once, Relay and Claude Code \(set in relay\.arch, D-91\)/);
	assert.match(pkg.body, /\*\*Why:\*\* the benchmark's arm outcomes on the tasks this row starts: two attempts at once, Relay and Claude Code gave a proven result 10 of 10 times/);
	assert.match(pkg.body, /every Relay arm with it on, the champion's and the candidate's alike \(`--relay-meta`, GATE\.md amendment 5\)/);
	assert.match(pkg.body, /--relay-meta --model claude-haiku-5-5/);

	// The autopilot's gate takes it from the cycle's package.
	const dir = mkdtempSync(join(tmpdir(), "router-autopilot-"));
	const st = { build: "0.6.122-loop.2026w44", champion: "0.6.121", release: { package: "/x/relay.tgz" } };
	const o = { model: "claude-haiku-5-5", gate: { reps: 1, capUsdPerRun: 1 }, exam: "/exam" };
	const ready = { tasksDir: "/exam/tasks", usable: ["a", "b"], anchors: "/exam/anchors/anchors-v1.json" };
	const design = { looks: 1, plannedTasks: 2 };
	assert.ok(!gateArgs({ st, o, ready, dir, design }).includes("--relay-meta"));
	writeFileSync(join(dir, "cycle.json"), JSON.stringify({ package: { lanes: [], relayMeta: true } }));
	assert.ok(gateArgs({ st, o, ready, dir, design }).includes("--relay-meta"));
});

test("the gate fixes the meta-harness for both arms at its first run, and passes it to every run of the stage", () => {
	const root = mkdtempSync(join(tmpdir(), "router-gate-"));
	const tasks = join(root, "tasks");
	for (let i = 0; i < 20; i++) {
		mkdirSync(join(tasks, `p${i}`), { recursive: true });
		writeFileSync(join(tasks, `p${i}`, "task.json"), JSON.stringify({ id: `p${i}`, kind: "everyday" }));
	}
	const gate = (extra) => spawnSync(process.execPath, [join(ROOT, "runner", "gate.mjs"), "--champion", "0.6.121", "--candidate", "0.6.122", "--run", "--test", "dev-meta", "--tasks-dir", tasks, "--out", join(root, "runs"), "--model", "claude-haiku-5-5", "--cap-usd", "1", "--stage-cap-usd", "5", "--e2b-cap-usd", "5", "--plan-tasks", "20", ...extra], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root } });
	const dry = gate(["--relay-meta", "--dry-run"]);
	assert.equal(dry.status, 0, dry.stderr);
	assert.match(dry.stdout, /every Relay arm runs with its meta-harness on \(RELAY_META=1\)/);
	const state = join(root, "runs", "dev-meta.looks.json");
	mkdirSync(dirname(state), { recursive: true });
	writeFileSync(state, JSON.stringify({ test: "dev-meta", champion: "relay@0.6.121", candidate: "relay@0.6.122", tier: "practice", design: { spending: "fixed", looks: 1, plannedTasks: 20 }, order: null, looks: [], decided: null, relayMeta: true }));
	const changed = gate(["--dry-run"]);
	assert.notEqual(changed.status, 0);
	assert.match(changed.stderr, /this gate runs Relay with the meta-harness on \(--relay-meta\); it never changes mid-gate/);
});
