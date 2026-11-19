import assert from "node:assert/strict";
import { test } from "node:test";
import { responsesStreamTranslator, responsesToMessages, streamTranslator, toChatRequest, toMessagesError, toMessagesResponse, toResponsesRequest } from "./anthropic-chat.mjs";

const MODEL = "minimax.minimax-m2.5";

test("a Messages request becomes Chat Completions, leaving out what the model has no use for", () => {
	const chat = toChatRequest(
		{
			model: MODEL,
			max_tokens: 100,
			stream: true,
			thinking: { type: "adaptive" },
			system: [{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }],
			tools: [{ name: "Read", description: "reads", input_schema: { type: "object" } }, { type: "web_search_20260209", name: "web_search" }],
			tool_choice: { type: "any" },
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }, { type: "text", text: "reading" }, { type: "tool_use", id: "t1", name: "Read", input: { a: 1 } }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "body" }] }, { type: "text", text: "go on", cache_control: {} }] },
			],
		},
		MODEL,
	);
	assert.equal(chat.thinking, undefined);
	assert.deepEqual(chat.stream_options, { include_usage: true });
	assert.deepEqual(chat.messages, [
		{ role: "system", content: "be brief" },
		{ role: "user", content: "hi" },
		{ role: "assistant", content: "reading", tool_calls: [{ id: "t1", type: "function", function: { name: "Read", arguments: '{"a":1}' } }] },
		{ role: "tool", tool_call_id: "t1", content: "body" },
		{ role: "user", content: "go on" },
	]);
	assert.deepEqual(chat.tools.map((t) => t.function.name), ["Read"]);
	assert.equal(chat.tool_choice, "required");
});

test("a failed tool's result says so, and an assistant turn of only a tool call has no text", () => {
	const chat = toChatRequest(
		{
			max_tokens: 5,
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "f", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", is_error: true, content: "boom" }] },
			],
		},
		MODEL,
	);
	assert.equal(chat.messages[0].content, null);
	assert.equal(chat.messages[1].content, "Error: boom");
});

test("a whole answer comes back as a Messages answer, cached tokens apart", () => {
	const m = toMessagesResponse(
		{ id: "x", choices: [{ finish_reason: "tool_calls", message: { content: "ok", reasoning: "hidden", tool_calls: [{ id: "c", function: { name: "f", arguments: '{"a":1}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } },
		MODEL,
	);
	assert.deepEqual(m.content, [{ type: "text", text: "ok" }, { type: "tool_use", id: "c", name: "f", input: { a: 1 } }]);
	assert.equal(m.stop_reason, "tool_use");
	assert.deepEqual(m.usage, { input_tokens: 6, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 });
});

const events = (text) =>
	text
		.split("\n")
		.filter((l) => l.startsWith("data:"))
		.map((l) => JSON.parse(l.slice(5)));

test("a stream of reasoning, text and two tool calls becomes well-formed blocks, split anywhere", () => {
	const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: "x", choices: [{ delta, finish_reason: null, ...extra }] })}\n\n`;
	const source =
		chunk({ role: "assistant", reasoning: "secret" }) +
		chunk({ content: "Hel" }) +
		chunk({ content: "lo" }) +
		chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "f", arguments: '{"x"' } }] }) +
		chunk({ tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }) +
		chunk({ tool_calls: [{ index: 1, id: "b", function: { name: "g", arguments: "{}" } }] }) +
		`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
		`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`;
	const t = streamTranslator(MODEL);
	let out = "";
	for (let i = 0; i < source.length; i += 17) out += t.push(source.slice(i, i + 17));
	out += t.end();
	const list = events(out);
	assert.deepEqual(list.map((e) => e.type), [
		"message_start",
		"content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
		"content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
		"content_block_start", "content_block_delta", "content_block_stop",
		"message_delta", "message_stop",
	]);
	assert.doesNotMatch(out, /secret/);
	assert.deepEqual(list[5].content_block, { type: "tool_use", id: "a", name: "f", input: {} });
	assert.equal(list[6].delta.partial_json + list[7].delta.partial_json, '{"x":1}');
	assert.equal(list[9].index, 2);
	assert.equal(list.at(-2).delta.stop_reason, "tool_use");
	assert.equal(list.at(-2).usage.input_tokens, 9);
	assert.equal(t.end(), "");
});

test("a stream cut off before anything arrived still ends as a whole message", () => {
	assert.deepEqual(events(streamTranslator(MODEL).end()).map((e) => e.type), ["message_start", "message_delta", "message_stop"]);
});

test("provider errors keep the kind Claude Code retries on", () => {
	assert.equal(toMessagesError(429, '{"error":{"message":"slow"}}').error.type, "rate_limit_error");
	assert.equal(toMessagesError(429, '{"error":{"message":"slow"}}').error.message, "slow");
	assert.equal(toMessagesError(503, "busy").error.type, "overloaded_error");
	assert.equal(toMessagesError(400, "bad").error.type, "invalid_request_error");
});

test("Claude Code's per-request header line stays out of the system text, so a cache can match", () => {
	const chat = toChatRequest({ max_tokens: 5, system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2; cch=abc;" }, { type: "text", text: "be brief" }], messages: [] }, MODEL);
	assert.deepEqual(chat.messages, [{ role: "system", content: "be brief" }]);
});

test("a Messages request becomes a Responses one, keeping the effort it asked for", () => {
	const r = toResponsesRequest(
		{
			max_tokens: 100,
			stream: true,
			output_config: { effort: "high" },
			system: "be brief",
			tools: [{ name: "Read", description: "reads", input_schema: { type: "object" } }],
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: [{ type: "text", text: "reading" }, { type: "tool_use", id: "t1", name: "Read", input: { a: 1 } }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "body" }] },
			],
		},
		"gpt-6-luna",
	);
	assert.equal(r.instructions, "be brief");
	assert.deepEqual(r.reasoning, { effort: "high" });
	assert.equal(r.max_output_tokens, 100);
	assert.deepEqual(r.input, [
		{ role: "user", content: "hi" },
		{ role: "assistant", content: "reading" },
		{ type: "function_call", call_id: "t1", name: "Read", arguments: '{"a":1}' },
		{ type: "function_call_output", call_id: "t1", output: "body" },
	]);
	assert.equal(r.tools[0].name, "Read");
});

test("a Responses stream of reasoning, text and a tool call becomes well-formed blocks", () => {
	const data = (e) => `data: ${JSON.stringify(e)}\n\n`;
	const source =
		data({ type: "response.reasoning_summary_text.delta", delta: "secret" }) +
		data({ type: "response.output_text.delta", delta: "Hi" }) +
		data({ type: "response.output_item.added", item: { type: "function_call", id: "fc", call_id: "c1", name: "f" } }) +
		data({ type: "response.function_call_arguments.delta", delta: '{"a":1}' }) +
		data({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } } } });
	const t = responsesStreamTranslator("gpt-6-luna");
	let out = "";
	for (let i = 0; i < source.length; i += 23) out += t.push(source.slice(i, i + 23));
	out += t.end();
	const list = events(out);
	assert.deepEqual(list.map((e) => e.type), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
	assert.doesNotMatch(out, /secret/);
	assert.equal(list[4].content_block.id, "c1");
	assert.equal(list.at(-2).delta.stop_reason, "tool_use");
	assert.deepEqual(list.at(-2).usage, { input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 });
});

test("an answer's reasoning goes back in front of it on the next request, under one cache key", () => {
	const memory = new Map();
	const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "sealed" };
	const data = (e) => `data: ${JSON.stringify(e)}\n\n`;
	const t = responsesStreamTranslator("gpt-6-luna", memory);
	t.push(data({ type: "response.completed", response: { output: [reasoning, { type: "function_call", call_id: "c1", name: "f", arguments: "{}" }] } }));
	t.end();
	responsesToMessages({ output: [{ ...reasoning, id: "rs_2" }, { type: "message", content: [{ type: "output_text", text: "done" }] }] }, "gpt-6-luna", memory);
	const r = toResponsesRequest(
		{
			max_tokens: 5,
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "f", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
				{ role: "user", content: "more" },
			],
		},
		"gpt-6-luna",
		{ cacheKey: "run-1", memory },
	);
	assert.equal(r.prompt_cache_key, "run-1");
	assert.deepEqual(r.include, ["reasoning.encrypted_content"]);
	assert.deepEqual(r.input.map((i) => i.id ?? i.type ?? i.role), ["user", "rs_1", "function_call", "function_call_output", "rs_2", "assistant", "user"]);
});

test("a stream that fails says so, and is not an empty answer that reads as finished", () => {
	const data = (e) => `data: ${JSON.stringify(e)}\n\n`;
	for (const [event, type] of [
		[{ type: "response.failed", response: { error: { code: "insufficient_quota", message: "no credits" } } }, "billing_error"],
		[{ type: "error", code: "server_error", message: "boom" }, "overloaded_error"],
		[{ type: "response.failed", response: { error: { code: "rate_limit_exceeded", message: "slow" } } }, "rate_limit_error"],
	]) {
		const t = responsesStreamTranslator("gpt-6-luna");
		const out = t.push(data(event)) + t.end();
		const list = events(out);
		assert.equal(list.at(-1).type, "error");
		assert.equal(list.at(-1).error.type, type);
		assert.ok(!list.some((e) => e.type === "message_stop"));
		assert.equal(t.failure.type, type);
	}
});

test("system notes among the messages stay in place and never replace the system prompt", () => {
	const r = toResponsesRequest(
		{
			max_tokens: 5,
			system: "the real prompt",
			messages: [
				{ role: "system", content: "tools now available" },
				{ role: "user", content: "hi" },
				{ role: "system", content: "<total_tokens>9 tokens left</total_tokens>" },
			],
		},
		"gpt-6-luna",
	);
	assert.equal(r.instructions, "the real prompt");
	assert.deepEqual(r.input, [
		{ role: "user", content: "tools now available" },
		{ role: "user", content: "hi" },
		{ role: "user", content: "<total_tokens>9 tokens left</total_tokens>" },
	]);
	const noPrompt = toResponsesRequest({ max_tokens: 5, messages: [{ role: "system", content: "a note" }, { role: "user", content: "hi" }] }, "gpt-6-luna");
	assert.equal(noPrompt.instructions, undefined);
	assert.equal(noPrompt.input[0].content, "a note");
});

test("every answer has its own message id, so Claude Code keeps its turns apart", () => {
	const idOf = (t) => events(t.end()).find((e) => e.type === "message_start").message.id;
	const ids = [idOf(responsesStreamTranslator("gpt-6-luna")), idOf(responsesStreamTranslator("gpt-6-luna")), idOf(streamTranslator(MODEL)), idOf(streamTranslator(MODEL)), responsesToMessages({ output: [] }, "gpt-6-luna").id, responsesToMessages({ output: [] }, "gpt-6-luna").id, toMessagesResponse({ choices: [] }, MODEL).id, toMessagesResponse({ choices: [] }, MODEL).id];
	assert.equal(new Set(ids).size, ids.length);
});

test("a whole Responses answer comes back as a Messages one", () => {
	const m = responsesToMessages({ id: "r", output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "ok" }] }], incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 3, output_tokens: 1 } }, "gpt-6-luna");
	assert.deepEqual(m.content, [{ type: "text", text: "ok" }]);
	assert.equal(m.stop_reason, "max_tokens");
});
