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
// Test D's faults (PREREGISTRATION.md) are injected here, the same way for every tool: --fault network drops every model
// request's connection, and --fault errors answers every model request 529 overloaded_error, from --fault-after-sec
// after the run's first model request, for --fault-for-sec. When a network fault starts, model connections already open
// are cut too, as a real outage would. Each faulted request is logged with its fault.
import { Resolver } from "node:dns";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		port: { type: "string", default: "8787" },
		upstream: { type: "string", default: "https://api.anthropic.com" },
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

/** The response text for parsing token counts, whatever encoding the provider chose. */
function decodeBody(raw, encoding) {
	try {
		if (encoding === "gzip") return gunzipSync(raw).toString("utf8");
		if (encoding === "br") return brotliDecompressSync(raw).toString("utf8");
		if (encoding === "deflate") return inflateSync(raw).toString("utf8");
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

function log(entry) {
	appendFileSync(values.log, `${JSON.stringify(entry)}\n`);
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

async function handle(req, res) {
	const started = Date.now();
	const isModelRequest = req.method === "POST" && req.url?.split("?")[0].endsWith("/messages");
	if (isModelRequest && firstModelRequestAt === undefined) {
		firstModelRequestAt = started;
		if (fault === "network") {
			setTimeout(() => {
				for (const socket of openModelSockets) socket.destroy();
				if (openModelSockets.size) log({ ts: new Date().toISOString(), fault, cutInFlight: openModelSockets.size });
				openModelSockets.clear();
			}, Number(values["fault-after-sec"]) * 1000).unref();
		}
	}
	if (isModelRequest) {
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
		res.writeHead(529, { "content-type": "application/json" });
		res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
		return;
	}
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
		response = await forward(req.method, target, headers, chunks.length ? Buffer.concat(chunks) : undefined);
	} catch (error) {
		log({ ts: new Date().toISOString(), path: target.pathname, status: 0, error: String(error).slice(0, 200), ms: Date.now() - started });
		res.writeHead(502, { "content-type": "application/json" });
		res.end(JSON.stringify({ type: "error", error: { type: "meter_upstream_unreachable", message: "The cost meter could not reach the provider." } }));
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
		status: response.statusCode,
		ms: Date.now() - started,
		...(asked ?? {}),
		...(usage ?? {}),
		...(cost === undefined ? {} : { costUsd: cost, spentUsd }),
	});
}

const server =
	values["tls-cert"] && values["tls-key"]
		? createHttpsServer({ cert: readFileSync(values["tls-cert"]), key: readFileSync(values["tls-key"]) }, handle)
		: createHttpServer(handle);
// A client that refuses the certificate or speaks something else never reaches handle(); say so, for whoever debugs a run.
server.on("tlsClientError", (error) => process.stderr.write(`tls client error: ${error.code ?? ""} ${error.message}\n`));
server.on("clientError", (error, socket) => {
	process.stderr.write(`client error: ${error.code ?? ""} ${error.message}\n`);
	socket.destroy();
});

if (process.argv[1] === new URL(import.meta.url).pathname) {
	server.listen(Number(values.port), values.host, () => {
		const scheme = values["tls-cert"] ? "https" : "http";
		process.stdout.write(`meter listening on ${scheme}://${values.host}:${values.port} -> ${upstream.origin}, log ${values.log}\n`);
	});
	if (values["plain-port"]) {
		createHttpServer(handle).listen(Number(values["plain-port"]), "127.0.0.1", () => {
			process.stdout.write(`meter also listening on http://127.0.0.1:${values["plain-port"]}\n`);
		});
	}
}
