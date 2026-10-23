// Small, dependency-free helpers the loop uses to turn a proposed change into a diff a reviewer can read: a unified
// diff between two texts (git's format, so `git apply` takes it), the JSON paths two objects differ at, and the lines a
// patch's hunks touch.
import { createHash } from "node:crypto";

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** JSON with keys in sorted order, so a hash does not depend on how an object was built. */
export function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.filter((k) => value[k] !== undefined)
			.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The value at a dotted path ("queue.stuck.idleTurns"), or undefined. */
export function getPath(obj, path) {
	return path.split(".").reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
}

/** A copy of `obj` with `value` at the dotted path. The original is left as it was. */
export function setPath(obj, path, value) {
	const keys = path.split(".");
	const copy = structuredClone(obj);
	let o = copy;
	for (const k of keys.slice(0, -1)) {
		if (!isObject(o[k])) throw new Error(`no object at ${path}`);
		o = o[k];
	}
	o[keys.at(-1)] = value;
	return copy;
}

/** The dotted paths where two JSON values differ. Objects are compared key by key; arrays and scalars are leaves. */
export function changedPaths(a, b, prefix = "") {
	if (isObject(a) && isObject(b)) {
		const out = [];
		for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
			out.push(...changedPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k));
		}
		return out;
	}
	return canonical(a) === canonical(b) ? [] : [prefix];
}

/** True when `path` is `prefix` or inside it. */
export const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}.`);

/** JSON written the way the file it came from was: the same indent, and a newline at the end. */
export function serializeLike(value, original) {
	const indent = /^\{\n(\t| +)"/.exec(original ?? "")?.[1] ?? "\t";
	return `${JSON.stringify(value, null, indent)}\n`;
}

function splitLines(text) {
	const lines = text.split("\n");
	const eol = lines.at(-1) === "";
	if (eol) lines.pop();
	return { lines, eol };
}

/** The edit script between two line lists: common head and tail trimmed, then a longest common subsequence. */
function editScript(a, b) {
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	const x = a.slice(head, a.length - tail);
	const y = b.slice(head, b.length - tail);
	const n = x.length;
	const m = y.length;
	const lcs = new Uint32Array((n + 1) * (m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i * (m + 1) + j] = x[i] === y[j] ? lcs[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
		}
	}
	const ops = a.slice(0, head).map((line) => [" ", line]);
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && x[i] === y[j]) {
			ops.push([" ", x[i]]);
			i++;
			j++;
		} else if (i < n && (j === m || lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1])) {
			ops.push(["-", x[i++]]);
		} else {
			ops.push(["+", y[j++]]);
		}
	}
	for (const line of a.slice(a.length - tail)) ops.push([" ", line]);
	return ops;
}

/**
 * A unified diff of `before` and `after` for the file `path`, in git's format, with `context` lines around each change.
 * Empty when they are the same. `git apply` takes it from the repository's root.
 */
export function unifiedDiff(before, after, { path, context = 3 } = {}) {
	if (before === after) return "";
	const a = splitLines(before);
	const b = splitLines(after);
	const ops = editScript(a.lines, b.lines);
	// Mark the last line of a file that has no newline at its end, so git reads it exactly.
	const lastOld = a.lines.length - 1;
	const lastNew = b.lines.length - 1;
	const changed = ops.map((o, k) => (o[0] !== " " ? k : -1)).filter((k) => k >= 0);
	const hunks = [];
	let start = null;
	let end = null;
	for (const k of changed) {
		if (start === null) {
			start = Math.max(0, k - context);
			end = Math.min(ops.length - 1, k + context);
		} else if (k - context <= end + 1) end = Math.min(ops.length - 1, k + context);
		else {
			hunks.push([start, end]);
			start = Math.max(0, k - context);
			end = Math.min(ops.length - 1, k + context);
		}
	}
	if (start !== null) hunks.push([start, end]);
	const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
	// Old and new line numbers at the start of each op.
	const oldAt = [];
	const newAt = [];
	let o = 0;
	let nn = 0;
	for (const op of ops) {
		oldAt.push(o);
		newAt.push(nn);
		if (op[0] !== "+") o++;
		if (op[0] !== "-") nn++;
	}
	for (const [s, e] of hunks) {
		const slice = ops.slice(s, e + 1);
		const oldLen = slice.filter((op) => op[0] !== "+").length;
		const newLen = slice.filter((op) => op[0] !== "-").length;
		const oldStart = oldLen ? oldAt[s] + 1 : oldAt[s];
		const newStart = newLen ? newAt[s] + 1 : newAt[s];
		out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);
		slice.forEach((op, idx) => {
			out.push(`${op[0]}${op[1]}`);
			const k = s + idx;
			const isLastOld = op[0] !== "+" && oldAt[k] === lastOld && !a.eol;
			const isLastNew = op[0] !== "-" && newAt[k] === lastNew && !b.eol;
			if (isLastOld || isLastNew) out.push("\\ No newline at end of file");
		});
	}
	return `${out.join("\n")}\n`;
}

/** Per file a patch changes, the old-side line numbers its hunks remove or keep around a change: { path: [[from, to], ...] }. */
export function hunkRanges(patch) {
	const files = {};
	let current = null;
	for (const line of String(patch ?? "").split("\n")) {
		const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (header) {
			current = header[1];
			files[current] ??= [];
			continue;
		}
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
		if (hunk && current) {
			const from = Number(hunk[1]);
			const len = hunk[2] === undefined ? 1 : Number(hunk[2]);
			files[current].push([from, from + Math.max(len, 1) - 1]);
		}
	}
	return files;
}

/** A simple glob, as the invariants use them: `**` any folders, `*` any name part. Anchored at the root. */
export function globToRegExp(glob) {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			if (glob[i + 2] === "/") {
				re += "(?:.*/)?";
				i += 2;
			} else {
				re += ".*";
				i += 1;
			}
		} else if (c === "*") re += "[^/]*";
		else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}
