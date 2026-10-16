import assert from "node:assert/strict";
import { test } from "node:test";
import { oolongParse, scoreLongBench, scoreOolong } from "./longctx-score.mjs";

const label = { answer: "['Sports']", answerType: "ANSWER_TYPE.LABEL" };
const comparison = { answer: "['more common than']", answerType: "ANSWER_TYPE.COMPARISON" };

test("OOLONG labels match exactly after the last colon, without * and brackets", () => {
	assert.equal(scoreOolong(label, "I counted every line.\n\nLabel: Sports").score, 1);
	assert.equal(scoreOolong(label, "Label: **[Sports]**").score, 1);
	assert.equal(scoreOolong(label, "Label: sports").score, 0);
	assert.equal(scoreOolong(label, "Label: Health").score, 0);
	// A short answer with no colon is compared whole, as the original does.
	assert.equal(scoreOolong(label, "Sports").score, 1);
	assert.equal(scoreOolong(label, "The most common label is Sports").score, 1);
	assert.equal(scoreOolong(label, "").score, 0);
});

test("OOLONG comparisons accept the phrase inside a longer sentence", () => {
	assert.equal(scoreOolong(comparison, "Answer: Business & Finance is more common than Health").score, 1);
	assert.equal(scoreOolong(comparison, "Answer: Business & Finance is less common than Health").score, 0);
	assert.equal(oolongParse("Answer: Business & Finance is same frequency as Health").parsed, "same frequency");
	assert.equal(scoreOolong({ answer: "['same frequency as']", answerType: "ANSWER_TYPE.COMPARISON" }, "Answer: A is same frequency as B").score, 1);
});

test("OOLONG numeric answers get 0.75 to the power of the difference", () => {
	const numeric = { answer: "[12]", answerType: "ANSWER_TYPE.NUMERIC" };
	assert.equal(scoreOolong(numeric, "Answer: 12").score, 1);
	assert.equal(scoreOolong(numeric, "Answer: 10").score, 0.75 ** 2);
	assert.equal(scoreOolong(numeric, "Answer: twelve").score, 0);
});

test("LongBench v2 reads the letter from 'The correct answer is (X)'", () => {
	const item = { answer: "C" };
	assert.equal(scoreLongBench(item, "Reasoning...\nThe correct answer is (C)").score, 1);
	assert.equal(scoreLongBench(item, "**The correct answer is C**").score, 1);
	assert.equal(scoreLongBench(item, "The correct answer is (B)").score, 0);
	assert.equal(scoreLongBench(item, "The answer is C").parsed, null);
	// The first match counts, as re.search does.
	assert.equal(scoreLongBench(item, "The correct answer is (A)... no, The correct answer is (C)").score, 0);
});
