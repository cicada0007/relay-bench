#!/usr/bin/env node
// The contamination scan (TIERS.md, "The living exam"): before a mined candidate is drafted, and before a drafted task
// is approved, check it against everything the improving loop can see, and against its own dates. A task the loop has
// seen, or one dated before the models' training cutoff, measures memory rather than skill.
//
// What the loop can see: every file tracked in this public repository (its fixtures, results and reviews included),
// the practice tasks (tasks/ and dev-tasks/ here), and every task the exam already holds, retired or not. A candidate
// is also compared with the other candidates, so the same change mined twice is caught.
//
// What it checks, per candidate or task:
// - seen:            the same repository and pull request or issue as a task or candidate already seen;
// - mentioned:       its issue or pull request URL, or "owner/repo#n", appears in loop-visible text;
// - same repository: its repository is the source of a practice task or a public fixture;
// - near-duplicate:  its text (issue and pull request titles, the issue's body when known, a drafted request) shares
//                    most of its 5-word runs with one loop-visible document (containment >= 0.5, or Jaccard >= 0.5);
// - dates:           the issue opened and the fix merged after the cutoff, the issue before the merge, and the
//                    candidate mined with a cutoff no earlier than this one.
//
//   node scripts/contamination.mjs --exam ../relay-exam --cutoff 2026-07-01 [--candidates <file>] [--json]
//
// It reads only; it writes nothing. scripts/living-exam.mjs runs it as one step of the weekly pipeline.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = new URL("..", import.meta.url).pathname;
export const SHINGLE = 5;
export const NEAR = Object.freeze({ containment: 0.5, jaccard: 0.5, minShingles: 3 });

/** Lower case, letters and digits only, single spaces. */
export const normalize = (text) =>
	String(text ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

/** The text's runs of `n` words. A text shorter than n words but at least 3 long is one run. */
export function shingles(text, n = SHINGLE) {
	const words = normalize(text).split(" ").filter(Boolean);
	const out = new Set();
	if (words.length < n) {
		if (words.length >= 3) out.add(words.join(" "));
		return out;
	}
	for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
	return out;
}

/** References a text makes to GitHub issues and pull requests: "owner/repo#n" and issue or pull URLs, lower case. */
export function references(text) {
	const refs = new Set();
	const s = String(text ?? "");
	for (const m of s.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/gi)) refs.add(`${m[1]}#${m[2]}`.toLowerCase());
	for (const m of s.matchAll(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/g)) refs.add(`${m[1]}#${m[2]}`.toLowerCase());
	return refs;
}

/**
 * The loop-visible corpus. `docs` are { id, source, text, taskId? } (taskId: the task a document belongs to, so a task
 * is never compared with itself); `seen` are earlier tasks or candidates as
 * { id, source, repo, pr, issue, text }; `repos` are repositories the loop has seen ({ repo, source }).
 */
export function buildCorpus({ docs = [], seen = [], repos = [] }) {
	const index = new Map();
	const entries = [];
	for (const d of [...docs, ...seen.filter((s) => s.text)]) {
		const sh = shingles(d.text);
		const entry = { id: d.id, taskId: d.taskId ?? d.id, source: d.source, size: sh.size, shingles: sh };
		entries.push(entry);
		for (const s of sh) {
			if (!index.has(s)) index.set(s, []);
			index.get(s).push(entry);
		}
	}
	const refs = new Map();
	for (const d of docs) for (const r of references(d.text)) if (!refs.has(r)) refs.set(r, d);
	const lower = (x) => String(x ?? "").toLowerCase();
	return {
		index,
		refs,
		seen: seen.map((s) => ({ ...s, repo: lower(s.repo) })),
		repos: new Map(repos.map((r) => [lower(r.repo), r.source])),
	};
}

/** The candidate's or task's identity and text, from a mined candidate (mine-tasks.mjs) or a task's source block. */
export function subjectOf(item) {
	const source = item.source ?? {};
	const repo = String(item.repo ?? source.repo ?? "").toLowerCase();
	const num = (url) => Number(/\/(?:issues|pull)\/(\d+)/.exec(url ?? "")?.[1]) || null;
	return {
		id: item.id,
		repo,
		pr: item.pr?.number ?? num(source.pr),
		issue: item.issue?.number ?? num(source.issue),
		issueCreatedAt: item.issue?.createdAt ?? source.issueCreatedAt ?? null,
		mergedAt: item.pr?.mergedAt ?? source.prMergedAt ?? null,
		minedAt: item.minedAt ?? null,
		minedCutoff: item.cutoff ?? null,
		text: [item.issue?.title, item.issue?.body, item.pr?.title, item.request].filter(Boolean).join("\n"),
	};
}

/** Every reason a candidate or task is contaminated; { id, clean, hits }. `cutoff` is YYYY-MM-DD. */
export function scan(item, corpus, { cutoff }) {
	const s = subjectOf(item);
	const hits = [];
	const add = (kind, detail, source) => hits.push({ kind, detail, ...(source ? { source } : {}) });

	for (const other of corpus.seen) {
		if (other.id === s.id || other.repo !== s.repo) continue;
		// Two pull requests from the same base commit are different tasks (another issue, another fix), so only the same
		// pull request or the same issue counts as seen.
		if (s.pr && other.pr === s.pr) add("seen", `the same pull request ${s.repo}#${s.pr} as ${other.id}`, other.source);
		else if (s.issue && other.issue === s.issue) add("seen", `the same issue ${s.repo}#${s.issue} as ${other.id}`, other.source);
	}
	for (const ref of [s.pr && `${s.repo}#${s.pr}`, s.issue && `${s.repo}#${s.issue}`].filter(Boolean)) {
		const doc = corpus.refs.get(ref);
		if (doc) add("mentioned", `${ref} is named in ${doc.id}`, doc.source);
	}
	if (corpus.repos.has(s.repo)) add("same repository", `${s.repo} is the source of ${corpus.repos.get(s.repo)}`);

	const mine = shingles(s.text);
	if (mine.size >= NEAR.minShingles) {
		const shared = new Map();
		for (const sh of mine) for (const entry of corpus.index.get(sh) ?? []) if (entry.taskId !== s.id) shared.set(entry, (shared.get(entry) ?? 0) + 1);
		for (const [entry, n] of shared) {
			const containment = n / mine.size;
			const jaccard = n / (mine.size + entry.size - n);
			if (containment >= NEAR.containment || jaccard >= NEAR.jaccard) {
				add("near-duplicate", `${Math.round(100 * containment)}% of its 5-word runs are in ${entry.id}`, entry.source);
			}
		}
	}

	const after = (date, what) => {
		if (!date || Number.isNaN(Date.parse(date))) add("dates", `no ${what} date`);
		else if (!(Date.parse(date) > Date.parse(cutoff))) add("dates", `${what} ${String(date).slice(0, 10)}, not after the cutoff ${cutoff}`);
	};
	after(s.issueCreatedAt, "issue opened");
	after(s.mergedAt, "fix merged");
	if (s.issueCreatedAt && s.mergedAt && Date.parse(s.issueCreatedAt) > Date.parse(s.mergedAt)) add("dates", "the issue opened after the fix merged");
	if (s.minedAt && s.mergedAt && Date.parse(s.minedAt) < Date.parse(s.mergedAt)) add("dates", "mined before the fix merged");
	if (s.minedCutoff && Date.parse(s.minedCutoff) < Date.parse(cutoff)) add("dates", `mined with the earlier cutoff ${s.minedCutoff}`);
	return { id: s.id, clean: hits.length === 0, hits };
}

/** Text files tracked by git in a repository, up to 1 MB each, as corpus documents. */
function trackedFiles(root) {
	let list = [];
	try {
		list = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
	} catch {
		return [];
	}
	const docs = [];
	for (const rel of list) {
		const path = join(root, rel);
		if (!existsSync(path) || statSync(path).size > 1024 * 1024) continue;
		const buf = readFileSync(path);
		if (buf.includes(0)) continue;
		docs.push({ id: `public:${rel}`, source: "this public repository", text: buf.toString("utf8") });
	}
	return docs;
}

/** Tasks in a folder, as documents (request and title) and as seen tasks (their source). */
function taskFolder(dir, source) {
	const docs = [];
	const seen = [];
	const repos = [];
	if (!existsSync(dir)) return { docs, seen, repos };
	for (const id of readdirSync(dir).sort()) {
		const taskPath = join(dir, id, "task.json");
		if (!existsSync(taskPath)) continue;
		const task = JSON.parse(readFileSync(taskPath, "utf8"));
		const requestPath = join(dir, id, "request.md");
		const request = existsSync(requestPath) ? readFileSync(requestPath, "utf8") : "";
		docs.push({ id: `${source}:${id}`, taskId: id, source, text: `${task.title ?? ""}\n${request}` });
		if (task.source?.repo) {
			seen.push({ id, source, ...subjectOf(task), text: undefined });
			if (source !== "exam") repos.push({ repo: task.source.repo, source: `${source} task ${id}` });
		}
	}
	return { docs, seen, repos };
}

/** Candidates from a JSON-lines file; a half-written last line (a miner still appending) is skipped. */
export function readCandidates(path) {
	if (!existsSync(path)) return [];
	const out = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {}
	}
	return out;
}

/** The corpus for a real exam: this repository, its practice tasks, the exam's tasks and every candidate. */
export async function corpusFor({ exam, candidates = [], root = ROOT }) {
	const practice = taskFolder(join(root, "tasks"), "practice");
	const dev = taskFolder(join(root, "dev-tasks"), "practice");
	const held = taskFolder(join(exam, "tasks"), "exam");
	const retired = taskFolder(join(exam, "retired"), "exam");
	const { RULES } = await import("./mine-tasks.mjs");
	return buildCorpus({
		docs: [...trackedFiles(root), ...practice.docs, ...dev.docs, ...held.docs, ...retired.docs],
		seen: [...held.seen, ...retired.seen, ...candidates.map((c) => ({ ...subjectOf(c), source: "an earlier candidate", text: undefined }))],
		repos: [...practice.repos, ...dev.repos, ...RULES.excludeRepos.map((repo) => ({ repo, source: "a public test fixture" }))],
	});
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values } = parseArgs({ options: { exam: { type: "string" }, cutoff: { type: "string" }, candidates: { type: "string" }, json: { type: "boolean", default: false } } });
	if (!values.exam || !values.cutoff) throw new Error("--exam and --cutoff are required");
	const exam = resolve(values.exam);
	const candidates = readCandidates(resolve(values.candidates ?? join(exam, "candidates.jsonl")));
	const corpus = await corpusFor({ exam, candidates });
	const results = candidates.map((c) => scan(c, corpus, { cutoff: values.cutoff }));
	if (values.json) console.log(JSON.stringify(results, null, 2));
	else {
		for (const r of results.filter((x) => !x.clean)) console.log(`${r.id}: ${r.hits.map((h) => `${h.kind}: ${h.detail}`).join("; ")}`);
		console.log(`${results.filter((r) => r.clean).length} of ${results.length} candidates are clean`);
	}
}
