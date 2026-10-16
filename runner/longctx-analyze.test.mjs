import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeLongctx } from "./longctx-analyze.mjs";
import { buildManifest, seededShuffle } from "./longctx-data.mjs";

const rec = (set, item, tool, score, extra = {}) => ({ set, item, tool, score, parsed: "x", usage: { costUsd: 0.01, output: 10 }, wallMs: 60_000, ...extra });

test("each set is compared on its own items, and an item with an infrastructure failure is dropped for every tool", () => {
	const records = [];
	for (let i = 0; i < 10; i++) {
		records.push(rec("longbench", `i${i}`, "relay", 1), rec("longbench", `i${i}`, "claude-code", i < 5 ? 1 : 0));
		records.push(rec("oolong", `o${i}`, "relay", 0), rec("oolong", `o${i}`, "claude-code", 1));
	}
	records.push(rec("oolong", "o10", "relay", 1), { set: "oolong", item: "o10", tool: "claude-code", infra: "sandbox" });
	const r = analyzeLongctx(records);
	assert.equal(r.longbench.tools.relay.score, 100);
	assert.equal(r.longbench.tools["claude-code"].score, 50);
	assert.equal(r.longbench.comparisons["claude-code"].difference, 50);
	assert.equal(r.longbench.comparisons["claude-code"].word, "much better");
	assert.deepEqual(r.oolong.droppedItems, ["o10"]);
	assert.equal(r.oolong.tools.relay.items, 10);
	assert.equal(r.oolong.comparisons["claude-code"].word, "worse");
});

test("the sample is a seeded draw: the same every time, and a permutation of the population", () => {
	const ids = Array.from({ length: 503 }, (_, i) => `id${String(i).padStart(3, "0")}`);
	const a = seededShuffle(ids);
	assert.deepEqual(a, seededShuffle(ids));
	assert.deepEqual([...a].sort(), ids);
	assert.notDeepEqual(a.slice(0, 50), ids.slice(0, 50));
	const rows = { longbench: ids.map((id) => ({ id, context: id, question: "q", choices: {}, answer: "A", meta: {} })) };
	const m = buildManifest(rows);
	assert.equal(m.sets.longbench.items.length, 50);
	assert.deepEqual(m.sets.longbench.items.map((x) => x.id), a.slice(0, 50));
});
