import assert from "node:assert/strict";
import { test } from "node:test";
import { ARMS, armFor, relayInstallCommand, saidDone } from "./arms.mjs";

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

test("the install command takes only a released version", () => {
	assert.match(relayInstallCommand("0.6.121"), /RELAY_VERSION=0\.6\.121 /);
	assert.throws(() => relayInstallCommand("0.6.121 && curl evil"));
});

test("a gate arm reads Relay's own claim of being done", () => {
	const relayMerge = { planned: 3, verified: 3 };
	assert.equal(saidDone("relay@0.6.121", { exitCode: 1, stdout: "", relayMerge }), true);
	assert.equal(saidDone("relay@0.6.121", { exitCode: 0, stdout: "", relayMerge: { planned: 3, verified: 2 } }), false);
});
