#!/usr/bin/env node
// The cost meter: a local HTTP proxy every tool in a run sends its model traffic through. It forwards each request
// unchanged to the provider and appends one JSON line per response to the log, with the token counts the provider
// reported and how the request asked the model to work (model, thinking type, effort, max_tokens), so each tool's
// default settings are on the record. Nothing else is recorded: no prompts, no outputs, no keys.
//
//   node meter/meter.mjs --port 8787 --upstream https://api.anthropic.com --log usage.jsonl [--cap-usd 10]
//   node meter/meter.mjs --port 443 --tls-cert meter.crt --tls-key meter.key --resolve-upstream-by-dns ...
//
// With --cap-usd, the meter is also the round's one spend limit, the same for every tool: once the priced cost of a run
// reaches the cap, every further model request is answered 429 with error type "spend_cap_reached" and not forwarded.
//
// In the benchmark no tool's endpoint setting is changed, because some tools turn features off when it is (Claude Code
// with a custom ANTHROPIC_BASE_URL; Hermes drops the model's thinking for any endpoint not on anthropic.com). Instead the
// sandbox's hosts file sends api.anthropic.com to 127.0.0.1, where the meter answers on 443 with a certificate from a CA
// made for that one run and trusted only inside that sandbox. --resolve-upstream-by-dns makes the meter find the real
// provider through DNS, past the hosts file. --plain-port also serves plain HTTP on 127.0.0.1, from the same process,
// so one log and one spend cap cover it: for a tool that trusts only its own built-in certificate list (Prime Agent
// 0.10.0), which therefore reaches the meter by its endpoint setting instead. Streaming responses are passed through as
// they arrive and parsed on the side.
//
// OpenAI is metered the same way, so Codex and Relay on an OpenAI model are measured alike: api.openai.com resolves to
// the meter too, and a request whose Host is api.openai.com goes to --openai-upstream. Its Responses and Chat Completions
// usage (cached input, 30-minute and 12-hour cache writes, reasoning tokens) is priced from OpenAI's list prices. Codex
// talks to the Responses API over a WebSocket by default; the meter passes the socket through byte for byte and reads the
// provider's events as they go by. It leaves the client's offer of compression (Sec-WebSocket-Extensions) out of the
// handshake it forwards, so the events arrive as plain text it can read; nothing else in the conversation changes.
//
// Test D's faults (PREREGISTRATION.md) are injected here, the same way for every tool: --fault network drops every model
// request's connection, and --fault errors answers every model request 529 overloaded_error, from --fault-after-sec
// after the run's first model request, for --fault-for-sec. When a network fault starts, model connections already open
// are cut too, as a real outage would. Each faulted request is logged with its fault.
import { createHash } from "node:crypto";
import { Resolver } from "node:dns";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import * as zlib from "node:zlib";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		port: { type: "string", default: "8787" },
		upstream: { type: "string", default: "https://api.anthropic.com" },
		"openai-upstream": { type: "string", default: "https://api.openai.com" },
		log: { type: "string", default: "usage.jsonl" },
		"cap-usd": { type: "string" },
		host: { type: "string", default: "127.0.0.1" },
		"tls-cert": { type: "string" },
		"tls-key": { type: "string" },
		"resolve-upstream-by-dns": { type: "boolean", default: false },
		"plain-port": { type: "string" },
		fault: { type: "string" },
		"fault-after-sec": { type: "string", default: "120" },
		"fault-for-sec": { type: "string", default: "600" },
	},
});

/**
 * List prices in $ per million tokens.
 *
 * Anthropic, checked 15 Oct 2026 on platform.claude.com/docs/en/about-claude/pricing. A 5-minute cache write is 1.25x
 * input and a 1-hour write 2x input; a hit is 5% of input on Opus and Sonnet 5.5. Haiku 5.5 bills the whole request at
 * its long-context prices once the prompt passes 100,000 tokens.
 *
 * OpenAI, checked 23 Oct 2026 on developers.openai.com/api/docs/pricing (Standard tier) and its prompt-caching guide.
 * Ordinary input is input_tokens minus cached reads minus cache writes; a 30-minute write and a 12-hour write each have
 * their own total rate (not a surcharge on input); reasoning tokens are billed as output. The whole request is billed at
 * the long-context prices once input passes 272,000 tokens ("Short context: <=272K input tokens").
 */
export const PRICES = {
	"claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
	"claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
	"claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, long: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
	"gpt-6-astra": openai([10, 50, 1, 12.5, 25], [20, 75, 2, 25, 50]),
	"gpt-6.1-sol": openai([2, 10, 0.1, 2.5, 5], [4, 15, 0.2, 5, 10]),
	"gpt-6-sol": openai([2, 10, 0.2, 2.5, 5], [4, 15, 0.4, 5, 10]),
	"gpt-6-luna": openai([0.1, 0.5, 0.01, 0.125, 0.25], [0.2, 0.75, 0.02, 0.25, 0.5]),
	"gpt-5.6-sol": openai([4, 20, 0.4, 5, 10], [8, 30, 0.8, 10, 20]),
	"gpt-5.6-terra": openai([2, 12, 0.2, 2.5, 5], [4, 18, 0.4, 5, 10]),
	"gpt-5.6-luna": openai([0.2, 1.2, 0.02, 0.25, 0.5], [0.4, 1.8, 0.04, 0.5, 1]),
};
function openai([input, output, cacheRead, write30m, write12h], [lInput, lOutput, lCacheRead, lWrite30m, lWrite12h]) {
	return {
		provider: "openai",
		input,
		output,
		cacheRead,
		write30m,
		write12h,
		long: { above: 272_000, input: lInput, output: lOutput, cacheRead: lCacheRead, write30m: lWrite30m, write12h: lWrite12h },
	};
}

/**
 * OpenAI's processing tiers, as the response's service_tier reports them. Flex is half price (the pricing page lists
 * Flex at the Batch rate). Any other tier (Fast, formerly Priority; Ultrafast) is priced at 6x, the highest multiplier
 * on the page, and marked in the log: an assumption that keeps the spend cap binding, not a measured price.
 */
export const OPENAI_TIERS = { default: 1, auto: 1, flex: 0.5 };
export const UNKNOWN_TIER_MULTIPLIER = 6;

/** The price entry for a model id: the longest listed id it starts with ("gpt-6.1-sol-2026-09-30" is gpt-6.1-sol). */
export function priceFor(model) {
	const key = Object.keys(PRICES)
		.filter((id) => model?.startsWith(id))
		.sort((a, b) => b.length - a.length)[0];
	return key ? PRICES[key] : undefined;
}

/** The dollar cost of one response's usage, or undefined for a model with no price here. */
export function costOf(usage) {
	const base = priceFor(usage.model);
	if (!base) return undefined;
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	const price = base.long && prompt > base.long.above ? base.long : base;
	if (base.provider === "openai") {
		const write12h = usage.cacheWrite12h ?? 0;
		const write30m = usage.cacheWrite - write12h;
		const dollars =
			usage.input * price.input +
			usage.output * price.output +
			usage.cacheRead * price.cacheRead +
			write30m * price.write30m +
			write12h * price.write12h;
		return (dollars * tierMultiplier(usage.serviceTier)) / 1_000_000;
	}
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
const tierMultiplier = (tier) => (tier === undefined || tier === null ? 1 : (OPENAI_TIERS[tier] ?? UNKNOWN_TIER_MULTIPLIER));

const capUsd = values["cap-usd"] === undefined ? undefined : Number(values["cap-usd"]);
let spentUsd = 0;
const upstreams = { anthropic: new URL(values.upstream), openai: new URL(values["openai-upstream"]) };
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length"]);

/** The provider a request is for, from the name it was sent to: api.openai.com is OpenAI; anything else is Anthropic. */
export function providerForHost(host) {
	return String(host ?? "").toLowerCase().replace(/:\d+$/, "") === "api.openai.com" ? "openai" : "anthropic";
}

/** A path that asks a model for tokens: Anthropic's Messages; OpenAI's Responses (and its compaction) and Chat Completions. */
export function isModelPath(provider, pathname) {
	const path = String(pathname ?? "").split("?")[0];
	if (provider === "openai") return /\/(responses(\/compact)?|chat\/completions)$/.test(path);
	return path.endsWith("/messages");
}

// c-ares asks the DNS servers directly and never reads the hosts file, which points the provider's name at the meter.
const resolver = new Resolver();
function lookupByDns(hostname, options, callback) {
	resolver.resolve4(hostname, (error, addresses) => {
		if (error) return callback(error);
		if (options?.all) return callback(null, addresses.map((address) => ({ address, family: 4 })));
		callback(null, addresses[0], 4);
	});
}

/** Forwards one request to the provider and resolves with the provider's response stream. */
function forward(method, target, headers, body) {
	return new Promise((resolve, reject) => {
		const send = target.protocol === "https:" ? httpsRequest : httpRequest;
		const request = send(
			target,
			{
				method,
				headers: body ? { ...headers, "content-length": String(body.length) } : headers,
				...(values["resolve-upstream-by-dns"] ? { lookup: lookupByDns } : {}),
			},
			resolve,
		);
		request.on("error", reject);
		request.end(body);
	});
}

/** A body as text for parsing token counts, whatever encoding the provider (or the tool) chose. */
export function decodeBody(raw, encoding) {
	try {
		if (encoding === "gzip") return zlib.gunzipSync(raw).toString("utf8");
		if (encoding === "br") return zlib.brotliDecompressSync(raw).toString("utf8");
		if (encoding === "deflate") return zlib.inflateSync(raw).toString("utf8");
		if (encoding === "zstd") return typeof zlib.zstdDecompressSync === "function" ? zlib.zstdDecompressSync(raw).toString("utf8") : "";
	} catch {
		return "";
	}
	return raw.toString("utf8");
}

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

/**
 * OpenAI's usage object, from the Responses API (input_tokens, input_tokens_details) or Chat Completions (prompt_tokens,
 * prompt_tokens_details), in the meter's terms: input is ordinary input only, as for Anthropic, with cached reads and
 * cache writes apart.
 */
export function openaiUsage(u, model, serviceTier) {
	const total = u.input_tokens ?? u.prompt_tokens ?? 0;
	const details = u.input_tokens_details ?? u.prompt_tokens_details ?? {};
	const cacheRead = details.cached_tokens ?? 0;
	const cacheWrite = details.cache_write_tokens ?? 0;
	return {
		input: Math.max(0, total - cacheRead - cacheWrite),
		output: u.output_tokens ?? u.completion_tokens ?? 0,
		cacheRead,
		cacheWrite,
		cacheWrite12h: details.cache_write_tokens_details?.ttl_12h_tokens ?? 0,
		reasoning: (u.output_tokens_details ?? u.completion_tokens_details)?.reasoning_tokens ?? 0,
		model,
		...(serviceTier ? { serviceTier } : {}),
	};
}

/** The usage an OpenAI event or response carries, or undefined: a finished Responses response, or a Chat Completions one. */
export function usageFromOpenAIEvent(event) {
	const response = event?.response && typeof event.response === "object" ? event.response : event;
	if (response?.usage && typeof response.usage === "object") return openaiUsage(response.usage, response.model, response.service_tier);
	return undefined;
}

/** Token counts from one OpenAI response, streamed (SSE) or not; the last usage it reports. */
export function usageFromOpenAI(body, contentType) {
	let usage;
	if (contentType?.includes("text/event-stream")) {
		for (const line of body.split("\n")) {
			if (!line.startsWith("data:")) continue;
			let event;
			try {
				event = JSON.parse(line.slice(5).trim());
			} catch {
				continue;
			}
			usage = usageFromOpenAIEvent(event) ?? usage;
		}
	} else {
		try {
			usage = usageFromOpenAIEvent(JSON.parse(body));
		} catch {}
	}
	return usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: undefined };
}

/** How a request asked the model to work, from its body; never the prompt. */
export function askedOf(provider, sent) {
	if (provider === "openai") {
		return {
			askedModel: sent.model,
			effort: sent.reasoning?.effort ?? sent.reasoning_effort,
			maxTokens: sent.max_output_tokens ?? sent.max_completion_tokens ?? sent.max_tokens,
			...(sent.service_tier ? { serviceTierAsked: sent.service_tier } : {}),
		};
	}
	return { askedModel: sent.model, thinking: sent.thinking?.type, effort: sent.output_config?.effort, maxTokens: sent.max_tokens };
}

function log(entry) {
	appendFileSync(values.log, `${JSON.stringify(entry)}\n`);
}

/** What the meter adds to a log line for a priced response; the assumed-tier mark when the tier has no listed price. */
function priced(usage) {
	const cost = costOf(usage);
	if (cost) spentUsd += cost;
	if (cost === undefined) return {};
	const assumed = usage.serviceTier && !(usage.serviceTier in OPENAI_TIERS) ? { tierPriceAssumed: UNKNOWN_TIER_MULTIPLIER } : {};
	return { costUsd: cost, spentUsd, ...assumed };
}

const fault = values.fault;
if (fault !== undefined && fault !== "network" && fault !== "errors") throw new Error(`unknown --fault ${fault}`);
let firstModelRequestAt;
/** Client connections of model requests in progress, so a network fault can cut them when it starts. */
const openModelSockets = new Set();
/** True while the fault window is open: it opens --fault-after-sec after the first model request. */
function faultActive(now) {
	if (!fault || firstModelRequestAt === undefined) return false;
	const opens = firstModelRequestAt + Number(values["fault-after-sec"]) * 1000;
	return now >= opens && now < opens + Number(values["fault-for-sec"]) * 1000;
}
function noteModelRequest(started) {
	if (firstModelRequestAt !== undefined) return;
	firstModelRequestAt = started;
	if (fault === "network") {
		setTimeout(() => {
			for (const socket of openModelSockets) socket.destroy();
			if (openModelSockets.size) log({ ts: new Date().toISOString(), fault, cutInFlight: openModelSockets.size });
			openModelSockets.clear();
		}, Number(values["fault-after-sec"]) * 1000).unref();
	}
}

/** The provider's own error shapes, for the answers the meter gives in its place. */
const errorBody = {
	anthropic: {
		cap: () => ({ type: "error", error: { type: "spend_cap_reached", message: `This run reached its spend cap of ${capUsd}.` } }),
		overloaded: () => ({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
		unreachable: () => ({ type: "error", error: { type: "meter_upstream_unreachable", message: "The cost meter could not reach the provider." } }),
	},
	openai: {
		// insufficient_quota is OpenAI's own word for "no more spend allowed"; tools stop on it instead of retrying.
		cap: () => ({ error: { type: "insufficient_quota", code: "insufficient_quota", message: `This run reached its spend cap of ${capUsd}.`, param: null } }),
		overloaded: () => ({ error: { type: "server_error", code: "server_is_overloaded", message: "Overloaded", param: null } }),
		unreachable: () => ({ error: { type: "server_error", code: "meter_upstream_unreachable", message: "The cost meter could not reach the provider.", param: null } }),
	},
};
const faultStatus = { anthropic: 529, openai: 503 };

async function handle(req, res) {
	const started = Date.now();
	const provider = providerForHost(req.headers.host);
	const isModelRequest = req.method === "POST" && isModelPath(provider, req.url);
	if (isModelRequest) {
		noteModelRequest(started);
		openModelSockets.add(req.socket);
		res.on("close", () => openModelSockets.delete(req.socket));
	}
	if (isModelRequest && faultActive(started)) {
		for await (const _ of req) {}
		log({ ts: new Date().toISOString(), path: req.url, fault, ms: 0 });
		if (fault === "network") {
			req.socket.destroy();
			return;
		}
		res.writeHead(faultStatus[provider], { "content-type": "application/json" });
		res.end(JSON.stringify(errorBody[provider].overloaded()));
		return;
	}
	if (capUsd !== undefined && spentUsd >= capUsd && req.method === "POST") {
		for await (const _ of req) {}
		log({ ts: new Date().toISOString(), path: req.url, status: 429, refused: "spend_cap_reached", spentUsd, ms: 0 });
		res.writeHead(429, { "content-type": "application/json" });
		res.end(JSON.stringify(errorBody[provider].cap()));
		return;
	}
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const headers = {};
	for (const [name, value] of Object.entries(req.headers)) {
		if (!HOP_BY_HOP.has(name)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
	}
	const target = new URL(req.url, upstreams[provider]);
	let response;
	try {
		response = await forward(req.method, target, headers, chunks.length ? Buffer.concat(chunks) : undefined);
	} catch (error) {
		log({ ts: new Date().toISOString(), path: target.pathname, status: 0, error: String(error).slice(0, 200), ms: Date.now() - started });
		res.writeHead(502, { "content-type": "application/json" });
		res.end(JSON.stringify(errorBody[provider].unreachable()));
		return;
	}
	// The response goes back byte for byte, in the provider's own encoding, and is decoded only for the log.
	const outHeaders = {};
	for (const [name, value] of Object.entries(response.headers)) {
		if (!HOP_BY_HOP.has(name)) outHeaders[name] = value;
	}
	res.writeHead(response.statusCode, outHeaders);
	const contentType = response.headers["content-type"] ?? "";
	const raw = [];
	for await (const chunk of response) {
		res.write(chunk);
		raw.push(chunk);
	}
	res.end();
	const text = decodeBody(Buffer.concat(raw), response.headers["content-encoding"]);
	const metered = req.method === "POST" && isModelPath(provider, target.pathname);
	const usage = metered ? (provider === "openai" ? usageFromOpenAI(text, contentType) : usageFromAnthropic(text, contentType)) : undefined;
	let asked;
	if (metered) {
		try {
			asked = askedOf(provider, JSON.parse(decodeBody(Buffer.concat(chunks), req.headers["content-encoding"])));
		} catch {}
	}
	log({
		ts: new Date().toISOString(),
		path: target.pathname,
		...(provider === "openai" ? { provider } : {}),
		status: response.statusCode,
		ms: Date.now() - started,
		...(asked ?? {}),
		...(usage ?? {}),
		...(usage ? priced(usage) : {}),
	});
}

// ---- WebSockets: just enough of RFC 6455 to read the provider's events as they pass, and to stop at the cap.

/** Frames at the front of `buffer`: { frames: [{ fin, opcode, payload, raw }], rest } (rest is an incomplete frame). */
export function parseFrames(buffer) {
	const frames = [];
	let at = 0;
	while (buffer.length - at >= 2) {
		const b0 = buffer[at];
		const b1 = buffer[at + 1];
		let length = b1 & 0x7f;
		let offset = at + 2;
		if (length === 126) {
			if (buffer.length < offset + 2) break;
			length = buffer.readUInt16BE(offset);
			offset += 2;
		} else if (length === 127) {
			if (buffer.length < offset + 8) break;
			length = Number(buffer.readBigUInt64BE(offset));
			offset += 8;
		}
		const masked = (b1 & 0x80) !== 0;
		const mask = masked ? buffer.subarray(offset, offset + 4) : null;
		if (masked) offset += 4;
		if (buffer.length < offset + length) break;
		const payload = Buffer.from(buffer.subarray(offset, offset + length));
		if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
		frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload, raw: buffer.subarray(at, offset + length) });
		at = offset + length;
	}
	return { frames, rest: buffer.subarray(at) };
}

/** One frame: a client's frames are masked (RFC 6455), a server's are not. */
export function encodeFrame({ opcode = 1, payload = Buffer.alloc(0), fin = true, mask = false }) {
	const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
	const head = [((fin ? 0x80 : 0) | opcode) & 0xff];
	const maskBit = mask ? 0x80 : 0;
	if (data.length < 126) head.push(maskBit | data.length);
	else if (data.length < 65_536) head.push(maskBit | 126, data.length >> 8, data.length & 0xff);
	else {
		const len = Buffer.alloc(8);
		len.writeBigUInt64BE(BigInt(data.length));
		head.push(maskBit | 127, ...len);
	}
	if (!mask) return Buffer.concat([Buffer.from(head), data]);
	const key = createHash("sha256").update(`${Date.now()}${Math.random()}`).digest().subarray(0, 4);
	const body = Buffer.from(data);
	for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4];
	return Buffer.concat([Buffer.from(head), key, body]);
}

/** Reads one direction of a socket frame by frame; calls onMessage(text, frames) for each whole data message. */
function messageReader(onFrame, onMessage) {
	let pending = Buffer.alloc(0);
	let parts = [];
	let frames = [];
	return (chunk) => {
		pending = Buffer.concat([pending, chunk]);
		const parsed = parseFrames(pending);
		pending = Buffer.from(parsed.rest);
		for (const frame of parsed.frames) {
			if (frame.opcode >= 8) {
				onFrame(frame);
				continue;
			}
			parts.push(frame.payload);
			frames.push(frame);
			if (frame.fin) {
				const whole = frames;
				const text = Buffer.concat(parts).toString("utf8");
				parts = [];
				frames = [];
				onMessage(text, whole);
			}
		}
	};
}

function handleUpgrade(req, socket, head) {
	const started = Date.now();
	const provider = providerForHost(req.headers.host);
	const target = new URL(req.url, upstreams[provider]);
	const modelSocket = isModelPath(provider, target.pathname);
	const refuse = (status, reason, body) => {
		socket.end(`HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify(body)}`);
	};
	if (modelSocket) {
		noteModelRequest(started);
		if (faultActive(started)) {
			log({ ts: new Date().toISOString(), path: target.pathname, transport: "websocket", fault, ms: 0 });
			if (fault === "network") return socket.destroy();
			return refuse(faultStatus[provider], "Overloaded", errorBody[provider].overloaded());
		}
		if (capUsd !== undefined && spentUsd >= capUsd) {
			log({ ts: new Date().toISOString(), path: target.pathname, transport: "websocket", status: 429, refused: "spend_cap_reached", spentUsd, ms: 0 });
			return refuse(429, "Too Many Requests", errorBody[provider].cap());
		}
		openModelSockets.add(socket);
		socket.on("close", () => openModelSockets.delete(socket));
	}
	const secure = target.protocol === "https:" || target.protocol === "wss:";
	const port = Number(target.port || (secure ? 443 : 80));
	const lookup = values["resolve-upstream-by-dns"] ? { lookup: lookupByDns } : {};
	const up = secure
		? tlsConnect({ host: target.hostname, port, servername: target.hostname, ALPNProtocols: ["http/1.1"], ...lookup })
		: netConnect({ host: target.hostname, port, ...lookup });
	const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`, `host: ${target.host}`];
	for (let i = 0; i < req.rawHeaders.length; i += 2) {
		const name = req.rawHeaders[i];
		if (/^(host|sec-websocket-extensions)$/i.test(name)) continue;
		lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
	}
	up.on("error", (error) => {
		log({ ts: new Date().toISOString(), path: target.pathname, transport: "websocket", status: 0, error: String(error).slice(0, 200), ms: Date.now() - started });
		if (!socket.destroyed) refuse(502, "Bad Gateway", errorBody[provider].unreachable());
	});
	socket.on("error", () => up.destroy());
	up.on(secure ? "secureConnect" : "connect", () => {
		up.write(`${lines.join("\r\n")}\r\n\r\n`);
		if (head?.length) up.write(head);
	});

	// Model requests on this socket, oldest first, so each finished response is logged with what it asked for.
	const asked = [];
	const fromClient = messageReader(
		(frame) => up.write(frame.raw),
		(text, frames) => {
			let message;
			try {
				message = JSON.parse(text);
			} catch {}
			if (message?.type === "response.create") {
				if (capUsd !== undefined && spentUsd >= capUsd) {
					log({ ts: new Date().toISOString(), path: target.pathname, transport: "websocket", status: 429, refused: "spend_cap_reached", spentUsd, ms: 0 });
					socket.write(encodeFrame({ opcode: 1, payload: JSON.stringify({ type: "error", status: 429, ...errorBody[provider].cap() }) }));
					socket.end(encodeFrame({ opcode: 8, payload: Buffer.concat([Buffer.from([0x03, 0xf0]), Buffer.from("spend cap reached")]) }));
					up.destroy();
					return;
				}
				asked.push({ at: Date.now(), streamId: message.stream_id, ...askedOf(provider, message.response ?? message) });
			}
			for (const frame of frames) up.write(frame.raw);
		},
	);
	const fromUpstream = messageReader(
		() => {},
		(text) => {
			let event;
			try {
				event = JSON.parse(text);
			} catch {
				return;
			}
			if (!/^response\.(completed|incomplete|failed|done)$/.test(event?.type ?? "")) return;
			const usage = usageFromOpenAIEvent(event);
			if (!usage) return;
			// A socket can carry several responses at once ("lanes", by stream_id); pair by lane, else oldest first.
			const lane = event.stream_id ?? event.response?.stream_id;
			const index = Math.max(0, asked.findIndex((a) => lane !== undefined && a.streamId === lane));
			const [request = {}] = asked.splice(index, 1);
			const { at, streamId, ...askedFields } = request;
			log({
				ts: new Date().toISOString(),
				path: target.pathname,
				provider,
				transport: "websocket",
				status: event.type === "response.failed" ? 500 : 200,
				ms: Date.now() - (at ?? started),
				...askedFields,
				...usage,
				...priced(usage),
			});
		},
	);

	// "handshake" until the provider's answer is in; then "open" (frames, read on the side) or "refused" (passed as is).
	let handshake = Buffer.alloc(0);
	let state = "handshake";
	up.on("data", (chunk) => {
		if (state === "open") {
			socket.write(chunk);
			fromUpstream(chunk);
			return;
		}
		if (state === "refused") {
			socket.write(chunk);
			return;
		}
		handshake = Buffer.concat([handshake, chunk]);
		const end = handshake.indexOf("\r\n\r\n");
		if (end === -1) return;
		const headerBlock = handshake.subarray(0, end + 4);
		const rest = handshake.subarray(end + 4);
		socket.write(headerBlock);
		const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(headerBlock.toString("latin1"))?.[1] ?? 0);
		if (status !== 101) {
			log({ ts: new Date().toISOString(), path: target.pathname, transport: "websocket", status, ms: Date.now() - started });
			state = "refused";
			socket.write(rest);
			return;
		}
		state = "open";
		if (/sec-websocket-extensions/i.test(headerBlock.toString("latin1"))) {
			log({ ts: new Date().toISOString(), path: target.pathname, transport: "websocket", warning: "the provider negotiated an extension; its events may not be readable" });
		}
		socket.on("data", fromClient);
		if (rest.length) {
			socket.write(rest);
			fromUpstream(rest);
		}
	});
	up.on("end", () => socket.end());
	up.on("close", () => socket.destroy());
	socket.on("close", () => up.destroy());
}

const server =
	values["tls-cert"] && values["tls-key"]
		? createHttpsServer({ cert: readFileSync(values["tls-cert"]), key: readFileSync(values["tls-key"]) }, handle)
		: createHttpServer(handle);
server.on("upgrade", handleUpgrade);
// A client that refuses the certificate or speaks something else never reaches handle(); say so, for whoever debugs a run.
server.on("tlsClientError", (error) => process.stderr.write(`tls client error: ${error.code ?? ""} ${error.message}\n`));
server.on("clientError", (error, socket) => {
	process.stderr.write(`client error: ${error.code ?? ""} ${error.message}\n`);
	socket.destroy();
});

if (process.argv[1] === new URL(import.meta.url).pathname) {
	server.listen(Number(values.port), values.host, () => {
		const scheme = values["tls-cert"] ? "https" : "http";
		process.stdout.write(`meter listening on ${scheme}://${values.host}:${values.port} -> ${upstreams.anthropic.origin}, ${upstreams.openai.origin}, log ${values.log}\n`);
	});
	if (values["plain-port"]) {
		const plain = createHttpServer(handle);
		plain.on("upgrade", handleUpgrade);
		plain.listen(Number(values["plain-port"]), "127.0.0.1", () => {
			process.stdout.write(`meter also listening on http://127.0.0.1:${values["plain-port"]}\n`);
		});
	}
}
