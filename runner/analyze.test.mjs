import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrap, rng, word } from "./analyze.mjs";

test("the seeded generator repeats exactly", () => {
	const a = rng(20261015);
	const b = rng(20261015);
	for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test("the bootstrap interval is reproducible and brackets the mean", () => {
	const diffs = [10, 20, 30, 40, 0, 50, 25, 35, 15, 45, 5, 30];
	const one = bootstrap(diffs);
	const two = bootstrap(diffs);
	assert.deepEqual(one, two);
	assert.ok(one.low < 25.4 && one.high > 25.4);
});

test("the words follow the pre-registered rule", () => {
	assert.equal(word({ low: 16, high: 40 }), "much better");
	assert.equal(word({ low: 15, high: 40 }), "better");
	assert.equal(word({ low: 0.1, high: 10 }), "better");
	assert.equal(word({ low: -3, high: 12 }), "no clear difference");
	assert.equal(word({ low: -20, high: -1 }), "worse");
});
