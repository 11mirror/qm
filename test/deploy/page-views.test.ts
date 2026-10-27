import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DEPLOYMENTS_MIGRATION } from "../../src/deploy/deploy-store.ts";
import { mkdtempSync } from "node:fs";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAclStore } from "../../src/acl/acl-store.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";
import { createApp } from "../../src/api/app.ts";
import { createInsecureTestServer } from "../../src/api/server.ts";
import { createDeployService } from "../../src/deploy/deploy-service.ts";
import { createDeployStore } from "../../src/deploy/deploy-store.ts";
import { type AppPageView, type AppPageViewLog, createPostgresAppPageViewLog } from "../../src/deploy/page-views.ts";
import { createPostgresDirectoryStore } from "../../src/directory/postgres-directory-store.ts";
import type { FeatureFlagStore } from "../../src/feature-flags.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { scopeId } from "../../src/types.ts";
import { singleProcessDeps } from "../support/single-process.ts";
import { testDatabaseUrl, testDeployBackings, testMap } from "../support/test-database.ts";

const SESSION_SECRET = "portal-session-secret";
const LOGIN_URL = "https://portal.example.com";
const HOST = "mysite.apps.example.com";
const auditLog = { record() {}, events: async () => [], tail: async () => [] };

function session(sub: string, appOnly?: true): string {
  const key = createHmac("sha256", SESSION_SECRET).update("portal.session.v1").digest();
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({ k: "session", sub, org: "acme", iat: now, exp: now + 3600, ...(appOnly ? { appOnly } : {}) }),
  ).toString("base64url");
  return `portal_session=${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

function get(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "localhost", port, path, method: "GET", headers: { Host: HOST, ...headers } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function harness(log: AppPageViewLog) {
  const upstream = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("UPSTREAM OK");
  });
  upstream.listen(0);
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const deploy = createDeployService({
    ...singleProcessDeps(),
    externalSharingAllowed: async () => true,
    deployStore: createDeployStore(testDeployBackings()),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: upstreamPort }),
      resolveEndpoint: async (d) => d.endpoint,
      logs: async () => null,
      destroy: async () => {},
    },
    auditLog,
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "page-views-")),
  });
  const app = createApp({
    deploy,
    acl,
    directory: createPostgresDirectoryStore(testDatabaseUrl()),
    sessions: createPostgresSessionStore(testDatabaseUrl()),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
  } as unknown as Parameters<typeof createApp>[0]);
  const deployed = await app.deploy({
    ownerScopeId: scopeId("personal", "alice@example.com"),
    createdBy: "alice@example.com",
    entrypoint: "x",
    files: [],
    name: "mysite",
  });
  const server = createInsecureTestServer(app, {
    featureFlags: { enabled: async () => true } as unknown as FeatureFlagStore,
    deployAppsDomain: "apps.example.com",
    deployGateSecret: "gate-secret",
    deployAppsSessionSecret: SESSION_SECRET,
    deployAppsLoginUrl: LOGIN_URL,
    appPageViews: log,
  });
  server.listen(0);
  return {
    app,
    deploymentId: (deployed as { id: string }).id,
    port: (server.address() as AddressInfo).port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("page loads of a published app are recorded with viewer, auth mode and request basics", async () => {
  const views: AppPageView[] = [];
  const h = await harness({ record: async (view) => void views.push(view) });
  try {
    const owner = await get(h.port, "/reports?token=secret", {
      Accept: "text/html",
      Cookie: session("alice@example.com"),
      "User-Agent": "test-agent/1",
      "x-qm-app-host": "1",
      "x-qm-client-ip": "203.0.113.7",
    });
    assert.equal(owner.status, 200);
    await settle();
    assert.equal(views.length, 1);
    const [view] = views;
    assert.equal(view!.deploymentId, h.deploymentId);
    assert.equal(view!.viewer, "alice@example.com");
    assert.equal(view!.authMode, "signed_in");
    assert.equal(view!.path, "/reports", "the query string is never stored");
    assert.equal(view!.ip, "203.0.113.7");
    assert.equal(view!.userAgent, "test-agent/1");
    assert.equal(typeof view!.version, "number");
    assert.ok(Math.abs(view!.at - Date.now()) < 10_000);

    const assetHeaders: Record<string, string>[] = [
      { Accept: "*/*", "Sec-Fetch-Dest": "script" },
      { Accept: "application/json" },
      { Accept: "text/html", "Sec-Fetch-Dest": "image" },
    ];
    for (const headers of assetHeaders) {
      const asset = await get(h.port, "/app.js", { ...headers, Cookie: session("alice@example.com") });
      assert.equal(asset.status, 200);
    }
    await settle();
    assert.equal(views.length, 1, "static assets and API calls are not page views");

    await get(h.port, "/", { Accept: "text/html", Cookie: session("mallory@example.com") });
    await get(h.port, "/", { Accept: "text/html" });
    await settle();
    assert.equal(views.length, 1, "denied and signed-out requests that never reach the app are not recorded");

    await h.app.setDeploymentPublic("mysite", true, { createdBy: "alice@example.com" });
    await get(h.port, "/", { Accept: "text/html", "x-qm-client-ip": "198.51.100.9" });
    await get(h.port, "/", { Accept: "text/html", Cookie: session("mallory@example.com") });
    await get(h.port, "/", { Accept: "text/html", Cookie: session("guest@example.org", true) });
    await settle();
    assert.deepEqual(
      views.slice(1).map((v) => [v.viewer, v.authMode]),
      [
        [null, "public"],
        ["mallory@example.com", "public"],
        ["guest@example.org", "app_only"],
      ],
    );
    assert.notEqual(views[1]!.ip, "198.51.100.9", "a client IP header is only trusted from the app gateway");
  } finally {
    await h.close();
  }
});

test("the owner's framed shell counts once, not again for the inner app frame", async () => {
  const views: AppPageView[] = [];
  const h = await harness({ record: async (view) => void views.push(view) });
  try {
    const shell = await get(h.port, "/", {
      Accept: "text/html",
      "Sec-Fetch-Dest": "document",
      Cookie: session("alice@example.com"),
    });
    assert.equal(shell.status, 200);
    const inner = await get(h.port, "/", {
      Accept: "text/html",
      "Sec-Fetch-Dest": "iframe",
      "Sec-Fetch-Site": "same-origin",
      Cookie: session("alice@example.com"),
    });
    assert.equal(inner.status, 200);
    await settle();
    assert.equal(views.length, 1);
    assert.equal(views[0]!.authMode, "signed_in");
  } finally {
    await h.close();
  }
});

test("a failing page-view log never blocks the page and is reported", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  const h = await harness({ record: async () => Promise.reject(new Error("db down")) });
  try {
    const page = await get(h.port, "/", { Accept: "text/html", Cookie: session("alice@example.com") });
    assert.equal(page.status, 200);
    assert.equal(page.body, "UPSTREAM OK");
    await settle();
    assert.ok(errors.some((line) => line.includes("app page view log") && line.includes("db down")));
  } finally {
    console.error = original;
    await h.close();
  }
});

const URL = process.env.DATABASE_URL!;
const view = () => ({
  deploymentId: "dep-1",
  version: null,
  viewer: null,
  authMode: "public" as const,
  at: 1_700_000_000_002,
  path: "/",
  ip: null,
  userAgent: null,
});

test("pg page-view log stores one row per view with clipped request fields", async () => {
  const pg = (await import("pg")).default;
  const admin = new pg.Pool({ connectionString: URL });
  try {
    await admin.query("DROP TABLE IF EXISTS app_page_views CASCADE");
    await admin.query("DELETE FROM qm_schema_migrations WHERE id LIKE 'deploy/app-page-views/%'").catch(() => {});
    const schema = createPgPool(URL, [DEPLOYMENTS_MIGRATION]);
    await schema.pool();
    await schema.close();
    await admin.query(
      `INSERT INTO deployments (id, owner_scope_id, created_by, current_version, status, versions)
       VALUES ('dep-1', 'org:o', 'U1', 1, 'stopped', '[]') ON CONFLICT (id) DO NOTHING`,
    );
    const log = createPostgresAppPageViewLog(URL);
    await log.record({
      deploymentId: "dep-1",
      version: 3,
      viewer: "alice@example.com",
      authMode: "signed_in",
      at: 1_700_000_000_000,
      path: "/reports",
      ip: "203.0.113.7",
      userAgent: "ua".repeat(400),
    });
    await log.record({
      deploymentId: "dep-1",
      version: null,
      viewer: null,
      authMode: "public",
      at: 1_700_000_000_001,
      path: `/${"p".repeat(5000)}`,
      ip: null,
      userAgent: null,
    });
    const { rows } = await admin.query(
      "SELECT deployment_id, version, viewer, auth_mode, at, path, ip, user_agent FROM app_page_views ORDER BY at",
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(
      { ...rows[0], at: Number(rows[0].at), user_agent: rows[0].user_agent.length },
      {
        deployment_id: "dep-1",
        version: 3,
        viewer: "alice@example.com",
        auth_mode: "signed_in",
        at: 1_700_000_000_000,
        path: "/reports",
        ip: "203.0.113.7",
        user_agent: 512,
      },
    );
    assert.equal(rows[1].viewer, null);
    assert.equal(rows[1].auth_mode, "public");
    assert.equal(rows[1].path.length, 2048);
    assert.equal(rows[1].ip, null);
    await assert.rejects(
      log.record({ ...view(), deploymentId: "no-such-app" }),
      (err: { code?: string }) => err.code === "23503",
    );
    await assert.rejects(
      admin.query("DELETE FROM deployments WHERE id = 'dep-1'"),
      (err: { code?: string }) => err.code === "23503",
    );
  } finally {
    await admin.query("DROP TABLE IF EXISTS app_page_views CASCADE").catch(() => {});
    await admin.query("DELETE FROM deployments WHERE id = 'dep-1'").catch(() => {});
    await admin.end();
  }
});
