// Anchors (GATE.md amendment 1): a fixed, versioned set of tasks scored with every release, so scores stay comparable
// while the exam around them changes week by week. The exam's own score moves when its tasks change; the anchors'
// score moves only when Relay does. The quarter's trend (scripts/ledger.mjs trend) is read on the anchors.
//
// An anchor set is a manifest beside the exam, `anchors/<version>.json`, holding each task's fingerprints at the time
// it was made. It is never edited: an anchor task that changes (a judge fixed, say) makes the set unusable, and a new
// version is made instead. When a set is spent (runner/exposure.mjs), the next release scores the old set and the new
// one, so the trend can be carried from one to the other.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { taskHashes } from "./judge.mjs";

export const VERSION_PATTERN = /^anchors-v\d+$/;
export const anchorsDirFor = (tasksDir) => join(dirname(resolve(tasksDir)), "anchors");
export const anchorsPathFor = (tasksDir, version) => join(anchorsDirFor(tasksDir), `${version}.json`);

/** A fingerprint of the set: its version and every task's fingerprints, in id order. Safe to publish: it names no task. */
export function anchorFingerprint(manifest) {
	const ids = Object.keys(manifest.tasks).sort();
	const canonical = JSON.stringify({ version: manifest.version, tasks: ids.map((id) => [id, manifest.tasks[id]]) });
	return createHash("sha256").update(canonical).digest("hex");
}

/** A new anchor set from tasks in `tasksDir`. `hashesOf` reads a task's fingerprints (taskHashes by default). */
export function makeAnchors({ tasksDir, ids, version, now = new Date(), hashesOf = taskHashes }) {
	if (!VERSION_PATTERN.test(version ?? "")) throw new Error(`an anchor set's version looks like anchors-v1, not ${version}`);
	const unique = [...new Set(ids)].sort();
	if (unique.length < 20) throw new Error(`an anchor set needs at least 20 tasks, the gate's minimum; got ${unique.length}`);
	const tasks = {};
	for (const id of unique) {
		const dir = join(tasksDir, id);
		if (!existsSync(join(dir, "task.json"))) throw new Error(`no task ${id} in ${tasksDir}`);
		tasks[id] = hashesOf(dir);
	}
	return { version, createdAt: now.toISOString(), tasks };
}

/** Writes a new anchor set; refuses to replace one, since a version never changes. */
export function writeAnchors(path, manifest) {
	if (existsSync(path)) throw new Error(`${path} exists; an anchor set never changes, make ${manifest.version.replace(/\d+$/, (n) => String(Number(n) + 1))} instead`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Reads an anchor set: { version, ids, fingerprint, manifest }. */
export function loadAnchors(path) {
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	if (!VERSION_PATTERN.test(manifest.version ?? "") || !manifest.tasks) throw new Error(`${path} is not an anchor set`);
	return { version: manifest.version, ids: Object.keys(manifest.tasks).sort(), fingerprint: anchorFingerprint(manifest), manifest };
}

/** The anchor tasks that no longer match their fingerprints; empty when the set is usable. */
export function anchorProblems(manifest, tasksDir, hashesOf = taskHashes) {
	const problems = [];
	for (const [id, pinned] of Object.entries(manifest.tasks)) {
		const dir = join(tasksDir, id);
		if (!existsSync(join(dir, "task.json"))) {
			problems.push(`${id}: missing`);
			continue;
		}
		const now = hashesOf(dir);
		for (const part of Object.keys(pinned)) if (now[part] !== pinned[part]) problems.push(`${id}: ${part} changed since ${manifest.version}`);
	}
	return problems;
}
