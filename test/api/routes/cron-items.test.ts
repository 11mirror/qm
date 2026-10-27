import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedgerItemView } from "../../../src/inbox/view.ts";
import { world, call, CAP, PORTAL, ITEM, inboxCron, plainCron, seed } from "../../support/cron-items-app.ts";
import { ensureSentChat, cronItemRoutes } from "../../../src/api/routes/cron-items.ts";
import { buildGmailReplyMime } from "../../../src/inbox/sources/gmail.ts";
import { type ApiCtx, findRoute, respond, run } from "../../../src/api/routes/route.ts";
import { createInboxLedger } from "../../../src/inbox/ledger.ts";
import { inboxApp } from "../../support/inbox-app.ts";
import { testDatabaseUrl } from "../../support/test-database.ts";

test("ingest needs an agent capability, not a portal session", async () => {
  const w = world();
  const cron = await inboxCron(w);
  const fromPortal = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items?principalId=josh`,
    body: { items: [ITEM] },
    capability: PORTAL,
  });
  assert.equal(fromPortal.status, 403);
  const ok = await call(w, { method: "POST", path: `/v1/crons/${cron.id}/items`, body: { items: [ITEM] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { created: 1, updated: 0, skipped: 0 });
});

test("a personal inbox's items stay out of a shared-scope capability's reach", async () => {
  const w = world();
  const cron = await inboxCron(w);
  const shared = { ...CAP, privateScope: false, scopeId: "channel:C9" };
  assert.equal(
    (await call(w, { method: "POST", path: `/v1/crons/${cron.id}/items`, body: { items: [ITEM] }, capability: shared }))
      .status,
    403,
  );
  assert.equal((await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items`, capability: shared })).status, 403);
});

test("another person cannot read the ledger at all", async () => {
  const w = world();
  const cron = await inboxCron(w);
  const out = await call(w, {
    method: "GET",
    path: `/v1/crons/${cron.id}/items`,
    capability: { ...CAP, actorId: "ada", scopeId: "personal:ada" },
  });
  assert.equal(out.status, 404);
});

test("ingest stamps the drafting session from the caller's thread", async () => {
  const w = world();
  const cron = await inboxCron(w);
  await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items`,
    body: { items: [ITEM] },
    capability: { ...CAP, threadRef: "thread-9" },
    sessionForThread: "sess-42",
  });
  const [item] = await w.items.byCron(cron.id);
  assert.equal(item?.proposal?.sessionId, "sess-42");
});

test("an agent's draft edit stamps the drafting session from the caller's thread", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "edit", args: { proposal: { body: "Shorter" }, expectedProposalAt: item.proposal!.at } },
    capability: { ...CAP, threadRef: "thread-9" },
    sessionForThread: "sess-42",
  });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const after = await w.items.get(item.id);
  assert.deepEqual(after?.proposal?.data, { body: "Shorter" });
  assert.equal(after?.proposal?.by, "agent");
  assert.equal(after?.proposal?.sessionId, "sess-42");
});

test("ingest rejects malformed items with a pointed message", async () => {
  const w = world();
  const cron = await inboxCron(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items`,
    body: { items: [{ ...ITEM, slack: undefined }] },
  });
  assert.equal(out.status, 400);
  assert.match(String((out.body as { message: string }).message), /items\[0\]: slack items need/);
});

test("ingest refuses a source this inbox does not declare", async () => {
  const w = world();
  const cron = await inboxCron(w, "gmail");
  const out = await call(w, { method: "POST", path: `/v1/crons/${cron.id}/items`, body: { items: [ITEM] } });
  assert.equal(out.status, 400);
  assert.match(String((out.body as { message: string }).message), /does not accept "slack"/);
});

test("an inbox with no source adapter ingests an opaque payload", async () => {
  const w = world();
  const cron = await plainCron(w, {});
  const ok = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items`,
    body: {
      items: [
        {
          dedupeKey: "SENTRY-42",
          summary: "TypeError in checkout",
          sourceAt: 99,
          sourcePayload: { issue: "SENTRY-42", culprit: "checkout.ts", events: 12 },
          proposal: { plan: "guard the null" },
        },
      ],
    },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const [item] = await w.items.byCron(cron.id);
  assert.deepEqual(item?.sourcePayload, { issue: "SENTRY-42", culprit: "checkout.ts", events: 12 });
  assert.deepEqual(item?.proposal?.data, { plan: "guard the null" });
  assert.equal(item?.status, "ready");
});

test("an opaque item needs a dedupe key and an object payload", async () => {
  const w = world();
  const cron = await plainCron(w, {});
  const noKey = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items`,
    body: { items: [{ sourcePayload: {} }] },
  });
  assert.equal(noKey.status, 400);
  const huge = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items`,
    body: { items: [{ dedupeKey: "k", sourcePayload: { blob: "x".repeat(70_000) } }] },
  });
  assert.equal(huge.status, 400);
  assert.match(String((huge.body as { message: string }).message), /sourcePayload must be under/);
  const unknownSource = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items`,
    body: { items: [{ source: "front", dedupeKey: "k", sourcePayload: {} }] },
  });
  assert.equal(unknownSource.status, 400);
});

test("listing returns the ledger view with per-state counts and filters", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const listed = await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items` });
  const body = listed.body as { items: LedgerItemView[]; counts: Record<string, number> };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]!.state, "held");
  assert.equal(body.items[0]!.dedupeKey, "C1:1.2");
  assert.deepEqual(body.items[0]!.sourcePayload.slack, { channelId: "C1", ts: "1.2", isDirectMessage: false });
  assert.deepEqual(body.counts, { held: 1 });
  const heldOnly = await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items?state=held` });
  assert.equal((heldOnly.body as { items: unknown[] }).items.length, 1);
  const pendingOnly = await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items?state=pending` });
  assert.equal((pendingOnly.body as { items: unknown[] }).items.length, 0);
  const junk = await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items?state=nonsense` });
  assert.equal(junk.status, 400);
  const one = await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items/${item.id}` });
  assert.equal((one.body as { item: LedgerItemView }).item.id, item.id);
  const missing = await call(w, { method: "GET", path: `/v1/crons/${cron.id}/items/nope` });
  assert.equal(missing.status, 404);
});

test("edit replaces the proposal and marks it the person's own", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action?principalId=josh`,
    body: { kind: "edit", args: { proposal: { body: "Shorter." } } },
    capability: PORTAL,
  });
  assert.equal(out.status, 200);
  const view = (out.body as { item: LedgerItemView }).item;
  assert.deepEqual(view.proposal?.data, { body: "Shorter." });
  assert.equal(view.proposal?.by, "human");
});

test("send posts through the source adapter, records the outcome, and refuses a resend", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const sent = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "send" },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const view = (sent.body as { item: LedgerItemView }).item;
  assert.equal(view.state, "actioned");
  assert.equal(view.actionResult, "Looking now — back to you within the hour.");
  assert.deepEqual(w.sent, [
    {
      host: "chat.postMessage",
      body: { channel: "C1", text: "Looking now — back to you within the hour.", parse: "none", thread_ts: "1.2" },
    },
  ]);
  const again = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "send" },
  });
  assert.equal(again.status, 409);
  assert.equal(w.sent.length, 1, "a resend never reaches the source");
});

test("send takes a final edit in the same call and a refusal leaves the item held", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  w.slackOk = false;
  const blocked = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "send", args: { proposal: { body: "Final words." } } },
  });
  assert.equal(blocked.status, 502);
  const stored = await w.items.get(item.id);
  assert.equal(stored?.status, "ready", "a refused send leaves the item held");
  assert.deepEqual(stored?.proposal?.data, { body: "Final words." }, "the edit still persisted");
  w.slackOk = true;
  const ok = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "send" },
  });
  assert.equal(ok.status, 200);
  assert.equal((w.sent.at(-1)!.body as { text: string }).text, "Final words.");
});

test("dismiss, reopen and the actioned end-state", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const dismissed = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "dismiss" },
  });
  assert.equal((dismissed.body as { item: LedgerItemView }).item.state, "dismissed");
  const reopened = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "reopen" },
  });
  assert.equal((reopened.body as { item: LedgerItemView }).item.state, "held");
  await w.items.recordAction(item.id, { kind: "send", outcome: "actioned" });
  const again = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "send" },
  });
  assert.equal(again.status, 409);
});

test("react adds the emoji, records it on the item, and leaves the item held", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "react", args: { name: ":eyes:" } },
  });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const view = (out.body as { item: LedgerItemView }).item;
  assert.equal(view.state, "held", "reacting never resolves the item");
  assert.deepEqual(view.sourcePayload.reactions, ["eyes"]);
  assert.equal(view.actionKind, undefined);
  assert.deepEqual(w.sent, [{ host: "reactions.add", body: { channel: "C1", timestamp: "1.2", name: "eyes" } }]);
  const again = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "react", args: { name: "tada" } },
  });
  assert.deepEqual((again.body as { item: LedgerItemView }).item.sourcePayload.reactions, ["eyes", "tada"]);
});

test("a reaction slack refuses leaves the item untouched", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  w.slackOk = false;
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "react", args: { name: "eyes" } },
  });
  assert.equal(out.status, 502);
  const stored = await w.items.get(item.id);
  assert.equal(stored?.status, "ready");
  assert.equal(stored?.sourcePayload?.reactions, undefined);
});

test("an action kind the source does not know is refused", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "escalate", args: { to: "ada" } },
  });
  assert.equal(out.status, 400);
  assert.equal((await w.items.get(item.id))?.status, "ready");
  assert.deepEqual(w.sent, []);
});

test("a deployment without connectors answers 404 rather than pretending to send", async () => {
  const w = world({ tokens: false });
  const { cron, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { kind: "send" },
  });
  assert.equal(out.status, 404);
});

test("an action with no kind is refused", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/action`,
    body: { args: {} },
  });
  assert.equal(out.status, 400);
});

test("follow-up runs an agent turn scoped to the item and lands on its thread", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const out = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/followup`,
    body: { message: "make it shorter" },
  });
  assert.equal(out.status, 200);
  assert.deepEqual(w.followUps, [{ itemId: item.id, message: "make it shorter", actorId: "josh" }]);
  const view = (out.body as { item: LedgerItemView }).item;
  assert.deepEqual(
    view.thread.map((m) => [m.role, m.text]),
    [
      ["human", "make it shorter"],
      ["agent", "shortened it"],
    ],
  );
  assert.deepEqual(view.proposal?.data, { body: "shorter" });
});

test("follow-up needs a message and a wired chat service", async () => {
  const w = world();
  const { cron, item } = await seed(w);
  const empty = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/followup`,
    body: { message: "   " },
  });
  assert.equal(empty.status, 400);
  const long = await call(w, {
    method: "POST",
    path: `/v1/crons/${cron.id}/items/${item.id}/followup`,
    body: { message: "x".repeat(4_001) },
  });
  assert.equal(long.status, 400);
  const unwired = world({ chat: false });
  const seeded = await seed(unwired);
  const out = await call(unwired, {
    method: "POST",
    path: `/v1/crons/${seeded.cron.id}/items/${seeded.item.id}/followup`,
    body: { message: "hi" },
  });
  assert.equal(out.status, 404);
});

test("sent chats are durable, idempotent, and isolated to the signed-in owner", async () => {
  const { crons, app } = inboxApp();
  const items = createInboxLedger(testDatabaseUrl());
  let previewEnabled = false;
  let status = 0;
  let response: { item: { id: string; cronId: string; state: string; thread: { text: string }[] } };
  const ctx = {
    actor: { p: "alice" },
    url: new URL("http://localhost/?principalId=bob"),
    body: { threadId: "sent-only-thread", subject: "No inbox match", from: "Alice", text: "The sent email body" },
    app,
    deps: { inbox: { items, record: async () => {} }, featureFlags: { enabled: async () => previewEnabled } },
    res: {
      setHeader() {},
      getHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(data: string) {
        response = JSON.parse(data);
      },
    },
  } as unknown as ApiCtx;
  await respond(ensureSentChat, ctx);
  assert.equal(status, 403);
  assert.equal((await crons.list()).length, 0);
  previewEnabled = true;
  await respond(ensureSentChat, ctx);
  assert.equal(status, 200);
  const original = response!.item;
  assert.equal(original.state, "held");
  assert.equal((await crons.get(original.cronId))!.owner, "alice");
  assert.equal((await items.get(original.id))!.sourcePayload!.snippet, "The sent email body");
  await items.appendThread(original.id, [{ role: "human", text: "Summarize this" }]);
  await respond(ensureSentChat, ctx);
  assert.equal(response!.item.id, original.id);
  assert.equal(response!.item.thread[0]!.text, "Summarize this");
  await items.setProposal(original.id, { data: { body: "My unfinished draft" }, by: "human" });
  const proposal = (await items.get(original.id))!.proposal;
  ctx.body = {
    threadId: "sent-only-thread",
    messageId: "newer-message",
    subject: "New title",
    from: "New sender",
    text: "New context",
  };
  await respond(ensureSentChat, ctx);
  const refreshed = (await items.get(original.id))!;
  assert.deepEqual(refreshed.proposal, proposal);
  assert.equal(refreshed.sourcePayload!.snippet, "New context");
  assert.equal(refreshed.sourcePayload!.from, "New sender");
  assert.equal(refreshed.sourcePayload!.title, "New title");
  assert.equal(refreshed.sourceSummary, "New title");
  assert.equal((refreshed.sourcePayload!.gmail as { messageId: string }).messageId, "newer-message");
  ctx.body = { ...(ctx.body as object), accountType: "personal" };
  await respond(ensureSentChat, ctx);
  assert.notEqual(response!.item.id, original.id);
  ctx.actor = { p: "bob" } as ApiCtx["actor"];
  await respond(ensureSentChat, ctx);
  assert.notEqual(response!.item.id, original.id);
  assert.equal(response!.item.thread.length, 0);
  ctx.actor = undefined;
  await respond(ensureSentChat, ctx);
  assert.equal(status, 403);
});

test("a sent email draft saves and sends into the original Gmail thread exactly once", async () => {
  const { app } = inboxApp();
  const items = createInboxLedger(testDatabaseUrl());
  let response: { item: { id: string; cronId: string; proposal?: { at: number; data: { body: string } } } };
  let status = 0;
  const ctx = {
    actor: { p: "alice" },
    url: new URL("http://localhost/"),
    body: {
      threadId: "thread-1",
      subject: "Project update",
      from: "Alice",
      to: "Bob <bob@example.com>",
      cc: "Casey <casey@example.com>",
      rfcMessageId: "<original@example.com>",
      text: "Original sent message",
    },
    app,
    deps: {
      inbox: { items, record: async () => {} },
      inboxSourceTokens: { connectorAccessToken: async () => "test-token" },
      featureFlags: { enabled: async () => true },
    },
    res: {
      setHeader() {},
      getHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(data: string) {
        response = JSON.parse(data);
      },
    },
  } as unknown as ApiCtx;
  await respond(ensureSentChat, ctx);
  const { id, cronId } = response!.item;
  const found = findRoute(cronItemRoutes, "POST", `/v1/crons/${cronId}/items/${id}/action`)!;
  const action = async (kind: string, args = {}) => {
    ctx.body = { kind, args };
    await run(found.route, found.params, ctx);
  };
  const draft = {
    to: ["Bob <bob@example.com>"],
    cc: ["Casey <casey@example.com>"],
    subject: "Project update",
    body: "Following up",
  };
  await action("edit", { proposal: draft });
  assert.equal(status, 200);
  assert.equal(response!.item.proposal!.data.body, "Following up");
  const savedAt = response!.item.proposal!.at;
  const originalFetch = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = async (_url, init) => {
    sent++;
    const message = JSON.parse(String(init!.body));
    assert.equal(message.threadId, "thread-1");
    const mime = Buffer.from(message.raw, "base64url").toString();
    assert.match(mime, /To: Bob <bob@example.com>/);
    assert.match(mime, /Cc: Casey <casey@example.com>/);
    assert.match(mime, /In-Reply-To: <original@example.com>/);
    return Response.json({ id: "sent-reply", threadId: "thread-1" });
  };
  try {
    await action("send", { proposal: draft, expectedProposalAt: savedAt });
    assert.equal(status, 200);
    await action("send", { proposal: draft, expectedProposalAt: savedAt });
    assert.equal(status, 409);
    assert.equal(sent, 1);
    await action("reply");
    assert.equal(status, 200);
    assert.equal(response!.item.proposal!.data.body, "");
    await action("send", { proposal: draft, expectedProposalAt: savedAt });
    assert.equal(status, 409);
    assert.equal(sent, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sent chat preserves long quoted recipient headers and rejects oversized input", async () => {
  const { app } = inboxApp();
  const items = createInboxLedger(testDatabaseUrl());
  let status = 0;
  let id = "";
  const to = [
    '"Doe, Jane" <jane@example.com>',
    ...Array.from({ length: 15 }, (_, i) => `Recipient ${i} <recipient${i}@example.com>`),
  ].join(", ");
  const cc = '"Smith, Casey" <casey@example.com>';
  const ctx = {
    actor: { p: "alice" },
    body: { threadId: "t", to, cc },
    app,
    deps: { inbox: { items, record: async () => {} }, featureFlags: { enabled: async () => true } },
    res: {
      setHeader() {},
      getHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(data: string) {
        id = JSON.parse(data).item?.id ?? "";
      },
    },
  } as unknown as ApiCtx;
  await respond(ensureSentChat, ctx);
  assert.equal(status, 200);
  const stored = (await items.get(id))!;
  const mime = (await buildGmailReplyMime(stored, { body: "Hello" }))!.toString();
  assert.ok(mime.replaceAll("\r\n ", " ").startsWith(`To: ${to}\r\nCc: ${cc}\r\n`));
  for (const invalid of [
    { to: "x".repeat(8001) },
    { cc: "x".repeat(8001) },
    { to: "a@example.com\r\nBcc: b@example.com" },
    { accountType: "forged" },
    { accountType: ["default"] },
  ]) {
    ctx.body = { threadId: "t", ...invalid };
    await respond(ensureSentChat, ctx);
    assert.equal(status, 400);
    assert.deepEqual((await items.get(stored.id))!.sourcePayload, stored.sourcePayload);
  }
});
