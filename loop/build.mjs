// The autopilot's builds of Relay (AUTOPILOT.md): a harness worktree at one fixed origin/main commit, a patch applied,
// relay.arch synced (`npm run arch`), the harness's own checks (`npm run check`), and Relay's own release script packing
// a local tarball (`npm run release:pack`) that nothing publishes. RUNBOOK.md's manual steps, automated.
//
// The package is the one prescreen (relay@pkg) and the gate (a local build, GATE.md amendment 4) install: the Relay CLI
// tarball, relay-worker-<version>.tgz, which bundles Relay's own packages (harness scripts/pack-relay-release.mjs). Its
// version is a local build's, 0.6.122-loop.2026w44 (runner/arms.mjs), so `relay --version` names the build and no
// release channel can ever hold the same version.
//
// Every command goes through `run(cmd, args, { cwd, env })`, so tests pass a fake: nothing here builds, pushes or
// publishes in them. The founder's checkout is only read from (git show, git fetch, git worktree add); its working
// tree, branch and node_modules are never written.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statfsSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The release workflow's vars.R2_PUBLIC_BASE_URL (harness scripts/lib/local-release.mjs RELEASE_BASE_URL). A build
 *  is stamped with it as a release is; it is where an installed Relay looks for updates, and nothing is sent there. */
export const RELEASE_BASE_URL = "https://relayevals.com/harness";
/** The package name the release script gives the CLI (RELAY_PACKAGE_NAME's default). */
export const CLI_PACKAGE = "relay-worker";

/** The plain runner: a command and its arguments, never a shell. */
export function sh(cmd, args, { cwd, env = process.env, input } = {}) {
	const r = spawnSync(cmd, args, { cwd, env, input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	return { status: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error.message) : "") };
}

export const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Free space on the disk that holds `path`, in GB. */
export function freeGb(path) {
	let p = path;
	while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
	const s = statfsSync(p);
	return (s.bavail * s.bsize) / 1e9;
}

/**
 * The version of this cycle's local build: the next patch after the harness's own version, then `-loop.<year>w<week>`,
 * and `.<n>` for the n-th proposal's build in the same week. 0.6.121 in 2026-W44 is 0.6.122-loop.2026w44.
 */
export function buildVersion(harnessVersion, cycle, n = null) {
	const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(harnessVersion ?? "").replace(/-.*$/, ""));
	const c = /^(\d{4})-W(\d{2})$/.exec(cycle ?? "");
	if (!v || !c) throw new Error(`a build version needs the harness's x.y.z and a cycle such as 2026-W44, not ${harnessVersion} and ${cycle}`);
	return `${v[1]}.${v[2]}.${Number(v[3]) + 1}-loop.${c[1]}w${c[2]}${n === null ? "" : `.${n}`}`;
}

/** A failed step, with the tail of its output for the report. */
export class BuildError extends Error {
	constructor(step, result) {
		const tail = `${result.stderr || result.stdout}`.trim().split("\n").slice(-6).join("\n");
		super(`${step} failed (exit ${result.status})${tail ? `:\n${tail}` : ""}`);
		this.step = step;
	}
}

function must(step, result) {
	if (result.status !== 0) throw new BuildError(step, result);
	return result;
}

/**
 * The worktree's node_modules, as links into the founder's checkout (as the builders' link-wt.sh does), with Relay's
 * own packages linked to the worktree's packages, so the build compiles the worktree's code. Returns the links made.
 */
export function linkNodeModules(main, wt) {
	const made = [];
	const link = (target, path) => {
		if (existsSync(path) || isLink(path)) return;
		mkdirSync(dirname(path), { recursive: true });
		symlinkSync(target, path);
		made.push(path);
	};
	const mainModules = join(main, "node_modules");
	if (!existsSync(mainModules)) throw new Error(`${mainModules} is missing: the harness checkout needs its node_modules (npm install there once)`);
	mkdirSync(join(wt, "node_modules", "@relay"), { recursive: true });
	for (const name of [...readdirSync(mainModules).filter((n) => !n.startsWith(".")), ".bin"]) {
		if (name === "@relay" || !existsSync(join(mainModules, name))) continue;
		link(join(mainModules, name), join(wt, "node_modules", name));
	}
	const relayDir = join(mainModules, "@relay");
	if (existsSync(relayDir)) {
		for (const name of readdirSync(relayDir)) {
			const target = readlinkSync(join(relayDir, name));
			link(join(wt, "packages", basename(target)), join(wt, "node_modules", "@relay", name));
		}
	}
	const packages = join(main, "packages");
	for (const pkg of existsSync(packages) ? readdirSync(packages) : []) {
		const modules = join(packages, pkg, "node_modules");
		if (!existsSync(modules)) continue;
		for (const name of [...readdirSync(modules).filter((n) => !n.startsWith(".")), ".bin"]) {
			if (!existsSync(join(modules, name))) continue;
			link(join(modules, name), join(wt, "packages", pkg, "node_modules", name));
		}
	}
	return made;
}

function isLink(path) {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Removes the links linkNodeModules made, so removing the worktree can never reach into the founder's checkout. */
export function unlinkNodeModules(links) {
	for (const path of links) if (isLink(path)) unlinkSync(path);
}

/**
 * A worktree of the harness at `base`, detached, at `dir`, with node_modules linked. `run` runs git; `link` links
 * node_modules (tests pass one that does nothing). Returns { dir, links, remove() }.
 */
export function addWorktree({ run, harness, dir, base, link = linkNodeModules }) {
	if (existsSync(dir)) removeWorktree({ run, harness, dir, links: [] });
	mkdirSync(dirname(dir), { recursive: true });
	must("git worktree add", run("git", ["-C", harness, "worktree", "add", "--detach", "--force", dir, base]));
	const links = link(harness, dir);
	return { dir, links, remove: () => removeWorktree({ run, harness, dir, links }) };
}

export function removeWorktree({ run, harness, dir, links = [] }) {
	unlinkNodeModules(links);
	// node_modules folders inside the worktree hold only links (or nothing); take them out first, links unfollowed.
	for (const m of [join(dir, "node_modules"), ...(existsSync(join(dir, "packages")) ? readdirSync(join(dir, "packages")).map((p) => join(dir, "packages", p, "node_modules")) : [])]) {
		if (existsSync(m) && !isLink(m)) {
			for (const name of readdirSync(m)) {
				const p = join(m, name);
				if (isLink(p)) unlinkSync(p);
				else if (name === "@relay") for (const inner of readdirSync(p)) if (isLink(join(p, inner))) unlinkSync(join(p, inner));
			}
		}
	}
	run("git", ["-C", harness, "worktree", "remove", "--force", dir]);
	if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Applies a patch file in the worktree, after checking it applies whole. */
export function applyPatch({ run, dir, patch }) {
	must("git apply --check", run("git", ["-C", dir, "apply", "--check", patch]));
	must("git apply", run("git", ["-C", dir, "apply", patch]));
}

/** The environment of a build: Node from the autopilot's own Node first, a scratch HOME, and no keys. */
export function buildEnv({ home, env = process.env, node = process.execPath }) {
	const out = {};
	for (const [k, v] of Object.entries(env)) if (!/(_KEY|_TOKEN|SECRET|PASSWORD)$/i.test(k) && k !== "ANTHROPIC_BASE_URL") out[k] = v;
	out.PATH = `${dirname(node)}:${env.PATH ?? "/usr/bin:/bin"}`;
	out.HOME = home;
	out.DO_NOT_TRACK = "1";
	return out;
}

/**
 * The harness's own steps in the worktree: `npm run arch`, then `npm run check` when `check`, then `commit` (a
 * function, for the release's commit, after the checks and before the build), then `npm run build` and the release
 * script, packing version `version`. Returns { tgz, steps } with the path of the CLI tarball the script wrote.
 */
export function buildRelay({ run, dir, version, env, check = false, commit = null, baseUrl = RELEASE_BASE_URL, log = () => {} }) {
	const steps = [];
	const step = (name, args) => {
		const t = Date.now();
		log(`  ${name}`);
		must(name, run("npm", args, { cwd: dir, env }));
		steps.push({ step: name, ms: Date.now() - t });
	};
	step("npm run arch", ["run", "arch"]);
	if (check) step("npm run check", ["run", "check"]);
	const committed = commit ? commit() : null;
	step("npm run build", ["run", "build"]);
	step("npm run release:pack", ["run", "release:pack", "--", "--channel", "stable", "--base-url", baseUrl, "--version", version]);
	const tgz = join(dir, "packages", "coding-agent", "release", "artifacts", `${CLI_PACKAGE}-${version}.tgz`);
	if (!existsSync(tgz)) throw new BuildError("npm run release:pack", { status: 0, stdout: "", stderr: `no ${basename(tgz)} in the release artifacts` });
	return { tgz, steps, commit: committed };
}

/** Commits the worktree's whole tree (detached) after the checks ran on it, and keeps it under a hidden ref. */
export function commitTree({ run, dir, harness, message, ref }) {
	must("git add", run("git", ["-C", dir, "add", "-A"]));
	// The pre-commit hook runs `npm run check`, which buildRelay has just run on this exact tree.
	must("git commit", run("git", ["-C", dir, "commit", "--no-verify", "-q", "-m", message]));
	const sha = must("git rev-parse", run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
	must("git update-ref", run("git", ["-C", harness, "update-ref", ref, sha]));
	return sha;
}

/** Copies a built package to where prescreen or the gate reads it, and returns its SHA-256. */
export function keepPackage(tgz, to) {
	mkdirSync(dirname(to), { recursive: true });
	copyFileSync(tgz, to);
	return sha256File(to);
}
