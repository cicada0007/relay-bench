// The drafting ledger: list prices kept equal to the meter's, calls bounded before they are made, reservations replaced
// by real costs, and caps that refuse. No network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { E2B_USD_PER_SECOND, maxCallUsd, OPENAI_PRICES, openaiCostUsd, openLedger, SpendCapError, usageSummary } from "./draft-spend.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "draft-spend-"));

test("the OpenAI prices are the meter's, and a response costs what the meter would charge", async () => {
	const { PRICES, costOf, openaiUsage } = await import("../meter/meter.mjs");
	for (const [model, price] of Object.entries(OPENAI_PRICES)) {
		const { provider, ...meter } = PRICES[model];
		assert.equal(provider, "openai");
		assert.deepEqual(price, meter, model);
	}
	for (const model of Object.keys(PRICES).filter((m) => PRICES[m].provider === "openai")) assert.ok(OPENAI_PRICES[model], `${model} is priced here too`);
	const usage = { input_tokens: 4_200, input_tokens_details: { cached_tokens: 1_000 }, output_tokens: 1_800, output_tokens_details: { reasoning_tokens: 900 } };
	for (const model of ["gpt-6-luna-2026-09-30", "gpt-6.1-sol", "gpt-6-astra"]) {
		for (const tier of [undefined, "default", "flex", "priority"]) {
			const expected = costOf(openaiUsage(usage, model, tier));
			assert.ok(Math.abs(openaiCostUsd(usage, model, tier) - expected) < 1e-12, `${model} ${tier}`);
		}
	}
	// Luna: 3,200 ordinary input at $0.10, 1,000 cached at $0.01, 1,800 output (reasoning included) at $0.50 per million.
	assert.ok(Math.abs(openaiCostUsd(usage, "gpt-6-luna") - (3_200 * 0.1 + 1_000 * 0.01 + 1_800 * 0.5) / 1e6) < 1e-15);
	assert.deepEqual(usageSummary(usage), { input: 3_200, cached: 1_000, cacheWrite: 0, cacheWrite12h: 0, output: 1_800, reasoning: 900 });
	assert.equal(openaiCostUsd(usage, "gpt-unknown"), undefined);
	assert.equal(openaiCostUsd(undefined, "gpt-6-luna"), undefined);
});

test("a call's most possible cost covers every answer it can get back", () => {
	const bound = maxCallUsd("gpt-6.1-sol", { inputBytes: 3_000, maxOutputTokens: 6_000 });
	assert.ok(Math.abs(bound - ((3_000 + 1_000) * 5 + 6_000 * 10) / 1e6) < 1e-12, "input at the dearest input rate, output at the output rate");
	// The worst answer the call allows: as many input tokens as bytes, all written to the cache, every output token used.
	const worst = { input_tokens: 3_000, input_tokens_details: { cache_write_tokens: 3_000, cache_write_tokens_details: { ttl_12h_tokens: 3_000 } }, output_tokens: 6_000 };
	assert.ok(openaiCostUsd(worst, "gpt-6.1-sol", "default") <= bound);
	assert.equal(maxCallUsd("gpt-unknown", { inputBytes: 10, maxOutputTokens: 10 }), undefined);
	assert.equal(maxCallUsd("gpt-6-luna", { inputBytes: 10, maxOutputTokens: 0 }), undefined);
	// A prompt past 272,000 tokens is bounded at the long-context prices.
	assert.ok(maxCallUsd("gpt-6-luna", { inputBytes: 300_000, maxOutputTokens: 1 }) > (301_000 * 0.25) / 1e6);
});

test("a reservation counts at its most until it is settled, and a call that could cross the cap is refused", () => {
	const dir = scratch();
	try {
		const path = join(dir, "drafting", "spend.json");
		let ledger = openLedger(path);
		assert.throws(() => ledger.reserve("openai", { boundUsd: 0.01 }), (e) => e instanceof SpendCapError && /no openai spending cap/.test(e.message));
		ledger = openLedger(path, { caps: { openai: 0.1, e2b: 0.05 } });
		const a = ledger.reserve("openai", { boundUsd: 0.06, candidate: "a" });
		assert.equal(ledger.totals().openai.spentUsd, 0.06);
		assert.throws(() => ledger.reserve("openai", { boundUsd: 0.05 }), (e) => e instanceof SpendCapError && /could cross the \$0\.10 cap/.test(e.message));
		ledger.settle("openai", a, { costUsd: 0.002, usage: { input: 1, output: 2 } });
		const b = ledger.reserve("openai", { boundUsd: 0.05, candidate: "b" });
		// A call whose cost never became known keeps counting at its most.
		ledger.settle("openai", b, { outcome: "error" });
		ledger.update("openai", b, { costUsd: 0, outcome: "still unknown" });
		const t = ledger.totals();
		assert.equal(t.openai.spentUsd, 0.052);
		assert.equal(t.openai.calls, 2);
		assert.throws(() => ledger.reserve("openai", { boundUsd: undefined }), SpendCapError);

		const s = ledger.reserve("e2b", { boundUsd: 0.04, label: "a" });
		assert.throws(() => ledger.reserve("e2b", { boundUsd: 0.02 }), SpendCapError, "the E2B cap is its own");
		ledger.settle("e2b", s, { seconds: 100, costUsd: 100 * E2B_USD_PER_SECOND });
		const file = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(file.openai.capUsd, 0.1);
		assert.equal(file.openai.spentUsd, 0.052);
		assert.deepEqual(file.openai.calls.map((c) => [c.candidate, c.state, c.outcome]), [["a", "settled", undefined], ["b", "unknown", "still unknown"]]);
		assert.equal(file.e2b.spentUsd, 0.0046);
		assert.equal(file.e2b.seconds, 100);
		// The caps stay in the file for the next process.
		assert.equal(openLedger(path).totals().e2b.capUsd, 0.05);
		assert.throws(() => openLedger(path, { caps: { openai: "lots" } }), /number of dollars/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
