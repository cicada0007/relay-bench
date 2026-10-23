// Group-sequential boundaries for the gate (GATE.md, amendment 1): how strict each look at a release's results must be
// so that looking several times never raises the chance of a false accept above alpha.
//
// The gate's question at each look is one-sided: is the mean per-task difference above a line (0 for "better", -5 for
// "no worse"), or below 0 for "worse"? With one look, a 95% interval is right: each side is wrong 2.5% of the time.
// Looking again at more tasks gives more chances to be wrong, so each look gets its own, stricter boundary. A spending
// function fixes in advance how much of the 2.5% may be used up by each share of the planned tasks ("information
// fraction"); the boundaries follow from it by numerical integration (Lan and DeMets, 1983; Jennison and Turnbull,
// "Group Sequential Methods", 2000, chapter 19). Pure: numbers in, numbers out.

/** erfc with fractional error below 1.2e-7 everywhere (Numerical Recipes, erfcc). */
function erfc(x) {
	const z = Math.abs(x);
	const t = 1 / (1 + 0.5 * z);
	const r =
		t *
		Math.exp(
			-z * z -
				1.26551223 +
				t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
		);
	return x >= 0 ? r : 2 - r;
}

/** The standard normal distribution function. */
export const normalCdf = (x) => (x === Infinity ? 1 : x === -Infinity ? 0 : 0.5 * erfc(-x / Math.SQRT2));
/** The standard normal density. */
export const normalPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** The standard normal quantile (Acklam's approximation, then one Newton step). */
export function normalInv(p) {
	if (!(p > 0 && p < 1)) {
		if (p === 0) return -Infinity;
		if (p === 1) return Infinity;
		throw new Error(`normalInv needs 0 < p < 1, not ${p}`);
	}
	const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
	const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
	const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
	const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
	const low = 0.02425;
	let x;
	if (p < low) {
		const q = Math.sqrt(-2 * Math.log(p));
		x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
	} else if (p <= 1 - low) {
		const q = p - 0.5;
		const r = q * q;
		x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
	} else {
		const q = Math.sqrt(-2 * Math.log(1 - p));
		x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
	}
	const e = normalCdf(x) - p;
	return x - e / normalPdf(x);
}

/** log Γ(x), Lanczos. */
function logGamma(x) {
	const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
	let y = x;
	const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
	let ser = 1.000000000190015;
	for (const v of g) ser += v / ++y;
	return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** The continued fraction of the incomplete beta function (Numerical Recipes, betacf). */
function betacf(a, b, x) {
	const tiny = 1e-300;
	let c = 1;
	let d = 1 - ((a + b) * x) / (a + 1);
	if (Math.abs(d) < tiny) d = tiny;
	d = 1 / d;
	let h = d;
	for (let m = 1; m <= 300; m++) {
		const m2 = 2 * m;
		let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
		d = 1 + aa * d;
		if (Math.abs(d) < tiny) d = tiny;
		c = 1 + aa / c;
		if (Math.abs(c) < tiny) c = tiny;
		d = 1 / d;
		h *= d * c;
		aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
		d = 1 + aa * d;
		if (Math.abs(d) < tiny) d = tiny;
		c = 1 + aa / c;
		if (Math.abs(c) < tiny) c = tiny;
		d = 1 / d;
		const del = d * c;
		h *= del;
		if (Math.abs(del - 1) < 3e-15) break;
	}
	return h;
}

/** The regularized incomplete beta function I_x(a, b). */
function betaInc(a, b, x) {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
	return x < (a + 1) / (a + b + 2) ? (front * betacf(a, b, x)) / a : 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** Student's t distribution function with `df` degrees of freedom. */
export function tCdf(t, df) {
	if (t === Infinity) return 1;
	if (t === -Infinity) return 0;
	const tail = 0.5 * betaInc(df / 2, 0.5, df / (df + t * t));
	return t >= 0 ? 1 - tail : tail;
}

const tInvCache = new Map();
/** Student's t quantile, by bisection on tCdf (the boundaries need it at most a few times per look). */
export function tInv(p, df) {
	if (p >= 1) return Infinity;
	if (p <= 0) return -Infinity;
	const key = `${p}|${df}`;
	if (tInvCache.has(key)) return tInvCache.get(key);
	// Upper tail probabilities as small as 1e-9 lie well inside +-1e4 for any df >= 1.
	let lo = -1e4;
	let hi = 1e4;
	for (let i = 0; i < 200 && hi - lo > 1e-10; i++) {
		const mid = (lo + hi) / 2;
		if (tCdf(mid, df) < p) lo = mid;
		else hi = mid;
	}
	const x = (lo + hi) / 2;
	tInvCache.set(key, x);
	return x;
}

/** How much of the one-sided alpha a spending function allows to be used by information fraction t (0 to 1). */
export const SPENDING = Object.freeze({
	/** Lan-DeMets O'Brien-Fleming-type: almost nothing early, nearly all of alpha kept for the last look. */
	"obrien-fleming": (t, alpha) => (t <= 0 ? 0 : t >= 1 ? alpha : 2 - 2 * normalCdf(normalInv(1 - alpha / 2) / Math.sqrt(t))),
	/** Lan-DeMets Pocock-type: about the same share at every look, so the last look is much stricter. */
	pocock: (t, alpha) => (t <= 0 ? 0 : t >= 1 ? alpha : alpha * Math.log(1 + (Math.E - 1) * t)),
});

/** Simpson weights for an evenly spaced grid of an odd number of points from a to b. */
function simpson(a, b, points) {
	const h = (b - a) / (points - 1);
	const z = new Float64Array(points);
	const w = new Float64Array(points);
	for (let i = 0; i < points; i++) {
		z[i] = a + i * h;
		w[i] = (h / 3) * (i === 0 || i === points - 1 ? 1 : i % 2 ? 4 : 2);
	}
	return { z, w };
}

const GRID = 801;
const LOWEST = -8;
const boundaryCache = new Map();

/**
 * The efficacy boundaries, on the z scale, for looks at the given information fractions (increasing, the last one 1
 * when the plan is complete). Each boundary b_k is set so that, with no true difference, the chance of first crossing
 * at look k is exactly what the spending function allows between t_(k-1) and t_k. A fraction above 1 counts as 1.
 * Returns [{ fraction, spent, increment, z }], where `spent` is the alpha used up to and including that look.
 */
export function boundaries(fractions, { alpha = 0.025, spending = "obrien-fleming" } = {}) {
	const spend = SPENDING[spending];
	if (!spend) throw new Error(`unknown spending function ${spending}; known: ${Object.keys(SPENDING).join(", ")}`);
	if (!fractions.length) throw new Error("boundaries need at least one look");
	const ts = fractions.map((t) => Math.min(1, t));
	for (let i = 0; i < ts.length; i++) {
		if (!(ts[i] > 0)) throw new Error(`information fraction ${fractions[i]} is not above 0`);
		if (i && !(ts[i] > ts[i - 1])) throw new Error(`information fractions must increase: ${fractions.join(", ")}`);
	}
	const key = `${spending}|${alpha}|${ts.join(",")}`;
	if (boundaryCache.has(key)) return boundaryCache.get(key);

	const out = [];
	let spentBefore = 0;
	// The density of Z_(k-1) over the region where no earlier look crossed, on a grid.
	let grid = null;
	let density = null;
	for (let k = 0; k < ts.length; k++) {
		const spent = spend(ts[k], alpha);
		const increment = Math.max(0, spent - spentBefore);
		let b;
		if (k === 0) {
			b = increment > 0 ? normalInv(1 - increment) : Infinity;
		} else {
			const ik = ts[k];
			const ip = ts[k - 1];
			const step = Math.sqrt(ik - ip);
			const cross = (bound) => {
				let p = 0;
				for (let i = 0; i < grid.z.length; i++) p += grid.w[i] * density[i] * (1 - normalCdf((bound * Math.sqrt(ik) - grid.z[i] * Math.sqrt(ip)) / step));
				return p;
			};
			if (increment <= 0) b = Infinity;
			else {
				let lo = -10;
				let hi = 20;
				for (let i = 0; i < 100 && hi - lo > 1e-9; i++) {
					const mid = (lo + hi) / 2;
					if (cross(mid) > increment) lo = mid;
					else hi = mid;
				}
				b = (lo + hi) / 2;
			}
		}
		out.push({ fraction: ts[k], spent: spentBefore + increment, increment, z: b });
		spentBefore += increment;
		if (k === ts.length - 1) break;
		// The density of Z_k where it did not cross, for the next look.
		const top = Number.isFinite(b) ? b : 12;
		const next = simpson(LOWEST, top, GRID);
		const nextDensity = new Float64Array(GRID);
		if (k === 0) {
			for (let j = 0; j < GRID; j++) nextDensity[j] = normalPdf(next.z[j]);
		} else {
			const ik = ts[k];
			const ip = ts[k - 1];
			const step = Math.sqrt(ik - ip);
			const scale = Math.sqrt(ik) / step;
			for (let j = 0; j < GRID; j++) {
				let s = 0;
				for (let i = 0; i < grid.z.length; i++) s += grid.w[i] * density[i] * normalPdf((next.z[j] * Math.sqrt(ik) - grid.z[i] * Math.sqrt(ip)) / step);
				nextDensity[j] = s * scale;
			}
		}
		grid = next;
		density = nextDensity;
	}
	const frozen = Object.freeze(out.map((b) => Object.freeze(b)));
	boundaryCache.set(key, frozen);
	return frozen;
}

/**
 * A z boundary carried over to Student's t for a look over `n` tasks: the same nominal one-sided level, on n - 1
 * degrees of freedom, so a look at 20 tasks is not judged as if its spread were known exactly.
 */
export function tBoundary(z, n) {
	if (!Number.isFinite(z)) return z;
	if (n < 2) return Infinity;
	return tInv(normalCdf(z), n - 1);
}
