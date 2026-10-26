import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { createHttpEventsReceiver, type SlackEventsHandler } from "../src/slack/http-events.ts";

const SOURCE_SECRET = "source-auth-secret-for-slack-events-tests-01";
const SLACK_SECRET = "slack-signing-secret-for-events-tests-0001";

const servers: Server[] = [];
const mounted = new Map<string, SlackEventsHandler>();
const receiverFor = (account: string, signingSecret = SLACK_SECRET) =>
  createHttpEventsReceiver({
    signingSecret,
    serve: (handler) => {
      mounted.set(account, handler);
      return () => void mounted.delete(account);
    },
  });
const receiver = receiverFor("");

async function start(slackEvents?: (account: string) => SlackEventsHandler | undefined): Promise<string> {
  const built = buildApp(testConfig());
  const core = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SOURCE_SECRET,
    ...(slackEvents ? { slackEvents } : {}),
  });
  await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
  servers.push(core);
  return `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
}

let base: string;
before(async () => {
  base = await start((account) => mounted.get(account));
});

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

function slackHeaders(body: string, secret = SLACK_SECRET): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  };
}

const post = (url: string, body: string, secret?: string, path = "/slack/events") =>
  fetch(`${url}${path}`, { method: "POST", headers: slackHeaders(body, secret), body });

test("the public core endpoint hands valid Slack events to the running receiver", async () => {
  await receiver.start(0 as never);
  try {
    const response = await post(base, JSON.stringify({ type: "url_verification", challenge: "events-ok" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { challenge: "events-ok" });
  } finally {
    await receiver.stop(0 as never);
  }
});

test("the receiver remains the Slack-signature authority", async () => {
  await receiver.start(0 as never);
  try {
    const body = JSON.stringify({ type: "url_verification", challenge: "nope" });
    const response = await post(base, body, "wrong-signing-secret-for-events-tests");
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_signature" });
  } finally {
    await receiver.stop(0 as never);
  }
});

test("each Slack account's receiver answers on its own path, and a stopped one is not found", async () => {
  const account = receiverFor("workspace-b", "workspace-b-signing-secret-for-tests-0001");
  await account.start(0 as never);
  try {
    const body = JSON.stringify({ type: "url_verification", challenge: "b-ok" });
    const ok = await post(base, body, "workspace-b-signing-secret-for-tests-0001", "/slack/events/workspace-b");
    assert.deepEqual(await ok.json(), { challenge: "b-ok" });
    assert.equal((await post(base, body, SLACK_SECRET, "/slack/events/workspace-b")).status, 401);
    assert.equal((await post(base, body)).status, 404);
  } finally {
    await account.stop(0 as never);
  }
  const body = JSON.stringify({ type: "url_verification", challenge: "down" });
  assert.equal((await post(base, body, undefined, "/slack/events/workspace-b")).status, 404);
  assert.equal((await post(await start(), body)).status, 404);
});
