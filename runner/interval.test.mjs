// The cautious low end (runner/interval.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { cautiousLow, elStatistic } from "./interval.mjs";

const group = (xs) => {
	const m = new Map();
	for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
	return { v: [...m.keys()], c: [...m.values()] };
};

test("the likelihood statistic is zero at the mean, grows away from it, and is infinite outside the data", () => {
	const data = group([-100, 0, 0, 0, 100, 100]);
	assert.ok(Math.abs(elStatistic(data, 100 / 6)) < 1e-9);
	assert.ok(elStatistic(data, -20) > elStatistic(data, 0));
	assert.equal(elStatistic(data, 100), Infinity);
	assert.equal(elStatistic(group([5, 5]), 5), 0);
});

test("for symmetric, spread-out data it is close to the plain t interval", () => {
	const diffs = Array.from({ length: 200 }, (_, i) => ((i * 37) % 101) - 50);
	const m = diffs.reduce((s, x) => s + x, 0) / diffs.length;
	const sd = Math.sqrt(diffs.reduce((s, x) => s + (x - m) ** 2, 0) / (diffs.length - 1));
	const plain = m - 1.97 * (sd / Math.sqrt(diffs.length));
	assert.ok(Math.abs(cautiousLow(diffs, 1.97) - plain) < 0.5);
});

test("when a few tasks differ and all one way, it sits lower than the plain end", () => {
	const diffs = [...Array(388).fill(0), ...Array(12).fill(-100)];
	const m = -3;
	const sd = Math.sqrt(diffs.reduce((s, x) => s + (x - m) ** 2, 0) / (diffs.length - 1));
	const plain = m - 1.966 * (sd / Math.sqrt(diffs.length));
	const low = cautiousLow(diffs, 1.966);
	assert.ok(plain > -5, "the plain end would pass");
	assert.ok(low < -5, `the cautious end does not: ${low}`);
});

test("with every task tied it still keeps a margin of doubt; an infinite boundary gives the floor", () => {
	assert.ok(cautiousLow(Array(40).fill(0), 2.02) < -5);
	assert.ok(cautiousLow(Array(200).fill(0), 1.97) > -5);
	assert.equal(cautiousLow([1, 2], Infinity), -100);
});
