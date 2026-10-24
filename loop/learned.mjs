// What the week's release learned, in one or two plain sentences: the central side of relay-harness D-101's weekly
// note, which the harness writes per repository. Each release the loop makes carries them: the change it ships and its
// measured result, the rows of the router's starting table it changes, and the harness versions tried for the first
// time that week (scripts/harness-watch.mjs).
//
// - The measured result is the gate's on the exam once the gate has run (loop/autopilot.mjs, in the pull request), and
//   until then each lane's pre-screen on the dev set (loop/package.mjs, in PR_BODY.md and the release's changelog
//   fragment). Numbers only, with the interval: never a word for the result.
// - The changelog fragment (`packages/<pkg>/.changes/loop-<week>.md`) is part of the release's commit, which is fixed
//   before the gate runs and is what the gate judges, so it carries the pre-screen's numbers; the gate's are in the pull
//   request and the ledger. The harness's scripts/release.mjs folds the fragment into CHANGELOG.md, which Releases
//   shows, and its pull request check asks for one whenever a package's src changes.
import { newFileDiff } from "./diff.mjs";
import { setWords } from "./propose.mjs";

const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "–");
const signed = (x, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "–");
const fmt = (v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));
const list = (items) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The values a relay.arch change sets, one per leaf that differs: [{ path, from, to }], objects walked, arrays whole. */
export function leafChanges(path, from, to) {
	if (plain(from) && plain(to)) {
		return [...new Set([...Object.keys(from), ...Object.keys(to)])].flatMap((k) => leafChanges(`${path}.${k}`, from[k], to[k]));
	}
	return JSON.stringify(from) === JSON.stringify(to) ? [] : [{ path, from, to }];
}

/** What one change teaches Relay, in a few words, after "Relay learned". */
export function changeWords(p) {
	const c = p?.change ?? {};
	if (c.row) {
		const to = setWords(c.row.to);
		return `to start ${to}${to.includes(",") ? "," : ""} on its router's ${c.row.id} row, where it started ${setWords(c.row.from)}`;
	}
	if (c.kind === "arch") {
		const leaves = leafChanges(c.path, c.from, c.to);
		if (!leaves.length) return `a new value for ${c.path}`;
		const shown = leaves.slice(0, 2).map((l) => `${l.path} from ${l.from === undefined ? "unset" : fmt(l.from)} to ${l.to === undefined ? "unset" : fmt(l.to)}`);
		return `to set ${list(shown)}${leaves.length > 2 ? ` and ${leaves.length - 2} more of ${c.path}` : ""}`;
	}
	if (c.kind === "skill") return `a new skill, ${c.skill}, from lessons people chose to share`;
	return `new words for its ${c.prompt ?? c.symbol ?? c.file} ${String(c.prompt ?? "").startsWith("tool.") ? "tool" : "prompt"}`;
}

/** The measured result: the gate's on the exam when given, else each chosen lane's pre-screen on the dev set. */
export function measuredWords({ chosen, results = [], gate = null, champion = null }) {
	if (gate && Number.isFinite(gate.difference)) {
		return `the gate on the exam measured ${signed(gate.difference)} points of requirements met${champion ? ` against relay@${champion}` : ""} (interval ${f(gate.low)} to ${f(gate.high)}, ${gate.tasks} tasks, ${gate.status})`;
	}
	const devs = chosen.map((p) => results.find((r) => r.id === p.id)?.dev).filter((d) => d && Number.isFinite(d.difference));
	if (!devs.length) return "nothing has measured it yet";
	const one = (d) => `${signed(d.difference)} points (interval ${f(d.low)} to ${f(d.high)}, ${d.tasks} practice tasks)`;
	return `${devs.length === 1 ? "its pre-screen" : "its pre-screens"} measured ${list(devs.map(one))}${champion ? ` against relay@${champion}` : ""}`;
}

/**
 * The release's lines: one or two plain sentences. `chosen` are the release's proposals, `results` their pre-screens,
 * `gate` the gate's result once it has run, `harnesses` the words for each harness version tried for the first time
 * this week (scripts/harness-watch.mjs triedThisWeek), or null when no check ran.
 */
export function learnedLines({ cycle, chosen, results = [], gate = null, champion = null, harnesses = null }) {
	if (!chosen?.length) return [];
	const first = `In week ${cycle} Relay learned ${list(chosen.map(changeWords))}; ${measuredWords({ chosen, results, gate, champion })}.`;
	const rows = chosen.map((p) => p.change?.row?.id).filter(Boolean);
	const router = rows.length ? `It changes the router's ${list(rows)} row${rows.length === 1 ? "" : "s"}` : "It changes no row of the router's starting table";
	const tried = harnesses === null || harnesses === undefined ? "" : harnesses.length ? `, and this week's new harness version${harnesses.length === 1 ? " is" : "s are"} ${list(harnesses)}` : ", and no new harness version came out this week";
	return [first, `${router}${tried}.`];
}

/** The section the release's pull request body carries. */
export const learnedSection = (lines) => ["## What Relay learned this week", "", lines.join(" "), ""];

/** The packages whose changelog a release's fragment goes in: Relay's own, and each other package whose src it changes. */
export const FRAGMENT_PACKAGES = Object.freeze(["coding-agent", "agent", "ai", "tui", "supervisor"]);
export const fragmentPath = (pkg, cycle) => `packages/${pkg}/.changes/loop-${cycle.toLowerCase()}.md`;

/**
 * The release's changelog fragments, as new-file diffs to add to release.patch: one bullet with the lines, in Relay's
 * package (coding-agent) and in every other package whose src/ the patch changes, where that package keeps fragments
 * (`.changes/README.md` at the champion) and the file is not there yet. Returns { patch, files, text }.
 */
export function fragmentDiffs({ cycle, lines, patch, sources = () => null }) {
	if (!lines.length) return { patch: "", files: [] };
	const touched = new Set([...String(patch ?? "").matchAll(/^diff --git a\/packages\/([^/]+)\/src\//gm)].map((m) => m[1]));
	const files = FRAGMENT_PACKAGES.filter((pkg) => pkg === "coding-agent" || touched.has(pkg))
		.filter((pkg) => typeof sources(`packages/${pkg}/.changes/README.md`) === "string")
		.map((pkg) => fragmentPath(pkg, cycle))
		.filter((file) => typeof sources(file) !== "string");
	const text = `- ${lines.join(" ")}\n`;
	return { patch: files.map((file) => newFileDiff(text, file)).join(""), files, text };
}
