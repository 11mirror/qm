import { withResolvedRuntime, resolveRuntimeChoiceDurable } from "../../src/harness/runtime-choice.ts";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockHarness } from "../support/mock-harness.ts";
import { estimateHistoryTokens } from "../../src/harness/context-compaction.ts";
import type { Harness } from "../../src/harness/harness.ts";
import { actor, conv, PERSONAL, buildOrchestrator, seed, turn } from "../support/context-compaction.ts";

test("runtime handoff continues once with saved results under the original run and remaining deadline", async () => {
  const base = createMockHarness();
  const seen: import("../../src/harness/harness.ts").HarnessTurnInput[] = [];
  const choice = { modelId: "gpt-6-astra", effortLevel: "high", fastMode: false };
  const runId = randomUUID();
  const harness: Harness = {
    ...base,
    turns: {
      ...base.turns,
      runTurn: async (input) => {
        seen.push(input);
        if (seen.length === 1) {
          await input.emit({ kind: "UserMessage", text: input.input });
          await input.emit({
            kind: "ToolResult",
            tool: "runtime",
            callId: `runtime-${input.runId}`,
            turnId: input.runId,
            body: { actorId: actor.id, runtimeHandoff: { choice, lifetime: "task" } },
          });
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { reply: "must not be delivered", runtimeHandoff: { choice, lifetime: "task" }, modelCalls: 1 };
        }
        assert.deepEqual(input.runtime, choice);
        assert.equal(input.runId, runId);
        assert.ok(input.history.some((e) => e.kind === "ToolResult"));
        assert.ok(input.turnWallClockMs! < seen[0]!.turnWallClockMs!);
        await input.emit({ kind: "AgentMessage", text: "continued" });
        return { reply: "continued", modelCalls: 1 };
      },
    },
  };
  const { orch, sessions } = buildOrchestrator(harness, undefined, 60000);
  await orch.handleTurn({ ...turn("switch then finish"), runId, surfaceTools: false });
  assert.equal(seen.length, 2);
  const session = await sessions.getByThread(conv.threadRef);
  const entries = await sessions.getItems(session!.id);
  assert.deepEqual(
    entries.filter((e) => e.kind === "AgentMessage").map((e) => e.text),
    ["continued"],
  );
});

test("runtime handoff cannot restart a stopped task", async () => {
  const base = createMockHarness();
  let calls = 0;
  const harness: Harness = {
    ...base,
    turns: {
      ...base.turns,
      runTurn: async () => {
        calls++;
        return {
          reply: "",
          stopped: true,
          runtimeHandoff: { choice: { modelId: "gpt-6-astra" }, lifetime: "task" },
        };
      },
    },
  };
  const { orch } = buildOrchestrator(harness);
  await orch.handleTurn({ ...turn("switch"), surfaceTools: false });
  assert.equal(calls, 1);
});

test("a retry restores a committed runtime decision after a crash, without replaying the selection", async () => {
  const base = createMockHarness();
  const choice = { modelId: "gpt-6-astra" };
  let calls = 0;
  const harness: Harness = {
    ...base,
    turns: {
      ...base.turns,
      runTurn: async (input) => {
        calls++;
        if (calls === 1) {
          await input.emit({ kind: "UserMessage", text: input.input });
          await input.emit({
            kind: "ToolResult",
            tool: "runtime",
            callId: `runtime-${input.runId}`,
            turnId: input.runId,
            body: { actorId: actor.id, runtimeHandoff: { choice, lifetime: "task" } },
          });
          return { reply: "", runtimeHandoff: { choice, lifetime: "task" } };
        }
        assert.deepEqual(input.runtime, choice);
        if (calls === 2) throw new Error("worker died after the handoff");
        return { reply: "resumed" };
      },
    },
  };
  const { orch } = buildOrchestrator(harness);
  const input = { ...turn("switch and finish"), runId: "5f0c3a52-8e1b-4d7a-9c36-2b8e4f1d7a90", surfaceTools: false };
  await assert.rejects(() => orch.handleTurn(input), /worker died/);
  await orch.handleTurn({ ...input, attempt: 2 });
  assert.equal(calls, 3);
});

test("only a cron automation receives task-runtime authority and each fire starts fresh", async () => {
  const base = createMockHarness();
  const active = { modelId: "claude-sonnet-5", effortLevel: "high", fastMode: false };
  const outcomes: { surface: string; ok: boolean }[] = [];
  let resumed = 0;
  const harness: Harness = {
    ...base,
    turns: {
      ...base.turns,
      runTurn: async (input) => {
        if (input.runtime?.modelId === "gpt-6-astra") {
          resumed++;
          return { reply: "handled" };
        }
        const result = await input.runtimeControl!(active, { action: "set", model: "Astra" });
        outcomes.push({ surface: input.input, ok: result.ok });
        if (result.ok && result.handoff) {
          await input.emit({
            kind: "ToolResult",
            tool: "runtime",
            callId: `runtime-${input.runId}`,
            turnId: input.runId,
            body: { actorId: actor.id, runtimeHandoff: result.handoff },
          });
          return { reply: "", runtimeHandoff: result.handoff };
        }
        return { reply: "denied" };
      },
    },
  };
  const { orch } = buildOrchestrator(harness);
  for (const surface of ["cron", "webhook"]) {
    await orch.handleTurn({
      ...turn(surface),
      surface,
      origin: { kind: "automation" },
      runId: randomUUID(),
      surfaceTools: false,
    });
  }
  await orch.handleTurn({
    ...turn("ambient"),
    surface: "cron",
    origin: { kind: "ambient" },
    runId: randomUUID(),
    surfaceTools: false,
  });
  await orch.handleTurn({
    ...turn("next fire"),
    surface: "cron",
    origin: { kind: "automation" },
    runId: randomUUID(),
    surfaceTools: false,
  });
  assert.deepEqual(
    outcomes.map((x) => x.ok),
    [true, false, true],
  );
  assert.equal(resumed, 2);
});

test("cron dispatch uses purpose defaults while task handoffs and later fires stay isolated", async () => {
  const base = createMockHarness();
  const category = { modelId: "gpt-6-astra", effortLevel: "low", fastMode: true };
  const handoff = { ...category, modelId: "gpt-6-sol", fastMode: false };
  const seen: import("../../src/harness/harness.ts").RuntimeChoice[] = [];
  const adapter: Harness = {
    ...base,
    turns: {
      ...base.turns,
      runTurn: async (input) => {
        seen.push(input.runtime as typeof category);
        const state = await input.runtimeControl!(input.runtime as typeof category, { action: "get" });
        assert.ok(state.ok);
        assert.deepEqual(state.effective, category);
        if (seen.length === 1) return { reply: "", runtimeHandoff: { choice: handoff, lifetime: "task" } };
        return { reply: "done" };
      },
    },
  };
  const router = withResolvedRuntime(adapter, (input) =>
    resolveRuntimeChoiceDurable(
      built.config,
      "org:default-org",
      input.scopeLabel,
      category,
      input.runtime,
      undefined,
      input.runtimePurpose,
    ),
  );
  const built = buildOrchestrator(router);
  await built.config.setRuntimeSelection(PERSONAL, {
    modelId: "claude-sonnet-5",
    effortLevel: "high",
  });
  await built.config.setPurposeRuntime("cron", category);
  for (const runId of [randomUUID(), randomUUID()]) {
    const result = await built.orch.handleTurn({
      ...turn("cron"),
      surface: "cron",
      origin: { kind: "automation" },
      runId,
      surfaceTools: false,
    });
    assert.equal(result.status, "ok");
  }
  assert.deepEqual(seen, [category, handoff, category]);
});

test("human child continuations respect non-fast category defaults", async () => {
  const base = createMockHarness();
  const category = { modelId: "gpt-6-astra", effortLevel: "low", fastMode: false };
  const seen: unknown[] = [];
  const adapter: Harness = {
    ...base,
    turns: {
      ...base.turns,
      runTurn: async (input) => {
        seen.push(input.runtime);
        return { reply: "done" };
      },
    },
  };
  const router = withResolvedRuntime(adapter, (input) =>
    resolveRuntimeChoiceDurable(
      built.config,
      "org:default-org",
      input.scopeLabel,
      category,
      input.runtime,
      undefined,
      input.runtimePurpose,
    ),
  );
  const built = buildOrchestrator(router);
  await built.config.setSetting("interactiveFastMode", true);
  await built.config.setPurposeRuntime("subagent", category);
  const parent = await built.sessions.getOrCreateByThread("parent", "dm", PERSONAL);
  const child = await built.sessions.getOrCreateByThread("subagent:review", "dm", PERSONAL);
  await built.sessions.setParentSession(child.id, parent.id);
  await built.orch.handleTurn({
    surface: "web",
    actor,
    conversation: { ...conv, threadRef: child.threadRef },
    origin: { kind: "human" },
    text: "continue",
    surfaceTools: false,
  });
  assert.deepEqual(seen, [category]);
});

for (const explicit of [false, true]) {
  test(`${explicit ? "explicit" : "automatic"} recent recovery continues the request once and stays reduced next turn`, async () => {
    const base = createMockHarness();
    const seen: Parameters<Harness["turns"]["runTurn"]>[0][] = [];
    let summaries = 0;
    let effects = 0;
    const harness: Harness = {
      ...base,
      models: {
        ...base.models,
        compactHistory: async () => {
          summaries++;
          throw new Error("summary refused");
        },
      },
      turns: {
        ...base.turns,
        runTurn: async (input) => {
          seen.push(input);
          if (explicit && seen.length === 1) {
            await input.emit({ kind: "UserMessage", text: input.input });
            await input.emit({ kind: "ToolCall", tool: "files", callId: "effect", body: { action: "write" } });
            effects++;
            await input.emit({ kind: "ToolResult", tool: "files", callId: "effect", text: "stored" });
            await input.emit({
              kind: "ToolCall",
              tool: "context",
              callId: "reduce",
              body: { action: "compact", mode: "recent" },
            });
            await input.emit({ kind: "ToolResult", tool: "context", callId: "reduce", text: "requested" });
            return { reply: "not final", runtimeHandoff: { context: "recent" } };
          }
          if (seen.length === (explicit ? 2 : 1)) {
            assert.ok(estimateHistoryTokens(input.history) <= 600);
            assert.ok(input.history.some((e) => e.body.mode === "recent"));
            assert.ok(
              input.input.includes("finish the request") || input.history.some((e) => e.text === "finish the request"),
            );
            assert.ok(!JSON.stringify(input.history).includes("old excluded sentinel"));
            if (explicit) assert.ok(input.history.some((e) => e.callId === "effect"));
          }
          await input.emit({ kind: "AgentMessage", text: "finished" });
          return { reply: "finished" };
        },
      },
    };
    const { orch, sessions } = buildOrchestrator(harness, 1000);
    const sid = await seed(
      sessions,
      explicit ? [] : Array.from({ length: 10 }, () => ({ text: "old excluded sentinel ".repeat(300) })),
    );
    const before = await sessions.getItems(sid);
    const result = await orch.handleTurn({ ...turn("finish the request"), surfaceTools: false });
    assert.equal(result.status, "ok");
    assert.equal(result.reply, "finished");
    assert.equal(seen.length, explicit ? 2 : 1);
    assert.equal(summaries, explicit ? 0 : 1);
    assert.equal(effects, explicit ? 1 : 0);
    assert.deepEqual((await sessions.getItems(sid)).slice(0, before.length), before);
    assert.equal((await orch.handleTurn({ ...turn("what happened?"), surfaceTools: false })).status, "ok");
    assert.ok(!JSON.stringify(seen.at(-1)!.history).includes("old excluded sentinel"));
  });
}

test("retry recovery supplies an excluded request without rerunning its completed action", async () => {
  const base = createMockHarness();
  let mainCalls = 0;
  const harness: Harness = {
    ...base,
    models: {
      ...base.models,
      compactHistory: async () => {
        throw new Error("summary refused");
      },
    },
    turns: {
      ...base.turns,
      runTurn: async (input) => {
        mainCalls++;
        assert.equal(input.input, "finish the stored request");
        assert.equal(input.continueTurn, undefined);
        assert.ok(!input.history.some((e) => e.kind === "UserMessage"));
        await input.emit({ kind: "AgentMessage", text: "resumed" });
        return { reply: "resumed" };
      },
    },
  };
  const { orch, sessions } = buildOrchestrator(harness, 500);
  await seed(sessions, [
    { text: "finish the stored request" },
    { kind: "ToolCall", tool: "files", callId: "done", body: { action: "write" } },
    { kind: "ToolResult", tool: "files", callId: "done", text: "stored ".repeat(1000) },
  ]);
  const result = await orch.handleTurn({ ...turn("finish the stored request"), attempt: 2, surfaceTools: false });
  assert.equal(result.status, "ok");
  assert.equal(result.reply, "resumed");
  assert.equal(mainCalls, 1);
});
