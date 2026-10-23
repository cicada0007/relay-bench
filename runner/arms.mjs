// How each tool runs, unattended, inside a benchmark sandbox: its config files, its command, and how its own claim of
// being done is read. Every tool gets the same model, time limit and spend cap (enforced by the meter). No tool's
// endpoint is changed: the meter answers at api.anthropic.com and api.openai.com inside the sandbox
// (sandbox/meter-intercept.sh). Settings not named here are the tool's defaults.

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
/** The provider of a test model, from its id: Claude models are Anthropic's; GPT and o-series models are OpenAI's. */
export function providerOf(model) {
	if (/^claude-/.test(model)) return "anthropic";
	if (/^(gpt-|o\d)/.test(model)) return "openai";
	throw new Error(`no provider known for model ${model}`);
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
		providers: ["anthropic", "openai"],
		/** Relay through its queue, one model on every tier, from the model's own provider: on an OpenAI model (the Codex
		 *  comparison) it is Relay's "openai" provider, which reads OPENAI_API_KEY and calls api.openai.com, where the
		 *  meter answers. A model arm (model watch) puts its own model on its tier, or on every tier. */
		files: ({ model, override }) => {
			const provider = providerOf(model);
			const on = (tier) => `${provider}/${override && (override.tier === "all" || override.tier === tier) ? override.model : model}`;
			return {
				"/home/user/.relay/agent/settings.json": JSON.stringify({
					defaultProvider: provider,
					defaultModel: override?.tier === "all" ? override.model : model,
					models: { tiers: { decider: on("decider"), strong: on("strong"), fast: on("fast") } },
				}),
			};
		},
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
		providers: ["anthropic"],
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
		providers: ["anthropic"],
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
		providers: ["anthropic"],
		files: () => ({}),
		/** Hermes's one-shot mode with command approvals off inside the sandbox (--yolo), on the test model. It reaches
		 *  the meter at api.anthropic.com like Claude Code and Relay, so it keeps the model's thinking between steps. */
		command: ({ model }) => `hermes -z "$(cat ${REQUEST})" -m ${model} --provider anthropic --yolo`,
		/** Its documented --continue: the most recent session. */
		resume: ({ model }) => `hermes -z ${quote(RESUME_PROMPT)} --continue -m ${model} --provider anthropic --yolo`,
		env: () => ({}),
		result: "working-tree",
	},
	codex: {
		label: "Codex",
		providers: ["openai"],
		files: () => ({}),
		/** Codex CLI's documented unattended mode, `codex exec` (pinned in sandbox/template.mjs), on the test model, with
		 *  approvals and its own sandbox off inside the benchmark's sandbox, as its help says that flag is for
		 *  ("environments that are externally sandboxed"); the same as Claude Code's skipped permissions. --json prints
		 *  its events, which saidDone reads. Its key is CODEX_API_KEY, the variable its docs name for `codex exec`.
		 *  stdin is closed: with a prompt given, `codex exec` would also wait to read piped stdin. */
		command: ({ model }) => `codex exec --json -m ${model} --dangerously-bypass-approvals-and-sandbox "$(cat ${REQUEST})" < /dev/null`,
		/** Its documented `codex exec resume --last`: the most recent session, with the same settings. */
		resume: ({ model }) => `codex exec resume --last --json -m ${model} --dangerously-bypass-approvals-and-sandbox ${quote(RESUME_PROMPT)} < /dev/null`,
		env: () => ({}),
		result: "working-tree",
	},
};

/** Whether a tool's arm can run a model, by provider. */
export const armRuns = (arm, model) => (arm.providers ?? ["anthropic"]).includes(providerOf(model));

/** A released Relay version, as the installer's RELAY_VERSION takes it: 0.6.121, or a beta such as 0.6.122-beta.3. */
export const RELAY_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-beta\.\d+(?:\.\d+)?)?$/;

/**
 * A local build of Relay that the autopilot made and the gate judges (GATE.md, amendment 4): a version that no release
 * channel ever publishes, `<x.y.z>-loop.<year>w<week>`, with an optional `.<n>` for a rebuild in the same week, such as
 * 0.6.122-loop.2026w44. Its package is a local tarball, never published.
 */
export const LOCAL_BUILD_PATTERN = /^\d+\.\d+\.\d+-loop\.\d{4}w\d{2}(?:\.\d+)?$/;
export const isLocalBuild = (version) => LOCAL_BUILD_PATTERN.test(version ?? "");

/** The tiers a model arm can put its model on: one of Relay's three, or all of them. */
export const MODEL_ARM_TIERS = Object.freeze(["all", "decider", "strong", "fast"]);
const MODEL_ARM = /^(\d+\.\d+\.\d+(?:-beta\.\d+(?:\.\d+)?)?)\+(all|decider|strong|fast)\+([a-z0-9][a-z0-9.-]*)$/;

/**
 * A model arm's spec, `<version>+<tier>+<model>` (model watch): a released Relay with a new model on one tier or on
 * every tier, such as `0.6.121+all+claude-sonnet-6`. Only the characters a release id may have (runner/pins.mjs).
 * Null when `spec` is not one.
 */
export function parseModelArm(spec) {
	const m = MODEL_ARM.exec(spec ?? "");
	return m ? { version: m[1], tier: m[2], model: m[3] } : null;
}

/** The spec of a model arm, checked: `modelArm("0.6.121", "all", "claude-sonnet-6")`. */
export function modelArm(version, tier, model) {
	const spec = `${version}+${tier}+${model}`;
	if (!parseModelArm(spec)) throw new Error(`not a model arm: Relay ${version} with ${model} on ${tier}`);
	return spec;
}

/**
 * The arm for a tool name. `relay@<version>` is Relay at that released version, installed for the run (GATE.md); the
 * gate compares two of them. `relay@<version>+<tier>+<model>` is the same Relay with another model on that tier (model
 * watch), and `override` says which. `relay@pkg` is Relay from --relay-package, for pre-screens only. A local build,
 * `relay@0.6.122-loop.2026w44`, is Relay from --relay-package too, and the only package a counted gate may judge
 * (`localBuild` names its version). Every other name is an arm of ARMS as it is.
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
	if (isLocalBuild(spec)) return { arm: ARMS.relay, base, relayVersion: null, relayPackage: true, localBuild: spec };
	const modelArmSpec = parseModelArm(spec);
	if (modelArmSpec) {
		const { version, tier, model } = modelArmSpec;
		return { arm: ARMS.relay, base, relayVersion: version, relayPackage: false, override: { tier, model } };
	}
	if (!RELAY_VERSION_PATTERN.test(spec)) return null;
	return { arm: ARMS.relay, base, relayVersion: spec, relayPackage: false };
}

/** The installer command that puts one released Relay version in place for the sandbox user, kernel included. */
export function relayInstallCommand(version) {
	if (!RELAY_VERSION_PATTERN.test(version)) throw new Error(`not a released Relay version: ${version}`);
	// Into the folder first on a run's PATH (sandbox/template.mjs RUN_PATH), where the template's own Relay lives: the
	// installer would otherwise pick npm's writable system folder, and `relay` would still be the template's version.
	// `relay --version` prints on stderr in the sandbox, so both streams are read.
	return `curl -fsSL https://relayevals.com/harness/install.sh | NPM_CONFIG_PREFIX=/home/user/.relay/npm-global RELAY_VERSION=${version} RELAY_BOOTSTRAP_KERNEL_ON_INSTALL=1 DO_NOT_TRACK=1 sh && relay --version 2>&1`;
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
	if (tool === "codex") {
		// `codex exec --json` prints one event a line; a turn ends with turn.completed or turn.failed. It said it was done
		// when its last turn completed and it exited 0.
		let last;
		for (const line of stdout.split("\n")) {
			try {
				const event = JSON.parse(line);
				if (event.type === "turn.completed" || event.type === "turn.failed") last = event.type;
			} catch {}
		}
		return exitCode === 0 && last === "turn.completed";
	}
	return exitCode === 0;
}
