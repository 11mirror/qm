import { test } from "node:test";
import assert from "node:assert/strict";
import { createSlackHistoryReader } from "../../src/slack/history.ts";
import { createSlackCoreClient, type SlackCoreClient } from "../../src/api/slack-core-client.ts";
import type { BotIdentity } from "../../src/slack/directory.ts";
import { registerSlackEvents } from "../../src/slack/events.ts";
import { createDeduper } from "../../src/slack/message-gating.ts";
import { createPostgresSurfaceCache } from "../../src/surface-cache/surface-cache.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { createSurfaceToolDeps, type SurfaceToolsContext } from "../../src/core/orchestrator/surface-tools.ts";
import type { ReadMessagesOpts } from "../../src/surface-cache/types.ts";

const ids = { botUserId: "UBOT", ownBotId: "BBOT" } as BotIdentity;

function fixture(fail?: Error) {
  const cache = createPostgresSurfaceCache(testDatabaseUrl());
  const notes: string[] = [];
  const core = {
    noteSurfaceHistoryGap: async (container: string, note: string) => {
      notes.push(`${container}:${note}`);
    },
    readSurfaceMessages: cache.readMessages,
    rememberSurfaceHistory: async (events) => {
      await cache.ingest(events);
    },
  } as SlackCoreClient;
  const calls: string[] = [];
  const historyClient = {
    conversations: {
      history: async (args: any) => {
        calls.push(`history:${args.latest ?? ""}:${args.limit}`);
        if (fail) throw fail;
        return {
          messages: [
            { ts: "20.000000", text: "root", user: "U1", thread_ts: "20.000000", reply_count: 1 },
            { ts: "10.000000", text: "earlier plan", user: "U2" },
          ],
        };
      },
      replies: async (args: any) => {
        calls.push(`replies:${args.ts}:${args.limit}`);
        if (fail) throw fail;
        return {
          messages: [
            { ts: "20.000000", text: "root", user: "U1", thread_ts: "20.000000" },
            { ts: "21.000000", text: "what did we decide above?", user: "U1", thread_ts: "20.000000" },
          ],
        };
      },
    },
  };
  const readHistory = createSlackHistoryReader({ core, ids, historyClient });
  return { cache, calls, notes, readHistory };
}

async function joinedLate(cache: ReturnType<typeof createPostgresSurfaceCache>) {
  await cache.ingest([
    { container: "C1", ts: "20.000000", text: "root", authorId: "U1" },
    { container: "C1", ts: "21.000000", sub: "20.000000", text: "what did we decide above?", authorId: "U1" },
  ]);
}

test("a late-joined thread backfills its last 15 replies once", async () => {
  const { cache, calls, readHistory } = fixture();
  await joinedLate(cache);
  const thread = await readHistory({}, "C1", "20.000000", undefined, true);
  assert.deepEqual(thread.raw.map((m) => m.ts).sort(), ["20.000000", "21.000000"]);
  assert.deepEqual(calls, ["replies:20.000000:15"]);
  await readHistory({}, "C1", "20.000000", undefined, true);
  assert.equal(calls.length, 1);
  const channel = await readHistory({}, "C1");
  assert.ok(channel.raw.some((m) => m.text === "earlier plan"));
  await readHistory({}, "C1");
  assert.deepEqual(calls, ["replies:20.000000:15", "history::15"]);
});

test("a failed backfill is not retried and falls back to the mirror", async () => {
  const limited = Object.assign(new Error("rate limited"), {
    code: "slack_webapi_rate_limited_error",
    retryAfter: 30,
  });
  const { cache, calls, readHistory } = fixture(limited);
  await joinedLate(cache);
  const first = await readHistory({}, "C1", "20.000000", undefined, true);
  assert.deepEqual(first.raw.map((m) => m.ts).sort(), ["20.000000", "21.000000"]);
  assert.deepEqual(calls, ["replies:20.000000:15"]);
  const again = await readHistory({}, "C1", "20.000000", undefined, true);
  assert.deepEqual(again.raw.map((m) => m.ts).sort(), ["20.000000", "21.000000"]);
  assert.equal(calls.length, 1);
});

test("a thread read before its root is mirrored still fetches only once", async () => {
  const { cache, calls, readHistory } = fixture(new Error("unavailable"));
  await cache.ingest([
    { container: "C1", ts: "21.000000", sub: "20.000000", text: "what did we decide above?", authorId: "U1" },
  ]);
  await readHistory({}, "C1", "20.000000");
  const again = await readHistory({}, "C1", "20.000000");
  assert.deepEqual(
    again.raw.map((m) => m.ts),
    ["21.000000"],
  );
  assert.deepEqual(calls, ["replies:20.000000:200"]);
});

test("an older-page read does not use up the latest-page backfill", async () => {
  const { cache, calls, readHistory } = fixture();
  await joinedLate(cache);
  await readHistory({}, "C1", undefined, "15.000000");
  await readHistory({}, "C1");
  assert.deepEqual(calls, ["history:15.000000:200", "history::15"]);
});

test("a rate-limited backfill notes the gap in the channel's memory once", async () => {
  const limited = Object.assign(new Error("rate limited"), { code: "slack_webapi_rate_limited_error" });
  const { cache, notes, readHistory } = fixture(limited);
  await joinedLate(cache);
  await readHistory({}, "C1", "20.000000", undefined, true);
  await readHistory({}, "C1", "20.000000", undefined, true);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /^C1:Slack rate-limited the initial history pull/);
});

test("a non-rate-limit backfill failure writes no memory note", async () => {
  const { cache, notes, readHistory } = fixture(new Error("boom"));
  await joinedLate(cache);
  await readHistory({}, "C1", "20.000000", undefined, true);
  assert.deepEqual(notes, []);
});

test("the history gap note lands in the conversation's own scope memory", async () => {
  const cache = createPostgresSurfaceCache(testDatabaseUrl());
  await cache.ingest([
    { container: "C1", ts: "1.000000", text: "hi", authorId: "U1", kind: "channel" },
    { container: "G1", ts: "1.000000", text: "hi", authorId: "U1", kind: "group" },
  ]);
  const captured: string[] = [];
  const client = createSlackCoreClient({
    surfaceCache: cache,
    memory: {
      capture: async (scope: string, facts: string[]) => {
        captured.push(`${scope}=${facts.join()}`);
        return facts.length;
      },
    },
    runs: { onTerminal() {} },
  } as any);
  await client.noteSurfaceHistoryGap!("C1", "gap");
  await client.noteSurfaceHistoryGap!("G1", "gap");
  assert.deepEqual(captured, ["channel:C1=gap", "group:G1=gap"]);
});

test("the bot joining a channel backfills it once, and a failed pull never blocks the join", async () => {
  const events = new Map<string, (args: any) => Promise<void>>();
  const pulled: string[] = [];
  let synced = 0;
  registerSlackEvents({ event: (n: string, h: any) => void events.set(n, h), message: () => {} } as any, {
    handler: {} as any,
    mirror: {} as any,
    directory: {
      forceDirectorySync: async () => {
        synced++;
      },
    } as any,
    ids,
    deduper: createDeduper(),
    allowActor: () => true,
    backfillHistory: async (_client, channel) => {
      pulled.push(channel);
      if (channel === "C2") throw new Error("rate limited");
    },
  });
  const join = (channel: string, user: string) =>
    events.get("member_joined_channel")!({
      event: { channel, user, event_ts: `${channel}${user}` },
      body: {},
      client: {},
    });
  await join("C1", "UBOT");
  await join("C1", "U9");
  await join("C2", "UBOT");
  assert.deepEqual(pulled, ["C1", "C2"]);
  assert.equal(synced, 3);
});

const pagedIds: BotIdentity = {
  botUserId: "UBOT",
  ownBotId: "BBOT",
  ownTeamId: "T1",
  botHandle: "qm",
  ownWorkspaceUrl: "https://example.slack.com",
  identityMode: "slack-id",
};
const ts = (n: number) => `1000.${String(n).padStart(6, "0")}`;

for (const size of [199, 200, 201]) {
  test(`thread pagination includes parent in the ${size}-message boundary`, async () => {
    const cache = createPostgresSurfaceCache(testDatabaseUrl());
    await cache.ingest(
      Array.from({ length: size }, (_, i) => ({
        container: "C1",
        ts: ts(i),
        text: `message ${i}`,
        ...(i ? { sub: ts(0) } : {}),
      })),
    );
    const core = { readSurfaceMessages: cache.readMessages } as unknown as SlackCoreClient;
    const page = await createSlackHistoryReader({ core, ids: pagedIds })({}, "C1", ts(0));
    assert.deepEqual(
      page.raw.map((m) => m.ts),
      Array.from({ length: Math.min(size, 200) }, (_, i) => ts(i)),
    );
    assert.equal(page.hasMore, size > 200);
    await cache.close();
  });
}

test("before excludes future replies and a parent outside the requested window", async () => {
  const cache = createPostgresSurfaceCache(testDatabaseUrl());
  await cache.ingest(
    Array.from({ length: 205 }, (_, i) => ({
      container: "C1",
      ts: ts(i),
      text: "message",
      ...(i ? { sub: ts(0) } : {}),
    })),
  );
  const core = { readSurfaceMessages: cache.readMessages } as unknown as SlackCoreClient;
  const read = createSlackHistoryReader({ core, ids: pagedIds });
  const bounded = await read({}, "C1", ts(0), ts(199));
  assert.equal(bounded.raw.length, 199);
  assert.equal(bounded.raw.at(-1)?.ts, ts(198));
  assert.equal(bounded.hasMore, false);
  const empty = await read({ conversations: { replies: async () => ({ messages: [] }) } }, "C1", ts(0), ts(0));
  assert.deepEqual(empty.raw, []);
  await cache.close();
});

test("missing parent does not consume a reply slot when a bounded read permits mirror use", async () => {
  const cache = createPostgresSurfaceCache(testDatabaseUrl());
  await cache.ingest(
    Array.from({ length: 201 }, (_, i) => ({ container: "C1", ts: ts(i + 1), sub: ts(0), text: "reply" })),
  );
  const core = { readSurfaceMessages: cache.readMessages } as unknown as SlackCoreClient;
  const page = await createSlackHistoryReader({ core, ids: pagedIds })({}, "C1", ts(0), ts(999));
  assert.equal(page.raw.length, 200);
  assert.equal(page.raw[0]?.ts, ts(1));
  assert.equal(page.raw.at(-1)?.ts, ts(200));
  assert.equal(page.hasMore, true);
  await cache.close();
});

test("channel pagination counts roots before expanding a truncated thread", async () => {
  const cache = createPostgresSurfaceCache(testDatabaseUrl());
  await cache.ingest([{ container: "C1", ts: ts(0), text: "root" }]);
  await cache.ingest(
    Array.from({ length: 201 }, (_, i) => ({ container: "C1", ts: ts(i + 1), sub: ts(0), text: "reply" })),
  );
  const core = { readSurfaceMessages: cache.readMessages } as unknown as SlackCoreClient;
  const page = await createSlackHistoryReader({ core, ids: pagedIds })({}, "C1", undefined, undefined, true);
  assert.equal(page.raw.length, 200);
  assert.equal(page.hasMore, false);
  assert.equal(page.truncatedExpansions, 1);
  await cache.close();
});

test("channel overflow keeps newest roots, excludes deletions and preserves visible system entries", async () => {
  const cache = createPostgresSurfaceCache(testDatabaseUrl());
  await cache.ingest(
    Array.from({ length: 202 }, (_, i) => ({
      container: "C1",
      ts: ts(i),
      text: "root",
      ...(i === 2 ? { subtype: "channel_topic" } : {}),
    })),
  );
  await cache.ingest([{ container: "C1", ts: ts(201), deleted: true }]);
  const core = { readSurfaceMessages: cache.readMessages } as unknown as SlackCoreClient;
  const page = await createSlackHistoryReader({ core, ids: pagedIds })({}, "C1");
  assert.equal(page.hasMore, true);
  assert.deepEqual(
    page.raw.map((m) => m.ts),
    Array.from({ length: 200 }, (_, i) => ts(i + 1)),
  );
  assert.equal(page.raw[1]?.subtype, "channel_topic");
  await cache.close();
});

test("default context reads the stored mirror first and fills from Slack once per conversation", async () => {
  const calls: string[] = [];
  const core = {
    readSurfaceMessages: async () => [{ container: "C1", ts: "1", text: "stored" }],
    rememberSurfaceHistory: async () => {},
  } as unknown as SlackCoreClient;
  const client = {
    conversations: {
      history: async () => {
        calls.push("history");
        return { messages: [{ ts: "2", text: "live" }] };
      },
    },
  };
  const read = createSlackHistoryReader({ core, ids });
  const first = await read(client, "C1");
  assert.deepEqual(
    first.raw.map((m) => m.text),
    ["stored", "live"],
  );
  const second = await read(client, "C1");
  assert.deepEqual(
    second.raw.map((m) => m.text),
    ["stored"],
  );
  assert.deepEqual(calls, ["history"]);
});

test("default search reads stored Slack messages", async () => {
  let pulls = 0;
  const tools = createSurfaceToolDeps({
    deps: {
      outbound: {},
      surfaceCache: {
        containerState: async () => null,
        search: async () => [{ ts: "1.000000", text: "stored match" }],
      },
      surfaceContext: {
        pull: async () => {
          pulls++;
          return { messages: [{ ts: "1", text: "live match" }] };
        },
      },
    },
    input: { surface: "slack", surfaceTools: true },
    actor: { id: "U1" },
    conversation: { kind: "channel" },
    defaultDestination: { type: "slack", target: "C1:1" },
  } as unknown as SurfaceToolsContext)!;
  const result = await tools.search("match");
  assert.equal(result.source, "cache");
  assert.equal(result.hits?.[0]?.snippet, "stored match");
  assert.equal(pulls, 0);
});

test("mirror selects newest channel roots and the first thread page", async () => {
  const cache = createPostgresSurfaceCache(testDatabaseUrl());
  const ts = (n: number) => String(n).padStart(6, "0");
  await cache.ingest(Array.from({ length: 205 }, (_, i) => ({ container: "C1", ts: ts(i), text: "root" })));
  await cache.ingest(
    Array.from({ length: 250 }, (_, i) => ({ container: "C1", ts: ts(300 + i), sub: ts(204), text: "reply" })),
  );
  const read = createSlackHistoryReader({
    ids,
    core: { readSurfaceMessages: cache.readMessages } as unknown as SlackCoreClient,
  });
  const roots = await read({}, "C1");
  assert.equal(roots.raw.length, 200);
  assert.equal(roots.raw[0]?.ts, ts(5));
  assert.equal(roots.raw.at(-1)?.ts, ts(204));
  const thread = await read({}, "C1", ts(204));
  assert.equal(thread.raw.length, 200);
  assert.equal(thread.raw[0]?.ts, ts(204));
  assert.equal(thread.raw.at(-1)?.ts, ts(498));
  const expanded = await read({}, "C1", undefined, undefined, true);
  assert.equal(expanded.raw.length, 399);
  assert.equal(expanded.raw.at(-1)?.ts, ts(498));
});

test("mirror uses the live first-page thread contract without fallback", async () => {
  const cache = createPostgresSurfaceCache(testDatabaseUrl());
  const messages = Array.from({ length: 220 }, (_, index) => ({
    ts: `1000.${String(index).padStart(6, "0")}`,
    text: `message-${index}`,
    ...(index ? { thread_ts: "1000.000000" } : {}),
  }));
  await cache.ingest(
    messages.map((message) => ({
      container: "C1",
      ts: message.ts,
      text: message.text,
      ...(message.thread_ts ? { sub: message.thread_ts } : {}),
    })),
  );
  const core = {
    readSurfaceMessages: async (container: string, opts?: ReadMessagesOpts) => {
      assert.equal(opts?.noFallback, true);
      return cache.readMessages(container, opts);
    },
    rememberSurfaceHistory: async () => {
      throw new Error("must not backfill");
    },
  } as unknown as SlackCoreClient;
  const client = { conversations: { replies: async () => ({ messages: messages.slice(0, 200), has_more: true }) } };
  const mirrored = await createSlackHistoryReader({ core, ids })(client, "C1", "1000.000000");
  assert.deepEqual(
    mirrored.raw.map((message) => message.ts),
    messages.slice(0, 200).map((message) => message.ts),
  );
  await cache.close();
});
