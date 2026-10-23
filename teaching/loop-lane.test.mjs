// A skill candidate in the improvement loop: it is a prompts-and-skills proposal that adds one new SKILL.md, free,
// checked against the lane and the invariants like any other, packaged into the release the gate judges, and never
// shipped by the loop itself. Made-up data only; nothing reaches a network or a model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runCycle } from "../loop/cycle.mjs";
import { addsNewFile, newFileDiff, newFileText } from "../loop/diff.mjs";
import { fakeArch, fakeArchText, fakeExec, fakeWriter, practiceTasks, record, SOURCES, sources, writeRecords } from "../loop/fakes.mjs";
import { invariantHits, proposalProblems, skillsRoot } from "../loop/lanes.mjs";
import { approve, serializeSettings } from "../loop/meta.mjs";
import { composePatch, packageRelease } from "../loop/package.mjs";
import { selectProposals, teachingProposals } from "../loop/propose.mjs";
import { CONSENT, graduate, readCandidates, readShared, sha256, writeCandidates } from "./graduate.mjs";

const SETTINGS = JSON.parse(readFileSync(new URL("../loop/settings.json", import.meta.url), "utf8"));
const machine = (n) => `m_${sha256(`machine-${n}`).slice(0, 32)}`;
const tmp = () => mkdtempSync(join(tmpdir(), "teaching-loop-"));

/** A folder of skill candidates graduated from `machines` machines sharing each lesson in `lessons`. */
function candidatesFrom(lessons, { machines = 5, passes = 5 } = {}) {
	const dir = tmp();
	for (let i = 0; i < machines; i++) {
		writeFileSync(join(dir, `b${i}.json`), JSON.stringify({ consent: CONSENT, machine: machine(i), lessons: lessons.map((l) => ({ kind: "memory", model: "anthropic/claude-sonnet-5-5", passes, ...l })) }));
	}
	const read = readShared([dir]);
	const out = join(tmp(), "candidates");
	writeCandidates(graduate(read.lessons, { skipped: read.skipped }), out);
	return out;
}
const TESTS_FIRST = { title: "Run the tests before committing", text: "Run the whole test suite before you commit, and fix what fails first." };

test("a candidate is one prompts-and-skills proposal: a new SKILL.md beside the shipped skills, free, inside its lane", () => {
	const arch = fakeArch();
	const { candidates, problems } = readCandidates(candidatesFrom([TESTS_FIRST]));
	assert.deepEqual(problems, []);
	const r = teachingProposals({ cycle: "2026-W43", candidates, arch, settings: SETTINGS });
	assert.deepEqual(r.refused, []);
	assert.equal(r.candidates.length, 1);
	const p = r.candidates[0];
	assert.equal(p.lane, "prompts");
	assert.equal(p.id, "2026-W43-prompts-teach-run-the-tests-before-committing");
	assert.equal(p.costUsd, 0, "no model writes it");
	assert.equal(skillsRoot(arch), "skills");
	assert.deepEqual(p.touches, { arch: [], files: ["skills/run-the-tests-before-committing/SKILL.md"] });
	assert.ok(addsNewFile(p.patch, p.touches.files[0]));
	assert.equal(newFileText(p.patch), candidates[0].skill);
	assert.deepEqual(p.evidence, { machines: 5, passes: 25, members: 5, models: ["anthropic/claude-sonnet-5-5"] });
	assert.deepEqual(proposalProblems(p, { arch }), []);
	assert.equal(p.risk, "medium");
	// Kept within the lane's limit like any other proposal, heaviest evidence first.
	const sel = selectProposals(r.candidates, { settings: SETTINGS, arch, sources });
	assert.deepEqual(sel.proposals.map((x) => x.id), [p.id]);
});

test("the lane's checks still apply: an invariant, a skill that ships already, a second file, an edit, a bad name", () => {
	const arch = fakeArch();
	// A skill named like a grader is a grader's file to the invariants (**/judge/**), whatever it says.
	const judge = teachingProposals({ cycle: "2026-W43", ...readCandidates(candidatesFrom([{ title: "Judge", text: "Read the whole diff before you approve a change." }])), arch, settings: SETTINGS });
	assert.equal(judge.candidates.length, 0);
	assert.match(judge.refused[0].problems.join("; "), /reaches an invariant \(the graders/);
	// A shipped skill is changed by a writer, never replaced by a taught one.
	const edit = teachingProposals({ cycle: "2026-W43", ...readCandidates(candidatesFrom([{ title: "Edit", text: "Read a file whole before you change part of it." }])), arch, settings: SETTINGS });
	assert.match(edit.refused[0].problems.join("; "), /a skill named edit ships already/);
	// Words only: a taught skill adds its SKILL.md and nothing else, as a new file, with a name the harness loads.
	const base = teachingProposals({ cycle: "2026-W43", ...readCandidates(candidatesFrom([TESTS_FIRST])), arch, settings: SETTINGS }).candidates[0];
	const withScript = { ...base, patch: `${base.patch}${newFileDiff("echo hi\n", "skills/run-the-tests-before-committing/run.sh")}` };
	assert.match(proposalProblems(withScript, { arch }).join("; "), /skills\/run-the-tests-before-committing\/run.sh is outside the prompts lane/);
	const notNew = { ...base, patch: base.patch.replace("new file mode 100644\n--- /dev/null\n", "--- a/skills/run-the-tests-before-committing/SKILL.md\n") };
	assert.match(proposalProblems(notNew, { arch }).join("; "), /can only be added whole, as a new file/);
	const badName = { ...base, patch: newFileDiff("x\n", "skills/Bad_Name/SKILL.md") };
	assert.match(proposalProblems(badName, { arch }).join("; "), /the new skill Bad_Name needs a name of lowercase a-z, 0-9 and hyphens only/);
	// Outside the skills folder it is any other file outside the lane.
	const elsewhere = { ...base, patch: newFileDiff("x\n", "src/queue/new.ts") };
	assert.match(proposalProblems(elsewhere, { arch }).join("; "), /src\/queue\/new.ts is outside the prompts lane/);
	// Teaching's own rules and the machine's export are invariants too.
	assert.deepEqual(invariantHits({ files: ["teaching/graduate.mjs", "TEACHING.md", "packages/coding-agent/src/core/teaching/export.ts"] }).map((h) => h.invariant), ["gate", "gate", "tenant-data"]);
});

test("a candidate that names a practice task's failures is refused, as a writer's change would be", () => {
	const arch = fakeArch();
	const { candidates } = readCandidates(candidatesFrom([{ title: "Long tasks", text: "On py-l0 split the request into parts first." }]));
	const clusters = [{ id: "c-timeout-long", tasks: ["py-l0", "py-l1"], notes: [] }];
	const r = teachingProposals({ cycle: "2026-W43", candidates, arch, clusters, settings: SETTINGS });
	assert.equal(r.candidates.length, 0);
	assert.match(r.refused[0].problems.join("; "), /names "py-l0", from a practice task's failures/);
});

test("with the prompts lane off, candidates wait; a folder with a bad candidate is refused by name", () => {
	const arch = fakeArch();
	const dir = candidatesFrom([TESTS_FIRST]);
	const off = { ...SETTINGS, lanes: { ...SETTINGS.lanes, prompts: { ...SETTINGS.lanes.prompts, enabled: false } } };
	const r = teachingProposals({ cycle: "2026-W43", ...readCandidates(dir), arch, settings: off });
	assert.deepEqual(r.candidates, []);
	assert.match(r.notes[0], /1 skill candidate wait; the prompts lane is off/);
	writeFileSync(join(dir, "run-the-tests-before-committing", "SKILL.md"), "changed\n");
	const bad = teachingProposals({ cycle: "2026-W43", ...readCandidates(dir), arch, settings: SETTINGS });
	assert.equal(bad.refused[0].id, "2026-W43-prompts-teach-run-the-tests-before-committing");
	assert.match(bad.refused[0].problems.join("; "), /changed since graduation/);
});

test("packaged, a taught skill is a new file in release.patch that git applies at the champion", () => {
	const arch = fakeArch();
	const archText = fakeArchText();
	const p = teachingProposals({ cycle: "2026-W43", ...readCandidates(candidatesFrom([TESTS_FIRST])), arch, settings: SETTINGS }).candidates[0];
	const composed = composePatch({ chosen: [p], arch, archText, sources });
	assert.deepEqual(composed.held, []);
	assert.equal(composed.patch, p.patch);
	const dir = tmp();
	const pkg = packageRelease({ cycle: "2026-W43", cycleDir: dir, results: [{ id: p.id, lane: "prompts", status: "passed", dev: { tasks: 6, difference: 3, low: 0.5, high: 5.5, costRatio: 1, timeRatio: 1, safetyFlags: 0 }, selection: { status: "pass" } }], proposals: [p], arch, archText, sources, ledger: { entries: [] }, champion: "0.6.121", release: "0.6.122-beta.1", model: "claude-haiku-5-5" });
	assert.match(pkg.body, /a new skill, `skills\/run-the-tests-before-committing\/SKILL.md`, graduated from lessons people chose to share/);
	assert.match(pkg.body, /5 machines shared it, after it was used in 25 tasks there that passed their checks/);
	assert.match(pkg.body, /Nothing here is released/);
	// git applies it to the champion and the skill appears, byte for byte.
	const champion = tmp();
	writeFileSync(join(champion, "relay.arch.json"), archText);
	for (const [file, text] of Object.entries(SOURCES)) {
		mkdirSync(join(champion, dirname(file)), { recursive: true });
		writeFileSync(join(champion, file), text);
	}
	execFileSync("git", ["init", "-q"], { cwd: champion });
	writeFileSync(join(champion, "release.patch"), pkg.patch);
	execFileSync("git", ["apply", "release.patch"], { cwd: champion });
	assert.equal(readFileSync(join(champion, "skills", "run-the-tests-before-committing", "SKILL.md"), "utf8"), newFileText(p.patch));
	// A second lane adding the same new file is held back, not merged over it.
	const twice = composePatch({ chosen: [p, { ...p, id: "other" }], arch, archText, sources });
	assert.deepEqual(twice.held, [{ id: "other", why: "it adds skills/run-the-tests-before-committing/SKILL.md, which already exists" }]);
});

test("the cycle takes --teaching: the candidate fills the prompts lane, no writer is paid for it, and nothing is shipped", async () => {
	const p = practiceTasks({ everyday: 6, long: 4 });
	const runs = join(p.root, "runs");
	const records = writeRecords(runs, ["py-l0", "py-l1", "py-l2"].map((task) => record({ task, kind: "long", share: 0.5, saidDoneButFailed: true })));
	const settingsPath = join(p.root, "settings.json");
	writeFileSync(settingsPath, serializeSettings(approve(SETTINGS, { by: "arnav" }).settings));
	const harness = tmp();
	writeFileSync(join(harness, "relay.arch.json"), fakeArchText());
	for (const [file, text] of Object.entries(SOURCES)) {
		mkdirSync(join(harness, dirname(file)), { recursive: true });
		writeFileSync(join(harness, file), text);
	}
	const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: harness, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git("commit", "-q", "-m", "champion");
	const writes = [];
	const calls = [];
	const r = await runCycle({ cycle: "2026-W43", out: join(p.root, "loop"), settingsPath, records: [records], tasksDirs: [p.tasks], harness, harnessRef: "HEAD", champion: "0.6.121", teaching: candidatesFrom([TESTS_FIRST]), exec: fakeExec({ calls }), writer: fakeWriter({ diff: "", calls: writes }) });
	const taught = r.state.proposals.filter((x) => x.lane === "prompts");
	assert.deepEqual(taught.map((x) => x.id), ["2026-W43-prompts-teach-run-the-tests-before-committing"]);
	assert.ok(!r.state.written.some((w) => w.startsWith("prompts|")), "the prompts lane's one slot is taken, so its writer is not called");
	assert.ok(existsSync(join(r.dir, "proposals", `${taught[0].id}.patch`)));
	assert.match(r.report, /new skill run-the-tests-before-committing \(skills\/run-the-tests-before-committing\/SKILL.md\)\. .*Evidence: 5 machines, 25 passing uses there/);
	assert.deepEqual(calls, [], "no pre-screen ran without a spend cap");
	assert.equal(r.steps.find((s) => s.step === "prescreen").status, "stopped");
	assert.ok(!existsSync(join(harness, "skills", "run-the-tests-before-committing")), "the loop never writes into the harness");
});
