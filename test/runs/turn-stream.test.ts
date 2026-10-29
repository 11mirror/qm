import "../support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";

import { createTurnStream, goalView, runGoal } from "../../src/runs/turn-stream.ts";
import type { RunDeliveryState } from "../../src/runs/run-store.ts";
import { buildApp } from "../support/build-app.ts";
import { testConfig } from "../support/test-config.ts";
import { settledRun } from "../support/turns.ts";

function recording() {
  const writes: Array<[string, RunDeliveryState]> = [];
  const stream = createTurnStream({
    runs: {
      async setDeliveryState(runId, _lease, state) {
        writes.push([runId, state]);
        return true;
      },
    },
  });
  return { stream, writes };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("accumulates deltas per run and isolates runs", () => {
  const { stream: s } = recording();
  assert.equal(s.snapshot("r1"), null, "unknown run has no partial");
  s.publish("r1", "Hel");
  s.publish("r1", "lo");
  s.publish("r2", "world");
  assert.equal(s.snapshot("r1"), "Hello");
  assert.equal(s.snapshot("r2"), "world");
});

test("ignores empty deltas", () => {
  const { stream: s } = recording();
  s.publish("r1", "");
  assert.equal(s.snapshot("r1"), null);
  s.publish("r1", "x");
  s.publish("r1", "");
  assert.equal(s.snapshot("r1"), "x");
});

test("publishBlockStart() joins text blocks with a paragraph break, never leads or doubles", () => {
  const { stream: s } = recording();
  s.publishBlockStart("r1");
  assert.equal(s.snapshot("r1"), null, "a boundary before any text is a no-op");
  s.publish("r1", "First block.");
  s.publishBlockStart("r1");
  s.publishBlockStart("r1");
  s.publish("r1", "Second block.");
  assert.equal(s.snapshot("r1"), "First block.\n\nSecond block.", "blocks join with one break");
  s.publish("r1", "\n\n");
  s.publishBlockStart("r1");
  s.publish("r1", "Third.");
  assert.equal(s.snapshot("r1"), "First block.\n\nSecond block.\n\nThird.", "no double break after trailing one");
});

test("begin() is idempotent, text-free and never clobbers buffered text", () => {
  const { stream: s } = recording();
  s.begin("r1");
  assert.equal(s.snapshot("r1"), null, "no partial yet — begin() is text-free");
  s.publish("r1", "Hello");
  s.begin("r1");
  assert.equal(s.snapshot("r1"), "Hello");
});

test("caps a run's buffer, keeping the newest half", () => {
  const { stream: s } = recording();
  s.publish("r1", "a".repeat(150_000));
  s.publish("r1", "b".repeat(60_000));
  assert.equal(
    s.snapshot("r1"),
    "a".repeat(40_000) + "b".repeat(60_000),
    "buffer retains the newest text past the cap",
  );
  assert.equal(s.startOffset("r1"), 110_000);
});

test("end() evicts a finished run's buffer after the grace period", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { stream: s } = recording();
  s.publish("r1", "done reply");
  s.end("r1");
  assert.equal(s.snapshot("r1"), "done reply", "buffer survives during grace so a final poll catches up");
  t.mock.timers.tick(30_000);
  assert.equal(s.snapshot("r1"), null, "buffer evicted after grace");
});

test("a late delta after end() cancels eviction and keeps streaming", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { stream: s } = recording();
  s.publish("r1", "a");
  s.end("r1");
  s.publish("r1", "b");
  t.mock.timers.tick(30_000);
  assert.equal(s.snapshot("r1"), "ab", "eviction was cancelled by the late delta");
});

test("reply, runtime, surface and closed first block are written to the run's delivery state", async () => {
  const { stream: s, writes } = recording();
  s.publish("r1", "On it.");
  s.noteToolCall("r1");
  s.markSurfacePosted("r1");
  s.markSurfacePosted("r1");
  const runtime = { modelId: "m", harness: "pi" } as never;
  s.noteRuntime("r1", runtime);
  s.markReplyDone("r1");
  await flush();
  assert.deepEqual(writes, [
    ["r1", { firstBlock: "On it." }],
    ["r1", { surfacePosted: true }],
    ["r1", { runtime }],
    ["r1", { replyDone: true }],
  ]);
});

test("getRun reads reply, runtime, surface and first block from the run row, not this process's stream", async () => {
  const built = buildApp(testConfig({ workers: 0 }));
  const ack = await built.app.turn({
    origin: { kind: "direct" },
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "t-durable" },
    text: "hello",
    async: true,
  });
  const runtime = { modelId: "m" } as never;
  await built.runs.setDeliveryState(ack.runId!, null, {
    replying: true,
    runtime,
    firstBlock: "On it.",
    surfacePosted: true,
    replyDone: true,
  });
  const run = await built.app.getRun(ack.runId!);
  assert.equal(run?.replying, true);
  assert.equal(run?.replyComplete, true);
  assert.deepEqual(run?.runtime, runtime);
  assert.equal(run?.firstBlock, "On it.");
  assert.equal(run?.firstBlockClosed, true);
  assert.equal(run?.surfacePosted, true);
});

test("a queued run surfaces replyComplete via getRun once the reply is final", async () => {
  const built = buildApp(testConfig({ workers: 1, reaperIntervalMs: 60_000 }));
  built.runtime.start();
  try {
    const ack = await built.app.turn({
      origin: { kind: "direct" },
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t1" },
      text: "hello",
      async: true,
    });
    const finished = await settledRun(built.runs, ack.runId!, 5_000);
    assert.equal(finished.status, "done");
    const run = await built.app.getRun(ack.runId!);
    assert.equal(run?.replyComplete, true, "a completed reply is flagged replyComplete");
    assert.notEqual(run?.alive, true, "a finished turn is not reported alive");
  } finally {
    await built.runtime.stop();
  }
});

test("a queued tool-using run surfaces its activity + timings via getRun()", async () => {
  const built = buildApp(testConfig({ workers: 1, reaperIntervalMs: 60_000 }));
  const computer = await built.sandboxResources.create("U1", "personal:U1", "sprites", "default");
  await built.sandboxResources.setDefault("U1", "personal:U1", computer.id);
  built.runtime.start();
  try {
    const ack = await built.app.turn({
      origin: { kind: "direct" },
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t1" },
      text: "!run echo hi",
      async: true,
    });
    assert.equal(ack.status, "queued");
    const finished = await settledRun(built.runs, ack.runId!, 5_000);
    assert.equal(finished.status, "done");

    const run = await built.app.getRun(ack.runId!);
    const kinds = (run?.activity ?? []).map((a) => ("item" in a ? a.item.kind : a.marker));
    assert.ok(kinds.includes("ToolCall"), "the execute tool call was mirrored to the run's activity");
    assert.ok(kinds.includes("ToolResult"), "the execute tool result was mirrored too");
    assert.equal(typeof run?.startedAt, "number", "getRun surfaces when the run started");
    assert.equal(typeof run?.finishedAt, "number", "getRun surfaces when the run finished");
  } finally {
    await built.runtime.stop();
  }
});

test("a queued run exposes the agent's in-flight reply via getRun().partial", async () => {
  const built = buildApp(testConfig({ workers: 1, reaperIntervalMs: 60_000 }));
  built.runtime.start();
  try {
    const ack = await built.app.turn({
      origin: { kind: "direct" },
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t1" },
      text: "hello",
      async: true,
    });
    assert.equal(ack.status, "queued");
    assert.ok(ack.runId);

    const finished = await settledRun(built.runs, ack.runId!, 5_000);
    assert.equal(finished.status, "done");

    const run = await built.app.getRun(ack.runId!);
    assert.ok(run?.partial, "the agent's reply was streamed to the run");
    assert.equal(run!.partial, finished.result?.reply, "streamed partial matches the final reply");
  } finally {
    await built.runtime.stop();
  }
});

test("first block: captured until noteToolCall closes it; later text never leaks in", () => {
  const { stream: s } = recording();
  assert.equal(s.firstBlock("r1"), null, "unknown run has no first block");
  s.publish("r1", "On it — ");
  s.publish("r1", "checking the logs.");
  assert.deepEqual(s.firstBlock("r1"), { text: "On it — checking the logs.", closed: false }, "open until a tool call");
  s.noteToolCall("r1");
  assert.deepEqual(
    s.firstBlock("r1"),
    { text: "On it — checking the logs.", closed: true },
    "the first tool call closes it",
  );
  s.publishBlockStart("r1");
  s.publish("r1", "Found it: deploy #4819.");
  assert.deepEqual(
    s.firstBlock("r1"),
    { text: "On it — checking the logs.", closed: true },
    "post-tool text stays out",
  );
});

test("first block: a second text block before any tool call disqualifies the harvest", () => {
  const { stream: s } = recording();
  s.publish("r1", "First thought.");
  s.publishBlockStart("r1");
  s.publish("r1", "Second thought.");
  s.noteToolCall("r1");
  assert.deepEqual(
    s.firstBlock("r1"),
    { text: "First thought.", closed: false },
    "never closed — not a preamble to work",
  );
});

test("first block: a turn that goes straight to tools has none", () => {
  const { stream: s } = recording();
  s.noteToolCall("r1");
  s.publishBlockStart("r1");
  s.publish("r1", "The answer.");
  assert.equal(s.firstBlock("r1"), null, "no text before the tool call → nothing to harvest");
});

test("a DM turn's opening text block rides getRun as firstBlock/firstBlockClosed", async () => {
  const built = buildApp(testConfig({ workers: 1, reaperIntervalMs: 60_000 }));
  built.runtime.start();
  try {
    const ack = await built.app.turn({
      origin: { kind: "direct" },
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t-fb" },
      text: "!preamble On it — checking.",
      async: true,
    });
    const finished = await settledRun(built.runs, ack.runId!, 5_000);
    assert.equal(finished.status, "done");
    const run = await built.app.getRun(ack.runId!);
    assert.equal(run?.firstBlock, "On it — checking.", "the opening block is exposed for the surface to harvest");
    assert.equal(run?.firstBlockClosed, true, "the tool call closed it");
    assert.ok(run?.partial?.includes("All clear — nothing broke."), "the final reply still streams as partial");
  } finally {
    await built.runtime.stop();
  }
});

test("a harvested first block is stripped from the final reply (never shown twice)", async () => {
  const built = buildApp(testConfig({ workers: 1, reaperIntervalMs: 60_000 }));
  built.runtime.start();
  try {
    const ack = await built.app.turn({
      origin: { kind: "direct" },
      surface: "slack",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t-strip" },
      text: "!preamble On it — checking.",
      async: true,
    });
    const finished = await settledRun(built.runs, ack.runId!, 5_000);
    assert.equal(finished.status, "done");
    assert.equal(finished.deliveryState?.replying, true, "Slack engagement survives outside the worker stream");
    assert.equal(finished.result?.reply, "All clear — nothing broke.", "the acked preamble is stripped from the reply");
  } finally {
    await built.runtime.stop();
  }
});

test("a long first block is harvested too (no length gate) and stripped from the reply", async () => {
  const built = buildApp(testConfig({ workers: 1, reaperIntervalMs: 60_000 }));
  built.runtime.start();
  try {
    const long = "x".repeat(400);
    const ack = await built.app.turn({
      origin: { kind: "direct" },
      surface: "slack",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t-held" },
      text: `!preamble ${long}`,
      async: true,
    });
    const finished = await settledRun(built.runs, ack.runId!, 5_000);
    assert.equal(finished.status, "done");
    assert.equal(
      finished.result?.reply,
      "All clear — nothing broke.",
      "the long acked preamble is stripped like any other",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("a non-slack surface never strips the first block from the reply", async () => {
  const built = buildApp(testConfig({ workers: 1, reaperIntervalMs: 60_000 }));
  built.runtime.start();
  try {
    const ack = await built.app.turn({
      origin: { kind: "direct" },
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t-web" },
      text: "!preamble On it — checking.",
      async: true,
    });
    const finished = await settledRun(built.runs, ack.runId!, 5_000);
    assert.equal(finished.status, "done");
    assert.ok(
      finished.result?.reply?.startsWith("On it — checking."),
      "no ack was posted on this surface, so nothing is stripped",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("runGoal shows a goal changed during the run or still open, never one from after it", () => {
  const goal = { objective: "ship it", status: "active" as const, tokensUsed: 0, createdAt: 5, updatedAt: 5 };
  const run = { startedAt: 10, finishedAt: 20 };
  assert.equal(runGoal(undefined, run), null);
  assert.equal(runGoal(goal, { startedAt: null, finishedAt: null }), null, "an unstarted run has no goal");
  assert.equal(runGoal(goal, run)?.objective, "ship it", "an open goal carried into the run");
  assert.equal(runGoal({ ...goal, status: "complete", updatedAt: 15 }, run)?.status, "complete");
  assert.equal(runGoal({ ...goal, status: "complete", updatedAt: 8 }, run), null, "closed before the run");
  assert.equal(runGoal({ ...goal, status: "complete", updatedAt: 25 }, run), null, "closed after the run");
  assert.equal(runGoal({ ...goal, createdAt: 25, updatedAt: 25 }, run), null, "opened after the run");
  assert.ok(runGoal({ ...goal, createdAt: 25, updatedAt: 25 }, { startedAt: 10, finishedAt: null }));
});

test("goalView renders a goal record's status and floor", () => {
  const record = {
    objective: "work for a while",
    status: "active" as const,
    floor: { minMs: 1_800_000, minTurns: 3 },
    tokensUsed: 0,
    createdAt: 10,
    updatedAt: 20,
  };
  assert.deepEqual(goalView(record), {
    objective: "work for a while",
    status: "active",
    floor: "30m, 3 turns",
    createdAt: 10,
    updatedAt: 20,
  });
  const { floor: _floor, ...bare } = record;
  assert.deepEqual(goalView({ ...bare, status: "paused" }), {
    objective: "work for a while",
    status: "paused",
    createdAt: 10,
    updatedAt: 20,
  });
});

test("monitor wakes persist engagement after the reply gate", async () => {
  const built = buildApp(testConfig({ workers: 1 }));
  built.runtime.start();
  try {
    const ack = await built.app.turn({
      origin: { kind: "direct" },
      surface: "monitor",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t-monitor" },
      text: "!preamble Checking background results.",
      async: true,
    });
    const finished = await settledRun(built.runs, ack.runId!, 5_000);
    assert.equal(finished.status, "done");
    assert.equal(finished.deliveryState?.replying, true);
  } finally {
    await built.runtime.stop();
  }
});

test("reasoning streams per block beside the reply text, whole, and settles when persisted", () => {
  const published: Array<{ step: string; index: number; text: string; offset: number }> = [];
  const s = createTurnStream({
    runs: { setDeliveryState: async () => true },
    onReasoning: (_runId, block, text, offset) => published.push({ ...block, text, offset }),
  });
  s.publishReasoning("r1", "step-a", 0, "**Plan**");
  s.publishReasoning("r1", "step-a", 0, " the fix");
  s.publishReasoning("r1", "step-a", 2, "second block");
  s.publish("r1", "Answer");
  assert.equal(s.snapshot("r1"), "Answer", "reasoning never enters the reply text");
  assert.deepEqual(s.reasoning("r1"), [
    { step: "step-a", index: 0, text: "**Plan** the fix" },
    { step: "step-a", index: 2, text: "second block" },
  ]);
  assert.deepEqual(
    published.map(({ index, offset }) => [index, offset]),
    [
      [0, 0],
      [0, 8],
      [2, 0],
    ],
  );
  s.settleReasoning("r1", "step-a", 0);
  assert.deepEqual(s.reasoning("r1"), [{ step: "step-a", index: 2, text: "second block" }]);
  s.publishReasoning("r1", "step-b", 0, "x".repeat(25_000));
  s.publishReasoning("r1", "step-b", 0, "more");
  assert.equal(s.reasoning("r1").find((b) => b.step === "step-b")?.text.length, 25_004);
  assert.equal(published.at(-1)?.text, "more", "every delta is published");
  s.end("r1");
  s.begin("r1");
  assert.deepEqual(s.reasoning("r1"), [], "a retried attempt never serves the previous attempt's blocks");
});

test("the first block counts as harvested only once it is saved under the attempt's lease", async () => {
  const leases: Array<string | null> = [];
  let accept = false;
  const s = createTurnStream({
    runs: {
      async setDeliveryState(_runId, lease, _state) {
        leases.push(lease);
        return accept;
      },
    },
  });
  s.begin("r1", "lease-1");
  s.publish("r1", "On it.", "lease-1");
  s.noteToolCall("r1", "lease-1");
  assert.equal(await s.savedFirstBlock("r1"), undefined, "a refused write leaves the block in the reply");
  accept = true;
  s.begin("r1", "lease-2");
  assert.equal(s.firstBlock("r1"), null, "a new attempt starts without the old first block");
  s.publish("r1", "Retrying.", "lease-2");
  s.noteToolCall("r1", "lease-2");
  s.markReplyDone("r1", "lease-2");
  assert.equal(await s.savedFirstBlock("r1"), "Retrying.");
  await flush();
  assert.deepEqual(leases, ["lease-1", "lease-2", "lease-2"]);
});

test("a failed first-block write is not harvested", async () => {
  const s = createTurnStream({
    runs: {
      async setDeliveryState() {
        throw new Error("db down");
      },
    },
  });
  s.begin("r1", "lease-1");
  s.publish("r1", "On it.", "lease-1");
  s.noteToolCall("r1", "lease-1");
  assert.equal(await s.savedFirstBlock("r1"), undefined);
});

test("a superseded attempt neither evicts nor writes for the attempt that reclaimed its run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: Array<[string | null, RunDeliveryState]> = [];
  const s = createTurnStream({
    runs: {
      async setDeliveryState(_runId, lease, state) {
        writes.push([lease, state]);
        return true;
      },
    },
  });
  s.begin("r1", "lease-1");
  s.begin("r1", "lease-2");
  s.publish("r1", "STALE ", "lease-1");
  s.publishBlockStart("r1", "lease-1");
  s.publish("r1", "Retrying.", "lease-2");
  s.end("r1", "lease-1");
  s.markSurfacePosted("r1", "lease-1");
  s.markReplyDone("r1", "lease-1");
  t.mock.timers.tick(30_000);
  assert.equal(s.snapshot("r1"), "Retrying.", "the stale end did not schedule eviction");
  s.noteToolCall("r1", "lease-2");
  s.markSurfacePosted("r1", "lease-2");
  s.end("r1", "lease-2");
  t.mock.timers.tick(30_000);
  s.markReplyDone("r1", "lease-2");
  await flush();
  assert.deepEqual(writes, [
    ["lease-2", { firstBlock: "Retrying." }],
    ["lease-2", { surfacePosted: true }],
  ]);
});

test("a failed surface-post save can be retried without suppressing durable state", async () => {
  let attempts = 0;
  const stream = createTurnStream({
    runs: {
      async setDeliveryState() {
        attempts++;
        if (attempts === 1) throw new Error("connection unavailable");
        return attempts > 2;
      },
    },
  });
  stream.markSurfacePosted("retry");
  await flush();
  stream.markSurfacePosted("retry");
  await flush();
  stream.markSurfacePosted("retry");
  await flush();
  stream.markSurfacePosted("retry");
  assert.equal(attempts, 3);
});
