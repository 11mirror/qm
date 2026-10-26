import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { signedRequestHeaders } from "../plugins/chassis/src/source-auth-sign.ts";
import { createHttpChatSurface, httpChatConfigsFromEnv, type HttpChatConfig } from "../src/chat-surface/http-chat.ts";
import { createSurfaceRegistry, inboundTurn } from "../src/chat-surface/registry.ts";
import { createSlackSurface } from "../src/chat-surface/slack.ts";
import { surfaceThreadRef } from "../src/chat-surface/refs.ts";
import type { InboundMessage } from "../src/chat-surface/surface.ts";
import { createApprovalStore } from "../src/core/approval-store.ts";
import { createOutbound, type OutboundPost } from "../src/surfaces/outbound.ts";
import { conversationScope } from "../src/resolution/resolution-service.ts";
import { tenant } from "../src/tenant.ts";
import type { PendingApprovalRecord, TurnRequest } from "../src/types.ts";
import type { IngestEvent } from "../src/surface-cache/types.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { settle } from "./support/settle.ts";
import { testMap } from "./support/test-database.ts";

const SECRET = "synthetic-chat-surface-signing-secret-0123456789";
const PATH = "/v1/surfaces/forum/events";

function config(apiUrl = "http://forum.invalid/agent"): HttpChatConfig {
  return {
    surface: "forum",
    account: "prod",
    label: "Forum",
    apiUrl,
    apiToken: "synthetic-forum-api-token",
    signingSecret: SECRET,
    internalEmailDomains: ["example.com"],
  };
}

function dmEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    chat: { id: 42, kind: "dm", members: [{ id: 7, email: "alice@example.com", name: "Alice" }] },
    message: { id: 9001, text: "hello there" },
    author: { id: 7, email: "alice@example.com", name: "Alice", timezone: "America/Los_Angeles" },
    ...overrides,
  };
}

function signed(body: unknown, secret = SECRET, nowSec = Math.floor(Date.now() / 1000)) {
  const rawBody = JSON.stringify(body);
  return { rawBody, pathWithQuery: PATH, headers: signedRequestHeaders(secret, "POST", PATH, rawBody, {}, nowSec) };
}

test("surface refs keep a chat id from colliding with another surface or account", () => {
  const forum = surfaceThreadRef({ surface: "forum", account: "prod", kind: "channel", container: "123" });
  const other = surfaceThreadRef({ surface: "chat2", account: "prod", kind: "channel", container: "123" });
  assert.equal(forum, "forum:prod:ch:123");
  assert.notEqual(forum, other);
  assert.equal(
    conversationScope({ kind: "channel", threadRef: forum, channelRef: "forum:prod:123" }, "alice@example.com"),
    "channel:forum:prod:123",
  );
  assert.throws(() => surfaceThreadRef({ surface: "forum", account: "prod", kind: "dm", container: "1:ch:2" }));
});

test("http-chat accepts only events signed with its own secret inside the replay window", async () => {
  const adapter = createHttpChatSurface(config());
  const receive = adapter.normalize!.bind(adapter);
  const ok = await receive(signed(dmEvent()));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.status === 200 && ok.messages[0], {
    tenant: tenant(),
    account: "prod",
    conversation: { kind: "dm", key: "42", members: [{ id: "7", email: "alice@example.com", displayName: "Alice" }] },
    messageId: "9001",
    author: { id: "7", email: "alice@example.com", displayName: "Alice", timezone: "America/Los_Angeles" },
    text: "hello there",
    attachments: [],
    mentions: {},
    mentionsSelf: false,
    threadEngaged: false,
  });
  assert.equal((await receive(signed(dmEvent(), "another-secret-that-is-long-enough-000000"))).status, 401);
  assert.equal((await receive(signed(dmEvent(), SECRET, Math.floor(Date.now() / 1000) - 3600))).status, 401);
  const tampered = signed(dmEvent());
  assert.equal((await receive({ ...tampered, rawBody: tampered.rawBody.replace("hello", "HELLO") })).status, 401);
  const other = await receive(signed({ type: "reaction_added" }));
  assert.deepEqual(other, { status: 200, messages: [] });
});

test("http-chat treats authors as guests unless their email is in an internal domain, and takes DMs only", async () => {
  const adapter = createHttpChatSurface(config());
  const receive = adapter.normalize!.bind(adapter);
  const authorOf = async (author: Record<string, unknown>) => {
    const out = await receive(signed(dmEvent({ author })));
    return out.status === 200 ? out.messages[0]?.author : undefined;
  };
  assert.equal((await authorOf({ id: 1, email: "a@example.com" }))?.guest, undefined);
  assert.equal((await authorOf({ id: 1, email: "a@EXAMPLE.com" }))?.guest, undefined);
  assert.equal((await authorOf({ id: 1, email: "a@example.com", guest: true }))?.guest, true);
  assert.equal((await authorOf({ id: 1, email: "a@other.test" }))?.guest, true);
  assert.equal((await authorOf({ id: 1 }))?.guest, true);
  const channel = dmEvent({ chat: { id: 42, kind: "channel" }, message: { id: 1, text: "hi", mentions_bot: true } });
  assert.deepEqual(await receive(signed(channel)), { status: 200, messages: [] });
  assert.equal((await receive(signed(dmEvent({ chat: { id: "4:2", kind: "dm" } })))).status, 400);
  assert.equal((await receive(signed(dmEvent({ chat: { id: 2 ** 60, kind: "dm" } })))).status, 400);
});

test("http-chat configuration rejects reserved surface names and weak secrets", () => {
  const env = (value: unknown) => ({ HTTP_CHAT_SURFACES: JSON.stringify(value) });
  assert.deepEqual(httpChatConfigsFromEnv({}), []);
  assert.equal(httpChatConfigsFromEnv(env([config()]))[0]?.surface, "forum");
  assert.throws(() => httpChatConfigsFromEnv(env([{ ...config(), surface: "slack" }])), /reserved/);
  assert.throws(() => httpChatConfigsFromEnv(env([{ ...config(), signingSecret: "short" }])), /32/);
});

test("a DM always becomes a turn; a channel message needs a mention or an engaged thread", () => {
  const adapter = createHttpChatSurface(config());
  const message = (
    conversation: InboundMessage["conversation"],
    extra: Partial<InboundMessage> = {},
  ): InboundMessage => ({
    tenant: tenant(),
    account: "prod",
    conversation,
    messageId: "1",
    author: { id: "7", email: "alice@example.com" },
    text: "hi",
    attachments: [],
    mentions: {},
    mentionsSelf: false,
    threadEngaged: false,
    ...extra,
  });
  const dm = inboundTurn(adapter, message({ kind: "dm", key: "42" }));
  assert.equal(dm?.surface, "forum");
  assert.equal(dm?.conversation.threadRef, "forum:prod:dm:42");
  assert.equal(dm?.conversation.channelRef, undefined);
  assert.equal(dm?.deliveryTarget, "42");
  assert.equal(dm?.actor.externalId, "alice@example.com");
  assert.equal(dm?.idempotencyKey, "forum:prod:1");
  assert.deepEqual(dm?.source, { account: "prod", workspaceId: "prod", userId: "7" });
  assert.equal(inboundTurn(adapter, message({ kind: "channel", key: "42" })), undefined);
  assert.equal(inboundTurn(adapter, message({ kind: "dm", key: "42" }, { author: { id: "8", bot: true } })), undefined);
  const mentioned = inboundTurn(
    adapter,
    message({ kind: "channel", key: "42", thread: "500" }, { mentionsSelf: true }),
  );
  assert.equal(mentioned?.conversation.threadRef, "forum:prod:ch:42:500");
  assert.equal(mentioned?.conversation.channelRef, "forum:prod:42");
  assert.equal(mentioned?.deliveryTarget, "42:500");
  assert.equal(
    inboundTurn(adapter, message({ kind: "group", key: "42", thread: "500" }, { threadEngaged: true }))?.conversation
      .kind,
    "group",
  );
  const anonymous = inboundTurn(adapter, message({ kind: "dm", key: "42" }, { author: { id: "8", guest: true } }));
  assert.deepEqual(anonymous?.actor, { externalId: "forum:prod:user:8", isExternalGuest: true });
  const withFile = inboundTurn(
    adapter,
    message({ kind: "dm", key: "42" }, { attachments: [{ id: "f1", name: "deck.pdf", url: "https://x.test/f1" }] }),
  );
  assert.equal(withFile?.text, "hi\n[attachment: deck.pdf https://x.test/f1]");
});

function fakeForum() {
  const posts: Array<{ url: string; body: unknown; auth: string | null }> = [];
  let status = 201;
  const adapter = createHttpChatSurface(config("http://forum.invalid/agent/"), {
    fetch: async (url, init) => {
      posts.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ id: 77 }), { status });
    },
  });
  return { adapter, posts, failWith: (code: number) => void (status = code) };
}

test("registry submits signed events as turns and posts outbound replies through the owning surface", async () => {
  const forum = fakeForum();
  const slack = createSlackSurface();
  const slackPosts: OutboundPost[] = [];
  slack.slack.attach(async (post) => void slackPosts.push(post));
  const turns: TurnRequest[] = [];
  const outbound = createOutbound({});
  const registry = createSurfaceRegistry({
    surfaces: [slack, forum.adapter],
    outbound,
    turn: async (request) => {
      turns.push(request);
      return { runId: `run-${turns.length}` };
    },
  });
  assert.equal(registry.label("forum"), "Forum");
  assert.equal(registry.label("slack"), "Slack");
  assert.equal(registry.forDestination("principal"), slack);
  assert.deepEqual(await registry.receive("forum", signed(dmEvent())), {
    status: 200,
    body: { ok: true, runs: ["run-1"] },
  });
  assert.equal(
    (await registry.receive("forum", signed(dmEvent(), "wrong-secret-wrong-secret-wrong-secret-00"))).status,
    401,
  );
  assert.equal((await registry.receive("nope", signed(dmEvent()))).status, 404);
  assert.equal((await registry.receive("slack", signed(dmEvent()))).status, 404);
  assert.equal(turns.length, 1);

  await outbound.send({
    destination: { type: "forum", target: "42:500", account: "prod" },
    text: "the reply",
    idempotencyKey: "run:run-1",
  });
  await outbound.send({ destination: { type: "slack", target: "C1" }, text: "to slack", idempotencyKey: "run:s" });
  assert.deepEqual(forum.posts, [
    {
      url: "http://forum.invalid/agent/chats/42/messages",
      body: { text: "the reply", thread_id: "500", idempotency_key: "run:run-1" },
      auth: "Bearer synthetic-forum-api-token",
    },
  ]);
  assert.deepEqual(
    slackPosts.map((p) => [p.destination.target, p.text]),
    [["C1", "to slack"]],
  );
});

test("http-chat refuses posts for another account or a malformed target, and treats 4xx as permanent", async () => {
  const forum = fakeForum();
  const ctx = (destination: { type: string; target: string; account?: string }) => ({
    tenant: tenant(),
    destination,
    idempotencyKey: "k",
  });
  await assert.rejects(
    forum.adapter.deliver(ctx({ type: "forum", target: "42", account: "staging" }), { text: "x" }),
    (error: Error & { permanent?: boolean }) => error.permanent === true,
  );
  await assert.rejects(
    forum.adapter.deliver(ctx({ type: "forum", target: "a b" }), { text: "x" }),
    (error: Error & { permanent?: boolean }) => error.permanent === true,
  );
  forum.failWith(404);
  await assert.rejects(
    forum.adapter.deliver(ctx({ type: "forum", target: "42" }), { text: "x" }),
    (error: Error & { permanent?: boolean }) => error.permanent === true,
  );
  forum.failWith(503);
  await assert.rejects(
    forum.adapter.deliver(ctx({ type: "forum", target: "42" }), { text: "x" }),
    (error: Error & { permanent?: boolean }) => error.permanent !== true,
  );
  assert.equal(forum.posts.length, 2);
});

test("native() hands out the Slack handle only from the Slack surface, and each Slack surface owns its accounts", () => {
  const a = createSlackSurface();
  const b = createSlackSurface();
  assert.equal(fakeForum().adapter.native("slack"), null);
  assert.equal(a.native("slack"), a.slack);
  a.slack.accounts.set("default", { client: {}, teamId: "T1" });
  assert.equal(b.slack.accounts.has("default"), false);
  assert.throws(
    () => createSurfaceRegistry({ surfaces: [a, b], outbound: createOutbound({}), turn: async () => ({}) }),
    /unique/,
  );
});

test("an approval on a non-Slack surface is posted to the conversation as text with a link", async () => {
  const forum = fakeForum();
  const outbound = createOutbound({});
  const registry = createSurfaceRegistry({ surfaces: [forum.adapter], outbound, turn: async () => ({}) });
  const store = createApprovalStore(testMap<PendingApprovalRecord>(), outbound, {
    surfaces: registry,
    webSessionUrl: (id) => `https://qm.test/s/${id}`,
  });
  const request = inboundTurn(forum.adapter, {
    tenant: tenant(),
    account: "prod",
    conversation: { kind: "dm", key: "42" },
    messageId: "1",
    author: { id: "7", email: "alice@example.com" },
    text: "deploy it",
    attachments: [],
    mentions: {},
    mentionsSelf: false,
    threadEngaged: false,
  })!;
  await store.put("ap1", {
    requestId: "ap1",
    command: "fly deploy",
    summary: "Deploy the app",
    sessionId: "sess-1",
    createdAt: 5,
    request,
  } as PendingApprovalRecord);
  assert.deepEqual(
    forum.posts.map((p) => p.body),
    [
      {
        text: "Approval needed: Deploy the app\nApprove or deny it here: https://qm.test/s/sess-1",
        idempotency_key: "command-approval:ap1:5",
      },
    ],
  );
});

test("http-chat writes its inbound and outbound messages to the surface message store under its own key", async () => {
  const mirrored: IngestEvent[] = [];
  const adapter = createHttpChatSurface(config(), {
    now: () => 1_700_000_000_000,
    fetch: async () => new Response("{}", { status: 201 }),
    mirror: async (events) => void mirrored.push(...events),
  });
  await adapter.normalize!(
    signed(
      dmEvent({
        message: { id: 9001, text: "hello", thread_id: 500, sent_at: 1_700_000_000_000 },
        author: { id: 7, email: "alice@example.com", name: "Alice" },
      }),
      SECRET,
      1_700_000_000,
    ),
  );
  await adapter.deliver(
    { tenant: tenant(), destination: { type: "forum", target: "42:500" }, idempotencyKey: "run:1" },
    { text: "hi back" },
  );
  await settle(async () => mirrored.length === 2);
  assert.deepEqual(mirrored, [
    {
      container: "forum:prod:42",
      ts: "1700000000.000000",
      sub: "500",
      authorId: "7",
      authorName: "Alice",
      text: "hello",
      files: [],
      kind: "dm",
      members: ["alice@example.com"],
    },
    { container: "forum:prod:42", ts: "1700000000.000001", sub: "500", text: "hi back", self: true, handled: true },
  ]);
});

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  return raw;
}

test("a signed DM event round-trips through core and its reply is posted to the chat API", async (t) => {
  const received: Array<{ path: string; body: Record<string, unknown> }> = [];
  const forum = createHttpServer(async (req, res) => {
    received.push({ path: req.url ?? "", body: JSON.parse(await readBody(req)) as Record<string, unknown> });
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: received.length }));
  });
  await new Promise<void>((resolve) => forum.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => forum.close(() => resolve())));
  const forumUrl = `http://127.0.0.1:${(forum.address() as AddressInfo).port}/agent`;

  const { createServer } = await import("../src/api/server.ts");
  const { serverDeps } = await import("../src/wiring.ts");
  const cfg = testConfig({
    signingSecret: "synthetic-core-signing-secret-0123456789",
    chatSurfaces: [config(forumUrl)],
  });
  const b = buildApp(cfg);
  await b.identity.hydrate();
  b.runtime.start();
  const server = createServer(b.app, serverDeps(cfg, b));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    b.scheduler.stop();
    b.deploymentLayerRefresh.stop();
    await b.runtime.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = async (body: unknown) => {
    const event = signed(body);
    return fetch(`${base}${PATH}`, { method: "POST", headers: event.headers, body: event.rawBody });
  };

  const unsigned = await fetch(`${base}${PATH}`, { method: "POST", body: JSON.stringify(dmEvent()) });
  assert.equal(unsigned.status, 401);

  const accepted = await send(dmEvent({ message: { id: 9001, text: "!sysprompt" } }));
  assert.equal(accepted.status, 200);
  await settle(async () => received.length === 1);
  assert.equal(received[0]?.path, "/agent/chats/42/messages");
  assert.match(String(received[0]?.body.text), /over Forum\b/);
  assert.equal(received[0]?.body.idempotency_key, `run:${((await accepted.json()) as { runs: string[] }).runs[0]}`);

  const session = await b.sessions.getByThread("forum:prod:dm:42");
  assert.equal(session?.surface, "forum");
  assert.equal(session?.scopeId, "personal:alice@example.com");

  const replayed = await send(dmEvent({ message: { id: 9001, text: "!sysprompt" } }));
  assert.equal(replayed.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(received.length, 1);
});
