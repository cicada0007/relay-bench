// runner/gate.mjs end to end on throwaway folders and made-up records: no model, no sandbox, nothing spent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { anchorsPathFor, makeAnchors, writeAnchors } from "./anchors.mjs";
import { exposurePathFor, readExposures } from "./exposure.mjs";

const GATE = new URL("./gate.mjs", import.meta.url).pathname;
const CHAMP = "relay@0.6.121";
const CAND = "relay@0.6.122";

function gate(args, env = {}) {
	const r = spawnSync(process.execPath, [GATE, "--champion", "0.6.121", "--candidate", "0.6.122", ...args], { encoding: "utf8", env: { ...process.env, ...env } });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Appends graded runs for tasks [from, to): the champion meets `champ`, the candidate `cand(i)`. */
function addRecords(out, test, from, to, champ, cand, prefix = "t") {
	mkdirSync(out, { recursive: true });
	const lines = [];
	for (let i = from; i < to; i++) {
		const task = `${prefix}${String(i).padStart(3, "0")}`;
		for (const [tool, share] of [
			[CHAMP, champ],
			[CAND, cand(i)],
		]) {
			lines.push(JSON.stringify({ runId: `${test}-${task}-${tool}`, test, task, taskKind: "everyday", tool, rep: 1, score: { share }, usage: { costUsd: 0.1 }, wallMs: 60_000 }));
		}
	}
	appendFileSync(join(out, "records.jsonl"), `${lines.join("\n")}\n`);
}

test("with no plan, a gate reads as before: every read is its one look, and nothing is kept between reads", () => {
	const out = mkdtempSync(join(tmpdir(), "gate-cli-"));
	addRecords(out, "g", 0, 100, 0.2, () => 0.8);
	const r = gate(["--test", "g", "--out", out]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /^PASS · better/);
	const result = JSON.parse(readFileSync(join(out, "g.gate.json"), "utf8"));
	assert.equal(result.version, 2);
	assert.equal(existsSync(join(out, "g.looks.json")), false);
});

test("a sequential gate waits for each planned look, keeps its looks, and stays stopped once it decides", () => {
	const out = mkdtempSync(join(tmpdir(), "gate-cli-"));
	const plan = ["--looks", "3", "--plan-tasks", "90"];
	addRecords(out, "s", 0, 25, 0.5, (i) => (i % 2 ? 0.5 : 0.6));
	const waiting = gate(["--test", "s", "--out", out, ...plan]);
	assert.equal(waiting.code, 20);
	assert.match(waiting.out, /waiting for look 1/);

	addRecords(out, "s", 25, 30, 0.5, (i) => (i % 2 ? 0.5 : 0.6));
	const first = gate(["--test", "s", "--out", out, ...plan]);
	assert.equal(first.code, 20, first.err);
	assert.match(first.out, /continue/);
	const again = gate(["--test", "s", "--out", out]);
	assert.equal(again.code, 20);
	let state = JSON.parse(readFileSync(join(out, "s.looks.json"), "utf8"));
	assert.equal(state.looks.length, 1, "reading the same look again takes no new look");

	assert.match(gate(["--test", "s", "--out", out, "--looks", "4", "--plan-tasks", "90"]).err, /fixed at its first look/);

	addRecords(out, "s", 30, 60, 0.2, () => 1);
	const second = gate(["--test", "s", "--out", out]);
	assert.equal(second.code, 0, second.out + second.err);
	state = JSON.parse(readFileSync(join(out, "s.looks.json"), "utf8"));
	assert.equal(state.looks.length, 2);
	assert.equal(state.decided.status, "PASS");

	addRecords(out, "s", 60, 90, 0.9, () => 0);
	const later = gate(["--test", "s", "--out", out]);
	assert.equal(later.code, 0);
	assert.match(later.out, /stopped at look 2/);
});

function exam(n) {
	const root = mkdtempSync(join(tmpdir(), "gate-exam-"));
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
	return { root, tasks, anchors, out: join(root, "runs", "gate") };
}

test("a counted exam gate needs a plan and an anchor set, and counts each look against the leak budget", () => {
	const e = exam(100);
	addRecords(e.out, "gate-0.6.122", 0, 100, 0.2, () => 0.8);
	const base = ["--test", "gate-0.6.122", "--tier", "exam", "--tasks-dir", e.tasks, "--out", e.out];
	assert.match(gate([...base, "--plan-tasks", "100"]).err, /anchor set/);
	assert.match(gate([...base, "--anchors", e.anchors]).err, /fixes its planned tasks/);

	writeFileSync(join(e.root, "leak-budget.json"), JSON.stringify({ exam: { readsPerTask: 0 } }));
	const refused = gate([...base, "--plan-tasks", "100", "--anchors", e.anchors]);
	assert.equal(refused.code, 20);
	assert.match(refused.out, /leak budget spent/);
	assert.deepEqual(readExposures(exposurePathFor(e.tasks)), [], "a refused read is not counted");

	writeFileSync(join(e.root, "leak-budget.json"), "{}");
	const r = gate([...base, "--plan-tasks", "100", "--anchors", e.anchors]);
	assert.equal(r.code, 0, r.out + r.err);
	assert.match(r.out, /anchors anchors-v1/);
	const reads = readExposures(exposurePathFor(e.tasks));
	assert.equal(reads.length, 1);
	assert.equal(reads[0].kind, "read");
	assert.equal(reads[0].tasks.length, 100);
});

test("a combined candidate's manifest is checked before anything is read", () => {
	const out = mkdtempSync(join(tmpdir(), "gate-cli-"));
	addRecords(out, "c", 0, 100, 0.2, () => 0.8);
	const manifest = join(out, "lanes.json");
	writeFileSync(manifest, JSON.stringify({ release: "0.6.122", lanes: [{ lane: "prompts", change: "a1" }] }));
	assert.match(gate(["--test", "c", "--out", out, "--combined", manifest]).err, /at least two lane changes/);
	writeFileSync(manifest, JSON.stringify({ release: "0.6.122", lanes: [{ lane: "prompts", change: "a1" }, { lane: "tools", change: "b2" }] }));
	const r = gate(["--test", "c", "--out", out, "--combined", manifest]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /combined +prompts a1, tools b2/);
});

test("--run --dry-run plans the first look's tasks, anchors first, and spends nothing", () => {
	const root = mkdtempSync(join(tmpdir(), "gate-run-"));
	const tasks = join(root, "tasks");
	for (let i = 0; i < 40; i++) {
		mkdirSync(join(tasks, `p${i}`), { recursive: true });
		writeFileSync(join(tasks, `p${i}`, "task.json"), JSON.stringify({ id: `p${i}`, kind: "everyday" }));
	}
	const r = gate(["--run", "--dry-run", "--test", "dev-g", "--tasks-dir", tasks, "--out", join(root, "runs"), "--model", "claude-haiku-5-5", "--cap-usd", "1", "--stage-cap-usd", "5", "--e2b-cap-usd", "5", "--looks", "2", "--plan-tasks", "40"]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /look 1: 20 of 40 planned tasks/);
	assert.match(r.out, /40 runs planned/);
	assert.equal(existsSync(join(root, "runs", "dev-g.looks.json")), false, "a dry run keeps no state");
});
