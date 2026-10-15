#!/usr/bin/env node
// The cost meter: a local HTTP proxy every tool in a run sends its model traffic through. It forwards each request
// unchanged to the provider and appends one JSON line per response to the log, with the token counts the provider
// reported and how the request asked the model to work (model, thinking type, effort, max_tokens), so each tool's
// default settings are on the record. Nothing else is recorded: no prompts, no outputs, no keys.
//
//   node meter/meter.mjs --port 8787 --upstream https://api.anthropic.com --log usage.jsonl [--cap-usd 10]
//
// With --cap-usd, the meter is also the round's one spend limit, the same for every tool: once the priced cost of a run
// reaches the cap, every further model request is answered 429 with error type "spend_cap_reached" and not forwarded.
//
// Tools point at http://127.0.0.1:8787 (Claude Code: ANTHROPIC_BASE_URL; Relay and Prime Agent: models.json baseUrl).
// Streaming responses are passed through as they arrive and parsed on the side.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		port: { type: "string", default: "8787" },
		upstream: { type: "string", default: "https://api.anthropic.com" },
		log: { type: "string", default: "usage.jsonl" },
		"cap-usd": { type: "string" },
	},
});

/**
 * Anthropic list prices in $ per million tokens, checked 15 Oct 2026 on platform.claude.com/docs/en/about-claude/pricing.
 * A 5-minute cache write is 1.25x input and a 1-hour write 2x input; a hit is 5% of input on Opus and Sonnet 5.5.
 * Haiku 5.5 bills the whole request at its long-context prices once the prompt passes 100,000 tokens.
 */
export const PRICES = {
	"claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
	"claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
	"claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, long: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
};

/** The dollar cost of one response's usage, or undefined for a model with no price here. */
export function costOf(usage) {
	const key = Object.keys(PRICES).find((id) => usage.model?.startsWith(id));
	if (!key) return undefined;
	const base = PRICES[key];
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	const price = base.long && prompt > base.long.above ? base.long : base;
	const write1h = usage.cacheWrite1h ?? 0;
	const write5m = usage.cacheWrite - write1h;
	const dollars =
		usage.input * price.input +
		usage.output * price.output +
		usage.cacheRead * price.cacheRead +
		write5m * price.input * 1.25 +
		write1h * price.input * 2;
	return dollars / 1_000_000;
}

const capUsd = values["cap-usd"] === undefined ? undefined : Number(values["cap-usd"]);
let spentUsd = 0;
const upstream = new URL(values.upstream);
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length"]);

/** Token counts from one Anthropic Messages response, streamed (SSE) or not. */
export function usageFromAnthropic(body, contentType) {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: undefined };
	const take = (u) => {
		if (!u) return;
		if (typeof u.input_tokens === "number") usage.input = u.input_tokens;
		if (typeof u.output_tokens === "number") usage.output = u.output_tokens;
		if (typeof u.cache_read_input_tokens === "number") usage.cacheRead = u.cache_read_input_tokens;
		if (typeof u.cache_creation_input_tokens === "number") usage.cacheWrite = u.cache_creation_input_tokens;
		if (typeof u.cache_creation?.ephemeral_1h_input_tokens === "number") usage.cacheWrite1h = u.cache_creation.ephemeral_1h_input_tokens;
	};
	if (contentType?.includes("text/event-stream")) {
		for (const line of body.split("\n")) {
			if (!line.startsWith("data:")) continue;
			let event;
			try {
				event = JSON.parse(line.slice(5).trim());
			} catch {
				continue;
			}
			if (event.type === "message_start") {
				usage.model = event.message?.model;
				take(event.message?.usage);
			} else if (event.type === "message_delta") {
				take(event.usage);
			}
		}
		return usage;
	}
	try {
		const json = JSON.parse(body);
		usage.model = json.model;
		take(json.usage);
	} catch {}
	return usage;
}

function log(entry) {
	appendFileSync(values.log, `${JSON.stringify(entry)}\n`);
}

const server = createServer(async (req, res) => {
	const started = Date.now();
	if (capUsd !== undefined && spentUsd >= capUsd && req.method === "POST") {
		for await (const _ of req) {}
		log({ ts: new Date().toISOString(), path: req.url, status: 429, refused: "spend_cap_reached", spentUsd, ms: 0 });
		res.writeHead(429, { "content-type": "application/json" });
		res.end(JSON.stringify({ type: "error", error: { type: "spend_cap_reached", message: `This run reached its spend cap of ${capUsd}.` } }));
		return;
	}
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const headers = {};
	for (const [name, value] of Object.entries(req.headers)) {
		if (!HOP_BY_HOP.has(name)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
	}
	const target = new URL(req.url, upstream);
	let response;
	try {
		response = await fetch(target, {
			method: req.method,
			headers,
			body: chunks.length ? Buffer.concat(chunks) : undefined,
		});
	} catch (error) {
		log({ ts: new Date().toISOString(), path: target.pathname, status: 0, error: String(error).slice(0, 200), ms: Date.now() - started });
		res.writeHead(502, { "content-type": "application/json" });
		res.end(JSON.stringify({ type: "error", error: { type: "meter_upstream_unreachable", message: "The cost meter could not reach the provider." } }));
		return;
	}
	const outHeaders = {};
	response.headers.forEach((value, name) => {
		if (!HOP_BY_HOP.has(name) && name !== "content-encoding") outHeaders[name] = value;
	});
	res.writeHead(response.status, outHeaders);
	const contentType = response.headers.get("content-type") ?? "";
	const decoder = new TextDecoder();
	let text = "";
	if (response.body) {
		for await (const chunk of response.body) {
			res.write(chunk);
			text += decoder.decode(chunk, { stream: true });
		}
	}
	res.end();
	const metered = req.method === "POST" && target.pathname.endsWith("/messages");
	const usage = metered ? usageFromAnthropic(text, contentType) : undefined;
	let asked;
	if (metered) {
		try {
			const sent = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			asked = { askedModel: sent.model, thinking: sent.thinking?.type, effort: sent.output_config?.effort, maxTokens: sent.max_tokens };
		} catch {}
	}
	const cost = usage ? costOf(usage) : undefined;
	if (cost) spentUsd += cost;
	log({
		ts: new Date().toISOString(),
		path: target.pathname,
		status: response.status,
		ms: Date.now() - started,
		...(asked ?? {}),
		...(usage ?? {}),
		...(cost === undefined ? {} : { costUsd: cost, spentUsd }),
	});
});

if (process.argv[1] === new URL(import.meta.url).pathname) {
	server.listen(Number(values.port), "127.0.0.1", () => {
		process.stdout.write(`meter listening on 127.0.0.1:${values.port} -> ${upstream.origin}, log ${values.log}\n`);
	});
}
