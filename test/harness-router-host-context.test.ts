import assert from "node:assert/strict";
import test from "node:test";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { createHarnessRouter } from "../src/harness/harness-router.ts";
import { createMockHarness } from "./support/mock-harness.ts";

test("the harness router binds the resolved runtime to host context without mutating the captured base", async () => {
  const base = Object.freeze({
    actorId: "alice",
    scopeId: "personal:alice",
    session: Object.freeze({ id: "session-1", threadRef: "dm:alice:1" }),
    surface: "slack",
  });
  let seen: HarnessTurnInput | undefined;
  const adapter = createMockHarness();
  adapter.turns.runTurn = async (turn) => {
    seen = turn;
    return { reply: "ok" };
  };
  const router = createHarnessRouter(new Map([["pi", adapter]]), adapter, async () => ({
    harnessId: "pi",
    modelId: "gpt-6.1-sol",
  }));

  await router.turns.runTurn({
    session: { id: "session-1" },
    mcpHostContextBase: base,
  } as unknown as HarnessTurnInput);

  assert.deepEqual(seen?.mcpHostContext, {
    ...base,
    runtime: { harnessId: "pi", modelId: "gpt-6.1-sol" },
  });
  assert.equal("runtime" in base, false);
  assert.notEqual(seen?.mcpHostContext, base);
});
