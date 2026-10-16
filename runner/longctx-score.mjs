// Test G's scoring: each benchmark's own rule, ported line for line from its published evaluation code, so a tool's
// final answer is graded exactly as the benchmark's authors grade a model's. No model is asked to judge.
//
// - OOLONG-synth: synth_attempt_answer_parse and synth_process_response in src/eval/eval_helpers.py of
//   github.com/abertsch72/oolong at commit 0bb7eabe839218fee7fe8d007f41cfc2fd3ae24c (MIT).
// - LongBench v2: extract_answer in pred.py and the accuracy in result.py of github.com/THUDM/LongBench at commit
//   2e00731f8d0bff23dc4325161044d0ed8af94c1e (Apache-2.0); the uncompensated score (no 0.25 for an unparsed answer).

export const SCORERS = {
	oolong: { repo: "https://github.com/abertsch72/oolong", commit: "0bb7eabe839218fee7fe8d007f41cfc2fd3ae24c", file: "src/eval/eval_helpers.py" },
	longbench: { repo: "https://github.com/THUDM/LongBench", commit: "2e00731f8d0bff23dc4325161044d0ed8af94c1e", file: "pred.py, result.py" },
};

/** OOLONG's synth_attempt_answer_parse: the text after the last colon, without * [ ], or a fallback for no colon. */
export function oolongParse(answer) {
	let confidence = "low";
	if (!answer.includes(":")) {
		// Python's answer.split()[-1] splits on runs of whitespace and fails on an empty answer; an empty one scores 0.
		if (answer.length < 20) return { parsed: answer, confidence };
		const words = answer.trim().split(/\s+/);
		return { parsed: words[words.length - 1], confidence };
	}
	let candidate = answer.split(":").pop().trim();
	candidate = candidate.replaceAll("*", "").replaceAll("[", "").replaceAll("]", "");
	confidence = "med";
	if (answer.includes("User:") || answer.includes("Answer:") || answer.includes("Date:") || answer.includes("Label")) {
		confidence = "high";
	}
	if (candidate.length < 20) confidence = "vhigh";
	else if (candidate.includes("more common")) candidate = "more common";
	else if (candidate.includes("less common")) candidate = "less common";
	else if (candidate.includes("same frequency")) candidate = "same frequency";
	return { parsed: candidate, confidence };
}

/** Python's ast.literal_eval(answer)[0] for the dataset's answers, which are one-element lists of strings or ints. */
function oolongGold(answer) {
	const m = /^\[\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(-?\d+))\s*\]$/.exec(answer.trim());
	if (!m) throw new Error(`unexpected OOLONG answer ${answer}`);
	if (m[3] !== undefined) return m[3];
	return (m[1] ?? m[2]).replace(/\\(.)/g, "$1");
}

/** OOLONG's synth_process_response score for one final answer: 1, 0, or 0.75^|difference| for a numeric answer. */
export function scoreOolong(item, output) {
	if (item.answerType === "ANSWER_TYPE.DATE" || item.answer.includes("datetime")) {
		// Not in test G's sample (OOLONG yahoo at 128k has label and comparison answers only); refuse rather than guess
		// at dateutil's parser.
		throw new Error("date answers are not ported");
	}
	const gold = oolongGold(item.answer);
	const { parsed, confidence } = oolongParse(output);
	let score = 0;
	if (parsed === gold) score = 1;
	else if (["more common", "less common", "same frequency"].includes(parsed)) {
		if (gold.includes(parsed)) score = 1;
	} else if (item.answerType === "ANSWER_TYPE.NUMERIC") {
		// Python's int() accepts surrounding whitespace, an optional sign and underscores between digits.
		const asInt = (s) => (/^\s*[+-]?\d+(_\d+)*\s*$/.test(s) ? Number(s.replaceAll("_", "")) : undefined);
		const a = asInt(parsed);
		const g = asInt(gold);
		if (a !== undefined && g !== undefined) score = 0.75 ** Math.abs(g - a);
	}
	return { score, parsed, confidence, gold };
}

/** LongBench v2's extract_answer and judge: the letter in "The correct answer is (X)" (or without brackets). */
export function scoreLongBench(item, output) {
	const response = output.replaceAll("*", "");
	const match = /The correct answer is \(([A-D])\)/.exec(response) ?? /The correct answer is ([A-D])/.exec(response);
	const parsed = match ? match[1] : null;
	return { score: parsed === item.answer ? 1 : 0, parsed, gold: item.answer };
}

export function scoreItem(set, item, output) {
	if (set === "oolong") return scoreOolong(item, output);
	if (set === "longbench") return scoreLongBench(item, output);
	throw new Error(`unknown set ${set}`);
}
