// The model that writes a writer lane's change (prompts and skills, tools): one call per proposal, paid, and never made
// without a cap. Its worst case is fixed before the call, from the prompt's length and the most it may write, and the
// call is made only when that fits what the lane and the cycle have left.
//
// The improving loop's writer is never from the family that drafts the exam (OpenAI, TIERS.md "Written by another model
// family"), so the exam stays written by a model the loop is not. Tests pass a fake writer; nothing here is called by
// them.
import { providerOf } from "../runner/arms.mjs";

/** List prices in dollars per million tokens, from Anthropic's model pages (checked 23 Oct 2026). */
export const WRITER_PRICES = Object.freeze({
	"claude-opus-5-5": { input: 4, output: 20 },
	"claude-sonnet-5-5": { input: 2, output: 10 },
	"claude-haiku-5-5": { input: 0.1, output: 0.5 },
});
export const DEFAULT_WRITER_MODEL = "claude-opus-5-5";
/** The most one written change may be, in output tokens (thinking included). */
export const WRITER_MAX_TOKENS = 6000;
/** Characters per input token, low on purpose, so the worst case is never under the real cost. */
const CHARS_PER_TOKEN = 2.5;

/** Why this model may not write the loop's changes; empty when it may. */
export function writerProblems(model) {
	let provider;
	try {
		provider = providerOf(model);
	} catch {
		return [`no provider known for ${model}`];
	}
	if (provider === "openai") return [`${model} is from the family that drafts the exam (TIERS.md); the loop's writer is another family`];
	if (!WRITER_PRICES[model]) return [`no list price is known for ${model}, so its worst case cannot be fixed`];
	return [];
}

/** The most one call can cost, in dollars: every input character a token, at most `maxTokens` out. */
export function worstCostUsd({ model, inputChars, maxTokens = WRITER_MAX_TOKENS }) {
	const price = WRITER_PRICES[model];
	return (Math.ceil(inputChars / CHARS_PER_TOKEN) * price.input + maxTokens * price.output) / 1e6;
}

/** What a call cost, from the usage the API reported. */
export function costUsd(model, usage = {}) {
	const price = WRITER_PRICES[model];
	const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) * 1.25 + (usage.cache_read_input_tokens ?? 0) * 0.1;
	return (input * price.input + (usage.output_tokens ?? 0) * price.output) / 1e6;
}

/**
 * The Messages API, with plain fetch as the rest of this repository calls model APIs. The key comes from the
 * environment and is never printed. No fallback model: a refusal ends the call, so its cost never exceeds the worst
 * case worked out for this model.
 */
export function anthropicWriter({ apiKey, model = DEFAULT_WRITER_MODEL, fetch: doFetch = globalThis.fetch, baseUrl = "https://api.anthropic.com" } = {}) {
	if (!apiKey) throw new Error("RELAY_BENCH_ANTHROPIC_KEY is not set");
	const problems = writerProblems(model);
	if (problems.length) throw new Error(problems[0]);
	return {
		model,
		async write({ system, prompt, maxTokens = WRITER_MAX_TOKENS }) {
			const res = await doFetch(`${baseUrl}/v1/messages`, {
				method: "POST",
				headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
				body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] }),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(`Anthropic ${res.status}: ${body?.error?.message ?? "no message"}`);
			const usage = body.usage ?? {};
			const cost = costUsd(model, usage);
			if (body.stop_reason === "refusal") return { text: "", refused: true, usage, costUsd: cost, model: body.model ?? model };
			const text = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
			return { text, truncated: body.stop_reason === "max_tokens", usage, costUsd: cost, model: body.model ?? model };
		},
	};
}
