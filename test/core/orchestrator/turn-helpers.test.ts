import "../../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp } from "../../support/test-app.ts";
import type { TurnRequest } from "../../../src/types.ts";
import { testConfig } from "../../support/test-config.ts";
import { turnPostKeys, replayableRequest } from "../../../src/core/orchestrator/turn-helpers.ts";
import { reservedSurfaceEnqueues } from "../../../src/core/orchestrator/turn-input.ts";
import { storedItem, type NewItem } from "../../../src/sessions/items.ts";
import type { OrchestratorInput } from "../../../src/core/orchestrator/types.ts";
import { settle } from "../../support/settle.ts";

function freshApp() {
  return buildTestApp(testConfig());
}

const actor = { externalId: "U1" };

function channelTurn(text: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return {
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef: "ch:C9:t1", channelRef: "C9", audience: [actor] },
    deliveryTarget: "slack:C9:t1",
    surfaceTools: true,
    addressed: true,
    text,
    origin: { kind: "human" },
    ...extra,
  };
}

test("a new post after a send with a lost result does not reuse the reserved position", async () => {
  const built = freshApp();
  const req = channelTurn("!post-lost-result deploy is done", { idempotencyKey: "dedup-retry-1" });

  const turn = built.app.turn(req);
  await settle(async () => (await built.posts.pending("slack")).length > 0);
  const afterFirst = await built.posts.pending("slack");
  assert.equal(afterFirst.length, 1, "the interrupted attempt already enqueued its post");

  const res = await turn;
  assert.equal(res.status, "silent", res.reason);

  const rows = (await built.posts.pending("slack")).filter((d) => d.idempotencyKey.startsWith("post:"));
  assert.equal(rows.length, 2, "new work cannot reuse the first attempt's delivery position");
  assert.equal(new Set(rows.map((row) => row.idempotencyKey)).size, 2);
  assert.equal(rows[0]!.text, "deploy is done", "the delivered copy is the first attempt's, keyed not text-matched");
  assert.match(
    rows[0]!.idempotencyKey,
    /^post:.+:slack:slack:C9:t1:0$/,
    "the key is the turn's run id, the destination, and the position — nothing per-attempt",
  );
});

test("a resumed turn's NEW post after a completed one is delivered, not swallowed by the dedup", async () => {
  const built = freshApp();
  const req = channelTurn("!post-then-boom first update|second update", { idempotencyKey: "dedup-resume-1" });

  const res = await built.app.turn(req);
  assert.equal(res.status, "silent", res.reason);

  const rows = (await built.posts.pending("slack")).filter((d) => d.idempotencyKey.startsWith("post:"));
  assert.deepEqual(
    rows.map((d) => d.text).sort(),
    ["first update", "second update"],
    "the completed post is recorded work, so the resume's continuation posts at the next position",
  );
  assert.equal(new Set(rows.map((d) => d.idempotencyKey)).size, 2, "each post holds its own key");
});

test("a retried automation fire (surface 'monitor') still seeds past its recorded post — the NEW post delivers", async () => {
  const built = freshApp();
  const req: TurnRequest = {
    surface: "monitor",
    actor,
    conversation: { kind: "channel", threadRef: "monitor:M1:t1", channelRef: "C9", audience: [actor] },
    surfaceTools: true,
    text: "!post-then-boom monitor first|monitor second",
    idempotencyKey: "dedup-monitor-1",
    origin: { kind: "automation", destination: { type: "slack", target: "slack:C9:t1" } },
  };

  const res = await built.app.turn(req);
  assert.equal(res.status, "silent", res.reason);

  const rows = (await built.posts.pending("slack")).filter((d) => d.idempotencyKey.startsWith("post:"));
  assert.deepEqual(
    rows.map((d) => d.text).sort(),
    ["monitor first", "monitor second"],
    "the seed counts entries recorded under the surface tool's real name, not the fire's surface label",
  );
});

test("distinct posts in one turn each get their own key and all deliver", async () => {
  const built = freshApp();
  const res = await built.app.turn(channelTurn("!post2 alpha|beta", { idempotencyKey: "dedup-two-1" }));
  assert.equal(res.status, "silent", res.reason);

  const rows = (await built.posts.pending("slack")).filter((d) => d.idempotencyKey.startsWith("post:"));
  assert.deepEqual(rows.map((d) => d.text).sort(), ["alpha", "beta"]);
  assert.equal(new Set(rows.map((d) => d.idempotencyKey)).size, 2);
});

test("reservedSurfaceEnqueues counts durable surface enqueue reservations, including missing results, after the interrupted user entry", () => {
  const entry = (seq: number, item: NewItem) => storedItem(item, { sessionId: "s", seq, createdAt: seq });
  const entries = [
    entry(0, { kind: "UserMessage", text: "!go" }),
    entry(1, { kind: "ToolCall", tool: "slack", callId: "a", body: { action: "post" } }),
    entry(2, { kind: "ToolResult", tool: "slack", callId: "a", body: { action: "post", ok: true } }),
    entry(3, { kind: "ToolCall", tool: "execute", callId: "b", body: { command: "make" } }),
    entry(4, { kind: "ToolResult", tool: "execute", callId: "b", body: { ok: true } }),
    entry(5, { kind: "ToolCall", tool: "slack", callId: "c", body: { action: "reach" } }),
    entry(6, { kind: "ToolResult", tool: "slack", callId: "c", body: { action: "reach", ok: true } }),
    entry(7, { kind: "ToolCall", tool: "slack", callId: "d", body: { action: "post" } }),
    entry(8, { kind: "ToolResult", tool: "slack", callId: "d", isError: true, body: { interrupted: true } }),
  ];
  assert.equal(
    reservedSurfaceEnqueues(entries, 0, "slack"),
    3,
    "the interrupted post already consumed its delivery position",
  );
  assert.equal(reservedSurfaceEnqueues(entries, 5, "slack"), 1, "entries at or before sinceSeq are excluded");
});

test("turnPostKeys mints deterministic per-destination position keys and seeds past recorded work", () => {
  const keys = turnPostKeys("run-1");
  const dest = { type: "slack", target: "C1:100.1" };
  assert.equal(keys.key(dest, keys.take()), "post:run-1:slack:C1:100.1:0");
  assert.equal(keys.key(dest, keys.take()), "post:run-1:slack:C1:100.1:1");
  const seeded = turnPostKeys("run-1");
  seeded.seed(2);
  assert.equal(seeded.key(dest, seeded.take()), "post:run-1:slack:C1:100.1:2");
});

test("a replayed request keeps every request field and drops run-only state", () => {
  const actor = { id: "U1", type: "internal" as const, displayName: "Ada" };
  const input = {
    surface: "web",
    actor,
    conversation: { kind: "dm", threadRef: "t1", audience: [actor] },
    origin: { kind: "automation" },
    text: "hi",
    clientTools: [{ name: "pick", description: "pick one", parameters: {} }],
    desktopClientId: "desk-1",
    unattendedGrants: ["admin.audit.read"],
    approval: { requestId: "r1", approved: true },
    runId: "run-1",
    runLeaseToken: "lease",
  } as unknown as OrchestratorInput;
  const replayed = replayableRequest(input);
  assert.deepEqual(replayed.clientTools, [{ name: "pick", description: "pick one", parameters: {} }]);
  assert.equal(replayed.desktopClientId, "desk-1");
  assert.deepEqual(replayed.unattendedGrants, ["admin.audit.read"]);
  assert.deepEqual(replayed.origin, { kind: "automation" });
  assert.equal(replayed.approval, undefined);
  assert.equal("runId" in replayed, false);
  assert.equal("runLeaseToken" in replayed, false);
  assert.equal(replayed.actor.externalId, "U1");
});
