import { test } from "node:test";
import assert from "node:assert/strict";
import { tenantFor, withTenant } from "../../src/tenant.ts";
import {
  slackReplyArgs,
  botIdentityArgs,
  botIdentityFromEnv,
  setDefaultBotIdentity,
  encodeDeliveryTarget,
  parseDeliveryTarget,
  deliveryCandidatesFor,
  channelWelcomeMessage,
  scopeSurfaceUrl,
  onBotJoinedChannel,
} from "../../src/slack/delivery.ts";

test("slackReplyArgs keeps channel replies thread-only and never broadcasts them", () => {
  assert.deepEqual(slackReplyArgs("C1", "reply", "123.45", { threadOnly: true }), {
    channel: "C1",
    text: "reply",
    thread_ts: "123.45",
    reply_broadcast: false,
  });
  assert.deepEqual(slackReplyArgs("D1", "reply", "123.45"), {
    channel: "D1",
    text: "reply",
    thread_ts: "123.45",
  });
});

test("botIdentityFromEnv reads the display-name/icon knobs and trims them", () => {
  assert.deepEqual(botIdentityFromEnv({} as NodeJS.ProcessEnv), {});
  assert.deepEqual(
    botIdentityFromEnv({ SLACK_BOT_DISPLAY_NAME: "  agent · singapore-v2  " } as unknown as NodeJS.ProcessEnv),
    { username: "agent · singapore-v2" },
  );
  assert.deepEqual(
    botIdentityFromEnv({
      SLACK_BOT_DISPLAY_NAME: "agent · singapore-v2",
      SLACK_BOT_ICON_EMOJI: ":robot_face:",
    } as unknown as NodeJS.ProcessEnv),
    { username: "agent · singapore-v2", icon_emoji: ":robot_face:" },
  );
});

test("botIdentityArgs/slackReplyArgs stay a no-op without an env override", () => {
  assert.deepEqual(botIdentityArgs(), {});
  assert.deepEqual(slackReplyArgs("C1", "reply", undefined), {
    channel: "C1",
    text: "reply",
  });
});

test("each tenant posts under its own bot display identity", () => {
  const alpha = tenantFor("alpha", "00000000-0000-4000-8000-00000000000a");
  const beta = tenantFor("beta", "00000000-0000-4000-8000-00000000000b");
  withTenant(alpha, () => setDefaultBotIdentity({ username: "Alpha Bot", icon_emoji: ":a:" }));
  withTenant(beta, () => setDefaultBotIdentity({ username: "Beta Bot" }));
  assert.deepEqual(
    withTenant(alpha, () => slackReplyArgs("C1", "hi", undefined)),
    { channel: "C1", text: "hi", username: "Alpha Bot", icon_emoji: ":a:" },
  );
  assert.deepEqual(
    withTenant(beta, () => botIdentityArgs()),
    { username: "Beta Bot" },
  );
  assert.deepEqual(botIdentityArgs(), {});
});

test("slackReplyArgs can suppress Slack link and media unfurls per message", () => {
  assert.deepEqual(slackReplyArgs("C1", "see https://x.com/a/status/1", undefined, { unfurlLinks: false }), {
    channel: "C1",
    text: "see https://x.com/a/status/1",
    unfurl_links: false,
    unfurl_media: false,
  });
  assert.deepEqual(slackReplyArgs("C1", "see https://x.com/a/status/1", undefined), {
    channel: "C1",
    text: "see https://x.com/a/status/1",
  });
});

test("delivery target round-trips channel + thread, and channel-only when not threaded", () => {
  const threaded = encodeDeliveryTarget("C123", "1699999999.001200");
  assert.equal(threaded, "C123:1699999999.001200");
  assert.deepEqual(parseDeliveryTarget(threaded), { channel: "C123", threadTs: "1699999999.001200" });

  const root = encodeDeliveryTarget("D456");
  assert.equal(root, "D456");
  assert.deepEqual(parseDeliveryTarget(root), { channel: "D456" });
});

test("parseDeliveryTarget splits only on the first ':' and tolerates a bare channel", () => {
  assert.deepEqual(parseDeliveryTarget("C9:1.2"), { channel: "C9", threadTs: "1.2" });
  assert.deepEqual(parseDeliveryTarget("C9"), { channel: "C9" });
});

test("deliveryCandidatesFor: a channel offers this-thread (default) and the-whole-channel", () => {
  const cands = deliveryCandidatesFor("channel", "C123", "1699999999.001200", "eng");
  assert.ok(cands);
  assert.equal(cands.length, 2);
  assert.deepEqual(cands[0], { target: "C123:1699999999.001200", label: "this thread" });
  assert.equal(cands[1]!.target, "C123");
  assert.equal(cands[1]!.label, "#eng (the whole channel)");
  assert.deepEqual(parseDeliveryTarget(cands[1]!.target), { channel: "C123" });
  assert.notEqual(cands[0]!.target, cands[1]!.target);
});

test("deliveryCandidatesFor: a DM has a single destination → no menu", () => {
  assert.equal(deliveryCandidatesFor("dm", "D1", "1.2", undefined), undefined);
});

test("deliveryCandidatesFor: missing channel name falls back to a generic label", () => {
  const cands = deliveryCandidatesFor("channel", "C7", undefined, undefined);
  assert.ok(cands);
  assert.equal(cands[1]!.label, "the whole channel");
});

test("deliveryCandidatesFor: a group DM offers this-thread and group-DM destinations", () => {
  const cands = deliveryCandidatesFor("group", "G123", "1699999999.001200", undefined);
  assert.ok(cands);
  assert.deepEqual(cands[0], { target: "G123:1699999999.001200", label: "this thread" });
  assert.deepEqual(cands[1], { target: "G123", label: "the group DM" });
});

const WEB_BASE = "https://portal.example.com/web-ui";
const BOT = "UBOT";
function fakeJoinClient(
  opts: {
    postMessageFails?: boolean;
    extShared?: boolean;
  } = {},
) {
  const calls = {
    posted: [] as Array<{ channel: string; text: string }>,
  };
  return {
    calls,
    client: {
      chat: {
        postMessage: async (args: { channel: string; text: string }) => {
          if (opts.postMessageFails) {
            const err = new Error("ratelimited") as Error & { data?: unknown };
            err.data = { error: "ratelimited" };
            throw err;
          }
          calls.posted.push({ channel: args.channel, text: args.text });
          return {};
        },
      },
      conversations: {
        info: async (_args: { channel: string }) => ({
          channel: {
            is_ext_shared: Boolean(opts.extShared),
          },
        }),
      },
    },
  };
}

test("scopeSurfaceUrl builds the channel project deep link and degrades when unset", () => {
  assert.equal(scopeSurfaceUrl(WEB_BASE, "channel:C123"), `${WEB_BASE}/projects/channel/C123`);
  assert.equal(scopeSurfaceUrl(undefined, "channel:C1"), undefined);
  assert.equal(scopeSurfaceUrl("", "channel:C1"), undefined);
});

test("channelWelcomeMessage includes the link when present, omits it cleanly when not", () => {
  const url = scopeSurfaceUrl(WEB_BASE, "channel:C1")!;
  assert.ok(channelWelcomeMessage(url).includes(url));
  const linkless = channelWelcomeMessage(undefined);
  assert.ok(!linkless.includes("http"));
  assert.ok(linkless.length > 0);
});

test("onBotJoinedChannel: posts welcome with the deep link and asks the ensurer to pin the header", async () => {
  const { client, calls } = fakeJoinClient();
  let synced = 0;
  const ensured: string[] = [];
  await onBotJoinedChannel({
    client,
    channel: "C123",
    joinerUserId: BOT,
    botUserId: BOT,
    webUiPublicUrl: WEB_BASE,
    syncDirectory: async () => {
      synced++;
    },
    ensureHeader: (channel) => ensured.push(channel),
  });
  const expectedUrl = `${WEB_BASE}/projects/channel/C123`;
  assert.equal(calls.posted.length, 1);
  assert.equal(calls.posted[0]!.channel, "C123");
  assert.ok(calls.posted[0]!.text.includes(expectedUrl), "welcome message must contain the channel surface deep link");
  assert.deepEqual(ensured, ["C123"], "the pinned header is the ensurer's to post, not join's");
  assert.equal(synced, 1, "directory sync must run on bot join");
});

test("onBotJoinedChannel: ignores a human joining (only the bot itself triggers it)", async () => {
  const { client, calls } = fakeJoinClient();
  let synced = 0;
  await onBotJoinedChannel({
    client,
    channel: "C123",
    joinerUserId: "UHUMAN",
    botUserId: BOT,
    webUiPublicUrl: WEB_BASE,
    syncDirectory: async () => {
      synced++;
    },
  });
  assert.equal(calls.posted.length, 0);
  assert.equal(synced, 0);
});

test("onBotJoinedChannel: an ensureHeader failure is swallowed and never blocks the welcome or sync", async () => {
  const { client, calls } = fakeJoinClient();
  let synced = 0;
  await assert.doesNotReject(
    onBotJoinedChannel({
      client,
      channel: "C123",
      joinerUserId: BOT,
      botUserId: BOT,
      webUiPublicUrl: WEB_BASE,
      syncDirectory: async () => {
        synced++;
      },
      ensureHeader: () => {
        throw new Error("missing_scope");
      },
    }),
  );
  assert.equal(calls.posted.length, 1, "welcome still lands even when the header hook throws");
  assert.equal(synced, 1, "directory sync still runs after a swallowed header error");
});

test("onBotJoinedChannel: a welcome-post failure still runs the directory sync", async () => {
  const { client, calls } = fakeJoinClient({ postMessageFails: true });
  let synced = 0;
  await assert.doesNotReject(
    onBotJoinedChannel({
      client,
      channel: "C123",
      joinerUserId: BOT,
      botUserId: BOT,
      webUiPublicUrl: WEB_BASE,
      syncDirectory: async () => {
        synced++;
      },
    }),
  );
  assert.equal(calls.posted.length, 0, "the welcome post threw");
  assert.equal(synced, 1, "directory sync still runs so members can reach the surface even if the welcome failed");
});

test("onBotJoinedChannel: stays silent in an externally-shared (Slack Connect) channel — no welcome, no purpose", async () => {
  const { client, calls } = fakeJoinClient({ extShared: true });
  let synced = 0;
  await onBotJoinedChannel({
    client,
    channel: "C123",
    joinerUserId: BOT,
    botUserId: BOT,
    webUiPublicUrl: WEB_BASE,
    syncDirectory: async () => {
      synced++;
    },
  });
  assert.equal(calls.posted.length, 0, "the bot never posts into a Connect channel (an external could see it)");
  assert.equal(synced, 1, "directory sync (which never emits into the channel) still runs");
});
