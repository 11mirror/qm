import type { CapabilityClaims } from "../../src/auth/capability-token.ts";
import type { ServerResponse } from "node:http";
import { composioRoutes, composioUserId } from "../../src/api/routes/composio.ts";
import { type ApiCtx, respond } from "../../src/api/routes/route.ts";
import type { ServerDeps } from "../../src/api/deps.ts";
import { createKeychain } from "../../src/credentials/create-keychain.ts";
import { deriveConnectorKey } from "../../src/connectors/connector-client-store.ts";
import { createAclStore } from "../../src/acl/acl-store.ts";
import { scopeId } from "../../src/types.ts";
import { tenant } from "../../src/tenant.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";
import { testAdvisoryLock, testDatabaseUrl } from "./test-database.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { createKeychainStore } from "../../src/credentials/keychain-store.ts";
import { createComposioReturns, createSlackAccounts } from "../../src/connectors/composio-links.ts";

export function fakeRuns(run: Record<string, unknown>): ServerDeps["runs"] {
  return {
    get: async () => run,
    leaseHeld: async (held: { status: string; leaseToken?: string }, token: string) =>
      held.status === "running" && token === held.leaseToken,
  } as unknown as ServerDeps["runs"];
}

export function fixture() {
  const url = testDatabaseUrl();
  const keychain = createKeychain({
    lock: testAdvisoryLock(),
    store: createKeychainStore(testDatabaseUrl()),
    key: deriveConnectorKey("composio-test"),
  });
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const app = { getSessionForViewer: async (_id: string, _viewer: string): Promise<unknown> => null };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const replies: unknown[] = [];
  const audits: Array<{ action: string; resource?: string }> = [];
  const deps: Partial<ServerDeps> = {
    keychain,
    serviceCreds: keychain,
    acl,
    composioReturns: createComposioReturns(url),
    auditLog: {
      record: (e: { action: string; resource?: string }) => audits.push(e),
    } as unknown as ServerDeps["auditLog"],
    runs: fakeRuns({
      status: "running",
      sessionId: "cron:test-cron:fire:test-fire",
      attempts: 1,
      leaseToken: "test-lease",
      request: { actor: { id: "alice" } },
    }),
    composioFetch: (async (input, init) => {
      calls.push({ url: String(input), init });
      const result = replies.shift();
      if (result instanceof Error) throw result;
      if (result instanceof Response) return result;
      return Response.json(result);
    }) as typeof fetch,
  };
  async function invoke(
    path: string,
    body?: unknown,
    actor: string | null = "alice",
    capability?: CapabilityClaims,
    impersonating = false,
  ) {
    let status = 0;
    let text = "";
    const url = new URL(path, "http://localhost");
    const res = {
      setHeader() {},
      getHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        text = value;
      },
    } as unknown as ServerResponse;
    const ctx = {
      deps,
      app,
      res,
      url,
      body,
      capability,
      actor: actor ? { p: actor, exp: Date.now() + 60_000, ...(impersonating ? { imp: "admin" } : {}) } : null,
    } as ApiCtx;
    const route = composioRoutes.find((r) => "path" in r && r.path === url.pathname)!;
    await respond(route.handle, ctx);
    return { status, data: JSON.parse(text), text };
  }
  async function own(ownerId = "alice", service = "composio") {
    await keychain.save({ ownerId, service, envKey: "COMPOSIO_API_KEY", secret: "private-key" });
  }
  async function shared(granted = true, enabled = true) {
    const org = tenant().orgScope;
    await keychain.setServiceCredential(org, {
      slug: "composio",
      name: "Composio",
      delivery: "env",
      envKey: "COMPOSIO_API_KEY",
      secret: "company-key",
      host: "",
      enabled,
    });
    if (granted)
      await acl.grant({
        ownerScopeId: org,
        ref: "service-cred:composio",
        granteeScopeId: org,
        permission: "read",
        grantedBy: "admin",
      });
  }
  return { invoke, own, shared, calls, replies, deps, app, audits, url };
}

export const privateCap: CapabilityClaims = {
  runId: "test-run",
  sessionId: "test-session",
  threadRef: "cron:test-cron:fire:test-fire",
  runAttempt: 1,
  runLeaseToken: "test-lease",
  actorId: "alice",
  scopeId: "personal:alice",
  ownerConnections: true,
  liveActor: true,
  exp: Date.now() + 60_000,
};

export async function slackReplyFixture() {
  const f = fixture();
  await f.own();
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await sessions.getOrCreateByThread(
    "ch:C123:123.456",
    "channel",
    scopeId("personal", "alice"),
    undefined,
    "slack",
  );
  f.deps.sessions = sessions;
  f.app.getSessionForViewer = async (id, viewer) => (id === "session" && viewer === "alice" ? { session } : null);
  const receipts = async () =>
    (await sessions.getItems(session.id)).map((e): Record<string, unknown> => ({
      kind: e.kind,
      text: e.text,
      externalId: e.externalId,
      ...e.body,
    }));
  const slackAccounts = createSlackAccounts(f.url);
  f.deps.slackAccounts = slackAccounts;
  await slackAccounts.put({
    principalId: "alice",
    memberId: "alice",
    accountId: "ca_alice",
    userId: "U123",
    teamId: "T123",
    user: "Alice",
    workspace: "Test",
  });
  const account = {
    id: "ca_alice",
    user_id: composioUserId(tenant().orgId, "alice"),
    toolkit: { slug: "slack" },
    status: "ACTIVE",
  };
  const identity = { data: { ok: true, user_id: "U123", team_id: "T123" } };
  const message = { sessionId: "session", text: "Hello", clientMessageId: "01234567-0123-4123-8123-012345678901" };
  return { ...f, account, identity, message, sessions, receipts };
}
