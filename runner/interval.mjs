// The low end of the gate's interval: the line a PASS must clear (GATE.md, amendment 1). Pure: numbers in, numbers out.
//
// Two versions of one coding tool mostly tie task by task; the tasks that differ are few. A plain interval
// (mean ± c × sd / √n) then fails in a known way: when a small sample happens to hold fewer differing tasks than the
// truth, both its mean and its spread come out small, and it accepts too often (the Wald interval's failure for rare
// events). Two things correct it:
// 1. Two make-believe tasks, one the candidate won by the most a task can differ (100 points) and one it lost by as
//    much (Bonett and Price, 2012). A sample in which every task ties then still cannot pass on 20 tasks.
// 2. Empirical likelihood (Owen, 1988): for each value the true mean could take, the tasks are reweighted as little as
//    possible to have that mean, and the test asks how unlikely the sample is under those weights. The spread is then
//    the one the hypothesis implies, not the one the sample happened to show, as in a score test. The low end is the
//    lowest mean the test does not reject at the look's boundary c.

/** Distinct values and their counts. */
function grouped(values, weights) {
	const counts = new Map();
	values.forEach((v, i) => counts.set(v, (counts.get(v) ?? 0) + (weights?.[i] ?? 1)));
	return { v: [...counts.keys()], c: [...counts.values()] };
}

/**
 * -2 log of the empirical likelihood ratio for the mean `mu`, over values `v` with counts `c`. Infinite when `mu` lies
 * outside the values' range; zero at their mean.
 */
export function elStatistic({ v, c }, mu) {
	let min = Infinity;
	let max = -Infinity;
	for (const x of v) {
		if (x < min) min = x;
		if (x > max) max = x;
	}
	if (min === max) return mu === min ? 0 : Infinity;
	if (!(mu > min && mu < max)) return Infinity;
	// Solve sum c (x - mu) / (1 + l (x - mu)) = 0 for l, inside the range that keeps every weight positive. The left side
	// falls from +inf to -inf across that range; Newton steps, kept inside a bracket that bisection would also keep.
	let lo = -1 / (max - mu);
	let hi = 1 / (mu - min);
	let l = 0;
	for (let i = 0; i < 100; i++) {
		let g = 0;
		let dg = 0;
		for (let j = 0; j < v.length; j++) {
			const d = v[j] - mu;
			const den = 1 + l * d;
			g += (c[j] * d) / den;
			dg -= (c[j] * d * d) / (den * den);
		}
		if (g > 0) lo = l;
		else hi = l;
		let next = l - g / dg;
		if (!(next > lo && next < hi)) next = (lo + hi) / 2;
		if (Math.abs(next - l) < 1e-15 * Math.max(1, Math.abs(l))) {
			l = next;
			break;
		}
		l = next;
	}
	let s = 0;
	for (let j = 0; j < v.length; j++) s += c[j] * Math.log(1 + l * (v[j] - mu));
	return Math.max(0, 2 * s);
}

/**
 * The lowest mean not rejected at boundary `c` (one-sided), from per-task differences with the make-believe pair
 * at ±`bound` added. `c` infinite gives -bound.
 */
export function cautiousLow(diffs, c, { bound = 100 } = {}) {
	if (!diffs.length) return null;
	if (!Number.isFinite(c)) return -bound;
	const data = grouped([...diffs, bound, -bound]);
	const total = data.c.reduce((s, x) => s + x, 0);
	const centre = data.v.reduce((s, x, j) => s + x * data.c[j], 0) / total;
	const target = c * c;
	let lo = -bound;
	let hi = centre;
	for (let i = 0; i < 60 && hi - lo > 1e-9; i++) {
		const mid = (lo + hi) / 2;
		if (elStatistic(data, mid) > target) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}
