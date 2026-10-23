// runner/run-stage.mjs refuses a stage that would pass the leak budget, before anything starts (a dry run here).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exposurePathFor, recordExposure } from "./exposure.mjs";

const STAGE = new URL("./run-stage.mjs", import.meta.url).pathname;

function exam(n) {
	const root = mkdtempSync(join(tmpdir(), "stage-budget-"));
	const tasks = join(root, "tasks");
	for (let i = 0; i < n; i++) {
		mkdirSync(join(tasks, `x${i}`), { recursive: true });
		writeFileSync(join(tasks, `x${i}`, "task.json"), JSON.stringify({ id: `x${i}`, kind: "everyday", tier: "exam" }));
	}
	return { root, tasks };
}
const stage = (e, extra = []) =>
	spawnSync(
		process.execPath,
		[STAGE, "--test", "dev-budget", "--model", "claude-haiku-5-5", "--tools", "relay@0.6.121,relay@0.6.122", "--tasks", "tier:exam", "--tasks-dir", e.tasks, "--reps", "2", "--cap-usd", "1", "--stage-cap-usd", "5", "--out", join(e.root, "runs"), "--dry-run", ...extra],
		{ encoding: "utf8" },
	);

test("a stage within the leak budget plans its runs; one past it runs nothing and names the task", () => {
	const e = exam(3);
	const ok = stage(e);
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(ok.stdout, /12 runs planned/);

	writeFileSync(join(e.root, "leak-budget.json"), JSON.stringify({ exam: { runsPerTask: 5 } }));
	recordExposure(exposurePathFor(e.tasks), { kind: "run", tier: "exam", tasks: ["x1"], test: "earlier" });
	recordExposure(exposurePathFor(e.tasks), { kind: "run", tier: "exam", tasks: ["x1"], test: "earlier" });
	const refused = stage(e);
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /x1 would be shown to 6 runs; its budget is 5/);
	assert.match(refused.stderr, /nothing was run/);
});

test("an unreleased build runs only as relay@pkg, with its package, in a dev or pilot test", () => {
	const root = mkdtempSync(join(tmpdir(), "stage-pkg-"));
	const tasks = join(root, "tasks");
	mkdirSync(join(tasks, "p1"), { recursive: true });
	writeFileSync(join(tasks, "p1", "task.json"), JSON.stringify({ id: "p1", kind: "everyday" }));
	const pkg = join(root, "relay.tgz");
	writeFileSync(pkg, "not really a package");
	const run = (test, extra) =>
		spawnSync(process.execPath, [STAGE, "--test", test, "--model", "claude-haiku-5-5", "--tools", "relay@0.6.121,relay@pkg", "--tasks", "p1", "--tasks-dir", tasks, "--reps", "1", "--cap-usd", "0.2", "--stage-cap-usd", "1", "--out", join(root, "runs"), "--dry-run", ...extra], { encoding: "utf8" });
	const missing = run("dev-loop-x", []);
	assert.notEqual(missing.status, 0);
	assert.match(missing.stderr, /relay@pkg needs --relay-package/);
	const counted = run("loop-x", ["--relay-package", pkg]);
	assert.notEqual(counted.status, 0);
	assert.match(counted.stderr, /for dev and pilot tests only/);
	const ok = run("dev-loop-x", ["--relay-package", pkg]);
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(ok.stdout, /2 runs planned/);
});
