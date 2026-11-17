#!/usr/bin/env node
// Reads a gate run's records.jsonl and prints the numbers-only table and the three rules of the gate (README.md).
//   node results/gate-2c-bedrock/summarize.mjs runs/gate-2c-bedrock/records.jsonl [--json]
import { readFileSync } from "node:fs";

const [path, flag] = process.argv.slice(2);
/** E2B, 2 vCPU + 4 GiB, as runner/run-stage.mjs prices it. */
const E2B_USD_PER_SECOND = 0.000046;
const records = readFileSync(path, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l));
const arms = [...new Set(records.map((r) => r.tool))];
const rows = {};
for (const tool of arms) {
	const rs = records.filter((r) => r.tool === tool);
	const done = rs.filter((r) => r.saidDone);
	rows[tool] = {
		runs: rs.length,
		met: rs.reduce((s, r) => s + (r.score?.requirementsMet ?? 0), 0),
		of: rs.reduce((s, r) => s + (r.score?.requirements ?? 0), 0),
		saidDone: done.length,
		saidDoneUnmet: done.filter((r) => (r.score?.requirementsMet ?? 0) < (r.score?.requirements ?? 0)).length,
		hours: rs.reduce((s, r) => s + (r.wallMs ?? 0), 0) / 3_600_000,
		modelUsd: rs.reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0),
		// Sandbox time from the run's start to its record (work and judge sandboxes, one at a time), at E2B's price.
		e2bUsd: rs.reduce((s, r) => s + ((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000) * E2B_USD_PER_SECOND, 0),
		atCap: rs.filter((r) => r.usage?.refusedAtCap > 0).length,
		perTask: Object.fromEntries(
			rs.map((r) => [
				r.task,
				{ met: r.score?.requirementsMet, saidDone: r.saidDone, min: Math.round((r.wallMs ?? 0) / 60000), usd: Number((r.usage?.costUsd ?? 0).toFixed(3)), refusedAtCap: r.usage?.refusedAtCap ?? 0 },
			]),
		),
	};
}
const relay = arms.find((t) => t.startsWith("relay"));
const cc = arms.find((t) => t === "claude-code");
let rules;
if (relay && cc) {
	const R = rows[relay];
	const C = rows[cc];
	rules = {
		"1 requirements": { relay: R.met, claudeCode: C.met, pass: R.met >= C.met },
		"2 said done but unmet": { relay: `${R.saidDoneUnmet} of ${R.saidDone}`, pass: R.saidDone === 0 ? true : R.saidDoneUnmet / R.saidDone <= 0.25 },
		"3 time": { relayHours: R.hours.toFixed(2), claudeCodeHours: C.hours.toFixed(2), ratio: (R.hours / C.hours).toFixed(2), pass: R.hours <= 1.5 * C.hours },
	};
}
if (flag === "--json") console.log(JSON.stringify({ rows, rules }, null, 2));
else {
	console.log(`| | ${arms.join(" | ")} |`);
	console.log(`|---|${arms.map(() => "---").join("|")}|`);
	const line = (label, f) => console.log(`| ${label} | ${arms.map((t) => f(rows[t])).join(" | ")} |`);
	line("Runs", (r) => r.runs);
	line("Requirements met", (r) => `${r.met} of ${r.of}`);
	line("Said done, with a requirement unmet", (r) => `${r.saidDoneUnmet} of ${r.saidDone}`);
	line("Time", (r) => `${r.hours.toFixed(2)} h`);
	line("Model spend (metered)", (r) => `$${r.modelUsd.toFixed(2)}`);
	line("E2B spend (estimated)", (r) => `$${r.e2bUsd.toFixed(2)}`);
	line("Runs that reached the spend cap", (r) => r.atCap);
	if (rules) for (const [k, v] of Object.entries(rules)) console.log(`rule ${k}: ${JSON.stringify(v)}`);
	for (const t of arms) console.log(t, JSON.stringify(rows[t].perTask));
}
