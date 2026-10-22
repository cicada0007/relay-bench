// The hand check of judges, end to end on made-up records: draw 1 run in 10 into a sheet, mark it, read the agreement.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agreement, THRESHOLD } from "./grader-agreement.mjs";
import { draw, fromCsv, loadRuns, sheetRows, toCsv } from "./handcheck.mjs";

const run = (i, task, extra = {}) => ({
	runId: `bar-${task}-r${String(i).padStart(3, "0")}`,
	test: "bar",
	task,
	tool: i % 2 ? "relay@0.6.121" : "claude-code",
	model: "claude-haiku-5-5",
	judge: { requirements: { R1: i % 3 === 0 }, R0: true, checks: { R1: [i % 3 === 0 ? 2 : 1, 2] }, notes: i % 3 === 0 ? {} : { R1: "1 failed: a, b" } },
	...extra,
});
const records = Array.from({ length: 95 }, (_, i) => run(i, `task-${i % 7}`));

test("1 graded run in 10 is drawn, the same way every time for the same seed", () => {
	const withUngraded = [...records, { runId: "lost", task: "task-1", judge: { error: "judge printed no JSON" } }];
	const a = draw(withUngraded);
	assert.equal(a.length, 10);
	assert.ok(!a.some((r) => r.runId === "lost"));
	assert.deepEqual(draw(withUngraded).map((r) => r.runId), a.map((r) => r.runId));
	assert.notDeepEqual(draw(withUngraded, { seed: 7 }).map((r) => r.runId), a.map((r) => r.runId));
	assert.equal(draw(records.slice(0, 3)).length, 1);
});

test("each drawn run gives one row per part, R0 included, with where to read it", () => {
	const rows = sheetRows([records[1]], { tasksDir: "/exam/tasks", recordsDir: "/exam/runs/bar" });
	assert.deepEqual(rows.map((r) => [r.part, r.judge, r.checks]), [["R1", "fail", "1/2"], ["R0", "pass", ""]]);
	assert.equal(rows[0].judge_note, "1 failed: a, b");
	assert.equal(rows[0].request, "/exam/tasks/task-1/request.md");
	assert.equal(rows[0].judge_checks, "/exam/tasks/task-1/judge/CHECKS.md");
	assert.equal(rows[0].result, `/exam/runs/bar/${records[1].runId}/result.tgz`);
});

test("the sheet survives a spreadsheet round trip: commas, quotes and new lines in notes", () => {
	const rows = [{ run: "r1", part: "R1", judge_note: 'says "done", but\nfails', person: "" }];
	const back = fromCsv(toCsv(rows));
	assert.equal(back[0].judge_note, 'says "done", but\nfails');
	assert.equal(back[0].run, "r1");
	assert.equal(fromCsv("a,b\r\n1,2\r\n").length, 1);
});

test("a later grade (rejudged.jsonl) is the one checked", () => {
	const dir = mkdtempSync(join(tmpdir(), "handcheck-"));
	try {
		writeFileSync(join(dir, "records.jsonl"), `${JSON.stringify(records[1])}\n${JSON.stringify({ ...records[2], test: "other" })}\n`);
		writeFileSync(join(dir, "rejudged.jsonl"), `${JSON.stringify({ runId: records[1].runId, judge: { requirements: { R1: true }, R0: true } })}\n`);
		const runs = loadRuns(join(dir, "records.jsonl"), "bar");
		assert.equal(runs.length, 1);
		assert.equal(runs[0].judge.requirements.R1, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a judge people agree with less than 90% of the time is flagged", () => {
	const marks = (task, agree, disagree) => [
		...Array.from({ length: agree }, () => ({ task, person: "agree" })),
		...Array.from({ length: disagree }, () => ({ task, person: "Disagree", run: "r", part: "R1", person_note: "the request never asked for that" })),
	];
	const result = agreement([...marks("good", 9, 1), ...marks("bad", 8, 2), { task: "good", person: "" }, { task: "bad", person: "maybe" }]);
	assert.equal(THRESHOLD, 0.9);
	assert.equal(result.judges.good.agreement, 0.9);
	assert.equal(result.judges.good.flagged, false);
	assert.equal(result.judges.bad.flagged, true);
	assert.deepEqual(result.flagged, ["bad"]);
	assert.equal(result.judges.bad.disagreements[0].note, "the request never asked for that");
	assert.equal(result.unmarked, 1);
	assert.deepEqual(result.unreadable.map((u) => u.mark), ["maybe"]);
	assert.equal(result.overall.agreement, 17 / 20);
});

test("from records to a marked sheet to a verdict, on the command line", () => {
	const dir = mkdtempSync(join(tmpdir(), "handcheck-cli-"));
	const scripts = new URL(".", import.meta.url).pathname;
	try {
		writeFileSync(join(dir, "records.jsonl"), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
		const sheet = join(dir, "sheet.csv");
		const made = spawnSync(process.execPath, [join(scripts, "handcheck.mjs"), "--records", join(dir, "records.jsonl"), "--tasks-dir", "/exam/tasks", "--to", sheet], { encoding: "utf8" });
		assert.equal(made.status, 0, made.stderr);
		assert.match(made.stdout, /10 of 95 runs, 20 parts/);
		const rows = fromCsv(readFileSync(sheet, "utf8"));
		const agreeAll = rows.map((r) => ({ ...r, person: "agree" }));
		writeFileSync(sheet, toCsv(agreeAll));
		const ok = spawnSync(process.execPath, [join(scripts, "grader-agreement.mjs"), sheet], { encoding: "utf8" });
		assert.equal(ok.status, 0, ok.stdout + ok.stderr);
		assert.match(ok.stdout, /100\.0% agree/);
		const task = rows[0].task;
		writeFileSync(sheet, toCsv(rows.map((r) => ({ ...r, person: r.task === task ? "disagree" : "agree" }))));
		const flagged = spawnSync(process.execPath, [join(scripts, "grader-agreement.mjs"), sheet], { encoding: "utf8" });
		assert.equal(flagged.status, 1);
		assert.match(flagged.stdout, new RegExp(`${task}.*FLAGGED`));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
