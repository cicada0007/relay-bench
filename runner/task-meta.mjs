// The pinned benchmark tasks' own metadata (runner/task-meta.json): each task's difficulty and category, and the size
// of the sandbox it asks for, read once from the task's task.toml in Harbor's task cache and kept here, so every reader
// sees the same values without Harbor (scripts/arm-outcomes.mjs --write-task-meta rewrites it). A task not listed has
// no metadata here.
//
// Sandbox prices: E2B's published price per second is scripts/draft-spend.mjs's, for the round's size, 2 vCPU and
// 4 GiB. A task that asks for more is priced by `sizeFactor`, the larger of its vCPUs over 2 and its memory over 4 GiB:
// E2B prices vCPUs and memory each by the second, so that factor times the 2 vCPU, 4 GiB price is never less than the
// task's own. A smaller task keeps the 2 vCPU, 4 GiB price, so a sandbox's cost here is at most what E2B bills.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const TASK_META = join(new URL("..", import.meta.url).pathname, "runner", "task-meta.json");

let cached = null;
/** The metadata file: { about, <benchmark>: { dataset, written, tasks: { <task>: { difficulty, category, cpus, memoryMb } } } }. */
export function readTaskMeta(path = TASK_META) {
	if (path === TASK_META && cached) return cached;
	const meta = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
	if (path === TASK_META) cached = meta;
	return meta;
}

/** One task's metadata, or null. */
export const metaOf = (benchmark, task, meta = readTaskMeta()) => meta?.[benchmark]?.tasks?.[task] ?? null;

/** How many times the 2 vCPU, 4 GiB price a task's sandbox may cost: 1, or more for a task that asks for more. */
export function sizeFactor(m) {
	const cpus = Number.isFinite(m?.cpus) ? m.cpus : 0;
	const memoryMb = Number.isFinite(m?.memoryMb) ? m.memoryMb : 0;
	return Math.max(1, cpus / 2, memoryMb / 4096);
}
