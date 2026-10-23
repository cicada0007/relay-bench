// loop/propose.mjs and loop/lanes.mjs: one proposal in every lane the loop runs, each a diff that applies at the
// champion and stays inside its lane; and every change that reaches an invariant refused, whatever lane it claims.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { serializeLike, setPath, unifiedDiff } from "./diff.mjs";
import { fakeArch, fakeArchText, fakeWriter, SOURCES, sources } from "./fakes.mjs";
import { INVARIANTS, LANE_ORDER, LANES, proposalProblems, symbolSpan } from "./lanes.mjs";
import { archProposal, examProposalProblems, examProposals, ruleCandidates, selectProposals, writeProposal, writerTargets } from "./propose.mjs";
import { worstCostUsd, writerProblems } from "./writer.mjs";

const SETTINGS = JSON.parse(readFileSync(new URL("./settings.json", import.meta.url), "utf8"));
const cluster = (symptom, kind, extra = {}) => ({ id: `c-${symptom}-${kind}`, symptom, kind, words: symptom, lanes: { "false-done": ["config", "prompts"], timeout: ["architecture"], "spend-cap": ["architecture"], "parked-after-retries": ["config"], unsolved: ["tools"], unmet: ["prompts"] }[symptom] ?? [], runs: 6, tasks: ["py-l0", "py-l1", "py-l2"], stacks: ["python3"], notes: ["py-l0 R1: total_due() returned 9, expected 10"], ...extra });

/** Applies a patch to the champion's files with git, as a reviewer would; returns the files after, or throws. */
function applyAtChampion(patch, archText) {
	const dir = mkdtempSync(join(tmpdir(), "loop-champion-"));
	writeFileSync(join(dir, "relay.arch.json"), archText);
	for (const [file, text] of Object.entries(SOURCES)) {
		mkdirSync(join(dir, dirname(file)), { recursive: true });
		writeFileSync(join(dir, file), text);
	}
	writeFileSync(join(dir, "p.patch"), patch);
	const r = spawnSync("git", ["apply", "p.patch"], { cwd: dir, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return (file) => readFileSync(join(dir, file), "utf8");
}

function analysis() {
	return {
		clusters: [cluster("false-done", "long"), cluster("timeout", "long"), cluster("spend-cap", "everyday"), cluster("parked-after-retries", "everyday"), cluster("unsolved", "public", { tasks: ["terminal-bench/a", "terminal-bench/b"], stacks: ["terminal"], notes: [] }), cluster("unmet", "long")],
		routes: {
			"small-low-risk@fast": { row: "small-low-risk", tier: "fast", tasks: 8, meanShare: 0.25 },
			"large-or-cross-file@strong": { row: "large-or-cross-file", tier: "strong", tasks: 8, meanShare: 0.75 },
		},
		learning: { on: { tasks: 6, meanShare: 0.3 }, off: { tasks: 6, meanShare: 0.6 } },
	};
}
const many = { ...SETTINGS, lanes: Object.fromEntries(Object.entries(SETTINGS.lanes).map(([l, v]) => [l, { ...v, proposals: l === "runtime" ? 0 : 3 }])) };

test("the rules lanes each propose a concrete diff: config, routing, memory and architecture", () => {
	const arch = fakeArch();
	const archText = fakeArchText();
	const { candidates, notes } = ruleCandidates({ cycle: "2026-W43", analysis: analysis(), arch, archText, settings: many, sources });
	const { proposals, refused } = selectProposals(candidates, { settings: many, arch, sources });
	assert.deepEqual(refused, []);
	const by = Object.fromEntries(proposals.map((p) => [p.rule, p]));
	// config, set in relay.arch: one line of relay.arch.json, low risk.
	const check = by["request-check-once-more"];
	assert.equal(check.lane, "config");
	assert.deepEqual([check.change.from, check.change.to, check.change.setHere, check.risk], [2, 3, true, "low"]);
	assert.deepEqual(check.touches.arch, ["queue.requestCheck.maxChecks"]);
	assert.equal(JSON.parse(applyAtChampion(check.patch, archText)("relay.arch.json")).queue.requestCheck.maxChecks, 3);
	// config, held in code: relay.arch.json and the constant itself, in one patch.
	const attempts = by["third-attempt"];
	assert.equal(attempts.change.code.patched, true);
	assert.equal(attempts.risk, "medium");
	const after = applyAtChampion(attempts.patch, archText);
	assert.match(after("packages/supervisor/src/store.ts"), /^export const MAX_ATTEMPTS = 3;$/m);
	assert.match(after("packages/supervisor/src/store.ts"), /return MAX_ATTEMPTS - task\.attempts/, "the code around the constant is untouched");
	// routing, from the measured gap between the fast row and the strong tier.
	const route = by["route-small-low-risk-to-strong"];
	assert.equal(route.lane, "routing");
	assert.equal(route.evidence.gapPoints, 50);
	assert.equal(JSON.parse(applyAtChampion(route.patch, archText)("relay.arch.json")).routing.suitability[1].tier, "strong");
	// memory, from the learning ablation's arms: learning on did worse, so refine half as often.
	const memory = by["refine-less-often"];
	assert.equal(memory.lane, "memory");
	assert.equal(memory.change.to.everyTurns, 50);
	assert.equal(memory.change.code.file, "packages/coding-agent/src/core/settings-manager.ts");
	// architecture: a long request out of time lets sub-agents nest deeper; spend caps put children on fast.
	assert.deepEqual([by["one-level-deeper"].change.from, by["one-level-deeper"].change.to], [2, 3]);
	assert.equal(by["children-on-fast"].change.to, "fast");
	assert.ok(proposals.every((p) => p.patch.startsWith("diff --git ")));
	assert.deepEqual(notes, []);

	// At the release's ceiling (3), the depth rule proposes nothing and says why.
	const deeper = setPath(arch, "subAgents.maxDepth", 3);
	const again = ruleCandidates({ cycle: "2026-W43", analysis: analysis(), arch: deeper, archText: serializeLike(deeper, archText), settings: many, sources });
	assert.ok(!again.candidates.some((c) => c.rule === "one-level-deeper"));
	assert.ok(again.notes.some((n) => /one-level-deeper: subAgents.maxDepth is already at the loop's bound/.test(n)));
});

test("a lane keeps only its settings' number of proposals, and a lane turned off proposes nothing", () => {
	const arch = fakeArch();
	const { candidates } = ruleCandidates({ cycle: "2026-W43", analysis: analysis(), arch, archText: fakeArchText(), settings: SETTINGS, sources });
	const { proposals, held } = selectProposals(candidates, { settings: SETTINGS, arch, sources });
	assert.equal(proposals.filter((p) => p.lane === "config").length, 1);
	assert.equal(proposals.filter((p) => p.lane === "architecture").length, 1);
	assert.ok(held.length >= 2);
	const off = { ...SETTINGS, lanes: { ...SETTINGS.lanes, config: { ...SETTINGS.lanes.config, enabled: false } } };
	assert.ok(!ruleCandidates({ cycle: "2026-W43", analysis: analysis(), arch, archText: fakeArchText(), settings: off, sources }).candidates.some((c) => c.lane === "config"));
});

test("the writer lanes: the model's change to a prompt is applied, kept inside that prompt, and paid for", async () => {
	const arch = fakeArch();
	const targets = writerTargets({ analysis: analysis(), arch, settings: SETTINGS });
	assert.deepEqual(targets.map((t) => `${t.lane}|${t.prompt.id}`).sort(), ["prompts|queue.plan", "prompts|queue.requestCheck", "tools|tool.ipython"]);
	const rc = targets.find((t) => t.prompt.id === "queue.requestCheck");
	const file = rc.prompt.file;
	// A model answer with a fence and uneven context: the loop rebuilds the diff itself.
	const answer = `Here is the change.\n\`\`\`diff\n--- a/${file}\n+++ b/${file}\n@@ -6,1 +6,2 @@\n \t"Read the request detail by detail.",\n+\t"Check every case the request names, not only the first.",\n\`\`\`\n`;
	const calls = [];
	const r = await writeProposal({ cycle: "2026-W43", target: rc, source: SOURCES[file], writer: fakeWriter({ diff: answer, calls }), arch });
	assert.equal(r.refused, undefined, JSON.stringify(r.refused));
	assert.equal(calls.length, 1);
	assert.match(calls[0].prompt, /REQUEST_CHECK_PROMPT in src\/queue\/request-check.ts, lines 4 to 7/);
	assert.equal(r.proposal.lane, "prompts");
	assert.equal(r.proposal.costUsd, 0.04);
	assert.match(applyAtChampion(r.proposal.patch, fakeArchText())(file), /not only the first/);

	// The tools lane, the same way.
	const tool = targets.find((t) => t.lane === "tools");
	const toolDiff = `--- a/src/tools/ipython.ts\n+++ b/src/tools/ipython.ts\n@@ -3,1 +3,1 @@\n-\tdescription: "Run Python in a kernel.",\n+\tdescription: "Run Python in a kernel; print what you need to see.",\n`;
	const t = await writeProposal({ cycle: "2026-W43", target: tool, source: SOURCES["src/tools/ipython.ts"], writer: fakeWriter({ diff: toolDiff }), arch });
	assert.equal(t.proposal.lane, "tools");

	// Outside the prompt's declaration: refused, though the patch applies.
	const outside = `--- a/${file}\n+++ b/${file}\n@@ -10,1 +10,1 @@\n-\treturn other(input, REQUEST_CHECK_PROMPT);\n+\treturn other(input, REQUEST_CHECK_PROMPT, { strict: false });\n`;
	const bad = await writeProposal({ cycle: "2026-W43", target: rc, source: SOURCES[file], writer: fakeWriter({ diff: outside }), arch });
	assert.match(bad.refused.join("\n"), /outside REQUEST_CHECK_PROMPT/);
	assert.equal(bad.costUsd, 0.04, "a refused change still counts what it cost");
	// Naming what a practice task needed: refused, it would learn the task.
	const overfit = answer.replace("Check every case the request names, not only the first.", "Make total_due() add the last line.");
	assert.match((await writeProposal({ cycle: "2026-W43", target: rc, source: SOURCES[file], writer: fakeWriter({ diff: overfit }), arch })).refused.join("\n"), /names "total_due", from a practice task's failures/);
	// No diff, or one that does not apply.
	assert.match((await writeProposal({ cycle: "2026-W43", target: rc, source: SOURCES[file], writer: fakeWriter({ diff: "I would not change it." }), arch })).refused[0], /holds no diff/);
	assert.match((await writeProposal({ cycle: "2026-W43", target: rc, source: SOURCES[file], writer: fakeWriter({ diff: answer.replace("detail by detail", "line by line") }), arch })).refused[0], /does not apply/);

	// The writer is never the exam's drafting family, and its worst case is fixed before the call.
	assert.match(writerProblems("gpt-6.1-sol")[0], /drafts the exam/);
	assert.deepEqual(writerProblems("claude-opus-5-5"), []);
	assert.ok(Math.abs(worstCostUsd({ model: "claude-opus-5-5", inputChars: 25_000, maxTokens: 6000 }) - (10_000 * 4 + 6000 * 20) / 1e6) < 1e-12);
});

test("the exam lane proposes kinds of task for a person, never a task and never an approval", () => {
	const ps = examProposals({ cycle: "2026-W43", analysis: analysis(), settings: SETTINGS });
	assert.equal(ps.length, 2);
	assert.deepEqual(ps[0].wanted, { language: "python", kind: "long", minLevel: 2 });
	assert.deepEqual(ps[0].mineArgs, ["--languages", "python"]);
	for (const p of ps) {
		assert.equal(p.approvedBy, null);
		assert.equal(p.status, "waiting for a person");
		assert.deepEqual(examProposalProblems(p), []);
	}
	assert.match(examProposalProblems({ ...ps[0], approvedBy: "relay-loop" })[0], /never approves/);
	assert.match(examProposalProblems({ ...ps[0], source: { pr: "https://github.com/x/y/pull/1" } })[0], /never a task it has seen/);
});

test("the runtime lane is documented only, and every lane is described", () => {
	assert.deepEqual(LANE_ORDER, Object.keys(LANES));
	for (const l of LANE_ORDER) assert.ok(LANES[l].words.length > 20, l);
	const arch = fakeArch();
	assert.match(proposalProblems({ lane: "runtime", touches: { arch: [] }, patch: "" }, { arch })[0], /documented only/);
	assert.match(proposalProblems({ lane: "exam", touches: { arch: [] }, patch: "" }, { arch })[0], /approval queue/);
});

test("the invariants are refused, whatever lane a change claims", () => {
	const arch = fakeArch();
	const archText = fakeArchText();
	const viaArch = (lane, path, value) => archProposal({ cycle: "2026-W43", lane, rule: "x", path, value, arch, archText, sources, words: "w", expect: "e" });
	const refusedFor = (p, sourcesMap = {}) => proposalProblems(p, { arch, sources: sourcesMap }).join("\n");

	// Ceilings.
	assert.match(refusedFor(viaArch("config", "budgets.releaseCeilings.maxUsdPerTask", 50)), /reaches an invariant \(the release's ceilings/);
	assert.match(refusedFor(viaArch("config", "budgets.firstRunSpendCap", { perTaskUsd: 100, perDayUsd: 400 })), /ceilings/);
	assert.match(refusedFor(viaArch("architecture", "subAgents.maxDepth", 5)), /past the release's ceiling of 3/);
	// The trusted core: what a task must pass and may touch.
	assert.match(refusedFor(viaArch("config", "checks.gates", ["test"])), /trusted core/);
	assert.match(refusedFor(viaArch("config", "checks.scopeDeny", [])), /trusted core/);
	// A lane that reaches outside itself, even into a value no invariant names.
	assert.match(refusedFor(viaArch("routing", "selfModel.minSamples", 1)), /outside the routing lane/);
	assert.match(refusedFor(viaArch("config", "routing.deciderShare", 0.5)), /outside the config lane/);

	const filePatch = (file, before = "a\n", after = "b\n") => unifiedDiff(before, after, { path: file });
	const viaFile = (lane, file) => ({ lane, touches: { arch: [] }, patch: filePatch(file), change: { kind: "source", file } });
	const cases = [
		["scripts/release-trust.json", /trusted core/],
		["scripts/release-ceilings.json", /ceilings/],
		["packages/coding-agent/src/core/queue/release-ceilings.generated.ts", /ceilings/],
		["install.sh", /trusted core/],
		["tasks/py-a/judge/judge.mjs", /graders|exam's contents/],
		["scripts/exam-judge/judge.mjs", /graders/],
		["TASKS.lock.json", /exam's contents/],
		["scripts/approve-task.mjs", /exam's contents/],
		["GATE.md", /gate's rules/],
		["runner/gate-analyze.mjs", /gate's rules/],
		["runner/exposure.mjs", /gate's rules/],
		["scripts/check-query.mjs", /gate's rules/],
		["ledger/ledger.json", /gate's rules/],
		["loop/lanes.mjs", /gate's rules/],
		["packages/coding-agent/src/core/telemetry.ts", /tenant data/],
		["packages/coding-agent/src/core/counts/send.ts", /tenant data/],
	];
	for (const [file, why] of cases) {
		for (const lane of ["config", "prompts", "architecture"]) {
			const text = refusedFor(viaFile(lane, file));
			assert.match(text, why, `${lane} ${file}`);
			assert.match(text, /outside the .* lane|reaches an invariant/);
		}
	}
	// A writer lane may not edit relay.arch.json directly, nor a prompt it does not own.
	assert.match(refusedFor({ lane: "prompts", touches: { arch: ["prompts"] }, patch: filePatch("relay.arch.json") }), /changes source, not relay.arch.json/);
	assert.match(refusedFor({ lane: "tools", touches: { arch: [] }, patch: filePatch("src/queue/decider.ts") }), /outside the tools lane/);
	// Every invariant has words and something it covers.
	for (const inv of INVARIANTS) assert.ok(inv.words && (inv.arch.length || inv.files.length), inv.id);
	// selectProposals refuses them with their reasons and keeps nothing of them.
	const sel = selectProposals([viaArch("config", "budgets.releaseCeilings.maxUsdPerTask", 50)], { settings: SETTINGS, arch, sources });
	assert.equal(sel.proposals.length, 0);
	assert.equal(sel.refused.length, 1);
});

test("a declaration's span runs to the next top-level declaration", () => {
	assert.deepEqual(symbolSpan(SOURCES["src/queue/request-check.ts"], "REQUEST_CHECK_PROMPT"), [4, 7]);
	assert.deepEqual(symbolSpan(SOURCES["packages/supervisor/src/store.ts"], "MAX_ATTEMPTS"), [4, 4]);
	assert.equal(symbolSpan(SOURCES["packages/supervisor/src/store.ts"], "NOT_THERE"), null);
});
