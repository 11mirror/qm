import assert from "node:assert/strict";
import { after, test } from "node:test";
import { testMap } from "../support/test-database.ts";
import { createPostgresErrorLog } from "../../src/admin/postgres-error-log.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import {
  fixture,
  slackServer,
  slackUrl,
  featureFlags,
  createInboxSourceRefresh,
  tokens,
  json,
  ALEX,
  directoryOf,
  directory,
  slackFetch,
} from "../support/inbox-refresh.ts";
await new Promise<void>((resolve) => slackServer.listen(0, "127.0.0.1", resolve));
after(() => slackServer.close());

test("Slack avatars come from the org directory without the owner's Slack login or conversation reads", async () => {
  const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0", userId: "U1" });
  const looked: string[] = [];
  const refresh = createInboxSourceRefresh({
    featureFlags,
    items,
    tokens: { connectorAccessToken: async () => null },
    directory: directoryOf({ U1: { displayName: "Alex", avatarUrl: ALEX } }, (id) => looked.push(id)),
    slackApiUrl: slackUrl(async () => assert.fail("no Slack reads")),
  });
  await refresh("owner", [item], "avatars");
  const after = (await items.get(item.id))!;
  assert.deepEqual(after.sourcePayload?.participants, [{ id: "U1", name: "Alex", avatarUrl: ALEX }]);
  assert.equal(after.inboxPreview?.participants, undefined);
  assert.deepEqual(after.proposal, item.proposal);
  assert.deepEqual(after.sourcePayload?.context, item.sourcePayload?.context);
  await refresh("owner", [after], "avatars");
  assert.deepEqual(looked, ["U1"]);
});

test("missing or unsafe directory photos retain initials", async () => {
  for (const avatarUrl of [undefined, "http://example.com/photo.png", "javascript:alert(1)"]) {
    const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0", userId: "U1" });
    await createInboxSourceRefresh({
      featureFlags,
      items,
      tokens,
      directory: directoryOf({ U1: { displayName: "Alex", ...(avatarUrl ? { avatarUrl } : {}) } }),
    })("owner", [item], "avatars");
    assert.deepEqual((await items.get(item.id))!.sourcePayload!.participants, [{ id: "U1", name: "Alex" }]);
  }
});

test("avatar-only refresh does not suppress full Slack context refresh", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0", userId: "U1" });
  const refresh = createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    slackApiUrl: slackUrl(slackFetch([])),
  });
  await refresh("owner", [item], "avatars");
  await refresh("owner", [(await items.get(item.id))!]);
  const after = (await items.get(item.id))!;
  assert.equal(after.sourcePayload?.sourceContextFetched, true);
  assert.equal((after.sourcePayload!.context as Array<{ authorId: string }>)[0]!.authorId, "U1");
  assert.equal((after.sourcePayload!.context as Array<{ avatarUrl: string }>)[0]!.avatarUrl, ALEX);
  assert.equal(after.inboxPreview?.participants, undefined);
});

test("a newer message during an avatar lookup cannot acquire the previous sender's photo", async () => {
  const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0", userId: "U1" });
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory: directoryOf({ U1: { displayName: "Alex", avatarUrl: ALEX } }, () =>
      items.ingest([
        {
          cronId: "inbox",
          dedupeKey: "ask",
          source: "slack",
          sourceAt: 2000,
          sourcePayload: { slack: { channelId: "D1", ts: "2.0", userId: "U2" } },
        },
      ]),
    ),
  })("owner", [item], "avatars");
  assert.equal((await items.get(item.id))!.sourcePayload?.participants, undefined);
});

test("concurrent list and detail refreshes preserve the authoritative Slack thread metadata", async () => {
  const { items, item } = await fixture("slack", { channelId: "C_GROUP_DM", ts: "1.0", userId: "U1" });
  const refresh = createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    slackApiUrl: slackUrl(slackFetch([], { direct: true })),
  });
  await Promise.all([refresh("owner", [item]), refresh("owner", [item], "avatars")]);
  const after = (await items.get(item.id))!;
  assert.equal((after.sourcePayload!.slack as { isDirectMessage: boolean }).isDirectMessage, true);
  assert.equal(after.sourcePayload!.sourceContextFetched, true);
});

test("partial profile failures keep saved photos and names while saving successful lookups", async () => {
  const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0", userId: "U1" });
  const saved = { id: "U2", name: "Taylor", avatarUrl: "https://avatars.slack-edge.com/taylor.png" };
  await items.annotate(item.id, { participants: [{ id: "U1", name: "Alex" }, saved] });
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory: directoryOf({ U1: { displayName: "Alex", avatarUrl: ALEX } }, (id) => {
      if (id === "U2") throw new Error("directory unavailable");
    }),
    now: () => 1000,
  })("owner", [(await items.get(item.id))!], "avatars");
  const after = (await items.get(item.id))!;
  assert.deepEqual(after.sourcePayload!.participants, [{ id: "U1", name: "Alex", avatarUrl: ALEX }, saved]);
  assert.equal(after.sourcePayload!.slackAvatarsRefreshAt, 61_000);
  assert.deepEqual(after.proposal, item.proposal);
  const looked: string[] = [];
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory: directoryOf({ U2: { displayName: "Taylor" } }, (id) => looked.push(id)),
    now: () => 62_000,
  })("owner", [after], "avatars");
  assert.deepEqual(looked, ["U1", "U2"]);
});

test("opening a thread retains cached photos and author names when profile reads fail", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0", userId: "U1" });
  const saved = { id: "U1", name: "Alex", avatarUrl: ALEX };
  await items.annotate(item.id, { participants: [saved], slackAvatarsRefreshAt: 99_000_000 });
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory: directoryOf({}, () => {
      throw new Error("directory unavailable");
    }),
    now: () => 1000,
    slackApiUrl: slackUrl(slackFetch([])),
  })("owner", [(await items.get(item.id))!]);
  const after = (await items.get(item.id))!;
  assert.deepEqual(after.sourcePayload!.participants, [saved]);
  assert.equal(after.sourcePayload!.slackAvatarsRefreshAt, 61_000);
  for (const message of after.sourcePayload!.context as Array<Record<string, unknown>>) {
    assert.equal(message.author, "Alex");
    assert.equal(message.authorId, "U1");
    assert.equal(message.avatarUrl, saved.avatarUrl);
  }
});

test("thread profile limits prioritize the waiting sender and latest visible authors", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0", userId: "U1" });
  const lookedUp: string[] = [];
  const people = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      `U${i + 1}`,
      { displayName: `U${i + 1}`, avatarUrl: `https://avatars.slack-edge.com/U${i + 1}.png` },
    ]),
  );
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory: directoryOf(people, (id) => lookedUp.push(id)),
    slackApiUrl: slackUrl(async (url) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("conversations.info")) return json({ ok: true, channel: {} });
      if (u.pathname.endsWith("auth.test")) return json({ ok: true, user_id: "OWNER" });
      return json({
        ok: true,
        messages: Array.from({ length: 12 }, (_, i) => ({
          ts: `${i + 1}.0`,
          thread_ts: "1.0",
          user: `U${i + 1}`,
          text: "Message",
        })),
      });
    }),
  })("owner", [item]);
  assert.deepEqual(lookedUp, ["U1", "U12", "U11", "U10", "U9", "U8", "U7", "U6"]);
  const after = (await items.get(item.id))!;
  assert.equal((after.sourcePayload!.participants as Array<{ id: string }>)[0]!.id, "U1");
  const latest = (after.sourcePayload!.context as Array<{ avatarUrl?: string }>).slice(-6);
  assert.ok(latest.every((message) => message.avatarUrl));
});

test("bot and external-user messages use profiles already returned by Slack", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0" });
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    slackApiUrl: slackUrl(async (url) => {
      const path = new URL(String(url)).pathname;
      assert.ok(!path.endsWith("users.info") && !path.endsWith("bots.info"));
      if (path.endsWith("conversations.info")) return json({ ok: true, channel: {} });
      if (path.endsWith("auth.test")) return json({ ok: true, user_id: "OWNER" });
      return json({
        ok: true,
        messages: [
          {
            ts: "1.0",
            bot_id: "B1",
            bot_profile: { name: "Build bot", icons: { image_48: "https://avatars.slack-edge.com/build.png" } },
            text: "Build finished",
          },
        ],
      });
    }),
  })("owner", [item]);
  const after = (await items.get(item.id))!;
  assert.deepEqual(after.sourcePayload!.participants, [
    { id: "bot:B1", name: "Build bot", avatarUrl: "https://avatars.slack-edge.com/build.png" },
  ]);
  const message = (after.sourcePayload!.context as Array<Record<string, unknown>>)[0]!;
  assert.equal(message.author, "Build bot");
  assert.equal(message.authorId, "bot:B1");
  assert.equal(message.avatarUrl, "https://avatars.slack-edge.com/build.png");
});

test("a partial source page cannot replace the waiting sender with an unrelated author", async () => {
  for (const userId of [undefined, "U1"]) {
    const { items, item } = await fixture("slack", { channelId: "D1", ts: "0.5", ...(userId ? { userId } : {}) });
    await items.annotate(item.id, {
      participants: [{ id: "U1", name: "Alex", avatarUrl: "https://avatars.slack-edge.com/alex.png" }],
    });
    const sourceFetch = slackFetch([], { direct: true });
    const fetchImpl: typeof fetch = async (url, init) => {
      const response = await sourceFetch(url, init);
      if (!String(url).includes("conversations.history")) return response;
      return json({ ok: true, messages: [{ ts: "2.0", user: "U_OTHER", text: "Newer message" }] });
    };
    await createInboxSourceRefresh({ featureFlags, items, tokens, directory, slackApiUrl: slackUrl(fetchImpl) })(
      "owner",
      [(await items.get(item.id))!],
    );
    assert.equal(((await items.get(item.id))!.sourcePayload!.participants as Array<{ id: string }>)[0]!.id, "U1");
  }
});

test("cosmetic avatar refresh never waits for an in-flight full conversation refresh", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0", userId: "U1" });
  let begin!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sourceFetch = slackFetch([]);
  const refresh = createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    slackApiUrl: slackUrl(async (url, init) => {
      if (String(url).includes("conversations.info")) {
        begin();
        await blocked;
      }
      return sourceFetch(url, init);
    }),
  });
  const source = refresh("owner", [item]);
  await started;
  try {
    const finished = await Promise.race([
      refresh("owner", [item], "avatars").then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(finished, true);
  } finally {
    release();
    await source;
  }
  assert.equal((await items.get(item.id))!.sourcePayload!.sourceContextFetched, true);
});

test("a second core's full refresh wins over a stale cosmetic profile refresh", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0", userId: "U1" });
  let begin!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const avatars = createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory: directoryOf(
      { U1: { displayName: "Stale", avatarUrl: "https://avatars.slack-edge.com/stale.png" } },
      () => {
        begin();
        return blocked;
      },
    ),
  })("owner", [item], "avatars");
  await started;
  const sourceFetch = slackFetch([], { own: true });
  try {
    await createInboxSourceRefresh({
      featureFlags,
      items,
      tokens,
      directory,
      slackApiUrl: slackUrl(async (url, init) => {
        if (String(url).includes("auth.test")) return json({ ok: true, user_id: "OWNER" });
        return sourceFetch(url, init);
      }),
    })("owner", [item]);
  } finally {
    release();
    await avatars;
  }
  const after = (await items.get(item.id))!;
  assert.deepEqual(after.sourcePayload!.participants, [
    { id: "U1", name: "Alex", avatarUrl: ALEX },
    { id: "U2", name: "Taylor" },
  ]);
  assert.equal(after.sourcePayload!.sourceContextFetched, true);
  assert.equal((after.sourcePayload!.context as unknown[]).length, 2);
});

test("unverified waiting senders never inherit another context author's avatar", async () => {
  const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0" });
  const people = directoryOf({
    U_OTHER: { displayName: "Someone Else", avatarUrl: "https://avatars.slack-edge.com/other.png" },
  });
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory: people,
    slackApiUrl: slackUrl(async (url) => {
      if (String(url).includes("conversations.info")) return json({ ok: true, channel: { is_im: true } });
      if (String(url).includes("auth.test")) return json({ ok: true, user_id: "OWNER" });
      return json({ ok: true, messages: [{ ts: "2.0", user: "U_OTHER", text: "Another message" }] });
    }),
  })("owner", [item]);
  const after = (await items.get(item.id))!;
  assert.deepEqual(after.sourcePayload!.participants, []);
  assert.equal(after.sourcePayload!.slackAvatarsRefreshAt, 0);
  assert.equal(
    (after.sourcePayload!.context as Array<{ avatarUrl: string }>)[0]!.avatarUrl,
    "https://avatars.slack-edge.com/other.png",
  );
});

test("saved participants do not supply a missing sender identity", async () => {
  for (const mode of [undefined, "avatars"] as const) {
    const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0" });
    const saved = { id: "U1", name: "Previously saved sender" };
    await items.annotate(item.id, { participants: [saved] });
    const before = (await items.get(item.id))!;
    const looked: string[] = [];
    await createInboxSourceRefresh({
      featureFlags,
      items,
      tokens,
      directory: directoryOf({ U1: { displayName: "Alex", avatarUrl: ALEX } }, (id) => looked.push(id)),
      slackApiUrl: slackUrl(async (url) => {
        assert.notEqual(mode, "avatars");
        if (String(url).includes("conversations.info")) return json({ ok: true, channel: { is_im: true } });
        return json({ ok: true, messages: [] });
      }),
    })("owner", [before], mode);
    const after = (await items.get(item.id))!;
    assert.deepEqual(looked, []);
    assert.deepEqual(after.sourcePayload!.participants, [saved]);
    if (mode === "avatars") assert.deepEqual(after, before);
    else assert.equal(after.sourcePayload!.slackAvatarsRefreshAt, 0);
  }
});

test("profile failures retain diagnostics without exposing credentials", async () => {
  for (const mode of [undefined, "avatars"] as const) {
    const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0", userId: "U1" });
    const errors = createPostgresErrorLog(testDatabaseUrl());
    await createInboxSourceRefresh({
      featureFlags,
      items,
      tokens,
      directory: directoryOf({}, () => {
        throw new Error("lookup failed token=xoxb-private-credential");
      }),
      errors,
      slackApiUrl: slackUrl(slackFetch([])),
    })("owner", [item], mode);
    const events = await errors.list();
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.scopeLabel === "personal:owner"));
    assert.match(events[0]!.message, /Slack profile U1: lookup failed/);
    assert.doesNotMatch(JSON.stringify(events), /private-credential/);
    assert.equal((await items.get(item.id))!.status, "ready");
  }
});

test("cosmetic refresh records ledger failures without rejecting the inbox request", async () => {
  const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0", userId: "U1" });
  const errors = createPostgresErrorLog(testDatabaseUrl());
  await createInboxSourceRefresh({
    featureFlags,
    items: {
      ...items,
      annotate: async () => {
        throw new Error("database unavailable");
      },
    },
    tokens,
    directory,
    errors,
    slackApiUrl: slackUrl(async () => json({ ok: true, user: { name: "Alex" } })),
  })("owner", [item], "avatars");
  const events = await errors.list();
  assert.equal(events.length, 1);
  assert.match(events[0]!.message, new RegExp(item.id));
  assert.match(events[0]!.message, /database unavailable/);
  assert.equal(events[0]!.scopeLabel, "personal:owner");
});

test("Inbox source refresh checks the owner rollout before credentials, reads, or writes in either mode", async () => {
  const { createFeatureFlagStore } = await import("../../src/feature-flags.ts");
  const flags = createFeatureFlagStore(testMap());
  await flags.setEnabled("inbox_loops", "personal:someone-else", true, "admin");
  for (const mode of [undefined, "avatars"] as const) {
    const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0", userId: "U1" });
    const before = structuredClone(item);
    const calls: string[] = [];
    let credentials = 0;
    const refresh = createInboxSourceRefresh({
      items,
      featureFlags: flags,
      tokens: {
        connectorAccessToken: async () => {
          credentials++;
          return "synthetic-token";
        },
      },
      directory,
      slackApiUrl: slackUrl(slackFetch(calls)),
    });
    await refresh("owner", [item], mode);
    assert.equal(credentials, 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(await items.get(item.id), before);
    await flags.setEnabled("inbox_loops", "personal:owner", true, "admin");
    await refresh("owner", [item], mode);
    assert.equal(credentials > 0 && calls.length > 0, mode === undefined);
    const enriched = (await items.get(item.id))!;
    assert.ok(enriched.sourcePayload?.participants);
    await flags.setEnabled("inbox_loops", "personal:owner", false, "admin");
    credentials = 0;
    calls.length = 0;
    await refresh("owner", [{ ...enriched, sourceAt: 3000 }], mode);
    assert.equal(credentials, 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(await items.get(item.id), enriched);
  }
});

test("Slack-id principals and items without a known sender use only the directory", async () => {
  const { items, item } = await fixture("slack", { channelId: "D1", ts: "1.0", userId: "U1" });
  const fetchImpl: typeof fetch = async () => assert.fail("no Slack reads");
  const slackIdMode = {
    getBySlackId: async (id: string) =>
      id === "U1" ? { principalId: "U1", displayName: "Alex", type: "internal" as const, avatarUrl: ALEX } : null,
  };
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory: slackIdMode,
    slackApiUrl: slackUrl(fetchImpl),
  })("owner", [item], "avatars");
  assert.deepEqual((await items.get(item.id))!.sourcePayload!.participants, [
    { id: "U1", name: "Alex", avatarUrl: ALEX },
  ]);
  const legacy = await fixture("slack", { channelId: "D2", ts: "1.0" });
  await createInboxSourceRefresh({
    featureFlags,
    items: legacy.items,
    tokens,
    directory,
    slackApiUrl: slackUrl(fetchImpl),
  })("owner", [legacy.item], "avatars");
  assert.deepEqual(await legacy.items.get(legacy.item.id), legacy.item);
});

test("people outside the directory keep the profile Slack returned with their message", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0" });
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    slackApiUrl: slackUrl(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("conversations.info")) return json({ ok: true, channel: {} });
      if (path.endsWith("auth.test")) return json({ ok: true, user_id: "OWNER" });
      return json({
        ok: true,
        messages: [
          {
            ts: "1.0",
            user: "U_EXT",
            user_profile: { display_name: "Pat Partner", image_72: "https://avatars.slack-edge.com/pat.png" },
            text: "Hello from Slack Connect",
          },
        ],
      });
    }),
  })("owner", [item]);
  const after = (await items.get(item.id))!;
  assert.deepEqual(after.sourcePayload!.participants, [
    { id: "U_EXT", name: "Pat Partner", avatarUrl: "https://avatars.slack-edge.com/pat.png" },
  ]);
  assert.equal((after.sourcePayload!.context as Array<{ author: string }>)[0]!.author, "Pat Partner");
});

test("people outside the directory without message profiles keep initials and never trigger profile API calls", async () => {
  const { items, item } = await fixture("slack", { channelId: "C1", ts: "1.0", userId: "U_EXT" });
  await createInboxSourceRefresh({
    featureFlags,
    items,
    tokens,
    directory,
    slackApiUrl: slackUrl(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("conversations.info")) return json({ ok: true, channel: {} });
      if (path.endsWith("auth.test")) return json({ ok: true, user_id: "OWNER" });
      assert.ok(path.endsWith("conversations.replies"));
      return json({ ok: true, messages: [{ ts: "1.0", user: "U_EXT", text: "Hello" }] });
    }),
  })("owner", [item]);
  assert.deepEqual((await items.get(item.id))!.sourcePayload!.participants, [{ id: "U_EXT", name: "U_EXT" }]);
});
