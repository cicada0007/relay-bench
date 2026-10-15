// Runs the meter against a fake provider: a plain JSON response and a streamed one must both pass through unchanged
// and be logged with the token counts the provider reported. No network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const here = new URL(".", import.meta.url).pathname;

function fakeProvider() {
	return createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const parsed = JSON.parse(body || "{}");
			assert.equal(req.headers["x-api-key"], "test-key");
			if (parsed.stream) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":120,"output_tokens":1,"cache_read_input_tokens":3000,"cache_creation_input_tokens":40}}}\n\n');
				res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n');
				res.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":57}}\n\n');
			} else {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ model: "claude-sonnet-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
			}
		});
	});
}

test("passes responses through and logs the provider's token counts", async () => {
	const provider = fakeProvider();
	await new Promise((r) => provider.listen(0, "127.0.0.1", r));
	const upstream = `http://127.0.0.1:${provider.address().port}`;
	const log = join(mkdtempSync(join(tmpdir(), "meter-")), "usage.jsonl");
	const port = String(20000 + Math.floor(Math.random() * 20000));
	const meter = spawn(process.execPath, [join(here, "meter.mjs"), "--port", port, "--upstream", upstream, "--log", log], { stdio: ["ignore", "pipe", "inherit"] });
	await new Promise((resolve) => meter.stdout.once("data", resolve));
	try {
		const call = (body) =>
			fetch(`http://127.0.0.1:${port}/v1/messages`, {
				method: "POST",
				headers: { "x-api-key": "test-key", "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const plain = await call({ model: "claude-sonnet-5-5" });
		assert.equal((await plain.json()).content[0].text, "ok");
		const streamed = await call({ model: "claude-haiku-5-5", stream: true });
		const text = await streamed.text();
		assert.match(text, /message_delta/);
		await new Promise((r) => setTimeout(r, 100));
		const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.equal(lines.length, 2);
		assert.deepEqual([lines[0].model, lines[0].input, lines[0].output], ["claude-sonnet-5-5", 10, 4]);
		assert.deepEqual([lines[1].model, lines[1].input, lines[1].output, lines[1].cacheRead, lines[1].cacheWrite], ["claude-haiku-5-5", 120, 57, 3000, 40]);
		assert.ok(!readFileSync(log, "utf8").includes("test-key"), "the key must never be logged");
	} finally {
		meter.kill();
		provider.close();
	}
});

test("prices responses at Anthropic's list prices, with Haiku 5.5's long-context tier", async () => {
	const { costOf } = await import("./meter.mjs");
	// Sonnet 5.5: 1M input $2, 1M output $10, cache hits $0.10, a 5-minute write 1.25x input.
	assert.equal(costOf({ model: "claude-sonnet-5-5", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 }).toFixed(4), "12.1000");
	assert.equal(costOf({ model: "claude-sonnet-5-5", input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }).toFixed(4), "2.5000");
	assert.equal(costOf({ model: "claude-sonnet-5-5", input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 }).toFixed(4), "4.0000");
	// Haiku 5.5 at 100,000 prompt tokens is base price; one token more and the whole request is long-context.
	assert.equal(costOf({ model: "claude-haiku-5-5", input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 }).toFixed(4), "0.0100");
	// 100,001 x $0.50 + 1,000 x $2.50, per million = $0.0525005.
	assert.ok(Math.abs(costOf({ model: "claude-haiku-5-5", input: 100_001, output: 1_000, cacheRead: 0, cacheWrite: 0 }) - 0.0525005) < 1e-12);
	assert.equal(costOf({ model: "some-other-model", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), undefined);
});

test("refuses model requests once the run's spend cap is reached", async () => {
	const provider = fakeProvider();
	await new Promise((r) => provider.listen(0, "127.0.0.1", r));
	const log = join(mkdtempSync(join(tmpdir(), "meter-")), "usage.jsonl");
	const port = String(20000 + Math.floor(Math.random() * 20000));
	// The fake Sonnet response costs 10 input + 4 output tokens = $0.00006; a cap of $0.00005 is reached after one call.
	const meter = spawn(process.execPath, [join(here, "meter.mjs"), "--port", port, "--upstream", `http://127.0.0.1:${provider.address().port}`, "--log", log, "--cap-usd", "0.00005"], { stdio: ["ignore", "pipe", "inherit"] });
	await new Promise((resolve) => meter.stdout.once("data", resolve));
	try {
		const call = () => fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers: { "x-api-key": "test-key", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5-5" }) });
		assert.equal((await call()).status, 200);
		const refused = await call();
		assert.equal(refused.status, 429);
		assert.equal((await refused.json()).error.type, "spend_cap_reached");
	} finally {
		meter.kill();
		provider.close();
	}
});

test("serves HTTPS with the run's certificate and passes compressed responses through unchanged", async () => {
	const { execFileSync } = await import("node:child_process");
	const { gzipSync, gunzipSync } = await import("node:zlib");
	const { request } = await import("node:https");
	const dir = mkdtempSync(join(tmpdir(), "meter-tls-"));
	execFileSync("openssl", [
		"req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
		"-addext", "subjectAltName=DNS:localhost", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
	], { stdio: "ignore" });
	const provider = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
			res.end(gzipSync(JSON.stringify({ model: "claude-sonnet-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 7, output_tokens: 3 } })));
		});
	});
	await new Promise((r) => provider.listen(0, "127.0.0.1", r));
	const log = join(dir, "usage.jsonl");
	const port = String(20000 + Math.floor(Math.random() * 20000));
	const meter = spawn(process.execPath, [
		join(here, "meter.mjs"), "--port", port, "--upstream", `http://127.0.0.1:${provider.address().port}`, "--log", log,
		"--tls-cert", join(dir, "cert.pem"), "--tls-key", join(dir, "key.pem"),
	], { stdio: ["ignore", "pipe", "inherit"] });
	await new Promise((resolve) => meter.stdout.once("data", resolve));
	try {
		const reply = await new Promise((resolve, reject) => {
			const req = request(
				{ host: "127.0.0.1", servername: "localhost", port, path: "/v1/messages", method: "POST", ca: readFileSync(join(dir, "cert.pem")), headers: { "content-type": "application/json" } },
				(res) => {
					const parts = [];
					res.on("data", (c) => parts.push(c));
					res.on("end", () => resolve({ encoding: res.headers["content-encoding"], body: Buffer.concat(parts) }));
				},
			);
			req.on("error", reject);
			req.end(JSON.stringify({ model: "claude-sonnet-5-5" }));
		});
		assert.equal(reply.encoding, "gzip");
		assert.equal(JSON.parse(gunzipSync(reply.body)).content[0].text, "ok");
		await new Promise((r) => setTimeout(r, 100));
		const line = JSON.parse(readFileSync(log, "utf8").trim());
		assert.deepEqual([line.model, line.input, line.output], ["claude-sonnet-5-5", 7, 3]);
	} finally {
		meter.kill();
		provider.close();
	}
});
