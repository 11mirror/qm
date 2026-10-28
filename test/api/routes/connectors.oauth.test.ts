import "../../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "../../../src/api/server.ts";
import {
  mintCapabilityToken,
  CAPABILITY_TTL_MS,
  OAUTH_CONSENT_AUD,
  CONTROL_PLANE_AUD,
} from "../../../src/auth/capability-token.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../../src/auth/portal-identity.ts";
import { signRequest } from "../../../plugins/chassis/src/source-auth-sign.ts";
import { PROVIDERS, setPublicOAuthClients, type FetchLike, openOAuthState } from "../../../src/connectors/oauth.ts";
import type { BuiltApp } from "../../../src/wiring.ts";
import { buildApp } from "../../support/build-app.ts";
import { settle } from "../../support/settle.ts";
import { testConfig } from "../../support/test-config.ts";
import { listenLocal } from "../../support/listen-local.ts";

const SECRET = "oauth-route-test-secret".repeat(3);
const oauthEnv = {
  GOOGLE_OAUTH_CLIENT_ID: "gid",
  GOOGLE_OAUTH_CLIENT_SECRET: "gsecret",
} as NodeJS.ProcessEnv;

function sign(method: string, pathWithQuery: string, body = ""): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, `${method}\n${pathWithQuery}\n${body}`),
  };
}

function start(
  fetchImpl: FetchLike,
  opts: { oauthEnv?: NodeJS.ProcessEnv } = {},
): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(testConfig({}));
  const server = createServer(built.app, {
    signingSecret: SECRET,
    replayDedupe: built.replayDedupe,
    connectorTokens: built.connectorTokens,
    oauthFlows: built.oauthFlows,
    auditLog: built.auditLog,
    oauthEnv: opts.oauthEnv ?? oauthEnv,
    oauthFetch: fetchImpl,
  });
  const base = listenLocal(server);
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("OAuth start, unsigned callback, status, and revoke are principal-bound", async () => {
  let exchanged = false;
  const fetchImpl: FetchLike = async (url, init) => {
    exchanged = true;
    assert.equal(url, PROVIDERS.google!.tokenUrl);
    assert.match(init.body, /grant_type=authorization_code/);
    assert.match(init.body, /code=code-123/);
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "at-google", refresh_token: "rt-google", expires_in: 3600 }),
    };
  };

  const srv = start(fetchImpl);
  try {
    const redirectUri = `${srv.base}/v1/connectors/oauth/google/callback`;
    const startPath = `/v1/connectors/oauth/google/start?principalId=U1&redirectUri=${encodeURIComponent(redirectUri)}`;
    const startRes = await fetch(`${srv.base}${startPath}`, { headers: sign("GET", startPath) });
    assert.equal(startRes.status, 200);
    const startBody = (await startRes.json()) as { authorizeUrl: string; hosts: string[] };
    assert.deepEqual(startBody.hosts, PROVIDERS.google!.hosts);
    const consent = new URL(startBody.authorizeUrl);
    const state = consent.searchParams.get("state");
    assert.ok(state);
    assert.equal(consent.searchParams.get("client_id"), "gid");

    const callbackPath = `/v1/connectors/oauth/google/callback?code=code-123&state=${encodeURIComponent(state)}`;
    const callbackRes = await fetch(`${srv.base}${callbackPath}`);
    assert.equal(callbackRes.status, 200);
    assert.equal(exchanged, true);
    const replay = await fetch(`${srv.base}${callbackPath}`);
    assert.equal(replay.status, 400);
    assert.match(((await replay.json()) as { message: string }).message, /already used|invalid OAuth state/);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1"), "at-google");
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U2"), null);

    const statusPath = "/v1/connectors/oauth/status?principalId=U1";
    const statusRes = await fetch(`${srv.base}${statusPath}`, { headers: sign("GET", statusPath) });
    assert.equal(statusRes.status, 200);
    const statusBody = await statusRes.text();
    assert.match(statusBody, /"google"/);
    assert.match(statusBody, /"connected":true/);
    assert.doesNotMatch(statusBody, /at-google|rt-google/);

    const revokeBody = JSON.stringify({ principalId: "U1", provider: "google" });
    const revokeRes = await fetch(`${srv.base}/v1/connectors/oauth/revoke`, {
      method: "POST",
      headers: sign("POST", "/v1/connectors/oauth/revoke", revokeBody),
      body: revokeBody,
    });
    assert.equal(revokeRes.status, 200);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1"), null);
  } finally {
    await srv.close();
  }
});

test("revoke clears a connector linked under a non-default account type", async () => {
  const srv = start(async () => {
    throw new Error("no token exchange expected");
  });
  try {
    await srv.built.connectorTokens.setConnectorToken(
      "gmail.googleapis.com",
      "U1",
      { accessToken: "at-company", expiresAt: Date.now() + 3_600_000 },
      "company",
    );

    const statusPath = "/v1/connectors/oauth/status?principalId=U1";
    const before = (await (await fetch(`${srv.base}${statusPath}`, { headers: sign("GET", statusPath) })).json()) as {
      providers: Record<string, { connected?: boolean }>;
    };
    assert.equal(before.providers.google?.connected, true);

    const revokeBody = JSON.stringify({ principalId: "U1", provider: "google" });
    const revokeRes = await fetch(`${srv.base}/v1/connectors/oauth/revoke`, {
      method: "POST",
      headers: sign("POST", "/v1/connectors/oauth/revoke", revokeBody),
      body: revokeBody,
    });
    assert.equal(revokeRes.status, 200);

    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1", "company"), null);
    const after = (await (await fetch(`${srv.base}${statusPath}`, { headers: sign("GET", statusPath) })).json()) as {
      providers: Record<string, { connected?: boolean }>;
    };
    assert.equal(after.providers.google?.connected, false);
  } finally {
    await srv.close();
  }
});

test("OAuth status reports expired non-refreshable connectors as reconnect-needed", async () => {
  const srv = start(async () => {
    throw new Error("no token exchange expected");
  });
  try {
    await srv.built.connectorTokens.setConnectorToken("slack.com", "U1", { accessToken: "stale-slack", expiresAt: 1 });

    const statusPath = "/v1/connectors/oauth/status?principalId=U1";
    const statusRes = await fetch(`${srv.base}${statusPath}`, { headers: sign("GET", statusPath) });
    assert.equal(statusRes.status, 200);
    const status = (await statusRes.json()) as {
      providers: Record<string, { connected?: boolean; needsReconnect?: boolean }>;
    };
    assert.equal(status.providers.slack?.connected, false);
    assert.equal(status.providers.slack?.needsReconnect, true);
  } finally {
    await srv.close();
  }
});

test("OAuth callback rejects forged state even without source-auth", async () => {
  const srv = start(async () => {
    throw new Error("must not exchange forged state");
  });
  try {
    const res = await fetch(`${srv.base}/v1/connectors/oauth/google/callback?code=abc&state=forged`);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /oauth_callback_failed/);
  } finally {
    await srv.close();
  }
});

const X_ENV = { X_OAUTH_CLIENT_ID: "xid", X_OAUTH_CLIENT_SECRET: "xsecret" } as NodeJS.ProcessEnv;
const X_STATE_LIMIT = 500;

test("authorize state stays inside the tightest provider limit and still carries the PKCE verifier", async () => {
  let body = "";
  const srv = start(
    async (_url, init) => {
      body = init.body;
      return { ok: true, status: 200, json: async () => ({ access_token: "at-x", expires_in: 7200 }) };
    },
    { oauthEnv: X_ENV },
  );
  try {
    const redirectUri = "https://acme-portal.fly.dev/v1/connectors/oauth/x/callback";
    const query = `principalId=${encodeURIComponent("person@acme-corp.com")}&redirectUri=${encodeURIComponent(redirectUri)}&returnTo=${encodeURIComponent("/keychain")}`;
    const startPath = `/v1/connectors/oauth/x/start?${query}`;
    const startRes = await fetch(`${srv.base}${startPath}`, { headers: sign("GET", startPath) });
    assert.equal(startRes.status, 200);
    const consent = new URL(((await startRes.json()) as { authorizeUrl: string }).authorizeUrl);
    const state = consent.searchParams.get("state") ?? "";
    assert.ok(
      state.length <= X_STATE_LIMIT,
      `state is ${state.length} chars — X rejects authorize when state exceeds ${X_STATE_LIMIT}`,
    );
    assert.ok(consent.searchParams.get("code_challenge"));

    const callbackPath = `/v1/connectors/oauth/x/callback?code=code-x&state=${encodeURIComponent(state)}`;
    const cb = await fetch(`${srv.base}${callbackPath}`, { redirect: "manual" });
    assert.equal(cb.status, 302, await cb.text());
    assert.equal(cb.headers.get("location"), "/keychain?connector=x&status=connected");
    assert.match(body, /code_verifier=/);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("api.x.com", "person@acme-corp.com"), "at-x");
    const replayed = await fetch(`${srv.base}${callbackPath}`, { redirect: "manual" });
    assert.equal(replayed.status, 400, "the state is single-use");
  } finally {
    await srv.close();
  }
});

test("OAuth status lists a linked per-user MCP sign-in under its display name", async (t) => {
  t.after(() => setPublicOAuthClients([]));
  const srv = start(async () => {
    throw new Error("no token exchange expected");
  });
  try {
    await srv.built.mcpServers.put({
      id: "orders",
      name: "Orders",
      url: "https://api.orders.example/mcp",
      auth: "oauth-user",
      credentialScope: "per-user",
      credentialHost: "api.orders.example",
      clientId: "public-client",
      oauthAuthorizeUrl: "https://id.orders.example/authorize",
      oauthTokenUrl: "https://id.orders.example/token",
      oauthScopes: ["orders:write"],
      readOnly: false,
      enabled: true,
      updatedAt: 0,
      updatedBy: "internal:admin",
    });
    await srv.built.mcpToolService.refresh();
    const statusPath = "/v1/connectors/oauth/status?principalId=U1";
    const read = async () => {
      const res = await fetch(`${srv.base}${statusPath}`, { headers: sign("GET", statusPath) });
      assert.equal(res.status, 200);
      return (await res.json()) as {
        providers: Record<string, { connected?: boolean; mcpLabel?: string; available?: boolean }>;
      };
    };
    assert.equal((await read()).providers.orders, undefined, "unlinked MCP sign-ins stay out of the list");

    await srv.built.connectorTokens.setConnectorToken("api.orders.example", "U1", {
      accessToken: "orders-token",
      expiresAt: Date.now() + 3_600_000,
    });
    let linked = (await read()).providers.orders;
    await settle(async () => (linked = (await read()).providers.orders)?.connected === true);
    assert.equal(linked?.connected, true);
    assert.equal(linked?.mcpLabel, "Orders");
    assert.equal(linked?.available, true);
  } finally {
    await srv.close();
  }
});

const OAUTH_CONSENT_BRIDGE_SECRET = "consent-bridge-secret".repeat(3);
const oauthConsentBridgeOauthEnv = {
  GOOGLE_OAUTH_CLIENT_ID: "gid",
  GOOGLE_OAUTH_CLIENT_SECRET: "gsecret",
} as NodeJS.ProcessEnv;

async function oauthConsentBridgeStart(
  fetchImpl: FetchLike,
  opts: { portalUrl?: string } = { portalUrl: "http://callback.test" },
): Promise<{ base: string; built: BuiltApp; close: () => Promise<void> }> {
  const built = buildApp(testConfig({ signingSecret: OAUTH_CONSENT_BRIDGE_SECRET }));
  await built.directory.replaceChannels(
    [
      { channelId: "C1", name: "consent", isPrivate: false },
      { channelId: "C9", name: "connectors", isPrivate: false },
    ],
    [
      { channelId: "C1", principalId: "U1" },
      { channelId: "C9", principalId: "U1" },
    ],
  );
  const server = createServer(built.app, {
    signingSecret: OAUTH_CONSENT_BRIDGE_SECRET,
    replayDedupe: built.replayDedupe,
    connectorTokens: built.connectorTokens,
    keychain: built.keychain,
    consentLinks: built.consentLinks,
    auditLog: built.auditLog,
    oauthEnv: oauthConsentBridgeOauthEnv,
    oauthFetch: fetchImpl,
    publicUrl: "http://callback.test",
    ...(opts.portalUrl ? { portalUrl: opts.portalUrl } : {}),
  });
  const base = listenLocal(server);
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const consentTok = async (actorId: string, opts: { scopeId?: string } = {}) => {
  return await mintCapabilityToken(
    {
      actorId,
      scopeId: opts.scopeId ?? `personal:${actorId}`,
      aud: OAUTH_CONSENT_AUD,
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    OAUTH_CONSENT_BRIDGE_SECRET,
  );
};
const controlTok = async (actorId: string) =>
  await mintCapabilityToken(
    { actorId, scopeId: `personal:${actorId}`, aud: CONTROL_PLANE_AUD, exp: Date.now() + CAPABILITY_TTL_MS },
    OAUTH_CONSENT_BRIDGE_SECRET,
  );

const coreRedeemPath = (connectPath: string): string =>
  connectPath.replace(/^\/connect\/redeem\//, "/v1/connectors/oauth/consent/redeem/");

async function redeem(
  base: string,
  path: string,
  clicker?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const ts = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    "x-timestamp": String(ts),
    "x-signature": signRequest(OAUTH_CONSENT_BRIDGE_SECRET, ts, `GET\n${path}\n`),
    ...(clicker
      ? {
          [PORTAL_IDENTITY_HEADER]: await mintPortalIdentity(
            { p: clicker, exp: Date.now() + 60_000 },
            OAUTH_CONSENT_BRIDGE_SECRET,
          ),
        }
      : {}),
    ...extraHeaders,
  };
  return fetch(`${base}${path}`, { headers });
}

async function mint(base: string, cap: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/v1/connectors/oauth/consent/mint`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-capability": cap },
    body: JSON.stringify(body),
  });
}

test("mint → intended teammate redeems → callback connects them; the link is then single-use", async () => {
  let exchanged = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    exchanged++;
    assert.equal(url, PROVIDERS.google!.tokenUrl);
    assert.match(init.body, /grant_type=authorization_code/);
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "at-google", refresh_token: "rt", expires_in: 3600 }),
    };
  };
  const srv = await oauthConsentBridgeStart(fetchImpl);
  try {
    const mintRes = await mint(srv.base, await consentTok("U1"), { provider: "google" });
    assert.equal(mintRes.status, 200);
    const { connectPath, connectUrl } = (await mintRes.json()) as { connectPath: string; connectUrl: string };
    assert.match(connectPath, /^\/connect\/redeem\//);
    assert.equal(connectUrl, `http://callback.test${connectPath}`);

    const res = await redeem(srv.base, coreRedeemPath(connectPath), "U1");
    assert.equal(res.status, 200);
    const decision = (await res.json()) as { status: string; authorizeUrl: string };
    assert.equal(decision.status, "authorize");
    const consent = new URL(decision.authorizeUrl);
    assert.equal(consent.origin + consent.pathname, PROVIDERS.google!.authUrl);
    assert.equal(consent.searchParams.get("client_id"), "gid");
    const state = await openOAuthState(consent.searchParams.get("state") ?? "", {
      secret: OAUTH_CONSENT_BRIDGE_SECRET,
    });
    assert.equal(state.principalId, "U1");
    assert.equal(state.orgId, "default-org");

    const second = await redeem(srv.base, coreRedeemPath(connectPath), "U1");
    assert.equal(
      ((await second.json()) as { status: string }).status,
      "authorize",
      "a re-click before the user finishes Google still mints",
    );

    const cb = `/v1/connectors/oauth/google/callback?code=code-1&state=${encodeURIComponent(consent.searchParams.get("state") ?? "")}`;
    const cbRes = await fetch(`${srv.base}${cb}`, { redirect: "manual" });
    assert.equal(cbRes.status, 302);
    assert.match(cbRes.headers.get("location") ?? "", /^\/connectors\?connector=google&status=connected/);
    assert.equal(exchanged, 1);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1"), "at-google");

    const third = await redeem(srv.base, coreRedeemPath(connectPath), "U1");
    assert.equal(
      ((await third.json()) as { status: string }).status,
      "invalid",
      "the link is consumed once the connection completes",
    );
  } finally {
    await srv.close();
  }
});

test("redeem refuses without a verified clicker (the portal's session gate)", async () => {
  const srv = await oauthConsentBridgeStart(async () => {
    throw new Error("must not exchange");
  });
  try {
    const mintRes = await mint(srv.base, await consentTok("U1"), { provider: "google" });
    const { connectPath } = (await mintRes.json()) as { connectPath: string };
    const res = await redeem(srv.base, coreRedeemPath(connectPath));
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("redeem ignores an unsigned clicker header: only the signed portal identity names the clicker", async () => {
  const srv = await oauthConsentBridgeStart(async () => {
    throw new Error("must not exchange");
  });
  try {
    const mintRes = await mint(srv.base, await consentTok("U1"), { provider: "google" });
    const { connectPath } = (await mintRes.json()) as { connectPath: string };
    const forged = await redeem(srv.base, coreRedeemPath(connectPath), undefined, { "x-consent-clicker": "U1" });
    assert.equal(forged.status, 401, "a source-signed caller can no longer name the clicker in a header");
    const mixed = await redeem(srv.base, coreRedeemPath(connectPath), "U2", { "x-consent-clicker": "U1" });
    assert.equal(((await mixed.json()) as { status: string }).status, "wrong_recipient");
  } finally {
    await srv.close();
  }
});

test("a wrong-recipient click is refused, leaves the link usable, and reports whether they're already connected", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: "at-google", refresh_token: "rt", expires_in: 3600 }),
  });
  const srv = await oauthConsentBridgeStart(fetchImpl, { portalUrl: "http://callback.test" });
  try {
    const cap = await consentTok("U1", { scopeId: "channel:C1" });
    const mintRes = await mint(srv.base, cap, { provider: "google", intendedPrincipalId: "U1" });
    const { connectPath } = (await mintRes.json()) as { connectPath: string };

    const wrong = (await (await redeem(srv.base, coreRedeemPath(connectPath), "U2")).json()) as {
      status: string;
      provider: string;
      clickerConnected: boolean;
    };
    assert.equal(wrong.status, "wrong_recipient");
    assert.equal(wrong.provider, "google");
    assert.equal(wrong.clickerConnected, false);

    await srv.built.connectorTokens.setConnectorToken("gmail.googleapis.com", "U2", {
      accessToken: "ya29.u2",
      expiresAt: Date.now() + 3_600_000,
    });
    const already = (await (await redeem(srv.base, coreRedeemPath(connectPath), "U2")).json()) as {
      status: string;
      clickerConnected: boolean;
    };
    assert.equal(already.status, "wrong_recipient");
    assert.equal(already.clickerConnected, true);

    const ok = (await (await redeem(srv.base, coreRedeemPath(connectPath), "U1")).json()) as { status: string };
    assert.equal(ok.status, "authorize");
  } finally {
    await srv.close();
  }
});

test("connecting from a channel never re-grants a previously private connector", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: "at-google", refresh_token: "rt", expires_in: 3600 }),
  });
  const srv = await oauthConsentBridgeStart(fetchImpl);
  try {
    const cap = await consentTok("U1", { scopeId: "channel:C9" });
    const mintRes = await mint(srv.base, cap, { provider: "google" });
    const { connectPath } = (await mintRes.json()) as { connectPath: string };
    const decision = (await (await redeem(srv.base, coreRedeemPath(connectPath), "U1")).json()) as {
      status: string;
      authorizeUrl: string;
    };
    assert.equal(decision.status, "authorize");
    const state = new URL(decision.authorizeUrl).searchParams.get("state") ?? "";
    const cb = `/v1/connectors/oauth/google/callback?code=code-1&state=${encodeURIComponent(state)}`;
    assert.equal((await fetch(`${srv.base}${cb}`, { redirect: "manual" })).status, 302);
    assert.equal(await srv.built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1"), "at-google");
    assert.equal((await srv.built.keychain!.grantsForScope("channel:C9")).length, 0);
  } finally {
    await srv.close();
  }
});

test("mint refuses naming anyone but the actor, and points at the self-connect page", async () => {
  const srv = await oauthConsentBridgeStart(async () => {
    throw new Error("must not exchange");
  });
  try {
    const cap = await consentTok("U1", { scopeId: "channel:C1" });
    for (const who of ["U2", "outsider@x"]) {
      const res = await mint(srv.base, cap, { provider: "google", intendedPrincipalId: who });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { message: string };
      assert.match(body.message, /\/connect\/google\/self-connect/);
    }
  } finally {
    await srv.close();
  }
});

test("on an API-only host (no PUBLIC_WEB_URL) the callback does NOT default to the web UI — it falls through to JSON", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: "at-google", refresh_token: "rt", expires_in: 3600 }),
  });
  const srv = await oauthConsentBridgeStart(fetchImpl, {});
  try {
    const mintRes = await mint(srv.base, await consentTok("U1"), { provider: "google" });
    assert.equal(mintRes.status, 200);
    const { connectPath } = (await mintRes.json()) as { connectPath: string };
    const decision = (await (await redeem(srv.base, coreRedeemPath(connectPath), "U1")).json()) as {
      status: string;
      authorizeUrl: string;
    };
    const consent = new URL(decision.authorizeUrl);
    const cb = `/v1/connectors/oauth/google/callback?code=code-1&state=${encodeURIComponent(consent.searchParams.get("state") ?? "")}`;
    const cbRes = await fetch(`${srv.base}${cb}`, { redirect: "manual" });
    assert.equal(cbRes.status, 200);
    const body = (await cbRes.json()) as { ok: boolean; provider: string };
    assert.equal(body.ok, true);
    assert.equal(body.provider, "google");
  } finally {
    await srv.close();
  }
});

test("the consent-mint route rejects a control-plane / aud-less / missing token (the cross-onramp wall)", async () => {
  const srv = await oauthConsentBridgeStart(async () => {
    throw new Error("must not exchange");
  });
  try {
    const body = JSON.stringify({ provider: "google", redirectUri: `${srv.base}/cb` });
    const headers = (cap?: string) => ({
      "content-type": "application/json",
      ...(cap ? { "x-agent-capability": cap } : {}),
    });
    assert.equal(
      (
        await fetch(`${srv.base}/v1/connectors/oauth/consent/mint`, {
          method: "POST",
          headers: headers(await controlTok("U1")),
          body,
        })
      ).status,
      403,
    );
    const audless = await mintCapabilityToken(
      { actorId: "U1", scopeId: "personal:U1", exp: Date.now() + CAPABILITY_TTL_MS },
      OAUTH_CONSENT_BRIDGE_SECRET,
    );
    assert.equal(
      (await fetch(`${srv.base}/v1/connectors/oauth/consent/mint`, { method: "POST", headers: headers(audless), body }))
        .status,
      403,
    );
    assert.equal(
      (await fetch(`${srv.base}/v1/connectors/oauth/consent/mint`, { method: "POST", headers: headers(), body }))
        .status,
      401,
    );
  } finally {
    await srv.close();
  }
});

test("an oauth-consent token cannot drive control-plane routes (crons)", async () => {
  const srv = await oauthConsentBridgeStart(async () => {
    throw new Error("must not exchange");
  });
  try {
    const res = await fetch(`${srv.base}/v1/crons`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": await consentTok("U1") },
      body: JSON.stringify({ schedule: { everyMs: 1000 }, action: "x" }),
    });
    assert.equal(res.status, 403);
  } finally {
    await srv.close();
  }
});

test("mint refuses an unconfigured provider even when PUBLIC_WEB_URL is set", async () => {
  const srv = await oauthConsentBridgeStart(async () => {
    throw new Error("must not exchange");
  });
  try {
    const res = await mint(srv.base, await consentTok("U1"), { provider: "github" });
    assert.equal(res.status, 501);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "oauth_not_configured");
  } finally {
    await srv.close();
  }
});

test("an expired consent link reports an expiry status", async () => {
  const srv = await oauthConsentBridgeStart(async () => {
    throw new Error("must not exchange");
  });
  try {
    const { linkId } = await srv.built.consentLinks.mint(
      {
        principalId: "U1",
        provider: "google",
        accountType: "default",
        redirectUri: `${srv.base}/v1/connectors/oauth/google/callback`,
      },
      Date.now() - 25 * 60 * 60_000,
    );
    const res = await redeem(srv.base, `/v1/connectors/oauth/consent/redeem/${linkId}`, "U1");
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, "expired");
  } finally {
    await srv.close();
  }
});
