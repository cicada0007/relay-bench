// Package: the cycle's pre-screened proposals as one combined release, written down and never opened anywhere.
//
// One change per lane (GATE.md amendment 1, "Combined candidates": several lane changes are judged as one candidate,
// once, at the full 2.5%): the best pre-screened proposal of each lane. The package is files in the cycle's folder:
// - PR_BODY.md: the body of the pull request a person would open in the harness, with each lane's change, the gain and
//   interval it showed on the dev set, the check tier's answer, the risk tier, how to roll it back, and the ledger
//   entry the release would make;
// - release.patch: every change, composed, for `git apply` at the champion;
// - lanes.json: the combined candidate's manifest for the gate (runner/gate.mjs --combined), with two lanes or more;
// - ledger-preview.json: the entry scripts/ledger.mjs would add, which it writes only after the gate on the exam stops
//   with PASS and a person signs it.
// The loop never opens a pull request in relay-harness; a person reads this and decides.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addsNewFile, newFileDiff, newFileText, serializeLike, setPath, unifiedDiff } from "./diff.mjs";
import { LANE_ORDER, LANES } from "./lanes.mjs";
import { applyToText, maxRisk } from "./propose.mjs";

const f = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : x.toFixed(d));
const signed = (x, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "–");
const fmt = (v) => (typeof v === "object" ? JSON.stringify(v) : String(v));

/** The change id a lane carries in the combined manifest and the ledger, naming its cycle and proposal. */
export const changeId = (cycle, proposalId) => `loop:${cycle}:${proposalId}`;
/** The cycle a change id names, or null. */
export const cycleOfChange = (change) => /^loop:([^:]+):/.exec(change ?? "")?.[1] ?? null;

/** Of the passed pre-screens, the best per lane: highest low end on the dev set, then highest gain. */
export function choosePerLane(passed) {
	const best = new Map();
	for (const r of passed) {
		const cur = best.get(r.lane);
		const key = (x) => [x.dev?.low ?? -Infinity, x.dev?.difference ?? -Infinity];
		if (!cur || key(r)[0] > key(cur)[0] || (key(r)[0] === key(cur)[0] && key(r)[1] > key(cur)[1])) best.set(r.lane, r);
	}
	return LANE_ORDER.filter((l) => best.has(l)).map((l) => best.get(l));
}

/**
 * The combined patch: every relay.arch change applied to one copy of the file, then each source change in lane order.
 * A source change that no longer applies after an earlier lane's is held back. `sources(file)` returns the champion's
 * text. Returns { patch, kept, held: [{ id, why }] }.
 */
export function composePatch({ chosen, arch, archText, sources = () => null }) {
	let after = arch;
	const texts = new Map();
	const created = new Set();
	const kept = [];
	const held = [];
	for (const p of chosen) {
		const codeParts = splitPatch(p.patch).filter((part) => part.file !== "relay.arch.json");
		let ok = true;
		const staged = new Map(texts);
		const fresh = [];
		for (const part of codeParts) {
			// A new file (a taught skill's SKILL.md): it is the patch's own text, and only while nothing holds that path.
			if (addsNewFile(part.text, part.file)) {
				if (staged.has(part.file) || typeof sources(part.file) === "string") {
					ok = false;
					held.push({ id: p.id, why: `it adds ${part.file}, which already exists` });
					break;
				}
				staged.set(part.file, newFileText(part.text));
				fresh.push(part.file);
				continue;
			}
			const base = staged.has(part.file) ? staged.get(part.file) : sources(part.file);
			if (typeof base !== "string") {
				ok = false;
				held.push({ id: p.id, why: `${part.file} could not be read to compose its change` });
				break;
			}
			const next = applyToText(part.file, base, part.text);
			if (next === null) {
				ok = false;
				held.push({ id: p.id, why: `its change to ${part.file} no longer applies after an earlier lane's` });
				break;
			}
			staged.set(part.file, next);
		}
		if (!ok) continue;
		for (const [file, text] of staged) texts.set(file, text);
		for (const file of fresh) created.add(file);
		if (p.change?.kind === "arch") after = setPath(after, p.change.path, p.change.to);
		kept.push(p);
	}
	const parts = [];
	if (arch && archText && after !== arch) parts.push(unifiedDiff(archText, serializeLike(after, archText), { path: "relay.arch.json" }));
	for (const [file, text] of [...texts].sort(([a], [b]) => a.localeCompare(b))) parts.push(created.has(file) ? newFileDiff(text, file) : unifiedDiff(sources(file), text, { path: file }));
	return { patch: parts.join(""), kept, held, arch: after };
}

/** A patch split per file: [{ file, text }]. */
export function splitPatch(patch) {
	const out = [];
	for (const chunk of String(patch ?? "").split(/^(?=diff --git )/m)) {
		const m = /^diff --git a\/(.+?) b\//.exec(chunk);
		if (m) out.push({ file: m[1], text: chunk });
	}
	return out;
}

/** The entry the compound ledger would add for this release, with what only the gate can fill marked so. */
export function ledgerPreview({ ledger, release, champion, lanes }) {
	const last = ledger.entries.at(-1) ?? null;
	return {
		writtenOnlyBy: "node scripts/ledger.mjs write, after the gate on the exam stops with PASS and a founder signs it (GATE.md, amendment 2)",
		wouldBe: {
			seq: (last?.seq ?? 0) + 1,
			release,
			champion,
			...(last && last.release !== champion ? { chainStart: true, note: `the ledger's last release is ${last.release}; this needs --chain-start` } : {}),
			prev: last?.hash ?? null,
			test: `gate-${release}`,
			lanes,
			gate: "from the gate on the exam",
			exam: "from the gate on the exam",
			anchors: "from the gate on the exam",
			signers: "a founder; never the loop, a model or an agent",
		},
	};
}

/** The pull request's body, in plain words and numbers only. */
export function prBody({ cycle, release, champion, chosen, results, arch, held, preview, model }) {
	const byId = new Map(results.map((r) => [r.id, r]));
	const lines = [];
	const lanes = chosen.map((p) => LANES[p.lane].label);
	lines.push(`# Relay loop, cycle ${cycle}: ${lanes.join(", ")}`, "");
	lines.push(`One release candidate from the improvement loop's cycle ${cycle}, against the champion relay@${champion}. It holds one change in each of ${chosen.length} lane${chosen.length === 1 ? "" : "s"}, judged as one candidate by the gate on the exam${chosen.length >= 2 ? " (`--combined lanes.json`)" : ""}. Nothing here is released; a person opens this pull request, the gate judges the release, and a founder signs it.`, "");
	lines.push(`**Risk tier:** ${maxRisk(chosen.map((p) => p.risk))} (the highest of the lanes below: low, a limit moved one step in relay.arch; medium, what a model is told, which model works, or a value held in code; high, how Relay is put together).`, "");
	lines.push("## The changes", "");
	for (const p of chosen) {
		const r = byId.get(p.id);
		const d = r?.dev;
		lines.push(`### ${LANES[p.lane].label}: ${p.title.replace(/^[^:]+: /, "")}`, "");
		lines.push(`- **What:** ${p.words}.`);
		if (p.change?.kind === "arch") {
			lines.push(`- **relay.arch:** \`${p.change.path}\` from \`${fmt(p.change.from)}\` to \`${fmt(p.change.to)}\`${p.change.setHere ? " (set in relay.arch, D-91)" : `; the code holds it: \`${p.change.code?.file} ${p.change.code?.symbol}\`${p.change.code?.patched ? ", changed in this patch" : ", to be changed by hand"}`}.`);
		} else if (p.change?.kind === "skill") lines.push(`- **Source:** a new skill, \`${p.change.file}\`, graduated from lessons people chose to share (relay-bench teaching/, TEACHING.md); no model wrote it.`);
		else lines.push(`- **Source:** \`${p.change.file}\`, the text of \`${p.change.symbol}\` (${p.change.prompt}), written by ${p.change.writer ?? "the loop's writer"} and checked to stay inside it.`);
		if (p.change?.kind === "skill") lines.push(`- **Why:** ${p.evidence?.machines ?? "–"} machines shared it, after it was used in ${p.evidence?.passes ?? "–"} tasks there that passed their checks.`);
		else lines.push(`- **Why:** ${p.evidence?.runs ?? "–"} failing practice runs on ${p.evidence?.tasks ?? "–"} tasks (${(p.clusters ?? []).join(", ") || "measured gap"}).`);
		lines.push(`- **Expected:** ${p.expect}.`);
		if (d) lines.push(`- **Dev set** (practice, ${d.tasks} tasks, relay@pkg minus relay@${champion}): ${signed(d.difference)} points, interval ${f(d.low)} to ${f(d.high)}; cost ratio ${f(d.costRatio, 3)}, time ratio ${f(d.timeRatio, 3)}; safety flags ${d.safetyFlags}.`);
		lines.push(`- **Selection set** (the check tier's one word): ${r?.selection?.status === "pass" ? "pass" : r?.selection?.status === "not available" ? `not asked, ${r.selection.why}` : (r?.selection?.status ?? "–")}.`);
		lines.push(`- **Risk:** ${p.risk}.`);
		lines.push(`- **Roll back:** ${p.change?.kind === "arch" ? `set \`${p.change.path}\` back to \`${fmt(p.change.from)}\` (\`git apply -R\` this lane's part), then \`npm run arch\`.` : `\`git apply -R\` this lane's part of release.patch, then \`npm run arch\`.`}`);
		lines.push("");
	}
	if (held.length) {
		lines.push("## Held back", "");
		for (const h of held) lines.push(`- ${h.id}: ${h.why}`);
		lines.push("");
	}
	lines.push("## Roll back the release", "");
	lines.push(`Revert this pull request. relay@${champion} stays the release people have; relay.arch returns to version ${arch?.version ?? "–"} (hash ${String(arch?.hash ?? "–").slice(0, 12)}) once \`npm run arch\` runs on the reverted tree. A release already out is withdrawn with the switch-off list (D-80), and its successor gated again.`, "");
	lines.push("## How it is judged", "");
	lines.push(`Build the release from \`release.patch\` at v${champion} (\`npm run arch\`, then the release scripts), then run the gate on the exam, a founder's yes first (RUNBOOK.md, "The gate"):`, "");
	lines.push("```");
	lines.push(`node runner/gate.mjs --run --test gate-${release} --champion ${champion} --candidate ${release} \\`);
	lines.push(`  --tier exam --tasks-dir ../relay-exam/tasks --out ../relay-exam/runs/gate --plan-tasks <n> \\`);
	lines.push(`  --anchors ../relay-exam/anchors/<version>.json${chosen.length >= 2 ? " --combined lanes.json" : ""} --model ${model} --reps 1 \\`);
	lines.push("  --cap-usd <usd> --stage-cap-usd <usd> --e2b-cap-usd <usd>");
	lines.push("```", "");
	lines.push("## The ledger entry it would make", "");
	lines.push("Written only by `node scripts/ledger.mjs write`, after the gate on the exam stops with PASS and a founder signs it:", "");
	lines.push("```json", JSON.stringify(preview.wouldBe, null, 2), "```", "");
	lines.push("Proposed by the Relay improvement loop (relay-bench `loop/`). The loop does not open, merge or release it.", "");
	return lines.join("\n");
}

/**
 * The package for one cycle. `results` are the pre-screen results; `proposals` the cycle's proposals by id. Writes the
 * files under <cycleDir>/release unless `write` is false. Returns what it wrote, or { empty: why } when nothing passed.
 */
export function packageRelease({ cycle, cycleDir, results, proposals, arch, archText, sources = () => null, ledger, champion, release, model, write = true }) {
	const passed = results.filter((r) => r.status === "passed");
	if (!passed.length) return { empty: "no proposal passed its pre-screen this cycle" };
	const byId = new Map(proposals.map((p) => [p.id, p]));
	const chosenResults = choosePerLane(passed);
	const notChosen = passed.filter((r) => !chosenResults.includes(r)).map((r) => ({ id: r.id, why: "another proposal of its lane had the higher low end on the dev set; it waits for a later cycle" }));
	const composed = composePatch({ chosen: chosenResults.map((r) => byId.get(r.id)), arch, archText, sources });
	const chosen = composed.kept;
	if (!chosen.length) return { empty: "no pre-screened change could be composed", held: composed.held };
	const lanes = chosen.map((p) => ({ lane: p.lane, change: changeId(cycle, p.id) }));
	const preview = ledgerPreview({ ledger, release, champion, lanes });
	const held = [...notChosen, ...composed.held];
	const body = prBody({ cycle, release, champion, chosen, results, arch, held, preview, model });
	const manifest = chosen.length >= 2 ? { release, lanes } : null;
	const out = { dir: join(cycleDir, "release"), lanes, risk: maxRisk(chosen.map((p) => p.risk)), held, body, patch: composed.patch, manifest, preview, files: [] };
	if (write) {
		mkdirSync(out.dir, { recursive: true });
		const put = (name, text) => {
			writeFileSync(join(out.dir, name), text);
			out.files.push(join(out.dir, name));
		};
		put("PR_BODY.md", body);
		put("release.patch", composed.patch);
		if (manifest) put("lanes.json", `${JSON.stringify(manifest, null, 2)}\n`);
		put("ledger-preview.json", `${JSON.stringify(preview, null, 2)}\n`);
	}
	return out;
}

/** The value a change sets, for a reader: used by the report. */
export const describeChange = (p) => (p.change?.kind === "arch" ? `${p.change.path}: ${fmt(p.change.from)} → ${fmt(p.change.to)}` : p.change?.kind === "skill" ? `new skill ${p.change.skill} (${p.change.file})` : `${p.change?.file} ${p.change?.symbol}`);
