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
