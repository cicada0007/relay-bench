import assert from "node:assert/strict";
import { test } from "node:test";
import { add } from "../src/math.js";

test("add", () => assert.equal(add(2, 3), 5));
import { multiply } from "../src/math.js";

test("multiply", () => assert.equal(multiply(4, 5), 20));
