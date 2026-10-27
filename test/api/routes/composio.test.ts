import { test } from "node:test";
import assert from "node:assert/strict";
import { composioUserId } from "../../../src/api/routes/composio.ts";
import { tenant } from "../../../src/tenant.ts";
import { createPostgresDirectoryStore } from "../../../src/directory/postgres-directory-store.ts";
import { testAdvisoryLock } from "../../support/test-database.ts";
import { fixture, privateCap } from "../../support/composio-routes.ts";
import { createSlackAccounts } from "../../../src/connectors/composio-links.ts";
import { testQuery } from "../../support/test-database.ts";

test("Composio requires a verified actor and never uses another person's key", async () => {
  const f = fixture();
  await f.own("bob");
  assert.equal((await f.invoke("/v1/composio/toolkits", undefined, null)).status, 401);
  assert.equal((await f.invoke("/v1/composio/toolkits")).status, 403);
  assert.equal(f.calls.length, 0);
});

test("company credentials require an applicable grant and must be enabled", async () => {
  for (const [granted, enabled] of [
    [false, true],
    [true, false],
  ]) {
    const f = fixture();
    await f.shared(granted, enabled);
    assert.equal((await f.invoke("/v1/composio/toolkits")).status, 403);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await f.shared();
  f.replies.push({ items: [], next_cursor: null });
  assert.equal((await f.invoke("/v1/composio/toolkits")).status, 200);
  assert.equal(new Headers(f.calls[0]!.init?.headers).get("x-api-key"), "company-key");
});

test("catalog preserves provider usage order, pagination, and strips raw fields", async () => {
  const f = fixture();
  await f.own();
  f.replies.push({
    items: [
      { slug: "gmail", name: "Gmail", meta: { description: "Email" }, secret: "do-not-return" },
      { slug: "github", name: "GitHub" },
    ],
    next_cursor: "page+2",
  });
  const r = await f.invoke("/v1/composio/toolkits?cursor=page%2B1");
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.data.items.map((x: { id: string }) => x.id),
    ["gmail", "github"],
  );
  assert.equal(r.data.nextCursor, "page+2");
  assert.doesNotMatch(r.text, /private-key|do-not-return/);
  const url = new URL(f.calls[0]!.url);
  assert.equal(url.searchParams.get("sort_by"), "usage");
  assert.equal(url.searchParams.get("cursor"), "page+1");
});

test("ambiguous personal keys fail closed rather than switching to the company key", async () => {
  const f = fixture();
  await f.own();
  await f.own("alice", "another-project");
  await f.shared();
  assert.equal((await f.invoke("/v1/composio/toolkits")).status, 409);
  assert.equal(f.calls.length, 0);
});

test("authorization binds the session to the authenticated actor, ignoring supplied identity", async () => {
  for (const link of ["https://connect.composio.dev/link/lk_test", "https://app.composio.dev/link/lt_test"]) {
    const f = fixture();
    await f.own();
    f.replies.push(
      { session_id: "trs_test" },
      { redirect_url: link, connected_account_id: "ca_test", secret: "hidden" },
    );
    const r = await f.invoke("/v1/composio/authorize", { toolkit: "gmail", user_id: "bob", principalId: "bob" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { url: link, accountId: "ca_test" });
    const payload = JSON.parse(String(f.calls[0]!.init?.body));
    assert.equal(payload.user_id, composioUserId(tenant().orgId, "alice"));
    assert.deepEqual(payload.toolkits, { enable: ["gmail"] });
    assert.deepEqual(payload.manage_connections, { enable: false });
    assert.equal(f.calls[1]!.url.endsWith("/tool_router/session/trs_test/link"), true);
  }
});

test("invalid toolkits and unsafe authorization destinations are rejected", async () => {
  const f = fixture();
  await f.own();
  assert.equal((await f.invoke("/v1/composio/authorize", { toolkit: "../../anything" })).status, 400);
  assert.equal(f.calls.length, 0);
  for (const redirect_url of [
    "https://evil.example/link/lk_test",
    "https://connect.composio.dev.evil.example/link/lk_test",
    "https://user:pass@connect.composio.dev/link/lk_test",
    "http://connect.composio.dev/link/lk_test",
    "https://connect.composio.dev/other",
  ]) {
    f.replies.push({ session_id: "trs_test" }, { redirect_url, connected_account_id: "ca_test" });
    assert.equal((await f.invoke("/v1/composio/authorize", { toolkit: "gmail" })).status, 502);
  }
});

test("upstream errors are redacted and identity is stable per organization and person", async () => {
  const f = fixture();
  await f.own();
  f.replies.push(new Error("private-key"));
  const r = await f.invoke("/v1/composio/toolkits");
  assert.equal(r.status, 502);
  assert.doesNotMatch(r.text, /private-key/);
  assert.notEqual(composioUserId("a", "alice"), composioUserId("b", "alice"));
  assert.notEqual(composioUserId("a", "alice"), composioUserId("a", "bob"));
  assert.deepEqual((await f.invoke("/v1/composio/identity")).data, {
    userId: composioUserId(tenant().orgId, "alice"),
    userIds: [composioUserId(tenant().orgId, "alice")],
  });
});

test("authorization supplies the callback and account binding without accepting unsafe callback schemes", async () => {
  const f = fixture();
  await f.own();
  for (const callbackUrl of ["javascript:alert(1)", "http://evil.example/", "https://user:password@example.com/"]) {
    assert.equal((await f.invoke("/v1/composio/authorize", { toolkit: "gmail", callbackUrl })).status, 400);
  }
  assert.equal(f.calls.length, 0);
  const callbackUrl = "https://qm.example/s/chat?composioReturn=nonce";
  f.replies.push(
    { session_id: "trs_test" },
    { redirect_url: "https://connect.composio.dev/link/lk_test", connected_account_id: "ca_test" },
  );
  const r = await f.invoke("/v1/composio/authorize", { toolkit: "gmail", callbackUrl });
  assert.equal(r.data.accountId, "ca_test");
  assert.equal(JSON.parse(String(f.calls[1]!.init?.body)).callback_url, callbackUrl);
});

test("connections return only this actor's active accounts and strip credentials", async () => {
  const f = fixture();
  await f.own();
  const owned = {
    id: "ca_gmail",
    user_id: composioUserId(tenant().orgId, "alice"),
    status: "ACTIVE",
    toolkit: { slug: "gmail" },
    data: { token: "secret-token" },
  };
  f.replies.push({
    items: [
      owned,
      { ...owned, id: "ca_other", user_id: composioUserId(tenant().orgId, "bob") },
      { ...owned, status: "INITIATED" },
      { ...owned, is_disabled: true },
    ],
    next_cursor: "next-page",
  });
  const r = await f.invoke("/v1/composio/connections?user_ids=bob&cursor=page-1");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, {
    items: [{ id: "ca_gmail", toolkit: "gmail", userId: composioUserId(tenant().orgId, "alice"), missingScopes: [] }],
    nextCursor: "next-page",
  });
  const q = new URL(f.calls[0]!.url).searchParams;
  assert.equal(q.get("user_ids"), composioUserId(tenant().orgId, "alice"));
  assert.equal(q.get("statuses"), "ACTIVE");
  assert.equal(q.get("cursor"), "page-1");
  assert.doesNotMatch(r.text, /secret-token|private-key|user_id/);
});

test("connections report scopes the app's configuration grants that an older connection lacks", async () => {
  const f = fixture();
  await f.own();
  const account = (id: string, scope: string | undefined, config = "ac_x") => ({
    id,
    user_id: composioUserId(tenant().orgId, "alice"),
    status: "ACTIVE",
    toolkit: { slug: "twitter" },
    auth_config: { id: config },
    state: { authScheme: "OAUTH2", val: { scope, access_token: "secret-token" } },
  });
  f.replies.push(
    {
      items: [
        account("ca_old", "tweet.read users.read offline.access"),
        account("ca_new", "tweet.read users.read offline.access dm.read dm.write"),
        account("ca_unknown", undefined),
        account("ca_unreadable", "tweet.read", "ac_gone"),
      ],
    },
    {
      credentials: {
        scopes: ["tweet.read", "users.read", "offline.access", "dm.read", "dm.write"],
        client_secret: "s3",
      },
    },
    new Response("missing", { status: 404 }),
  );
  const r = await f.invoke("/v1/composio/connections");
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.data.items.map((item: { id: string; missingScopes: string[] }) => [item.id, item.missingScopes]),
    [
      ["ca_old", ["dm.read", "dm.write"]],
      ["ca_new", []],
      ["ca_unknown", []],
      ["ca_unreadable", []],
    ],
  );
  assert.deepEqual(
    f.calls.slice(1).map((call) => new URL(call.url).pathname),
    ["/api/v3.1/auth_configs/ac_x", "/api/v3.1/auth_configs/ac_gone"],
  );
  assert.doesNotMatch(r.text, /secret-token|s3|private-key/);
  f.replies.push({ items: [account("ca_old", "tweet.read"), account("ca_unreadable", "tweet.read", "ac_gone")] }, {});
  await f.invoke("/v1/composio/connections");
  assert.deepEqual(
    f.calls.slice(3).map((call) => new URL(call.url).pathname),
    ["/api/v3.1/connected_accounts", "/api/v3.1/auth_configs/ac_gone"],
  );
});

test("scopes granted in URL form match their short configured names", async () => {
  const f = fixture();
  await f.own();
  f.replies.push(
    {
      items: [
        {
          id: "ca_outlook",
          user_id: composioUserId(tenant().orgId, "alice"),
          status: "ACTIVE",
          toolkit: { slug: "outlook" },
          auth_config: { id: "ac_outlook" },
          state: { val: { scope: "https://graph.microsoft.com/Mail.Read offline_access https://mail.google.com/" } },
        },
      ],
    },
    { credentials: { scopes: ["Mail.Read", "offline_access", "https://mail.google.com/", "Mail.Send"] } },
  );
  const r = await f.invoke("/v1/composio/connections");
  assert.deepEqual(r.data.items[0].missingScopes, ["Mail.Send"]);
});

test("people can disconnect only their own connections, on a turn they started", async () => {
  const f = fixture();
  await f.own();
  const mine = {
    id: "ca_mine",
    user_id: composioUserId(tenant().orgId, "alice"),
    status: "EXPIRED",
    toolkit: { slug: "twitter" },
  };
  f.replies.push(mine, {});
  const r = await f.invoke("/v1/composio/disconnect", { accountId: "ca_mine" });
  assert.deepEqual([r.status, r.data], [200, { disconnected: "ca_mine", toolkit: "twitter" }]);
  assert.deepEqual(
    f.calls.map((call) => [call.init?.method, new URL(call.url).pathname]),
    [
      ["GET", "/api/v3.1/connected_accounts/ca_mine"],
      ["DELETE", "/api/v3.1/connected_accounts/ca_mine"],
    ],
  );
  assert.deepEqual(
    f.audits.filter((e) => e.action === "composio.disconnected").map((e) => e.resource),
    ["twitter/ca_mine"],
  );

  f.replies.push(mine, {});
  assert.equal((await f.invoke("/v1/composio/disconnect", { accountId: "ca_mine" }, null, privateCap)).status, 200);

  for (const account of [
    { ...mine, user_id: composioUserId(tenant().orgId, "bob") },
    { ...mine, id: "ca_other" },
    { ...mine, toolkit: { slug: "composio" } },
  ]) {
    const g = fixture();
    await g.own();
    g.replies.push(account);
    assert.equal((await g.invoke("/v1/composio/disconnect", { accountId: "ca_mine" })).status, 403);
    assert.ok(g.calls.every((call) => call.init?.method === "GET"));
  }

  const g = fixture();
  await g.own();
  g.replies.push(new Response("gone", { status: 404 }));
  assert.equal((await g.invoke("/v1/composio/disconnect", { accountId: "ca_mine" })).status, 404);
});

test("disconnecting refuses automations, impersonation and malformed accounts before provider calls", async () => {
  for (const [body, actor, capability, impersonating, status] of [
    [{ accountId: "ca_mine" }, null, { ...privateCap, liveActor: false, triggered: true }, false, 403],
    [{ accountId: "ca_mine" }, "alice", undefined, true, 403],
    [{ accountId: "../ca_mine" }, "alice", undefined, false, 400],
    [{ accountId: "ca_mine" }, null, undefined, false, 401],
  ] as const) {
    const f = fixture();
    await f.own();
    assert.equal((await f.invoke("/v1/composio/disconnect", body, actor, capability, impersonating)).status, status);
    assert.equal(f.calls.length, 0);
  }
});

test("connections require credential access and fail visibly on upstream errors", async () => {
  const f = fixture();
  assert.equal((await f.invoke("/v1/composio/connections", undefined, null)).status, 401);
  assert.equal((await f.invoke("/v1/composio/connections")).status, 403);
  await f.own();
  f.replies.push(new Error("private-key"));
  const r = await f.invoke("/v1/composio/connections");
  assert.equal(r.status, 502);
  assert.doesNotMatch(r.text, /private-key/);
});

test("Slack connection links verified workspace identity to the web owner and persists status", async () => {
  const f = fixture();
  await f.own();
  const { createPrincipalLinkService } = await import("../../../src/identity/principal-links.ts");
  const { installPrincipalLinks, canonicalPerson } = await import("../../../src/directory/person.ts");
  f.deps.principalLinks = createPrincipalLinkService(f.url, testAdvisoryLock());
  installPrincipalLinks(f.deps.principalLinks);
  f.deps.slackAccounts = createSlackAccounts(f.url);
  f.deps.signingSecret = "qa-slack-link-secret";
  f.deps.directory = createPostgresDirectoryStore(f.url);
  await f.deps.directory.replace([
    { principalId: "work@example.test", slackId: "U123", displayName: "Alice", type: "internal" },
  ]);
  f.deps.slackEnvBotToken = "bot-test";
  f.deps.slackWebClient = () => ({ apiCall: async () => ({ ok: true, team_id: "T123" }) });
  try {
    f.replies.push(
      { session_id: "trs_test" },
      { redirect_url: "https://connect.composio.dev/link/lk_test", connected_account_id: "ca_test" },
    );
    const started = await f.invoke("/v1/composio/slack/authorize", {});
    assert.equal(started.status, 200);
    const account = {
      id: "ca_test",
      user_id: composioUserId(tenant().orgId, "alice"),
      toolkit: { slug: "slack" },
      status: "ACTIVE",
    };
    f.replies.push(account, { data: { ok: true, user_id: "U123", team_id: "T123", user: "alice", team: "Acme" } });
    f.replies.push({ items: [] });
    const linked = await f.invoke("/v1/composio/slack/complete", { ticket: started.data.ticket });
    assert.equal(linked.status, 200);
    assert.equal(canonicalPerson("work@example.test"), "alice");
    assert.equal((await f.deps.slackAccounts.get("alice"))?.accountId, "ca_test");
    f.replies.push(account);
    assert.equal((await f.invoke("/v1/composio/slack")).data.connected, true);
    f.replies.push({ ...account, status: "REVOKED" });
    assert.equal((await f.invoke("/v1/composio/slack")).data.connected, false);
    f.replies.push(account, { data: { ok: true, user_id: "U123", team_id: "T123", user: "alice", team: "Acme" } });
    assert.equal((await f.invoke("/v1/composio/slack/complete", { ticket: started.data.ticket })).status, 200);
  } finally {
    installPrincipalLinks(null);
  }
});

test("Slack link rejects changed browser accounts, wrong owner, bots, other workspaces and inactive connections", async () => {
  const { createPrincipalLinkService } = await import("../../../src/identity/principal-links.ts");
  const { mintSignedPayload } = await import("../../../src/auth/signed-token.ts");
  for (const scenario of [
    "expired",
    "other-browser",
    "wrong-owner",
    "bot",
    "wrong-workspace",
    "pending",
    "existing-connectors",
    "existing-key",
    "different-project",
  ]) {
    const f = fixture();
    await f.own();
    await f.own("bob");
    f.deps.signingSecret = "slack-test";
    f.deps.principalLinks = createPrincipalLinkService(f.url, testAdvisoryLock());
    f.deps.slackAccounts = createSlackAccounts(f.url);
    f.deps.directory = createPostgresDirectoryStore(f.url);
    await f.deps.directory.replace([
      { principalId: "work@example.test", slackId: "U123", displayName: "Alice", type: "internal" },
    ]);
    f.deps.slackEnvBotToken = "bot-test";
    f.deps.slackWebClient = () => ({ apiCall: async () => ({ ok: true, team_id: "T123" }) });
    const ticket = await mintSignedPayload(
      {
        purpose: "slack-account-link",
        principal: "alice",
        org: tenant().orgId,
        accountId: "ca_test",
        exp: Date.now() + (scenario === "expired" ? -1000 : 60000),
      },
      "slack-test",
    );
    f.replies.push(
      {
        id: "ca_test",
        user_id: composioUserId(tenant().orgId, scenario === "wrong-owner" ? "bob" : "alice"),
        toolkit: { slug: "slack" },
        status: scenario === "pending" ? "INITIATED" : "ACTIVE",
      },
      {
        data: {
          ok: true,
          user_id: "U123",
          team_id: scenario === "wrong-workspace" ? "T999" : "T123",
          ...(scenario === "bot" ? { bot_id: "B123" } : {}),
        },
      },
    );
    if (scenario === "existing-key") await f.own("work@example.test");
    if (scenario === "different-project") await f.shared();
    f.replies.push({ items: scenario === "existing-connectors" ? [{ id: "ca_existing" }] : [] });
    if (scenario === "different-project") f.replies.push({ items: [{ id: "ca_company_existing" }] });
    const result = await f.invoke(
      "/v1/composio/slack/complete",
      { ticket },
      scenario === "other-browser" ? "bob" : "alice",
    );
    assert.ok(result.status >= 400, `${scenario}: ${result.status}`);
    assert.equal((await f.deps.principalLinks.list()).length, 0);
    assert.equal((await testQuery(f.url, "SELECT * FROM slack_accounts")).length, 0);
  }
});
