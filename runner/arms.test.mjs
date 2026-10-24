import assert from "node:assert/strict";
import { test } from "node:test";
import { ARMS, armFor, armRuns, providerOf, relayInstallCommand, saidDone, TOOL_PACKAGES, toolInstallCommand } from "./arms.mjs";

test("a plain tool name is that tool's arm", () => {
	assert.equal(armFor("claude-code").arm, ARMS["claude-code"]);
	assert.equal(armFor("relay").relayVersion, null);
});

test("relay@<version> is Relay at a released version", () => {
	const a = armFor("relay@0.6.121");
	assert.equal(a.arm, ARMS.relay);
	assert.equal(a.base, "relay");
	assert.equal(a.relayVersion, "0.6.121");
	assert.equal(armFor("relay@0.6.122-beta.3").relayVersion, "0.6.122-beta.3");
});

test("relay@pkg is a local package, for pre-screens", () => {
	assert.equal(armFor("relay@pkg").relayPackage, true);
});

test("anything else is refused", () => {
	for (const name of ["relay@latest", "relay@0.6", "relay@0.6.121; rm -rf /", "hermes@1.0.0", "nobody"]) {
		assert.equal(armFor(name), null, name);
	}
});

test("claude-code@<version> and codex@<version> are that harness at a published version, installed for the run", () => {
	const cc = armFor("claude-code@2.1.310");
	assert.equal(cc.arm, ARMS["claude-code"]);
	assert.equal(cc.base, "claude-code");
	assert.equal(cc.toolVersion, "2.1.310");
	assert.equal(cc.relayVersion, null);
	assert.equal(armFor("codex@0.164.0").arm, ARMS.codex);
	for (const name of ["claude-code@latest", "claude-code@2.1", "codex@0.164.0-alpha.1", "codex@0.164.0 && curl evil"]) assert.equal(armFor(name), null, name);
	// Installed over the image's own with npm, and read back from what the harness prints.
	assert.equal(toolInstallCommand("claude-code", "2.1.310"), "npm install -g --no-fund --no-audit --loglevel=error @anthropic-ai/claude-code@2.1.310 && claude --version 2>&1");
	assert.match(toolInstallCommand("codex", "0.164.0"), /@openai\/codex@0\.164\.0 && codex --version 2>&1$/);
	assert.equal(TOOL_PACKAGES.codex.printed("0.164.0"), "codex-cli 0.164.0");
	assert.throws(() => toolInstallCommand("claude-code", "2.1.310; rm -rf /"));
	assert.throws(() => toolInstallCommand("hermes", "1.0.0"));
	// Its own claim of being done is read as the harness's.
	assert.equal(saidDone("claude-code@2.1.310", { exitCode: 0, stdout: '{"type":"result","subtype":"success","is_error":false}' }), true);
	assert.equal(armRuns(armFor("codex@0.164.0").arm, "gpt-6-luna"), true);
});

test("the install command takes only a released version", () => {
	assert.match(relayInstallCommand("0.6.121"), /RELAY_VERSION=0\.6\.121 /);
	assert.throws(() => relayInstallCommand("0.6.121 && curl evil"));
});

test("a released Relay installs over the template's own, and its version is read from both streams", () => {
	// The template's Relay sits in the folder first on a run's PATH; installing anywhere else leaves it in front.
	assert.match(relayInstallCommand("0.6.121"), /NPM_CONFIG_PREFIX=\/home\/user\/\.relay\/npm-global /);
	assert.match(relayInstallCommand("0.6.121"), /relay --version 2>&1$/);
});

test("a gate arm reads Relay's own claim of being done", () => {
	const relayMerge = { planned: 3, verified: 3 };
	assert.equal(saidDone("relay@0.6.121", { exitCode: 1, stdout: "", relayMerge }), true);
	assert.equal(saidDone("relay@0.6.121", { exitCode: 0, stdout: "", relayMerge: { planned: 3, verified: 2 } }), false);
});

test("Codex runs in its documented unattended mode on an OpenAI model, with stdin closed", () => {
	const settings = { model: "gpt-6-luna", gates: { test: "npm test" }, limitMinutes: 45, capUsd: "1" };
	const command = ARMS.codex.command(settings);
	assert.match(command, /^codex exec --json -m gpt-6-luna --dangerously-bypass-approvals-and-sandbox "\$\(cat \/home\/user\/request\.md\)" < \/dev\/null$/);
	assert.match(ARMS.codex.resume(settings), /^codex exec resume --last --json -m gpt-6-luna --dangerously-bypass-approvals-and-sandbox '.*interrupted.*' < \/dev\/null$/);
	assert.deepEqual(ARMS.codex.files(settings), {});
});

test("Codex said it was done when its last turn completed and it exited 0", () => {
	// The event lines `codex exec --json` prints (its docs: thread.started, turn.started, item.*, turn.completed,
	// turn.failed, error); the first two as Codex 0.163.0 printed them.
	const done = [
		'{"type":"thread.started","thread_id":"01a1659b-4957-7260-aa3f-1dedd90b7271"}',
		'{"type":"turn.started"}',
		'{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Fixed it."}}',
		'{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":800,"output_tokens":300,"reasoning_output_tokens":120}}',
	].join("\n");
	assert.equal(saidDone("codex", { exitCode: 0, stdout: done }), true);
	assert.equal(saidDone("codex", { exitCode: 1, stdout: done }), false);
	const failed = `${done}\n{"type":"turn.started"}\n{"type":"error","message":"stream disconnected"}\n{"type":"turn.failed","error":{"message":"quota"}}`;
	assert.equal(saidDone("codex", { exitCode: 0, stdout: failed }), false);
	assert.equal(saidDone("codex", { exitCode: 0, stdout: "2026-10-22T21:53:58Z ERROR not json\n" }), false);
});

test("Relay on an OpenAI model uses its openai provider on every tier", () => {
	const settings = JSON.parse(ARMS.relay.files({ model: "gpt-6-luna" })["/home/user/.relay/agent/settings.json"]);
	assert.equal(settings.defaultProvider, "openai");
	assert.deepEqual(settings.models.tiers, { decider: "openai/gpt-6-luna", strong: "openai/gpt-6-luna", fast: "openai/gpt-6-luna" });
	const anthropic = JSON.parse(ARMS.relay.files({ model: "claude-haiku-5-5" })["/home/user/.relay/agent/settings.json"]);
	assert.equal(anthropic.models.tiers.fast, "anthropic/claude-haiku-5-5");
});

test("each arm runs only the providers it supports", () => {
	assert.equal(providerOf("claude-haiku-5-5"), "anthropic");
	assert.equal(providerOf("gpt-6.1-sol"), "openai");
	assert.throws(() => providerOf("gemini-3"));
	assert.ok(armRuns(ARMS.relay, "gpt-6-luna") && armRuns(ARMS.relay, "claude-haiku-5-5"));
	assert.ok(armRuns(ARMS.codex, "gpt-6-luna") && !armRuns(ARMS.codex, "claude-haiku-5-5"));
	for (const tool of ["claude-code", "prime-agent", "hermes"]) assert.ok(!armRuns(ARMS[tool], "gpt-6-luna"), tool);
});

test("a local build is Relay from a package, named by a version no release channel publishes", () => {
	const a = armFor("relay@0.6.122-loop.2026w44");
	assert.equal(a.arm, ARMS.relay);
	assert.equal(a.relayPackage, true);
	assert.equal(a.relayVersion, null);
	assert.equal(a.localBuild, "0.6.122-loop.2026w44");
	assert.equal(armFor("relay@0.6.122-loop.2026w44.2").localBuild, "0.6.122-loop.2026w44.2");
	for (const name of ["relay@0.6.122-loop", "relay@0.6.122-loop.w44", "relay@0.6.122-loop.2026w44;rm"]) assert.equal(armFor(name), null, name);
	assert.throws(() => relayInstallCommand("0.6.122-loop.2026w44"), /not a released Relay version/);
});
