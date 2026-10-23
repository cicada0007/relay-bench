#!/usr/bin/env node
// Anchor sets (GATE.md, amendment 1; runner/anchors.mjs): a fixed set of exam tasks scored with every release, so the
// quarter's trend is read on the same tasks while the rest of the exam changes.
//
//   node scripts/anchors.mjs create --version anchors-v1 --tasks-dir ../relay-exam/tasks (--ids a,b,c | --sample 40)
//   node scripts/anchors.mjs check --anchors ../relay-exam/anchors/anchors-v1.json --tasks-dir ../relay-exam/tasks
//
// `create` takes locked, approved exam tasks only (scripts/lock-tasks.mjs), writes <exam>/anchors/<version>.json beside
// the tasks, and never replaces a version. --sample draws that many of the exam's tasks with a shuffle seeded 20261015.
// `check` exits 1 when an anchor task changed since its set was made; a changed set is replaced by a new version.
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { anchorProblems, anchorsPathFor, loadAnchors, makeAnchors, writeAnchors } from "../runner/anchors.mjs";
import { readTasks, sampleIds } from "../runner/stage-tasks.mjs";
import { lockDifferences } from "./lock-tasks.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const { values, positionals } = parseArgs({
	options: { version: { type: "string" }, "tasks-dir": { type: "string" }, ids: { type: "string" }, sample: { type: "string" }, anchors: { type: "string" } },
	allowPositionals: true,
});
const [command] = positionals;
if (!["create", "check"].includes(command)) throw new Error("usage: node scripts/anchors.mjs create|check ... (see the top of this file)");
if (!values["tasks-dir"]) throw new Error("--tasks-dir is required: the private exam repository's tasks folder");
const tasksDir = resolve(values["tasks-dir"]);
const inside = relative(ROOT, tasksDir);
if (!inside.startsWith("..") && !isAbsolute(inside)) throw new Error(`anchor sets are part of the sealed exam; ${tasksDir} is inside this public repository`);

if (command === "check") {
	if (!values.anchors) throw new Error("check needs --anchors <file>");
	const set = loadAnchors(resolve(values.anchors));
	const problems = anchorProblems(set.manifest, tasksDir);
	for (const p of problems) console.log(p);
	console.log(problems.length ? `${set.version} no longer matches its tasks; make a new version` : `${set.version}: all ${set.ids.length} tasks match (fingerprint ${set.fingerprint.slice(0, 12)})`);
	process.exit(problems.length ? 1 : 0);
}

if (!values.version) throw new Error("create needs --version, such as anchors-v1");
if (Boolean(values.ids) === Boolean(values.sample)) throw new Error("create needs one of --ids or --sample");
const exam = [...readTasks(tasksDir)].filter(([, t]) => t.tier === "exam").map(([id]) => id);
const ids = values.ids ? values.ids.split(",").map((s) => s.trim()).filter(Boolean) : sampleIds(exam, Number(values.sample));
const notExam = ids.filter((id) => !exam.includes(id));
if (notExam.length) throw new Error(`anchors are exam tasks; these are not: ${notExam.join(", ")}`);
const differences = lockDifferences(ids, tasksDir);
if (differences.length) {
	for (const d of differences) console.error(`${d.id}: ${d.what}`);
	throw new Error("every anchor task must be approved and match the exam's lock; nothing was written");
}
const path = anchorsPathFor(tasksDir, values.version);
const manifest = makeAnchors({ tasksDir, ids, version: values.version });
writeAnchors(path, manifest);
console.log(`${path}: ${Object.keys(manifest.tasks).length} anchor tasks, fingerprint ${loadAnchors(path).fingerprint.slice(0, 12)}`);
