import assert from "node:assert/strict";
import { test } from "node:test";
import { getContextPolicy, setContextPolicy } from "../src/api/routes/context-policy.ts";
import { type ApiCtx, respond } from "../src/api/routes/route.ts";
import { createPostgresChannelPolicyStore } from "../src/surface-cache/channel-policy-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

function fakeRes() {
  const out = { status: 0, body: undefined as unknown };
  return {
    res: {
      getHeader() {},
      writeHead(status: number) {
        out.status = status;
        return this;
      },
      end(data?: string) {
        out.body = data ? JSON.parse(data) : undefined;
      },
    } as unknown as ApiCtx["res"],
    out,
  };
}

type Instructions = Map<string, { text: string; version: number }>;

function makeCtx(over: {
  url?: string;
  body?: unknown;
  contexts?: string[];
  store?: ReturnType<typeof createPostgresChannelPolicyStore>;
  instructions?: Instructions;
}): {
  ctx: ApiCtx;
  out: { status: number; body: unknown };
  store: ReturnType<typeof createPostgresChannelPolicyStore>;
  instructions: Instructions;
} {
  const instructions: Instructions = over.instructions ?? new Map();
  const { res, out } = fakeRes();
  const store = over.store ?? createPostgresChannelPolicyStore(testDatabaseUrl());
  const audits: unknown[] = [];
  const ctx = {
    res,
    url: new URL(over.url ?? "http://x/v1/contexts/policy"),
    body: over.body,
    params: {},
    app: {
      listContexts: async () => (over.contexts ?? []).map((scopeId) => ({ scopeId })),
      getInstructions: (scope: string) => ({
        instructions: instructions.get(scope)?.text ?? null,
        instructionsVersion: instructions.get(scope)?.version ?? 0,
      }),
      updateInstructions: async (scope: string, text: string) => {
        const version = (instructions.get(scope)?.version ?? 0) + 1;
        instructions.set(scope, { text, version });
        return version;
      },
    },
    deps: {
      channelPolicy: store,
      auditLog: { record: (e: unknown) => audits.push(e) },
    },
  } as unknown as ApiCtx;
  return { ctx, out, store, instructions };
}

test("context policy read requires membership and a Slack-backed scope", async () => {
  const member = makeCtx({
    url: "http://x/v1/contexts/policy?principalId=alice&scope=channel:C1",
    contexts: ["channel:C1"],
  });
  await member.store.set("C1", { setBy: "someone", bots: { "Noisy Bot": { mode: "ignore" } } });
  member.instructions.set("channel:C1", { text: "flag launches", version: 3 });
  await respond(getContextPolicy, member.ctx);
  assert.equal(member.out.status, 200);
  const policy = (
    member.out.body as {
      policy: { instructions: string; instructionsVersion: number; bots: Record<string, { mode: string }> };
    }
  ).policy;
  assert.equal(policy.instructions, "flag launches");
  assert.equal(policy.instructionsVersion, 3);
  assert.equal(policy.bots["Noisy Bot"]!.mode, "ignore");

  const outsider = makeCtx({ url: "http://x/v1/contexts/policy?principalId=mallory&scope=channel:C1", contexts: [] });
  await respond(getContextPolicy, outsider.ctx);
  assert.equal(outsider.out.status, 403);

  const personal = makeCtx({
    url: "http://x/v1/contexts/policy?principalId=alice&scope=personal:alice",
    contexts: ["personal:alice"],
  });
  await respond(getContextPolicy, personal.ctx);
  assert.equal(personal.out.status, 400);
});

test("context policy write validates the ledger, persists, and audits", async () => {
  const { ctx, out, store, instructions } = makeCtx({
    contexts: ["channel:C2"],
    body: {
      principalId: "alice",
      scope: "channel:C2",
      instructions: "watch for deploy failures",
      bots: { "General Agent": { mode: "rollup", rollupHours: 4 } },
    },
  });
  await respond(setContextPolicy, ctx);
  assert.equal(out.status, 200);
  const stored = await store.get("C2");
  assert.equal(instructions.get("channel:C2")?.text, "watch for deploy failures");
  assert.deepEqual(stored?.bots["General Agent"], { mode: "rollup", rollupHours: 4 });
  assert.equal(stored?.setBy, "alice");

  const bad = makeCtx({
    contexts: ["channel:C2"],
    store,
    instructions,
    body: { principalId: "alice", scope: "channel:C2", bots: { "General Agent": { mode: "sometimes" } } },
  });
  await respond(setContextPolicy, bad.ctx);
  assert.equal(bad.out.status, 400);

  const outsider = makeCtx({
    contexts: [],
    store,
    instructions,
    body: { principalId: "mallory", scope: "channel:C2", instructions: "hijack", bots: {} },
  });
  await respond(setContextPolicy, outsider.ctx);
  assert.equal(outsider.out.status, 403);
  assert.equal(instructions.get("channel:C2")?.text, "watch for deploy failures");
});

test("ambientEnabled round-trips through the member route and rejects non-booleans", async () => {
  const store = createPostgresChannelPolicyStore(testDatabaseUrl());
  const off = makeCtx({
    contexts: ["channel:C5"],
    store,
    body: { principalId: "alice", scope: "channel:C5", bots: {}, ambientEnabled: false },
  });
  await respond(setContextPolicy, off.ctx);
  assert.equal(off.out.status, 200);
  assert.equal((off.out.body as any).policy.ambientEnabled, false);
  assert.equal((await store.get("C5"))?.ambientEnabled, false);

  const read = makeCtx({
    url: "http://x/v1/contexts/policy?principalId=alice&scope=channel:C5",
    contexts: ["channel:C5"],
    store,
  });
  await respond(getContextPolicy, read.ctx);
  assert.equal((read.out.body as any).policy.ambientEnabled, false);

  const bad = makeCtx({
    contexts: ["channel:C5"],
    store,
    body: { principalId: "alice", scope: "channel:C5", bots: {}, ambientEnabled: "nope" },
  });
  await respond(setContextPolicy, bad.ctx);
  assert.equal(bad.out.status, 400);
  assert.equal((await store.get("C5"))?.ambientEnabled, false, "a rejected write changes nothing");

  const cleared = makeCtx({
    contexts: ["channel:C5"],
    store,
    body: { principalId: "alice", scope: "channel:C5", bots: {}, ambientEnabled: null },
  });
  await respond(setContextPolicy, cleared.ctx);
  assert.equal(cleared.out.status, 200);
  assert.equal((cleared.out.body as any).policy.ambientEnabled, null, "null clears back to the default rule");
  assert.equal((await store.get("C5"))?.ambientEnabled, undefined);
});

test("a stale baseUpdatedAt bounces instead of reverting a concurrent edit", async () => {
  const store = createPostgresChannelPolicyStore(testDatabaseUrl());
  await store.set("C3", { setBy: "agent" });
  const instructions: Instructions = new Map([["channel:C3", { text: "v1", version: 1 }]]);
  const current = await store.get("C3");
  const stale = makeCtx({
    contexts: ["channel:C3"],
    store,
    instructions,
    body: {
      principalId: "alice",
      scope: "channel:C3",
      instructions: "v2",
      bots: {},
      baseUpdatedAt: (current?.updatedAt ?? 0) - 1,
    },
  });
  await respond(setContextPolicy, stale.ctx);
  assert.equal(stale.out.status, 409);
  assert.equal(instructions.get("channel:C3")?.text, "v1");

  const fresh = makeCtx({
    contexts: ["channel:C3"],
    store,
    instructions,
    body: {
      principalId: "alice",
      scope: "channel:C3",
      instructions: "v2",
      bots: {},
      baseUpdatedAt: current?.updatedAt ?? 0,
    },
  });
  await respond(setContextPolicy, fresh.ctx);
  assert.equal(fresh.out.status, 200);
  assert.equal(instructions.get("channel:C3")?.text, "v2");
});
