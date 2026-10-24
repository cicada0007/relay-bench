// loop/autopilot.mjs, the week carried from the cycle to a pull request, with every external step faked: the cycle's
// run-stage, the harness's npm scripts, git fetch and push, gh, launchctl and the gate's runs. The harness is a
// throwaway git repository, the exam a throwaway folder, and the gate's verdict and the ledger are the real scripts
// reading made-up records. Nothing here reaches a network, a model, a sandbox or the founder's checkouts.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { makePin, pinPathFor, writePin } from "../runner/pins.mjs";
import { afterMerge, examReadiness, EXIT, gateDesign, installSchedule, ruleWords, runWeek, worstWeek } from "./autopilot.mjs";
import { sh, sha256File } from "./build.mjs";
import { nodeScript } from "./cycle.mjs";
import { fakeArchText, fakeExec, practiceTasks, record, sealedExam, SOURCES, writeRecords } from "./fakes.mjs";
import { approve, serializeSettings } from "./meta.mjs";

const SETTINGS = JSON.parse(readFileSync(new URL("./settings.json", import.meta.url), "utf8"));
const AUTOPILOT = new URL("./autopilot.mjs", import.meta.url).pathname;
const REPO = "cicada0007/relay-harness";
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const argOf = (args, name) => args[args.indexOf(name) + 1];

/** A throwaway harness: a git repository with the fake relay.arch, its sources, a package.json at 0.6.121, Relay's
 *  changelog fragments folder, and an origin/main ref where `git fetch` would have put it. */
function fakeHarness() {
	const dir = mkdtempSync(join(tmpdir(), "autopilot-harness-"));
	writeFileSync(join(dir, "relay.arch.json"), fakeArchText());
	writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "relay", private: true, version: "0.6.121" }, null, "\t")}\n`);
	mkdirSync(join(dir, "packages", "coding-agent", ".changes"), { recursive: true });
	writeFileSync(join(dir, "packages", "coding-agent", ".changes", "README.md"), "# Changelog fragments\n");
	for (const [file, text] of Object.entries(SOURCES)) {
		mkdirSync(join(dir, dirname(file)), { recursive: true });
		writeFileSync(join(dir, file), text);
	}
	const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" }).trim();
	git("init", "-q", "-b", "main");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");
	git("add", "-A");
	git("commit", "-q", "-m", "champion");
	git("update-ref", "refs/remotes/origin/main", "HEAD");
	return { dir, git };
}

function world({ approved = 24, examTasks = 24, anchors } = {}) {
	const p = practiceTasks({ everyday: 6, long: 4 });
	const runs = join(p.root, "runs");
	const rs = [
		...["py-l0", "py-l1", "py-l2"].map((task) => record({ task, kind: "long", share: 0.5, saidDoneButFailed: true })),
		...["py-l1", "py-l2", "py-l3"].map((task) => record({ task, kind: "long", share: 0, extra: { timedOut: true } })),
		...["py-e0", "py-e1", "py-e2"].map((task) => record({ task, share: 1 })),
	];
	const records = [writeRecords(runs, rs)];
	const settingsPath = join(p.root, "settings.json");
	writeFileSync(settingsPath, serializeSettings(approve(SETTINGS, { by: "arnav" }).settings));
	return { p, records, settingsPath, harness: fakeHarness(), out: join(p.root, "loop"), work: join(p.root, "work"), ledger: join(p.root, "ledger.json"), examP: sealedExam({ tasks: examTasks, approved, anchors }) };
}

/** The npm registry, made up: each watched package's latest version, published on 23 Oct 2026. */
const fakeRegistry = (latest, { calls = [] } = {}) => async (url) => {
	calls.push(url);
	const pkg = decodeURIComponent(url.split("/").pop());
	const version = latest[pkg];
	if (!version) return { ok: false, status: 404, json: async () => ({}) };
	return { ok: true, status: 200, json: async () => ({ name: pkg, "dist-tags": { latest: version }, time: { [version]: "2026-10-23T21:20:46.540Z" } }) };
};

/**
 * The fake outside world. `gh(args)` answers gh; `verdict` makes the gate's runs: "pass" (the build meets more
 * requirements) or "block" (it meets none); `registry` answers the harness watch's reads of npm. Every call is kept in
 * `calls`.
 */
function fakeOps(w, exam, { gh = () => ok(), verdict = "pass", npmFail = null, now = "2026-10-26T06:00:00Z", registry = null } = {}) {
	const calls = [];
	const logs = [];
	const stage = fakeExec({ calls: [], candidate: () => 1, champion: () => 0.5 });
	const fakeGate = (args) => {
		const out = argOf(args, "--out");
		const test = argOf(args, "--test");
		const version = argOf(args, "--candidate");
		const tasksDir = argOf(args, "--tasks-dir");
		const pinPath = pinPathFor(tasksDir, version);
		if (!existsSync(pinPath)) writePin(pinPath, makePin({ tasksDir, release: version }));
		const ids = argOf(args, "--tasks").split(",").slice(0, Number(argOf(args, "--plan-tasks")));
		const sha = sha256File(argOf(args, "--candidate-package"));
		mkdirSync(out, { recursive: true });
		const rows = [];
		for (const [i, task] of ids.entries()) {
			const share = verdict === "pass" ? { champion: 0.5, candidate: i % 3 ? 1 : 0.9 } : { champion: 1, candidate: 0 };
			for (const [tool, s] of [[`relay@${argOf(args, "--champion")}`, share.champion], [`relay@${version}`, share.candidate]]) {
				rows.push({
					runId: `${test}-${task}-${tool}`, test, task, taskKind: "everyday", tool, model: argOf(args, "--model"), rep: 1, score: { share: s },
					usage: { costUsd: 0.05 }, wallMs: 60_000, startedAt: "2026-10-26T07:00:00.000Z", finishedAt: "2026-10-26T07:01:00.000Z", taskHashes: { judge: exam.judges[task] },
					...(tool.endsWith(version) ? { relayPackageSha256: sha, relayPackageVersion: version } : {}),
				});
			}
		}
		appendFileSync(join(out, "records.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
		// The real gate reads the look, as gate --run does after its runs.
		return nodeScript("runner/gate.mjs", args.filter((a) => a !== "--run"));
	};
	const ops = {
		calls,
		logs,
		run(cmd, args, opts = {}) {
			calls.push([cmd, ...args]);
			if (cmd === "git") {
				if (args.includes("fetch") || args.includes("push")) return ok();
				return sh("git", args, opts);
			}
			if (cmd === "npm") {
				if (npmFail && args[1] === npmFail) return { status: 1, stdout: "", stderr: `${npmFail} failed in a test` };
				if (args[1] === "release:pack") {
					const v = argOf(args, "--version");
					const dir = join(opts.cwd, "packages", "coding-agent", "release", "artifacts");
					mkdirSync(dir, { recursive: true });
					const tree = sh("git", ["-C", opts.cwd, "diff", "HEAD"]).stdout + sh("git", ["-C", opts.cwd, "rev-parse", "HEAD"]).stdout;
					writeFileSync(join(dir, `relay-worker-${v}.tgz`), `a made-up build of ${v}\n${tree}`);
				}
				return ok();
			}
			if (cmd === "gh") return gh(args);
			if (cmd === "launchctl") return ok();
			throw new Error(`a test ran ${cmd}`);
		},
		node(script, args) {
			calls.push(["node", script, ...args]);
			if (script === "runner/run-stage.mjs") return stage(script, args);
			if (script === "runner/gate.mjs") return fakeGate(args);
			return nodeScript(script, args);
		},
		freeGb: () => 100,
		now: () => new Date(now),
		log: (line) => logs.push(line),
		link: () => [],
		env: { RELAY_BENCH_OPENAI_KEY: "made-up", E2B_API_KEY: "made-up" },
		...(registry ? { fetch: registry } : {}),
	};
	return ops;
}

const options = (w, exam, over = {}) => ({
	out: w.out, settingsPath: w.settingsPath, records: w.records, tasksDirs: [w.p.tasks], harness: w.harness.dir, exam: exam.root,
	work: w.work, ledgerPath: w.ledger, model: "gpt-6-luna", spendCap: 30, signedBy: "arnav", scoreboard: join(w.p.root, "no-scoreboard.json"), ...over,
});
const statuses = (r) => r.steps.map((s) => `${s.step}:${s.status}`);
const ghPass = (number = 301) => (args) => {
	if (args[0] === "pr" && args[1] === "create") return ok(`https://github.com/${REPO}/pull/${number}\n`);
	return ok("[]");
};

test("without a spend cap nothing runs, and it says the most the week could cost", async () => {
	const w = world();
	const exam = await w.examP;
	const ops = fakeOps(w, exam);
	const r = await runWeek(options(w, exam, { spendCap: null }), ops);
	assert.equal(r.exitCode, EXIT.NO_CAP);
	assert.deepEqual(statuses(r), ["money:stopped"]);
	assert.match(r.steps[0].why, /no --spend-cap was given, so nothing ran; the most this week could cost is \$\d+\.\d\d of model spend \(\$38\.00 for the loop's lanes, \$48\.00 for a gate of 24 exam tasks\) plus \$\d+\.\d\d of sandbox time/);
	assert.deepEqual(ops.calls, [], "no git, npm, gh or node script ran");
	assert.equal(existsSync(w.out), false, "nothing was written");

	// The command line, the same, exits 3.
	const cli = spawnSync(process.execPath, [AUTOPILOT, "--out", w.out, "--exam", exam.root, "--harness", w.harness.dir, "--settings", w.settingsPath], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: w.p.root } });
	assert.equal(cli.status, 3, cli.stderr);
	assert.match(cli.stdout, /the most this week could cost is/);
	assert.equal(existsSync(w.out), false);
});

test("with fewer than 20 approved exam tasks the week runs the free steps and stops with one plain sentence", async () => {
	const w = world({ approved: 19, examTasks: 21 });
	const exam = await w.examP;
	const ops = fakeOps(w, exam, { gh: ghPass() });
	const r = await runWeek(options(w, exam), ops);
	assert.equal(r.exitCode, EXIT.WAITING);
	assert.equal(ops.logs.at(-1), "The exam has 19 approved tasks and the gate needs 20, so this week stops before anything paid.");
	assert.equal(r.steps.at(-1).step, "ready");
	assert.ok(!ops.calls.some(([c]) => c === "npm" || c === "gh"), "nothing was built and nothing opened");
	assert.ok(!ops.calls.some(([c, s]) => c === "node" && ["runner/run-stage.mjs", "runner/gate.mjs"].includes(s)), "nothing paid ran");
	assert.ok(existsSync(join(w.out, "2026-W44", "cycle.json")), "the cycle's free steps ran and were kept");
	const report = readFileSync(join(w.out, "2026-W44", "autopilot", "report.md"), "utf8");
	assert.match(report, /No pull request this week\.\*\* The exam has 19 approved tasks/);
	assert.match(report, /## What Relay learned about itself/);
});

test("a whole week, every outside step faked: cycle, builds, pre-screen, release, gate PASS, ledger, one pull request", async () => {
	const w = world();
	const exam = await w.examP;
	const registryCalls = [];
	const ops = fakeOps(w, exam, { gh: ghPass(301), registry: fakeRegistry({ "@anthropic-ai/claude-code": "2.1.310", "@openai/codex": "0.163.0" }, { calls: registryCalls }) });
	const r = await runWeek(options(w, exam), ops);
	assert.equal(r.exitCode, EXIT.DONE, JSON.stringify(r.steps, null, 1));
	assert.deepEqual(statuses(r), ["harnesses:ran", "pull request:ran", "harness:ran", "ready:ran", "cycle:ran", "build:ran", "prescreen:ran", "package:ran", "release:ran", "gate:ran", "ledger:ran", "pull request:ran"]);

	// The harness watch: one read of npm per harness, a new Claude Code queued as an exam stage for a person, and its
	// line in the cycle's notes; nothing of it ran.
	assert.deepEqual(registryCalls, ["https://registry.npmjs.org/@anthropic-ai%2fclaude-code", "https://registry.npmjs.org/@openai%2fcodex"]);
	const queued = readFileSync(join(exam.root, "queue", "harness-watch.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(queued.map((q) => [q.id, q.test, q.week, q.status]), [["claude-code@2.1.310", "bar-1-haiku-claude-code-2.1.310", "2026-W44", "waiting for a person"]]);
	assert.ok(!ops.calls.some((c) => c.includes("bar-1-haiku-claude-code-2.1.310")), "no step started the queued stage");
	const cycleState = JSON.parse(readFileSync(join(w.out, "2026-W44", "cycle.json"), "utf8"));
	assert.ok(cycleState.notes.some((n) => /^Claude Code 2\.1\.310 came out on 23 Oct 2026 \(the benchmark pins 2\.1\.300\): its exam stage bar-1-haiku-claude-code-2\.1\.310 is queued for a person/.test(n)), cycleState.notes.join("\n"));
	assert.ok(cycleState.notes.some((n) => /^Codex: 0\.163\.0 is the latest published version and the one the benchmark pins; nothing new$/.test(n)));
	const st = r.state;
	assert.equal(st.build, "0.6.122-loop.2026w44");
	assert.equal(st.champion, "0.6.121");

	// Each proposal's build, then the release's: arch, (check), build, pack, in that order, at the local build's version.
	const npm = ops.calls.filter(([c]) => c === "npm").map((c) => c.slice(1, 3).join(" "));
	const proposals = Object.keys(st.builds);
	assert.ok(proposals.length >= 2);
	assert.deepEqual(npm.slice(-4), ["run arch", "run check", "run build", "run release:pack"]);
	assert.equal(npm.filter((s) => s === "run check").length, 1, "npm run check runs on the release");
	const pack = ops.calls.filter(([c, , s]) => c === "npm" && s === "release:pack").at(-1);
	assert.equal(argOf(pack, "--version"), "0.6.122-loop.2026w44");
	assert.equal(argOf(pack, "--base-url"), "https://relayevals.com/harness");
	assert.ok(ops.calls.some(([c, ...a]) => c === "git" && a.includes("apply") && a.at(-1).endsWith("release.patch")));

	// The release was committed on origin/main plus the patch, and that commit is what was pushed.
	const base = w.harness.git("rev-parse", "origin/main");
	assert.equal(st.base, base);
	assert.notEqual(st.release.commit, base);
	assert.equal(w.harness.git("rev-parse", `${st.release.commit}^`), base);
	assert.notEqual(w.harness.git("show", `${st.release.commit}:relay.arch.json`), w.harness.git("show", `${base}:relay.arch.json`));
	// The release's changelog fragment is in that commit, with the pre-screen's numbers (the commit is fixed before the gate).
	const fragment = w.harness.git("show", `${st.release.commit}:packages/coding-agent/.changes/loop-2026-w44.md`);
	assert.match(fragment, /^- In week 2026-W44 Relay learned .+; its pre-screens? measured .+ It changes no row of the router's starting table, and this week's new harness version is Claude Code 2\.1\.310 \(its exam stage is queued for a person\)\.$/);
	assert.doesNotMatch(fragment, /the gate on the exam measured/);
	const push = ops.calls.find(([c, ...a]) => c === "git" && a.includes("push"));
	assert.equal(push.at(-1), `${st.release.commit}:refs/heads/loop/2026-W44`);
	assert.match(w.harness.git("worktree", "list"), /^[^\n]+$/, "every worktree was removed");
	assert.equal(spawnSync("git", ["-C", w.harness.dir, "rev-parse", "--verify", "-q", "refs/relay-autopilot/2026-W44"]).status, 1, "the hidden ref is gone");

	// The gate judged the local build's package, on the exam's approved tasks, combined when two lanes or more.
	const gate = ops.calls.find(([c, s]) => c === "node" && s === "runner/gate.mjs");
	assert.equal(argOf(gate, "--candidate"), "0.6.122-loop.2026w44");
	assert.equal(argOf(gate, "--tier"), "exam");
	assert.equal(sha256File(argOf(gate, "--candidate-package")), st.release.sha256);
	assert.equal(argOf(gate, "--tasks").split(",").length, 24);
	assert.equal(gate.includes("--combined"), existsSync(join(w.out, "2026-W44", "release", "lanes.json")));
	assert.equal(st.gate.status, "PASS");

	// The ledger: written by scripts/ledger.mjs from the gate's records, with the build's hash.
	const ledger = JSON.parse(readFileSync(w.ledger, "utf8"));
	assert.equal(ledger.entries.length, 1);
	const entry = ledger.entries[0];
	assert.equal(entry.release, "0.6.122-loop.2026w44");
	assert.equal(entry.champion, "0.6.121");
	assert.equal(entry.build.sha256, st.release.sha256);
	assert.deepEqual(entry.signers, ["arnav"]);

	// One pull request, in the harness, labelled, its body the package's plus the gate's numbers.
	const created = ops.calls.filter(([c, ...a]) => c === "gh" && a[0] === "pr" && a[1] === "create");
	assert.equal(created.length, 1);
	const pr = created[0];
	assert.equal(argOf(pr, "--repo"), REPO);
	assert.equal(argOf(pr, "--label"), "no-linear");
	assert.equal(argOf(pr, "--base"), "main");
	assert.equal(argOf(pr, "--head"), "loop/2026-W44");
	assert.ok(ops.calls.filter(([c]) => c === "gh").every((c) => c.includes("--repo")), "--repo on every gh command");
	const body = readFileSync(argOf(pr, "--body-file"), "utf8");
	for (const part of ["## What Relay learned this week", "## The changes", "## The gate on the exam", "Verdict: PASS (exit 0)", st.release.sha256, "## The ledger entry", "## Roll back", "## Reproduce", "--candidate-package"]) assert.ok(body.includes(part), part);
	// What Relay learned, said with the gate's numbers: the change, the gate's difference and interval, the router rows
	// and the harness version tried for the first time; numbers only.
	const learned = body.slice(body.indexOf("## What Relay learned this week"), body.indexOf("## The changes"));
	assert.equal(learned.split("\n").filter((l) => l.trim() && !l.startsWith("#")).length, 1, learned);
	assert.match(learned, /^## What Relay learned this week\n\nIn week 2026-W44 Relay learned .+; the gate on the exam measured [+-]\d+\.\d points of requirements met against relay@0\.6\.121 \(interval -?\d+\.\d to -?\d+\.\d, 24 tasks, PASS\)\. It changes no row of the router's starting table, and this week's new harness version is Claude Code 2\.1\.310 \(its exam stage is queued for a person\)\.\n/);
	assert.doesNotMatch(learned, /\b(better|worse|beats?|wins?)\b/i);
	assert.equal(st.learned.length, 2);
	assert.equal(st.learned.join(" "), learned.split("\n\n")[1].trim());
	const packaged = readFileSync(join(w.out, "2026-W44", "release", "PR_BODY.md"), "utf8");
	assert.match(packaged, /## What Relay learned this week\n\nIn week 2026-W44 Relay learned .+; its pre-screens? measured /, "before the gate, the package's body has the pre-screen's numbers");
	const added = body.slice(body.indexOf("## The gate on the exam"));
	assert.doesNotMatch(added, /\b(better|worse)\b/i, "numbers only");
	assert.doesNotMatch(body, /## How it is judged/, "the package's how-to is replaced by what was done");

	const g = JSON.parse(readFileSync(join(w.out, "autopilot.json"), "utf8"));
	assert.deepEqual(g.prs.map((p) => [p.number, p.status, p.build]), [[301, "open", "0.6.122-loop.2026w44"]]);
	const report = readFileSync(join(w.out, "2026-W44", "autopilot", "report.md"), "utf8");
	assert.match(report, /\*\*A pull request waits for you:\*\* https:\/\/github\.com\/cicada0007\/relay-harness\/pull\/301/);
	for (const part of ["## What Relay learned about itself", "## What it proposed", "## New harness versions", "## What it tested", "## What it cost"]) assert.ok(report.includes(part), part);
	assert.match(report, /- Claude Code 2\.1\.310 came out on 23 Oct 2026 .*queued for a person/);
	assert.match(report, /It says: In week 2026-W44 Relay learned /);
	assert.match(readFileSync(join(w.out, "2026-W44", "report.md"), "utf8"), /Notes: .*Claude Code 2\.1\.310 came out on 23 Oct 2026/, "a line in the week's notes");
	assert.doesNotMatch(report, /\b(better|worse)\b/i);

	// Money: within the cap.
	const spent = st.spend.reduce((s, e) => s + e.usd, 0);
	assert.ok(spent > 0 && spent <= 30, String(spent));

	// Run again: nothing is built, gated, written or opened twice; last week's pull request now waits.
	const again = fakeOps(w, exam, { gh: (args) => (args[1] === "view" ? ok(JSON.stringify({ number: 301, state: "OPEN", url: `https://github.com/${REPO}/pull/301` })) : ok()) });
	const r2 = await runWeek(options(w, exam), again);
	assert.equal(r2.exitCode, EXIT.WAITING);
	assert.match(r2.steps.at(-1).why, /pull request #301 .* still waits for a person/);
	assert.ok(!again.calls.some(([c, ...a]) => c === "npm" || (c === "gh" && a[1] === "create")));
	assert.equal(JSON.parse(readFileSync(w.ledger, "utf8")).entries.length, 1);
});

test("on BLOCK no pull request opens and no ledger entry is written", async () => {
	const w = world();
	const exam = await w.examP;
	const ops = fakeOps(w, exam, { gh: ghPass(), verdict: "block" });
	const r = await runWeek(options(w, exam), ops);
	assert.equal(r.exitCode, EXIT.BLOCK);
	assert.equal(r.state.gate.status, "BLOCK");
	assert.deepEqual(r.steps.at(-1), { step: "pull request", status: "skipped", why: "the gate gave BLOCK, so no pull request is opened and no ledger entry is written." });
	assert.ok(!ops.calls.some(([c, ...a]) => (c === "gh" && a[1] === "create") || (c === "git" && a.includes("push"))));
	assert.ok(!ops.calls.some(([c, s, a]) => c === "node" && s === "scripts/ledger.mjs" && a === "write"), "the ledger was not asked");
	assert.equal(existsSync(w.ledger), false);
	const report = readFileSync(join(w.out, "2026-W44", "autopilot", "report.md"), "utf8");
	assert.match(report, /No pull request this week/);
	assert.match(report, /Verdict: BLOCK \(exit 10\)/);
});

test("the ledger is written only on PASS: a failed check, a failed build, or no proposal opens nothing", async () => {
	const w = world();
	const exam = await w.examP;
	const ops = fakeOps(w, exam, { gh: ghPass(), npmFail: "check" });
	const r = await runWeek(options(w, exam), ops);
	assert.equal(r.exitCode, EXIT.FAILED);
	assert.equal(r.steps.at(-1).step, "release");
	assert.match(r.steps.at(-1).why, /npm run check failed \(exit 1\).*no pull request/);
	assert.ok(!ops.calls.some(([c, s]) => c === "node" && s === "runner/gate.mjs"), "an unchecked release never reaches the gate");
	assert.ok(!ops.calls.some(([c]) => c === "gh"));
	assert.equal(existsSync(w.ledger), false);
	assert.match(w.harness.git("worktree", "list"), /^[^\n]+$/, "the worktree was removed after the failure");
});

test("after a merge, the release that holds it becomes the champion, and the next PASS follows it in the ledger", async () => {
	const w = world();
	const exam = await w.examP;
	const first = await runWeek(options(w, exam), fakeOps(w, exam, { gh: ghPass(301) }));
	assert.equal(first.exitCode, EXIT.DONE);
	const commit = first.state.release.commit;

	// Merged, and no release holds it yet: the champion stays, and the next week waits.
	const merged = (releases) => (args) => {
		if (args[1] === "view") return ok(JSON.stringify({ number: 301, state: "MERGED", mergedAt: "2026-10-27T10:00:00Z", mergeCommit: { oid: commit }, url: `https://github.com/${REPO}/pull/301` }));
		if (args[0] === "release") return ok(JSON.stringify(releases));
		if (args[1] === "create") return ok(`https://github.com/${REPO}/pull/302\n`);
		return ok();
	};
	const waitOps = fakeOps(w, exam, { gh: merged([{ tagName: "v0.6.121", isDraft: false, isPrerelease: false }]), now: "2026-11-02T06:00:00Z" });
	const wait = afterMerge(301, options(w, exam), waitOps);
	assert.equal(wait.status, "merged");
	assert.match(waitOps.logs.at(-1), /merged and no release holds it yet/);
	const week = await runWeek(options(w, exam), fakeOps(w, exam, { gh: merged([]), now: "2026-11-02T06:00:00Z" }));
	assert.equal(week.exitCode, EXIT.WAITING);
	assert.match(week.steps.at(-1).why, /merged and no release holds it yet/);

	// A release that holds the merge: main moves to the merge, then to the release commit of 0.6.122, tagged.
	w.harness.git("checkout", "-q", "--detach", commit);
	writeFileSync(join(w.harness.dir, "package.json"), `${JSON.stringify({ name: "relay", private: true, version: "0.6.122" }, null, "\t")}\n`);
	w.harness.git("commit", "-q", "-am", "Release v0.6.122");
	w.harness.git("tag", "v0.6.122");
	w.harness.git("update-ref", "refs/remotes/origin/main", "HEAD");
	const releasedOps = fakeOps(w, exam, { gh: merged([{ tagName: "v0.6.122", isDraft: false, isPrerelease: false }, { tagName: "v0.6.122-beta.9", isDraft: false, isPrerelease: true }]), now: "2026-11-02T06:00:00Z" });
	const released = afterMerge(301, options(w, exam), releasedOps);
	assert.equal(released.status, "released");
	assert.deepEqual([released.champion.version, released.champion.holds], ["0.6.122", "0.6.122-loop.2026w44"]);
	assert.match(releasedOps.logs.at(-1), /Relay 0\.6\.122 holds pull request #301 \(the local build 0\.6\.122-loop\.2026w44\); it is the champion for the next cycle/);

	// The next week: measured against 0.6.122, and its ledger entry follows the build 0.6.122 shipped.
	const next = fakeOps(w, exam, { gh: merged([{ tagName: "v0.6.122", isDraft: false, isPrerelease: false }]), now: "2026-11-02T06:00:00Z" });
	const r = await runWeek(options(w, exam), next);
	assert.equal(r.exitCode, EXIT.DONE, JSON.stringify(r.steps, null, 1));
	assert.equal(r.state.champion, "0.6.122");
	const ledgerCall = next.calls.find(([c, s, a]) => c === "node" && s === "scripts/ledger.mjs" && a === "write");
	assert.equal(argOf(ledgerCall, "--follows"), "0.6.122-loop.2026w44");
	const ledger = JSON.parse(readFileSync(w.ledger, "utf8"));
	assert.deepEqual(ledger.entries.map((e) => [e.release, e.champion, e.follows ?? null]), [["0.6.122-loop.2026w44", "0.6.121", null], ["0.6.123-loop.2026w45", "0.6.122", "0.6.122-loop.2026w44"]]);
});

test("the weekly schedule carries no key: zsh reads ~/.zshenv, and the model key comes from the Keychain at run time", () => {
	const root = mkdtempSync(join(tmpdir(), "autopilot-schedule-"));
	const fakeKey = "sk-proj-abcdefghijklmnop1234";
	const saved = process.env.RELAY_BENCH_OPENAI_KEY;
	process.env.RELAY_BENCH_OPENAI_KEY = fakeKey;
	const calls = [];
	const logs = [];
	try {
		const r = installSchedule({ spendCap: 20, signedBy: "arnav", plist: join(root, "agent.plist"), logDir: join(root, "logs") }, { run: (cmd, args) => (calls.push([cmd, ...args]), ok()), log: (l) => logs.push(l) });
		const text = readFileSync(r.path, "utf8");
		assert.equal(text, r.text);
		for (const part of ["<string>/bin/zsh</string>", "<string>--spend-cap</string>", "<string>20</string>", "<string>--keychain</string>", "<string>relay-openai</string>", "<key>Weekday</key>", "loop/autopilot.mjs"]) assert.ok(text.includes(part), part);
		assert.ok(!text.includes(fakeKey));
		assert.doesNotMatch(text, /sk-|e2b_|_KEY|_TOKEN|ANTHROPIC|OPENAI_API/);
		assert.deepEqual(calls.map((c) => c.slice(0, 2)), [["launchctl", "bootout"], ["launchctl", "bootstrap"]], "only the fake launchctl ran");
		const cron = logs.find((l) => l.includes("crontab"));
		assert.match(cron, /^0 6 \* \* 1 \. \$HOME\/\.relay-autopilot\.env && cd /m);
		assert.ok(!cron.includes(fakeKey) && !cron.includes("--keychain"));
		const lint = spawnSync("plutil", ["-lint", r.path], { encoding: "utf8" });
		if (!lint.error) assert.equal(lint.status, 0, lint.stdout + lint.stderr);
	} finally {
		if (saved === undefined) delete process.env.RELAY_BENCH_OPENAI_KEY;
		else process.env.RELAY_BENCH_OPENAI_KEY = saved;
	}
	assert.throws(() => installSchedule({ spendCap: 20, signedBy: "arnav", plist: join(root, "x.plist"), logDir: root, scheduleExtra: ["--records", `/tmp/${fakeKey}`] }, { run: () => ok(), log: () => {} }), /never carries a key/);
	assert.throws(() => installSchedule({ spendCap: null, signedBy: "arnav", plist: join(root, "y.plist"), logDir: root }, { run: () => ok(), log: () => {} }), /--spend-cap/);
	// The command line refuses a schedule without a cap before it writes or loads anything (only this case runs here:
	// with a cap it would load a real launchd job).
	const cli = spawnSync(process.execPath, [AUTOPILOT, "--install-schedule", "weekly", "--signed-by", "arnav"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root } });
	assert.notEqual(cli.status, 0);
	assert.match(cli.stderr, /a schedule needs the weekly --spend-cap/);
	assert.equal(existsSync(join(root, "Library")), false);
});

test("the exam's readiness, the gate's design and the worst case, in numbers", async () => {
	const none = examReadiness(join(tmpdir(), "no-such-exam-here"));
	assert.equal(none.ok, false);
	const unlocked = await sealedExam({ tasks: 22, approved: 22, lock: false, anchors: false });
	assert.match(examReadiness(unlocked.root).sentence, /22 approved tasks but 0 match their lock/);
	const noAnchors = await sealedExam({ tasks: 22, approved: 22, anchors: false });
	assert.match(examReadiness(noAnchors.root).sentence, /no anchor set.*anchors\.mjs create --version anchors-v1 .* --sample 22\.$/);
	const ready = await sealedExam({ tasks: 70, approved: 66 });
	const r = examReadiness(ready.root);
	assert.equal(r.ok, true);
	assert.equal(r.usable.length, 66);
	assert.deepEqual(gateDesign(21), { spending: "fixed", looks: 1, plannedTasks: 21 });
	assert.deepEqual(gateDesign(66), { spending: "obrien-fleming", looks: 3, plannedTasks: 66 });
	assert.deepEqual(gateDesign(500).plannedTasks, 120);
	const w = worstWeek({ settings: SETTINGS, tasks: 21 });
	assert.deepEqual([w.lanesUsd, w.gateUsd, w.modelUsd, w.sandboxUsd], [38, 42, 80, 40]);
	assert.equal(ruleWords("no worse"), "the interval's low end is above -5");
	assert.equal(ruleWords("worse on long tasks"), "the interval on long tasks is below -5");
});
