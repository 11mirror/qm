import { configureTestTenancy } from "../support/tenant-test.ts";
import { test, after, before } from "../support/tenant-test.ts";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { configurePgTenancy, createPgPool, type PgPool } from "../../src/persistence/pg-pool.ts";
import { registerTenantSettings, tenantFor, withoutTenant, tenantSettings, withTenant } from "../../src/tenant.ts";
import { listTenants, upsertTenant, type TenantRecord } from "../../src/tenants/registry.ts";

const ADMIN_URL = process.env.DATABASE_URL!;
const DB = `qm_tenant_settings_${process.pid}`;
const key = randomBytes(32);

let admin: pg.Client;
let pool: PgPool;

function databaseUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${DB}`;
  return url.toString();
}

before(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await configureTestTenancy(databaseUrl());
  pool = createPgPool(databaseUrl());
  await pool.pool();
});

after(async () => {
  await pool?.close();
  configurePgTenancy(false);
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
});

test("a tenant record round-trips through its row with secrets sealed at rest", async () => {
  const record: TenantRecord = {
    id: randomUUID(),
    slug: "kittenmittens",
    orgId: "kittenmittens",
    hosts: ["kittenmittens.example.test", "km.example.test"],
    status: "suspended",
    appsDomain: "apps.km.example.test",
    s3Bucket: "qm-km",
    oidcClientId: "kittenmittens",
    oidcAdmin: true,
    secrets: { oidcClientSecret: "km-trusted-secret", slackServiceToken: "km-slack" },
  };
  await upsertTenant(pool, record, key);
  const stored = await pool.q(`SELECT encode(secrets, 'escape') AS raw FROM tenants WHERE id = $1`, [record.id]);
  assert.doesNotMatch(String(stored[0]!.raw), /km-slack|km-trusted-secret/);
  assert.deepEqual(
    (await listTenants(pool, key)).find((t) => t.id === record.id),
    record,
  );
  await assert.rejects(listTenants(pool, randomBytes(32)), /unable to authenticate|Unsupported state/);
  await upsertTenant(pool, { ...record, s3Bucket: undefined, secrets: {} }, undefined);
  const cleared = (await listTenants(pool, key)).find((t) => t.id === record.id)!;
  assert.equal(cleared.s3Bucket, undefined);
  assert.deepEqual(cleared.secrets, {});
  await assert.rejects(upsertTenant(pool, record, undefined), /QM_TENANT_SECRETS_KEY/);
});

test("tenantSettings() reads only registered settings and never falls back to process env", () => {
  const acme: TenantRecord = {
    id: randomUUID(),
    slug: "acme",
    orgId: "acme",
    hosts: ["acme.example.test"],
    status: "active",
    s3Bucket: "acme-bucket",
    oidcAdmin: false,
    secrets: {},
  };
  registerTenantSettings([acme]);
  const saved = { ...process.env };
  try {
    for (const name of ["PORTAL_PUBLIC_URL", "PUBLIC_API_URL", "AGENT_API_URL"]) delete process.env[name];
    process.env.S3_BUCKET = "home-bucket";
    process.env.PUBLIC_WEB_URL = "https://home.example.test";
    process.env.MODEL_GATEWAY_API_KEY = "home-gateway";
    assert.equal(
      withTenant(tenantFor("acme", acme.id, "acme"), () => tenantSettings()),
      acme,
    );
    withoutTenant(() => assert.throws(() => tenantSettings(), /explicit registered tenant/));
    assert.throws(() => tenantSettings(tenantFor("ghost", randomUUID(), "ghost")), /ghost has no registered settings/);
  } finally {
    process.env = saved;
    registerTenantSettings([]);
  }
});
