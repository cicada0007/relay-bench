import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTrial } from "./tb21.mjs";

const ran = { started_at: "2026-10-16T13:08:00Z", finished_at: "2026-10-16T13:20:00Z" };
const graded = (reward) => ({ rewards: { reward } });

test("a graded trial is the tool's, solved or not", () => {
	assert.equal(classifyTrial({ agent_execution: ran, verifier_result: graded(0) }).infra, false);
	assert.equal(classifyTrial({ agent_execution: ran, verifier_result: graded(1) }).infra, false);
});

test("the tool's own endings stay the tool's when it ran", () => {
	for (const exception_type of ["AgentTimeoutError", "NonZeroAgentExitCodeError"]) {
		assert.equal(classifyTrial({ agent_execution: ran, exception_info: { exception_type } }).infra, false);
	}
});

test("no grade because the tool never started is ours, whatever the exception's name", () => {
	// fix-ocaml-gc, relay r1: npm's download was reset while our install step ran.
	assert.equal(classifyTrial({ agent_execution: null, exception_info: { exception_type: "NonZeroAgentExitCodeError" } }).infra, true);
});

test("no result, or a sandbox failure, is ours", () => {
	assert.equal(classifyTrial(undefined).infra, true);
	assert.equal(classifyTrial({ agent_execution: ran, exception_info: { exception_type: "SandboxException" } }).infra, true);
});

test("a trial stopped at its cap is the tool's", () => {
	const meter = { agent_result: { metadata: { meter: { refusedAtCap: 1 } } } };
	assert.equal(classifyTrial({ ...meter, agent_execution: ran, exception_info: { exception_type: "ApiOverloadedError" } }).infra, false);
});
