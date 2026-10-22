#!/usr/bin/env node
// Finds candidate exam tasks in public GitHub repositories (TIERS.md, "Fresh"): merged pull requests that fix an issue
// opened after a cutoff date and add or change tests, in small Node or Python projects that fit the benchmark sandbox
// (TASK_FORMAT.md, "Toolchain": no packages from the network). It only reads the GitHub API, with the caller's token
// from GITHUB_TOKEN (or GH_TOKEN); it never writes to GitHub. Each candidate is one JSON line: the repository, the base
// commit, the issue and the pull request, and the files it changed. scripts/draft-task.mjs turns one into a task.
//
//   node scripts/mine-tasks.mjs --cutoff 2026-07-01 --out ../relay-exam/candidates.jsonl \
//     [--until 2026-10-23] [--languages javascript,python] [--limit 50] [--per-repo 2] [--min-stars 10]
//
// The candidates say which public issues the exam is built from, so they are private: --out must be outside this public
// repository. Running it again skips pull requests already in --out and appends the new ones.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = new URL("..", import.meta.url).pathname;

/** What makes a pull request a candidate. Every rule is checked from the API alone; draft-task runs the tests. */
export const RULES = Object.freeze({
	minStars: 10,
	maxRepoKb: 20_000,
	maxFiles: 12,
	maxChangedLines: 400,
	minIssueChars: 80,
	perRepo: 2,
	/** Licenses that let the task's repository be copied into the exam and published after a round. */
	licenses: ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense", "Zlib", "PSF-2.0"],
	/** Repositories whose recorded API responses are public test fixtures here (scripts/fixtures/): anything an improving
	 *  agent can read in this repository can never be an exam task. */
	excludeRepos: ["JamshidS/aiset", "iwyoo/smiles-to-iupac"],
});

/** Text that marks a pull request as written by a coding agent; such fixes would grade one model on another's work. */
const AGENT_MARKS = [
	/generated with \[?claude code/i,
	/co-authored-by:\s*(claude|codex|copilot|cursor|devin|openhands|gemini)/i,
	/\b(codex|devin|openhands|sweep|copilot)[- ]?(agent|bot)\b/i,
	/🤖 generated/i,
];

/** Dependency manifests: a pull request that changes one may need a package from the network. */
const MANIFESTS = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|pyproject\.toml|setup\.py|setup\.cfg|Pipfile(\.lock)?|poetry\.lock|tox\.ini)$/;
const DOCS = /\.(md|rst|txt|adoc)$|(^|\/)(docs?|\.github)\//i;

export const languageOf = (path) =>
	/\.(m|c)?js$/.test(path) ? "javascript" : /\.py$/.test(path) ? "python" : /\.(m|c)?tsx?$/.test(path) ? "typescript" : null;

/** A test file by its path, in the layouts Node and Python projects use. */
export function isTestPath(path) {
	const lang = languageOf(path);
	if (lang === "javascript") return /(^|\/)(test|tests|__tests__|spec)\//.test(path) || /\.(test|spec)\.(m|c)?js$/.test(path);
	if (lang === "python") return /(^|\/)tests?\//.test(path) || /(^|\/)test_[^/]+\.py$/.test(path) || /_test\.py$/.test(path);
	return false;
}

/** The issue numbers a pull request's text closes in its own repository ("Fixes #12", "closes owner/repo#12", a URL). */
export function closingIssues(text, repo) {
	const found = [];
	const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:([\w.-]+\/[\w.-]+)#(\d+)|#(\d+)|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+))/gi;
	for (const m of String(text ?? "").matchAll(pattern)) {
		const target = (m[1] ?? m[4] ?? repo).toLowerCase();
		const number = Number(m[2] ?? m[3] ?? m[5]);
		if (target === repo.toLowerCase() && !found.includes(number)) found.push(number);
	}
	return found;
}

const PY_STDLIB = new Set(
	(
		"__future__ _thread abc argparse array ast asynchat asyncio asyncore atexit base64 bdb binascii bisect builtins bz2 " +
		"calendar cgi cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib " +
		"contextvars copy copyreg cProfile csv ctypes curses dataclasses datetime dbm decimal difflib dis doctest email " +
		"encodings enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass " +
		"gettext glob graphlib grp gzip hashlib heapq hmac html http imaplib importlib inspect io ipaddress itertools json " +
		"keyword linecache locale logging lzma mailbox marshal math mimetypes mmap multiprocessing netrc numbers operator " +
		"optparse os pathlib pdb pickle pkgutil platform plistlib poplib posixpath pprint profile pstats pty pwd py_compile " +
		"pydoc queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex " +
		"shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct subprocess " +
		"symtable sys sysconfig tabnanny tarfile tempfile termios textwrap threading time timeit tkinter token tokenize " +
		"tomllib trace traceback tracemalloc tty types typing unicodedata unittest urllib uuid venv warnings wave weakref " +
		"webbrowser wsgiref xml xmlrpc zipapp zipfile zipimport zlib zoneinfo"
	).split(" "),
);
const NODE_BUILTINS = new Set(builtinModules);

/** Modules a source file imports that are neither the standard library, relative, nor the repository's own. */
export function externalImports(source, language, ownModules = []) {
	const own = new Set(ownModules);
	const names = new Set();
	if (language === "javascript") {
		const pattern = /(?:require\(\s*|import\s*\(\s*|from\s+|import\s+)["']([^"'\s]+)["']/g;
		for (const m of source.matchAll(pattern)) {
			const spec = m[1];
			if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || spec.startsWith("#")) continue;
			const base = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
			if (!NODE_BUILTINS.has(base) && !own.has(base)) names.add(base);
		}
	} else if (language === "python") {
		for (const line of source.split("\n")) {
			const m = /^\s*(?:from\s+([\w.]+)\s+import\b|import\s+([\w.]+(?:\s*,\s*[\w.]+)*))/.exec(line);
			if (!m) continue;
			for (const mod of (m[1] ?? m[2]).split(",").map((s) => s.trim())) {
				const top = mod.split(".")[0];
				if (!top || mod.startsWith(".") || PY_STDLIB.has(top) || own.has(top)) continue;
				names.add(top);
			}
		}
	}
	return [...names].sort();
}

/** The repository's own importable names, from its file list: for Python every package and every module (test helpers
 *  next to a test file are imported by their bare name), and the test folders. */
export function ownModules(paths, language) {
	const own = new Set(["tests", "test"]);
	if (language === "python") {
		for (const path of paths) {
			const parts = path.split("/");
			const name = parts[parts.length - 1];
			if (name.endsWith(".py")) own.add(name === "__init__.py" ? parts[parts.length - 2] : name.slice(0, -3));
		}
	}
	return [...own].filter(Boolean);
}

/** Why a base commit's Node manifest needs packages from the network; empty when it fits the sandbox. */
export function nodeManifestProblems(pkg) {
	const problems = [];
	for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
		if (pkg[field] && Object.keys(pkg[field]).length) problems.push(`package.json has ${field}`);
	}
	if (!pkg.scripts?.test || /no test specified/.test(pkg.scripts.test)) problems.push("package.json has no test script");
	return problems;
}

/** Why a base commit's Python manifests need packages from the network; empty when it fits the sandbox. */
export function pythonManifestProblems(files) {
	const problems = [];
	for (const [path, text] of Object.entries(files)) {
		if (/requirements[^/]*\.txt$/.test(path)) {
			const real = text.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);
			if (real.length) problems.push(`${path} lists packages`);
		} else if (path.endsWith("pyproject.toml")) {
			const deps = /^\s*dependencies\s*=\s*\[([^\]]*)\]/m.exec(text);
			if (deps && deps[1].replace(/#.*$/gm, "").trim()) problems.push("pyproject.toml lists dependencies");
			const poetry = /\[tool\.poetry\.(?:dev-)?dependencies\]([^[]*)/.exec(text);
			if (poetry && poetry[1].split("\n").some((l) => /^\s*[\w-]+\s*=/.test(l) && !/^\s*python\s*=/.test(l))) {
				problems.push("pyproject.toml lists poetry dependencies");
			}
		} else if (path.endsWith("setup.py") || path.endsWith("setup.cfg")) {
			if (/install_requires\s*=\s*\[\s*["']/.test(text) || /install_requires\s*=\s*\n\s+\S/.test(text)) problems.push(`${path} lists install_requires`);
		} else if (/Pipfile$/.test(path) && /\[packages\]\s*\n\s*[\w-]+\s*=/.test(text)) {
			problems.push("Pipfile lists packages");
		}
	}
	return problems;
}

/** Why a test file cannot run in the sandbox with the standard runner of its language; empty when it can. */
export function testFileProblems(path, source, language, own) {
	const problems = [];
	const external = externalImports(source, language, own);
	if (external.length) problems.push(`${path} imports ${external.join(", ")}`);
	if (language === "python" && !/\bunittest\b/.test(source)) problems.push(`${path} is not a unittest file`);
	return problems;
}

/** Why a repository cannot hold an exam task, from its own record; empty when it can. */
export function repoProblems(repo, rules = RULES) {
	if (!repo) return ["repository not found"];
	const reasons = [];
	if ((rules.excludeRepos ?? []).some((r) => r.toLowerCase() === repo.full_name?.toLowerCase())) reasons.push("repository is a public test fixture here");
	const language = repo.language?.toLowerCase();
	if (repo.private) reasons.push("repository is private");
	if (repo.fork) reasons.push("repository is a fork");
	if (repo.archived) reasons.push("repository is archived");
	if (!["javascript", "python"].includes(language)) reasons.push(`repository language is ${repo.language}`);
	if ((repo.stargazers_count ?? 0) < rules.minStars) reasons.push(`repository has ${repo.stargazers_count ?? 0} stars`);
	if ((repo.size ?? 0) > rules.maxRepoKb) reasons.push(`repository is ${repo.size} KB`);
	if (!rules.licenses.includes(repo.license?.spdx_id)) reasons.push(`license is ${repo.license?.spdx_id ?? "none"}`);
	return reasons;
}

const isBot = (user) => user?.type === "Bot" || /\[bot\]$/.test(user?.login ?? "");

/**
 * The decision for one pull request, from what the API returned for it: { ok, reasons, candidate }. `got` holds
 * { item, repo, pr, files, issue, tree, manifests, tests } (manifests and tests map a path to its text).
 */
export function evaluate(got, { cutoff, rules = RULES, now = new Date() }) {
	const { repo, pr, files = [], issue, tree = [], manifests = {}, tests = {} } = got;
	const language = repo?.language?.toLowerCase();
	const reasons = repoProblems(repo, rules);
	if (!pr?.merged_at) reasons.push("pull request is not merged");
	if (isBot(pr?.user)) reasons.push("pull request is by a bot");
	if (AGENT_MARKS.some((mark) => mark.test(`${pr?.body ?? ""}\n${pr?.title ?? ""}`))) reasons.push("pull request was written by a coding agent");
	if (!issue) reasons.push("no closing issue in the same repository");
	else {
		if (issue.pull_request) reasons.push("the closed number is a pull request");
		if (!(Date.parse(issue.created_at) > Date.parse(cutoff))) reasons.push(`issue opened ${issue.created_at?.slice(0, 10)}, before the cutoff`);
		if (pr?.merged_at && Date.parse(issue.created_at) > Date.parse(pr.merged_at)) reasons.push("issue opened after the merge");
		if (isBot(issue.user)) reasons.push("issue is by a bot");
		if ((issue.body ?? "").trim().length < rules.minIssueChars) reasons.push("issue has too little text to write a request from");
	}
	const changed = files.filter((f) => f.status !== "removed");
	const testFiles = changed.filter((f) => isTestPath(f.filename) && languageOf(f.filename) === language);
	const sourceFiles = files.filter((f) => !isTestPath(f.filename) && languageOf(f.filename) === language);
	const other = files.filter((f) => !testFiles.includes(f) && !sourceFiles.includes(f));
	if (files.length > rules.maxFiles) reasons.push(`pull request changes ${files.length} files`);
	const changedLines = files.reduce((s, f) => s + (f.additions ?? 0) + (f.deletions ?? 0), 0);
	if (changedLines > rules.maxChangedLines) reasons.push(`pull request changes ${changedLines} lines`);
	if (!testFiles.length) reasons.push("pull request adds or changes no test file");
	if (!sourceFiles.length) reasons.push("pull request changes no source file");
	for (const f of other) {
		if (MANIFESTS.test(f.filename)) reasons.push(`pull request changes ${f.filename}`);
		else if (!DOCS.test(f.filename)) reasons.push(`pull request changes ${f.filename}, which is not ${language} or documentation`);
	}
	if (files.some((f) => f.status !== "removed" && f.patch === undefined && languageOf(f.filename))) reasons.push("a changed file has no text diff");
	const paths = tree.filter((t) => t.type === "blob").map((t) => t.path);
	if (paths.some((p) => languageOf(p) === "typescript" && !p.endsWith(".d.ts"))) reasons.push("repository has TypeScript sources");
	if (language === "javascript") {
		if (!manifests["package.json"]) reasons.push("repository has no package.json at its root");
		else {
			try {
				reasons.push(...nodeManifestProblems(JSON.parse(manifests["package.json"])));
			} catch {
				reasons.push("package.json is not JSON");
			}
		}
	}
	if (language === "python") reasons.push(...pythonManifestProblems(manifests));
	const own = ownModules(paths, language);
	if (language === "javascript") {
		try {
			own.push(JSON.parse(manifests["package.json"]).name);
		} catch {}
	}
	for (const f of testFiles) {
		if (tests[f.filename] === undefined) reasons.push(`${f.filename} could not be read`);
		else reasons.push(...testFileProblems(f.filename, tests[f.filename], language, own));
	}
	if (reasons.length) return { ok: false, reasons };
	const name = repo.full_name;
	return {
		ok: true,
		reasons: [],
		candidate: {
			id: `${name.replace("/", "-")}-${pr.number}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
			repo: name,
			repoUrl: repo.html_url,
			cloneUrl: repo.clone_url,
			license: repo.license.spdx_id,
			stars: repo.stargazers_count,
			language,
			baseCommit: pr.base.sha,
			headCommit: pr.head.sha,
			mergeCommit: pr.merge_commit_sha,
			pr: { number: pr.number, url: pr.html_url, title: pr.title, mergedAt: pr.merged_at, author: pr.user?.login },
			issue: { number: issue.number, url: issue.html_url, title: issue.title, createdAt: issue.created_at, author: issue.user?.login },
			files: { tests: testFiles.map((f) => f.filename), source: sourceFiles.map((f) => f.filename), other: other.map((f) => f.filename) },
			changedLines,
			cutoff,
			minedAt: now.toISOString(),
		},
	};
}

/** Weekly windows from the cutoff to `until`, newest first, so each search stays under GitHub's 1,000-result limit. */
export function windows(cutoff, until, days = 7) {
	const out = [];
	const end = Date.parse(until);
	for (let start = Date.parse(cutoff); start < end; start += days * 86_400_000) {
		const to = Math.min(start + days * 86_400_000 - 86_400_000, end);
		out.push([new Date(start).toISOString().slice(0, 10), new Date(to).toISOString().slice(0, 10)]);
	}
	return out.reverse();
}

export const searchQuery = (language, [from, to]) =>
	`is:pr is:merged linked:issue archived:false language:${language} merged:${from}..${to}`;

/** A read-only GitHub client: GET only, paced for the search limit, waiting out rate limits. */
export function githubClient({ token, fetch: doFetch = globalThis.fetch, baseUrl = "https://api.github.com", sleep } = {}) {
	const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	let lastSearch = 0;
	return {
		async get(path, { accept = "application/vnd.github+json" } = {}) {
			if (path.startsWith("/search/")) {
				const gap = Date.now() - lastSearch;
				if (gap < 2_100) await wait(2_100 - gap);
				lastSearch = Date.now();
			}
			for (let attempt = 0; attempt < 4; attempt++) {
				const res = await doFetch(`${baseUrl}${path}`, {
					method: "GET",
					headers: { accept, "x-github-api-version": "2022-11-28", "user-agent": "relay-bench-mine-tasks", ...(token ? { authorization: `Bearer ${token}` } : {}) },
				});
				if ((res.status === 403 || res.status === 429) && attempt < 3) {
					const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
					const retry = Number(res.headers.get("retry-after") ?? 0) * 1000;
					await wait(Math.min(Math.max(retry, reset - Date.now(), 5_000), 15 * 60_000));
					continue;
				}
				if (res.status === 404) return null;
				if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
				return accept.includes("json") ? res.json() : res.text();
			}
			throw new Error(`GitHub kept refusing ${path}`);
		},
	};
}

const decode = (content) => (content?.encoding === "base64" ? Buffer.from(content.content, "base64").toString("utf8") : undefined);

/** Everything evaluate() needs for one search result, read from the API. */
export async function gather(client, item, rules = RULES) {
	const repoName = item.repository_url.split("/repos/")[1];
	const got = { item };
	got.repo = await client.get(`/repos/${repoName}`);
	// Most pull requests fail on their repository alone; stop there and save the rate limit.
	if (repoProblems(got.repo, rules).length) return got;
	got.pr = await client.get(`/repos/${repoName}/pulls/${item.number}`);
	if (!got.pr) return got;
	const numbers = closingIssues(`${got.pr.title}\n${got.pr.body ?? ""}`, repoName);
	if (numbers.length) got.issue = await client.get(`/repos/${repoName}/issues/${numbers[0]}`);
	got.files = (await client.get(`/repos/${repoName}/pulls/${item.number}/files?per_page=100`)) ?? [];
	const tree = await client.get(`/repos/${repoName}/git/trees/${got.pr.base.sha}?recursive=1`);
	got.tree = tree?.tree ?? [];
	got.manifests = {};
	for (const entry of got.tree) {
		if (entry.type === "blob" && MANIFESTS.test(entry.path) && !entry.path.includes("/") && !/lock/.test(entry.path)) {
			const text = decode(await client.get(`/repos/${repoName}/contents/${entry.path}?ref=${got.pr.base.sha}`));
			if (text !== undefined) got.manifests[entry.path] = text;
		}
	}
	got.tests = {};
	const language = got.repo.language?.toLowerCase();
	for (const f of got.files) {
		if (f.status === "removed" || !isTestPath(f.filename) || languageOf(f.filename) !== language) continue;
		const text = decode(await client.get(`/repos/${repoName}/contents/${encodeURI(f.filename)}?ref=${got.pr.merge_commit_sha ?? got.pr.head.sha}`));
		if (text !== undefined) got.tests[f.filename] = text;
	}
	return got;
}

/**
 * Searches window by window and yields { ok, reasons, candidate, item } for each pull request it looks at, until
 * `limit` candidates are found. Cheap checks on the search result come first, so most pull requests cost one request.
 */
export async function* mine(client, { cutoff, until, languages, limit, seen = new Set(), perRepo = RULES.perRepo, rules = RULES, now }) {
	const perRepoCount = new Map();
	for (const key of seen) {
		const repo = key.split("#")[0];
		perRepoCount.set(repo, (perRepoCount.get(repo) ?? 0) + 1);
	}
	let found = 0;
	for (const window of windows(cutoff, until)) {
		for (const language of languages) {
			for (let page = 1; page <= 10; page++) {
				const q = encodeURIComponent(searchQuery(language, window));
				const result = await client.get(`/search/issues?q=${q}&sort=created&order=desc&per_page=100&page=${page}`);
				const items = result?.items ?? [];
				for (const item of items) {
					const repoName = item.repository_url.split("/repos/")[1];
					const key = `${repoName}#${item.number}`;
					if (seen.has(key)) continue;
					seen.add(key);
					if ((perRepoCount.get(repoName) ?? 0) >= perRepo) continue;
					if (isBot(item.user) || AGENT_MARKS.some((mark) => mark.test(item.body ?? ""))) {
						yield { ok: false, reasons: ["pull request is by a bot or a coding agent"], item };
						continue;
					}
					if (!closingIssues(`${item.title}\n${item.body ?? ""}`, repoName).length) {
						yield { ok: false, reasons: ["no closing issue in the same repository"], item };
						continue;
					}
					const decision = evaluate(await gather(client, item, rules), { cutoff, rules, now });
					yield { ...decision, item };
					if (decision.ok) {
						perRepoCount.set(repoName, (perRepoCount.get(repoName) ?? 0) + 1);
						if (++found >= limit) return;
					}
				}
				if (items.length < 100) break;
			}
		}
	}
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values } = parseArgs({
		options: {
			cutoff: { type: "string" },
			until: { type: "string", default: new Date().toISOString().slice(0, 10) },
			languages: { type: "string", default: "javascript,python" },
			limit: { type: "string", default: "50" },
			"per-repo": { type: "string", default: String(RULES.perRepo) },
			"min-stars": { type: "string", default: String(RULES.minStars) },
			out: { type: "string" },
			verbose: { type: "boolean", default: false },
		},
	});
	if (!values.cutoff || Number.isNaN(Date.parse(values.cutoff))) throw new Error("--cutoff <YYYY-MM-DD> is required: issues must be opened after it");
	if (!values.out) throw new Error("--out is required, a file outside this repository, such as ../relay-exam/candidates.jsonl");
	const out = resolve(values.out);
	const inside = relative(ROOT, out);
	if (!inside.startsWith("..") && !isAbsolute(inside)) throw new Error(`the candidates are private; ${out} is inside this public repository`);
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	if (!token) throw new Error("GITHUB_TOKEN (or GH_TOKEN) is not set; a token with read access to public repositories is enough");
	const seen = new Set(
		existsSync(out)
			? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((c) => `${c.repo}#${c.pr.number}`)
			: [],
	);
	const rules = { ...RULES, minStars: Number(values["min-stars"]) };
	let looked = 0;
	let kept = 0;
	for await (const result of mine(githubClient({ token }), {
		cutoff: values.cutoff,
		until: values.until,
		languages: values.languages.split(","),
		limit: Number(values.limit),
		perRepo: Number(values["per-repo"]),
		seen,
		rules,
	})) {
		looked++;
		if (result.ok) {
			kept++;
			appendFileSync(out, `${JSON.stringify(result.candidate)}\n`);
			console.log(`candidate ${result.candidate.id}: ${result.candidate.issue.url}`);
		} else if (values.verbose) {
			console.log(`skip ${result.item.html_url}: ${result.reasons.join("; ")}`);
		}
	}
	console.log(`looked at ${looked} pull requests, kept ${kept}; candidates in ${out}`);
}
