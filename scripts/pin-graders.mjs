#!/usr/bin/env node
// Pins the exam's graders for one release (runner/pins.mjs): every locked task's judge fingerprint, under the release's
// id, beside the exam. The gate on the exam refuses runs graded by any other judge. `runner/gate.mjs --run` pins them
// itself at a gate's first look; this pins them by hand, for a gate run another way.
//
//   node scripts/pin-graders.mjs --release 0.6.122-beta.3 --tasks-dir ../relay-exam/tasks
//   node scripts/pin-graders.mjs --check --release 0.6.122-beta.3 --tasks-dir ../relay-exam/tasks
//
// --check exits 1 when a pinned task's judge has changed since (a release keeps its pin; the change applies from the next).
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { taskHashes } from "../runner/judge.mjs";
import { loadPin, makePin, pinFingerprint, pinPathFor, writePin } from "../runner/pins.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const { values } = parseArgs({ options: { release: { type: "string" }, "tasks-dir": { type: "string" }, check: { type: "boolean", default: false } } });
for (const name of ["release", "tasks-dir"]) if (!values[name]) throw new Error(`--${name} is required`);
const tasksDir = resolve(values["tasks-dir"]);
const inside = relative(ROOT, tasksDir);
if (!inside.startsWith("..") && !isAbsolute(inside)) throw new Error(`pins belong to the sealed exam; ${tasksDir} is inside this public repository`);
const path = pinPathFor(tasksDir, values.release);
if (values.check) {
	if (!existsSync(path)) throw new Error(`no pin at ${path}`);
	const pin = loadPin(path);
	const changed = Object.entries(pin.tasks).filter(([id, judge]) => !existsSync(join(tasksDir, id)) || taskHashes(join(tasksDir, id)).judge !== judge).map(([id]) => id);
	for (const id of changed) console.log(`${id}: its judge differs from the one pinned for ${pin.release}`);
	console.log(changed.length ? `${changed.length} judge(s) changed since ${pin.pinnedAt}` : `${Object.keys(pin.tasks).length} judges match the pin for ${pin.release}`);
	process.exit(changed.length ? 1 : 0);
}
const pin = makePin({ tasksDir, release: values.release });
writePin(path, pin);
console.log(`${path}: ${Object.keys(pin.tasks).length} judges pinned for ${pin.release} (fingerprint ${pinFingerprint(pin).slice(0, 12)})`);
