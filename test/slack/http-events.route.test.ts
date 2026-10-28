import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createServer } from "../../src/api/server.ts";
import { buildApp } from "../support/build-app.ts";
import { testConfig } from "../support/test-config.ts";
import { createPostgresReplayDedupe } from "../../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { createHttpEventsReceiver, receiveSlackRequest } from "../../src/slack/http-events.ts";
import { createSlackSurface, type SlackNative } from "../../src/surfaces/slack-surface.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

const SOURCE_SECRET = "source-auth-secret-for-slack-events-tests-01";
const SLACK_SECRET = "slack-signing-secret-for-events-tests-0001";

const servers: Server[] = [];
const surface = createSlackSurface();
const receiverFor = (account: string, signingSecret = SLACK_SECRET, slack: SlackNative = surface.slack) =>
  createHttpEventsReceiver({ signingSecret, serve: (endpoint) => slack.serveEvents(account, endpoint) });
const receiver = receiverFor("");
const servedBy =
  (slack: SlackNative) =>
  (account: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> =>
    receiveSlackRequest(slack, account, req, res);

async function start(
  slackEvents?: (account: string, req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
): Promise<string> {
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
  base = await start(servedBy(surface.slack));
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

test("an on-demand Slack app is started only after the request carries its own signing secret", async () => {
  const onDemand = createSlackSurface();
  const secret = "on-demand-signing-secret-for-events-tests-01";
  const seen: unknown[] = [];
  let starts = 0;
  onDemand.slack.onDemand({
    signingSecret: (account) => (account ? undefined : secret),
    async ready() {
      starts++;
      if (onDemand.slack.events("")) return;
      const app = {
        processEvent: async ({ body, ack }: { body: unknown; ack: () => Promise<void> }) => {
          seen.push(body);
          await ack();
        },
      };
      const tenantReceiver = receiverFor("", secret, onDemand.slack);
      tenantReceiver.init?.(app as never);
      await tenantReceiver.start(0 as never);
    },
  });
  const url = await start(servedBy(onDemand.slack));
  const event = JSON.stringify({ type: "event_callback", event_id: "Ev1", event: { type: "reaction_added" } });
  assert.equal((await post(url, event, SLACK_SECRET)).status, 401);
  const challenge = JSON.stringify({ type: "url_verification", challenge: "tenant-ok" });
  assert.deepEqual(await (await post(url, challenge, secret)).json(), { challenge: "tenant-ok" });
  assert.equal(starts, 0);
  assert.equal((await post(url, event, secret)).status, 200);
  const action = JSON.stringify({ type: "block_actions", actions: [] });
  const form = `payload=${encodeURIComponent(action)}`;
  const clicked = await fetch(`${url}/slack/interactions`, {
    method: "POST",
    headers: { ...slackHeaders(form, secret), "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  assert.equal(clicked.status, 200);
  assert.equal(starts, 2);
  assert.deepEqual(seen, [JSON.parse(event), JSON.parse(action)]);
  assert.equal((await post(url, event, secret, "/slack/events/other")).status, 404);
});
