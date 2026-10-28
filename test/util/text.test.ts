import { test } from "node:test";
import assert from "node:assert/strict";
import { headSlice, tailSlice, hasLoneSurrogate, jsonbStringify } from "../../src/util/text.ts";

test("headSlice and tailSlice pass short strings through and cut long ones", () => {
  assert.equal(headSlice("abc", 5), "abc");
  assert.equal(tailSlice("abc", 5), "abc");
  assert.equal(headSlice("abcdef", 3), "abc");
  assert.equal(tailSlice("abcdef", 3), "def");
});

test("headSlice and tailSlice return empty for zero or negative budgets (slice(-0) trap)", () => {
  assert.equal(headSlice("abcdef", 0), "");
  assert.equal(tailSlice("abcdef", 0), "");
  assert.equal(headSlice("abcdef", -2), "");
  assert.equal(tailSlice("abcdef", -2), "");
});

test("headSlice and tailSlice never strand half a surrogate pair", () => {
  const s = "😀".repeat(10);
  for (let n = 1; n < s.length; n++) {
    assert.ok(!hasLoneSurrogate(headSlice(s, n)), `headSlice at ${n}`);
    assert.ok(!hasLoneSurrogate(tailSlice(s, n)), `tailSlice at ${n}`);
  }
});

test("jsonbStringify strips NULs and lone surrogates from values and keys and keeps toJSON output", () => {
  const value = { "k\u0000ey": ["a\u0000b", "x\uD800y"], at: new Date(0), nested: { ok: "\uD83D\uDE00" } };
  assert.equal(
    jsonbStringify(value),
    JSON.stringify({ key: ["ab", "x\uFFFDy"], at: "1970-01-01T00:00:00.000Z", nested: { ok: "\uD83D\uDE00" } }),
  );
  assert.equal(jsonbStringify(JSON.parse('{"__proto__":{"polluted":true}}')), '{"__proto__":{"polluted":true}}');
});
