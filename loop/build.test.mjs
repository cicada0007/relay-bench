// loop/build.mjs: the build's version, its environment without keys, and node_modules links that are removed without
// ever reaching the checkout they point into. No npm script runs here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isLocalBuild } from "../runner/arms.mjs";
import { addWorktree, applyPatch, BuildError, buildEnv, buildRelay, buildVersion, linkNodeModules, sh } from "./build.mjs";

test("a build's version is the next patch, then the week: a local build no release channel holds", () => {
	assert.equal(buildVersion("0.6.121", "2026-W44"), "0.6.122-loop.2026w44");
	assert.equal(buildVersion("0.6.121", "2026-W44", 2), "0.6.122-loop.2026w44.2");
	assert.equal(buildVersion("0.6.121-beta.3", "2026-W05"), "0.6.122-loop.2026w05");
	assert.ok(isLocalBuild(buildVersion("0.6.121", "2026-W44", 2)));
	assert.throws(() => buildVersion("next", "2026-W44"), /x\.y\.z/);
	assert.throws(() => buildVersion("0.6.121", "W44"), /2026-W44/);
});

test("a build runs with the autopilot's Node first, a scratch HOME, and no keys", () => {
	const env = buildEnv({ home: "/tmp/h", node: "/opt/node22/bin/node", env: { PATH: "/usr/bin", RELAY_BENCH_OPENAI_KEY: "x", E2B_API_KEY: "y", GITHUB_TOKEN: "z", ANTHROPIC_BASE_URL: "u", LANG: "C" } });
	assert.deepEqual(env, { PATH: "/opt/node22/bin:/usr/bin", HOME: "/tmp/h", DO_NOT_TRACK: "1", LANG: "C" });
});

test("node_modules are links into the checkout, Relay's own packages link to the worktree's, and removal leaves the checkout whole", () => {
	const main = mkdtempSync(join(tmpdir(), "build-main-"));
	const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
	mkdirSync(join(main, "packages", "ai", "src"), { recursive: true });
	writeFileSync(join(main, "packages", "ai", "src", "a.ts"), "export const a = 1;\n");
	writeFileSync(join(main, ".gitignore"), "node_modules/\n");
	git(main, "init", "-q", "-b", "main");
	git(main, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A");
	git(main, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "x");
	mkdirSync(join(main, "node_modules", "left-pad"), { recursive: true });
	writeFileSync(join(main, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
	mkdirSync(join(main, "node_modules", ".bin"), { recursive: true });
	mkdirSync(join(main, "node_modules", "@relay"), { recursive: true });
	symlinkSync("../../packages/ai", join(main, "node_modules", "@relay", "ai"));
	mkdirSync(join(main, "packages", "ai", "node_modules", "zod"), { recursive: true });
	writeFileSync(join(main, "packages", "ai", "node_modules", "zod", "index.js"), "module.exports = 2;\n");

	const wt = addWorktree({ run: sh, harness: main, dir: join(mkdtempSync(join(tmpdir(), "build-wt-")), "wt"), base: "HEAD", link: linkNodeModules });
	assert.ok(lstatSync(join(wt.dir, "node_modules", "left-pad")).isSymbolicLink());
	assert.equal(readFileSync(join(wt.dir, "node_modules", "left-pad", "index.js"), "utf8"), "module.exports = 1;\n");
	assert.equal(readFileSync(join(wt.dir, "node_modules", "@relay", "ai", "src", "a.ts"), "utf8"), "export const a = 1;\n");
	assert.ok(lstatSync(join(wt.dir, "node_modules", "@relay", "ai")).isSymbolicLink());
	assert.match(String(execFileSync("readlink", [join(wt.dir, "node_modules", "@relay", "ai")])), new RegExp(`${wt.dir}/packages/ai`));
	assert.ok(lstatSync(join(wt.dir, "packages", "ai", "node_modules", "zod")).isSymbolicLink());

	const patch = join(main, "x.patch");
	writeFileSync(patch, "diff --git a/packages/ai/src/a.ts b/packages/ai/src/a.ts\n--- a/packages/ai/src/a.ts\n+++ b/packages/ai/src/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n");
	applyPatch({ run: sh, dir: wt.dir, patch });
	assert.equal(readFileSync(join(wt.dir, "packages", "ai", "src", "a.ts"), "utf8"), "export const a = 2;\n");
	assert.throws(() => applyPatch({ run: sh, dir: wt.dir, patch }), (e) => e instanceof BuildError && e.step === "git apply --check");

	wt.remove();
	assert.equal(existsSync(wt.dir), false);
	assert.equal(readFileSync(join(main, "node_modules", "left-pad", "index.js"), "utf8"), "module.exports = 1;\n", "the checkout's node_modules are whole");
	assert.equal(readFileSync(join(main, "packages", "ai", "node_modules", "zod", "index.js"), "utf8"), "module.exports = 2;\n");
	assert.equal(readFileSync(join(main, "packages", "ai", "src", "a.ts"), "utf8"), "export const a = 1;\n", "the checkout's tree is as it was");
	assert.doesNotMatch(git(main, "worktree", "list"), /build-wt-/);
});

test("the harness's steps run in order, the release's checks before its commit, and a failed step stops the build", () => {
	const calls = [];
	const dir = mkdtempSync(join(tmpdir(), "build-steps-"));
	const run = (cmd, args, opts) => {
		calls.push([cmd, ...args].join(" "));
		if (args[1] === "release:pack") {
			mkdirSync(join(opts.cwd, "packages", "coding-agent", "release", "artifacts"), { recursive: true });
			writeFileSync(join(opts.cwd, "packages", "coding-agent", "release", "artifacts", "relay-worker-0.6.122-loop.2026w44.tgz"), "x");
		}
		return { status: 0, stdout: "", stderr: "" };
	};
	const r = buildRelay({ run, dir, version: "0.6.122-loop.2026w44", env: {}, check: true, commit: () => (calls.push("commit"), "abc") });
	assert.deepEqual(calls, ["npm run arch", "npm run check", "commit", "npm run build", "npm run release:pack -- --channel stable --base-url https://relayevals.com/harness --version 0.6.122-loop.2026w44"]);
	assert.equal(r.commit, "abc");
	assert.match(r.tgz, /relay-worker-0\.6\.122-loop\.2026w44\.tgz$/);
	const failing = (cmd, args) => ({ status: args[1] === "check" ? 1 : 0, stdout: "", stderr: "biome found 2 errors" });
	assert.throws(() => buildRelay({ run: failing, dir, version: "0.6.122-loop.2026w44", env: {}, check: true, commit: () => assert.fail("no commit after a failed check") }), /npm run check failed \(exit 1\):\nbiome found 2 errors/);
});
