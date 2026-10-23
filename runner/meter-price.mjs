// Whether the meter can price a model (meter/meter.mjs PRICES). The meter is the spend cap of every run: a model it has
// no price for is counted as free, so its runs would have no cap that binds. A run on a model the meter cannot price is
// refused before it starts. Asked in a child process, since meter.mjs reads its own command line when it is loaded.
import { spawnSync } from "node:child_process";

const METER = new URL("../meter/meter.mjs", import.meta.url).href;

/** `{ model: price entry or null }` for each model id, as the meter prices it. */
export function meterPrices(models) {
	const code = `const m = await import(${JSON.stringify(METER)}); const out = {}; for (const id of JSON.parse(process.env.RELAY_BENCH_PRICE_MODELS)) out[id] = m.priceFor(id) ?? null; console.log(JSON.stringify(out));`;
	const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
		encoding: "utf8",
		env: { ...process.env, RELAY_BENCH_PRICE_MODELS: JSON.stringify(models) },
	});
	if (r.status !== 0) throw new Error(`could not read the meter's prices: ${(r.stderr || "").slice(-300)}`);
	return JSON.parse(r.stdout.trim().split("\n").pop());
}

/** Why a run on these models would have no spend cap that binds; empty when the meter prices every one. */
export function unpricedProblems(models, prices = meterPrices(models)) {
	return models
		.filter((model) => !prices[model])
		.map((model) => `the meter has no price for ${model}, so it could not hold the run to its spend cap; add its list price to PRICES in meter/meter.mjs first`);
}
