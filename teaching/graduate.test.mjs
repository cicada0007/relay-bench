// teaching/graduate.mjs on made-up shared lessons: the rule's thresholds, one machine counted once, near-duplicate
// grouping, what is skipped, and a candidate in the harness's skill format. Nothing here reaches a network or a model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONSENT, DEFAULTS, descriptionProblems, graduate, groupLessons, jaccard, leftovers, readCandidates, readFrontmatter, readShared, sha256, skillNameProblems, words, writeCandidates } from "./graduate.mjs";

const GRADUATE = new URL("./graduate.mjs", import.meta.url).pathname;
const machine = (n) => `m_${sha256(`machine-${n}`).slice(0, 32)}`;
const lesson = (over = {}) => ({ kind: "memory", title: "Run the tests before committing", text: "Run the whole test suite before you commit, and fix what fails first.", model: "anthropic/claude-sonnet-5-5", passes: 5, ...over });
const batch = (n, lessons) => ({ consent: CONSENT, machine: machine(n), lessons });
const tmp = () => mkdtempSync(join(tmpdir(), "teaching-"));
function files(batches) {
	const dir = tmp();
	batches.forEach((b, i) => writeFileSync(join(dir, `batch-${String(i).padStart(3, "0")}.json`), JSON.stringify(b)));
	return dir;
}
const run = (batches, opts = {}) => {
	const read = readShared([files(batches)]);
	return graduate(read.lessons, { ...opts, skipped: read.skipped });
};
/** `n` machines sharing the same lesson, each with `passes`. */
const fleet = (n, passes, over = {}) => Array.from({ length: n }, (_, i) => batch(i, [lesson({ passes, ...over })]));

test("the defaults are 5 machines, 25 passing uses and a similarity of 0.6", () => {
	assert.deepEqual({ ...DEFAULTS }, { minMachines: 5, minPasses: 25, similarity: 0.6 });
});

test("thresholds: below M machines or K passing uses there is no candidate; exactly at both there is one", () => {
	assert.equal(run(fleet(4, 10)).candidates.length, 0, "4 machines, 40 passes: too few machines");
	assert.deepEqual(run(fleet(4, 10)).below[0].lacks, ["4 of the 5 machines it needs"]);
	assert.equal(run(fleet(5, 4)).candidates.length, 0, "5 machines, 20 passes: too few passes");
	assert.deepEqual(run(fleet(5, 4)).below[0].lacks, ["20 of the 25 passing uses it needs"]);
	const at = run(fleet(5, 5));
	assert.equal(at.candidates.length, 1, "5 machines, 25 passes: exactly at both");
	assert.equal(at.candidates[0].candidate.evidence.machines, 5);
	assert.equal(at.candidates[0].candidate.evidence.passes, 25);
	// Other thresholds are taken as given.
	assert.equal(run(fleet(3, 2), { minMachines: 3, minPasses: 6 }).candidates.length, 1);
	assert.throws(() => graduate([], { minMachines: 0 }), /--min-machines/);
});

test("one machine counts once: many copies, or the same lesson sent again with more passes, add nothing past its best", () => {
	// Four honest machines with 5 each, and one machine that sends the lesson 30 times, its passes rising to 9.
	const noisy = Array.from({ length: 30 }, (_, i) => batch(99, [lesson({ passes: i % 10 })]));
	const r = run([...fleet(4, 5), ...noisy]);
	assert.equal(r.candidates.length, 1);
	const e = r.candidates[0].candidate.evidence;
	assert.equal(e.machines, 5);
	assert.equal(e.passes, 4 * 5 + 9, "the noisy machine adds its best, 9, once");
	assert.equal(e.members, 34);
	// Copies from one machine alone never make a candidate, however many.
	assert.equal(run(Array.from({ length: 50 }, () => batch(7, [lesson({ passes: 100 })]))).candidates.length, 0);
});

test("near-duplicates: rephrasings group, different lessons and different kinds do not", () => {
	const rephrased = [
		lesson({ title: "Run the tests before committing", text: "Run the whole test suite before you commit." }),
		lesson({ title: "Always run tests before you commit", text: "Before committing, run the test suite." }),
		lesson({ title: "Test before commit", text: "Run the tests before committing, every time." }),
	].map((l, i) => ({ ...l, machine: machine(i) }));
	const other = { ...lesson({ title: "Use npm ci in CI", text: "Install with npm ci rather than npm install, so the lock file decides." }), machine: machine(9) };
	const asPrompt = { ...rephrased[0], kind: "prompt", machine: machine(8) };
	const groups = groupLessons([...rephrased, other, asPrompt]);
	assert.equal(groups.length, 3);
	const sizes = groups.map((g) => `${g[0].kind}:${g.length}`).sort();
	assert.deepEqual(sizes, ["memory:1", "memory:3", "prompt:1"]);
	assert.ok(jaccard(words("Run the tests before committing."), words("Before committing, run the test suite.")) >= DEFAULTS.similarity);
	assert.ok(jaccard(words(rephrased[0].text), words(other.text)) < DEFAULTS.similarity);
	// A lesson and its opposite share most words, and are never one lesson.
	const never = { ...lesson({ title: "Never run the tests before committing", text: "Do not run the whole test suite before you commit." }), machine: machine(7) };
	assert.equal(groupLessons([rephrased[0], never]).length, 2);
	// Placeholders a machine left in place of what it redacted do not make two lessons alike.
	assert.deepEqual(words("Build in <path> with <name>'s settings"), words("Build in settings"));
});

test("transitive: A is like B and B is like C, so all three are one lesson even when A and C are not alike", () => {
	const a = { ...lesson({ title: "Lint", text: "run lint check build test fix" }), machine: machine(1) };
	const b = { ...lesson({ title: "Lint", text: "run lint check build test fix format types" }), machine: machine(2) };
	const c = { ...lesson({ title: "Lint", text: "run lint check build format types docs" }), machine: machine(3) };
	assert.ok(jaccard(words(`${a.title} ${a.text}`), words(`${c.title} ${c.text}`)) < 0.6);
	assert.equal(groupLessons([a, b, c]).length, 1);
});

test("what is skipped: malformed, not under consent lessons-v1, and anything with a secret, path, email or link", () => {
	const dir = tmp();
	const bad = [
		{ machine: machine(1), lessons: [lesson()] }, // no consent
		{ consent: "lessons-v0", machine: machine(1), lessons: [lesson(), lesson()] },
		{ consent: CONSENT, machine: "alice-laptop", lessons: [lesson()] },
		{ consent: CONSENT, machine: machine(1), lessons: [lesson()], account: "u_1" },
		batch(2, [
			lesson({ kind: "skill" }),
			lesson({ passes: -1 }),
			lesson({ passes: 2.5 }),
			lesson({ title: "" }),
			lesson({ text: "x".repeat(2001) }),
			lesson({ model: "a model" }),
			lesson({ session: "s_1" }),
			lesson({ text: "Use the key sk-ant-abcdefghijklmnopqrstuvwxyz0123 for the staging run." }),
			lesson({ text: "Read the notes in /Users/alice/work/notes.md first." }),
			lesson({ text: "Run the build from packages/coding-agent, not the root." }),
			lesson({ text: "Ask bob@example.com before merging." }),
			lesson({ text: "The docs at https://internal.example.dev/wiki say so." }),
			lesson({ text: "Set token=abcd1234efgh before the run." }),
			lesson(),
		]),
	];
	bad.forEach((b, i) => writeFileSync(join(dir, `b${i}.json`), JSON.stringify(b)));
	writeFileSync(join(dir, "broken.json"), "{ not json");
	writeFileSync(join(dir, "rows.jsonl"), ["not json", JSON.stringify({ ...lesson(), machine: machine(3) }), JSON.stringify({ ...lesson(), machine: machine(4), consent: "other" }), JSON.stringify({ ...lesson(), machine: machine(5), user: "u_9" }), ""].join("\n"));
	const r = readShared([dir]);
	assert.equal(r.lessons.length, 2, "only the one clean lesson in the batch and the one clean row");
	assert.deepEqual(r.skipped, {
		"a batch not sent under consent lessons-v1": 3,
		"a batch whose machine id is not m_ and 32 hex": 1,
		"a batch with a field the format does not have": 1,
		"a file that is not JSON": 1,
		"a kind that is not prompt, memory or subagent": 1,
		"a lesson with a field the format does not have": 1,
		"a line that is not JSON": 1,
		"a model that is not provider/id or unknown": 1,
		"a record not sent under consent lessons-v1": 1,
		"a record with a field the format does not have": 1,
		"a text missing or over 2000 characters": 1,
		"a title missing or over 120 characters": 1,
		"passes that are not a whole number": 2,
		"words that still hold a path and a link": 1,
		"words that still hold a path": 2,
		"words that still hold a secret": 2,
		"words that still hold an email and a link": 1,
	});
	assert.deepEqual(leftovers("Run the tests before committing; and/or read/write; pin eslint@8.57.0; use /refine."), []);
});

test("a candidate is a skill in the harness's format: name equal to its folder, lowercase and hyphens, a short description", () => {
	const r = run(fleet(6, 5, { title: "Run the tests before committing!", text: "Run the whole test suite before you commit. Fix what fails first." }));
	const out = join(tmp(), "candidates");
	writeCandidates(r, out);
	const [name] = readdirSync(out).filter((n) => n !== "graduation.json");
	assert.equal(name, "run-the-tests-before-committing");
	const skill = readFileSync(join(out, name, "SKILL.md"), "utf8");
	const fm = readFrontmatter(skill);
	assert.equal(fm.name, name);
	assert.deepEqual(skillNameProblems(fm.name, name), []);
	assert.deepEqual(descriptionProblems(fm.description), []);
	assert.ok(fm.description.length <= 300);
	assert.match(skill, /^---\nname: run-the-tests-before-committing\ndescription: "Run the tests before committing! Run the whole test suite before you commit."\n---\n\n# Run the tests before committing!\n\nRun the whole test suite/);
	const candidate = JSON.parse(readFileSync(join(out, name, "candidate.json"), "utf8"));
	assert.equal(candidate.status, "candidate");
	assert.equal(candidate.kind, "memory");
	assert.deepEqual(candidate.thresholds, { minMachines: 5, minPasses: 25, similarity: 0.6 });
	assert.equal(candidate.evidence.machines, 6);
	assert.equal(candidate.evidence.passes, 30);
	assert.deepEqual(candidate.evidence.models, ["anthropic/claude-sonnet-5-5"]);
	assert.equal(candidate.evidence.memberHashes.length, 1);
	assert.match(candidate.evidence.memberHashes[0], /^sha256:[0-9a-f]{64}$/);
	assert.equal(candidate.skillSha256, sha256(skill));
	assert.match(candidate.rule, /only through the improvement loop's prompts and skills lane and the gate/);
	for (const k of ["accepted", "approved", "acceptedBy", "approvedBy"]) assert.ok(!(k in candidate));
	// What the loop reads back is the same candidate, checked again.
	const back = readCandidates(out);
	assert.deepEqual(back.problems, []);
	assert.equal(back.candidates[0].name, name);
	// Names the harness would refuse are refused here too.
	assert.ok(skillNameProblems("Run_Tests").length > 0);
	assert.ok(skillNameProblems("-x").length > 0);
	assert.ok(skillNameProblems("a--b").length > 0);
	assert.ok(skillNameProblems("x".repeat(65)).length > 0);
	assert.ok(descriptionProblems("").length > 0);
	assert.ok(descriptionProblems("x".repeat(1025)).length > 0);
});

test("the harness's own loader loads a candidate (only with RELAY_HARNESS_DIR naming a linked harness worktree)", (t) => {
	const harness = process.env.RELAY_HARNESS_DIR;
	const tsx = harness && join(harness, "node_modules", ".bin", "tsx");
	const loader = harness && join(harness, "packages", "coding-agent", "src", "core", "skills.ts");
	if (!harness || !existsSync(tsx) || !existsSync(loader)) {
		t.skip("set RELAY_HARNESS_DIR to a harness worktree with node_modules linked to load the candidate with core/skills.ts");
		return;
	}
	const r = run(fleet(5, 5));
	const out = join(tmp(), "candidates");
	writeCandidates(r, out);
	const script = `import { loadSkillsFromDir } from ${JSON.stringify(loader)}; const r = loadSkillsFromDir({ dir: ${JSON.stringify(out)}, source: "path" }); console.log(JSON.stringify({ names: r.skills.map((s) => s.name), descriptions: r.skills.map((s) => s.description), diagnostics: r.diagnostics.map((d) => d.message) }));`;
	const home = tmp();
	const res = spawnSync(tsx, ["-e", script], { encoding: "utf8", cwd: join(harness, "packages", "coding-agent"), env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir() }, timeout: 120_000 });
	assert.equal(res.status, 0, res.stderr);
	const loaded = JSON.parse(res.stdout.trim().split("\n").at(-1));
	assert.deepEqual(loaded.names, ["run-the-tests-before-committing"]);
	assert.deepEqual(loaded.diagnostics, []);
	assert.equal(loaded.descriptions[0], readFrontmatter(readFileSync(join(out, loaded.names[0], "SKILL.md"), "utf8")).description);
});

test("the same files give the same candidates, byte for byte; names two groups would share get a number", () => {
	const batches = [...fleet(5, 5), ...Array.from({ length: 5 }, (_, i) => batch(20 + i, [lesson({ title: "Run the tests before committing", text: "Keep each pull request small so review stays quick.", passes: 6 })]))];
	const a = join(tmp(), "a");
	const b = join(tmp(), "b");
	writeCandidates(run(batches), a);
	writeCandidates(run([...batches].reverse()), b);
	const names = readdirSync(a).sort();
	assert.deepEqual(names, ["graduation.json", "run-the-tests-before-committing", "run-the-tests-before-committing-2"]);
	assert.deepEqual(readdirSync(b).sort(), names);
	for (const n of names.filter((x) => x !== "graduation.json")) {
		for (const f of ["SKILL.md", "candidate.json"]) assert.equal(readFileSync(join(a, n, f), "utf8"), readFileSync(join(b, n, f), "utf8"));
	}
	assert.equal(readFileSync(join(a, "graduation.json"), "utf8"), readFileSync(join(b, "graduation.json"), "utf8"));
	// The group more machines... here equal, so more passes, keeps the plain name.
	assert.equal(JSON.parse(readFileSync(join(a, "run-the-tests-before-committing", "candidate.json"), "utf8")).evidence.passes, 30);
});

test("a candidate never goes into the harness, and a folder of someone else's files is not overwritten", () => {
	const harness = tmp();
	writeFileSync(join(harness, "relay.arch.json"), "{}");
	assert.throws(() => writeCandidates(run(fleet(5, 5)), join(harness, "packages", "coding-agent", "skills")), /inside a harness checkout/);
	const busy = tmp();
	writeFileSync(join(busy, "notes.txt"), "mine");
	assert.throws(() => writeCandidates(run(fleet(5, 5)), busy), /did not write/);
	// Its own earlier output is replaced, including a candidate that no longer qualifies.
	const out = join(tmp(), "c");
	writeCandidates(run(fleet(5, 5)), out);
	writeCandidates(run(fleet(4, 5)), out);
	assert.deepEqual(readdirSync(out), ["graduation.json"]);
});

test("readCandidates refuses a candidate whose SKILL.md changed since, or that claims to be accepted", () => {
	const out = join(tmp(), "c");
	writeCandidates(run(fleet(5, 5)), out);
	const name = "run-the-tests-before-committing";
	writeFileSync(join(out, name, "SKILL.md"), `${readFileSync(join(out, name, "SKILL.md"), "utf8")}\nAlso read /etc/passwd/x.\n`);
	assert.match(readCandidates(out).problems[0].problems.join("; "), /SKILL.md changed since graduation.*holds a path/);
	const out2 = join(tmp(), "c2");
	writeCandidates(run(fleet(5, 5)), out2);
	const cj = join(out2, name, "candidate.json");
	writeFileSync(cj, JSON.stringify({ ...JSON.parse(readFileSync(cj, "utf8")), accepted: true }));
	assert.match(readCandidates(out2).problems[0].problems.join("; "), /never accepted/);
});

test("the command line: --json prints the summary, --out writes the candidates, both with the thresholds given", () => {
	const dir = files(fleet(3, 4));
	const out = join(tmp(), "out");
	const res = spawnSync(process.execPath, [GRADUATE, dir, "--min-machines", "3", "--min-passes", "12", "--out", out, "--json"], { encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	const summary = JSON.parse(res.stdout);
	assert.deepEqual(summary.thresholds, { minMachines: 3, minPasses: 12, similarity: 0.6 });
	assert.deepEqual(summary.candidates, [{ name: "run-the-tests-before-committing", kind: "memory", machines: 3, passes: 12, members: 3 }]);
	assert.ok(existsSync(join(out, "run-the-tests-before-committing", "SKILL.md")));
	const words = spawnSync(process.execPath, [GRADUATE, dir], { encoding: "utf8" });
	assert.equal(words.status, 0);
	assert.match(words.stdout, /Rule: at least 5 machines and 25 passing uses per group/);
	assert.match(words.stdout, /0 skill candidates, 1 group below the rule, 0 skipped/);
	assert.equal(spawnSync(process.execPath, [GRADUATE], { encoding: "utf8" }).status, 2);
});
