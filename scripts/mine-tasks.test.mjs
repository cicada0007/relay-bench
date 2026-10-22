// The miner's selection logic on recorded GitHub API responses (scripts/fixtures/mine-tasks-github.json, read-only,
// trimmed), and on small changes to them. No network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	closingIssues,
	evaluate,
	externalImports,
	gather,
	githubClient,
	isTestPath,
	mine,
	nodeManifestProblems,
	pythonManifestProblems,
	RULES,
	searchQuery,
	windows,
} from "./mine-tasks.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/mine-tasks-github.json", import.meta.url), "utf8"));
const AISET = fixture.searchItems.find((i) => i.repository_url.endsWith("JamshidS/aiset"));
const SMILES = fixture.searchItems.find((i) => i.repository_url.endsWith("iwyoo/smiles-to-iupac"));
const NOW = new Date("2026-10-22T21:00:00Z");
// The recorded repositories are excluded from real mining (their data is public here); the tests lift that one rule.
const OPEN = { ...RULES, excludeRepos: [] };

/** Answers from the recording; the first search returns the recorded pull requests, later ones nothing. */
function recorded(overrides = {}) {
	const asked = [];
	let searches = 0;
	return {
		asked,
		async get(path) {
			asked.push(path);
			if (path.startsWith("/search/")) return { items: searches++ === 0 ? fixture.searchItems : [] };
			if (path in overrides) return structuredClone(overrides[path]);
			return path in fixture.responses ? structuredClone(fixture.responses[path]) : null;
		},
	};
}

async function gathered(item, rules = OPEN) {
	return gather(recorded(), item, rules);
}

test("a recorded pull request that fits becomes a candidate with its repo, base commit, issue and pull request", async () => {
	const seen = [];
	for await (const result of mine(recorded(), { cutoff: "2026-07-01", until: "2026-10-22", languages: ["python"], limit: 5, now: NOW, rules: OPEN })) {
		seen.push(result);
	}
	const ok = seen.filter((r) => r.ok);
	assert.equal(ok.length, 1);
	const c = ok[0].candidate;
	assert.equal(c.id, "jamshids-aiset-39");
	assert.equal(c.repo, "JamshidS/aiset");
	assert.equal(c.language, "python");
	assert.equal(c.license, "MIT");
	assert.equal(c.baseCommit, "a1e65e3a920b22fde94dc127bc9847efc7aac0ff");
	assert.equal(c.pr.number, 39);
	assert.equal(c.pr.url, "https://github.com/JamshidS/aiset/pull/39");
	assert.equal(c.issue.number, 24);
	assert.equal(c.issue.url, "https://github.com/JamshidS/aiset/issues/24");
	assert.ok(Date.parse(c.issue.createdAt) > Date.parse("2026-07-01"));
	assert.deepEqual(c.files.tests, ["tests/test_workspace_slug.py"]);
	assert.deepEqual(c.files.source, ["src/aiset/core.py", "src/aiset/workspace.py"]);
	assert.equal(c.minedAt, NOW.toISOString());
	// The other recorded pull request is turned away on its repository alone.
	const smiles = seen.find((r) => r.item === SMILES || r.item.number === SMILES.number);
	assert.equal(smiles.ok, false);
	assert.ok(smiles.reasons.includes("repository has 0 stars"));
});

test("the miner only reads: every request is a GET path on the API", async () => {
	const client = recorded();
	for await (const _ of mine(client, { cutoff: "2026-07-01", until: "2026-10-22", languages: ["python"], limit: 5, now: NOW, rules: OPEN })) {
	}
	assert.ok(client.asked.length > 3);
	for (const path of client.asked) assert.match(path, /^\/(search|repos)\//);
});

test("a recorded repository that needs packages and pytest is turned away for those reasons too", async () => {
	const rules = { ...OPEN, minStars: 0 };
	const decision = evaluate(await gathered(SMILES, rules), { cutoff: "2026-07-01", rules, now: NOW });
	assert.equal(decision.ok, false);
	assert.ok(decision.reasons.includes("pyproject.toml lists dependencies"), decision.reasons.join("; "));
	assert.ok(decision.reasons.some((r) => /imports pytest/.test(r)));
	assert.ok(decision.reasons.some((r) => /is not a unittest file/.test(r)));
});

test("an issue opened before the cutoff is not fresh", async () => {
	const decision = evaluate(await gathered(AISET), { cutoff: "2026-10-21", rules: OPEN, now: NOW });
	assert.equal(decision.ok, false);
	assert.ok(decision.reasons.some((r) => /before the cutoff/.test(r)));
});

test("each rule turns away a pull request that breaks it", async () => {
	const base = await gathered(AISET);
	assert.equal(evaluate(base, { cutoff: "2026-07-01", rules: OPEN, now: NOW }).ok, true);
	const cases = [
		["pull request is by a bot", (g) => (g.pr.user = { login: "renovate[bot]", type: "Bot" })],
		["pull request was written by a coding agent", (g) => (g.pr.body += "\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)")],
		["license is GPL-3.0", (g) => (g.repo.license = { spdx_id: "GPL-3.0" })],
		["repository is a fork", (g) => (g.repo.fork = true)],
		["the closed number is a pull request", (g) => (g.issue.pull_request = {})],
		["issue has too little text to write a request from", (g) => (g.issue.body = "broken")],
		["pull request adds or changes no test file", (g) => (g.files = g.files.filter((f) => !f.filename.startsWith("tests/")))],
		["pull request changes no source file", (g) => (g.files = g.files.filter((f) => !f.filename.startsWith("src/")))],
		["pull request changes pyproject.toml", (g) => g.files.push({ filename: "pyproject.toml", status: "modified", additions: 1, deletions: 0, patch: "@@" })],
		["tests/test_workspace_slug.py imports pytest", (g) => (g.tests["tests/test_workspace_slug.py"] = `import pytest\nimport unittest\n${g.tests["tests/test_workspace_slug.py"]}`)],
		["repository has TypeScript sources", (g) => g.tree.push({ path: "web/app.ts", type: "blob" })],
		["pyproject.toml lists dependencies", (g) => (g.manifests["pyproject.toml"] = g.manifests["pyproject.toml"].replace("dependencies = []", 'dependencies = ["requests"]'))],
	];
	for (const [reason, change] of cases) {
		const g = structuredClone(base);
		change(g);
		const decision = evaluate(g, { cutoff: "2026-07-01", rules: OPEN, now: NOW });
		assert.equal(decision.ok, false, reason);
		assert.ok(decision.reasons.includes(reason), `${reason}: got ${decision.reasons.join("; ")}`);
	}
});

test("the recorded repositories can never become exam tasks: their data is public here", async () => {
	const client = recorded();
	const decision = evaluate(await gather(client, AISET), { cutoff: "2026-07-01", now: NOW });
	assert.equal(decision.ok, false);
	assert.equal(decision.reasons[0], "repository is a public test fixture here");
	assert.deepEqual(client.asked, ["/repos/JamshidS/aiset"], "nothing more is read once the repository is out");
	for (const item of fixture.searchItems) assert.ok(RULES.excludeRepos.includes(item.repository_url.split("/repos/")[1]));
});

test("closing references count only for issues in the same repository", () => {
	const repo = "JamshidS/aiset";
	assert.deepEqual(closingIssues("Fixes #24", repo), [24]);
	assert.deepEqual(closingIssues("closes JamshidS/aiset#7 and resolves https://github.com/JamshidS/aiset/issues/9", repo), [7, 9]);
	assert.deepEqual(closingIssues("Fixes other/repo#3; see #4", repo), []);
	assert.deepEqual(closingIssues("Resolved: #5. Fixed #5 again", repo), [5]);
});

test("test files are told apart from source files by their path", () => {
	for (const p of ["tests/test_a.py", "pkg/tests/helpers.py", "test_b.py", "c_test.py", "test/x.js", "lib/a.test.mjs", "__tests__/b.js", "spec/c.cjs"]) {
		assert.ok(isTestPath(p), p);
	}
	for (const p of ["src/aiset/core.py", "lib/index.js", "testing.md", "contest.py", "app.ts"]) assert.ok(!isTestPath(p), p);
});

test("imports outside the standard library and the repository are found", () => {
	assert.deepEqual(externalImports('import os\nfrom aiset import core\nimport pytest, json\nfrom requests.adapters import X', "python", ["aiset"]), ["pytest", "requests"]);
	assert.deepEqual(
		externalImports('const a = require("node:fs"); import b from "./b.js"; import { c } from "@scope/pkg/sub"; const d = require("lodash"); import "fs";', "javascript"),
		["@scope/pkg", "lodash"],
	);
	assert.deepEqual(externalImports("const s = `from 'an\n other'`;", "javascript"), []);
});

test("manifests that pull packages from the network are turned away", () => {
	assert.deepEqual(nodeManifestProblems({ scripts: { test: "node --test" } }), []);
	assert.deepEqual(nodeManifestProblems({ scripts: { test: "jest" }, devDependencies: { jest: "1" } }), ["package.json has devDependencies"]);
	assert.deepEqual(nodeManifestProblems({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }), ["package.json has no test script"]);
	assert.deepEqual(pythonManifestProblems({ "requirements.txt": "# none\n\n" }), []);
	assert.deepEqual(pythonManifestProblems({ "requirements.txt": "requests==2\n" }), ["requirements.txt lists packages"]);
	assert.deepEqual(pythonManifestProblems({ "pyproject.toml": '[project]\ndependencies = [\n  # none\n]\n' }), []);
	assert.deepEqual(pythonManifestProblems({ "setup.py": "setup(install_requires=['x'])" }), ["setup.py lists install_requires"]);
});

test("searches cover the cutoff to today in weekly windows, newest first", () => {
	const w = windows("2026-09-01", "2026-09-20");
	assert.deepEqual(w, [["2026-09-15", "2026-09-20"], ["2026-09-08", "2026-09-14"], ["2026-09-01", "2026-09-07"]]);
	assert.equal(searchQuery("python", w[0]), "is:pr is:merged linked:issue archived:false language:python merged:2026-09-15..2026-09-20");
});

test("the client sends GET with the token, waits out a rate limit, and reads 404 as nothing", async () => {
	const calls = [];
	const waits = [];
	const responses = [
		new Response("limited", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 30) } }),
		new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
		new Response("missing", { status: 404 }),
	];
	const client = githubClient({
		token: "test-token",
		fetch: async (url, init) => {
			calls.push({ url, init });
			return responses.shift();
		},
		sleep: async (ms) => waits.push(ms),
	});
	assert.deepEqual(await client.get("/repos/a/b"), { ok: 1 });
	assert.equal(await client.get("/repos/a/c"), null);
	assert.equal(calls.length, 3);
	for (const c of calls) {
		assert.equal(c.init.method, "GET");
		assert.equal(c.init.headers.authorization, "Bearer test-token");
	}
	assert.equal(waits.length, 1);
	assert.ok(waits[0] >= 5_000 && waits[0] <= 15 * 60_000);
});
