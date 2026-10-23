// The drafting ledger: every paid call that drafting the exam makes, to OpenAI (the request's writer) and to E2B (the
// sandbox the judge check runs in), counted in one file beside the exam (<exam>/drafting/spend.json), each against its
// own cap.
//
// A call is reserved at the most it could cost before it is made, and refused when that could cross its cap. When it
// returns, the reservation is replaced by what it cost, read from the response's own usage (OpenAI) or the sandbox's
// seconds (E2B), at list price. A call whose cost never becomes known (the connection broke, the process died) stays
// counted at its reservation, so the total never undercounts. Several drafting processes may share one ledger: every
// change is made under a lock file, and the file is replaced whole, never half-written.
//
// The caps are kept in the file. A person sets one once (draft-task.mjs --openai-cap-usd / --e2b-cap-usd); with no cap
// set, every paid call is refused.
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * OpenAI list prices in $ per million tokens, the same as meter/meter.mjs PRICES (checked 23 Oct 2026 on
 * developers.openai.com/api/docs/pricing, Standard tier); draft-spend.test.mjs fails if the two ever differ. The meter
 * cannot be imported here: it reads its own command line when loaded. Each row: input, output, cached input, 30-minute
 * cache write, 12-hour cache write; then the same above 272,000 input tokens.
 */
const row = ([input, output, cacheRead, write30m, write12h], [lInput, lOutput, lCacheRead, lWrite30m, lWrite12h]) => ({
	input,
	output,
	cacheRead,
	write30m,
	write12h,
	long: { above: 272_000, input: lInput, output: lOutput, cacheRead: lCacheRead, write30m: lWrite30m, write12h: lWrite12h },
});
export const OPENAI_PRICES = Object.freeze({
	"gpt-6-astra": row([10, 50, 1, 12.5, 25], [20, 75, 2, 25, 50]),
	"gpt-6.1-sol": row([2, 10, 0.1, 2.5, 5], [4, 15, 0.2, 5, 10]),
	"gpt-6-sol": row([2, 10, 0.2, 2.5, 5], [4, 15, 0.4, 5, 10]),
	"gpt-6-luna": row([0.1, 0.5, 0.01, 0.125, 0.25], [0.2, 0.75, 0.02, 0.25, 0.5]),
	"gpt-5.6-sol": row([4, 20, 0.4, 5, 10], [8, 30, 0.8, 10, 20]),
	"gpt-5.6-terra": row([2, 12, 0.2, 2.5, 5], [4, 18, 0.4, 5, 10]),
	"gpt-5.6-luna": row([0.2, 1.2, 0.02, 0.25, 0.5], [0.4, 1.8, 0.04, 0.5, 1]),
});
/** OpenAI's processing tiers, as the meter prices them: any tier not listed is priced at 6x. */
const TIERS = { default: 1, auto: 1, flex: 0.5 };
const tierMultiplier = (tier) => (tier === undefined || tier === null ? 1 : (TIERS[tier] ?? 6));

/** E2B, 2 vCPU + 4 GiB (the round's image), checked 15 Oct 2026 at e2b.dev/pricing, as runner/run-stage.mjs prices it. */
export const E2B_USD_PER_SECOND = 0.000046;

/** The price entry for a model id: the longest listed id it starts with ("gpt-6-luna-2026-09-30" is gpt-6-luna). */
export function openaiPriceFor(model) {
	const key = Object.keys(OPENAI_PRICES)
		.filter((id) => model?.startsWith(id))
		.sort((a, b) => b.length - a.length)[0];
	return key ? OPENAI_PRICES[key] : undefined;
}

/** Tokens the call may be sent, at most: no token is shorter than a byte, plus room for the API's own message framing. */
const FRAMING_TOKENS = 1_000;

/**
 * The most one Responses API call can cost: every input byte a token at the dearest input rate (cache writes cost more
 * than input), and every output token the call allows (max_output_tokens, which counts reasoning too). The call is sent
 * at the default processing tier, so no tier multiplier applies. Undefined for a model with no price here.
 */
export function maxCallUsd(model, { inputBytes, maxOutputTokens }) {
	const base = openaiPriceFor(model);
	if (!base || !(maxOutputTokens > 0)) return undefined;
	const tokensIn = inputBytes + FRAMING_TOKENS;
	const price = tokensIn > base.long.above ? base.long : base;
	return (tokensIn * Math.max(price.input, price.write30m, price.write12h) + maxOutputTokens * price.output) / 1_000_000;
}

/** A Responses API usage object, in the ledger's terms: input is ordinary input only, as the meter counts it. */
export function usageSummary(u = {}) {
	const details = u.input_tokens_details ?? {};
	const cached = details.cached_tokens ?? 0;
	const cacheWrite = details.cache_write_tokens ?? 0;
	return {
		input: Math.max(0, (u.input_tokens ?? 0) - cached - cacheWrite),
		cached,
		cacheWrite,
		cacheWrite12h: details.cache_write_tokens_details?.ttl_12h_tokens ?? 0,
		output: u.output_tokens ?? 0,
		reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
	};
}

/** What one response cost, from its own usage and the model and tier it reports; undefined without a usage or a price. */
export function openaiCostUsd(usage, model, serviceTier) {
	const base = openaiPriceFor(model);
	if (!base || !usage || typeof usage !== "object") return undefined;
	const u = usageSummary(usage);
	const price = u.input + u.cached + u.cacheWrite > base.long.above ? base.long : base;
	const dollars =
		u.input * price.input +
		u.output * price.output +
		u.cached * price.cacheRead +
		(u.cacheWrite - u.cacheWrite12h) * price.write30m +
		u.cacheWrite12h * price.write12h;
	return (dollars * tierMultiplier(serviceTier)) / 1_000_000;
}

export class SpendCapError extends Error {}

const KINDS = { openai: "calls", e2b: "sandboxes" };
const round = (usd) => Math.round(usd * 1e6) / 1e6;
/** An entry's share of the total: what it cost once settled, its reservation until then. */
const counted = (entry) => (entry.state === "settled" && typeof entry.costUsd === "number" ? entry.costUsd : entry.boundUsd);

function empty() {
	return {
		about: "Every paid call made while drafting the exam (relay-bench scripts/draft-spend.mjs). A reserved entry counts at the most it could cost until it is settled.",
		openai: { capUsd: null, spentUsd: 0, calls: [] },
		e2b: { capUsd: null, usdPerSecond: E2B_USD_PER_SECOND, spentUsd: 0, seconds: 0, sandboxes: [] },
	};
}

function sleepMs(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs fn while holding <path>.lock (a folder: making one is atomic). A lock older than 30 seconds is left over from a
 *  process that died, since no holder keeps it for more than a moment, and is taken over. */
function withLock(path, fn) {
	const lock = `${path}.lock`;
	const deadline = Date.now() + 60_000;
	for (;;) {
		try {
			mkdirSync(lock);
			break;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lock).mtimeMs > 30_000) rmdirSync(lock);
			} catch {}
			if (Date.now() > deadline) throw new Error(`the spend ledger ${path} stayed locked for a minute`);
			sleepMs(25);
		}
	}
	try {
		return fn();
	} finally {
		rmdirSync(lock);
	}
}

/**
 * The ledger at `path` (made on first use). `caps` sets or changes the caps kept in it: { openai, e2b } in dollars.
 * Returns { reserve, settle, update, totals }; every call reads the file again, so other processes' calls count.
 */
export function openLedger(path, { caps = {}, now = () => new Date() } = {}) {
	mkdirSync(dirname(path), { recursive: true });
	const read = () => {
		try {
			return JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			if (error.code === "ENOENT") return empty();
			throw new Error(`cannot read the spend ledger ${path}: ${error.message}`);
		}
	};
	const write = (data) => {
		for (const kind of Object.keys(KINDS)) {
			const entries = data[kind][KINDS[kind]];
			data[kind].spentUsd = round(entries.reduce((s, e) => s + counted(e), 0));
			if (kind === "e2b") data.e2b.seconds = Math.round(entries.reduce((s, e) => s + (e.seconds ?? 0), 0) * 10) / 10;
		}
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
		renameSync(tmp, path);
	};
	const change = (fn) => withLock(path, () => {
		const data = read();
		const out = fn(data);
		write(data);
		return out;
	});
	const find = (data, kind, id) => {
		const entry = data[kind][KINDS[kind]].find((e) => e.id === id);
		if (!entry) throw new Error(`no ${kind} entry ${id} in ${path}`);
		return entry;
	};
	for (const [kind, cap] of Object.entries(caps)) {
		if (cap === undefined || cap === null) continue;
		if (!KINDS[kind]) throw new Error(`unknown spend kind ${kind}`);
		if (!(Number(cap) >= 0)) throw new Error(`a ${kind} cap is a number of dollars, not ${cap}`);
		change((data) => {
			data[kind].capUsd = Number(cap);
		});
	}
	return {
		path,
		/** Reserves one call at boundUsd; throws SpendCapError when that could take the total past the cap. */
		reserve(kind, { boundUsd, ...fields }) {
			if (!KINDS[kind]) throw new Error(`unknown spend kind ${kind}`);
			if (!(boundUsd >= 0)) throw new SpendCapError(`the ${kind} call cannot be bounded, so it is not made`);
			return change((data) => {
				const book = data[kind];
				if (typeof book.capUsd !== "number") throw new SpendCapError(`no ${kind} spending cap is set in ${path}; a person sets one first`);
				const entries = book[KINDS[kind]];
				const spent = entries.reduce((s, e) => s + counted(e), 0);
				if (spent + boundUsd > book.capUsd + 1e-12) {
					throw new SpendCapError(`${kind}: $${spent.toFixed(4)} counted so far plus this call's most ($${boundUsd.toFixed(4)}) could cross the $${book.capUsd.toFixed(2)} cap`);
				}
				const id = `${kind}-${entries.length + 1}-${process.pid}-${Date.now().toString(36)}`;
				entries.push({ id, at: now().toISOString(), state: "reserved", boundUsd: round(boundUsd), ...fields });
				return id;
			});
		},
		/** Replaces a reservation with what the call cost. Without a costUsd the entry keeps counting at its reservation. */
		settle(kind, id, { costUsd, ...fields } = {}) {
			change((data) => {
				const entry = find(data, kind, id);
				Object.assign(entry, fields, { settledAt: now().toISOString() });
				if (typeof costUsd === "number" && Number.isFinite(costUsd)) {
					entry.state = "settled";
					entry.costUsd = round(costUsd);
				} else {
					entry.state = "unknown";
				}
			});
		},
		/** Adds fields to an entry (an outcome, for example), leaving its cost alone. */
		update(kind, id, fields) {
			change((data) => {
				const entry = find(data, kind, id);
				const { costUsd, state, boundUsd, ...rest } = fields;
				Object.assign(entry, rest);
			});
		},
		totals() {
			const data = withLock(path, read);
			const sum = (kind) => round(data[kind][KINDS[kind]].reduce((s, e) => s + counted(e), 0));
			return {
				openai: { capUsd: data.openai.capUsd, spentUsd: sum("openai"), calls: data.openai.calls.length },
				e2b: { capUsd: data.e2b.capUsd, spentUsd: sum("e2b"), sandboxes: data.e2b.sandboxes.length, seconds: data.e2b.sandboxes.reduce((s, e) => s + (e.seconds ?? 0), 0) },
			};
		},
	};
}
