#!/usr/bin/env node
// How often people agree with each judge, from hand-check sheets (scripts/handcheck.mjs) a person has marked. A judge is
// a task's judge; every marked part of every run drawn for that task counts once. TIERS.md: a judge that disagrees with
// people more than one time in ten is flagged here, then fixed for every tool alike and its tasks graded again.
//
//   node scripts/grader-agreement.mjs <sheet.csv> [<sheet.csv> ...] [--json]
//
// Exit codes: 0 when no judge is flagged, 1 when one is, 2 when a sheet has a mark that is neither agree nor disagree.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fromCsv } from "./handcheck.mjs";

/** Agreement below this share flags the judge. */
export const THRESHOLD = 0.9;

/** Per judge: parts marked, agreed, disagreed, the share agreed and whether it is flagged; plus the marks it could not read. */
export function agreement(rows, threshold = THRESHOLD) {
	const judges = {};
	const unreadable = [];
	let unmarked = 0;
	rows.forEach((row, i) => {
		const mark = String(row.person ?? "").trim().toLowerCase();
		if (!mark) {
			unmarked++;
			return;
		}
		if (mark !== "agree" && mark !== "disagree") {
			unreadable.push({ row: i + 2, task: row.task, mark: row.person });
			return;
		}
		const j = (judges[row.task] ??= { marked: 0, agree: 0, disagree: 0, disagreements: [] });
		j.marked++;
		j[mark]++;
		if (mark === "disagree") j.disagreements.push({ run: row.run, part: row.part, judge: row.judge, note: row.person_note });
	});
	for (const j of Object.values(judges)) {
		j.agreement = j.agree / j.marked;
		j.flagged = j.agreement < threshold;
	}
	const marked = Object.values(judges).reduce((s, j) => s + j.marked, 0);
	const agreed = Object.values(judges).reduce((s, j) => s + j.agree, 0);
	return {
		threshold,
		judges,
		flagged: Object.keys(judges).filter((t) => judges[t].flagged).sort(),
		overall: { marked, agree: agreed, agreement: marked ? agreed / marked : null },
		unmarked,
		unreadable,
	};
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values, positionals } = parseArgs({ options: { json: { type: "boolean", default: false } }, allowPositionals: true });
	if (!positionals.length) throw new Error("usage: node scripts/grader-agreement.mjs <sheet.csv> [<sheet.csv> ...] [--json]");
	const rows = positionals.flatMap((path) => fromCsv(readFileSync(path, "utf8")));
	const result = agreement(rows);
	if (values.json) console.log(JSON.stringify(result, null, 2));
	else {
		const pct = (x) => (x === null ? "–" : `${(100 * x).toFixed(1)}%`);
		console.log("judge                                    marked  agree  disagree  agreement");
		for (const [task, j] of Object.entries(result.judges).sort()) {
			console.log(`${task.padEnd(40)} ${String(j.marked).padStart(6)} ${String(j.agree).padStart(6)} ${String(j.disagree).padStart(9)}  ${pct(j.agreement).padStart(9)}${j.flagged ? "  FLAGGED" : ""}`);
		}
		console.log(`all judges: ${result.overall.marked} parts marked, ${pct(result.overall.agreement)} agree; ${result.unmarked} not marked yet`);
		if (result.flagged.length) console.log(`below ${pct(result.threshold)}: ${result.flagged.join(", ")}; fix these judges for every tool, then grade their tasks again (runner/rejudge.mjs)`);
		for (const u of result.unreadable) console.log(`row ${u.row} (${u.task}): "${u.mark}" is neither agree nor disagree`);
	}
	process.exitCode = result.unreadable.length ? 2 : result.flagged.length ? 1 : 0;
}
