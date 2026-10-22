// Runs one Node test file with node:test and writes every test's outcome as JSON:
//   node run-node-tests.mjs <absolute test file> <report.json>   ->   { "tests": [{ "name", "outcome" }] }
// A test's name is its describe blocks and its own name, joined by " > ". A file with no node:test tests (a plain
// script using assert) is one test, "(whole file)", that passes when the script exits 0. Suites are not reported on
// their own: their tests are. Outcomes: pass, fail, skip (skipped or todo).
import { writeFileSync } from "node:fs";
import { run } from "node:test";

const [file, report] = process.argv.slice(2);
const tests = [];
const names = [];
const clean = (name) => (name === file ? "(whole file)" : name);
let error;
try {
	for await (const event of run({ files: [file], concurrency: 1 })) {
		const data = event.data;
		if (event.type === "test:start") {
			names.length = data.nesting;
			names[data.nesting] = clean(data.name);
		} else if (event.type === "test:pass" || event.type === "test:fail") {
			if (data.details?.type === "suite") continue;
			const name = [...names.slice(0, data.nesting), clean(data.name)].join(" > ");
			const outcome = event.type === "test:fail" ? "fail" : data.skip || data.todo ? "skip" : "pass";
			tests.push({ name, outcome });
		}
	}
} catch (e) {
	error = String(e?.message ?? e).slice(0, 400);
}
writeFileSync(report, JSON.stringify({ tests, ...(error ? { error } : {}) }));
