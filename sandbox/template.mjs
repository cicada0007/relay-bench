#!/usr/bin/env node
// The one sandbox image every run uses, for every tool: the same OS, toolchain and pinned tool versions.
// Build it once per round:   E2B_API_KEY=... node sandbox/template.mjs
// Versions are the round's frozen pins (PREREGISTRATION.md: "Versions are frozen when the round starts").
import { fileURLToPath } from "node:url";
import { defaultBuildLogger, Template } from "e2b";

/** The repository root: files the image copies (the meter) are named from here. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const TEMPLATE_NAME = "relay-bench-round-1";
export const PINS = Object.freeze({
	node: "22",
	relay: "0.6.117",
	primeAgent: "0.10.0",
	claudeCode: "2.1.300",
	hermes: "0.22.2",
});

/** PATH inside a run: where each tool's installer puts its command for the sandbox user. */
export const RUN_PATH = [
	"/home/user/.relay/npm-global/bin",
	"/home/user/.local/bin",
	"/home/user/.prime-agent/bin",
	"/home/user/.hermes/bin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
].join(":");

export function benchTemplate() {
	return (
		Template({ fileContextPath: ROOT })
			.fromNodeImage(PINS.node)
			.setUser("root")
			.aptInstall(["python3", "python3-venv", "git", "curl", "ca-certificates", "procps", "jq"], { noInstallRecommends: true })
			.runCmd(`npm install -g --no-fund --no-audit @anthropic-ai/claude-code@${PINS.claudeCode}`)
			.copy("meter/meter.mjs", "/opt/relay-bench/meter.mjs", { mode: 0o755 })
			// Relay and Prime Agent install for the sandbox user, where their kernels and settings live at run time.
			// Both kernels are ready when a run starts: Prime Agent's installer sets its kernel up as part of a normal
			// install, so Relay's is set up at install too (RELAY_BOOTSTRAP_KERNEL_ON_INSTALL=1).
			.setUser("user")
			.runCmd(
				`curl -fsSL https://relayevals.com/harness/install.sh | RELAY_VERSION=${PINS.relay} RELAY_BOOTSTRAP_KERNEL_ON_INSTALL=1 DO_NOT_TRACK=1 sh`,
			)
			.runCmd(`curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | PRIME_AGENT_VERSION=${PINS.primeAgent} sh`)
			// Hermes from its own installer at the pinned release tag, with its defaults; --non-interactive only skips the
			// stages that wait for a person (a build has nobody at the terminal).
			.runCmd(
				`curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/v${PINS.hermes}/scripts/install.sh | bash -s -- --branch v${PINS.hermes} --non-interactive`,
			)
			.runCmd(
				`export PATH=${RUN_PATH}; ` +
					"echo relay $(relay --version | tail -1); echo prime-agent $(prime-agent --version 2>&1 | tail -1); " +
					"echo claude $(claude --version); echo hermes $(hermes --version 2>&1 | head -1); echo node $(node --version); echo $(python3 --version)",
			)
	);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	if (!process.env.E2B_API_KEY) {
		console.error("E2B_API_KEY is not set");
		process.exit(1);
	}
	const info = await Template.build(benchTemplate(), TEMPLATE_NAME, {
		cpuCount: 2,
		memoryMB: 4096,
		onBuildLogs: defaultBuildLogger(),
	});
	console.log(`built ${TEMPLATE_NAME}: ${JSON.stringify(info)}`);
}
