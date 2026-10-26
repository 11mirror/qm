import { test } from "node:test";
import assert from "node:assert/strict";
import { createSlackHistoryReader } from "../src/slack/history.ts";
import { createSurfaceToolDeps, type SurfaceToolsContext } from "../src/core/orchestrator/surface-tools.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";
import type { ReadMessagesOpts } from "../src/surface-cache/types.ts";
import type { BotIdentity } from "../src/slack/directory.ts";
import { createPostgresSurfaceCache } from "../src/surface-cache/surface-cache.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const ids = { botUserId: "UBOT", ownBotId: "BBOT" } as BotIdentity;

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
