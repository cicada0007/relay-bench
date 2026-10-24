// Where the scoreboard's records and picker answers are: round 1's test F, and every stage folder under
// <runs>/scoreboard/ (runner/harbor-bench.mjs's default). scripts/scoreboard.mjs and scripts/arm-outcomes.mjs read the
// same stages through this module, so the router's evidence and the scoreboard always count the same trials.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PICKER_EFFORT, PICKER_MODEL } from "../meta/pick-groups.mjs";

const readJsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/**
 * Where each benchmark's records are, besides every stage folder under <runs>/scoreboard/ (runner/harbor-bench.mjs's
 * default, read by the benchmark its records name). `stage` is a Harbor stage folder under the runs folder; `reuse`
 * names picker answers from elsewhere that the entry may count (round 1's exam asked about these same pairs).
 */
export const SOURCES = Object.freeze([{ benchmark: "terminal-bench-2-1", stage: "round-1/F", label: "Round 1, test F", reuse: ["meta/pick-exam-gpt-6.1-sol-medium.jsonl"] }]);
export const SCANNED = "scoreboard";

/** Every stage folder under <runs>/scoreboard/, as a source of the benchmark its first record names. */
export function scannedSources(runsDir) {
	const dir = join(runsDir, SCANNED);
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "records.jsonl")))
		.map((d) => ({ benchmark: readJsonl(join(dir, d.name, "records.jsonl"))[0]?.benchmark, stage: join(SCANNED, d.name) }))
		.filter((s) => s.benchmark)
		.sort((a, b) => a.stage.localeCompare(b.stage));
}

/** Picker answers a stage may count: its own picks file, and the source's `reuse` files under the runs folder. */
export function picksFor(stageDir, runsDir, reuse = []) {
	const own = join(stageDir, "meta", `picks-${PICKER_MODEL}-${PICKER_EFFORT}.jsonl`);
	return [own, ...reuse.map((p) => join(runsDir, p))].flatMap(readJsonl);
}

