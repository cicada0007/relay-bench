// How each tool runs, unattended, inside a benchmark sandbox: its config files, its command, and how its own claim of
// being done is read. Every tool gets the same model, time limit and spend cap (enforced by the meter). No tool's
// endpoint is changed: the meter answers at api.anthropic.com inside the sandbox (sandbox/meter-intercept.sh).
// Settings not named here are the tool's defaults.

/** The meter's plain-HTTP door, for Prime Agent only (see its arm). Same process, log and spend cap as the main one. */
export const METER_PLAIN_URL = "http://127.0.0.1:8787";

/** The test models as Anthropic describes them (the same values as Relay's catalogue, from Anthropic's model pages).
 *  Prime Agent 0.10.0's built-in list stops at Sonnet 5 and Haiku 4.5; for a model it does not know it falls back to
 *  4,096 output tokens with thinking off, so it is told these the way a user adopting a new model would.
 *  `reasoning` is false for Haiku 5.5 only because Prime Agent 0.10.0 picks the thinking format from the model's name
 *  (crates/pa-ai/src/providers/anthropic/mod.rs, supports_adaptive_thinking): "sonnet-5" gets the adaptive format, but
 *  "haiku-5-5" gets the older budget format, which the API refuses with a 400 for that model. So on Haiku 5.5, Prime
 *  Agent 0.10.0 can only run without thinking; the results page says so. */
export const MODEL_SPECS = {
	"claude-sonnet-5-5": { name: "Claude Sonnet 5.5", reasoning: true, cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
	"claude-haiku-5-5": { name: "Claude Haiku 5.5", reasoning: false, cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
};
function modelEntry(model) {
	const spec = MODEL_SPECS[model];
	if (!spec) throw new Error(`no model spec for ${model}`);
	return {
		id: model,
		name: spec.name,
		api: "anthropic-messages",
		reasoning: spec.reasoning,
		...(spec.reasoning ? { thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } } : {}),
		input: ["text", "image"],
		cost: spec.cost,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	};
}
export const WORK = "/home/user/work";
export const REQUEST = "/home/user/request.md";

/** What every tool is told when test D's restart loop starts it again after it stopped without finishing. */
export const RESUME_PROMPT =
	"Your previous session on this request was interrupted. Continue from where it stopped and finish the request in /home/user/request.md.";

const quote = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

export const ARMS = {
	relay: {
		label: "Relay",
		/** Relay through its queue, one model on every tier. */
		files: ({ model }) => ({
			"/home/user/.relay/agent/settings.json": JSON.stringify({
				defaultProvider: "anthropic",
				defaultModel: model,
				models: { tiers: { decider: `anthropic/${model}`, strong: `anthropic/${model}`, fast: `anthropic/${model}` } },
			}),
		}),
		command: ({ capUsd }) =>
			`relay queue plan --file ${REQUEST} && relay queue run --spend-cap ${capUsd}`,
		/** The queue keeps its plan and tasks on disk; running it again picks up where it stopped. */
		resume: ({ capUsd }) => `relay queue run --spend-cap ${capUsd}`,
		env: () => ({}),
		/** Relay's result is what a reviewer would merge: its verified task branches, merged in plan order. */
		result: "relay-merge",
	},
	"prime-agent": {
		label: "Prime Agent",
		/** Prime Agent's documented unattended mode, gated on the task's own checks. Its turn, token, continuation and
		 *  time limits are raised to the round's shared limits so its defaults (12 turns, 80,000 tokens, 30 minutes)
		 *  do not stop a 3-hour request early; the meter's spend cap is the limit that binds, as for every tool. */
		/** Prime Agent 0.10.0 trusts only its built-in certificate list (system and extra authorities arrived after it, in
		 *  PrimeIntellect-ai/prime-agent#3477), so it cannot reach the meter at api.anthropic.com. It uses its endpoint
		 *  setting instead; at v0.10.0 that setting only builds the request URL (crates/pa-ai/src/providers/anthropic/
		 *  stream.rs), so its behaviour does not change. */
		files: ({ model }) => ({
			"/home/user/.prime/agent/settings.json": JSON.stringify({ defaultProvider: "anthropic", defaultModel: model }),
			"/home/user/.prime/agent/models.json": JSON.stringify({
				providers: { anthropic: { baseUrl: METER_PLAIN_URL, models: [modelEntry(model)] } },
			}),
		}),
		command: ({ model, gates, limitMinutes }) => primeCommand({ model, gates, limitMinutes, prompt: `"$(cat ${REQUEST})"` }),
		/** Its documented -c/--continue: the previous session, with the same unattended settings. */
		resume: ({ model, gates, limitMinutes }) =>
			primeCommand({ model, gates, limitMinutes, prompt: quote(RESUME_PROMPT), extra: "--continue" }),
		env: () => ({}),
		result: "working-tree",
	},
	"claude-code": {
		label: "Claude Code",
		files: () => ({}),
		/** Headless mode with permissions skipped inside the sandbox. Every Claude Code model tier is pinned to the
		 *  test model so its background requests do not use a second model. */
		command: ({ model }) =>
			`claude -p "$(cat ${REQUEST})" --model ${model} --output-format json --dangerously-skip-permissions`,
		/** Its documented -c/--continue, which works with -p: the most recent conversation in this directory. */
		resume: ({ model }) =>
			`claude -p --continue ${quote(RESUME_PROMPT)} --model ${model} --output-format json --dangerously-skip-permissions`,
		env: ({ model }) => ({
			ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
			ANTHROPIC_DEFAULT_SONNET_MODEL: model,
			ANTHROPIC_DEFAULT_OPUS_MODEL: model,
			ANTHROPIC_SMALL_FAST_MODEL: model,
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			DISABLE_AUTOUPDATER: "1",
		}),
		result: "working-tree",
	},
	hermes: {
		label: "Hermes",
		files: () => ({}),
		/** Hermes's one-shot mode with command approvals off inside the sandbox (--yolo), on the test model. It reaches
		 *  the meter at api.anthropic.com like Claude Code and Relay, so it keeps the model's thinking between steps. */
		command: ({ model }) => `hermes -z "$(cat ${REQUEST})" -m ${model} --provider anthropic --yolo`,
		/** Its documented --continue: the most recent session. */
		resume: ({ model }) => `hermes -z ${quote(RESUME_PROMPT)} --continue -m ${model} --provider anthropic --yolo`,
		env: () => ({}),
		result: "working-tree",
	},
};

/** A released Relay version, as the installer's RELAY_VERSION takes it: 0.6.121, or a beta such as 0.6.122-beta.3. */
export const RELAY_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-beta\.\d+(?:\.\d+)?)?$/;

/**
 * The arm for a tool name. `relay@<version>` is Relay at that released version, installed for the run (GATE.md); the
 * gate compares two of them. `relay@pkg` is Relay from --relay-package, for pre-screens only. Every other name is an
 * arm of ARMS as it is.
 */
export function armFor(tool) {
	const at = tool.indexOf("@");
	if (at === -1) {
		const arm = ARMS[tool];
		return arm ? { arm, base: tool, relayVersion: null, relayPackage: false } : null;
	}
	const base = tool.slice(0, at);
	const spec = tool.slice(at + 1);
	if (base !== "relay") return null;
	if (spec === "pkg") return { arm: ARMS.relay, base, relayVersion: null, relayPackage: true };
	if (!RELAY_VERSION_PATTERN.test(spec)) return null;
	return { arm: ARMS.relay, base, relayVersion: spec, relayPackage: false };
}

/** The installer command that puts one released Relay version in place for the sandbox user, kernel included. */
export function relayInstallCommand(version) {
	if (!RELAY_VERSION_PATTERN.test(version)) throw new Error(`not a released Relay version: ${version}`);
	return `curl -fsSL https://relayevals.com/harness/install.sh | RELAY_VERSION=${version} RELAY_BOOTSTRAP_KERNEL_ON_INSTALL=1 DO_NOT_TRACK=1 sh && relay --version`;
}

function primeCommand({ model, gates, limitMinutes, prompt, extra }) {
	return [
		"prime-agent -p --autonomous",
		...(extra ? [extra] : []),
		...Object.values(gates).map((gate) => `--autonomous-gate ${quote(gate)}`),
		"--autonomous-max-turns 100000 --autonomous-max-tokens 1000000000 --autonomous-max-continuations 100",
		`--autonomous-timeout-ms ${limitMinutes * 60_000}`,
		`--model anthropic/${model}`,
		prompt,
	].join(" ");
}

/** What the tool itself said about finishing, read from its own output. */
export function saidDone(tool, { exitCode, stdout, relayMerge }) {
	tool = armFor(tool)?.base ?? tool;
	if (tool === "claude-code") {
		const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
		try {
			const json = JSON.parse(line);
			return json.type === "result" && json.subtype === "success" && json.is_error !== true;
		} catch {
			return false;
		}
	}
	if (tool === "relay") return relayMerge?.planned > 0 && relayMerge.verified === relayMerge.planned;
	return exitCode === 0;
}
