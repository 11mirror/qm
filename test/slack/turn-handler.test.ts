import assert from "node:assert/strict";
import { test } from "node:test";
import { createTurnHandler } from "../../src/slack/turn-handler.ts";
import { createConversationSerializer } from "../../src/slack/conversation-view.ts";
import { createThreadTracker, createDeduper } from "../../src/slack/message-gating.ts";
import type { BotIdentity, Directory } from "../../src/slack/directory.ts";

test("Slack Stop cancels the durable conversation tree even when the coordinator is idle", async () => {
  const stopped: string[] = [];
  const handler = createTurnHandler({
    core: {
      taskAcknowledgements: {},
      stopConversation: async (ref: string) => {
        stopped.push(ref);
        return true;
      },
    },
    flow: {
      callCore: async () => assert.fail("Stop must not submit another turn"),
    },
    directory: {},
    mirror: {},
    ids: { botUserId: "BOT" },
  } as unknown as Parameters<typeof createTurnHandler>[0]);
  await handler.handleIncoming(
    { kind: "dm", channel: "D1", userId: "U1", actor: { externalId: "U1" }, rawText: "stop", files: [], ts: "10.0" },
    {},
  );
  assert.deepEqual(stopped, ["dm:D1"]);
});

const ids = { botUserId: "UBOT", ownBotId: "BBOT", botHandle: "qm" } as BotIdentity;
const actor = { externalId: "U1", displayName: "Teammate" };
const directory = {
  classifyUserCached: async () => ({ actor }),
} as unknown as Directory;

function harness(run: (hooks: any) => Promise<unknown>) {
  const reactions: string[] = [];
  const posts: string[] = [];
  const postArgs: Array<Record<string, unknown>> = [];
  const turns: any[] = [];
  const client = {
    reactions: {
      add: async ({ name, timestamp }: { name: string; timestamp: string }) => {
        reactions.push(`+${name}@${timestamp}`);
      },
      remove: async ({ name, timestamp }: { name: string; timestamp: string }) => {
        reactions.push(`-${name}@${timestamp}`);
      },
    },
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        posts.push(args.text as string);
        postArgs.push(args);
        return { ts: `9${posts.length}.0` };
      },
      update: async () => ({}),
      delete: async () => ({}),
    },
  };
  const handler = createTurnHandler({
    core: {
      stageBlob: async () => ({ blobId: "b", sizeBytes: 0 }),
      reportRunEditRef: async () => {},
    },
    flow: {
      inFlightRuns: { add() {}, delete() {}, has: () => false },
      ackRunDelivery() {},
      callCore: async (turn: any, hooks: any) => {
        turns.push(turn);
        return run(hooks);
      },
    },
    directory,
    mirror: { mirrorMessageEvent: async () => {} },
    serializer: createConversationSerializer({
      ids,
      directory,
      externalParticipantsEnabled: async () => false,
      readHistory: async () => {
        throw new Error("history unavailable");
      },
    }),
    ackEmoji: {
      refreshAckEmoji() {},
      ackPickCandidates: () => [],
      requestAckEmoji: async () => undefined,
    },
    ackEmojiCandidates: () => ["eyes"],
    ids,
    threads: createThreadTracker(),
    deduper: createDeduper(),
    externalParticipantsEnabled: async () => false,
  } as unknown as Parameters<typeof createTurnHandler>[0]);
  const followup = {
    kind: "channel" as const,
    channel: "C1",
    userId: "U1",
    rawText: "can you also check staging?",
    files: [],
    threadTs: "1.000",
    ts: "2.000",
    unprompted: true,
    prefetched: { actor, info: { id: "C1", name: "eng" } as any, audience: [actor] },
  };
  return { handler, client, followup, reactions, posts, postArgs, turns };
}

test("an unmentioned thread followup QM answers gets the ack reaction added then cleared", async () => {
  const h = harness(async (hooks) => {
    hooks.onReplying?.();
    await new Promise((r) => setTimeout(r, 2_200));
    return { status: "ok", reply: "Staging is green." };
  });
  await h.handler.handleIncoming(h.followup, h.client);
  assert.equal(h.turns[0].origin.kind, "ambient");
  assert.deepEqual(h.reactions, ["+eyes@2.000", "-eyes@2.000"]);
  assert.deepEqual(h.posts, ["Staging is green."]);
});

test("an answered followup's ack clears as soon as QM posts into the thread", async () => {
  const h = harness(async (hooks) => {
    hooks.onReplying?.();
    await new Promise((r) => setTimeout(r, 2_200));
    hooks.onSurfacePosted?.();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(h.reactions, ["+eyes@2.000", "-eyes@2.000"]);
    return { status: "ok", reply: "" };
  });
  await h.handler.handleIncoming(h.followup, h.client);
  assert.deepEqual(h.reactions, ["+eyes@2.000", "-eyes@2.000"]);
});

test("an answered followup whose reply post fails still clears its ack", async () => {
  const h = harness(async (hooks) => {
    await hooks.onQueued?.("r1");
    hooks.onReplying?.();
    await new Promise((r) => setTimeout(r, 2_200));
    return { status: "ok", reply: "Staging is green." };
  });
  h.client.chat.postMessage = async () => {
    throw new Error("slack 500");
  };
  await h.handler.handleIncoming(h.followup, h.client);
  assert.deepEqual(h.reactions, ["+eyes@2.000", "-eyes@2.000"]);
});

test("synthetic reaction turns never receive ack hooks", async () => {
  let hooksSeen: string[] = [];
  const h = harness(async (hooks) => {
    hooksSeen = Object.keys(hooks).filter((k) => k.startsWith("on") && typeof hooks[k] === "function");
    return { status: "silent" };
  });
  await h.handler.handleIncoming({ ...h.followup, synthetic: true }, h.client);
  assert.ok(!hooksSeen.includes("onReplying"));
  assert.ok(!hooksSeen.includes("onFirstBlock"));
  assert.deepEqual(h.reactions, []);
});

for (const outcome of [{ status: "silent" }, { status: "react", reactions: ["thumbsup"] }] as const) {
  test(`an unmentioned followup QM declines (${outcome.status}) gets no ack reaction`, async () => {
    const h = harness(async () => {
      await new Promise((r) => setTimeout(r, 2_200));
      return outcome;
    });
    await h.handler.handleIncoming(h.followup, h.client);
    assert.deepEqual(h.reactions, outcome.status === "react" ? ["+thumbsup@2.000"] : []);
    assert.deepEqual(h.posts, []);
  });
}

test("waitRun signals replying only once the run has passed detection and begun its reply", async () => {
  const { createSlackCoreClient } = await import("../../src/api/slack-core-client.ts");
  let polls = 0;
  let replying = 0;
  const client = createSlackCoreClient({
    runs: { onTerminal() {} },
    app: {
      subscribeRun: () => () => {},
      getRun: async () => {
        polls++;
        return {
          status: polls >= 4 ? "done" : "running",
          attempt: 1,
          result: polls >= 4 ? { status: "ok", reply: "done" } : null,
          ...(polls >= 2 ? { replying: true } : {}),
        };
      },
    },
  } as any);
  await client.waitRun("r1", {
    onReplying: () => {
      assert.ok(polls >= 2, "not before the reply begins");
      replying++;
    },
  });
  assert.equal(replying, 1);
});

test("a mention-only thread reply starts a turn with the tag intact", async () => {
  const h = harness(async () => ({ status: "ok", reply: "On it." }));
  await h.handler.handleIncoming({ ...h.followup, unprompted: false, rawText: "<@UBOT>" }, h.client);
  assert.equal(h.turns.length, 1);
  assert.equal(h.turns[0].text, "@qm");
  assert.deepEqual(h.posts, ["On it."]);
});

test("the bot's own mention reaches the agent instead of being stripped", async () => {
  const h = harness(async () => ({ status: "ok", reply: "Done." }));
  await h.handler.handleIncoming({ ...h.followup, unprompted: false, rawText: "<@UBOT> check &amp; report" }, h.client);
  assert.equal(h.turns[0].text, "@qm check & report");
});
