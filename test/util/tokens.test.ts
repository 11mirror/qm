import { test } from "node:test";
import assert from "node:assert/strict";
import { countTokens, headWithinTokens } from "../../src/util/tokens.ts";

const prose = (chars: number): string => {
  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
  let text = "";
  for (let i = 0; text.length < chars; i++) text += `${words[(i * 7) % words.length]} `;
  return text.slice(0, chars);
};

test("countTokens counts the whole text rather than extrapolating from a prefix", () => {
  const head = prose(72_000);
  const tail = "\u4e00\u4e8c\u4e09".repeat(10_000);
  assert.equal(countTokens(head + tail), countTokens(head) + countTokens(tail));
});

test("headWithinTokens returns the longest head that fits and its exact count", () => {
  const text = prose(20_000);
  for (const max of [0, 1, 1_000, 2_500]) {
    const { head, tokens } = headWithinTokens(text, max);
    assert.ok(text.startsWith(head));
    assert.equal(tokens, countTokens(head));
    assert.ok(tokens <= max);
    assert.ok(countTokens(text.slice(0, head.length + 1)) > max);
  }
  assert.deepEqual(headWithinTokens(text, countTokens(text)), { head: text, tokens: countTokens(text) });
});
