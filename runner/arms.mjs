// How each tool runs, unattended, inside a benchmark sandbox: its config files, its command, and how its own claim of
// being done is read. Every tool sends its model traffic through the meter on 127.0.0.1:8787 and gets the same model,
// time limit and spend cap (enforced by the meter). Settings not named here are the tool's defaults.
export const METER_URL = "http://127.0.0.1:8787";
export const WORK = "/home/user/work";
export const REQUEST = "/home/user/request.md";

const quote = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

export const ARMS = {
	relay: {
		label: "Relay",
		/** Relay through its queue, one model on every tier, model traffic through the meter. */
		files: ({ model }) => ({
			"/home/user/.relay/agent/settings.json": JSON.stringify({
				defaultProvider: "anthropic",
				defaultModel: model,
				models: { tiers: { decider: `anthropic/${model}`, strong: `anthropic/${model}`, fast: `anthropic/${model}` } },
			}),
			"/home/user/.relay/agent/models.json": JSON.stringify({ providers: { anthropic: { baseUrl: METER_URL } } }),
		}),
		command: ({ capUsd }) =>
			`relay queue plan --file ${REQUEST} && relay queue run --spend-cap ${capUsd}`,
		env: () => ({}),
		/** Relay's result is what a reviewer would merge: its verified task branches, merged in plan order. */
		result: "relay-merge",
	},
	"prime-agent": {
		label: "Prime Agent",
		/** Prime Agent's documented unattended mode, gated on the task's own checks. Its turn, token, continuation and
		 *  time limits are raised to the round's shared limits so its defaults (12 turns, 80,000 tokens, 30 minutes)
		 *  do not stop a 3-hour request early; the meter's spend cap is the limit that binds, as for every tool. */
		files: ({ model }) => ({
			"/home/user/.prime/agent/settings.json": JSON.stringify({ defaultProvider: "anthropic", defaultModel: model }),
			"/home/user/.prime/agent/models.json": JSON.stringify({ providers: { anthropic: { baseUrl: METER_URL } } }),
		}),
		command: ({ model, gates, limitMinutes }) =>
			[
				"prime-agent -p --autonomous",
				...Object.values(gates).map((gate) => `--autonomous-gate ${quote(gate)}`),
				"--autonomous-max-turns 100000 --autonomous-max-tokens 1000000000 --autonomous-max-continuations 100",
				`--autonomous-timeout-ms ${limitMinutes * 60_000}`,
				`--model anthropic/${model}`,
				`"$(cat ${REQUEST})"`,
			].join(" "),
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
		env: ({ model }) => ({
			ANTHROPIC_BASE_URL: METER_URL,
			ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
			ANTHROPIC_DEFAULT_SONNET_MODEL: model,
			ANTHROPIC_DEFAULT_OPUS_MODEL: model,
			ANTHROPIC_SMALL_FAST_MODEL: model,
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			DISABLE_AUTOUPDATER: "1",
		}),
		result: "working-tree",
	},
};

/** What the tool itself said about finishing, read from its own output. */
export function saidDone(tool, { exitCode, stdout, relayMerge }) {
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
