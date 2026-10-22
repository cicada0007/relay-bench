// Hidden judge for a task drafted from a public pull request (scripts/draft-task.mjs copies this file, unchanged, into
// the task's judge/ folder, beside judge.json and the two test runners).
//
//   node judge/judge.mjs <checkout>              one JSON line in TASK_FORMAT.md's shape; always exits 0
//   node judge/judge.mjs <checkout> --outcomes   every test's outcome instead, for draft-task to choose the checks
//
// 1. Runs the repository's gates (judge.json "gates", the same as task.json) on a copy of the checkout.
// 2. On a second copy, puts back the hidden test files: the pull request's own test files (judge/hidden/, as the pull
//    request left them) and the starting repository's other test files (judge/original/, unchanged). Whatever the tool
//    did to those files, these are the versions that run.
// 3. Runs each test file among them ("tests.run") in its own process, with a time limit, and reads every test's outcome.
// 4. R1 holds when every test in judge.json "checks.R1" passes: the tests the pull request added or changed that fail
//    on the starting repository and pass on the pull request's own result. R0 holds when every test in "checks.R0"
//    passes: the tests that passed both before and after the pull request.
//
// Node 22 standard library and python3 only; no network.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, "judge.json"), "utf8"));
const GATE_SECONDS = config.limits?.gateSeconds ?? 150;
const FILE_SECONDS = config.limits?.fileSeconds ?? 90;
const CONCURRENCY = 4;
const SKIP = new Set([".git", "node_modules", "__pycache__", ".DS_Store"]);
const scratch = [];

function env() {
	const base = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1", NODE_ENV: "test", CI: "1" };
	for (const key of ["PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONSAFEPATH", "PYTHONWARNINGS", "NODE_OPTIONS", "NODE_TEST_CONTEXT"]) {
		delete base[key];
	}
	return base;
}

function tempCopy(from, prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratch.push(dir);
	cpSync(from, dir, { recursive: true, filter: (src) => !SKIP.has(basename(src)) });
	return dir;
}

/** Runs a command in its own process group; on time-out the whole group is killed. Resolves { ok, why, timedOut }. */
function limited(command, args, { cwd, seconds }) {
	return new Promise((done) => {
		let output = "";
		let timedOut = false;
		let child;
		try {
			child = spawn(command, args, { cwd, env: env(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			done({ ok: false, why: String(error), timedOut: false });
			return;
		}
		const keep = (chunk) => {
			output = (output + chunk).slice(-4000);
		};
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
		}, seconds * 1000);
		child.on("error", (error) => keep(String(error)));
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			const why = timedOut ? `timed out after ${seconds}s` : `exit ${code}${signal ? ` (${signal})` : ""}: ${output.trim().slice(-500)}`;
			done({ ok: !timedOut && code === 0, why, timedOut });
		});
	});
}

/** Puts the hidden test files into a copy of the checkout. */
function overlay(dir) {
	for (const [folder, files] of [["original", config.tests.original], ["hidden", config.tests.hidden]]) {
		for (const file of files) {
			const target = join(dir, file);
			mkdirSync(dirname(target), { recursive: true });
			cpSync(join(here, folder, file), target);
		}
	}
}

/** Runs one test file with this stack's runner; resolves { tests: [{ id, outcome }], why }. */
async function runFile(dir, file) {
	const work = mkdtempSync(join(tmpdir(), "judge-file-"));
	scratch.push(work);
	const report = join(work, "report.json");
	const run =
		config.stack === "python"
			? await limited("python3", [join(here, "run_py_tests.py"), dir, file, report, JSON.stringify(config.pythonPath ?? [])], { cwd: dir, seconds: FILE_SECONDS })
			: await limited(process.execPath, [join(here, "run-node-tests.mjs"), join(dir, file), report], { cwd: dir, seconds: FILE_SECONDS });
	let parsed = null;
	try {
		parsed = JSON.parse(readFileSync(report, "utf8"));
	} catch {}
	if (!parsed) return { tests: [], why: run.why };
	return { tests: parsed.tests.map((t) => ({ id: `${file}::${t.name}`, outcome: t.outcome })), why: parsed.error ?? (run.ok ? "" : run.why) };
}

/** Every test's outcome on the checkout, with the hidden files in place: { outcomes: { id: outcome }, files: { file: why } }. */
async function outcomesOf(checkout) {
	const dir = tempCopy(checkout, "judge-tests-");
	overlay(dir);
	// Helpers and fixtures are put back too, but only the test files are run.
	const files = config.tests.run ?? [...config.tests.original, ...config.tests.hidden];
	const results = new Array(files.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => {
			while (next < files.length) {
				const index = next++;
				results[index] = await runFile(dir, files[index]);
			}
		}),
	);
	const rank = { fail: 3, skip: 2, pass: 1 };
	const outcomes = {};
	const notes = {};
	results.forEach((result, index) => {
		if (result.why) notes[files[index]] = result.why;
		for (const t of result.tests) {
			// A name used twice in one file counts as one test that passes only when every copy passes.
			if (!outcomes[t.id] || rank[t.outcome] > rank[outcomes[t.id]]) outcomes[t.id] = t.outcome;
		}
	});
	return { outcomes, files: notes };
}

async function grade(checkout) {
	const result = {
		task: config.task,
		gates: Object.fromEntries(Object.keys(config.gates).map((gate) => [gate, false])),
		requirements: { R1: false },
		R0: false,
		checks: { R1: [0, config.checks.R1.length] },
		notes: {},
	};
	const gateDir = tempCopy(checkout, "judge-gates-");
	for (const [gate, command] of Object.entries(config.gates)) {
		const run = await limited("sh", ["-c", command], { cwd: gateDir, seconds: GATE_SECONDS });
		result.gates[gate] = run.ok;
		if (!run.ok) result.notes[`gate ${gate}`] = run.why;
	}
	const { outcomes, files } = await outcomesOf(checkout);
	const failed = (ids) => ids.filter((id) => outcomes[id] !== "pass");
	const note = (ids) => `${ids.length} failed: ${ids.slice(0, 5).join("; ")}${ids.length > 5 ? "; ..." : ""}`;
	const r1 = failed(config.checks.R1);
	result.checks.R1 = [config.checks.R1.length - r1.length, config.checks.R1.length];
	result.requirements.R1 = config.checks.R1.length > 0 && r1.length === 0;
	if (r1.length) result.notes.R1 = note(r1);
	const r0 = failed(config.checks.R0);
	result.R0 = r0.length === 0;
	if (r0.length) result.notes.R0 = note(r0);
	const fileNotes = Object.entries(files).filter(([, why]) => why);
	if (fileNotes.length) result.notes.files = fileNotes.map(([f, why]) => `${f}: ${why}`).join(" | ").slice(0, 1500);
	return result;
}

let line = { task: config.task, gates: {}, requirements: { R1: false }, R0: false, checks: { R1: [0, 0] }, notes: {} };
try {
	if (!process.argv[2]) throw new Error("usage: node judge/judge.mjs <checkout> [--outcomes]");
	const checkout = resolve(process.argv[2]);
	if (!existsSync(checkout)) throw new Error(`no such checkout: ${checkout}`);
	line = process.argv.includes("--outcomes") ? await outcomesOf(checkout) : await grade(checkout);
} catch (error) {
	line.notes = { ...(line.notes ?? {}), judge: String(error?.stack ?? error).slice(0, 600) };
} finally {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
	console.log(JSON.stringify(line));
	process.exit(0);
}
