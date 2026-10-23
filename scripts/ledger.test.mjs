// The compound ledger (scripts/ledger.mjs): it is written only from a gate on the exam that stopped with PASS, as the
// records still show it; it is numbers only; its chain shows any later change; its trend adds the anchors' gains.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { anchorsPathFor, makeAnchors, writeAnchors } from "../runner/anchors.mjs";
import { makePin, pinPathFor, writePin } from "../runner/pins.mjs";
import { currentTasks, lockPathFor } from "./lock-tasks.mjs";
import { appendEntry, emptyLedger, ledgerProblems, quarterRange, signerProblems, trend } from "./ledger.mjs";

const GATE = new URL("../runner/gate.mjs", import.meta.url).pathname;
const LEDGER = new URL("./ledger.mjs", import.meta.url).pathname;
const node = (args) => spawnSync(process.execPath, args, { encoding: "utf8" });

function exam(n = 100) {
	const root = mkdtempSync(join(tmpdir(), "ledger-"));
	const tasks = join(root, "tasks");
	for (let i = 0; i < n; i++) {
		const id = `t${String(i).padStart(3, "0")}`;
		const dir = join(tasks, id);
		mkdirSync(join(dir, "repo"), { recursive: true });
		mkdirSync(join(dir, "judge"), { recursive: true });
		writeFileSync(join(dir, "task.json"), JSON.stringify({ id, kind: "everyday", tier: "exam", draftedBy: "openai/gpt-x", approvedBy: "arnav", approvedAt: "2026-10-23" }));
		writeFileSync(join(dir, "request.md"), `Task ${i}.\n`);
		writeFileSync(join(dir, "repo", "a.py"), `x = ${i}\n`);
		writeFileSync(join(dir, "judge", "judge.mjs"), `// judge ${i}\n`);
	}
	const anchors = anchorsPathFor(tasks, "anchors-v1");
	writeAnchors(anchors, makeAnchors({ tasksDir: tasks, ids: Array.from({ length: 20 }, (_, i) => `t${String(i).padStart(3, "0")}`), version: "anchors-v1" }));
	const locked = currentTasks(tasks);
	writeFileSync(lockPathFor(tasks), JSON.stringify({ lockedAt: "2026-10-23T00:00:00Z", tasks: locked }));
	for (const release of ["0.6.122", "0.6.123", "0.6.124"]) writePin(pinPathFor(tasks, release), makePin({ tasksDir: tasks, release }));
	const judges = Object.fromEntries(Object.entries(locked).map(([id, t]) => [id, t.hashes.judge]));
	return { root, tasks, anchors, judges, out: join(root, "runs"), ledger: join(root, "ledger.json") };
}

let JUDGES = {};
function records(out, test, champion, candidate, champ, cand, n = 100) {
	mkdirSync(out, { recursive: true });
	const lines = [];
	for (let i = 0; i < n; i++) {
		const task = `t${String(i).padStart(3, "0")}`;
		for (const [tool, share] of [
			[`relay@${champion}`, champ],
			[`relay@${candidate}`, cand(i)],
		]) {
			lines.push(JSON.stringify({ runId: `${test}-${task}-${tool}`, test, task, taskKind: "everyday", tool, model: "claude-haiku-5-5", rep: 1, score: { share }, usage: { costUsd: 0.1 }, wallMs: 60_000, taskHashes: { judge: JUDGES[task] } }));
		}
	}
	appendFileSync(join(out, "records.jsonl"), `${lines.join("\n")}\n`);
}

function runGate(e, test, champion, candidate, { tier = "exam", extra = [] } = {}) {
	const args = [GATE, "--test", test, "--champion", champion, "--candidate", candidate, "--out", e.out, "--tier", tier, "--plan-tasks", "100", ...extra];
	if (tier === "exam") args.push("--tasks-dir", e.tasks, "--anchors", e.anchors);
	else args.push("--tasks-dir", e.tasks);
	return node(args);
}
const write = (e, test, ...extra) => node([LEDGER, "write", "--test", test, "--out", e.out, "--tasks-dir", e.tasks, "--anchors", e.anchors, "--ledger", e.ledger, "--signed-by", "arnav", ...extra]);

test("the ledger refuses every write that is not a gate on the exam that stopped with PASS", () => {
	const e = exam();
	JUDGES = e.judges;
	const refused = (r, pattern) => {
		assert.equal(r.status, 1, r.stdout + r.stderr);
		assert.match(r.stderr, pattern);
		assert.match(r.stderr, /nothing was written/);
		assert.equal(existsSync(e.ledger), false);
	};
	refused(write(e, "gate-never"), /the gate never looked/);

	records(e.out, "gate-block", "0.6.121", "0.6.122", 0.9, () => 0);
	assert.equal(runGate(e, "gate-block", "0.6.121", "0.6.122").status, 10);
	refused(write(e, "gate-block"), /stopped with BLOCK, not PASS/);

	records(e.out, "gate-practice", "0.6.121", "0.6.122", 0.2, () => 0.8);
	assert.equal(runGate(e, "gate-practice", "0.6.121", "0.6.122", { tier: "practice" }).status, 0);
	refused(write(e, "gate-practice"), /only a gate on the exam/);

	records(e.out, "dev-gate", "0.6.121", "0.6.122", 0.2, () => 0.8);
	assert.equal(runGate(e, "dev-gate", "0.6.121", "0.6.122").status, 0);
	refused(write(e, "dev-gate"), /pilot or dev test/);

	records(e.out, "gate-seq", "0.6.121", "0.6.122", 0.5, (i) => (i % 2 ? 0.5 : 0.6), 34);
	assert.equal(runGate(e, "gate-seq", "0.6.121", "0.6.122", { extra: ["--looks", "3"] }).status, 20);
	refused(write(e, "gate-seq"), /has not decided/);

	// A gate whose kept decision says PASS while its records say otherwise: hand-edited, or graded again later.
	records(e.out, "gate-edited", "0.6.121", "0.6.122", 0.9, () => 0);
	assert.equal(runGate(e, "gate-edited", "0.6.121", "0.6.122").status, 10);
	const statePath = join(e.out, "gate-edited.looks.json");
	const state = JSON.parse(readFileSync(statePath, "utf8"));
	state.decided = { ...state.decided, status: "PASS", label: "better" };
	writeFileSync(statePath, JSON.stringify(state));
	refused(write(e, "gate-edited"), /the records give BLOCK/);

	records(e.out, "gate-regraded", "0.6.121", "0.6.122", 0.2, () => 0.8);
	assert.equal(runGate(e, "gate-regraded", "0.6.121", "0.6.122").status, 0);
	const regrades = Array.from({ length: 100 }, (_, i) => ({ runId: `gate-regraded-t${String(i).padStart(3, "0")}-relay@0.6.122`, rejudgedAt: "2026-10-24", score: { share: 0 } }));
	writeFileSync(join(e.out, "rejudged.jsonl"), `${regrades.map((g) => JSON.stringify(g)).join("\n")}\n`);
	refused(write(e, "gate-regraded"), /the records give UNRESOLVED \(graders not pinned\)/);
});

test("a safety flag found after the gate decided still keeps the release out", () => {
	const e = exam();
	JUDGES = e.judges;
	records(e.out, "gate-0.6.122", "0.6.121", "0.6.122", 0.2, () => 0.8);
	assert.equal(runGate(e, "gate-0.6.122", "0.6.121", "0.6.122").status, 0);
	appendFileSync(join(e.out, "records.jsonl"), `${JSON.stringify({ runId: "late", test: "gate-0.6.122", task: "t999", tool: "relay@0.6.122", safetyFlags: ["secret-leaked"] })}\n`);
	const r = write(e, "gate-0.6.122");
	assert.equal(r.status, 1);
	assert.match(r.stderr, /carry a safety flag/);
});

test("a PASS is written once, numbers only, signed by a person, and chained to the release before it", () => {
	const e = exam();
	JUDGES = e.judges;
	records(e.out, "gate-0.6.122", "0.6.121", "0.6.122", 0.2, (i) => (i < 20 ? 0.3 : 0.8));
	assert.equal(runGate(e, "gate-0.6.122", "0.6.121", "0.6.122").status, 0);
	assert.match(write(e, "gate-0.6.122", "--signed-by", "claude").stderr, /Relay never signs its own release/);
	const first = write(e, "gate-0.6.122");
	assert.equal(first.status, 0, first.stderr);
	const ledger = JSON.parse(readFileSync(e.ledger, "utf8"));
	const entry = ledger.entries[0];
	assert.equal(entry.release, "0.6.122");
	assert.equal(entry.champion, "0.6.121");
	assert.equal(entry.gate.status, "PASS");
	assert.equal(entry.anchors.tasks, 20);
	assert.ok(Math.abs(entry.anchors.difference - 10) < 1e-9);
	assert.ok(entry.anchors.se > 0 && entry.exam.low > 0);
	assert.deepEqual(entry.signers, ["arnav"]);
	assert.match(entry.graders, /^[0-9a-f]{64}$/);
	assert.equal(entry.model, "claude-haiku-5-5");
	const text = JSON.stringify(ledger);
	assert.doesNotMatch(text, /better|worse|"label"/i, "numbers only");
	assert.doesNotMatch(text, /t0\d\d/, "no task names");
	assert.deepEqual(ledgerProblems(ledger), []);
	assert.match(write(e, "gate-0.6.122").stderr, /already in the ledger/);

	records(e.out, "gate-0.6.124", "0.6.123", "0.6.124", 0.2, () => 0.8);
	assert.equal(runGate(e, "gate-0.6.124", "0.6.123", "0.6.124").status, 0);
	assert.match(write(e, "gate-0.6.124").stderr, /last release is 0\.6\.122, but this gate's champion is 0\.6\.123/);
	records(e.out, "gate-0.6.123", "0.6.122", "0.6.123", 0.3, () => 0.8);
	assert.equal(runGate(e, "gate-0.6.123", "0.6.122", "0.6.123").status, 0);
	assert.equal(write(e, "gate-0.6.123").status, 0);
	assert.equal(write(e, "gate-0.6.124", "--chain-start").status, 0, "a new chain is allowed when it says so");
	assert.equal(node([LEDGER, "verify", "--ledger", e.ledger]).status, 0);

	const tampered = JSON.parse(readFileSync(e.ledger, "utf8"));
	tampered.entries[1].anchors.difference = 40;
	writeFileSync(e.ledger, JSON.stringify(tampered));
	const verify = node([LEDGER, "verify", "--ledger", e.ledger]);
	assert.equal(verify.status, 1);
	assert.match(verify.stdout, /entry 2 \(0\.6\.123\) was changed after it was written/);
});

test("the trend adds each release's anchor gain, and its variance", () => {
	let ledger = emptyLedger();
	const releases = [
		["0.6.121", "0.6.122", "2026-10-02", 50, 1, 1],
		["0.6.122", "0.6.123", "2026-10-09", 51, 2, 1],
		["0.6.123", "0.6.124", "2026-10-16", 53, 3, 1],
	];
	for (const [champion, release, date, base, gain, se] of releases) {
		ledger = appendEntry(ledger, { release, champion, date, gate: { status: "PASS" }, anchors: { version: "anchors-v1", champion: base, candidate: base + gain, difference: gain, se } });
	}
	assert.deepEqual(ledgerProblems(ledger), []);
	const t = trend(ledger.entries, quarterRange("2026-Q4"));
	assert.equal(t.withAnchors, 3);
	assert.equal(t.cumulative.points, 6);
	assert.ok(Math.abs(t.cumulative.se - Math.sqrt(3)) < 1e-12);
	assert.ok(Math.abs(t.cumulative.low - (6 - 1.96 * Math.sqrt(3))) < 1e-12);
	assert.equal(t.weeks, 3);
	assert.ok(Math.abs(t.relative.percent - 12) < 1e-12, "6 points on a start of 50");
	assert.ok(Math.abs(t.relativePerWeek.percent - 4) < 1e-12);
	assert.ok(Math.abs(t.slope.pointsPerWeek - 2.5) < 1e-12, "anchor scores 51, 53, 56: a least-squares slope of 2.5");
	assert.deepEqual(t.chainBreaks, []);
	assert.equal(trend(ledger.entries, quarterRange("2027-Q1")).cumulative, null);
	assert.deepEqual(quarterRange("2026-Q1"), { from: "2026-01-01", to: "2026-03-31" });
	assert.throws(() => quarterRange("Q4"), /2026-Q4/);
});

test("only people sign", () => {
	assert.deepEqual(signerProblems(["arnav", "sathwik"]), []);
	for (const name of ["relay", "Claude Opus 5.5", "openai/gpt-6.1-sol", "dependabot[bot]", "codex", "", "an agent"]) assert.ok(signerProblems([name]).length, name);
	assert.match(signerProblems(["arnav", "Arnav"]).join(), /signs twice/);
	assert.match(signerProblems([]).join(), /founder's signature/);
});
