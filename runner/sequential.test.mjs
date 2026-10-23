// Alpha spending (runner/sequential.mjs): the boundaries against published values, and against simulation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { rng } from "./analyze.mjs";
import { boundaries, normalCdf, normalInv, SPENDING, tBoundary, tCdf, tInv } from "./sequential.mjs";

const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

test("the normal and t functions agree with their tables", () => {
	close(normalInv(0.975), 1.959964, 1e-6, "z 0.975");
	close(normalCdf(-3), 0.0013499, 1e-7, "Phi(-3)");
	close(normalInv(1 - 1e-4), 3.719016, 1e-5, "z 0.9999");
	close(tInv(0.975, 19), 2.093024, 1e-5, "t 0.975, 19");
	close(tInv(0.975, 9), 2.262157, 1e-5, "t 0.975, 9");
	close(tCdf(2.093024, 19), 0.975, 1e-6, "T(2.093, 19)");
	close(tCdf(-1, 5) + tCdf(1, 5), 1, 1e-12, "t symmetry");
});

test("one look is the fixed 95% boundary, whatever the spending function", () => {
	for (const spending of Object.keys(SPENDING)) close(boundaries([1], { spending })[0].z, 1.959964, 1e-5, spending);
});

test("O'Brien-Fleming-type boundaries match the published values (Lan-DeMets, one-sided 0.025)", () => {
	const published = {
		2: [2.9626, 1.9686],
		3: [3.7103, 2.5114, 1.993],
		4: [4.3326, 2.9631, 2.359, 2.0141],
		5: [4.8769, 3.357, 2.6803, 2.2898, 2.031],
	};
	for (const [k, expected] of Object.entries(published)) {
		const ts = Array.from({ length: Number(k) }, (_, i) => (i + 1) / Number(k));
		boundaries(ts).forEach((b, i) => close(b.z, expected[i], 1e-3, `look ${i + 1} of ${k}`));
	}
});

test("Pocock-type boundaries are nearly level, and the last is stricter than O'Brien-Fleming's", () => {
	const p = boundaries([1 / 3, 2 / 3, 1], { spending: "pocock" }).map((b) => b.z);
	assert.ok(Math.max(...p) - Math.min(...p) < 0.05, p.join(", "));
	assert.ok(p[2] > boundaries([1 / 3, 2 / 3, 1])[2].z + 0.25);
});

test("every look's alpha adds up to the whole alpha, and unequal looks are allowed", () => {
	const b = boundaries([0.2, 0.55, 1]);
	close(b[2].spent, 0.025, 1e-12, "spent");
	close(b.reduce((s, x) => s + x.increment, 0), 0.025, 1e-12, "increments");
	assert.ok(b[0].z > b[1].z && b[1].z > b[2].z);
	assert.throws(() => boundaries([0.5, 0.5]), /must increase/);
	assert.throws(() => boundaries([0.5], { spending: "haybittle" }), /unknown spending/);
});

test("simulated with no true difference, the boundaries are crossed with chance alpha", () => {
	const next = rng(20261015);
	const gauss = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
	for (const [spending, ts] of [
		["obrien-fleming", [1 / 3, 2 / 3, 1]],
		["pocock", [0.25, 0.5, 0.75, 1]],
		["obrien-fleming", [0.3, 0.6, 1]],
	]) {
		const b = boundaries(ts, { spending });
		const sims = 100_000;
		let crossed = 0;
		for (let i = 0; i < sims; i++) {
			let s = 0;
			let prev = 0;
			for (let k = 0; k < ts.length; k++) {
				s += gauss() * Math.sqrt(ts[k] - prev);
				prev = ts[k];
				if (s / Math.sqrt(ts[k]) >= b[k].z) {
					crossed++;
					break;
				}
			}
		}
		close(crossed / sims, 0.025, 0.002, `${spending} at ${ts.join(", ")}`);
	}
});

test("a boundary on few tasks is carried over to t, so it is wider than on many", () => {
	assert.ok(tBoundary(1.96, 20) > tBoundary(1.96, 200));
	close(tBoundary(1.959964, 20), 2.093024, 1e-4, "20 tasks");
	assert.equal(tBoundary(Infinity, 20), Infinity);
});
