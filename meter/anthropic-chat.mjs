// Claude Code speaks only Anthropic's Messages format; open models on Amazon Bedrock answer only Chat Completions. So on
// those models the meter translates, for Claude Code alone: a request from Messages to Chat Completions, and the answer
// back, streamed or not. Everything a Chat Completions model has no use for (cache marks, thinking settings, betas) is
// left out; its reasoning is left out of the answer, because Claude Code would need a signature it cannot have.
// The other tools speak Chat Completions themselves and never come through here. No prompt or output is logged.

/** A new id for every answer: Claude Code merges assistant messages that share one, which would put all of a run's tool
 *  calls ahead of all their results, rewrite its history on every request, and so scramble the model's view of the run
 *  and defeat any prompt cache. */
const freshMessageId = () => `msg_${crypto.randomUUID().replaceAll("-", "")}`;

const textOf = (content) =>
	typeof content === "string"
		? content
		: (content ?? [])
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n");

/** One Anthropic message as the Chat Completions messages it becomes: tool results are messages of their own there. */
function chatMessages(message) {
	if (typeof message.content === "string") return [{ role: message.role, content: message.content }];
	const blocks = message.content ?? [];
	if (message.role === "assistant") {
		const toolCalls = blocks
			.filter((b) => b.type === "tool_use")
			.map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
		const text = textOf(blocks);
		return [{ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }];
	}
	const out = [];
	for (const b of blocks) {
		if (b.type !== "tool_result") continue;
		const body = textOf(b.content);
		out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${body}` : body });
	}
	const parts = [];
	for (const b of blocks) {
		if (b.type === "text") parts.push({ type: "text", text: b.text });
		else if (b.type === "image" && b.source?.type === "base64") parts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
	}
	if (parts.length) out.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join("\n") : parts });
	return out;
}

/** A Messages request as a Chat Completions request for `model`. */
export function toChatRequest(sent, model) {
	// Claude Code's first system line carries a per-request hash; left in, it would keep any prompt cache from ever matching.
	const system = textOf(sent.system)
		.split("\n")
		.filter((line) => !line.startsWith("x-anthropic-billing-header:"))
		.join("\n")
		.trim();
	const chat = {
		model,
		messages: [...(system ? [{ role: "system", content: system }] : []), ...(sent.messages ?? []).flatMap(chatMessages)],
		max_tokens: sent.max_tokens,
		...(sent.temperature === undefined ? {} : { temperature: sent.temperature }),
		...(sent.top_p === undefined ? {} : { top_p: sent.top_p }),
		...(sent.stop_sequences?.length ? { stop: sent.stop_sequences } : {}),
		...(sent.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
	};
	if (sent.tools?.length) {
		chat.tools = sent.tools
			.filter((t) => t.input_schema)
			.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
		if (!chat.tools.length) delete chat.tools;
	}
	const choice = sent.tool_choice?.type;
	if (chat.tools && choice === "any") chat.tool_choice = "required";
	else if (chat.tools && choice === "tool") chat.tool_choice = { type: "function", function: { name: sent.tool_choice.name } };
	else if (chat.tools && choice === "none") chat.tool_choice = "none";
	return chat;
}

const STOP = { stop: "end_turn", tool_calls: "tool_use", length: "max_tokens", content_filter: "refusal" };

/** Chat Completions usage in Anthropic's terms: input there is the prompt less what was read from cache. */
function anthropicUsage(u) {
	const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
	return { input_tokens: Math.max(0, (u?.prompt_tokens ?? 0) - cached), output_tokens: u?.completion_tokens ?? 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
}

const parseArguments = (text) => {
	try {
		return JSON.parse(text || "{}");
	} catch {
		return {};
	}
};

/** A whole Chat Completions answer as a Messages answer. */
export function toMessagesResponse(json, model) {
	const choice = json.choices?.[0];
	const content = [];
	if (choice?.message?.content) content.push({ type: "text", text: choice.message.content });
	for (const call of choice?.message?.tool_calls ?? []) {
		content.push({ type: "tool_use", id: call.id, name: call.function?.name, input: parseArguments(call.function?.arguments) });
	}
	const toolUsed = content.some((b) => b.type === "tool_use");
	return {
		id: json.id ?? freshMessageId(),
		type: "message",
		role: "assistant",
		model,
		content,
		stop_reason: toolUsed ? "tool_use" : (STOP[choice?.finish_reason] ?? "end_turn"),
		stop_sequence: null,
		usage: anthropicUsage(json.usage),
	};
}

/** A provider's error as Anthropic's error shape, with the kind the status means, so Claude Code retries as it would. */
export function toMessagesError(status, text) {
	let message = text;
	try {
		const json = JSON.parse(text);
		message = json.error?.message ?? json.message ?? text;
	} catch {}
	const type =
		status === 429 ? "rate_limit_error"
		: status === 401 ? "authentication_error"
		: status === 403 ? "permission_error"
		: status === 404 ? "not_found_error"
		: status === 503 || status === 529 ? "overloaded_error"
		: status >= 500 ? "api_error"
		: "invalid_request_error";
	return { type: "error", error: { type, message: String(message).slice(0, 2000) } };
}

/**
 * Turns a Chat Completions event stream into a Messages one. `push(chunk)` takes the provider's bytes as they come and
 * `end()` closes the message; both give back the text to send on. Tool-call pieces are joined by their index, and text
 * and tool calls each get their own content block, as Messages requires.
 */
export function streamTranslator(model) {
	let pending = "";
	let started = false;
	let ended = false;
	let index = -1;
	let open; // the open block: "text", or the tool call's index
	let finish;
	let usage;
	let toolUsed = false;
	const send = (type, body) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
	const close = () => {
		if (open === undefined) return "";
		open = undefined;
		return send("content_block_stop", { index });
	};
	const start = (id) => {
		if (started) return "";
		started = true;
		return send("message_start", {
			message: { id: id ?? freshMessageId(), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
		});
	};
	const onEvent = (event) => {
		let out = start(event.id);
		if (event.usage) usage = event.usage;
		const choice = event.choices?.[0];
		if (!choice) return out;
		if (choice.finish_reason) finish = choice.finish_reason;
		const delta = choice.delta ?? {};
		if (delta.content) {
			if (open !== "text") {
				out += close();
				index += 1;
				open = "text";
				out += send("content_block_start", { index, content_block: { type: "text", text: "" } });
			}
			out += send("content_block_delta", { index, delta: { type: "text_delta", text: delta.content } });
		}
		for (const call of delta.tool_calls ?? []) {
			const key = `tool${call.index ?? 0}`;
			if (open !== key) {
				out += close();
				index += 1;
				open = key;
				toolUsed = true;
				out += send("content_block_start", { index, content_block: { type: "tool_use", id: call.id, name: call.function?.name, input: {} } });
			}
			if (call.function?.arguments) out += send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: call.function.arguments } });
		}
		return out;
	};
	return {
		push(chunk) {
			pending += chunk;
			const lines = pending.split("\n");
			pending = lines.pop();
			let out = "";
			for (const line of lines) {
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (data === "[DONE]") continue;
				try {
					out += onEvent(JSON.parse(data));
				} catch {}
			}
			return out;
		},
		end() {
			if (ended) return "";
			ended = true;
			return (
				start() +
				close() +
				send("message_delta", { delta: { stop_reason: toolUsed ? "tool_use" : (STOP[finish] ?? "end_turn"), stop_sequence: null }, usage: anthropicUsage(usage) }) +
				send("message_stop", {})
			);
		},
	};
}

// ---- OpenAI's reasoning models take tools with reasoning only on the Responses API, so on them the same translation
// goes to and from that API. Reasoning stays on, at the effort Claude Code asked for, and out of the answer.

/** Where an answer's reasoning is kept until Claude Code sends that answer back: it cannot carry it itself. */
const textKey = (text) => `text:${text}`;

/** Files each reasoning item under the output item it came before, which is what the next request will name. */
function rememberReasoning(memory, output) {
	if (!memory) return;
	let held = [];
	for (const item of output ?? []) {
		if (item.type === "reasoning") held.push(item);
		else if (item.type === "function_call" || item.type === "message") {
			if (held.length) {
				const text = (item.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text).join("");
				memory.set(item.type === "function_call" ? item.call_id : textKey(text), held);
			}
			held = [];
		}
	}
}

/** A Messages request as a Responses request for `model`. With a memory, each earlier answer's reasoning goes back in
 *  front of it, and with a cache key the requests share one cache: without both, these models reuse little beyond the
 *  system prompt (measured: 16-20% of input cached, against 92-97% for the tools that send them). */
export function toResponsesRequest(sent, model, { cacheKey, memory } = {}) {
	const chat = toChatRequest(sent, model);
	const input = [];
	let instructions;
	const recall = (key) => {
		for (const item of memory?.get(key) ?? []) input.push(item);
	};
	for (const message of chat.messages) {
		// Only the request's own system text is the instructions. Claude Code also sends short system notes among its
		// messages (tokens left, tools now available); they stay where they are, or they would replace its system prompt
		// and change the start of every request. They go as user messages because Claude Code sends the newest note as a
		// user message and turns it into a system one on the next call. That flip stopped cache reuse at the system prompt
		// and tools (measured by replaying real requests: 6734 of 17977 tokens read as sent, 13521 with one role).
		if (message.role === "system" && message === chat.messages[0] && sent.system) instructions = message.content;
		else if (message.role === "system") input.push({ role: "user", content: message.content });
		else if (message.role === "tool") input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content });
		else if (message.role === "assistant") {
			if (message.content) {
				recall(textKey(message.content));
				input.push({ role: "assistant", content: message.content });
			}
			for (const call of message.tool_calls ?? []) {
				recall(call.id);
				input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
			}
		} else if (typeof message.content === "string") input.push({ role: "user", content: message.content });
		else {
			input.push({
				role: "user",
				content: message.content.map((part) => (part.type === "text" ? { type: "input_text", text: part.text } : { type: "input_image", image_url: part.image_url.url })),
			});
		}
	}
	const effort = sent.output_config?.effort;
	const choice = chat.tool_choice;
	return {
		model,
		input,
		store: false,
		...(memory ? { include: ["reasoning.encrypted_content"] } : {}),
		...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
		max_output_tokens: sent.max_tokens,
		...(instructions ? { instructions } : {}),
		...(effort ? { reasoning: { effort } } : {}),
		...(chat.stream ? { stream: true } : {}),
		...(chat.tools ? { tools: chat.tools.map((t) => ({ type: "function", strict: false, name: t.function.name, description: t.function.description, parameters: t.function.parameters })) } : {}),
		...(choice === undefined ? {} : { tool_choice: typeof choice === "string" ? choice : { type: "function", name: choice.function.name } }),
	};
}

/** Responses usage in Anthropic's terms. */
function responsesUsage(u) {
	const cached = u?.input_tokens_details?.cached_tokens ?? 0;
	return { input_tokens: Math.max(0, (u?.input_tokens ?? 0) - cached), output_tokens: u?.output_tokens ?? 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
}

const responsesStop = (response, toolUsed) => (toolUsed ? "tool_use" : response?.incomplete_details?.reason === "max_output_tokens" ? "max_tokens" : "end_turn");

/** A whole Responses answer as a Messages answer. */
export function responsesToMessages(json, model, memory) {
	rememberReasoning(memory, json.output);
	const content = [];
	for (const item of json.output ?? []) {
		if (item.type === "message") {
			const text = (item.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text).join("");
			if (text) content.push({ type: "text", text });
		} else if (item.type === "function_call") {
			content.push({ type: "tool_use", id: item.call_id, name: item.name, input: parseArguments(item.arguments) });
		}
	}
	return {
		id: json.id ?? freshMessageId(),
		type: "message",
		role: "assistant",
		model,
		content,
		stop_reason: responsesStop(json, content.some((b) => b.type === "tool_use")),
		stop_sequence: null,
		usage: responsesUsage(json.usage),
	};
}

/** A failure inside a 200 stream, in the kind Claude Code reads as a failure and not as an empty answer. */
function streamFailure(error) {
	const code = String(error?.code ?? error?.type ?? "");
	const type = /quota|credit|billing/.test(code) ? "billing_error" : /overload|server/.test(code) ? "overloaded_error" : /rate/.test(code) ? "rate_limit_error" : "api_error";
	return { type, message: String(error?.message ?? code ?? "the provider failed the request").slice(0, 2000) };
}

/** Turns a Responses event stream into a Messages one, like `streamTranslator`. */
export function responsesStreamTranslator(model, memory) {
	let pending = "";
	let failure;
	let started = false;
	let ended = false;
	let index = -1;
	let open = false;
	let openItem;
	let toolUsed = false;
	let final;
	const send = (type, body) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
	const start = () => {
		if (started) return "";
		started = true;
		return send("message_start", { message: { id: freshMessageId(), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
	};
	const close = () => {
		if (!open) return "";
		open = false;
		openItem = undefined;
		return send("content_block_stop", { index });
	};
	const onEvent = (event) => {
		let out = start();
		if (event.type === "response.output_text.delta") {
			if (openItem !== "text") {
				out += close();
				index += 1;
				open = true;
				openItem = "text";
				out += send("content_block_start", { index, content_block: { type: "text", text: "" } });
			}
			out += send("content_block_delta", { index, delta: { type: "text_delta", text: event.delta } });
		} else if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
			out += close();
			index += 1;
			open = true;
			openItem = event.item.id ?? event.item.call_id;
			toolUsed = true;
			out += send("content_block_start", { index, content_block: { type: "tool_use", id: event.item.call_id, name: event.item.name, input: {} } });
		} else if (event.type === "response.function_call_arguments.delta") {
			out += send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: event.delta } });
		} else if (event.type === "response.completed" || event.type === "response.incomplete") {
			final = event.response;
			rememberReasoning(memory, final?.output);
		} else if (event.type === "response.failed") {
			final = event.response;
			failure ??= streamFailure(final?.error);
		} else if (event.type === "error") {
			failure ??= streamFailure(event.error ?? event);
		}
		return out;
	};
	return {
		get failure() {
			return failure;
		},
		push(chunk) {
			pending += chunk;
			const lines = pending.split("\n");
			pending = lines.pop();
			let out = "";
			for (const line of lines) {
				if (!line.startsWith("data:")) continue;
				try {
					out += onEvent(JSON.parse(line.slice(5).trim()));
				} catch {}
			}
			return out;
		},
		end() {
			if (ended) return "";
			ended = true;
			if (failure) return start() + close() + send("error", { error: failure });
			return start() + close() + send("message_delta", { delta: { stop_reason: responsesStop(final, toolUsed), stop_sequence: null }, usage: responsesUsage(final?.usage) }) + send("message_stop", {});
		},
	};
}
