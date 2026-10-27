import type { CapabilityClaims } from "../../../src/auth/capability-token.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresDirectoryStore } from "../../../src/directory/postgres-directory-store.ts";
import { testDatabaseUrl } from "../../support/test-database.ts";
import { testMap } from "../../support/test-database.ts";
import { slackReplyFixture } from "../../support/composio-routes.ts";

test("Slack replies use only the viewer's verified user connection and server-side thread destination", async () => {
  const f = await slackReplyFixture();
  f.replies.push(f.account, f.identity, { data: { ok: true } }, { data: { ok: true, ts: "123.789" } });
  const result = await f.invoke("/v1/composio/slack/reply", {
    ...f.message,
    channel: "CATTACK",
    accountId: "ca_other",
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.sent, true);
  const receipts = await f.receipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.kind, "UserMessage");
  assert.equal(receipts[0]!.text, "Hello");
  assert.equal(receipts[0]!.externalId, "123.789");
  assert.equal(receipts[0]!.name, "Alice");
  assert.equal(receipts[0]!.slackReplyReceipt, true);
  const request = JSON.parse(String(f.calls.at(-1)!.init!.body));
  assert.equal(request.connected_account_id, "ca_alice");
  assert.equal(request.endpoint, "https://slack.com/api/chat.postMessage");
  assert.deepEqual(request.body, {
    channel: "C123",
    thread_ts: "123.456",
    text: "Hello",
    client_msg_id: f.message.clientMessageId,
    as_user: true,
    unfurl_links: false,
    unfurl_media: false,
  });
});

test("Slack reply status verifies personal access without posting", async () => {
  const f = await slackReplyFixture();
  f.replies.push(f.account, f.identity, { data: { ok: true } });
  assert.equal((await f.invoke("/v1/composio/slack/reply-status", f.message)).data.connected, true);
  assert.equal(f.calls.length, 3);
});

test("Slack reply status treats a Composio 4xx as not linked but still fails on 5xx", async () => {
  const f = await slackReplyFixture();
  f.replies.push(f.account, new Response("bad request", { status: 400 }));
  const quiet = await f.invoke("/v1/composio/slack/reply-status", f.message);
  assert.equal(quiet.status, 200);
  assert.equal(quiet.data.connected, false);
  f.replies.push(f.account, new Response("upstream down", { status: 500 }));
  assert.equal((await f.invoke("/v1/composio/slack/reply-status", f.message)).status, 502);
});

test("Slack replies cannot target hidden sessions or accept blank messages", async () => {
  const f = await slackReplyFixture();
  assert.equal((await f.invoke("/v1/composio/slack/reply", { ...f.message, sessionId: "hidden" })).status, 404);
  assert.equal((await f.invoke("/v1/composio/slack/reply", { ...f.message, text: " " })).status, 400);
  assert.equal((await f.invoke("/v1/composio/slack/reply", f.message, null)).status, 403);
  assert.equal(f.calls.length, 0);
});

test("Slack replies require a linked user account and never fall back to the bot token", async () => {
  const f = await slackReplyFixture();
  await f.deps.slackAccounts!.delete("alice");
  f.deps.slackEnvBotToken = "must-not-use";
  assert.equal((await f.invoke("/v1/composio/slack/reply-status", f.message)).data.connected, false);
  assert.equal((await f.invoke("/v1/composio/slack/reply", f.message)).status, 409);
  assert.equal(f.calls.length, 0);
});

for (const [label, accountPatch, identityPatch] of [
  ["another owner", { user_id: "other" }, {}],
  ["revoked connection", { status: "REVOKED" }, {}],
  ["bot token", {}, { bot_id: "B123" }],
  ["another user", {}, { user_id: "UOTHER" }],
  ["another workspace", {}, { team_id: "TOTHER" }],
] as const)
  test(`Slack replies reject ${label}`, async () => {
    const f = await slackReplyFixture();
    f.replies.push({ ...f.account, ...accountPatch }, { data: { ...f.identity.data, ...identityPatch } });
    assert.equal((await f.invoke("/v1/composio/slack/reply", f.message)).status, 409);
    assert.ok(f.calls.length <= 2);
  });

test("Slack replies preserve an uncertain send result without retrying", async () => {
  const f = await slackReplyFixture();
  f.replies.push(f.account, f.identity, { data: { ok: true } }, new Error("timeout"));
  const result = await f.invoke("/v1/composio/slack/reply", f.message);
  assert.equal(result.status, 502);
  assert.match(result.data.message, /outcome is unknown/);
  assert.equal(f.calls.length, 4);
});

test("Slack replies stop when the personal account cannot access the conversation", async () => {
  const f = await slackReplyFixture();
  f.replies.push(f.account, f.identity, { data: { ok: false, error: "channel_not_found" } });
  assert.equal((await f.invoke("/v1/composio/slack/reply", f.message)).status, 403);
  assert.equal(f.calls.length, 3);
});

test("Slack replies reject impersonation and agent capabilities", async () => {
  const f = await slackReplyFixture();
  assert.equal((await f.invoke("/v1/composio/slack/reply", f.message, "alice", undefined, true)).status, 403);
  assert.equal((await f.invoke("/v1/composio/slack/reply", f.message, "alice", {} as CapabilityClaims)).status, 403);
  assert.equal(f.calls.length, 0);
});

test("Slack replies preserve unthreaded DMs and report Slack permission failures", async () => {
  const f = await slackReplyFixture();
  f.app.getSessionForViewer = async () => ({ session: { threadRef: "dm:D123" } });
  f.replies.push(f.account, f.identity, { data: { ok: true } }, { data: { ok: false, error: "missing_scope" } });
  assert.equal((await f.invoke("/v1/composio/slack/reply", f.message)).status, 403);
  const request = JSON.parse(String(f.calls.at(-1)!.init!.body));
  assert.equal(request.body.channel, "D123");
  assert.equal("thread_ts" in request.body, false);
});

async function nativeSlackFixture(linked = true) {
  const f = await slackReplyFixture();
  f.deps.slackAccounts = testMap();
  f.deps.connectorTokens = f.deps.keychain;
  f.deps.oauthEnv = { SLACK_OAUTH_CLIENT_ID: "native-client", SLACK_OAUTH_CLIENT_SECRET: "native-secret" };
  f.deps.directory = createPostgresDirectoryStore(testDatabaseUrl());
  await f.deps.directory.replace([{ principalId: "alice", slackId: "U123", displayName: "Alice", type: "internal" }]);
  f.deps.slackEnvBotToken = "workspace-bot";
  if (linked) await f.deps.connectorTokens!.setConnectorToken("slack.com", "alice", { accessToken: "alice-user" });
  const nativeCalls: Array<{ method: string; token: string; payload?: object }> = [];
  const nativeReplies: unknown[] = [];
  f.deps.slackWebClient = (token, options) => {
    assert.equal(options.retryConfig?.retries, 0);
    assert.equal(options.rejectRateLimitedCalls, true);
    return {
      async apiCall(method, payload) {
        nativeCalls.push({ method, token, payload });
        if (token === "workspace-bot") return { ok: true, team_id: "T123" };
        const value = nativeReplies.shift();
        if (value instanceof Error) throw value;
        if ((value as { ok?: boolean })?.ok === false)
          throw Object.assign(new Error("Slack API error"), { code: "slack_webapi_platform_error", data: value });
        return value as { ok: boolean };
      },
    };
  };
  const nativeIdentity = { ok: true, user_id: "U123", team_id: "T123", user: "Alice", team: "Test" };
  return { ...f, nativeCalls, nativeReplies, nativeIdentity };
}

test("native Slack replies use the authenticated user's token and server destination without Composio", async () => {
  const f = await nativeSlackFixture();
  f.nativeReplies.push(f.nativeIdentity, { ok: true }, { ok: true, ts: "123.789" });
  const result = await f.invoke("/v1/composio/slack/reply", { ...f.message, channel: "COTHER" });
  assert.equal(result.data.sent, true);
  const receipts = await f.receipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.kind, "UserMessage");
  assert.equal(receipts[0]!.text, "Hello");
  assert.equal(receipts[0]!.externalId, "123.789");
  assert.equal(receipts[0]!.name, "Alice");
  assert.equal(receipts[0]!.slackReplyReceipt, true);
  assert.equal(f.calls.length, 0);
  const sent = f.nativeCalls.at(-1)!;
  assert.equal(sent.method, "chat.postMessage");
  assert.equal(sent.token, "alice-user");
  assert.deepEqual(sent.payload, {
    channel: "C123",
    thread_ts: "123.456",
    text: "Hello",
    client_msg_id: f.message.clientMessageId,
    as_user: true,
    unfurl_links: false,
    unfurl_media: false,
  });
});

test("native Slack rejects bot, wrong person, and wrong workspace tokens", async () => {
  for (const invalid of [{ bot_id: "B123" }, { user_id: "UOTHER" }, { team_id: "TOTHER" }]) {
    const f = await nativeSlackFixture();
    f.nativeReplies.push({ ...f.nativeIdentity, ...invalid });
    const result = await f.invoke("/v1/composio/slack/reply", f.message);
    assert.equal(result.status, 409);
    assert.equal(
      f.nativeCalls.some((c) => c.method === "chat.postMessage"),
      false,
    );
  }
});

test("native Slack connection status and linking work without a Composio credential", async () => {
  const f = await nativeSlackFixture(false);
  f.deps.keychain = undefined;
  f.deps.serviceCreds = undefined;
  assert.deepEqual((await f.invoke("/v1/composio/slack")).data, {
    connected: false,
    nativeOAuth: true,
    workspaceInstalled: true,
  });
  assert.equal((await f.invoke("/v1/composio/slack/reply-status", { sessionId: "session" })).data.connected, false);
  await f.deps.connectorTokens!.setConnectorToken("slack.com", "alice", { accessToken: "alice-user" });
  f.nativeReplies.push(f.nativeIdentity);
  assert.equal((await f.invoke("/v1/composio/slack")).data.connected, true);
});

test("configured native OAuth preserves an existing Composio connection", async () => {
  const f = await nativeSlackFixture(false);
  await f.deps.slackAccounts!.put("alice", {
    principalId: "alice",
    memberId: "alice",
    accountId: "ca_alice",
    userId: "U123",
    teamId: "T123",
    user: "Alice",
    workspace: "Test",
  });
  f.replies.push(f.account);
  assert.equal((await f.invoke("/v1/composio/slack")).data.connected, true);
  f.replies.push(f.account, f.identity, { data: { ok: true } }, { data: { ok: true, ts: "123.789" } });
  assert.equal((await f.invoke("/v1/composio/slack/reply", f.message)).data.sent, true);
  assert.equal(f.nativeCalls.length, 0);
});

test("native Slack access denial and uncertain sends never fall through to another transport", async () => {
  for (const sending of [false, true]) {
    const f = await nativeSlackFixture();
    f.nativeReplies.push(f.nativeIdentity, { ok: sending });
    if (sending) f.nativeReplies.push(new Error("timeout"));
    const result = await f.invoke("/v1/composio/slack/reply", f.message);
    assert.equal(result.status, sending ? 502 : 403);
    if (sending) assert.match(result.data.message, /outcome is unknown/);
    assert.equal(f.calls.length, 0);
  }
});

test("a confirmed Slack send is distinguished from a failed transcript write", async () => {
  const f = await slackReplyFixture();
  f.sessions.appendMany = async () => {
    throw new Error("database unavailable");
  };
  f.replies.push(f.account, f.identity, { data: { ok: true } }, { data: { ok: true, ts: "123.789" } });
  const result = await f.invoke("/v1/composio/slack/reply", f.message);
  assert.equal(result.status, 502);
  assert.equal(result.data.error, "transcript_unavailable");
  assert.match(result.data.message, /Slack sent your message.*Do not resend/);
});

test("Slack reply failures redact both provider credentials from diagnostics", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logged.push(args.map(String).join(" ")));
  const composio = await slackReplyFixture();
  composio.replies.push(new Response("provider rejected private-key", { status: 502 }));
  assert.equal((await composio.invoke("/v1/composio/slack/reply", composio.message)).status, 502);
  const native = await nativeSlackFixture();
  native.nativeReplies.push(new Error("provider rejected alice-user"));
  assert.equal((await native.invoke("/v1/composio/slack/reply", native.message)).status, 502);
  assert.match(logged.join("\n"), /provider rejected/);
  assert.doesNotMatch(logged.join("\n"), /private-key|alice-user/);
});
