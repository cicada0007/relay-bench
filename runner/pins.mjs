// Graders pinned per release (TIERS.md, "The living exam"): before a release's gate on the exam, the fingerprint of
// every sealed task's judge is written down under the release's id. Every run counted for that release must have been
// graded by exactly that judge. A judge fixed later (runner/rejudge.mjs) grades every tool's runs again, as before, but
// a release already pinned keeps its graders: its gate refuses runs graded by another judge (UNRESOLVED, "graders not
// pinned"), so a release is never re-judged by a grader that did not exist when it was gated.
//
// A pin is `pins/<release>.json` beside the exam's tasks folder: { release, pinnedAt, lock, tasks: { id: judgeHash } }.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { taskHashes } from "./judge.mjs";

export const pinsDirFor = (tasksDir) => join(dirname(resolve(tasksDir)), "pins");
export const pinPathFor = (tasksDir, release) => {
	if (!/^[0-9A-Za-z.+-]+$/.test(release ?? "")) throw new Error(`not a release id: ${release}`);
	return join(pinsDirFor(tasksDir), `${release}.json`);
};

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
/** A fingerprint of a pin that names no task: safe for the public ledger. */
export const pinFingerprint = (pin) => sha256(JSON.stringify([pin.release, pin.lock, Object.keys(pin.tasks).sort().map((id) => [id, pin.tasks[id]])]));

/**
 * A pin for `release` from the exam's lock: every locked task's judge fingerprint as it is now. `hashesOf` reads a
 * task's fingerprints (taskHashes by default).
 */
export function makePin({ tasksDir, release, now = new Date(), hashesOf = taskHashes }) {
	const lockPath = join(dirname(resolve(tasksDir)), "TASKS.lock.json");
	if (!existsSync(lockPath)) throw new Error(`${lockPath} does not exist; lock the exam before pinning its graders`);
	const lockText = readFileSync(lockPath, "utf8");
	const lock = JSON.parse(lockText).tasks ?? {};
	const tasks = {};
	const changed = [];
	for (const id of Object.keys(lock).sort()) {
		const judge = hashesOf(join(tasksDir, id)).judge;
		if (lock[id].hashes?.judge !== judge) changed.push(id);
		tasks[id] = judge;
	}
	if (changed.length) throw new Error(`judges differ from the lock for ${changed.join(", ")}; lock the exam again before pinning`);
	if (!Object.keys(tasks).length) throw new Error("the lock holds no tasks");
	return { release, pinnedAt: now.toISOString(), lock: sha256(lockText), tasks };
}

/** Writes a pin; a release's pin never changes. */
export function writePin(path, pin) {
	if (existsSync(path)) throw new Error(`${path} exists; a release's graders are pinned once`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(pin, null, 2)}\n`);
}

export const loadPin = (path) => JSON.parse(readFileSync(path, "utf8"));

/** The judge that graded a record: the re-grade's when it was graded again, else the one it ran with. */
export const gradedBy = (r) => (r.rejudgedAt ? (r.judgeTreeHash ?? null) : (r.taskHashes?.judge ?? null));

/** Why these records were not all graded by the pinned judges; empty when they were. Ungraded runs are left out. */
export function pinProblems(records, pin) {
	const problems = [];
	const seen = new Set();
	for (const r of records) {
		if (typeof r.score?.share !== "number") continue;
		const key = `${r.task}|${gradedBy(r)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const pinned = pin.tasks[r.task];
		const used = gradedBy(r);
		if (!pinned) problems.push(`${r.task}: not pinned for ${pin.release}`);
		else if (!used) problems.push(`${r.task}: a run carries no judge fingerprint`);
		else if (used !== pinned) problems.push(`${r.task}: graded by a judge other than the one pinned for ${pin.release}`);
	}
	return problems;
}
