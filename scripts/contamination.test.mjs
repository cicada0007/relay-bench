// The contamination scan (scripts/contamination.mjs): planted duplicates, mentions, repeats, repositories and dates.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCorpus, corpusFor, references, scan, shingles } from "./contamination.mjs";

const PRACTICE_REQUEST = `The CSV export drops the last row when the file does not end with a newline. Running export on a
table with three rows writes only two of them, and no error is printed. The export should write every row whether or not
the input ends with a newline, and keep the header exactly as it is today.`;

const candidate = (over = {}) => ({
	id: "acme-widgets-41",
	repo: "acme/widgets",
	baseCommit: "abc123",
	cutoff: "2026-07-01",
	minedAt: "2026-10-20T00:00:00Z",
	pr: { number: 41, title: "Fix the parser for nested lists", mergedAt: "2026-09-12T00:00:00Z" },
	issue: { number: 40, title: "Nested lists are flattened by the parser", createdAt: "2026-08-30T00:00:00Z" },
	...over,
});
const corpus = (extra = {}) =>
	buildCorpus({
		docs: [
			{ id: "practice:csv-export", taskId: "csv-export", source: "practice", text: PRACTICE_REQUEST },
			{ id: "public:README.md", source: "this public repository", text: "An open benchmark of coding agents. See https://github.com/other/thing/issues/7 for history." },
			...(extra.docs ?? []),
		],
		seen: extra.seen ?? [],
		repos: extra.repos ?? [],
	});
const kinds = (r) => r.hits.map((h) => h.kind);

test("a clean candidate passes", () => {
	const r = scan(candidate(), corpus(), { cutoff: "2026-07-01" });
	assert.deepEqual(r.hits, []);
	assert.equal(r.clean, true);
});

test("a planted, lightly edited copy of a practice task is caught as a near-duplicate", () => {
	const planted = PRACTICE_REQUEST.replace("three rows", "3 rows").replace("no error is printed", "nothing is printed");
	const r = scan(candidate({ issue: { ...candidate().issue, body: planted } }), corpus(), { cutoff: "2026-07-01" });
	assert.ok(kinds(r).includes("near-duplicate"), JSON.stringify(r.hits));
	assert.match(r.hits.find((h) => h.kind === "near-duplicate").detail, /practice:csv-export/);
	assert.equal(r.clean, false);
	// A task is never compared with its own request.
	assert.ok(scan({ id: "csv-export", request: PRACTICE_REQUEST, source: { repo: "x/y", issueCreatedAt: "2026-08-01", prMergedAt: "2026-08-02" } }, corpus(), { cutoff: "2026-07-01" }).clean);
});

test("a candidate named in loop-visible text, seen before, or from a loop-visible repository is caught", () => {
	assert.deepEqual([...references("see https://github.com/Acme/Widgets/pull/41 and acme/widgets#40")].sort(), ["acme/widgets#40", "acme/widgets#41"]);
	const mentioned = scan(candidate(), corpus({ docs: [{ id: "public:reviews/x.md", source: "public", text: "fixed in https://github.com/acme/widgets/pull/41" }] }), { cutoff: "2026-07-01" });
	assert.deepEqual(kinds(mentioned), ["mentioned"]);
	const seen = scan(candidate(), corpus({ seen: [{ id: "acme-widgets-41-old", source: "exam", repo: "acme/widgets", pr: 41 }] }), { cutoff: "2026-07-01" });
	assert.deepEqual(kinds(seen), ["seen"]);
	const sameIssue = scan(candidate(), corpus({ seen: [{ id: "other", source: "exam", repo: "Acme/Widgets", pr: 9, issue: 40 }] }), { cutoff: "2026-07-01" });
	assert.match(sameIssue.hits[0].detail, /the same issue acme\/widgets#40/);
	// Another pull request from the same base commit is another task.
	assert.ok(scan(candidate(), corpus({ seen: [{ id: "sibling", source: "an earlier candidate", repo: "acme/widgets", pr: 45, issue: 44, baseCommit: "abc123" }] }), { cutoff: "2026-07-01" }).clean);
	const repo = scan(candidate(), corpus({ repos: [{ repo: "acme/widgets", source: "practice task csv-export" }] }), { cutoff: "2026-07-01" });
	assert.deepEqual(kinds(repo), ["same repository"]);
});

test("a candidate dated before the cutoff, or out of order, is caught", () => {
	const old = scan(candidate({ issue: { ...candidate().issue, createdAt: "2026-06-01T00:00:00Z" } }), corpus(), { cutoff: "2026-07-01" });
	assert.match(old.hits[0].detail, /issue opened 2026-06-01, not after the cutoff/);
	const merged = scan(candidate({ pr: { ...candidate().pr, mergedAt: "2026-06-20T00:00:00Z" }, issue: { ...candidate().issue, createdAt: "2026-06-10T00:00:00Z" } }), corpus(), { cutoff: "2026-07-01" });
	assert.equal(merged.hits.filter((h) => h.kind === "dates").length, 2);
	const backwards = scan(candidate({ issue: { ...candidate().issue, createdAt: "2026-09-20T00:00:00Z" } }), corpus(), { cutoff: "2026-07-01" });
	assert.match(backwards.hits.map((h) => h.detail).join(), /opened after the fix merged/);
	const earlier = scan(candidate(), corpus(), { cutoff: "2026-08-01" });
	assert.match(earlier.hits.map((h) => h.detail).join(), /mined with the earlier cutoff 2026-07-01/);
	assert.match(scan(candidate({ pr: { number: 41, title: "x" } }), corpus(), { cutoff: "2026-07-01" }).hits[0].detail, /no fix merged date/);
});

test("the real corpus holds this repository's files, so its fixtures' repositories are caught", async () => {
	const exam = mkdtempSync(join(tmpdir(), "contamination-"));
	mkdirSync(join(exam, "tasks"));
	const c = await corpusFor({ exam, candidates: [] });
	const fixture = scan(candidate({ id: "jamshids-aiset-3", repo: "JamshidS/aiset" }), c, { cutoff: "2026-07-01" });
	assert.ok(kinds(fixture).includes("same repository"));
	assert.ok(shingles("one two three four five six").size === 2);
});
