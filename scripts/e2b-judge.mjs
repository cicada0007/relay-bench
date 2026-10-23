// Where a task's judge runs while the task is being made: in an E2B sandbox, or (tests only) on this machine.
//
// A mined candidate is someone else's code. Its judge runs that repository's own tests and gates (npm test, for one),
// so draft-task.mjs's judge check and validate-task.mjs on an exam task run them in an E2B sandbox from the round's image
// (sandbox/template.mjs), never on the machine that drafts. One sandbox per task: the task folder (repo/, reference/,
// judge/) goes in as one tarball, every judge run happens inside it, and it is killed at the end. It gets no keys: the
// sandbox is created with no environment of its own, and every command runs with runner/judge.mjs BASE_ENV only. Its
// seconds are recorded and priced at E2B's list price, and counted against the drafting ledger's E2B cap
// (scripts/draft-spend.mjs) before the sandbox starts.
//
// The local judge is the same interface on this machine, for tests with made-up repositories.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_ENV, sh, tar } from "../runner/judge.mjs";
import { TEMPLATE_NAME } from "../sandbox/template.mjs";
import { E2B_USD_PER_SECOND } from "./draft-spend.mjs";

/** How long a sandbox may live, and one judge run in it (TASK_FORMAT.md: a judge run takes under 5 minutes). */
export const SANDBOX_MINUTES = 30;
export const RUN_MINUTES = 10;
const HOME = "/home/user";
const TASK = `${HOME}/task`;
const TREES = new Set(["repo", "reference"]);

const lastJson = (stdout) => JSON.parse(String(stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "");

/** Copies a tree into a fresh git repository first, as validate-task.mjs does, so the judge sees what a tool would leave. */
const checkoutCommand = (tree, to) =>
	`rm -rf ${to} && mkdir -p ${to} && cp -a ${TASK}/${tree}/. ${to}/ && cd ${to} && git init -q -b main && git add -A && ` +
	"git -c user.name=bench -c user.email=bench@example.com -c commit.gpgsign=false commit -q --allow-empty -m start";

/**
 * Opens a judge for the task folder `dir` in a fresh E2B sandbox. Returns { where, sandboxId, run, put, close }:
 *   run(tree, { outcomes, checkout })  runs judge/judge.mjs on repo/ or reference/; resolves its JSON line
 *   put(path, text)                    replaces one file of the uploaded folder (judge/judge.json, once the checks are chosen)
 *   close()                            kills the sandbox; resolves { where, sandboxId, seconds, costUsd }
 * `ledger` (scripts/draft-spend.mjs) is charged; `Sandbox` is the e2b SDK's, or a fake in tests.
 */
export async function openE2BJudge({ dir, label, purpose = "judge", ledger, Sandbox, minutes = SANDBOX_MINUTES, runMinutes = RUN_MINUTES, clock = Date.now, log = () => {} }) {
	if (!Sandbox) ({ Sandbox } = await import("e2b"));
	const folder = tar(dir);
	const boundUsd = minutes * 60 * E2B_USD_PER_SECOND;
	const entry = ledger?.reserve("e2b", { boundUsd, label, purpose, template: TEMPLATE_NAME, limitMinutes: minutes });
	const started = clock();
	const charge = (fields) => {
		const seconds = Math.max(0, (clock() - started) / 1000);
		const costUsd = seconds * E2B_USD_PER_SECOND;
		ledger?.settle("e2b", entry, { seconds: Math.round(seconds * 10) / 10, costUsd, ...fields });
		return { seconds, costUsd };
	};
	let box;
	try {
		// No envs: nothing of this machine's environment, and no key, goes into the sandbox.
		box = await Sandbox.create(TEMPLATE_NAME, { timeoutMs: minutes * 60_000, envs: {}, metadata: { relayBench: `${purpose}-${label}` } });
	} catch (error) {
		charge({ error: String(error?.message ?? error).slice(0, 300) });
		throw new Error(`${label}: could not start an E2B sandbox: ${error?.message ?? error}`);
	}
	const sandboxId = box.sandboxId;
	let closed;
	let runs = 0;
	const close = async () => {
		if (closed) return closed;
		await box.kill().catch(() => {});
		const { seconds, costUsd } = charge({ sandboxId, killed: true });
		closed = { where: "e2b", sandboxId, seconds, costUsd };
		log(`${label}: E2B sandbox ${sandboxId} killed after ${seconds.toFixed(1)}s, about $${costUsd.toFixed(4)}`);
		return closed;
	};
	try {
		await box.files.write(`${HOME}/task.tgz`, folder);
		const unpacked = await sh(box, `mkdir -p ${TASK} && tar -xzf ${HOME}/task.tgz -C ${TASK} && rm ${HOME}/task.tgz`, { envs: BASE_ENV });
		if (unpacked.exitCode !== 0) throw new Error(`unpacking the task failed: ${unpacked.stderr.slice(-400)}`);
	} catch (error) {
		await close();
		throw new Error(`${label}: ${error.message}`);
	}
	return {
		where: "e2b",
		sandboxId,
		async run(tree, { outcomes = false, checkout = false } = {}) {
			if (!TREES.has(tree)) throw new Error(`not a tree to judge: ${tree}`);
			let target = `${TASK}/${tree}`;
			if (checkout) {
				target = `${HOME}/checkout-${tree}`;
				const made = await sh(box, checkoutCommand(tree, target), { envs: BASE_ENV });
				if (made.exitCode !== 0) throw new Error(`${label}: making a checkout of ${tree}/ failed: ${made.stderr.slice(-400)}`);
			}
			const t0 = Date.now();
			// The judge prints its line and exits at once; on a pipe that is not drained in time a long line (every outcome
			// of a large suite) is cut at the pipe's 64 KiB. A file takes the whole line, so the line is read from one.
			const outFile = `${HOME}/judge-run-${++runs}.out`;
			const r = await sh(box, `node ${TASK}/judge/judge.mjs ${target}${outcomes ? " --outcomes" : ""} > ${outFile}`, { envs: BASE_ENV, timeoutMs: runMinutes * 60_000 });
			log(`${label}: judge on ${tree}/${outcomes ? " (every outcome)" : ""} in the sandbox: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
			const out = String(await box.files.read(outFile).catch(() => ""));
			try {
				return lastJson(out);
			} catch {
				throw new Error(`${label}: the judge printed no JSON on ${tree}/ in the sandbox (exit ${r.exitCode}; ${out.length} bytes out, ending ${JSON.stringify(out.slice(-200))}): ${String(r.stderr).slice(-400)}`);
			}
		},
		async put(path, text) {
			await box.files.write(`${TASK}/${path}`, text);
		},
		close,
	};
}

/** The same judge on this machine, for tests with made-up repositories only (draft-task.mjs --local-judge). */
export function openLocalJudge({ dir, label = "local" }) {
	const started = Date.now();
	return {
		where: "local",
		async run(tree, { outcomes = false, checkout = false } = {}) {
			if (!TREES.has(tree)) throw new Error(`not a tree to judge: ${tree}`);
			let target = join(dir, tree);
			let cleanup = () => {};
			if (checkout) ({ target, cleanup } = localCheckout(target));
			try {
				const out = execFileSync(process.execPath, [join(dir, "judge", "judge.mjs"), target, ...(outcomes ? ["--outcomes"] : [])], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 15 * 60_000,
					maxBuffer: 64 * 1024 * 1024,
				});
				return lastJson(out);
			} catch (error) {
				throw new Error(`${label}: the judge printed no JSON on ${tree}/: ${String(error.stderr ?? error.message).slice(-400)}`);
			} finally {
				cleanup();
			}
		},
		async put(path, text) {
			writeFileSync(join(dir, path), text);
		},
		async close() {
			return { where: "local", seconds: (Date.now() - started) / 1000, costUsd: 0 };
		},
	};
}

function localCheckout(from) {
	const target = mkdtempSync(join(tmpdir(), "relay-bench-"));
	cpSync(from, target, { recursive: true });
	const git = (...args) => execFileSync("git", args, { cwd: target, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git("-c", "user.name=bench", "-c", "user.email=bench@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "start");
	return { target, cleanup: () => rmSync(target, { recursive: true, force: true }) };
}
