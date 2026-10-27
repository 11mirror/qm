import "../../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { createKeychain, type OAuthRefresh, type OAuthToken } from "../../../src/credentials/keychain.ts";
import { createKeychainStore } from "../../../src/credentials/keychain-store.ts";
import { deriveConnectorKey } from "../../../src/connectors/connector-client-store.ts";
import { oauthRevoke } from "../../../src/api/routes/connectors.ts";
import { testAdvisoryLock, testDatabaseUrl } from "../../support/test-database.ts";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createInsecureTestServer } from "../../../src/api/server.ts";
import type { AdvisoryLock } from "../../../src/persistence/advisory-lock.ts";
import { respond } from "../../../src/api/routes/route.ts";
import { createManagedSlack } from "../../../src/surfaces/slack-managed.ts";
import type { BuiltApp } from "../../../src/wiring.ts";
import { buildApp } from "../../support/build-app.ts";
import { testConfig } from "../../support/test-config.ts";

const KEY = deriveConnectorKey("test-connector-key-aaaaaaaaaaaaaaaa");

function makeKeychain(
  opts: {
    now?: () => number;
    skewMs?: number;
    refresh?: OAuthRefresh;
    databaseUrl?: string;
    lock?: AdvisoryLock;
  } = {},
) {
  const keychain = createKeychain({
    lock: opts.lock ?? testAdvisoryLock(),
    store: createKeychainStore(opts.databaseUrl ?? testDatabaseUrl()),
    key: KEY,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.skewMs !== undefined ? { oauthSkewMs: opts.skewMs } : {}),
    ...(opts.refresh ? { refreshConnector: opts.refresh } : {}),
  });
  return keychain;
}

test("connector tokens: per-user token + refresh; no shared fallback", async () => {
  let refreshed = 0;
  const tokens = makeKeychain({
    now: () => 10_000,
    skewMs: 0,
    refresh: async (_host, t) => {
      refreshed++;
      return { accessToken: "fresh-" + (t.refreshToken ?? ""), refreshToken: t.refreshToken, expiresAt: 1_000_000 };
    },
  });

  await tokens.setConnectorToken("private.example.test", "U1", { accessToken: "alice-private", expiresAt: 1_000_000 });
  assert.equal(await tokens.connectorAccessToken("private.example.test", "U1"), "alice-private");

  await tokens.setConnectorToken("gmail.googleapis.com", "U2", {
    accessToken: "stale",
    refreshToken: "rt-2",
    expiresAt: 5_000,
  });
  assert.deepEqual(await tokens.connectorTokenStatus("gmail.googleapis.com", "U2"), {
    connected: true,
    expiresAt: 5_000,
    hasRefreshToken: true,
  });
  assert.equal(await tokens.connectorAccessToken("gmail.googleapis.com", "U2"), "fresh-rt-2");
  assert.equal(refreshed, 1);
  assert.equal(await tokens.connectorAccessToken("gmail.googleapis.com", "U2"), "fresh-rt-2");
  assert.equal(refreshed, 1);
  assert.deepEqual(await tokens.connectorTokenStatus("gmail.googleapis.com", "U2"), {
    connected: true,
    expiresAt: 1_000_000,
    hasRefreshToken: true,
  });

  await tokens.deleteConnectorToken("gmail.googleapis.com", "U2");
  assert.deepEqual(await tokens.connectorTokenStatus("gmail.googleapis.com", "U2"), { connected: false });
  assert.equal(await tokens.connectorAccessToken("gmail.googleapis.com", "U2"), null);

  assert.equal(await tokens.connectorAccessToken("private.example.test", "U9"), null);
});

test("disconnect revokes connector grants so reconnect does not resurrect sharing", async () => {
  const keychain = makeKeychain();
  await keychain.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "first" });
  const grant = await keychain.grantConnectorToScope({
    host: "gmail.googleapis.com",
    principalId: "U1",
    audienceScopeId: "channel:C1",
    purpose: "shared inbox",
  });
  assert.ok(grant);

  await keychain.deleteConnectorToken("gmail.googleapis.com", "U1");
  await keychain.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "second" });

  assert.equal((await keychain.getGrant(grant.id))?.status, "revoked");
  assert.deepEqual(await keychain.grantsForScope("channel:C1"), []);
});

test("connector token refresh: concurrent callers single-flight; connection metadata survives the rewrite", async () => {
  let nowAt = 10_000;
  let calls = 0;
  let lastCtx: { orgId?: string; accountType?: string; clientRef?: string } | undefined;
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const keychain = makeKeychain({
    now: () => nowAt,
    skewMs: 0,
    refresh: async (_host, _t, ctx) => {
      calls++;
      lastCtx = ctx;
      await gate;
      return { accessToken: "fresh", refreshToken: "rt-rotated", expiresAt: 1_000_000 };
    },
  });
  await keychain.setConnectorToken(
    "gmail.googleapis.com",
    "U1",
    {
      accessToken: "stale",
      refreshToken: "rt",
      expiresAt: 5_000,
      clientRef: "org:default-org:google",
      accountType: "company",
    },
    "company",
  );

  const p1 = keychain.connectorAccessToken("gmail.googleapis.com", "U1", "company");
  const p2 = keychain.connectorAccessToken("gmail.googleapis.com", "U1", "company");
  await new Promise((r) => setImmediate(r));
  release();
  assert.deepEqual(await Promise.all([p1, p2]), ["fresh", "fresh"]);
  assert.equal(calls, 1, "a provider that rotates refresh tokens must not see two racing refreshes");
  assert.deepEqual(lastCtx, { accountType: "company", clientRef: "org:default-org:google" });

  nowAt = 2_000_000;
  let secondToken: OAuthToken | undefined;
  const seen: OAuthToken[] = [];
  const again = makeKeychain({
    now: () => nowAt,
    skewMs: 0,
    refresh: async (_host, t) => {
      seen.push(t);
      secondToken = t;
      return { accessToken: "fresh-2", refreshToken: t.refreshToken, expiresAt: 3_000_000 };
    },
  });
  await again.setConnectorToken(
    "gmail.googleapis.com",
    "U1",
    {
      accessToken: "fresh",
      refreshToken: "rt-rotated",
      expiresAt: 1_000_000,
      clientRef: "org:default-org:google",
      accountType: "company",
    },
    "company",
  );
  assert.equal(await again.connectorAccessToken("gmail.googleapis.com", "U1", "company"), "fresh-2");
  assert.equal(secondToken?.refreshToken, "rt-rotated");
  assert.equal(secondToken?.clientRef, "org:default-org:google");
  assert.equal(seen.length, 1);
});

test("connector token refresh: two instances sharing the store refresh a rotating token once", async () => {
  const databaseUrl = testDatabaseUrl();
  let calls = 0;
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const refresh: OAuthRefresh = async () => {
    calls++;
    await gate;
    return { accessToken: "fresh", refreshToken: "rt-rotated", expiresAt: 1_000_000 };
  };
  const lock = testAdvisoryLock();
  const first = makeKeychain({ now: () => 10_000, skewMs: 0, refresh, databaseUrl, lock });
  const second = makeKeychain({ now: () => 10_000, skewMs: 0, refresh, databaseUrl, lock });
  await first.setConnectorToken("gmail.googleapis.com", "U1", {
    accessToken: "stale",
    refreshToken: "rt",
    expiresAt: 5_000,
  });
  const racing = [
    first.connectorAccessToken("gmail.googleapis.com", "U1"),
    second.connectorAccessToken("gmail.googleapis.com", "U1"),
  ];
  await new Promise((r) => setTimeout(r, 50));
  release();
  assert.deepEqual(await Promise.all(racing), ["fresh", "fresh"]);
  assert.equal(calls, 1, "a rotating refresh token must not be spent by both instances");
});

test("connector token refresh failures are logged and never poison the stored token", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });

  const databaseUrl = testDatabaseUrl();
  const keychain = makeKeychain({
    databaseUrl,
    now: () => 10_000,
    skewMs: 0,
    refresh: async () => ({ accessToken: "" }),
  });
  await keychain.setConnectorToken("api.github.com", "U1", {
    accessToken: "stale",
    refreshToken: "rt",
    expiresAt: 5_000,
  });

  assert.equal(await keychain.connectorAccessToken("api.github.com", "U1"), null);
  assert.deepEqual(
    await keychain.connectorTokenStatus("api.github.com", "U1"),
    {
      connected: true,
      expiresAt: 5_000,
      hasRefreshToken: true,
      needsReconnect: true,
      refreshFailedAt: 10_000,
      refreshError: "refresh returned an empty access token",
    },
    "the empty result was not stored, but the failed refresh is visible",
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /connector token refresh \(api\.github\.com\)/);

  const throwing = makeKeychain({
    databaseUrl,
    now: () => 10_000,
    skewMs: 0,
    refresh: async () => {
      throw new Error("revoked by provider");
    },
  });
  assert.equal(await throwing.connectorAccessToken("api.github.com", "U1"), null);
  assert.match(errors[1]!, /revoked by provider/);
  assert.deepEqual(await throwing.connectorTokenStatus("api.github.com", "U1"), {
    connected: true,
    expiresAt: 5_000,
    hasRefreshToken: true,
    needsReconnect: true,
    refreshFailedAt: 10_000,
    refreshError: "revoked by provider",
  });

  const recovered = makeKeychain({
    databaseUrl,
    now: () => 20_000,
    skewMs: 0,
    refresh: async (_host, t) => ({ accessToken: "fresh", refreshToken: t.refreshToken, expiresAt: 1_000_000 }),
  });
  assert.equal(await recovered.connectorAccessToken("api.github.com", "U1"), "fresh");
  assert.deepEqual(
    await recovered.connectorTokenStatus("api.github.com", "U1"),
    { connected: true, expiresAt: 1_000_000, hasRefreshToken: true },
    "a successful refresh clears prior failure metadata",
  );
});

test("connector tokens: expired non-refreshable connector tokens need reconnect", async () => {
  const keychain = makeKeychain({ now: () => 10_000, skewMs: 0 });
  await keychain.setConnectorToken("slack.com", "U1", { accessToken: "stale-slack", expiresAt: 5_000 });

  assert.equal(await keychain.connectorAccessToken("slack.com", "U1"), null);
  assert.deepEqual(await keychain.connectorTokenStatus("slack.com", "U1"), {
    connected: true,
    expiresAt: 5_000,
    needsReconnect: true,
  });
});

test("connector token keys are Postgres-safe (no NUL byte) and round-trip through Postgres", async () => {
  const keychain = makeKeychain();

  await keychain.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "tok" }, "personal");
  assert.equal(await keychain.connectorAccessToken("gmail.googleapis.com", "U1", "personal"), "tok");
  assert.equal((await keychain.connectorTokenStatus("gmail.googleapis.com", "U1", "personal")).connected, true);
  await keychain.setConnectorToken("slack.com", "U2", { accessToken: "tok2" });
  assert.equal(await keychain.connectorAccessToken("slack.com", "U2"), "tok2");

  const connectors = await keychain.listConnectorsByOwners(["U1", "U2"]);
  assert.ok(
    [...connectors.values()].flat().every((c) => !c.credentialId.includes("\u0000")),
    "connector record keys must contain no NUL byte (Postgres-incompatible)",
  );
});

test("connector token account-type sub-key: a principal holds personal AND company tokens for one host", async () => {
  const keychain = makeKeychain({ now: () => 10_000, skewMs: 0 });

  await keychain.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "legacy-default" });
  await keychain.setConnectorToken(
    "gmail.googleapis.com",
    "U1",
    { accessToken: "personal-tok", accountType: "personal" },
    "personal",
  );
  await keychain.setConnectorToken(
    "gmail.googleapis.com",
    "U1",
    { accessToken: "company-tok", accountType: "company" },
    "company",
  );

  assert.equal(await keychain.connectorAccessToken("gmail.googleapis.com", "U1"), "legacy-default");
  assert.equal(await keychain.connectorAccessToken("gmail.googleapis.com", "U1", "personal"), "personal-tok");
  assert.equal(await keychain.connectorAccessToken("gmail.googleapis.com", "U1", "company"), "company-tok");

  assert.equal((await keychain.connectorTokenStatus("gmail.googleapis.com", "U1", "company")).accountType, "company");

  await keychain.deleteConnectorToken("gmail.googleapis.com", "U1", "personal");
  assert.equal(await keychain.connectorAccessToken("gmail.googleapis.com", "U1", "personal"), null);
  assert.equal(await keychain.connectorAccessToken("gmail.googleapis.com", "U1", "company"), "company-tok");
  assert.equal(await keychain.connectorAccessToken("gmail.googleapis.com", "U1"), "legacy-default");
});

test("connector tokens are hidden from keychain listings and own-credential materialization", async () => {
  const keychain = makeKeychain({ now: () => 10_000, skewMs: 0 });
  await keychain.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "tok" });
  await keychain.save({ ownerId: "U1", service: "github", secret: "ghp_x", envKey: "GITHUB_TOKEN" });

  const listed = await keychain.listByOwner("U1");
  assert.deepEqual(
    listed.map((c) => c.service),
    ["github"],
  );
  const own = await keychain.materializeOwn("U1");
  assert.deepEqual(
    own.map((m) => m.env[0]!.key),
    ["GITHUB_TOKEN"],
  );

  const [connector] = (await keychain.listConnectorsByOwners(["U1"])).get("U1")!;
  assert.equal(await keychain.remove("U1", connector!.credentialId), false);
  assert.equal(await keychain.connectorAccessToken("gmail.googleapis.com", "U1"), "tok");
});

test("oauthRevoke: a capability token disconnects its own connector, but not a non-member's", async () => {
  const deleted: Array<{ host: string; principalId: string }> = [];
  const deps = {
    connectorTokens: {
      deleteConnectorToken: async (host: string, principalId: string) => {
        deleted.push({ host, principalId });
      },
    },
  } as unknown as Parameters<typeof oauthRevoke>[0]["deps"];
  const call = (capability: unknown, body: unknown) => {
    const out: { status?: number; body?: any } = {};
    const res = {
      getHeader() {},
      writeHead(s: number) {
        out.status = s;
      },
      end(d?: string) {
        out.body = d ? JSON.parse(d) : undefined;
      },
    };
    return respond(oauthRevoke, { res, deps, body, capability } as unknown as Parameters<typeof oauthRevoke>[0]).then(
      () => out,
    );
  };
  const cap = (actorId: string, members: string[] = []) => ({
    actorId,
    scopeId: `personal:${actorId}`,
    keychainMembers: members.map((id) => ({ id })),
    exp: 9_999_999_999,
  });

  deleted.length = 0;
  const self = await call(cap("U1"), { provider: "google" });
  assert.equal(self.status, 200);
  assert.equal(self.body.principalId, "U1");
  assert.ok(deleted.length > 0 && deleted.every((d) => d.principalId === "U1"));

  const member = await call(cap("U1", ["U2"]), { provider: "google", principalId: "U2" });
  assert.equal(member.status, 200);
  assert.equal(member.body.principalId, "U2");

  deleted.length = 0;
  const stranger = await call(cap("U1"), { provider: "google", principalId: "U9" });
  assert.equal(stranger.status, 400);
  assert.equal(deleted.length, 0);
});

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

function start(socketAppId = "A-ACME", managed = false): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(testConfig());
  const server = createInsecureTestServer(built.app, {
    oauthStateSecret: "byo-route-oauth-state-secret",
    replayDedupe: built.replayDedupe,
    connectorTokens: built.connectorTokens,
    slackInstallation: built.slackInstallation,
    ...(managed
      ? {
          managedSlack: createManagedSlack({
            serviceUrl: "https://bridge.example",
            token: "test-token",
            appId: "A123",
            store: built.slackInstallation,
          }),
        }
      : {}),
    slackWebClient: () => ({
      apiCall: async (method: string) =>
        method === "auth.test"
          ? { ok: true, team_id: "T-ACME", team: "Acme", app_id: "A-ACME" }
          : { ok: true, url: "wss://example.invalid" },
    }),
    slackInstallationSocketAppId: async () => socketAppId,
    resolveClient: built.resolveClient,
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const putConnector = (base: string, b: object) =>
  fetch(`${base}/v1/admin/scopes/org:default-org/connectors`, {
    method: "PUT",
    headers: ADMIN,
    body: JSON.stringify(b),
  });

test("the slack-installation createUrl adopts the live branding label", async () => {
  const srv = start();
  try {
    const nameFrom = async (): Promise<string> => {
      const r = (await (await fetch(`${srv.base}/v1/admin/slack-installation`, { headers: ADMIN })).json()) as {
        createUrl: string;
      };
      const manifest = JSON.parse(new URL(r.createUrl).searchParams.get("manifest_json") ?? "{}") as {
        display_information?: { name?: string };
      };
      return manifest.display_information?.name ?? "";
    };
    assert.equal(await nameFrom(), "qm");
    assert.equal(
      (
        await fetch(`${srv.base}/v1/admin/scopes/org:default-org/branding`, {
          method: "PUT",
          headers: ADMIN,
          body: JSON.stringify({ selfLabel: "straylight" }),
        })
      ).status,
      200,
    );
    assert.equal(await nameFrom(), "straylight");
  } finally {
    await srv.close();
  }
});

test("admin registers a BYO client → /start uses it; the secret is never echoed", async () => {
  const srv = start();
  try {
    const redirectUri = `${srv.base}/v1/connectors/oauth/google/callback`;
    const startPath = `/v1/connectors/oauth/google/start?principalId=U1&redirectUri=${encodeURIComponent(redirectUri)}`;

    assert.equal((await fetch(`${srv.base}${startPath}`)).status, 501);

    const putRes = await putConnector(srv.base, {
      provider: "google",
      clientId: "byo-cid",
      clientSecret: "byo-super-secret",
      redirectAllowlist: [redirectUri],
    });
    assert.equal(putRes.status, 200);

    const denied = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/connectors`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-actor": "nobody@default-org" },
      body: JSON.stringify({ provider: "google", clientId: "x", clientSecret: "y" }),
    });
    assert.equal(denied.status, 403);

    const startRes = await fetch(`${srv.base}${startPath}`);
    assert.equal(startRes.status, 200);
    const body = (await startRes.json()) as { authorizeUrl: string };
    assert.equal(new URL(body.authorizeUrl).searchParams.get("client_id"), "byo-cid");

    const cfg = (await (await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN })).json()) as {
      connectors: Array<{ provider: string; clientId: string; hasSecret: boolean }>;
    };
    const google = cfg.connectors.find((c) => c.provider === "google");
    assert.equal(google?.clientId, "byo-cid");
    assert.equal(google?.hasSecret, true);
    assert.doesNotMatch(JSON.stringify(cfg), /byo-super-secret/);

    const badPath = `/v1/connectors/oauth/google/start?principalId=U1&redirectUri=${encodeURIComponent("https://evil/cb")}`;
    const bad = await fetch(`${srv.base}${badPath}`);
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /redirect_not_allowed/);
  } finally {
    await srv.close();
  }
});

test("admin stores validated Slack tokens without ever returning them", async () => {
  const srv = start();
  try {
    const put = await fetch(`${srv.base}/v1/admin/slack-installation`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ botToken: "xoxb-super-secret", appToken: "xapp-super-secret" }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.text();
    assert.doesNotMatch(putBody, /xoxb|xapp|super-secret/);
    assert.match(putBody, /T-ACME/);

    const status = await fetch(`${srv.base}/v1/admin/slack-installation`, { headers: ADMIN });
    assert.equal(status.status, 200);
    const statusText = await status.text();
    assert.doesNotMatch(statusText, /xoxb|xapp|super-secret/);
    const createUrl = new URL((JSON.parse(statusText) as { createUrl: string }).createUrl);
    assert.equal(createUrl.searchParams.get("new_app"), "1");
    assert.equal(JSON.parse(createUrl.searchParams.get("manifest_json")!).display_information.name, "qm");
    assert.equal((await srv.built.slackInstallation.get())?.botToken, "xoxb-super-secret");

    const del = await fetch(`${srv.base}/v1/admin/slack-installation`, { method: "DELETE", headers: ADMIN });
    assert.equal(del.status, 200);
    assert.equal(await srv.built.slackInstallation.get(), null);
  } finally {
    await srv.close();
  }
});

test("admin rejects Slack bot and Socket Mode tokens from different apps", async () => {
  const srv = start("A-OTHER");
  try {
    const put = await fetch(`${srv.base}/v1/admin/slack-installation`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ botToken: "xoxb-super-secret", appToken: "xapp-super-secret" }),
    });
    assert.equal(put.status, 400);
    assert.match(await put.text(), /different Slack apps/);
    assert.equal(await srv.built.slackInstallation.get(), null);
  } finally {
    await srv.close();
  }
});

test("disabling a BYO connector grays it out in the app-grid status", async () => {
  const srv = start();
  try {
    await putConnector(srv.base, { provider: "google", clientId: "c", clientSecret: "s", enabled: true });
    const statusPath = "/v1/connectors/oauth/status?principalId=U1";
    let st = (await (await fetch(`${srv.base}${statusPath}`)).json()) as {
      providers: Record<string, { configured: boolean }>;
    };
    assert.equal(st.providers.google!.configured, true);

    await putConnector(srv.base, { provider: "google", clientId: "c", clientSecret: "s", enabled: false });
    st = (await (await fetch(`${srv.base}${statusPath}`)).json()) as {
      providers: Record<string, { configured: boolean }>;
    };
    assert.equal(st.providers.google!.configured, false);
  } finally {
    await srv.close();
  }
});

test("the catalog endpoint exposes per-provider setup guidance (no secrets)", async () => {
  const srv = start();
  try {
    const { catalog } = (await (await fetch(`${srv.base}/v1/connectors/catalog`)).json()) as {
      catalog: Array<{ provider: string; setupGuide: { url: string; steps: string[] }; consentMode: string }>;
    };
    const names = catalog.map((c) => c.provider).sort();
    assert.deepEqual(names, ["dropbox", "github", "google", "linear", "notion", "slack", "x", "zoom"]);
    const google = catalog.find((c) => c.provider === "google")!;
    assert.ok(google.setupGuide.steps.length >= 3);
    assert.match(google.setupGuide.url, /^https:\/\//);
    assert.equal(catalog.find((c) => c.provider === "github")!.consentMode, "github_app");
  } finally {
    await srv.close();
  }
});

test("managed deployments accept validated own apps and preserve credentials on invalid replacement", async () => {
  const srv = start("A-ACME", true);
  try {
    await srv.built.slackInstallation.setManaged({
      botToken: "xoxb-managed",
      appId: "A123",
      teamId: "T-ACME",
      installId: "I1",
      installedAt: 1,
    });
    const put = (botToken: string) =>
      fetch(`${srv.base}/v1/admin/slack-installation`, {
        method: "PUT",
        headers: ADMIN,
        body: JSON.stringify({ botToken, appToken: "xapp-own" }),
      });
    assert.equal((await put("invalid")).status, 400);
    assert.equal((await srv.built.slackInstallation.get())?.botToken, "xoxb-managed");
    assert.equal((await put("xoxb-own")).status, 200);
    const status = (await (await fetch(`${srv.base}/v1/admin/slack-installation`, { headers: ADMIN })).json()) as {
      source: string;
      installAvailable: boolean;
      createUrl: string;
    };
    assert.equal(status.source, "admin");
    assert.equal(status.installAvailable, true);
    assert.equal(new URL(status.createUrl).searchParams.get("new_app"), "1");
    assert.equal((await srv.built.slackInstallation.get())?.botToken, "xoxb-own");
  } finally {
    await srv.close();
  }
});
