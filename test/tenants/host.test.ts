import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, after, before } from "node:test";
import pg from "pg";
import {
  createHostFront,
  normalizeHost,
  proxyTarget,
  requestHost,
  routeForHost,
  type HostRoute,
  type HostTarget,
} from "../../plugins/chassis/src/tenant-hosts.ts";
import { relocateEmbeddedAuth, tenantServiceEnv } from "../../plugins/chassis/src/tenant-workers.ts";
import type { Config } from "../../src/config.ts";
import { configurePgTenancy, createPgPool, type PgPool } from "../../src/persistence/pg-pool.ts";
import { tenant, tenantFor } from "../../src/tenant.ts";
import type { BootedTenant } from "../../src/tenants/boot.ts";
import { tenantCoreEnv, tenantTarget, startMultitenant, type MultitenantHost } from "../../src/tenants/host.ts";
import { type TenantRecord, upsertTenant } from "../../src/tenants/registry.ts";
import { tenantQueue } from "../../src/turns/absurd-schema.ts";

const ACME_ID = "0f8e2c4a-1b2c-4d3e-8f90-123456789abc";

const record: TenantRecord = {
  id: ACME_ID,
  slug: "acme",
  orgId: "acme",
  hosts: ["acme.example.test"],
  status: "active",
  env: { core: { PUBLIC_API_URL: "https://acme.example.test" }, portal: { PORTAL_FAVICON_EMOJI: "A" } },
  secretEnv: { core: { CORE_SIGNING_SECRET: "core-secret" }, portal: { PORTAL_SESSION_SECRET: "portal-secret" } },
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function get(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function named(name: string): HostTarget {
  return {
    request: (_req, res) => void res.end(name),
    upgrade: (_req, socket) => void socket.end(),
  };
}

test("request host prefers the forwarded host and drops the port", () => {
  assert.equal(
    requestHost({ host: "core.internal:8080", "x-forwarded-host": "Acme.Example.test:443" }),
    "acme.example.test",
  );
  assert.equal(requestHost({ host: "acme.example.test:8080" }), "acme.example.test");
  assert.equal(requestHost({ "x-forwarded-host": "a.test, b.test", host: "c.test" }), "a.test");
  assert.equal(requestHost({}), undefined);
  assert.equal(normalizeHost("[::1]:8080"), "[::1]");
});

test("routes match exact hosts before published-app domains", () => {
  const routes: HostRoute<string>[] = [
    { hosts: ["acme.example.test"], appsDomain: "apps.acme.example.test", target: "acme" },
    { hosts: ["beta.example.test"], appsDomain: "apps.beta.example.test", target: "beta" },
  ];
  assert.equal(routeForHost(routes, "acme.example.test"), "acme");
  assert.equal(routeForHost(routes, "dash.apps.beta.example.test"), "beta");
  assert.equal(routeForHost(routes, "apps.acme.example.test"), "acme");
  assert.equal(routeForHost(routes, "evilapps.acme.example.test"), undefined);
  assert.equal(routeForHost(routes, "other.example.test"), undefined);
  assert.equal(routeForHost(routes, undefined), undefined);
});

test("the front dispatches by host and sends unknown hosts to home only for health checks", async (t) => {
  const front = createHostFront(
    () => [
      { hosts: ["acme.example.test"], target: named("acme") },
      { hosts: ["home.example.test"], target: named("home") },
    ],
    () => named("home"),
  );
  const port = await listen(front);
  t.after(() => front.close());
  assert.deepEqual(await get(port, "/v1/x", { host: "acme.example.test" }), { status: 200, body: "acme" });
  assert.deepEqual(await get(port, "/v1/x", { host: "internal", "x-forwarded-host": "home.example.test" }), {
    status: 200,
    body: "home",
  });
  assert.deepEqual(await get(port, "/healthz", { host: "10.0.0.7:8080" }), { status: 200, body: "home" });
  assert.equal((await get(port, "/v1/x", { host: "stranger.test" })).status, 404);
});

test("the proxy target keeps the original host for the tenant worker", async (t) => {
  const upstream = createServer((req, res) => res.end(String(req.headers.host)));
  const upstreamPort = await listen(upstream);
  const front = createHostFront(
    () => [{ hosts: ["acme.example.test"], target: proxyTarget(upstreamPort) }],
    () => undefined,
  );
  const port = await listen(front);
  t.after(() => {
    front.close();
    upstream.close();
  });
  assert.deepEqual(await get(port, "/", { host: "acme.example.test" }), { status: 200, body: "acme.example.test" });
});

test("a tenant target runs the tenant server inside that tenant's context", async (t) => {
  const acme = tenantFor("acme", ACME_ID, "acme");
  const server = createServer((_req, res) => res.end(`${tenant().orgId}:${tenant().id ?? ""}`));
  const front = createHostFront(
    () => [{ hosts: ["acme.example.test"], target: tenantTarget(acme, server) }],
    () => undefined,
  );
  const port = await listen(front);
  t.after(() => front.close());
  assert.deepEqual(await get(port, "/", { host: "acme.example.test" }), { status: 200, body: `acme:${ACME_ID}` });
});

test("core env overlays the tenant record on the deployment env", () => {
  const env = tenantCoreEnv({ DATABASE_URL: "postgres://db/qm", ORG_ID: "home", PORT: "8080" }, record);
  assert.equal(env.ORG_ID, "acme");
  assert.equal(env.PUBLIC_API_URL, "https://acme.example.test");
  assert.equal(env.CORE_SIGNING_SECRET, "core-secret");
  assert.equal(env.DATABASE_URL, "postgres://db/qm");
  assert.equal(env.PORTAL_SESSION_SECRET, undefined);
});

test("surface env overlays only that service and names the tenant to core", () => {
  const env = tenantServiceEnv({ CORE_ORG_ID: "home", PORT: "8097" }, record, "portal");
  assert.equal(env.CORE_ORG_ID, "acme");
  assert.equal(env.CORE_TENANT_HOST, "acme.example.test");
  assert.equal(env.PORTAL_SESSION_SECRET, "portal-secret");
  assert.equal(env.PORTAL_FAVICON_EMOJI, "A");
  assert.equal(env.CORE_SIGNING_SECRET, undefined);
});

test("embedded auth moves to its own loopback port, rewriting endpoints that pointed at it", async () => {
  const env = await relocateEmbeddedAuth({
    AUTH_EMBEDDED: "1",
    AUTH_BROKER_UPSTREAM: "http://127.0.0.1:8099",
    OIDC_TOKEN_ENDPOINT: "http://127.0.0.1:8099/idp/token",
    OIDC_ISSUER: "https://acme.example.test/idp",
  });
  const moved = new URL(env.AUTH_BROKER_UPSTREAM!);
  assert.equal(moved.hostname, "127.0.0.1");
  assert.notEqual(moved.port, "8099");
  assert.equal(env.OIDC_TOKEN_ENDPOINT, `${env.AUTH_BROKER_UPSTREAM}/idp/token`);
  assert.equal(env.OIDC_ISSUER, "https://acme.example.test/idp");
  const plain = { AUTH_BROKER_UPSTREAM: "http://127.0.0.1:8099" };
  assert.equal(await relocateEmbeddedAuth(plain), plain);
});

test("Absurd queues are tenant-scoped except for the home tenant", () => {
  assert.equal(tenantQueue("turns_people", undefined), "turns_people");
  assert.equal(tenantQueue("turns_background", ACME_ID), "turns_background_t0f8e2c4a1b2c");
  assert.equal(tenantQueue("turns_people"), "turns_people");
});

const URL_ADMIN = process.env.DATABASE_URL;
const skip = URL_ADMIN ? false : "set DATABASE_URL (a Postgres) to run the multitenant host test";
const DB = `qm_mt_host_${process.pid}`;
const ROLE = "qm_mt_host_app";
const ACME = "5b0c7e44-1f1a-4c6e-9d2a-00000000a001";
const BETA = "5b0c7e44-1f1a-4c6e-9d2a-00000000b002";
const GAMMA = "5b0c7e44-1f1a-4c6e-9d2a-00000000c003";

let admin: pg.Client;
let registry: PgPool;
let host: MultitenantHost;
let appUrl = "";

async function bootStub(
  env: NodeJS.ProcessEnv,
  serve: (server: Server, config: Config) => Promise<void>,
): Promise<BootedTenant> {
  const config = { port: 0, publicUrl: env.PUBLIC_API_URL } as Config;
  const server = createServer((_req, res) =>
    res.end(JSON.stringify({ id: tenant().id ?? null, org: env.ORG_ID, flag: env.TENANT_FLAG ?? null })),
  );
  await serve(server, config);
  return { config, server, beginShutdown() {}, stop: async () => {}, releaseInFlightRuns: async () => {} };
}

function postgresMultitenantHostGet(
  port: number,
  path: string,
  hostHeader: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: hostHeader } }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  if (!URL_ADMIN) return;
  admin = new pg.Client({ connectionString: URL_ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE}' NOSUPERUSER NOBYPASSRLS; END IF; END $$`,
  );
  await admin.query(`CREATE DATABASE ${DB} OWNER ${ROLE}`);
  const url = new URL(URL_ADMIN);
  url.username = ROLE;
  url.password = ROLE;
  url.pathname = `/${DB}`;
  appUrl = url.toString();
  configurePgTenancy(true);
  registry = createPgPool(appUrl);
  await registry.pool();
  for (const [id, slug, flag] of [
    [ACME, "acme", "a"],
    [BETA, "beta", "b"],
  ] as const) {
    await upsertTenant(
      registry,
      {
        id,
        slug,
        orgId: slug,
        hosts: [`${slug}.example.test`],
        status: "active",
        env: { core: { TENANT_FLAG: flag } },
        secretEnv: {},
      },
      undefined,
    );
  }
  host = await startMultitenant(
    { DATABASE_URL: appUrl, ORG_ID: "home", PUBLIC_API_URL: "https://home.example.test" },
    bootStub,
  );
});

after(async () => {
  if (!URL_ADMIN) return;
  await host?.stopWorkers();
  for (const server of host?.servers ?? []) server.close();
  await registry?.close();
  configurePgTenancy(false);
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
});

test("one process serves the home tenant and every registry tenant by host", { skip }, async () => {
  assert.equal(host.tenants.length, 3);
  const port = (host.servers[host.servers.length - 1]!.address() as AddressInfo).port;
  const body = async (path: string, h: string) =>
    JSON.parse((await postgresMultitenantHostGet(port, path, h)).body) as unknown;
  assert.deepEqual(await body("/v1/x", "acme.example.test"), { id: ACME, org: "acme", flag: "a" });
  assert.deepEqual(await body("/v1/x", "beta.example.test:443"), { id: BETA, org: "beta", flag: "b" });
  assert.deepEqual(await body("/v1/x", "home.example.test"), { id: null, org: "home", flag: null });
  assert.deepEqual(await body("/healthz", "10.1.2.3"), { id: null, org: "home", flag: null });
  assert.equal((await postgresMultitenantHostGet(port, "/v1/x", "stranger.example.test")).status, 404);
});

test("a registry change boots added tenants and stops suspended ones without a restart", { skip }, async () => {
  const frontPort = (host.servers[host.servers.length - 1]!.address() as AddressInfo).port;
  await upsertTenant(
    registry,
    {
      id: GAMMA,
      slug: "gamma",
      orgId: "gamma",
      hosts: ["gamma.example.test"],
      status: "active",
      env: {},
      secretEnv: {},
    },
    undefined,
  );
  await upsertTenant(
    registry,
    {
      id: BETA,
      slug: "beta",
      orgId: "beta",
      hosts: ["beta.example.test"],
      status: "suspended",
      env: {},
      secretEnv: {},
    },
    undefined,
  );
  await host.refresh();
  assert.equal(host.tenants.length, 3);
  assert.equal(JSON.parse((await postgresMultitenantHostGet(frontPort, "/v1/x", "gamma.example.test")).body).id, GAMMA);
  assert.equal((await postgresMultitenantHostGet(frontPort, "/v1/x", "beta.example.test")).status, 404);
});
