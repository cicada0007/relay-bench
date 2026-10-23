// loop/meta.mjs on a made-up ledger and made-up cycles: the loop's own settings are judged by gated gain per dollar,
// changes to them are proposed and never applied, and only a person's approval changes the settings file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendEntry, emptyLedger } from "../scripts/ledger.mjs";
import { approvalProblems, approve, judgeMeta, metaProblems, metaProposals, readCycles, serializeSettings, settingsHash } from "./meta.mjs";
import { changeId } from "./package.mjs";

const SETTINGS_FILE = new URL("./settings.json", import.meta.url).pathname;
const SETTINGS = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
const META = new URL("./meta.mjs", import.meta.url).pathname;

const weeks = (n, from = 40) => Array.from({ length: n }, (_, i) => `2026-W${String(from + i).padStart(2, "0")}`);
/** A cycle's summary, as loop/cycle.mjs writes it. */
const summary = (cycle, spend, settings = SETTINGS, lanes = {}) => ({ cycle, settingsHash: settingsHash(settings), settings: { lanes: settings.lanes, clusters: settings.clusters }, clusters: 3, spend, lanes, packaged: [] });
/** A ledger whose releases carry loop changes from the named cycles. */
function ledgerOf(releases) {
	let ledger = emptyLedger();
	let champion = "0.6.121";
	releases.forEach(({ lanes, gain }, i) => {
		const release = `0.6.${122 + i}`;
		ledger = appendEntry(ledger, { release, champion, date: `2026-10-${10 + i}`, gate: { status: "PASS" }, anchors: { difference: gain, se: 1 }, lanes: lanes.map(([cycle, lane]) => ({ lane, change: changeId(cycle, `${cycle}-${lane}-x`) })) });
		champion = release;
	});
	return ledger;
}

test("gated gain per dollar, per lane, from the ledger and the cycles' spend", () => {
	const [w1, w2, w3, w4] = weeks(4);
	const cycles = [w1, w2, w3, w4].map((c) => summary(c, { config: 2, prompts: 2.5, memory: 2, routing: 0.5 }, SETTINGS, { config: { prescreened: 1, passed: 1, atLimit: true }, prompts: { prescreened: 1, passed: 1, atLimit: true }, memory: { prescreened: 1, passed: 0, atLimit: true } }));
	// Releases: config and prompts together (4 points, shared 2 and 2), config alone (2 points), and one with a change
	// from a cycle outside the window, which does not count.
	const ledger = ledgerOf([
		{ lanes: [[w1, "config"], [w1, "prompts"]], gain: 4 },
		{ lanes: [[w3, "config"]], gain: 2 },
		{ lanes: [["2026-W20", "routing"]], gain: 9 },
	]);
	const j = judgeMeta({ ledger, cycles, settings: SETTINGS });
	assert.equal(j.cycles, 4);
	assert.equal(j.releases.length, 2);
	assert.equal(j.lanes.config.spendUsd, 8);
	assert.equal(j.lanes.config.gainPoints, 4);
	assert.equal(j.lanes.config.gainPerDollar, 0.5);
	assert.equal(j.lanes.prompts.gainPerDollar, 2 / 10);
	assert.equal(j.lanes.memory.gainPoints, 0);
	assert.equal(j.lanes.memory.gainPerDollar, 0);
	assert.equal(j.lanes.routing.gainPoints, 0, "a release whose change came from outside the window is not counted");
	assert.equal(j.overall.gainPerDollar, 6 / 28);
	assert.equal(j.versions.length, 1);

	const ps = metaProposals(j, SETTINGS, { cycle: w4 });
	const off = ps.find((p) => p.rule === "off-memory");
	assert.ok(off, "memory spent and no gated release gained from it");
	assert.equal(off.after.lanes.memory.enabled, false);
	assert.equal(off.after.lanes.memory.budgetUsd, 0);
	assert.equal(off.after.lanes.config.budgetUsd, SETTINGS.lanes.config.budgetUsd + SETTINGS.lanes.memory.budgetUsd, "its budget goes to the lane with the most gain per dollar");
	const move = ps.find((p) => p.rule === "move-prompts-to-config");
	assert.ok(move);
	assert.equal(move.after.lanes.prompts.budgetUsd, 6);
	assert.equal(move.after.lanes.config.budgetUsd, 8);
	assert.ok(move.evidence.projectedPointsPerCycle.after > move.evidence.projectedPointsPerCycle.before);
	for (const p of [off, move]) {
		assert.deepEqual(p.problems, []);
		assert.match(p.diff, /^diff --git a\/loop\/settings.json b\/loop\/settings.json/);
		assert.equal(p.base, settingsHash(SETTINGS));
	}
	// More proposals for a lane whose pre-screens pass and that sits at its limit.
	assert.ok(ps.some((p) => p.rule === "more-config" && p.after.lanes.config.proposals === 2));
	// Proposed, not applied: the settings file is as it was.
	assert.equal(readFileSync(SETTINGS_FILE, "utf8"), serializeSettings(SETTINGS));
});

test("the meta loop judges nothing before its minimum cycles, rolls back settings that bought less per dollar, and lowers a threshold that finds nothing", () => {
	assert.deepEqual(metaProposals(judgeMeta({ ledger: emptyLedger(), cycles: weeks(3).map((c) => summary(c, { config: 1 })), settings: SETTINGS }), SETTINGS), []);

	const older = { ...SETTINGS, lanes: { ...SETTINGS.lanes, prompts: { ...SETTINGS.lanes.prompts, budgetUsd: 10 }, config: { ...SETTINGS.lanes.config, budgetUsd: 4 } } };
	const [a1, a2, a3, a4, b1, b2, b3, b4] = weeks(8);
	const cycles = [...[a1, a2, a3, a4].map((c) => summary(c, { config: 2, prompts: 2 }, older)), ...[b1, b2, b3, b4].map((c) => summary(c, { config: 2, prompts: 2 }))];
	const ledger = ledgerOf([{ lanes: [[a2, "prompts"]], gain: 6 }, { lanes: [[b2, "prompts"]], gain: 1 }]);
	const j = judgeMeta({ ledger, cycles, settings: SETTINGS });
	assert.equal(j.versions.length, 2);
	const back = metaProposals(j, SETTINGS).find((p) => p.rule === "roll-back");
	assert.ok(back, JSON.stringify(j.versions));
	assert.equal(back.after.lanes.prompts.budgetUsd, 10);
	assert.equal(back.after.lanes.config.budgetUsd, 4);
	assert.deepEqual(back.problems, []);

	const quiet = weeks(4).map((c) => ({ ...summary(c, { config: 0 }), clusters: 0 }));
	const lower = metaProposals(judgeMeta({ ledger: emptyLedger(), cycles: quiet, settings: SETTINGS }), SETTINGS).find((p) => p.rule === "fewer-runs-per-cluster");
	assert.equal(lower.after.clusters.minRuns, SETTINGS.clusters.minRuns - 1);
});

test("the meta loop may not raise the budget, touch the pre-screen or its own rules, or turn the runtime lane on", () => {
	const raise = { ...SETTINGS, lanes: { ...SETTINGS.lanes, prompts: { ...SETTINGS.lanes.prompts, budgetUsd: 50 } } };
	assert.match(metaProblems(SETTINGS, raise).join("\n"), /raises the loop's budget/);
	assert.match(metaProblems(SETTINGS, { ...SETTINGS, prescreen: { ...SETTINGS.prescreen, capUsdPerRun: 5 } }).join("\n"), /prescreen.capUsdPerRun is not the meta loop's to change/);
	assert.match(metaProblems(SETTINGS, { ...SETTINGS, meta: { ...SETTINGS.meta, minCycles: 1 } }).join("\n"), /meta.minCycles is not the meta loop's/);
	assert.match(metaProblems(SETTINGS, { ...SETTINGS, lanes: { ...SETTINGS.lanes, runtime: { enabled: true, budgetUsd: 0, proposals: 1 } } }).join("\n"), /runtime lane is documented only/);
	assert.match(metaProblems(SETTINGS, { ...SETTINGS, clusters: { minRuns: 1, minTasks: 2 } }).join("\n"), /clusters.minRuns must be/);
});

test("only a person's approval changes the settings, and a cycle may not spend until it has one", () => {
	assert.match(approvalProblems(SETTINGS)[0], /no person has approved/);
	const ok = approve(SETTINGS, { by: "arnav", now: new Date("2026-10-23T00:00:00Z") });
	assert.deepEqual(ok.problems, []);
	assert.deepEqual(approvalProblems(ok.settings), []);
	assert.equal(ok.settings.approved.hash, settingsHash(SETTINGS));
	for (const by of ["claude", "relay-loop", "codex", "gpt-6", "some-agent", ""]) assert.match(approve(SETTINGS, { by }).problems.join("\n"), /model, a tool or an agent/, by);
	// Edited after the approval: refused until approved again.
	const edited = { ...ok.settings, clusters: { ...ok.settings.clusters, minRuns: 4 } };
	assert.match(approvalProblems(edited)[0], /changed after arnav approved them/);

	// A meta proposal is applied only by approve, only on the settings it was made from.
	const proposal = { id: "2026-W44-meta-more-config", base: settingsHash(ok.settings), after: { ...ok.settings, lanes: { ...ok.settings.lanes, config: { ...ok.settings.lanes.config, proposals: 2 } } } };
	const applied = approve(ok.settings, { by: "arnav", proposal });
	assert.deepEqual(applied.problems, []);
	assert.equal(applied.settings.lanes.config.proposals, 2);
	assert.equal(applied.settings.approved.proposal, proposal.id);
	assert.match(approve(edited, { by: "arnav", proposal }).problems.join("\n"), /settings changed since this proposal was made/);
	const greedy = { ...proposal, after: { ...ok.settings, lanes: { ...ok.settings.lanes, config: { ...ok.settings.lanes.config, budgetUsd: 99 } } } };
	assert.match(approve(ok.settings, { by: "arnav", proposal: greedy }).problems.join("\n"), /raises the loop's budget/);

	// The command line: a model is refused and nothing is written; a person's name is recorded.
	const dir = mkdtempSync(join(tmpdir(), "loop-meta-"));
	const path = join(dir, "settings.json");
	writeFileSync(path, serializeSettings(SETTINGS));
	const bad = spawnSync(process.execPath, [META, "approve", "--by", "claude", "--settings", path], { encoding: "utf8" });
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /nothing was written/);
	assert.equal(readFileSync(path, "utf8"), serializeSettings(SETTINGS));
	const good = spawnSync(process.execPath, [META, "approve", "--by", "arnav", "--settings", path], { encoding: "utf8" });
	assert.equal(good.status, 0, good.stderr);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).approved.by, "arnav");
	const judged = spawnSync(process.execPath, [META, "judge", "--settings", path, "--out", join(dir, "none"), "--ledger", join(dir, "ledger.json")], { encoding: "utf8" });
	assert.equal(judged.status, 0, judged.stderr);
	assert.match(judged.stdout, /0 cycles/);
});

test("cycles are read from their summaries, oldest first", () => {
	const out = mkdtempSync(join(tmpdir(), "loop-out-"));
	for (const c of ["2026-W45", "2026-W43", "2026-W44"]) {
		mkdirSync(join(out, c), { recursive: true });
		writeFileSync(join(out, c, "summary.json"), JSON.stringify(summary(c, {})));
	}
	mkdirSync(join(out, "not-a-cycle"));
	assert.deepEqual(readCycles(out).map((c) => c.cycle), ["2026-W43", "2026-W44", "2026-W45"]);
});
