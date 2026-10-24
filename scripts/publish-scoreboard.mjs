#!/usr/bin/env node
// The public scoreboard page, updated from the week's file: results/scoreboard.json copied into the public repository
// Relay-harness/relay (benchmarks/scoreboard/), its page rendered there by that repository's own render.mjs, its check
// run (the page is the file's rendering, and neither holds a word for a result), then one pull request opened there for
// a person to merge. Nothing is merged or published by this script.
//
// - The person's checkout of the public repository is read, never changed: the work happens in a detached worktree of
//   it, made from origin/main (or from this week's branch on origin, when an earlier run this week pushed one), and
//   removed after. The branch is scoreboard/<week>; a second run in the same week adds a commit to it, and opens no
//   second pull request while one is open.
// - It stops, pushing nothing, when the check fails, and when the page already shows this file (nothing changed).
// - `gh` always with --repo Relay-harness/relay. --dry-run does everything but the push and the pull request.
//
//   node scripts/publish-scoreboard.mjs [--from results/scoreboard.json] [--public ../relay-public] [--dry-run]
//   node scripts/scoreboard.mjs --publish        the weekly job: build the scoreboard, then this (off unless given)
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = new URL("..", import.meta.url).pathname;
export const PUBLIC_REPO = "Relay-harness/relay";
export const PUBLIC_DIR = resolve(ROOT, "..", "relay-public");
export const PAGE_DIR = "benchmarks/scoreboard";

/** Runs a command; returns { status, stdout, stderr }. */
export function sh(cmd, args, { cwd, env = process.env } = {}) {
	const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return { status: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error.message) : "") };
}

const pct = (v) => (v === null || v === undefined ? "–" : `${v.toFixed(1)}%`);
const interval = (e) => (e.low === null || e.low === undefined ? "" : ` (95% interval ${pct(e.low)} to ${pct(e.high)})`);

/** The pull request's body: what it holds, numbers only. */
export function pullRequestBody(board, { checked }) {
	const lines = [
		`The scoreboard for week ${board.week}, from [cicada0007/relay-bench](${board.repository})${board.commit ? ` at \`${board.commit.slice(0, 7)}\`` : ""}: \`${PAGE_DIR}/scoreboard.json\`, and \`${PAGE_DIR}/README.md\` rendered from it by \`${PAGE_DIR}/render.mjs\`.`,
		"",
		`\`node ${PAGE_DIR}/render.mjs --check\` ${checked ? "passed" : "was not run"}: the page is the file's rendering, and neither holds a word for a result.`,
		"",
	];
	for (const b of board.benchmarks ?? []) {
		if (!b.runs?.length) {
			lines.push(`- ${b.title}: not run yet`);
			continue;
		}
		for (const run of b.runs) lines.push(`- ${b.title}, ${run.label}, ${run.modelName} (${run.status}): ${run.entries.map((e) => `${e.name} ${pct(e.score)}${interval(e)}`).join("; ")}`);
	}
	lines.push("", "Opened by `scripts/publish-scoreboard.mjs`; a person reviews and merges it.");
	return lines.join("\n");
}

/**
 * Publishes `from` (a scoreboard file) to the public repository at `publicDir` through a pull request in `repo`.
 * `git`, `gh` and `node` name the commands (tests pass fakes); `log` gets one line per step. Returns { status, ... }:
 * "opened" (with url), "updated" (an open pull request got the new commit), "unchanged", "dry run", or "refused" (with
 * why: nothing was pushed).
 */
export function publishScoreboard({ from = join(ROOT, "results", "scoreboard.json"), publicDir = PUBLIC_DIR, repo = PUBLIC_REPO, base = "main", git = "git", gh = "gh", node = process.execPath, env = process.env, dryRun = false, work = tmpdir(), log = () => {} }) {
	if (!existsSync(from)) return { status: "refused", why: `no scoreboard file at ${from}` };
	const board = JSON.parse(readFileSync(from, "utf8"));
	if (!/^\d{4}-W\d{2}$/.test(board.week ?? "")) return { status: "refused", why: `${from} names no ISO week` };
	if (!existsSync(join(publicDir, ".git"))) return { status: "refused", why: `${publicDir} is not a checkout of ${repo}` };
	const branch = `scoreboard/${board.week}`;
	const g = (args, cwd = publicDir) => sh(git, args, { cwd, env });
	const fail = (step, r) => ({ status: "refused", why: `${step} failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}` });

	const fetched = g(["fetch", "--quiet", "origin", base]);
	if (fetched.status !== 0) return fail(`git fetch origin ${base}`, fetched);
	const remote = g(["ls-remote", "--heads", "origin", branch]);
	if (remote.status !== 0) return fail("git ls-remote", remote);
	const onRemote = remote.stdout.trim() !== "";
	if (onRemote) {
		const f = g(["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
		if (f.status !== 0) return fail(`git fetch origin ${branch}`, f);
	}
	const start = onRemote ? `origin/${branch}` : `origin/${base}`;
	const wt = join(mkdtempSync(join(work, "relay-scoreboard-")), "relay-public");
	const added = g(["worktree", "add", "--quiet", "--detach", wt, start]);
	if (added.status !== 0) return fail("git worktree add", added);
	log(`worktree of ${publicDir} at ${start}: ${wt}`);
	try {
		const page = join(wt, PAGE_DIR);
		if (!existsSync(join(page, "render.mjs"))) return { status: "refused", why: `${PAGE_DIR}/render.mjs is not in ${repo} at ${start}` };
		copyFileSync(from, join(page, "scoreboard.json"));
		const rendered = sh(node, [join(page, "render.mjs")], { cwd: wt, env });
		if (rendered.status !== 0) return fail("render.mjs", rendered);
		const checked = sh(node, [join(page, "render.mjs"), "--check"], { cwd: wt, env });
		if (checked.status !== 0) return { status: "refused", why: `the page's check failed, so nothing was pushed: ${(checked.stderr || checked.stdout).trim().split("\n").join("; ")}` };
		log("rendered the page; its check passed");
		const changed = g(["status", "--porcelain", "--", PAGE_DIR], wt);
		if (changed.stdout.trim() === "") return { status: "unchanged", why: `the public page at ${start} already shows week ${board.week} as this file has it`, branch };
		const add = g(["add", "--", `${PAGE_DIR}/scoreboard.json`, `${PAGE_DIR}/README.md`], wt);
		if (add.status !== 0) return fail("git add", add);
		const message = `Scoreboard: week ${board.week}\n\nFrom cicada0007/relay-bench${board.commit ? ` at ${board.commit}` : ""}, rendered by ${PAGE_DIR}/render.mjs.`;
		const commit = g(["commit", "--quiet", "-m", message], wt);
		if (commit.status !== 0) return fail("git commit", commit);
		const head = g(["rev-parse", "HEAD"], wt).stdout.trim();
		const open = sh(gh, ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url"], { env });
		if (open.status !== 0) return fail("gh pr list", open);
		const existing = JSON.parse(open.stdout.trim() || "[]")[0] ?? null;
		if (dryRun) return { status: "dry run", branch, commit: head, existing, body: pullRequestBody(board, { checked: true }), why: `would push ${head.slice(0, 7)} to ${branch} and ${existing ? `update pull request #${existing.number}` : `open a pull request in ${repo}`}` };
		const pushed = g(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], wt);
		if (pushed.status !== 0) return fail(`git push origin ${branch}`, pushed);
		log(`pushed ${head.slice(0, 7)} to ${branch}`);
		if (existing) return { status: "updated", branch, commit: head, url: existing.url, number: existing.number };
		const created = sh(gh, ["pr", "create", "--repo", repo, "--base", base, "--head", branch, "--title", `Scoreboard: week ${board.week}`, "--body", pullRequestBody(board, { checked: true })], { env });
		if (created.status !== 0) return fail("gh pr create", created);
		const url = created.stdout.trim().split("\n").filter(Boolean).pop() ?? null;
		return { status: "opened", branch, commit: head, url };
	} finally {
		g(["worktree", "remove", "--force", wt]);
		rmSync(join(wt, ".."), { recursive: true, force: true });
		g(["worktree", "prune"]);
	}
}

/** One plain sentence for a person. */
export function describePublish(r) {
	switch (r.status) {
		case "opened":
			return `opened ${r.url} (branch ${r.branch}); a person reviews and merges it`;
		case "updated":
			return `added the new page to pull request #${r.number} (${r.url})`;
		case "unchanged":
			return `nothing to publish: ${r.why}`;
		case "dry run":
			return `dry run: ${r.why}`;
		default:
			return `not published: ${r.why}`;
	}
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values: args } = parseArgs({
		options: {
			from: { type: "string", default: join(ROOT, "results", "scoreboard.json") },
			public: { type: "string", default: PUBLIC_DIR },
			"dry-run": { type: "boolean", default: false },
		},
	});
	const r = publishScoreboard({ from: resolve(args.from), publicDir: resolve(args.public), dryRun: args["dry-run"], log: (l) => console.log(l) });
	console.log(describePublish(r));
	process.exitCode = r.status === "refused" ? 1 : 0;
}
