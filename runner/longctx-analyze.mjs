#!/usr/bin/env node
// Test G's analysis, as PREREGISTRATION.md fixes it, for each set on its own (OOLONG and LongBench v2 are separate
// benchmarks with separate scorers): a tool's score is its mean over items of the benchmark's own score; a comparison is
// the mean over items of (Relay's score - the other tool's score) on the items both ran; the 95% interval is the
// round's bootstrap over items (runner/analyze.mjs: 10,000 resamples, seed 20261015) and the word comes from it alone.
// An item with an infrastructure failure for any tool is dropped for every tool, and listed.
//
//   node runner/longctx-analyze.mjs --out runs/round-1 --test G [--json]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { bootstrap, word } from "./analyze.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

export function analyzeLongctx(records) {
	const result = {};
	for (const set of [...new Set(records.map((r) => r.set))]) {
		const rs = records.filter((r) => r.set === set);
		const dropped = [...new Set(rs.filter((r) => r.infra).map((r) => r.item))];
		const kept = rs.filter((r) => !dropped.includes(r.item));
		const byTool = new Map();
		for (const r of kept) {
			if (!byTool.has(r.tool)) byTool.set(r.tool, new Map());
			byTool.get(r.tool).set(r.item, r);
		}
		const tools = {};
		for (const [tool, items] of byTool) {
			const runs = [...items.values()];
			const cost = runs.reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0);
			const ms = runs.map((r) => r.wallMs ?? 0).sort((a, b) => a - b);
			tools[tool] = {
				items: runs.length,
				score: 100 * mean(runs.map((r) => r.score ?? 0)),
				unparsed: runs.filter((r) => r.parsed === null || r.parsed === undefined).length,
				costUsd: cost,
				costPerItemUsd: cost / runs.length,
				outputTokens: runs.reduce((s, r) => s + (r.usage?.output ?? 0), 0),
				stoppedAtCap: runs.filter((r) => (r.usage?.refusedAtCap ?? 0) > 0).length,
				timedOut: runs.filter((r) => r.timedOut).length,
				medianMinutes: ms[Math.floor(ms.length / 2)] / 60_000,
			};
		}
		const comparisons = {};
		const relay = byTool.get("relay");
		if (relay) {
			for (const [tool, items] of byTool) {
				if (tool === "relay") continue;
				const shared = [...items.keys()].filter((id) => relay.has(id));
				if (shared.length < 2) continue;
				const diffs = shared.map((id) => 100 * ((relay.get(id).score ?? 0) - (items.get(id).score ?? 0)));
				const interval = bootstrap(diffs);
				comparisons[tool] = { items: shared.length, difference: mean(diffs), ...interval, word: word(interval) };
			}
		}
		result[set] = { tools, comparisons, droppedItems: dropped };
	}
	return result;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values: args } = parseArgs({
		options: { out: { type: "string", default: "runs/round-1" }, test: { type: "string", default: "G" }, json: { type: "boolean", default: false } },
	});
	const records = readFileSync(join(ROOT, args.out, args.test, "records.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((r) => r.test === args.test);
	const result = analyzeLongctx(records);
	if (args.json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		const f = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? "–" : x.toFixed(d));
		const names = { oolong: "OOLONG (yahoo, 128k)", longbench: "LongBench v2" };
		for (const [set, s] of Object.entries(result)) {
			console.log(`Test ${args.test}, ${names[set] ?? set}${s.droppedItems.length ? ` (dropped for infrastructure: ${s.droppedItems.join(", ")})` : ""}`);
			console.log("tool          items  score  unparsed  cost       cost/item  out-tokens  at-cap  timed-out  median-min");
			for (const [tool, t] of Object.entries(s.tools)) {
				console.log(
					`${tool.padEnd(13)} ${String(t.items).padStart(5)}  ${f(t.score).padStart(5)}  ${String(t.unparsed).padStart(8)}  ` +
						`${`$${t.costUsd.toFixed(3)}`.padStart(9)}  ${`$${t.costPerItemUsd.toFixed(4)}`.padStart(9)}  ${String(t.outputTokens).padStart(10)}  ` +
						`${String(t.stoppedAtCap).padStart(6)}  ${String(t.timedOut).padStart(9)}  ${f(t.medianMinutes).padStart(10)}`,
				);
			}
			for (const [tool, c] of Object.entries(s.comparisons)) {
				console.log(`Relay minus ${tool}: ${f(c.difference)} points, 95% interval ${f(c.low)} to ${f(c.high)} over ${c.items} items: ${c.word}`);
			}
			console.log("");
		}
	}
}
