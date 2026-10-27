import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configuredConnectorProviders,
  connectorLabel,
  connectorStatusIsStale,
  refreshConnectorStatus,
  type ConnectorStatusRecord,
} from "../../src/credentials/connector-status.ts";
import type { ConnectorTokenStore, OAuthTokenStatus } from "../../src/credentials/keychain.ts";
import { ConnectorNotConfiguredError, setPublicOAuthClients } from "../../src/connectors/oauth.ts";

function fakeTokens(status: (host: string, accountType?: string) => OAuthTokenStatus): ConnectorTokenStore {
  return {
    connectorTokenStatus: async (host: string, _principalId: string, accountType?: string) => status(host, accountType),
  } as unknown as ConnectorTokenStore;
}

test("staleness: null/over-floor/past-expiry are stale; fresh+unexpired is not", () => {
  const now = 1_000_000;
  assert.equal(connectorStatusIsStale(null, now), true);
  const overFloor: ConnectorStatusRecord = { principalId: "U1", checkedAt: now - 20 * 60_000, providers: {} };
  assert.equal(connectorStatusIsStale(overFloor, now), true);
  const expired: ConnectorStatusRecord = {
    principalId: "U1",
    checkedAt: now - 1000,
    providers: { google: { connected: true, expiresAt: now - 1 } },
  };
  assert.equal(connectorStatusIsStale(expired, now), true);
  const fresh: ConnectorStatusRecord = {
    principalId: "U1",
    checkedAt: now - 1000,
    providers: { google: { connected: true, expiresAt: now + 60_000 }, slack: { connected: false } },
  };
  assert.equal(connectorStatusIsStale(fresh, now), false);
});

test("staleness: a token already expired AT refresh time does not make every check stale (no refresh loop)", () => {
  const now = 1_000_000;
  const refreshedAfterExpiry: ConnectorStatusRecord = {
    principalId: "U1",
    checkedAt: now - 1000,
    providers: { google: { connected: true, expiresAt: now - 5000 } },
  };
  assert.equal(
    connectorStatusIsStale(refreshedAfterExpiry, now),
    false,
    "expiry before checkedAt means another refresh learns nothing — wait for the TTL instead",
  );
  assert.equal(
    connectorStatusIsStale(refreshedAfterExpiry, now + 20 * 60_000),
    true,
    "the TTL floor still forces an eventual re-check",
  );
});

test("refresh: marks a provider connected from the token store and records the soonest expiry", async () => {
  const now = 500;
  const tokens = fakeTokens((host) =>
    host === "slack.com" ? { connected: true, expiresAt: 9999 } : { connected: false },
  );
  const rec = await refreshConnectorStatus(tokens, "U1", now);
  assert.equal(rec.checkedAt, now);
  assert.equal(rec.providers.slack?.connected, true);
  assert.equal(rec.providers.slack?.expiresAt, 9999);
  assert.equal(rec.providers.google?.connected, false);
});

test("refresh: a provider with multiple hosts uses the soonest connected expiry", async () => {
  const tokens = fakeTokens((host) => {
    if (host === "gmail.googleapis.com") return { connected: true, expiresAt: 5000 };
    if (host === "sheets.googleapis.com") return { connected: true, expiresAt: 3000 };
    return { connected: false };
  });
  const rec = await refreshConnectorStatus(tokens, "U1", 1);
  assert.equal(rec.providers.google?.connected, true);
  assert.equal(rec.providers.google?.expiresAt, 3000);
});

test("refresh: carries reconnect-needed and refresh failure metadata", async () => {
  const tokens = fakeTokens((host) =>
    host === "api.github.com"
      ? {
          connected: true,
          expiresAt: 100,
          hasRefreshToken: true,
          needsReconnect: true,
          refreshFailedAt: 600,
          refreshError: "revoked by provider",
        }
      : { connected: false },
  );

  const rec = await refreshConnectorStatus(tokens, "U1", 1_000);
  assert.deepEqual(rec.providers.github, {
    connected: true,
    expiresAt: 100,
    needsReconnect: true,
    refreshFailedAt: 600,
    refreshError: "revoked by provider",
  });
});

test("refresh: chooses a usable account status over a lapsed account for the same host", async () => {
  const tokens = fakeTokens((host, accountType) => {
    if (host !== "gmail.googleapis.com") return { connected: false };
    if (accountType === "personal") return { connected: true, expiresAt: 5000, accountType: "personal" };
    return {
      connected: true,
      expiresAt: 100,
      needsReconnect: true,
      refreshFailedAt: 300,
      refreshError: "default token revoked",
    };
  });

  const rec = await refreshConnectorStatus(tokens, "U1", 1_000);
  assert.equal(rec.providers.google?.connected, true);
  assert.equal(rec.providers.google?.expiresAt, 5000);
  assert.equal(rec.providers.google?.needsReconnect, undefined);
  assert.equal(rec.providers.google?.refreshFailedAt, undefined);
});

test("labels: known providers get friendly names; unknown is capitalized", () => {
  assert.equal(connectorLabel("google"), "Google");
  assert.equal(connectorLabel("github"), "GitHub");
  assert.equal(connectorLabel("acme"), "Acme");
});

test("refresh includes linked per-user MCP sign-ins and skips unlinked ones", async (t) => {
  t.after(() => setPublicOAuthClients([]));
  const client = (name: string, label: string) => ({
    name,
    host: `api.${name}.example`,
    authUrl: `https://id.${name}.example/authorize`,
    tokenUrl: `https://id.${name}.example/token`,
    scopes: [`${name}:write`],
    clientId: "public-client",
    label,
  });
  setPublicOAuthClients([client("orders", "Orders"), client("other", "Other")]);
  const rec = await refreshConnectorStatus(
    fakeTokens((host) => (host === "api.orders.example" ? { connected: true } : { connected: false })),
    "U1",
    1,
  );
  assert.deepEqual(rec.providers.orders, { connected: true, mcpLabel: "Orders" });
  assert.equal(rec.providers.other, undefined);
});

test("configured providers: unconfigured ones drop out quietly and resolver failures are logged", async (t) => {
  const warnings = t.mock.method(console, "warn", () => undefined);
  const configured = await configuredConnectorProviders(async (provider) => {
    if (provider === "github") return { id: "id", secret: "secret", clientRef: "env:github" };
    if (provider === "linear") throw new Error("connector store unreachable");
    throw new ConnectorNotConfiguredError(`provider not configured: ${provider}`);
  });
  assert.deepEqual(configured, ["github"]);
  const logged = warnings.mock.calls.map((call) => String(call.arguments[0]));
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /linear client: connector store unreachable/);
});
