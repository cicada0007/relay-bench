#!/usr/bin/env node
// The hand check of judges (TIERS.md, "Checked by hand"): draws 1 run in 10 from a records file into a review sheet, one
// row per part of each drawn run (R0 included), for a person to mark whether they agree with the judge's grade.
// scripts/grader-agreement.mjs reads the marked sheets and flags every judge people agree with less than 90% of the time.
//
//   node scripts/handcheck.mjs --records ../relay-exam/runs/bar/records.jsonl --tasks-dir ../relay-exam/tasks \
//     [--test <name>] [--to <sheet.csv>] [--seed 20261015] [--every 10]
//
// The sheet is a CSV file: open it in a spreadsheet, read each run's request, the judge's CHECKS.md and the run's result
// (the paths are in the row), and write "agree" or "disagree" in the person column, with a note when you disagree. It is
// written beside the records (so exam runs stay outside this public repository) unless --to says otherwise.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { rng, SEED } from "../runner/analyze.mjs";

export const COLUMNS = ["run", "test", "task", "tool", "model", "part", "judge", "checks", "judge_note", "person", "person_note", "request", "judge_checks", "result"];

/** One CSV field, quoted when it needs to be. */
const field = (value) => {
	const s = value === undefined || value === null ? "" : String(value);
	return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
export const toCsv = (rows, columns = COLUMNS) => `${[columns, ...rows.map((r) => columns.map((c) => r[c]))].map((r) => r.map(field).join(",")).join("\n")}\n`;

/** Rows of a CSV file as objects keyed by its header; quoted fields may hold commas, quotes and new lines. */
export function fromCsv(text) {
	const rows = [];
	let row = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else cell += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") {
			row.push(cell);
			cell = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else cell += ch;
	}
	if (cell || row.length) {
		row.push(cell);
		rows.push(row);
	}
	const [header, ...body] = rows.filter((r) => r.some((c) => c !== ""));
	return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/** A records file's runs, each with its latest grade (rejudged.jsonl beside it, as runner/analyze.mjs reads it). */
export function loadRuns(recordsPath, test) {
	const runs = readFileSync(recordsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !test || r.test === test);
	const rejudged = join(dirname(recordsPath), "rejudged.jsonl");
	if (existsSync(rejudged)) {
		const latest = new Map(readFileSync(rejudged, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((g) => [g.runId, g]));
		for (const r of runs) if (latest.has(r.runId)) r.judge = latest.get(r.runId).judge;
	}
	return runs;
}

/** 1 graded run in `every`, drawn with a seeded shuffle so the same records and seed always give the same sheet. */
export function draw(runs, { every = 10, seed = SEED } = {}) {
	const graded = runs.filter((r) => r.judge && typeof r.judge.requirements === "object").sort((a, b) => (a.runId < b.runId ? -1 : 1));
	const next = rng(seed);
	for (let i = graded.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[graded[i], graded[j]] = [graded[j], graded[i]];
	}
	return graded.slice(0, Math.ceil(graded.length / every)).sort((a, b) => (a.runId < b.runId ? -1 : 1));
}

/** The sheet's rows for the drawn runs: every part the judge graded, then R0. */
export function sheetRows(runs, { tasksDir, recordsDir }) {
	const rows = [];
	for (const r of runs) {
		const parts = [...Object.keys(r.judge.requirements), "R0"];
		for (const part of parts) {
			const pass = part === "R0" ? r.judge.R0 === true : r.judge.requirements[part] === true;
			const checks = r.judge.checks?.[part];
			rows.push({
				run: r.runId,
				test: r.test,
				task: r.task,
				tool: r.tool,
				model: r.model,
				part,
				judge: pass ? "pass" : "fail",
				checks: Array.isArray(checks) ? `${checks[0]}/${checks[1]}` : "",
				judge_note: r.judge.notes?.[part] ?? "",
				person: "",
				person_note: "",
				request: tasksDir ? join(tasksDir, r.task, "request.md") : "",
				judge_checks: tasksDir ? join(tasksDir, r.task, "judge", "CHECKS.md") : "",
				result: join(recordsDir, r.runId, "result.tgz"),
			});
		}
	}
	return rows;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values } = parseArgs({
		options: {
			records: { type: "string" },
			test: { type: "string" },
			"tasks-dir": { type: "string" },
			to: { type: "string" },
			seed: { type: "string", default: String(SEED) },
			every: { type: "string", default: "10" },
		},
	});
	if (!values.records) throw new Error("--records <records.jsonl> is required");
	const recordsPath = resolve(values.records);
	const runs = loadRuns(recordsPath, values.test);
	const drawn = draw(runs, { every: Number(values.every), seed: Number(values.seed) });
	const rows = sheetRows(drawn, { tasksDir: values["tasks-dir"] && resolve(values["tasks-dir"]), recordsDir: dirname(recordsPath) });
	const to = resolve(values.to ?? join(dirname(recordsPath), `handcheck-${new Date().toISOString().slice(0, 10)}${values.test ? `-${values.test}` : ""}.csv`));
	writeFileSync(to, toCsv(rows));
	console.log(`${to}: ${drawn.length} of ${runs.length} runs, ${rows.length} parts to mark agree or disagree`);
}
