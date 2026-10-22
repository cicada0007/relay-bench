// The review page for exam tasks: written beside the exam, never inside this public repository, with each task's
// drafter, source and approval. On a throwaway exam folder; nothing is published.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("./build-review-page.mjs", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;

function exam() {
	const root = mkdtempSync(join(tmpdir(), "exam-review-"));
	const tasks = join(root, "tasks");
	const add = (id, extra) => {
		const dir = join(tasks, id);
		mkdirSync(join(dir, "repo"), { recursive: true });
		mkdirSync(join(dir, "judge"), { recursive: true });
		writeFileSync(join(dir, "repo", "a.py"), "x = 1\n");
		writeFileSync(join(dir, "request.md"), "Fix mean.\n\n`mean([])` should raise ValueError.\n");
		writeFileSync(join(dir, "judge", "CHECKS.md"), "# x\n\n## R0: what worked before\n\n- R0.1 [a]\n\n## R1: mean\n\n- R1.1 [b]\n");
		writeFileSync(
			join(dir, "task.json"),
			JSON.stringify({ id, kind: "everyday", title: "Fix mean", stack: ["python3"], requirements: ["R1"], private: true, tier: "exam", draftedBy: "openai/gpt-x", source: { issue: "https://github.com/o/r/issues/1", pr: "https://github.com/o/r/pull/2", license: "MIT" }, ...extra }),
		);
	};
	add("o-r-2", {});
	add("o-r-3", { approvedBy: "arnav", approvedAt: "2026-10-23T00:00:00Z" });
	return { root, tasks };
}

test("the exam's review page lands beside the exam and shows who must still approve what", () => {
	const { root, tasks } = exam();
	try {
		const out = execFileSync(process.execPath, [script, "--tasks-dir", tasks], { encoding: "utf8" });
		assert.match(out, /2 tasks .*1 waiting for approval/);
		const page = readFileSync(join(root, "review", "exam-review.html"), "utf8");
		const data = JSON.parse(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/.exec(page)[1]);
		assert.equal(data.heading.eyebrow, "relay exam · private · approval");
		const [waiting, approved] = data.tasks;
		assert.deepEqual(waiting.exam.problems, ["not approved (scripts/approve-task.mjs)"]);
		assert.match(waiting.exam.approveCommand, /^node scripts\/approve-task\.mjs o-r-2 --by <your name> --tasks-dir /);
		assert.equal(waiting.exam.source.issue, "https://github.com/o/r/issues/1");
		assert.deepEqual(approved.exam.problems, []);
		assert.equal(approved.exam.approvedBy, "arnav");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a page holding exam tasks is never written inside this public repository", () => {
	const { root, tasks } = exam();
	const to = join(ROOT, "review", "exam-test-should-not-exist.html");
	try {
		assert.throws(() => execFileSync(process.execPath, [script, "--tasks-dir", tasks, "--to", to], { stdio: "pipe" }), /outside this public repository/);
		assert.ok(!existsSync(to));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
