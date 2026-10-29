import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSafeRegex } from "../../src/util/safe-regex.ts";

test("compileSafeRegex rejects repetition nested at any group depth", () => {
  for (const pattern of [
    "(a+)+",
    "((a+))+",
    "(?:(a+)b)+",
    "((a|b))*",
    "(((a*)))+",
    "(a|a)?",
    "(a+)?",
    "((a|a))?((a|a))?b",
    "((a+))?((a+))?b",
  ]) {
    assert.throws(() => compileSafeRegex(pattern), /nested or ambiguous repetition/, pattern);
  }
});

test("compileSafeRegex accepts single-level repetition, optional groups and literal parentheses", () => {
  for (const pattern of [
    "(ab)+",
    "((ab))+",
    "a+b+",
    "(a)(b+)c*",
    "[(]+",
    "\\(a+\\)+",
    "^(sudo (apt|yum))? install",
    "(a(b+))?c",
  ]) {
    assert.ok(compileSafeRegex(pattern) instanceof RegExp, pattern);
  }
});

test("overlapping adjacent repetitions are rejected before a quadratic timing input is evaluated", () => {
  const input = `${"a".repeat(100_000)}!`;
  const started = performance.now();
  for (const pattern of ["^a+a+$", "^[a-z]+[a-z]+$", "^a+\\w+$", "^(a)+(a)+$", "^a+aa+$", "^a+a?a+$"]) {
    assert.throws(() => compileSafeRegex(pattern).test(input), /ambiguous repetition/, pattern);
  }
  assert.ok(performance.now() - started < 1000);
});

test("case-insensitive overlapping repetitions cannot bypass the checker", () => {
  assert.throws(() => compileSafeRegex("^a+A+$", "i"), /ambiguous repetition/);
  assert.throws(() => compileSafeRegex("^\\x61+a+$"), /escaped character codes/);
});
