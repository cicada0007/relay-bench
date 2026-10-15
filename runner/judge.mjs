// Grading, shared by run-one.mjs (every run) and rejudge.mjs (when a judge is fixed, every tool's runs on that task are
// graded again the same way). The judge always works on a clean copy, in a fresh sandbox the tool never saw.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Sandbox } from "e2b";
import { RUN_PATH, TEMPLATE_NAME } from "../sandbox/template.mjs";

export const sha = (data) => createHash("sha256").update(data).digest("hex");

const SKIP = new Set([".DS_Store", "node_modules", "__pycache__", ".git"]);
/** A content fingerprint of a folder: every file's path and bytes, in sorted order, so the same tree always gives the
 *  same hash (a tarball's hash changes with file times). Used for the public task lock (TASKS.lock.json). */
export function treeHash(dir) {
	const files = [];
	const walk = (d) => {
		for (const name of readdirSync(d)) {
			if (SKIP.has(name) || name.startsWith("._") || name.endsWith(".pyc")) continue;
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else files.push(relative(dir, p));
		}
	};
	walk(dir);
	const hash = createHash("sha256");
	for (const f of files.sort()) {
		hash.update(f);
		hash.update("\0");
		hash.update(readFileSync(join(dir, f)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

/** The fingerprints a task is locked by: what a tool starts from, what it is asked, and how it is graded. */
export function taskHashes(taskDir) {
	return {
		task: sha(readFileSync(join(taskDir, "task.json"))),
		request: sha(readFileSync(join(taskDir, "request.md"))),
		repo: treeHash(join(taskDir, "repo")),
		judge: treeHash(join(taskDir, "judge")),
	};
}

// macOS tar adds AppleDouble "._*" files for extended attributes; in the Linux sandbox they look like broken source and
// test files (the first large pilot's starting repository failed its own lint gate on them). COPYFILE_DISABLE stops
// them; the exclude also drops any already on disk.
export const tar = (dir) =>
	execFileSync("tar", ["-czf", "-", "--exclude", ".DS_Store", "--exclude", "._*", "--exclude", "node_modules", "-C", dir, "."], {
		maxBuffer: 256 * 1024 * 1024,
		env: { ...process.env, COPYFILE_DISABLE: "1" },
	});

export const BASE_ENV = { DO_NOT_TRACK: "1", PATH: RUN_PATH, HOME: "/home/user", TERM: "dumb", CI: "1" };

export async function sh(sandbox, command, options = {}) {
	try {
		// Sandbox commands run in a login shell, which resets PATH from the system profile, so set it in the command.
		const r = await sandbox.commands.run(`export PATH=${RUN_PATH}; ${command}`, { envs: BASE_ENV, ...options });
		return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
	} catch (error) {
		// A non-zero exit is thrown as a CommandExitError carrying the result; a timeout carries no exit code.
		return { exitCode: error.exitCode ?? null, stdout: error.stdout ?? "", stderr: error.stderr || String(error.message ?? error), error: error.name };
	}
}

/** Grades one result tree (a .tgz) with the task's current judge. */
export async function judgeResult(resultTar, taskDir, label) {
	const judgeTar = tar(join(taskDir, "judge"));
	const box = await Sandbox.create(TEMPLATE_NAME, { timeoutMs: 30 * 60_000, metadata: { relayBench: `${label}-judge` } });
	const out = { judgeSandbox: box.sandboxId, judgeSha256: sha(judgeTar) };
	try {
		await box.files.write("/home/user/result.tgz", resultTar);
		await box.files.write("/home/user/judge.tgz", judgeTar);
		const prep = await sh(
			box,
			"mkdir -p /home/user/checkout /home/user/judge && tar -xzf /home/user/result.tgz -C /home/user/checkout && " +
				"tar -xzf /home/user/judge.tgz -C /home/user/judge && cd /home/user/checkout && " +
				"git config --global user.name judge && git config --global user.email judge@example.com && " +
				"git init -q -b main && git add -A && git commit -q -m result",
		);
		if (prep.exitCode !== 0) throw new Error(`judge setup failed: ${prep.stderr.slice(-400)}`);
		const judged = await sh(box, "node /home/user/judge/judge.mjs /home/user/checkout", { timeoutMs: 15 * 60_000 });
		const line = judged.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
		try {
			out.judge = JSON.parse(line);
		} catch {
			out.judge = { error: "judge printed no JSON", stderr: judged.stderr.slice(-600) };
		}
	} finally {
		await box.kill().catch(() => {});
	}
	return out;
}

/** The pre-registered scores for one judge result: parts met only while R0 holds, and the share of checks passed. */
export function scoreOf(task, judge, saidDone) {
	const reqs = judge?.requirements ?? {};
	const R0 = judge?.R0 === true;
	const met = task.requirements.filter((r) => reqs[r] === true && R0).length;
	const score = { requirementsMet: met, requirements: task.requirements.length, share: met / task.requirements.length, R0 };
	const checks = Object.values(judge?.checks ?? {}).filter((c) => Array.isArray(c) && c.length === 2);
	if (checks.length) {
		const total = checks.reduce((s, c) => s + c[1], 0);
		const passed = R0 ? checks.reduce((s, c) => s + c[0], 0) : 0;
		score.checks = { passed, total, share: total ? passed / total : 0 };
	}
	return { score, saidDoneButFailed: saidDone === true && met < task.requirements.length };
}
