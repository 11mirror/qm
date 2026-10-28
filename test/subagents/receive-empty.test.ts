import assert from "node:assert/strict";
import test from "node:test";
import { receiveMessages } from "../../src/subagents/reading.ts";

test("an empty nonblocking mailbox does not resolve the caller or audience", async () => {
  let lookups = 0;
  const ctx = {
    deps: { mailbox: { pending: async () => [] } },
    binding: { session: { id: "s" }, request: {} },
    currentCaller: async () => {
      lookups += 1;
      throw new Error("must not read caller");
    },
  } as unknown as Parameters<typeof receiveMessages>[0];
  assert.deepEqual(await receiveMessages(ctx), []);
  assert.equal(lookups, 0);
});
