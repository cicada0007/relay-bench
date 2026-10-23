// loop/package.mjs: the cycle's pre-screened changes as one combined release, written to files and nothing else: a
// pull request body with gain, interval, rollback, risk tier and lanes, a patch that applies at the champion, the
// gate's combined manifest, and the ledger entry it would make.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { combinedProblems } from "../runner/gate-analyze.mjs";
import { appendEntry, emptyLedger } from "../scripts/ledger.mjs";
import { fakeArch, fakeArchText, fakeWriter, SOURCES, sources } from "./fakes.mjs";
import { changeId, cycleOfChange, packageRelease } from "./package.mjs";
import { ruleCandidates, selectProposals, writeProposal, writerTargets } from "./propose.mjs";

const SETTINGS = JSON.parse(readFileSync(new URL("./settings.json", import.meta.url), "utf8"));
const cluster = (symptom, kind, lanes) => ({ id: `c-${symptom}-${kind}`, symptom, kind, words: symptom, lanes, runs: 6, tasks: ["py-l0", "py-l1"], stacks: ["python3"], notes: [] });

async function cycleProposals() {
	const arch = fakeArch();
	const archText = fakeArchText();
	const analysis = { clusters: [cluster("false-done", "long", ["config", "prompts"]), cluster("parked-after-retries", "everyday", ["config"])], routes: {}, learning: {} };
	const settings = { ...SETTINGS, lanes: { ...SETTINGS.lanes, config: { ...SETTINGS.lanes.config, proposals: 2 } } };
	const { candidates } = ruleCandidates({ cycle: "2026-W43", analysis, arch, archText, settings, sources });
	const { proposals } = selectProposals(candidates, { settings, arch, sources });
	const target = writerTargets({ analysis, arch, settings }).find((t) => t.prompt.id === "queue.requestCheck");
	const file = target.prompt.file;
	const diff = `--- a/${file}\n+++ b/${file}\n@@ -6,1 +6,2 @@\n \t"Read the request detail by detail.",\n+\t"Check every case the request names.",\n`;
	const written = await writeProposal({ cycle: "2026-W43", target, source: SOURCES[file], writer: fakeWriter({ diff }), arch });
	return { arch, archText, proposals: [...proposals, written.proposal] };
}
const result = (p, over = {}) => ({ id: p.id, lane: p.lane, status: "passed", dev: { tasks: 24, difference: 2.5, low: -1.2, high: 6.2, costRatio: 1.01, timeRatio: 0.98, safetyFlags: 0 }, selection: { status: "pass", query: 1 }, ...over });

function applyAll(patch, archText) {
	const dir = mkdtempSync(join(tmpdir(), "loop-release-"));
	writeFileSync(join(dir, "relay.arch.json"), archText);
	for (const [file, text] of Object.entries(SOURCES)) {
		mkdirSync(join(dir, dirname(file)), { recursive: true });
		writeFileSync(join(dir, file), text);
	}
	writeFileSync(join(dir, "release.patch"), patch);
	const r = spawnSync("git", ["apply", "release.patch"], { cwd: dir, encoding: "utf8" });
	return { status: r.status, stderr: r.stderr, read: (f) => readFileSync(join(dir, f), "utf8") };
}

test("one release from the best pre-screen of each lane: body, patch, manifest and ledger entry", async () => {
	const { arch, archText, proposals } = await cycleProposals();
	const config = proposals.filter((p) => p.lane === "config");
	assert.equal(config.length, 2);
	const prompts = proposals.find((p) => p.lane === "prompts");
	// The second config proposal did better on the dev set, so it is the lane's change; the first waits.
	const results = [result(config[0], { dev: { ...result(config[0]).dev, low: -3 } }), result(config[1], { dev: { ...result(config[1]).dev, difference: 4.1, low: 0.4, high: 7.8 } }), result(prompts), { id: "2026-W43-routing-z", lane: "routing", status: "dropped" }];
	let ledger = appendEntry(emptyLedger(), { release: "0.6.121", champion: "0.6.120", date: "2026-10-16", gate: { status: "PASS" }, lanes: null });
	const cycleDir = mkdtempSync(join(tmpdir(), "loop-package-"));
	const pkg = packageRelease({ cycle: "2026-W43", cycleDir, results, proposals, arch, archText, sources, ledger, champion: "0.6.121", release: "0.6.122-beta.1", model: "claude-haiku-5-5" });

	assert.deepEqual(pkg.lanes.map((l) => l.lane), ["config", "prompts"]);
	assert.equal(pkg.lanes[0].change, changeId("2026-W43", config[1].id));
	assert.equal(cycleOfChange(pkg.lanes[0].change), "2026-W43");
	assert.equal(pkg.risk, "medium");
	assert.deepEqual(pkg.held.map((h) => h.id), [config[0].id]);
	for (const name of ["PR_BODY.md", "release.patch", "lanes.json", "ledger-preview.json"]) assert.ok(existsSync(join(cycleDir, "release", name)), name);

	// The manifest is one the gate takes as a combined candidate.
	const manifest = JSON.parse(readFileSync(join(cycleDir, "release", "lanes.json"), "utf8"));
	assert.deepEqual(combinedProblems(manifest, "0.6.122-beta.1"), []);
	// The patch applies at the champion and holds every lane's change.
	const applied = applyAll(readFileSync(join(cycleDir, "release", "release.patch"), "utf8"), archText);
	assert.equal(applied.status, 0, applied.stderr);
	assert.match(applied.read("src/queue/request-check.ts"), /Check every case the request names/);
	const changed = config[1].change;
	assert.deepEqual(JSON.parse(applied.read("relay.arch.json")).queue[changed.path.split(".")[1]], changed.to);
	// The ledger entry it would make follows the ledger's last release.
	const preview = JSON.parse(readFileSync(join(cycleDir, "release", "ledger-preview.json"), "utf8"));
	assert.equal(preview.wouldBe.seq, 2);
	assert.equal(preview.wouldBe.prev, ledger.entries[0].hash);
	assert.equal(preview.wouldBe.champion, "0.6.121");
	assert.equal(preview.wouldBe.chainStart, undefined);
	assert.match(preview.writtenOnlyBy, /after the gate on the exam stops with PASS/);

	const body = readFileSync(join(cycleDir, "release", "PR_BODY.md"), "utf8");
	for (const needle of ["# Relay loop, cycle 2026-W43: config, prompts and skills", "**Risk tier:** medium", "+4.1 points, interval 0.4 to 7.8", "+2.5 points, interval -1.2 to 6.2", "Selection set** (the check tier's one word): pass", "Roll back", "set `queue.", "git apply -R", "--combined lanes.json", "\"seq\": 2", "The loop does not open, merge or release it"]) {
		assert.ok(body.includes(needle), `the body holds ${needle}`);
	}
	assert.doesNotMatch(body, /\b(better|worse|improved|regressed)\b/i, "numbers only, no words for results");
	assert.doesNotMatch(body, /Generated with/);

	// A ledger whose last release is not the champion: the entry would start a new chain, and says so.
	ledger = appendEntry(ledger, { release: "0.6.121-beta.9", champion: "0.6.121", date: "2026-10-20", gate: { status: "PASS" } });
	const other = packageRelease({ cycle: "2026-W43", cycleDir, results, proposals, arch, archText, sources, ledger, champion: "0.6.121", release: "0.6.122-beta.1", model: "m", write: false });
	assert.equal(other.preview.wouldBe.chainStart, true);
});

test("one lane is a release without a combined manifest; no pass is no package", async () => {
	const { arch, archText, proposals } = await cycleProposals();
	const one = proposals.find((p) => p.lane === "prompts");
	const cycleDir = mkdtempSync(join(tmpdir(), "loop-package-"));
	const pkg = packageRelease({ cycle: "2026-W43", cycleDir, results: [result(one, { selection: { status: "not available", why: "the check tier has no tasks yet (TIERS.md)" } })], proposals, arch, archText, sources, ledger: emptyLedger(), champion: "0.6.121", release: "0.6.122-beta.1", model: "m" });
	assert.equal(pkg.manifest, null);
	assert.equal(existsSync(join(cycleDir, "release", "lanes.json")), false);
	assert.match(pkg.body, /not asked, the check tier has no tasks yet/);
	assert.doesNotMatch(pkg.body, /--combined/);
	assert.equal(pkg.preview.wouldBe.seq, 1);
	assert.match(packageRelease({ cycle: "2026-W43", cycleDir, results: [result(one, { status: "dropped" })], proposals, arch, archText, sources, ledger: emptyLedger(), champion: "0.6.121", release: "x", model: "m" }).empty, /no proposal passed/);
});
