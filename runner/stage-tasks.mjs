// Which tasks a stage runs (run-stage.mjs --tasks), and the rule that keeps the sealed tiers sealed (TIERS.md): an exam
// or check task is run only from a tasks folder outside this public repository, and its runs (transcripts, patches,
// grades) are written outside it too, so nothing an improving agent can read here holds them.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isSealed } from "../scripts/approve-task.mjs";

export const ROOT = new URL("..", import.meta.url).pathname;

/** Every task in a folder, by id, in id order. */
export function readTasks(tasksDir) {
	const tasks = new Map();
	for (const id of readdirSync(tasksDir).sort()) {
		const path = join(tasksDir, id, "task.json");
		if (existsSync(path)) tasks.set(id, JSON.parse(readFileSync(path, "utf8")));
	}
	return tasks;
}

/** --tasks: a comma list of task ids, kind:<kind> and tier:<tier> selectors (a task with no tier is practice), in order. */
export function selectTasks(spec, tasksDir) {
	const tasks = readTasks(tasksDir);
	const ids = [];
	for (const item of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
		let found;
		if (item.startsWith("kind:")) found = [...tasks].filter(([, t]) => t.kind === item.slice(5)).map(([id]) => id);
		else if (item.startsWith("tier:")) found = [...tasks].filter(([, t]) => (t.tier ?? "practice") === item.slice(5)).map(([id]) => id);
		else found = [item];
		for (const id of found) if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}

/** True when `path` is this repository or inside it. */
export function insideRepo(path, root = ROOT) {
	const rel = relative(resolve(root), resolve(path));
	return !rel.startsWith("..") && !isAbsolute(rel);
}

/** Why a stage may not run these tasks from this folder into this output; empty when it may. */
export function sealedProblems({ ids, tasksDir, out, root = ROOT }) {
	const tasks = readTasks(tasksDir);
	const sealed = ids.filter((id) => isSealed(tasks.get(id)));
	if (!sealed.length) return [];
	const problems = [];
	if (insideRepo(tasksDir, root)) problems.push(`${sealed.length} exam or check tasks are in ${tasksDir}, inside this public repository`);
	if (insideRepo(out, root)) problems.push(`runs of exam or check tasks must be written outside this public repository; ${out} is inside it`);
	return problems;
}
