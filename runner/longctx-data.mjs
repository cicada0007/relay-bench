#!/usr/bin/env node
// Test G's data (PREREGISTRATION.md): two long-context benchmarks from Prime Agent's published same-model table, each
// with public data and a mechanical scorer (runner/longctx-score.mjs). This script downloads both at pinned revisions,
// draws the fixed sample with a seeded generator, and writes the manifest, runner/longctx-manifest.json, which is
// committed. Anyone running it again gets the same manifest, byte for byte; --check proves the local copy still matches.
//
//   node runner/longctx-data.mjs            download (once) into runs/longctx-data/ and write the manifest
//   node runner/longctx-data.mjs --check    verify the downloaded data against the committed manifest
//
// - OOLONG (yahoo, 128k): every OOLONG-synth test row with dataset "yahoo" and a 131,072-token window. There are 50, so
//   the sample of 50 is all of them; the seeded order still decides which 25 run if the round shrinks (the first 25).
//   Needs uv: the rows are read from the dataset's parquet with DuckDB (runner/longctx_oolong.py).
// - LongBench v2: 50 of its 503 questions, drawn uniformly.
//
// The sample: each set's ids in ascending order, shuffled by Fisher-Yates with mulberry32 seeded 20261015 (the round's
// seed, runner/analyze.mjs), then the first 50. Items are listed in that drawn order.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { rng, SEED } from "./analyze.mjs";
import { SCORERS } from "./longctx-score.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
export const DATA_DIR = join(ROOT, "runs", "longctx-data");
export const MANIFEST_PATH = join(ROOT, "runner", "longctx-manifest.json");
export const SAMPLE_SIZE = 50;

export const SOURCES = {
	oolong: {
		name: "OOLONG-synth, yahoo, 128k",
		dataset: "oolongbench/oolong-synth",
		revision: "f0d59eaf0febf130664cfceb710436c8e3216b2b",
		split: "test",
		filter: "dataset = 'yahoo' and context_len = 131072",
		files: ["data/test-00021-of-00041.parquet", "data/test-00022-of-00041.parquet"],
		local: "oolong-yahoo-128k.jsonl",
	},
	longbench: {
		name: "LongBench v2",
		dataset: "zai-org/LongBench-v2 (formerly THUDM/LongBench-v2)",
		revision: "2b48e494f2c7a2f0af81aae178e05c7e1dde0fe9",
		split: "train (the whole set, 503 questions)",
		files: ["data.json"],
		url: "https://huggingface.co/datasets/zai-org/LongBench-v2/resolve/2b48e494f2c7a2f0af81aae178e05c7e1dde0fe9/data.json",
		sha256: "15d61c22d92c96900b3c4948b6aeea218d3214b676a65df48e7b8555604c7fe2",
		local: "longbench-v2.json",
	},
};

const sha = (data) => createHash("sha256").update(data).digest("hex");

/** Fisher-Yates with the round's seeded generator. */
export function seededShuffle(items, seed = SEED) {
	const next = rng(seed);
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** Every row of both sets, with the context each tool is given and what the scorer needs. */
export function loadRows() {
	const oolongPath = join(DATA_DIR, SOURCES.oolong.local);
	const longbenchPath = join(DATA_DIR, SOURCES.longbench.local);
	if (!existsSync(oolongPath) || !existsSync(longbenchPath)) {
		throw new Error(`test G's data is not downloaded; run: node runner/longctx-data.mjs`);
	}
	const oolong = readFileSync(oolongPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.map((r) => ({
			id: String(r.id),
			context: r.context_window_text,
			question: r.question,
			answer: r.answer,
			answerType: r.answer_type,
			meta: { contextWindowId: r.context_window_id, task: r.task, answerType: r.answer_type, contextLen: r.context_len },
		}));
	const longbenchRaw = readFileSync(longbenchPath);
	if (sha(longbenchRaw) !== SOURCES.longbench.sha256) throw new Error(`${longbenchPath} does not match the pinned sha256`);
	const longbench = JSON.parse(longbenchRaw.toString("utf8")).map((r) => ({
		id: r._id,
		context: r.context,
		question: r.question,
		choices: { A: r.choice_A, B: r.choice_B, C: r.choice_C, D: r.choice_D },
		answer: r.answer,
		meta: { domain: r.domain, subDomain: r.sub_domain, difficulty: r.difficulty, length: r.length },
	}));
	return { oolong, longbench };
}

export function buildManifest(rows) {
	const sets = {};
	for (const [set, all] of Object.entries(rows)) {
		const ids = all.map((r) => r.id).sort((a, b) => (set === "oolong" ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0));
		const drawn = seededShuffle(ids).slice(0, SAMPLE_SIZE);
		const byId = new Map(all.map((r) => [r.id, r]));
		const { local, url, ...source } = SOURCES[set];
		sets[set] = {
			source,
			scorer: SCORERS[set],
			population: all.length,
			items: drawn.map((id) => {
				const r = byId.get(id);
				return {
					id,
					answer: r.answer,
					...(r.answerType ? { answerType: r.answerType } : {}),
					...r.meta,
					contextChars: r.context.length,
					contextSha256: sha(r.context),
					questionSha256: sha(JSON.stringify([r.question, r.choices ?? null])),
				};
			}),
		};
	}
	return {
		test: "G",
		seed: SEED,
		sampleSize: SAMPLE_SIZE,
		rule: "each set's ids in ascending order, Fisher-Yates shuffled with mulberry32(seed), first sampleSize; a shrunk round runs the first 25 of each set",
		sets,
	};
}

async function download() {
	mkdirSync(DATA_DIR, { recursive: true });
	const lb = SOURCES.longbench;
	const lbPath = join(DATA_DIR, lb.local);
	if (!existsSync(lbPath)) {
		console.log(`downloading ${lb.name} (465 MB)…`);
		const response = await fetch(lb.url);
		if (!response.ok) throw new Error(`${lb.url}: HTTP ${response.status}`);
		await pipeline(Readable.fromWeb(response.body), createWriteStream(`${lbPath}.part`));
		if (sha(readFileSync(`${lbPath}.part`)) !== lb.sha256) throw new Error(`${lb.name}: sha256 differs from the pinned one`);
		renameSync(`${lbPath}.part`, lbPath);
	}
	const oo = SOURCES.oolong;
	const ooPath = join(DATA_DIR, oo.local);
	if (!existsSync(ooPath)) {
		console.log(`exporting ${oo.name} from its parquet with DuckDB…`);
		const r = spawnSync("uv", ["run", "--quiet", "--with", "duckdb==1.3.2", "python", "-I", join(ROOT, "runner", "longctx_oolong.py"), oo.revision, `${ooPath}.part`], {
			stdio: ["ignore", "pipe", "inherit"],
			encoding: "utf8",
		});
		if (r.status !== 0 || r.stdout.trim() !== "50") throw new Error(`the OOLONG export failed (${r.stdout.trim() || r.status})`);
		renameSync(`${ooPath}.part`, ooPath);
	}
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { values: args } = parseArgs({ options: { check: { type: "boolean", default: false } } });
	if (!args.check) await download();
	const manifest = `${JSON.stringify(buildManifest(loadRows()), null, 1)}\n`;
	if (args.check) {
		const committed = readFileSync(MANIFEST_PATH, "utf8");
		if (committed !== manifest) {
			console.error("the downloaded data does not give the committed manifest");
			process.exit(1);
		}
		console.log("ok: the downloaded data gives the committed manifest");
	} else {
		writeFileSync(MANIFEST_PATH, manifest);
		const m = JSON.parse(manifest);
		for (const [set, s] of Object.entries(m.sets)) console.log(`${set}: ${s.items.length} of ${s.population} drawn`);
		console.log(`wrote ${MANIFEST_PATH}`);
	}
}
