import assert from "node:assert/strict";
import { after, test } from "node:test";
import { type LatestEvent } from "../../src/inbox/ledger.ts";
import {
  fixture,
  slackServer,
  slackUrl,
  featureFlags,
  createInboxSourceRefresh,
  tokens,
  json,
  directory,
  slackFetch,
} from "../support/inbox-refresh.ts";
await new Promise<void>((resolve) => slackServer.listen(0, "127.0.0.1", resolve));
after(() => slackServer.close());
function recorder() {
  const events: unknown[] = [];
  const record = async (_item: unknown, event: LatestEvent) => {
    events.push(event);
  };
  return { events, record };
}

test("Gmail reply sent outside QM becomes an owner event, ignoring drafts and recognizing send-as aliases", async () => {
  const { items, item } = await fixture();
  let reads = 0;
  const queue = recorder();
  const refresh = createInboxSourceRefresh({
    featureFlags,
    items,
    record: queue.record,
    tokens,
    directory,
    fetchImpl: async (url) => {
      reads++;
      assert.match(String(url), /threads\/t1\?format=metadata$/);
      return json({
        messages: [
          { id: "in", internalDate: "1000", labelIds: ["INBOX"] },
          { id: "out", internalDate: "2000", labelIds: ["SENT"], snippet: "Handled elsewhere" },
          { id: "draft", internalDate: "3000", labelIds: ["DRAFT"] },
        ],
      });
    },
  });
  await Promise.all([refresh("owner@example.com", [item]), refresh("owner@example.com", [item])]);
  await refresh("owner@example.com", [item]);
  assert.deepEqual(queue.events, [{ author: "owner", at: 2000, text: "Handled elsewhere" }]);
  assert.equal((await items.get(item.id))!.proposal?.data.body, "Keep my edit");
  assert.equal(reads, 1);
});

test("an old sent message or a newer inbound message does not close a Gmail item", async () => {
  for (const messages of [
    [{ internalDate: "900", labelIds: ["SENT"] }],
    [
      { internalDate: "1500", labelIds: ["SENT"] },
      { internalDate: "2000", labelIds: ["INBOX"] },
    ],
    [{ internalDate: "2000", labelIds: ["DRAFT"] }],
  ]) {
    const { items, item } = await fixture();
    const queue = recorder();
    await createInboxSourceRefresh({
      featureFlags,
      items,
      record: queue.record,
      tokens,
      directory,
      fetchImpl: async () => json({ messages }),
    })("owner", [item]);
    assert.deepEqual(queue.events, []);
  }
});

test("provider failure or missing connection preserves the item with an explicit refresh warning", async () => {
  for (const connected of [true, false]) {
    const { items, item } = await fixture();
    await createInboxSourceRefresh({
      featureFlags,
      items,
      tokens: { connectorAccessToken: async () => (connected ? "test" : null) },
      directory,
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    })("owner", [item]);
    const after = (await items.get(item.id))!;
    assert.equal(after.status, "ready");
    assert.equal(after.proposal?.data.body, "Keep my edit");
    assert.ok(after.sourcePayload?.sourceRefreshError);
  }
});

test("a new inbound message during a provider read wins over the older own reply", async () => {
  const { items, item } = await fixture();
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    fetchImpl: async () => {
      await items.ingest([
        {
          cronId: "inbox",
          dedupeKey: "ask",
          source: "gmail",
          sourceAt: 3000,
          sourcePayload: { gmail: { threadId: "t1" } },
        },
      ]);
      return json({ messages: [{ internalDate: "2000", labelIds: ["SENT"] }] });
    },
  })("owner", [item]);
  assert.equal((await items.get(item.id))!.status, "queued");
  assert.equal((await items.get(item.id))!.sourceAt, 3000);
});

test("top-level/private-channel mentions fetch just their root and replies, never channel history", async () => {
  for (const meta of [
    { channelId: "GPRIVATE", ts: "1.0" },
    { channelId: "C1", ts: "2.0", threadTs: "1.0" },
  ]) {
    const { items, item } = await fixture("slack", meta);
    const calls: string[] = [];
    await createInboxSourceRefresh({
      featureFlags,
      items,
      tokens,
      directory,
      slackApiUrl: slackUrl(slackFetch(calls)),
    })("owner", [item]);
    const after = (await items.get(item.id))!;
    assert.deepEqual(
      (after.sourcePayload!.context as Array<{ text: string }>).map((m) => m.text),
      ["Original mention", "Thread reply"],
    );
    assert.ok(calls.some((p) => p.includes("conversations.replies?") && p.includes("ts=1.0")));
    assert.ok(calls.every((p) => !p.includes("conversations.history")));
    assert.equal(after.sourcePayload!.sourceContextFetched, true);
    assert.equal(after.proposal?.data.body, "Keep my edit");
  }
});

test("Slack detects group DMs by conversation metadata, including C-prefixed IDs", async () => {
  const { items, item } = await fixture("slack", { channelId: "C_GROUP_DM", ts: "1.0" });
  const calls: string[] = [];
  const queue = recorder();
  await createInboxSourceRefresh({
    featureFlags,
    items,
    record: queue.record,
    tokens,
    directory,
    slackApiUrl: slackUrl(slackFetch(calls, { direct: true, own: true })),
  })("owner", [item]);
  assert.ok(calls.some((p) => p.includes("conversations.history")));
  assert.deepEqual(queue.events, [{ author: "owner", at: 2000, text: "Thread reply" }]);
});

test("a partial Slack thread is displayed as partial but cannot resolve an item", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0" });
  const queue = recorder();
  await createInboxSourceRefresh({
    featureFlags,
    items,
    record: queue.record,
    tokens,
    directory,
    slackApiUrl: slackUrl(slackFetch([], { partial: true, own: true })),
  })("owner", [item]);
  const after = (await items.get(item.id))!;
  assert.deepEqual(queue.events, []);
  assert.equal(after.sourcePayload!.sourceContextPartial, true);
});

test("rate limiting is respected across different Slack items and never triggers a history fallback", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0" });
  let reads = 0;
  const refresh = createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    slackApiUrl: slackUrl(async (url) => {
      if (String(url).includes("conversations.info")) return json({ ok: true, channel: {} });
      reads++;
      return new Response("limited", { status: 429, headers: { "retry-after": "120" } });
    }),
  });
  await refresh("owner", [item]);
  await refresh("owner", [{ ...item, id: "second" }]);
  assert.equal(reads, 1);
  assert.equal((await items.get(item.id))!.status, "ready");
});

test("a Gmail rate limit pauses reads across the owner's Gmail items", async () => {
  const { items, item } = await fixture();
  let reads = 0;
  const refresh = createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    fetchImpl: async () => {
      reads++;
      return new Response("limited", { status: 429, headers: { "retry-after": "120" } });
    },
  });
  await refresh("owner", [item]);
  await refresh("owner", [{ ...item, id: "second" }]);
  assert.equal(reads, 1);
  assert.match(String((await items.get(item.id))!.sourcePayload?.sourceRefreshError), /not been dismissed/);
});

test("slow Gmail reads have a total batch budget and later cards are visited on the next refresh", async () => {
  const { items, item } = await fixture();
  let clock = 0;
  let reads = 0;
  const refresh = createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    now: () => clock,
    fetchImpl: async () => {
      reads++;
      clock += 1000;
      return json({ messages: [] });
    },
  });
  const cards = Array.from({ length: 12 }, (_, i) => ({ ...item, id: `item-${i}` }));
  await refresh("owner", cards);
  assert.equal(reads, 4);
  await refresh("owner", cards);
  assert.equal(reads, 8);
  await refresh("owner", cards);
  assert.equal(reads, 12);
});
