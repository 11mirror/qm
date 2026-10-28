import test from "node:test";
import assert from "node:assert/strict";
import { applyPromptVars } from "../../src/resolution/prompt-vars.ts";

test("applyPromptVars substitutes values and keeps or drops conditional blocks", () => {
  assert.equal(
    applyPromptVars("Hi {{name}}{{#if email}} ({{email}}){{/if}}.", { name: "Ada", email: "ada@example.com" }),
    "Hi Ada (ada@example.com).",
  );
  assert.equal(applyPromptVars("Hi {{name}}{{#if email}} ({{email}}){{/if}}.", { name: "Ada" }), "Hi Ada.");
});

test("applyPromptVars nests conditional blocks", () => {
  const md = "{{#if a}}A{{#if b}}B{{/if}}a{{/if}}!";
  assert.equal(applyPromptVars(md, { a: true, b: true }), "ABa!");
  assert.equal(applyPromptVars(md, { a: true, b: false }), "Aa!");
  assert.equal(applyPromptVars(md, { a: false, b: true }), "!");
});

test("applyPromptVars inserts values literally without rereading template syntax in them", () => {
  assert.equal(applyPromptVars("Org: {{org}}", { org: "{{#if x}}{{y}}{{/if}}" }), "Org: {{#if x}}{{y}}{{/if}}");
});

test("applyPromptVars rejects unknown variables, stray braces and unbalanced blocks", () => {
  assert.throws(() => applyPromptVars("{{missing}}", {}), /unresolved template token near "\{\{missing\}\}"/);
  assert.throws(() => applyPromptVars("a {{ b", {}), /unresolved template token/);
  assert.throws(
    () => applyPromptVars("{{#if a}}open", { a: true }),
    /unresolved template token near "\{\{#if a\}\}open"/,
  );
  assert.throws(() => applyPromptVars("close{{/if}}", {}), /unresolved template token near "\{\{\/if\}\}"/);
});
