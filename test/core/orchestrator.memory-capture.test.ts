import { test } from "node:test";
import assert from "node:assert/strict";
import { type OrchestratorInput } from "../../src/core/orchestrator.ts";
import { replayableRequest } from "../../src/core/orchestrator/turn-helpers.ts";
import type { MemoryService } from "../../src/memory/memory-service.ts";
import { createMockHarness } from "../support/mock-harness.ts";
import type { Harness } from "../../src/harness/harness.ts";
import type { Conversation, Principal } from "../../src/types.ts";
import { buildBareOrchestrator } from "../support/bare-orchestrator.ts";

const actor: Principal = { id: "U1", type: "internal" };
const dm = (thread: string, text: string): OrchestratorInput => ({
  surface: "test",
  actor,
  conversation: { kind: "dm", threadRef: thread, audience: [actor] } as Conversation,
  origin: { kind: "direct" },
  text,
});

function gatedHarness() {
  const base = createMockHarness();
  let started = 0;
  let finished = 0;
  const gates: Array<() => void> = [];
  const harness: Harness = {
    ...base,
    models: {
      ...base.models,
      async oneShot(system: string, prompt: string): Promise<string | undefined> {
        started++;
        await new Promise<void>((res) => gates.push(res));
        const output = await base.models.oneShot!(system, prompt);
        finished++;
        return output;
      },
    },
  };
  return {
    harness,
    release: () => gates.shift()?.(),
    get started() {
      return started;
    },
    get finished() {
      return finished;
    },
  };
}

test("skipMemory turns neither recall nor capture", async () => {
  let recalls = 0;
  let captures = 0;
  const memory: MemoryService = {
    recall: async () => (recalls++, [{ text: "remembered deployment state", score: 0.2 }]),
    capture: async () => 0,
    query: async () => [],
    read: async () => "",
  };
  const orch = buildBareOrchestrator({
    memory,
    memoryStrategy: {
      onTurnEnd: async () => {
        captures++;
      },
    },
  });

  const result = await orch.handleTurn({ ...dm("dm:U1:canary", "deployment canary"), skipMemory: true });

  assert.equal(result.status, "ok");
  assert.equal(recalls, 0);
  assert.equal(captures, 0);
});

test("approval replay preserves the memory opt-out", () => {
  assert.equal(replayableRequest({ ...dm("dm:U1:approval", "deployment canary"), skipMemory: true }).skipMemory, true);
});

test("capture does NOT block the turn: the reply returns while extraction is still in flight", async () => {
  const g = gatedHarness();
  const orch = buildBareOrchestrator({ harness: g.harness });

  const res = await orch.handleTurn(dm("dm:U1:tA", "remember my secret is ZULU77"));

  assert.equal(res.status, "ok");
  for (let i = 0; i < 200 && g.started === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(g.started, 1, "capture extraction was kicked off");
  assert.equal(g.finished, 0, "...but the turn returned WITHOUT awaiting it (still gated) — async");
  g.release();
});

test("recall does NOT block on an in-flight capture; continuity is eventually-consistent", async () => {
  const g = gatedHarness();
  const orch = buildBareOrchestrator({ harness: g.harness });

  await orch.handleTurn(dm("dm:U1:tA", "remember my secret is ZULU77"));
  assert.equal(g.finished, 0, "capture is still in flight after the first turn returns");

  const recall = orch.handleTurn(dm("dm:U1:tB", "!sysprompt"));
  const completedBeforeCapture = await Promise.race([
    recall.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  if (!completedBeforeCapture) g.release();
  assert.equal(
    completedBeforeCapture,
    true,
    "recall is NOT blocked on the in-flight capture (never block on extraction)",
  );
  assert.equal((await recall).status, "ok");

  g.release();
  let reply = "";
  for (let i = 0; i < 200 && !/ZULU77/.test(reply); i++) {
    await new Promise((r) => setTimeout(r, 10));
    reply = (await orch.handleTurn(dm(`dm:U1:tC${i}`, "!sysprompt"))).reply ?? "";
  }
  assert.match(reply, /ZULU77/, "the recalled fact appears once the detached capture has settled");
});
