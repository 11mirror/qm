import "../../support/auto-fake-sprites.ts";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../support/build-app.ts";
import { testConfig } from "../../support/test-config.ts";
import { serveCore } from "../../support/core-route-server.ts";

const built = buildApp(testConfig());
const core = serveCore(built.app, { runs: built.runs, sessions: built.sessions });

after(async () => {
  await core.close();
  await built.runtime.stop();
});

test("POST /v1/turns strips unattendedGrants from the external body", async () => {
  const r = await core.post("/v1/turns", {
    surface: "cron",
    actor: { externalId: "internal:owner" },
    conversation: {
      kind: "channel",
      channelRef: "C9",
      threadRef: "t-grants-guard",
      audience: [{ externalId: "internal:owner" }],
    },
    text: "x",
    origin: { kind: "automation" },
    unattendedGrants: ["admin.sessions.read"],
    async: true,
  });
  assert.equal(r.status, 202);
  const { runId } = r.json as { runId: string };
  const run = await built.runs.get(runId);
  assert.equal(
    run?.request.unattendedGrants,
    undefined,
    "an external caller cannot smuggle an unattended admin grant into a turn",
  );
});

test("POST /v1/turns strips nested owner-keychain union from typed automation origin", async () => {
  const r = await core.post("/v1/turns", {
    surface: "cron",
    actor: { externalId: "internal:owner" },
    conversation: {
      kind: "channel",
      channelRef: "C9",
      threadRef: "t-typed-union-guard",
      audience: [{ externalId: "internal:owner" }],
    },
    text: "x",
    origin: { kind: "automation", screenData: "external event", useOwnerKeychain: true },
    async: true,
  });
  assert.equal(r.status, 202);
  const { runId } = r.json as { runId: string };
  const run = await built.runs.get(runId);
  assert.deepEqual(run?.request.origin, { kind: "automation", screenData: "external event" });
});

test("POST /v1/turns strips spawned: an external body can't opt out of mid-turn steer folding", async () => {
  const turnBody = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: {
      kind: "channel",
      channelRef: "C-spawn-guard",
      threadRef: "ch:C-spawn-guard:1.0",
      audience: [{ externalId: "U1" }],
    },
    text,
    origin: { kind: "human" },
    async: true,
    ...extra,
  });
  const post = async (body: Record<string, unknown>): Promise<{ runId: string }> => {
    const r = await core.post("/v1/turns", body);
    assert.equal(r.status, 202);
    return r.json as { runId: string };
  };
  const first = await post(turnBody("@bot start"));
  const second = await post(turnBody("make it blue", { spawned: true }));
  assert.equal(second.runId, first.runId, "the spawned-asserting live message still steered the live run");
});

test("POST /v1/turns strips redeliveryKey: an external body cannot borrow Slack's redelivery namespace", async () => {
  const turnBody = (threadRef: string): Record<string, unknown> => ({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "channel", channelRef: "C-rd", threadRef, audience: [{ externalId: "U1" }] },
    text: "hello",
    origin: { kind: "human" },
    async: true,
    redeliveryKey: "slack:B1:C-rd:1.0",
  });
  const post = async (body: Record<string, unknown>): Promise<{ http: number; runId?: string }> => {
    const r = await core.post("/v1/turns", body);
    const json = r.json as { runId?: string };
    return { http: r.status, ...(json.runId ? { runId: json.runId } : {}) };
  };
  const first = await post(turnBody("ch:C-rd:1.0"));
  const second = await post(turnBody("ch:C-rd:2.0"));
  assert.equal(first.http, 202);
  assert.equal(second.http, 202);
  assert.ok(
    first.runId && second.runId && first.runId !== second.runId,
    "the shared key neither collapses nor refuses",
  );
});

test("POST /v1/turns rejects a client idempotencyKey in the reserved slack: namespace", async () => {
  const r = await core.post("/v1/turns", {
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "web:U1:reserved" },
    text: "hi",
    origin: { kind: "human" },
    async: true,
    idempotencyKey: "slack:B1:C1:1.0",
  });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(r.json), /reserved slack: prefix/);
});

test("POST /v1/turns rejects a body without a turn origin", async () => {
  const r = await core.post("/v1/turns", {
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "web:U1:no-origin" },
    text: "hi",
    liveActor: true,
  });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(r.json), /origin\.kind must be/);
});
