// scripts/publish-scoreboard.mjs: the week's scoreboard into a public repository and one pull request there, against
// a throwaway repository and a fake `gh`. Nothing reaches GitHub.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describePublish, publishScoreboard, pullRequestBody } from "./publish-scoreboard.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
// The public repository beside this one (or RELAY_PUBLIC_DIR), for the test of its real render.mjs; skipped without it.
const REAL_RENDER = join(process.env.RELAY_PUBLIC_DIR ?? join(ROOT, "..", "relay-public"), "benchmarks", "scoreboard", "render.mjs");

const git = (cwd, ...args) => {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" } });
	assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
};

/** A small stand-in for the public repository's render.mjs: the page from the file, and the same --check. */
const FAKE_RENDER = `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const here = new URL(".", import.meta.url).pathname;
const text = readFileSync(join(here, "scoreboard.json"), "utf8");
const board = JSON.parse(text);
const page = "# Scoreboard\\n\\nWeek " + board.week + ".\\n";
if (process.argv.includes("--check")) {
	let current = "";
	try { current = readFileSync(join(here, "README.md"), "utf8"); } catch {}
	const problems = [];
	if (current !== page) problems.push("README.md is not the rendering of scoreboard.json");
	const word = text.match(/\\b(better|worse|beats?|wins?|best)\\b/i);
	if (word) problems.push('scoreboard.json has a word for a result: "' + word[0] + '"');
	for (const p of problems) console.error(p);
	process.exit(problems.length ? 1 : 0);
}
writeFileSync(join(here, "README.md"), page);
`;

/**
 * An origin (bare) and the person's checkout of it, with benchmarks/scoreboard/ holding `render` and week 2026-W43's
 * file and page; and a fake gh that logs its arguments and answers `pr list` with `open` and `pr create` with a URL.
 */
function fixture({ render = FAKE_RENDER, open = [] } = {}) {
	const root = mkdtempSync(join(tmpdir(), "publish-"));
	const origin = join(root, "origin.git");
	git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
	const checkout = join(root, "relay-public");
	git(root, "clone", "--quiet", origin, checkout);
	git(checkout, "config", "user.name", "Test Person");
	git(checkout, "config", "user.email", "person@example.com");
	const page = join(checkout, "benchmarks", "scoreboard");
	mkdirSync(page, { recursive: true });
	writeFileSync(join(page, "render.mjs"), render);
	writeFileSync(join(page, "scoreboard.json"), `${JSON.stringify(board("2026-W43"), null, 2)}\n`);
	spawnSync(process.execPath, [join(page, "render.mjs")], { cwd: checkout });
	git(checkout, "add", ".");
	git(checkout, "commit", "--quiet", "-m", "start");
	git(checkout, "push", "--quiet", "origin", "HEAD:main");
	const ghLog = join(root, "gh.log");
	const gh = join(root, "gh");
	writeFileSync(
		gh,
		`#!${process.execPath}
const { appendFileSync } = require("node:fs");
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(argv) + "\\n");
if (argv[0] === "pr" && argv[1] === "list") { console.log(${JSON.stringify(JSON.stringify(open))}); process.exit(0); }
if (argv[0] === "pr" && argv[1] === "create") { console.log("https://github.com/Relay-harness/relay/pull/7"); process.exit(0); }
process.exit(2);
`,
	);
	chmodSync(gh, 0o755);
	return { root, origin, checkout, gh, ghCalls: () => (existsSync(ghLog) ? readFileSync(ghLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
}

function board(week, extra = {}) {
	return {
		scoreboard: 1,
		week,
		repository: "https://github.com/cicada0007/relay-bench",
		commit: "abcdef1234567890",
		benchmarks: [
			{ id: "terminal-bench-2-1", title: "Terminal-Bench 2.1", runs: [{ label: "Round 1, test F", modelName: "Claude Haiku 5.5", status: "complete", entries: [{ name: "Relay 0.6.118", score: 71.8, low: 63.2, high: 80.5 }, { name: "Relay meta-harness", score: 86.2, low: 79.3, high: 92 }] }] },
			{ id: "swebench-verified", title: "SWE-bench Verified", runs: [] },
		],
		...extra,
	};
}

const writeBoard = (root, b) => {
	const path = join(root, `scoreboard-${b.week}.json`);
	writeFileSync(path, `${JSON.stringify(b, null, 2)}\n`);
	return path;
};

/** The person's checkout is as it was: same commit, clean, no branch or worktree added. */
function assertUntouched(checkout, head) {
	assert.equal(git(checkout, "rev-parse", "HEAD"), head);
	assert.equal(git(checkout, "status", "--porcelain"), "");
	assert.deepEqual(git(checkout, "branch", "--format=%(refname:short)").split("\n"), ["main"]);
	assert.equal(git(checkout, "worktree", "list").split("\n").length, 1);
}

test("the week's file is copied, rendered and checked in a worktree, pushed to its own branch, and one pull request opened", () => {
	const f = fixture();
	const head = git(f.checkout, "rev-parse", "HEAD");
	const from = writeBoard(f.root, board("2026-W44"));
	const r = publishScoreboard({ from, publicDir: f.checkout, gh: f.gh, work: f.root });
	assert.equal(r.status, "opened", r.why);
	assert.equal(r.url, "https://github.com/Relay-harness/relay/pull/7");
	assert.equal(r.branch, "scoreboard/2026-W44");
	assert.match(describePublish(r), /opened https:\/\/github\.com\/Relay-harness\/relay\/pull\/7/);
	// What landed on the branch: the file, byte for byte, and its rendering.
	const show = (path) => git(f.origin, "show", `scoreboard/2026-W44:${path}`);
	assert.equal(`${show("benchmarks/scoreboard/scoreboard.json")}\n`, readFileSync(from, "utf8"));
	assert.equal(show("benchmarks/scoreboard/README.md"), "# Scoreboard\n\nWeek 2026-W44.");
	assert.match(git(f.origin, "log", "-1", "--format=%s%n%b", "scoreboard/2026-W44"), /^Scoreboard: week 2026-W44\nFrom cicada0007\/relay-bench at abcdef1234567890/);
	assert.equal(git(f.origin, "rev-parse", "main"), head, "main is never pushed");
	const calls = f.ghCalls();
	assert.deepEqual(calls.map((c) => c.slice(0, 2)), [["pr", "list"], ["pr", "create"]]);
	for (const c of calls) assert.equal(c[c.indexOf("--repo") + 1], "Relay-harness/relay", "gh always names the repository");
	const create = calls[1];
	assert.equal(create[create.indexOf("--base") + 1], "main");
	assert.equal(create[create.indexOf("--head") + 1], "scoreboard/2026-W44");
	assert.match(create[create.indexOf("--body") + 1], /render\.mjs --check` passed/);
	assertUntouched(f.checkout, head);
});

test("a second run in the same week adds to the open pull request; the same file again publishes nothing", () => {
	const f = fixture({ open: [{ number: 7, url: "https://github.com/Relay-harness/relay/pull/7" }] });
	const head = git(f.checkout, "rev-parse", "HEAD");
	const first = publishScoreboard({ from: writeBoard(f.root, board("2026-W44")), publicDir: f.checkout, gh: f.gh, work: f.root });
	assert.equal(first.status, "updated");
	const again = publishScoreboard({ from: writeBoard(f.root, board("2026-W44", { commit: "fedcba0987654321" })), publicDir: f.checkout, gh: f.gh, work: f.root });
	assert.equal(again.status, "updated");
	assert.equal(git(f.origin, "rev-parse", `${again.commit}^`), first.commit, "built on the week's branch, not pushed over it");
	assert.equal(f.ghCalls().filter((c) => c[1] === "create").length, 0, "no second pull request");
	const same = publishScoreboard({ from: writeBoard(f.root, board("2026-W44", { commit: "fedcba0987654321" })), publicDir: f.checkout, gh: f.gh, work: f.root });
	assert.equal(same.status, "unchanged");
	assertUntouched(f.checkout, head);
});

test("a file with a word for a result is refused before anything is pushed, and a dry run pushes nothing", () => {
	const f = fixture();
	const head = git(f.checkout, "rev-parse", "HEAD");
	const worded = board("2026-W44", { note: "Relay did better" });
	const r = publishScoreboard({ from: writeBoard(f.root, worded), publicDir: f.checkout, gh: f.gh, work: f.root });
	assert.equal(r.status, "refused");
	assert.match(r.why, /the page's check failed, so nothing was pushed: .*word for a result: "better"/);
	assert.equal(f.ghCalls().length, 0);
	assert.equal(git(f.origin, "ls-remote", "--heads", f.origin, "scoreboard/2026-W44"), "");
	const dry = publishScoreboard({ from: writeBoard(f.root, board("2026-W45")), publicDir: f.checkout, gh: f.gh, work: f.root, dryRun: true });
	assert.equal(dry.status, "dry run");
	assert.match(dry.why, /would push [0-9a-f]{7} to scoreboard\/2026-W45 and open a pull request in Relay-harness\/relay/);
	assert.equal(git(f.origin, "ls-remote", "--heads", f.origin, "scoreboard/2026-W45"), "");
	assert.equal(f.ghCalls().filter((c) => c[1] === "create").length, 0);
	assertUntouched(f.checkout, head);
	assert.equal(publishScoreboard({ from: join(f.root, "none.json"), publicDir: f.checkout, gh: f.gh }).status, "refused");
	assert.match(publishScoreboard({ from: writeBoard(f.root, board("2026-W46")), publicDir: f.root, gh: f.gh }).why, /is not a checkout of Relay-harness\/relay/);
});

test("this repository's scoreboard file passes the public page's own render.mjs and its check", { skip: !existsSync(REAL_RENDER) && "the public repository is not beside this one" }, () => {
	const f = fixture({ render: readFileSync(REAL_RENDER, "utf8") });
	const from = join(f.root, "scoreboard.json");
	const ours = JSON.parse(readFileSync(join(ROOT, "results", "scoreboard.json"), "utf8"));
	copyFileSync(join(ROOT, "results", "scoreboard.json"), from);
	const r = publishScoreboard({ from, publicDir: f.checkout, gh: f.gh, work: f.root, dryRun: true });
	assert.equal(r.status, "dry run", r.why);
	assert.match(r.body, new RegExp(`week ${ours.week}`));
	assert.doesNotMatch(pullRequestBody(ours, { checked: true }), /\b(better|worse|beats?|wins?|won|lost|best|worst)\b/i);
});
