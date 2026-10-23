// The living exam's weekly pipeline (scripts/living-exam.mjs) on a throwaway exam, with a fake script runner: nothing
// is mined, drafted or paid for. It checks which steps run, in what order, and where it stops.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DRAFT_COST_USD, runPipeline } from "./living-exam.mjs";

/** Each drafted task's own request: different tasks, different words. */
const REQUESTS = {
	d1: "Dates in the calendar export shift by one day for events that start at midnight.",
	d2: "The command line tool crashes with a traceback when the config file is empty.",
	s1: "Sorting a table by a column with missing values puts them first instead of last.",
};
const PRACTICE = "Tasks in this file are copied word for word from a practice request that the improving loop has read many times over.";

function exam() {
	const root = mkdtempSync(join(tmpdir(), "living-exam-"));
	mkdirSync(join(root, "tasks"), { recursive: true });
	return root;
}
/** The public repository the scan reads, for these tests an empty one: this test file itself is tracked in the real
 *  one, so every request written below is, rightly, loop-visible there. */
const PUBLIC = mkdtempSync(join(tmpdir(), "living-exam-public-"));
const pipeline = (options) => runPipeline({ root: PUBLIC, ...options });
const candidate = (id, over = {}) => ({
	id,
	repo: `owner/${id}`,
	baseCommit: `base-${id}`,
	cutoff: "2026-07-01",
	minedAt: "2026-10-20T00:00:00Z",
	changedLines: 40,
	files: { source: ["a.py"], tests: ["test_a.py"], other: [] },
	pr: { number: 2, title: `Fix ${id}`, mergedAt: "2026-09-12T00:00:00Z" },
	issue: { number: 1, title: `Broken thing in ${id} when called twice`, createdAt: "2026-08-30T00:00:00Z" },
	...over,
});
function fakeExec(calls, behaviour = {}) {
	return (script, args) => {
		calls.push([script, ...args]);
		return behaviour[script]?.(args) ?? { status: 0, stdout: "ok\n", stderr: "" };
	};
}
const steps = (report) => report.map((r) => `${r.step}:${r.status}`);
const writeCandidates = (root, list) => writeFileSync(join(root, "candidates.jsonl"), list.map((c) => `${JSON.stringify(c)}\n`).join(""));
function draftedTask(root, id, extra = {}) {
	const dir = join(root, "tasks", id);
	mkdirSync(join(dir, "repo"), { recursive: true });
	mkdirSync(join(dir, "judge"), { recursive: true });
	writeFileSync(join(dir, "task.json"), JSON.stringify({ id, kind: "everyday", tier: "exam", level: 1, draftedBy: "openai/gpt-x", source: { repo: `owner/${id}`, issue: `https://github.com/owner/${id}/issues/1`, pr: `https://github.com/owner/${id}/pull/2`, issueCreatedAt: "2026-08-30", prMergedAt: "2026-09-12" }, ...extra }));
	writeFileSync(join(dir, "request.md"), `${REQUESTS[id]}\n`);
	writeFileSync(join(dir, "judge", "judge.mjs"), "// judge\n");
}

test("an empty exam runs nothing and says why for every step", async () => {
	const root = exam();
	const calls = [];
	const report = await pipeline({ exam: root, cutoff: "2026-07-01", exec: fakeExec(calls), env: {} });
	assert.deepEqual(steps(report), ["mine:skipped", "filter:skipped", "contamination:skipped", "draft:skipped", "approve:skipped", "lock:skipped", "saturation:skipped"]);
	assert.deepEqual(calls, []);
	assert.ok(report.every((r) => r.why.length > 0));
});

test("mining runs only when asked, with a cutoff and a token, and with the miner's usual command line", async () => {
	const root = exam();
	const calls = [];
	let r = await pipeline({ exam: root, cutoff: "2026-07-01", mine: true, exec: fakeExec(calls), env: {} });
	assert.match(r[0].why, /GITHUB_TOKEN/);
	assert.deepEqual(calls, []);
	r = await pipeline({ exam: root, cutoff: "2026-07-01", mine: true, limit: 25, exec: fakeExec(calls), env: { GITHUB_TOKEN: "x" } });
	assert.equal(r[0].status, "ran");
	assert.deepEqual(calls[0], ["scripts/mine-tasks.mjs", "--cutoff", "2026-07-01", "--out", join(root, "candidates.jsonl"), "--limit", "25"]);
});

test("new candidates are filtered and scanned; a planted duplicate is rejected; the pipeline stops before paying", async () => {
	const root = exam();
	const practice = join(root, "..", `${root.split("/").pop()}-practice`);
	writeCandidates(root, [
		candidate("one"),
		candidate("two", { issue: { number: 1, title: "copied", body: PRACTICE, createdAt: "2026-08-30T00:00:00Z" } }),
		candidate("old", { issue: { number: 1, title: "An old issue from before the models were trained", createdAt: "2026-05-01T00:00:00Z" } }),
	]);
	// The loop has seen the practice text: plant it as an exam task the loop already knows (retired).
	mkdirSync(join(root, "retired", "seen-before"), { recursive: true });
	writeFileSync(join(root, "retired", "seen-before", "task.json"), JSON.stringify({ id: "seen-before", title: "seen", tier: "exam" }));
	writeFileSync(join(root, "retired", "seen-before", "request.md"), PRACTICE);
	const calls = [];
	const report = await pipeline({ exam: root, cutoff: "2026-07-01", exec: fakeExec(calls), env: {} });
	assert.deepEqual(steps(report), ["mine:skipped", "filter:ran", "contamination:ran", "draft:stopped"]);
	assert.equal(report[2].clean, 1);
	assert.equal(report[2].rejected, 2);
	assert.match(report[3].why, /1 candidates wait for drafting, a paid step .* about \$0\.05.*--spend-cap/);
	assert.deepEqual(calls, [], "nothing paid, nothing run");
	const rejected = readFileSync(join(root, "queue", "rejected.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	assert.deepEqual(rejected.map((r) => r.id).sort(), ["old", "two"]);
	assert.match(rejected.find((r) => r.id === "two").reasons.join(), /near-duplicate/);
	assert.ok(!existsSync(practice));

	// The next week the rejected ones are not scanned again.
	const again = await pipeline({ exam: root, cutoff: "2026-07-01", exec: fakeExec([]), env: {} });
	assert.match(again[1].why, /^1 of 3 candidates are new/);
});

test("with a spend cap it drafts while the estimate fits, and only with the drafting key", async () => {
	const root = exam();
	writeCandidates(root, ["a1", "a2", "a3", "a4"].map((id) => candidate(id)));
	const noKey = await pipeline({ exam: root, cutoff: "2026-07-01", spendCap: 1, exec: fakeExec([]), env: {} });
	assert.match(noKey.at(-1).why, /OPENAI_API_KEY/);
	const calls = [];
	const fails = { "scripts/draft-task.mjs": (args) => (args[1] === "a2" ? { status: 1, stdout: "", stderr: "Error: a2: the judge does not validate\n" } : { status: 0, stdout: "", stderr: "" }) };
	const report = await pipeline({ exam: root, cutoff: "2026-07-01", spendCap: 3 * DRAFT_COST_USD, exec: fakeExec(calls, fails), env: { OPENAI_API_KEY: "test-only" } });
	const draft = report.find((r) => r.step === "draft");
	assert.equal(draft.status, "ran");
	assert.equal(calls.length, 3, "three attempts fit a cap of three estimates");
	assert.deepEqual(calls[0], ["scripts/draft-task.mjs", "--candidate", "a1", "--candidates", join(root, "candidates.jsonl"), "--tasks-dir", join(root, "tasks"), "--tier", "exam", "--level", "1"]);
	assert.equal(draft.drafted, 2);
	assert.equal(draft.failed, 1);
	assert.match(readFileSync(join(root, "queue", "rejected.jsonl"), "utf8"), /a2: the judge does not validate/);
});

test("drafted tasks are queued for a person, scanned again; approved ones are locked", async () => {
	const root = exam();
	draftedTask(root, "d1");
	draftedTask(root, "d2", { approvedBy: "arnav", approvedAt: "2026-10-23T00:00:00Z" });
	const calls = [];
	const report = await pipeline({ exam: root, cutoff: "2026-07-01", from: "approve", exec: fakeExec(calls), env: {} });
	assert.deepEqual(steps(report), ["approve:ran", "lock:ran", "saturation:skipped"]);
	const queued = readFileSync(join(root, "queue", "approve.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	assert.deepEqual(queued.map((q) => [q.id, q.clean]), [["d1", true]]);
	assert.deepEqual(calls.map((c) => c[0]), ["scripts/build-review-page.mjs", "scripts/lock-tasks.mjs"]);
});

test("a saturated level opens a harder queue, and harder candidates wait until it is open", async () => {
	const root = exam();
	draftedTask(root, "s1", { approvedBy: "arnav", approvedAt: "2026-10-23" });
	writeCandidates(root, [candidate("big", { changedLines: 200, files: { source: ["a.py", "b.py"], tests: [], other: [] } })]);
	const records = join(root, "records.jsonl");
	for (let i = 0; i < 50; i++) appendFileSync(records, `${JSON.stringify({ tool: "relay@0.6.121", task: "s1", score: { share: i < 46 ? 1 : 0 }, finishedAt: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z` })}\n`);
	const before = await pipeline({ exam: root, cutoff: "2026-07-01", exec: fakeExec([]), env: {} });
	assert.match(before.find((r) => r.step === "draft").why, /1 candidates wait for a harder level to open/);
	const sat = await pipeline({ exam: root, cutoff: "2026-07-01", from: "saturation", records: [records], tool: "relay@0.6.121", exec: fakeExec([]), env: {} });
	assert.deepEqual(sat[0].opened.map((o) => [o.tier, o.level]), [["exam", 2]]);
	const after = await pipeline({ exam: root, cutoff: "2026-07-01", exec: fakeExec([]), env: {} });
	assert.equal(after.find((r) => r.step === "draft").status, "stopped", "the level-2 candidate now waits for drafting");
});

test("the pipeline refuses an exam folder inside this public repository", async () => {
	await assert.rejects(pipeline({ exam: new URL("..", import.meta.url).pathname, exec: fakeExec([]), env: {} }), /outside this public repository/);
});
