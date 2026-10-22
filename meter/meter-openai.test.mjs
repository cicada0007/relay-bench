// The meter on OpenAI traffic: pricing, the usage fields of the Responses and Chat Completions APIs, routing by host,
// the spend cap, and the Responses API over a WebSocket (Codex's default). Against fake providers; no network.
//
// The response fixtures in meter/fixtures/ are written by hand from OpenAI's documented shapes (the API references, the
// prompt-caching guide for cache_write_tokens and its 30-minute and 12-hour split, and the WebSocket-mode guide), read on
// 23 October 2026. They are not recorded from a live call: no OpenAI key was used. Replace them with recorded responses
// from the first real run.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as zlib from "node:zlib";
import {
	costOf,
	encodeFrame,
	isModelPath,
	parseFrames,
	priceFor,
	providerForHost,
	UNKNOWN_TIER_MULTIPLIER,
	usageFromOpenAI,
	usageFromOpenAIEvent,
} from "./meter.mjs";

const here = new URL(".", import.meta.url).pathname;
const fixture = (name) => readFileSync(join(here, "fixtures", name), "utf8");
const close = (a, b) => Math.abs(a - b) < 1e-12;

test("OpenAI list prices: ordinary input, cached reads, 30-minute and 12-hour writes, output, long context", () => {
	// GPT-6.1 Sol: $2 input, $10 output, $0.10 cached, $2.50 a 30-minute write, $5 a 12-hour write, per million.
	const sol = { model: "gpt-6.1-sol-2026-09-30", input: 100_000, output: 10_000, cacheRead: 100_000, cacheWrite: 50_000, cacheWrite12h: 20_000 };
	// 0.1M x 2 + 0.01M x 10 + 0.1M x 0.1 + 0.03M x 2.5 + 0.02M x 5 = 0.2 + 0.1 + 0.01 + 0.075 + 0.1
	assert.ok(close(costOf(sol), 0.485));
	// Over 272,000 input tokens the whole request is at long-context prices: $4, $15, $0.20, $5, $10.
	const long = { ...sol, input: 200_000 };
	assert.ok(close(costOf(long), 0.2 * 4 + 0.01 * 15 + 0.1 * 0.2 + 0.03 * 5 + 0.02 * 10));
	// Exactly 272,000 is still short context.
	assert.ok(close(costOf({ model: "gpt-6-luna", input: 272_000, output: 0, cacheRead: 0, cacheWrite: 0 }), 0.0272));
	assert.ok(close(costOf({ model: "gpt-6-luna", input: 272_001, output: 0, cacheRead: 0, cacheWrite: 0 }), 272_001 * 0.2 / 1e6));
	// The longest listed id wins: gpt-6.1-sol is not gpt-6-sol, and an unlisted model has no price.
	assert.equal(priceFor("gpt-6.1-sol-2026-09-30").cacheRead, 0.1);
	assert.equal(priceFor("gpt-6-sol").cacheRead, 0.2);
	assert.equal(costOf({ model: "gpt-6", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), undefined);
	// Anthropic prices are unchanged by the OpenAI ones.
	assert.equal(costOf({ model: "claude-sonnet-5-5", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 }).toFixed(4), "12.1000");
});

test("OpenAI processing tiers: flex is half price; a tier with no listed price is assumed at the highest multiplier", () => {
	const base = { model: "gpt-6-luna", input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 };
	assert.ok(close(costOf({ ...base, serviceTier: "default" }), 0.01));
	assert.ok(close(costOf({ ...base, serviceTier: "flex" }), 0.005));
	assert.ok(close(costOf({ ...base, serviceTier: "priority" }), 0.01 * UNKNOWN_TIER_MULTIPLIER));
});

test("Responses usage, plain and streamed, is read into the meter's terms", () => {
	const plain = usageFromOpenAI(fixture("openai-responses.json"), "application/json");
	// input_tokens 12,000 = 1,000 ordinary + 4,000 cached reads + 7,000 cache writes (4,000 of them 12-hour).
	assert.deepEqual(plain, { input: 1000, output: 900, cacheRead: 4000, cacheWrite: 7000, cacheWrite12h: 4000, reasoning: 600, model: "gpt-6.1-sol-2026-09-30", serviceTier: "default" });
	assert.ok(close(costOf(plain), (1000 * 2 + 900 * 10 + 4000 * 0.1 + 3000 * 2.5 + 4000 * 5) / 1e6));
	const streamed = usageFromOpenAI(fixture("openai-responses.sse"), "text/event-stream; charset=utf-8");
	assert.deepEqual(streamed, { input: 50000, output: 2000, cacheRead: 250000, cacheWrite: 0, cacheWrite12h: 0, reasoning: 1500, model: "gpt-6-luna-2026-08-14", serviceTier: "default" });
	// 300,000 input tokens: long context.
	assert.ok(close(costOf(streamed), (50000 * 0.2 + 2000 * 0.75 + 250000 * 0.02) / 1e6));
});

test("Chat Completions usage, plain and streamed, is read the same way", () => {
	const plain = usageFromOpenAI(fixture("openai-chat.json"), "application/json");
	assert.deepEqual(plain, { input: 400, output: 200, cacheRead: 600, cacheWrite: 0, cacheWrite12h: 0, reasoning: 50, model: "gpt-6-sol-2026-06-01", serviceTier: "flex" });
	assert.ok(close(costOf(plain), ((400 * 2 + 200 * 10 + 600 * 0.2) / 1e6) * 0.5));
	const streamed = usageFromOpenAI(fixture("openai-chat-stream.sse"), "text/event-stream");
	assert.equal(streamed.input, 500);
	assert.equal(streamed.output, 40);
	assert.equal(streamed.model, "gpt-6.1-sol-2026-09-30");
	assert.equal(streamed.serviceTier, "priority");
	assert.equal(usageFromOpenAIEvent({ type: "response.output_text.delta", delta: "x" }), undefined);
});

test("requests go to the provider their host names, and only token-asking paths are metered", () => {
	assert.equal(providerForHost("api.openai.com"), "openai");
	assert.equal(providerForHost("API.OpenAI.com:443"), "openai");
	assert.equal(providerForHost("api.anthropic.com"), "anthropic");
	assert.equal(providerForHost("127.0.0.1:8787"), "anthropic");
	assert.ok(isModelPath("openai", "/v1/responses"));
	assert.ok(isModelPath("openai", "/v1/responses/compact"));
	assert.ok(isModelPath("openai", "/v1/chat/completions?x=1"));
	assert.ok(!isModelPath("openai", "/v1/models"));
	assert.ok(isModelPath("anthropic", "/v1/messages"));
	assert.ok(!isModelPath("anthropic", "/v1/responses"));
});

/** A fake OpenAI: plain HTTP for /v1/responses and /v1/chat/completions, and the Responses API over a WebSocket. */
function fakeOpenAI({ seen }) {
	const server = createServer((req, res) => {
		const parts = [];
		req.on("data", (c) => parts.push(c));
		req.on("end", () => {
			seen.http.push({ path: req.url, headers: req.headers });
			if (req.url === "/v1/responses") {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(fixture("openai-responses.sse"));
			} else {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(fixture("openai-chat.json"));
			}
		});
	});
	server.on("upgrade", (req, socket) => {
		seen.upgrades.push(req.headers);
		const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			const parsed = parseFrames(Buffer.concat([buffer, chunk]));
			buffer = Buffer.from(parsed.rest);
			for (const frame of parsed.frames) {
				if (frame.opcode !== 1) continue;
				seen.messages.push(JSON.parse(frame.payload.toString("utf8")));
				for (const line of fixture("openai-responses-ws.jsonl").split("\n").filter(Boolean)) socket.write(encodeFrame({ opcode: 1, payload: line }));
			}
		});
		socket.on("error", () => {});
	});
	return server;
}

async function startMeter(extra = []) {
	const seen = { http: [], upgrades: [], messages: [] };
	const anthropic = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			seen.http.push({ path: req.url, anthropic: true });
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ model: "claude-haiku-5-5", usage: { input_tokens: 5, output_tokens: 1 } }));
		});
	});
	const openai = fakeOpenAI({ seen });
	await new Promise((r) => anthropic.listen(0, "127.0.0.1", r));
	await new Promise((r) => openai.listen(0, "127.0.0.1", r));
	const log = join(mkdtempSync(join(tmpdir(), "meter-openai-")), "usage.jsonl");
	const port = String(20000 + Math.floor(Math.random() * 20000));
	const meter = spawn(
		process.execPath,
		[join(here, "meter.mjs"), "--port", port, "--upstream", `http://127.0.0.1:${anthropic.address().port}`, "--openai-upstream", `http://127.0.0.1:${openai.address().port}`, "--log", log, ...extra],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	await new Promise((resolve) => meter.stdout.once("data", resolve));
	const lines = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const stop = () => {
		meter.kill();
		anthropic.close();
		openai.close();
	};
	return { port, seen, lines, stop, log };
}

/** One HTTP request to the meter with a chosen Host header, as a tool resolving api.openai.com to it would send. */
function post(port, host, path, body, headers = {}) {
	return new Promise((resolve, reject) => {
		const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
		const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { host, "content-type": "application/json", authorization: "Bearer sk-test-key", "content-length": data.length, ...headers } }, (res) => {
			const parts = [];
			res.on("data", (c) => parts.push(c));
			res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString("utf8") }));
		});
		req.on("error", reject);
		req.end(data);
	});
}

test("OpenAI requests reach OpenAI, pass through unchanged, and are logged with their usage, effort and cost", async () => {
	const m = await startMeter();
	try {
		const streamed = await post(m.port, "api.openai.com", "/v1/responses", { model: "gpt-6-luna", stream: true, reasoning: { effort: "medium" }, max_output_tokens: 8000 });
		assert.equal(streamed.status, 200);
		assert.equal(streamed.body, fixture("openai-responses.sse"));
		// Codex compresses its request bodies; the meter still reads what was asked.
		const squeezed = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ model: "gpt-6-sol", reasoning_effort: "high" })));
		const chat = await post(m.port, "api.openai.com", "/v1/chat/completions", squeezed, { "content-encoding": "zstd" });
		assert.equal(JSON.parse(chat.body).id, "chatcmpl-fixture");
		await post(m.port, "api.anthropic.com", "/v1/messages", { model: "claude-haiku-5-5" });
		await new Promise((r) => setTimeout(r, 100));
		const [a, b, c] = m.lines();
		assert.deepEqual([a.provider, a.path, a.askedModel, a.effort, a.maxTokens, a.model, a.input, a.cacheRead, a.output, a.reasoning], ["openai", "/v1/responses", "gpt-6-luna", "medium", 8000, "gpt-6-luna-2026-08-14", 50000, 250000, 2000, 1500]);
		assert.ok(a.costUsd > 0);
		assert.deepEqual([b.askedModel, b.effort, b.serviceTier], ["gpt-6-sol", "high", "flex"]);
		assert.equal(c.model, "claude-haiku-5-5");
		assert.equal(c.provider, undefined);
		assert.ok(close(c.spentUsd, a.costUsd + b.costUsd + c.costUsd));
		assert.equal(m.seen.http.filter((h) => h.anthropic).length, 1);
		assert.equal(m.seen.http.find((h) => h.path === "/v1/responses").headers.authorization, "Bearer sk-test-key");
		assert.ok(!readFileSync(m.log, "utf8").includes("sk-test-key"), "the key is never logged");
	} finally {
		m.stop();
	}
});

test("at the spend cap, OpenAI requests are refused in OpenAI's own words, so tools stop", async () => {
	const m = await startMeter(["--cap-usd", "0.00001"]);
	try {
		assert.equal((await post(m.port, "api.openai.com", "/v1/responses", { model: "gpt-6-luna", stream: true })).status, 200);
		const refused = await post(m.port, "api.openai.com", "/v1/responses", { model: "gpt-6-luna", stream: true });
		assert.equal(refused.status, 429);
		assert.equal(JSON.parse(refused.body).error.code, "insufficient_quota");
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(m.lines()[1].refused, "spend_cap_reached");
	} finally {
		m.stop();
	}
});

/** A raw WebSocket client: the handshake by hand (with the Host a tool would send) and masked frames. */
async function wsClient(port, tls) {
	const socket = tls ? tlsConnect({ host: "127.0.0.1", port, servername: "api.openai.com", ca: tls.ca }) : connect({ host: "127.0.0.1", port });
	await new Promise((r) => socket.once(tls ? "secureConnect" : "connect", r));
	socket.write(
		[
			"GET /v1/responses HTTP/1.1",
			"Host: api.openai.com",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}`,
			"Sec-WebSocket-Version: 13",
			"Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits",
			"Authorization: Bearer sk-test-key",
			"",
			"",
		].join("\r\n"),
	);
	let raw = Buffer.alloc(0);
	let headers = null;
	const frames = [];
	const waiters = [];
	socket.on("data", (chunk) => {
		raw = Buffer.concat([raw, chunk]);
		if (!headers) {
			const end = raw.indexOf("\r\n\r\n");
			if (end === -1) return;
			headers = raw.subarray(0, end).toString("latin1");
			raw = raw.subarray(end + 4);
		}
		const parsed = parseFrames(raw);
		raw = Buffer.from(parsed.rest);
		frames.push(...parsed.frames);
		for (const w of waiters.splice(0)) w();
	});
	const closed = new Promise((r) => socket.on("close", r));
	const until = async (test) => {
		while (!test()) await new Promise((r) => waiters.push(r));
	};
	await until(() => headers);
	return { socket, frames, until, closed, headers: () => headers, send: (message) => socket.write(encodeFrame({ opcode: 1, payload: JSON.stringify(message), mask: true })) };
}

test("the Responses API over a WebSocket passes through unchanged and each finished response is metered", async () => {
	const m = await startMeter();
	try {
		const ws = await wsClient(m.port);
		assert.match(ws.headers(), /^HTTP\/1\.1 101/);
		ws.send({ type: "response.create", stream_id: "lane-1", model: "gpt-6-luna", reasoning: { effort: "low" }, input: [{ role: "user", content: "hi" }] });
		await ws.until(() => ws.frames.length >= 3);
		const expected = fixture("openai-responses-ws.jsonl").split("\n").filter(Boolean);
		assert.deepEqual(ws.frames.map((f) => f.payload.toString("utf8")), expected);
		// The provider saw the request unchanged, and no offer of compression.
		assert.equal(m.seen.messages[0].model, "gpt-6-luna");
		assert.equal(m.seen.upgrades[0]["sec-websocket-extensions"], undefined);
		assert.equal(m.seen.upgrades[0].authorization, "Bearer sk-test-key");
		await new Promise((r) => setTimeout(r, 100));
		const [line] = m.lines();
		assert.deepEqual([line.transport, line.provider, line.askedModel, line.effort, line.model, line.input, line.cacheRead, line.cacheWrite, line.output], ["websocket", "openai", "gpt-6-luna", "low", "gpt-6-luna-2026-08-14", 1000, 15000, 4000, 700]);
		assert.ok(close(line.costUsd, (1000 * 0.1 + 15000 * 0.01 + 4000 * 0.125 + 700 * 0.5) / 1e6));
		ws.socket.destroy();
	} finally {
		m.stop();
	}
});

test("on a WebSocket, a request after the cap is reached is answered with an error and never sent", async () => {
	const m = await startMeter(["--cap-usd", "0.0000001"]);
	try {
		const ws = await wsClient(m.port);
		ws.send({ type: "response.create", model: "gpt-6-luna", input: [] });
		await ws.until(() => ws.frames.length >= 3);
		ws.send({ type: "response.create", model: "gpt-6-luna", input: [] });
		await ws.closed;
		const error = JSON.parse(ws.frames.find((f) => f.opcode === 1 && f.payload.includes('"error"')).payload.toString("utf8"));
		assert.equal(error.type, "error");
		assert.equal(error.error.code, "insufficient_quota");
		assert.ok(ws.frames.some((f) => f.opcode === 8), "the meter closes the socket");
		assert.equal(m.seen.messages.length, 1, "the second request never reached the provider");
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(m.lines().at(-1).refused, "spend_cap_reached");
	} finally {
		m.stop();
	}
});

test("WebSocket frames: lengths of every size, masking, and a frame cut in two", () => {
	for (const size of [0, 5, 125, 126, 65_535, 65_536]) {
		const payload = Buffer.alloc(size, 7);
		for (const mask of [false, true]) {
			const { frames, rest } = parseFrames(encodeFrame({ opcode: 2, payload, mask }));
			assert.equal(rest.length, 0);
			assert.equal(frames.length, 1);
			assert.ok(frames[0].payload.equals(payload), `${size} ${mask}`);
		}
	}
	const whole = encodeFrame({ opcode: 1, payload: "hello", mask: true });
	const first = parseFrames(whole.subarray(0, 4));
	assert.equal(first.frames.length, 0);
	assert.equal(parseFrames(Buffer.concat([first.rest, whole.subarray(4)])).frames[0].payload.toString(), "hello");
});

test("over TLS with the run's certificate, as in the sandbox, the WebSocket is metered the same way", async () => {
	const dir = mkdtempSync(join(tmpdir(), "meter-ws-tls-"));
	execFileSync("openssl", [
		"req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=api.anthropic.com",
		"-addext", "subjectAltName=DNS:api.anthropic.com,DNS:api.openai.com", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
	], { stdio: "ignore" });
	const m = await startMeter(["--tls-cert", join(dir, "cert.pem"), "--tls-key", join(dir, "key.pem")]);
	try {
		const ws = await wsClient(m.port, { ca: readFileSync(join(dir, "cert.pem")) });
		assert.match(ws.headers(), /^HTTP\/1\.1 101/);
		ws.send({ type: "response.create", model: "gpt-6-luna", input: [] });
		await ws.until(() => ws.frames.length >= 3);
		await new Promise((r) => setTimeout(r, 100));
		const [line] = m.lines();
		assert.deepEqual([line.transport, line.model, line.output], ["websocket", "gpt-6-luna-2026-08-14", 700]);
		ws.socket.destroy();
	} finally {
		m.stop();
	}
});
