import assert from "node:assert/strict";
import { test } from "node:test";
import { createDirectory } from "../src/slack/directory.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";

function directory() {
  return createDirectory({
    core: {} as SlackCoreClient,
    ids: {
      ownTeamId: "",
      botUserId: "UBOT",
      ownBotId: "BBOT",
      botHandle: "qm",
      ownWorkspaceUrl: "",
      identityMode: "email",
    },
    coreSingleton: false,
  });
}

const rateLimited = Object.assign(new Error("An API error occurred: ratelimited"), { data: { error: "ratelimited" } });

test("a failed users.info lookup is logged with its cause before the user is treated as a guest", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const client = {
    users: {
      info: async () => {
        throw rateLimited;
      },
    },
  };
  const result = await directory().classifyUserCached(client, "U1");
  assert.equal(result.ok, false);
  assert.equal(result.actor.isExternalGuest, true);
  const logged = warn.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(
    logged.some((line) => line.includes("users.info") && line.includes("ratelimited")),
    logged.join("\n"),
  );
});

test("a failed conversations.info lookup is logged with its cause", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const client = {
    conversations: {
      info: async () => {
        throw rateLimited;
      },
    },
  };
  assert.equal(await directory().getChannelInfo(client, "C1"), undefined);
  const logged = warn.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(
    logged.some((line) => line.includes("conversations.info") && line.includes("ratelimited")),
    logged.join("\n"),
  );
});
