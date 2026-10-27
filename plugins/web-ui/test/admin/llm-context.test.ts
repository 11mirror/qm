import assert from "node:assert/strict";
import test from "node:test";
import { contextSections, sumCacheUsage, isStablePrefixMiss } from "../../src/admin/llm-context.ts";

test("model context splits a captured request into sections and flags cache misses", () => {
  const sections = contextSections({ system: "rules", messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
  assert.deepEqual(
    sections.map((s) => s.key),
    ["system", "messages", "params"],
  );
  const usage = sumCacheUsage([{ usage: { cacheRead: 0, cacheWrite: 4000, input: 10 } }]);
  assert.equal(isStablePrefixMiss(usage), true);
});
