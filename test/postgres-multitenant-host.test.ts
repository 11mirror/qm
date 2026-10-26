import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import type { Config } from "../src/config.ts";
import { configurePgTenancy, createPgPool, type PgPool } from "../src/persistence/pg-pool.ts";
import { tenant } from "../src/tenant.ts";
import { startMultitenant, type MultitenantHost } from "../src/tenants/host.ts";
import { upsertTenant } from "../src/tenants/registry.ts";
import type { BootedTenant } from "../src/tenants/boot.ts";

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

function get(port: number, path: string, hostHeader: string): Promise<{ status: number; body: string }> {
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
  const body = async (path: string, h: string) => JSON.parse((await get(port, path, h)).body) as unknown;
  assert.deepEqual(await body("/v1/x", "acme.example.test"), { id: ACME, org: "acme", flag: "a" });
  assert.deepEqual(await body("/v1/x", "beta.example.test:443"), { id: BETA, org: "beta", flag: "b" });
  assert.deepEqual(await body("/v1/x", "home.example.test"), { id: null, org: "home", flag: null });
  assert.deepEqual(await body("/healthz", "10.1.2.3"), { id: null, org: "home", flag: null });
  assert.equal((await get(port, "/v1/x", "stranger.example.test")).status, 404);
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
  assert.equal(JSON.parse((await get(frontPort, "/v1/x", "gamma.example.test")).body).id, GAMMA);
  assert.equal((await get(frontPort, "/v1/x", "beta.example.test")).status, 404);
});
