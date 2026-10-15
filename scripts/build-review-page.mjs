#!/usr/bin/env node
// Builds the task review page: every long task's request, part by part, beside the checks its hidden judge runs
// (judge/CHECKS.md), so a person can mark each part clear and fair, unclear or unfair before counted runs start
// (PREREGISTRATION.md: "A person reads every task and judge in tests A and B"). The page embeds the private tasks, so
// it is written to review/ (gitignored) and published only as a private artifact.
//
//   node scripts/build-review-page.mjs            -> review/task-review.html
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const TASKS = join(ROOT, "tasks");
const TEST_DIRS = new Set(["test", "tests", "node_modules", ".git"]);

function walk(dir, visit) {
	for (const name of readdirSync(dir)) {
		if (name.startsWith("._") || name === ".DS_Store") continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, visit);
		else visit(path, name);
	}
}

/** Non-blank lines of source in the starting repository, tests not counted; and the number of test files. */
function repoStats(repo) {
	let sourceLines = 0;
	let testFiles = 0;
	const visitSource = (dir) => {
		for (const name of readdirSync(dir)) {
			if (name.startsWith("._") || name === ".DS_Store") continue;
			const path = join(dir, name);
			if (statSync(path).isDirectory()) {
				if (TEST_DIRS.has(name)) {
					if (name !== "node_modules" && name !== ".git") walk(path, (p) => /\.(m?js|py)$/.test(p) && testFiles++);
					continue;
				}
				visitSource(path);
			} else if (/\.(m?js|cjs|py)$/.test(name)) {
				sourceLines += readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).length;
			}
		}
	};
	visitSource(repo);
	return { sourceLines, testFiles };
}

/** Splits request.md into the opening, the numbered parts (1-6) and the closing rules. */
function splitRequest(text) {
	const lines = text.split("\n");
	const starts = [];
	lines.forEach((line, i) => {
		const m = /^(\d+)\.\s/.exec(line);
		if (m && Number(m[1]) === starts.length + 1) starts.push(i);
	});
	const intro = lines.slice(0, starts[0] ?? lines.length).join("\n").trim();
	const parts = [];
	let outroStart = lines.length;
	starts.forEach((start, k) => {
		let end = starts[k + 1] ?? lines.length;
		if (k === starts.length - 1) {
			// The last part ends at the first unindented paragraph after a blank line.
			for (let i = start + 1; i < lines.length; i++) {
				if (lines[i].trim() && !/^\s/.test(lines[i]) && lines[i - 1].trim() === "") {
					end = i;
					break;
				}
			}
			outroStart = end;
		}
		const body = lines.slice(start, end);
		body[0] = body[0].replace(/^\d+\.\s+/, "");
		const indent = Math.min(...body.slice(1).filter((l) => l.trim()).map((l) => /^ */.exec(l)[0].length), 99);
		parts.push(body.map((l, i) => (i === 0 ? l : l.slice(Math.min(indent, 4)))).join("\n").trim());
	});
	return { intro, parts, outro: lines.slice(outroStart).join("\n").trim() };
}

/** Splits judge/CHECKS.md into its opening and one section per part (R0-R6), headings "## Rn: ...". */
function splitChecks(text) {
	const sections = {};
	let current = "about";
	const out = { about: [] };
	for (const line of text.split("\n")) {
		const m = /^##\s+(R\d)\b:?\s*(.*)$/.exec(line);
		if (m) {
			current = m[1];
			out[current] = [];
			sections[current] = m[2];
			continue;
		}
		if (/^#\s/.test(line)) continue;
		out[current].push(line);
	}
	const result = { about: out.about.join("\n").trim(), parts: {}, titles: sections };
	for (const key of Object.keys(out)) if (key !== "about") result.parts[key] = out[key].join("\n").trim();
	return result;
}

const tasks = [];
for (const id of readdirSync(TASKS).sort()) {
	const dir = join(TASKS, id);
	if (!existsSync(join(dir, "task.json"))) continue;
	const task = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
	if (task.kind !== "long") continue;
	const request = readFileSync(join(dir, "request.md"), "utf8");
	const checksPath = join(dir, "judge", "CHECKS.md");
	const checks = existsSync(checksPath) ? splitChecks(readFileSync(checksPath, "utf8")) : null;
	const counts = {};
	if (checks) {
		for (const [part, body] of Object.entries(checks.parts)) {
			counts[part] = body.split("\n").filter((l) => /^\s*(?:[-*]\s+R\d+\.\d+|\d+\.\s)/.test(l)).length;
		}
	}
	tasks.push({
		id,
		title: task.title,
		stack: task.stack,
		private: task.private === true,
		requirements: task.requirements,
		stats: { ...repoStats(join(dir, "repo")), requestWords: request.split(/\s+/).filter(Boolean).length, checks: counts },
		request: splitRequest(request),
		checks,
	});
}

const template = readFileSync(join(ROOT, "scripts", "review-page.template.html"), "utf8");
const data = JSON.stringify({ builtAt: new Date().toISOString(), tasks }).replaceAll("<", "\\u003c");
mkdirSync(join(ROOT, "review"), { recursive: true });
writeFileSync(join(ROOT, "review", "task-review.html"), template.replace("__REVIEW_DATA__", () => data));
console.log(`review/task-review.html: ${tasks.length} tasks (${tasks.filter((t) => !t.checks).length} without CHECKS.md)`);
