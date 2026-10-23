// scripts/anchors.mjs on a throwaway exam: only locked, approved exam tasks become anchors; a set is never replaced.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = new URL("./anchors.mjs", import.meta.url).pathname;
const LOCK = new URL("./lock-tasks.mjs", import.meta.url).pathname;
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

function exam(n, extra = () => ({})) {
	const tasks = join(mkdtempSync(join(tmpdir(), "anchors-cli-")), "tasks");
	for (let i = 0; i < n; i++) {
		const id = `e-${i}`;
		const dir = join(tasks, id);
		mkdirSync(join(dir, "repo"), { recursive: true });
		mkdirSync(join(dir, "judge"), { recursive: true });
		writeFileSync(join(dir, "task.json"), JSON.stringify({ id, kind: "everyday", tier: "exam", draftedBy: "openai/gpt-x", approvedBy: "arnav", approvedAt: "2026-10-23", ...extra(i) }));
		writeFileSync(join(dir, "request.md"), `Task ${i}.\n`);
		writeFileSync(join(dir, "repo", "a.py"), "x = 1\n");
		writeFileSync(join(dir, "judge", "judge.mjs"), "// judge\n");
	}
	return tasks;
}

test("a sample of locked exam tasks becomes an anchor set once, and checks clean", () => {
	const tasks = exam(30);
	execFileSync(process.execPath, [LOCK, "--tasks-dir", tasks]);
	const made = run(["create", "--version", "anchors-v1", "--tasks-dir", tasks, "--sample", "20"]);
	assert.equal(made.status, 0, made.stderr);
	assert.match(made.stdout, /20 anchor tasks/);
	const again = run(["create", "--version", "anchors-v1", "--tasks-dir", tasks, "--sample", "20"]);
	assert.notEqual(again.status, 0);
	assert.match(again.stderr, /never changes/);
	const checked = run(["check", "--anchors", join(tasks, "..", "anchors", "anchors-v1.json"), "--tasks-dir", tasks]);
	assert.equal(checked.status, 0, checked.stderr);
	const set = join(tasks, "..", "anchors", "anchors-v1.json");
	const [first] = Object.keys(JSON.parse(readFileSync(set, "utf8")).tasks);
	writeFileSync(join(tasks, first, "request.md"), "Changed.\n");
	const changed = run(["check", "--anchors", set, "--tasks-dir", tasks]);
	assert.equal(changed.status, 1);
	assert.match(changed.stdout, new RegExp(`${first}: request changed since anchors-v1`));
});

test("unlocked or unapproved tasks, and tasks inside this repository, are refused", () => {
	const tasks = exam(25, (i) => (i === 3 ? { approvedBy: undefined, approvedAt: undefined } : {}));
	const unlocked = run(["create", "--version", "anchors-v1", "--tasks-dir", tasks, "--sample", "20"]);
	assert.notEqual(unlocked.status, 0);
	assert.match(unlocked.stderr, /TASKS\.lock\.json does not exist/);
	execFileSync(process.execPath, [LOCK, "--tasks-dir", tasks]);
	const ids = Array.from({ length: 20 }, (_, i) => `e-${i}`).join(",");
	const unapproved = run(["create", "--version", "anchors-v1", "--tasks-dir", tasks, "--ids", ids]);
	assert.match(unapproved.stderr, /e-3: not approved/);
	const inside = run(["create", "--version", "anchors-v1", "--tasks-dir", new URL("../dev-tasks", import.meta.url).pathname, "--sample", "20"]);
	assert.match(inside.stderr, /inside this public repository/);
});
