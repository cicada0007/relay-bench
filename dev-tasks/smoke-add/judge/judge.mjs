// Smoke judge: R1 multiply works; R0 add still works and npm test passes.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const dir = process.argv[2];
const gates = { test: (() => { try { execFileSync("npm", ["test"], { cwd: dir, stdio: "pipe" }); return true; } catch { return false; } })() };
let R1 = false, R0 = false;
try {
	const m = await import(pathToFileURL(join(dir, "src", "math.js")).href);
	R0 = m.add(2, 3) === 5 && gates.test;
	R1 = typeof m.multiply === "function" && m.multiply(6, 7) === 42 && m.multiply(-2, 3) === -6;
} catch {}
console.log(JSON.stringify({ task: "smoke-add", gates, requirements: { R1 }, R0, notes: {} }));
