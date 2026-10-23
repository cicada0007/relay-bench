#!/usr/bin/env node
// Graduation (v7 step 5, Central: teaching). Lessons that people chose to share from their machines (harness D-94) are
// read, near-duplicates are grouped, and a group that many independent machines proved becomes a SKILL CANDIDATE in
// the harness's skill format (Agent Skills: <name>/SKILL.md). A candidate is never a base skill: it becomes one only
// through the improvement loop's prompts and skills lane and the gate (loop/, runner/gate.mjs), like any other change
// to Relay. This script never writes into the harness and never marks anything accepted. TEACHING.md has the rules.
//
//   node teaching/graduate.mjs <shared lessons: .json batches or .jsonl records, files or folders>... \
//     [--min-machines 5] [--min-passes 25] [--out runs/teaching] [--json]
//
// Input (exactly what a machine sends, harness D-94): a batch { consent: "lessons-v1", machine: "m_<32 hex>",
// lessons: [{ kind, title, text, model, passes }] }, or one record per line { machine, kind, title, text, model,
// passes } (a row the receiver kept). Anything else is skipped and counted, never read further. The receiver comes
// later; until then these are files. The output is deterministic: the same files give the same candidates, byte for
// byte, with no time in them.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { detectFlags } from "../runner/safety.mjs";

/** The consent a machine's batch says it was sent under (harness D-94). Nothing else is read. */
export const CONSENT = "lessons-v1";
export const KINDS = Object.freeze(["prompt", "memory", "subagent"]);

/**
 * The graduation rule's defaults: at least 5 independent machines and 25 passing uses, and two lessons are the same
 * lesson when their word sets overlap by 0.6 or more (Jaccard), grouped transitively.
 */
export const DEFAULTS = Object.freeze({ minMachines: 5, minPasses: 25, similarity: 0.6 });

/** The harness's limits on a lesson (core/learning/checks.ts): a lesson longer than this is a document. */
export const MAX_TITLE_CHARS = 120;
export const MAX_TEXT_CHARS = 2000;
/** The harness's limits on a skill (core/skills.ts, the Agent Skills spec). */
export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;

const MACHINE = /^m_[0-9a-f]{32}$/;
const MODEL = /^(?:unknown|[a-z0-9][a-z0-9._-]{0,39}\/[A-Za-z0-9][A-Za-z0-9._:@+-]{0,79})$/;
const MAX_PASSES = 100_000;
const MAX_LESSONS_PER_BATCH = 200;
const BATCH_KEYS = ["consent", "machine", "lessons"];
const LESSON_KEYS = ["kind", "title", "text", "model", "passes"];
/** A record in a .jsonl file may also carry its consent and when the receiver kept it; nothing else. */
const RECORD_KEYS = ["machine", ...LESSON_KEYS, "consent", "receivedAt"];

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// ── What must not be in a shared lesson ──
//
// The machine redacts before it sends and refuses what it is unsure of (harness D-94). This is the same check again,
// on Central's side: a lesson that still holds one of these is skipped whole, never redacted here.

const EXTRA_SECRETS = [
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/,
	/\bAIza[0-9A-Za-z_-]{35}\b/,
	/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
	/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{24,}/,
	/\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token|client[_-]?secret)\b["']?\s*[:=]\s*["']?[^\s"']{8,}/i,
	/\bsk-[A-Za-z0-9_-]{20,}/,
];
/** A long run of letters and digits mixed: a key, a token or a hash, none of which a lesson needs. */
const LONG_TOKEN = /[A-Za-z0-9+/_=-]{32,}/g;
const PATHS = [
	/(?:^|[\s"'`(\[=:,])\/[\w.@-]+\/[\w.@-]+/, // /Users/x (a slash command such as /refine is not a path)
	/(?:^|[\s"'`(\[=:,])\/[\w@-]*\.[A-Za-z][\w]*/, // /.env, /etc.conf
	/(?:^|[\s"'`(\[=:,])~[\w.-]*\//, // ~/x, ~alice/x
	/\$HOME\b|%USERPROFILE%|%APPDATA%/i,
	/\b[A-Za-z]:\\/, // C:\
	/(?:^|[\s"'`(\[=:,])\.{1,2}[\\/]/, // ./x, ../x
	/\b[\w.@-]+\/[\w.@-]+\/[\w.@-]+/, // a/b/c
	/\b[\w@-]+\/[\w.@-]*\.[A-Za-z][A-Za-z0-9]{0,7}\b/, // dir/file.ext
	/\b[\w-]+\\[\w.-]+/, // dir\file
	// One slash with a hyphen, underscore, digit or dot on a side: packages/coding-agent, owner/repo-2. "and/or" passes.
	/\b[\w.@-]*[-_.\d][\w.@-]*\/[\w.@-]*[A-Za-z0-9]|\b[\w.@-]*[A-Za-z0-9]\/[\w.@-]*[-_\d][\w.@-]*/,
];
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/; // not a package pinned at a version: eslint@8.57.0
const LINKS = [/\b[a-z][a-z0-9+.-]*:\/\//i, /\bwww\./i, /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|ai|co|xyz|cloud|tech)\b/i];

/** What a lesson's words still hold that must never reach Central: "a secret", "a path", "an email", "a link". */
export function leftovers(text) {
	const s = String(text ?? "");
	const found = [];
	const secret =
		detectFlags({ stdout: s }).some((f) => f.flag === "secret-leaked") ||
		EXTRA_SECRETS.some((re) => re.test(s)) ||
		(s.match(LONG_TOKEN) ?? []).some((t) => /[A-Za-z]/.test(t) && /[0-9]/.test(t));
	if (secret) found.push("a secret");
	if (PATHS.some((re) => re.test(s))) found.push("a path");
	if (EMAIL.test(s)) found.push("an email");
	if (LINKS.some((re) => re.test(s))) found.push("a link");
	return found;
}

// ── Reading what machines shared ──

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const extraKeys = (o, allowed) => Object.keys(o).filter((k) => !allowed.includes(k));

/** Why one lesson cannot be read, or null. */
function lessonProblem(l) {
	if (!isObject(l)) return "a lesson that is not an object";
	if (extraKeys(l, LESSON_KEYS).length) return "a lesson with a field the format does not have";
	if (!KINDS.includes(l.kind)) return "a kind that is not prompt, memory or subagent";
	if (typeof l.title !== "string" || !l.title.trim() || l.title.length > MAX_TITLE_CHARS) return `a title missing or over ${MAX_TITLE_CHARS} characters`;
	if (typeof l.text !== "string" || !l.text.trim() || l.text.length > MAX_TEXT_CHARS) return `a text missing or over ${MAX_TEXT_CHARS} characters`;
	if (typeof l.model !== "string" || !MODEL.test(l.model)) return "a model that is not provider/id or unknown";
	if (!Number.isInteger(l.passes) || l.passes < 0 || l.passes > MAX_PASSES) return "passes that are not a whole number";
	const left = leftovers(`${l.title}\n${l.text}`);
	if (left.length) return `words that still hold ${left.join(" and ")}`;
	if (!words(`${l.title} ${l.text}`).length) return "no words left to compare";
	return null;
}

/**
 * Every lesson in `paths` (files, or folders read for *.json and *.jsonl, sorted), with what was skipped by reason.
 * Returns { lessons: [{ machine, kind, title, text, model, passes }], skipped: { reason: count }, files }.
 */
export function readShared(paths) {
	const files = [];
	for (const p of paths) {
		const full = resolve(p);
		if (!existsSync(full)) throw new Error(`no such file or folder: ${p}`);
		if (statSync(full).isDirectory()) {
			for (const name of readdirSync(full).sort()) if (/\.jsonl?$/.test(name) && statSync(join(full, name)).isFile()) files.push(join(full, name));
		} else files.push(full);
	}
	const lessons = [];
	const skipped = {};
	const skip = (why, n = 1) => {
		skipped[why] = (skipped[why] ?? 0) + n;
	};
	const takeBatch = (b) => {
		if (!isObject(b)) return skip("a batch that is not an object");
		if (b.consent !== CONSENT) return skip(`a batch not sent under consent ${CONSENT}`, Array.isArray(b.lessons) ? Math.max(1, b.lessons.length) : 1);
		if (extraKeys(b, BATCH_KEYS).length) return skip("a batch with a field the format does not have");
		if (typeof b.machine !== "string" || !MACHINE.test(b.machine)) return skip("a batch whose machine id is not m_ and 32 hex");
		if (!Array.isArray(b.lessons) || b.lessons.length > MAX_LESSONS_PER_BATCH) return skip(`a batch without a list of at most ${MAX_LESSONS_PER_BATCH} lessons`);
		for (const l of b.lessons) {
			const why = lessonProblem(l);
			if (why) skip(why);
			else lessons.push({ machine: b.machine, kind: l.kind, title: l.title, text: l.text, model: l.model, passes: l.passes });
		}
	};
	const takeRecord = (r) => {
		if (!isObject(r)) return skip("a record that is not an object");
		if ("lessons" in r) return takeBatch(r);
		if (r.consent !== undefined && r.consent !== CONSENT) return skip(`a record not sent under consent ${CONSENT}`);
		if (extraKeys(r, RECORD_KEYS).length) return skip("a record with a field the format does not have");
		if (r.receivedAt !== undefined && typeof r.receivedAt !== "string") return skip("a record with a field the format does not have");
		if (typeof r.machine !== "string" || !MACHINE.test(r.machine)) return skip("a record whose machine id is not m_ and 32 hex");
		const { machine, consent: _c, receivedAt: _r, ...lesson } = r;
		const why = lessonProblem(lesson);
		if (why) skip(why);
		else lessons.push({ machine, kind: lesson.kind, title: lesson.title, text: lesson.text, model: lesson.model, passes: lesson.passes });
	};
	for (const file of files) {
		const text = readFileSync(file, "utf8");
		if (file.endsWith(".jsonl")) {
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				let value;
				try {
					value = JSON.parse(line);
				} catch {
					skip("a line that is not JSON");
					continue;
				}
				takeRecord(value);
			}
		} else {
			let value;
			try {
				value = JSON.parse(text);
			} catch {
				skip("a file that is not JSON");
				continue;
			}
			for (const b of Array.isArray(value) ? value : [value]) takeBatch(b);
		}
	}
	return { lessons, skipped: Object.fromEntries(Object.entries(skipped).sort(([a], [b]) => a.localeCompare(b))), files };
}

// ── Near-duplicates ──

/** Words that say nothing about what a lesson is. */
const STOP = new Set(
	"a an the to of in on for and or is are be been being it its this that these those with as at by from into you your we our us i me my do does did should must will would can could when so then also just only always any all each every there here which what".split(
		" ",
	),
);

/** A word reduced to its stem, enough that "committing", "commits" and "commit" are one word. */
export function stem(word) {
	let w = word;
	if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
	else if (/(?:s|x|z|ch|sh)es$/.test(w) && w.length > 4) w = w.slice(0, -2);
	else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
	if (w.endsWith("ing") && w.length - 3 >= 3) w = w.slice(0, -3);
	else if (w.endsWith("ed") && w.length - 2 >= 3) w = w.slice(0, -2);
	if (/([bdgmnprt])\1$/.test(w)) w = w.slice(0, -1);
	if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
	return w;
}

/** A lesson's words for comparing: lowercase, placeholders such as <path> and punctuation gone, stop words dropped, stemmed. */
export function words(text) {
	const plain = String(text ?? "")
		.toLowerCase()
		.replace(/<[^<>\n]{1,40}>/g, " ")
		.replace(/['\u2019]s\b/g, " ")
		.replace(/[^a-z0-9]+/g, " ");
	const out = new Set();
	for (const w of plain.split(" ")) if (w && !STOP.has(w)) out.add(stem(w));
	return [...out].sort();
}

/** Jaccard similarity of two sorted word lists: shared words over all words. */
export function jaccard(a, b) {
	if (!a.length && !b.length) return 1;
	const set = new Set(a);
	let shared = 0;
	for (const w of b) if (set.has(w)) shared++;
	return shared / (a.length + b.length - shared);
}

/** Words that turn a lesson around: "run X before Y" and "never run X before Y" share most words and are not alike. */
const NEGATION = /\b(?:not|never|no|don['\u2019]?t|doesn['\u2019]?t|cannot|can['\u2019]?t|avoid|without)\b/i;
export const negated = (text) => NEGATION.test(String(text ?? ""));

const lessonText = (l) => `${l.title}\n${l.text}`;
const order = (a, b) => a.kind.localeCompare(b.kind) || lessonText(a).localeCompare(lessonText(b)) || a.machine.localeCompare(b.machine) || a.model.localeCompare(b.model) || a.passes - b.passes;

/**
 * Lessons grouped by near-duplicate: same kind, both or neither saying "not" (or never, no, don't, avoid, without),
 * and linked when their words overlap by `similarity` or more, so a group is every lesson reachable through such
 * links. Returns groups of lessons, in a fixed order.
 */
export function groupLessons(lessons, { similarity = DEFAULTS.similarity } = {}) {
	const sorted = [...lessons].sort(order);
	const w = sorted.map((l) => words(`${l.title} ${l.text}`));
	const neg = sorted.map((l) => negated(`${l.title} ${l.text}`));
	const parent = sorted.map((_, i) => i);
	const find = (i) => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};
	for (let i = 0; i < sorted.length; i++) {
		for (let j = i + 1; j < sorted.length; j++) {
			if (sorted[i].kind !== sorted[j].kind || neg[i] !== neg[j]) continue;
			if (jaccard(w[i], w[j]) >= similarity) {
				const a = find(i);
				const b = find(j);
				if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
			}
		}
	}
	const groups = new Map();
	sorted.forEach((l, i) => {
		const root = find(i);
		if (!groups.has(root)) groups.set(root, []);
		groups.get(root).push(l);
	});
	return [...groups.values()];
}

/**
 * What a group proves. Each machine counts once: its passes are the highest any of its copies reported, so a machine
 * that sends a lesson many times, or again with more passes, adds nothing past its best.
 */
export function groupEvidence(group) {
	const best = new Map();
	for (const l of group) best.set(l.machine, Math.max(best.get(l.machine) ?? 0, l.passes));
	const texts = new Map();
	for (const l of group) {
		const key = `${l.title}\n${l.text}`;
		const t = texts.get(key) ?? { title: l.title, text: l.text, machines: new Set(), passes: 0 };
		t.machines.add(l.machine);
		texts.set(key, t);
	}
	for (const t of texts.values()) for (const m of t.machines) t.passes += best.get(m);
	// The words most machines sent, then the most passes behind them, then the shortest, then the first in order.
	const representative = [...texts.values()].sort((a, b) => b.machines.size - a.machines.size || b.passes - a.passes || a.text.length - b.text.length || `${a.title}\n${a.text}`.localeCompare(`${b.title}\n${b.text}`))[0];
	return {
		kind: group[0].kind,
		machines: best.size,
		passes: [...best.values()].reduce((s, n) => s + n, 0),
		members: group.length,
		texts: texts.size,
		models: [...new Set(group.map((l) => l.model))].sort(),
		memberHashes: [...texts.keys()].map((k) => `sha256:${sha256(k)}`).sort(),
		title: representative.title,
		text: representative.text,
	};
}

/** Whether a group meets the rule, and if not, what it lacks. */
export function meetsRule(evidence, { minMachines = DEFAULTS.minMachines, minPasses = DEFAULTS.minPasses } = {}) {
	const lacks = [];
	if (evidence.machines < minMachines) lacks.push(`${evidence.machines} of the ${minMachines} machines it needs`);
	if (evidence.passes < minPasses) lacks.push(`${evidence.passes} of the ${minPasses} passing uses it needs`);
	return lacks;
}

// ── The skill candidate, in the harness's format ──

/** Why a skill name would not load in the harness (core/skills.ts validateName), or an empty list. */
export function skillNameProblems(name, folder = name) {
	const problems = [];
	if (name !== folder) problems.push(`name "${name}" does not match its folder "${folder}"`);
	if (!name || name.length > MAX_NAME_LENGTH) problems.push(`a name of 1 to ${MAX_NAME_LENGTH} characters`);
	if (!/^[a-z0-9-]+$/.test(name)) problems.push("a name of lowercase a-z, 0-9 and hyphens only");
	if (name.startsWith("-") || name.endsWith("-")) problems.push("a name that does not start or end with a hyphen");
	if (name.includes("--")) problems.push("a name without two hyphens in a row");
	return problems;
}

/** Why a description would not load (core/skills.ts validateDescription), or an empty list. */
export function descriptionProblems(description) {
	if (typeof description !== "string" || !description.trim()) return ["a description is required"];
	if (description.length > MAX_DESCRIPTION_LENGTH) return [`a description of at most ${MAX_DESCRIPTION_LENGTH} characters`];
	return [];
}

/** A skill name from a lesson's title: "Run the tests before committing" -> "run-the-tests-before-committing". */
export function skillName(title) {
	const slug = String(title)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_NAME_LENGTH)
		.replace(/-+$/g, "");
	return slug || "taught-lesson";
}

/** The candidate's description: the lesson's title as one sentence, and its first sentence when the title is short. */
export function skillDescription({ title, text }) {
	const sentence = (s) => {
		const t = s.replace(/\s+/g, " ").trim();
		return /[.!?]$/.test(t) ? t : `${t}.`;
	};
	let d = sentence(title);
	if (d.length < 40) {
		const first = /^[^.!?\n]*[.!?]?/.exec(text.trim())?.[0] ?? "";
		if (first.trim() && first.trim().toLowerCase() !== title.trim().toLowerCase()) d = `${d} ${sentence(first)}`;
	}
	return d.length > 300 ? `${d.slice(0, 297).replace(/\s+\S*$/, "")}...` : d;
}

/** SKILL.md for a candidate: the frontmatter the harness reads (name, description), then the lesson's words. */
export function skillMarkdown({ name, title, text }) {
	const description = skillDescription({ title, text });
	return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${title.replace(/\s+/g, " ").trim()}\n\n${text.trim()}\n`;
}

/**
 * The frontmatter of a SKILL.md as this script writes it: `name: <plain>` and `description: <JSON string>`, nothing
 * else. Returns { name, description } or null when it is not in that form.
 */
export function readFrontmatter(markdown) {
	const m = /^---\n([\s\S]*?)\n---\n/.exec(String(markdown ?? "").replace(/\r\n?/g, "\n"));
	if (!m) return null;
	const out = {};
	for (const line of m[1].split("\n")) {
		const kv = /^(name|description): (.*)$/.exec(line);
		if (!kv || kv[1] in out) return null;
		if (kv[1] === "description") {
			try {
				out.description = JSON.parse(kv[2]);
			} catch {
				return null;
			}
			if (typeof out.description !== "string") return null;
		} else out.name = kv[2];
	}
	return typeof out.name === "string" && typeof out.description === "string" ? out : null;
}

/**
 * The graduation: groups, the rule, and a candidate for each group that meets it. Returns { candidates: [{ name,
 * skill, candidate }], below: [{ kind, machines, passes, members, lacks }], skipped, thresholds }.
 */
export function graduate(lessons, { minMachines = DEFAULTS.minMachines, minPasses = DEFAULTS.minPasses, similarity = DEFAULTS.similarity, skipped = {} } = {}) {
	if (!(Number.isInteger(minMachines) && minMachines >= 1)) throw new Error("--min-machines is a whole number, 1 or more");
	if (!(Number.isInteger(minPasses) && minPasses >= 0)) throw new Error("--min-passes is a whole number, 0 or more");
	if (!(similarity > 0 && similarity <= 1)) throw new Error("the similarity is above 0 and at most 1");
	const thresholds = { minMachines, minPasses, similarity };
	const candidates = [];
	const below = [];
	const names = new Set();
	const evidences = groupLessons(lessons, { similarity }).map(groupEvidence);
	// The strongest first, so a name two groups would share goes to the one more machines proved.
	evidences.sort((a, b) => b.machines - a.machines || b.passes - a.passes || a.kind.localeCompare(b.kind) || a.memberHashes[0].localeCompare(b.memberHashes[0]));
	for (const e of evidences) {
		const lacks = meetsRule(e, thresholds);
		if (lacks.length) {
			below.push({ kind: e.kind, machines: e.machines, passes: e.passes, members: e.members, lacks });
			continue;
		}
		const base = skillName(e.title);
		let name = base;
		for (let n = 2; names.has(name); n++) name = `${base.slice(0, MAX_NAME_LENGTH - String(n).length - 1).replace(/-+$/g, "")}-${n}`;
		names.add(name);
		const skill = skillMarkdown({ name, title: e.title, text: e.text });
		candidates.push({
			name,
			skill,
			candidate: {
				schema: 1,
				name,
				kind: e.kind,
				status: "candidate",
				rule: "A candidate becomes a base skill only through the improvement loop's prompts and skills lane and the gate (relay-bench loop/ and runner/gate.mjs, TEACHING.md), never directly.",
				evidence: { machines: e.machines, passes: e.passes, members: e.members, texts: e.texts, models: e.models, memberHashes: e.memberHashes },
				thresholds,
				skillSha256: sha256(skill),
			},
		});
	}
	return { candidates, below, skipped, thresholds };
}

/** True when `dir` or a folder above it is a harness checkout (it has relay.arch.json at its root). */
export function insideHarness(dir) {
	let d = resolve(dir);
	for (;;) {
		if (existsSync(join(d, "relay.arch.json"))) return true;
		const up = dirname(d);
		if (up === d) return false;
		d = up;
	}
}

const SUMMARY = "graduation.json";

/**
 * Writes the candidates to `out`: <name>/SKILL.md and <name>/candidate.json each, and graduation.json, the summary.
 * Refuses a folder inside the harness, and a folder that holds anything this script did not write. What an earlier run
 * wrote there is replaced.
 */
export function writeCandidates(result, out) {
	const dir = resolve(out);
	if (insideHarness(dir)) throw new Error(`${out} is inside a harness checkout; candidates never go into the harness, only through the improvement loop`);
	if (existsSync(dir)) {
		const names = readdirSync(dir);
		if (names.length) {
			const summaryPath = join(dir, SUMMARY);
			const before = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : null;
			const ours = new Set([SUMMARY, ...(before?.candidates ?? []).map((c) => c.name)]);
			const foreign = names.filter((n) => !ours.has(n));
			if (!before || foreign.length) throw new Error(`${out} holds files graduate.mjs did not write (${foreign.slice(0, 3).join(", ") || names.slice(0, 3).join(", ")}); give an empty folder`);
			for (const n of ours) rmSync(join(dir, n), { recursive: true, force: true });
		}
	}
	mkdirSync(dir, { recursive: true });
	for (const c of result.candidates) {
		mkdirSync(join(dir, c.name), { recursive: true });
		writeFileSync(join(dir, c.name, "SKILL.md"), c.skill);
		writeFileSync(join(dir, c.name, "candidate.json"), `${JSON.stringify(c.candidate, null, 2)}\n`);
	}
	writeFileSync(join(dir, SUMMARY), `${JSON.stringify(summaryOf(result), null, 2)}\n`);
	return dir;
}

/** The run in numbers: thresholds, what was skipped and why, the candidates and the groups below the rule. */
export function summaryOf(result) {
	return {
		schema: 1,
		thresholds: result.thresholds,
		skipped: result.skipped,
		candidates: result.candidates.map((c) => ({ name: c.name, kind: c.candidate.kind, machines: c.candidate.evidence.machines, passes: c.candidate.evidence.passes, members: c.candidate.evidence.members })),
		below: result.below,
	};
}

/**
 * The candidates in a folder graduate.mjs wrote, checked again before the loop reads them: each <name>/candidate.json
 * and SKILL.md, the SKILL.md unchanged since (its hash), its frontmatter loadable by the harness, and its words free
 * of secrets, paths, emails and links. Returns { candidates: [{ name, dir, skill, candidate }], problems: [{ name, problems }] }.
 */
export function readCandidates(dir) {
	const candidates = [];
	const problems = [];
	if (!existsSync(dir)) return { candidates, problems: [{ name: dir, problems: ["no such folder"] }] };
	for (const name of readdirSync(dir).sort()) {
		const folder = join(dir, name);
		if (!statSync(folder).isDirectory()) continue;
		const why = [];
		let candidate = null;
		let skill = null;
		try {
			candidate = JSON.parse(readFileSync(join(folder, "candidate.json"), "utf8"));
		} catch {
			why.push("no readable candidate.json");
		}
		try {
			skill = readFileSync(join(folder, "SKILL.md"), "utf8");
		} catch {
			why.push("no SKILL.md");
		}
		if (candidate && skill !== null) {
			if (candidate.schema !== 1 || candidate.status !== "candidate") why.push("not a candidate graduate.mjs wrote");
			if (candidate.name !== name) why.push(`candidate.json names ${candidate.name}, not its folder ${name}`);
			if (!KINDS.includes(candidate.kind)) why.push("a kind that is not prompt, memory or subagent");
			if (candidate.skillSha256 !== sha256(skill)) why.push("SKILL.md changed since graduation");
			for (const k of ["accepted", "acceptedBy", "approved", "approvedBy"]) if (k in candidate) why.push(`a candidate is never ${k.replace(/By$/, " by anyone")}`);
			const fm = readFrontmatter(skill);
			if (!fm) why.push("SKILL.md's frontmatter is not name and description");
			else why.push(...skillNameProblems(fm.name, name), ...descriptionProblems(fm.description));
			const left = leftovers(skill);
			if (left.length) why.push(`SKILL.md holds ${left.join(" and ")}`);
		}
		if (why.length) problems.push({ name, problems: why });
		else candidates.push({ name, dir: folder, skill, candidate });
	}
	return { candidates, problems };
}

/** The run in plain words, numbers only. */
export function describe(result, out) {
	const L = [];
	const skippedTotal = Object.values(result.skipped).reduce((s, n) => s + n, 0);
	const t = result.thresholds;
	L.push(`Rule: at least ${t.minMachines} machines and ${t.minPasses} passing uses per group; lessons are one group when their words overlap by ${t.similarity} or more.`);
	L.push(`${result.candidates.length} skill candidate${result.candidates.length === 1 ? "" : "s"}, ${result.below.length} group${result.below.length === 1 ? "" : "s"} below the rule, ${skippedTotal} skipped.`);
	for (const c of result.candidates) L.push(`  candidate ${c.name} (${c.candidate.kind}): ${c.candidate.evidence.machines} machines, ${c.candidate.evidence.passes} passing uses, ${c.candidate.evidence.members} copies`);
	for (const [why, n] of Object.entries(result.skipped)) L.push(`  skipped ${n}: ${why}`);
	if (out) L.push(`Written to ${out}. A candidate is not a base skill: it goes to the improvement loop (node loop/cycle.mjs --teaching ${out}), and only the gate lets it in.`);
	return L.join("\n");
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			"min-machines": { type: "string" },
			"min-passes": { type: "string" },
			out: { type: "string" },
			json: { type: "boolean", default: false },
		},
	});
	if (!positionals.length) {
		console.error("usage: node teaching/graduate.mjs <shared lessons>... [--min-machines 5] [--min-passes 25] [--out <dir>] [--json]");
		process.exit(2);
	}
	const num = (v, d) => (v === undefined ? d : Number(v));
	try {
		const read = readShared(positionals);
		const result = graduate(read.lessons, { minMachines: num(values["min-machines"], DEFAULTS.minMachines), minPasses: num(values["min-passes"], DEFAULTS.minPasses), skipped: read.skipped });
		const out = values.out ? writeCandidates(result, values.out) : null;
		console.log(values.json ? JSON.stringify(summaryOf(result), null, 2) : describe(result, out));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
