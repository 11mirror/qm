import { deriveTenantSecret } from "../../plugins/chassis/src/tenant-settings.ts";
import { signRequest } from "../../plugins/chassis/src/source-auth-sign.ts";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { loadConfig } from "../../src/config.ts";
import { configurePgPooling, createPgPool, migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { configureTenantConversion } from "../../src/tenants/bootstrap.ts";
import { createTenantDirectory } from "../../src/tenants/directory.ts";
import { listTenants, upsertTenant } from "../../src/tenants/registry.ts";
import { tenantConfig } from "../../src/tenants/tenant-config.ts";
import { registerTenantSettings, tenant, tenantFor, withTenant, withoutTenant } from "../../src/tenant.ts";
import { edgeTenant, setEdgeTenants, withEdgeTenant } from "../../plugins/chassis/src/tenant-hosts.ts";
import { coreOrgId } from "../../plugins/chassis/src/env.ts";

const migration = {
  id: "test/equal-tenants",
  statements: ["CREATE TABLE widgets(id text PRIMARY KEY)", "INSERT INTO widgets VALUES ('existing')"],
};

test("the original database tenant becomes an ordinary settings row, and deployment work has no tenant", async () => {
  const role = `qm_equal_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`CREATE DATABASE ${role}`);
  const migrationUrl = new URL(process.env.DATABASE_URL!);
  migrationUrl.pathname = `/${role}`;
  const applicationUrl = new URL(migrationUrl);
  applicationUrl.username = applicationUrl.password = role;
  const setup = new pg.Client({ connectionString: migrationUrl.toString() });
  await setup.connect();
  await setup.query(`ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
  await setup.query(`ALTER DEFAULT PRIVILEGES GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);
  const key = randomBytes(32);
  const env = {
    ORG_ID: "original",
    PUBLIC_API_URL: "https://original.example.test",
    SANDBOX_NAME_PREFIX: "existing-machines",
    ADMIN_GRANTS: "original@example.test:org_admin",
    CORE_SIGNING_SECRET: "original-signing-secret-0123456789",
    CAPABILITY_SECRET: "original-capability-secret-01234567",
    PORTAL_IDENTITY_SECRET: "original-portal-identity-secret-012345",
    CONNECTOR_SECRET_KEY: "original-connector-secret-01234567",
    QM_TENANT_SECRETS_KEY: key.toString("base64"),
    SLACK_BOT_TOKEN: "xoxb-test-original",
    SLACK_APP_TOKEN: "xapp-test-original",
  };
  configurePgPooling({ tenancy: false });
  const initial = createPgPool(migrationUrl.toString(), [migration]);
  const firstId = String((await initial.q("SELECT id FROM qm_tenant"))[0]!.id);
  await initial.close();
  configureTenantConversion(env);
  configurePgPooling({ databaseUrl: applicationUrl.toString(), migrationUrl: migrationUrl.toString(), tenancy: true });
  const pool = createPgPool(applicationUrl.toString(), [migration]);
  try {
    await withoutTenant(() => migrateRegisteredPgSchemas(applicationUrl.toString()));
    const [original] = await listTenants(pool, key);
    assert.equal(original!.id, firstId);
    assert.equal(original!.sandboxNamePrefix, "existing-machines");
    assert.equal(original!.secrets.slack?.botToken, env.SLACK_BOT_TOKEN);
    assert.equal(original!.secrets.adminGrants, env.ADMIN_GRANTS);
    const deployment = await pool.deploymentPool();
    assert.equal((await deployment.query("SELECT to_regclass('qm_tenant') AS name")).rows[0].name, null);
    await assert.rejects(deployment.query("SELECT * FROM widgets"), /explicit tenant context/);
    await assert.rejects(deployment.query("SELECT qm_tenant_id()"), /explicit tenant context/);
    await deployment.query("LISTEN qm_equal_test");
    await deployment.query("UNLISTEN qm_equal_test");
    assert.equal((await deployment.query("SELECT count(*) FROM tenants")).rows[0].count, "1");
    const other = {
      ...original!,
      id: randomUUID(),
      slug: "other",
      orgId: "other",
      hosts: ["other.example.test"],
      secrets: {},
      sandboxNamePrefix: "other-machines",
    };
    await upsertTenant(deployment, other, key);
    registerTenantSettings([original!, other]);
    const first = tenantFor(original!.orgId, original!.id, original!.slug);
    const second = tenantFor(other.orgId, other.id, other.slug);
    await withTenant(first, async () => assert.deepEqual(await pool.q("SELECT id FROM widgets"), [{ id: "existing" }]));
    await withTenant(second, async () => assert.deepEqual(await pool.q("SELECT id FROM widgets"), []));
    const changedEnv = { ...env, ORG_ID: "intruder", ADMIN_GRANTS: "intruder@example.test:org_admin" };
    const config = loadConfig(changedEnv);
    assert.equal(config.orgId, undefined);
    assert.equal(config.adminGrants, undefined);
    assert.equal(config.slack, undefined);
    assert.equal(
      withTenant(first, () => tenantConfig(config).adminGrants),
      env.ADMIN_GRANTS,
    );
    assert.equal(
      withTenant(second, () => tenantConfig(config).adminGrants),
      undefined,
    );
    withoutTenant(() => assert.throws(tenant, /explicit registered tenant/));
    withEdgeTenant(original!, () => {
      assert.equal(edgeTenant()!.id, firstId);
      assert.equal(coreOrgId(), "original");
      assert.equal(Object.hasOwn(original!.secrets, "signingSecret"), false);
      assert.equal(Buffer.from(original!.secrets.keychainSigningFallback!, "base64").length, 32);
    });
    configureTenantConversion(changedEnv);
    await withoutTenant(() => migrateRegisteredPgSchemas(applicationUrl.toString()));
    assert.equal((await listTenants(pool, key))[0]!.orgId, "original");
    await upsertTenant(deployment, { ...original!, status: "suspended" }, key);
    const directory = createTenantDirectory({
      databaseUrl: applicationUrl.toString(),
      pool,
      secretsKey: key,
      sandboxPrefix: "qm",
    });
    try {
      assert.deepEqual(
        (await directory.active()).map((t) => t.id),
        [other.id],
      );
      assert.equal(await directory.byHost("original.example.test"), undefined);
      assert.equal((await directory.byHost("other.example.test"))!.id, other.id);
      assert.equal(await directory.owner(undefined), undefined);
    } finally {
      await directory.close();
    }
  } finally {
    await pool.close();
    await setup.end();
    setEdgeTenants([]);
    configurePgPooling({ tenancy: false });
    await admin.query(`DROP DATABASE ${role} WITH (FORCE)`);
    await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  }
});

test("a fresh deployment registers no tenant and never reads tenant environment settings", async () => {
  const name = `qm_empty_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  configureTenantConversion({
    ORG_ID: "must-not-exist",
    PORTAL_TRUSTED_OIDC: "not-json",
    QM_TENANT_SECRETS_KEY: "invalid-key",
  });
  configurePgPooling({ databaseUrl: url.toString(), migrationUrl: url.toString(), tenancy: true });
  const pool = createPgPool(url.toString());
  try {
    await migrateRegisteredPgSchemas(url.toString());
    assert.deepEqual(await listTenants(pool, undefined), []);
    const { rows } = await (await pool.deploymentPool()).query("SELECT to_regclass('qm_tenant') AS singleton");
    assert.equal(rows[0].singleton, null);
    withoutTenant(() => assert.throws(tenant, /explicit registered tenant/));
  } finally {
    await pool.close();
    configurePgPooling({ tenancy: false });
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});

test("a fresh core boots, serves health and readiness, and shuts down without ever selecting a tenant", async (t) => {
  const notices: string[] = [];
  for (const method of ["warn", "error"] as const)
    t.mock.method(console, method, (...args: unknown[]) => notices.push(args.map(String).join(" ")));
  const role = `qm_boot_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`CREATE DATABASE ${role}`);
  const migration = new URL(process.env.DATABASE_URL!);
  migration.pathname = `/${role}`;
  const application = new URL(migration);
  application.username = application.password = role;
  const setup = new pg.Client({ connectionString: migration.toString() });
  await setup.connect();
  await setup.query(`ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
  await setup.query(`ALTER DEFAULT PRIVILEGES GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);
  await setup.query(`ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS TO ${role}`);
  const { bootApp } = await import("../../src/boot.ts");
  const { createTenantFront } = await import("../../src/tenants/host.ts");
  let front: import("node:http").Server | undefined;
  const app = await withoutTenant(() =>
    bootApp(
      {
        DATABASE_URL: application.toString(),
        DATABASE_MIGRATION_URL: migration.toString(),
        SANDBOX_BACKEND: "local",
        CORE_SIGNING_SECRET: "fresh-core-signing-secret-0123456789",
        CAPABILITY_SECRET: "fresh-capability-secret-012345678901",
        PORTAL_IDENTITY_SECRET: "fresh-identity-secret-01234567890123",
        CONNECTOR_SECRET_KEY: "fresh-connector-secret-012345678901",
        BACKGROUND_WORK_ENABLED: "0",
        BACKGROUND_DEPLOYMENT_ID: "test-boot",
        DEPLOYMENT_CONTROL_SECRET: "fresh-deployment-control-secret-0123456789",
        PORT: "0",
      },
      async (server) => {
        assert.throws(tenant, /explicit registered tenant/);
        front = createTenantFront(server);
        await new Promise<void>((resolve) => front!.listen(0, "127.0.0.1", resolve));
      },
    ),
  );
  const base = `http://127.0.0.1:${(front!.address() as import("node:net").AddressInfo).port}`;
  try {
    for (const path of ["/healthz", "/readyz"]) assert.equal((await fetch(`${base}${path}`)).status, 200);
    assert.equal((await fetch(`${base}/v1/apis`)).status, 404);
    const path = "/v1/background-work";
    const timestamp = Math.floor(Date.now() / 1000);
    const status = await fetch(`${base}${path}`, {
      headers: {
        "x-timestamp": String(timestamp),
        "x-signature": signRequest("fresh-core-signing-secret-0123456789", timestamp, `GET\n${path}\n`),
        authorization: "Bearer fresh-deployment-control-secret-0123456789",
      },
    });
    assert.equal(status.status, 200, await status.text());
    const body = JSON.stringify({ ownerDeploymentId: null, expectedOwnerDeploymentId: null });
    const write = (secret: string) =>
      fetch(`${base}${path}`, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-timestamp": String(timestamp),
          "x-signature": signRequest(secret, timestamp, `POST\n${path}\n${body}`),
          authorization: "Bearer fresh-deployment-control-secret-0123456789",
        },
      });
    assert.equal(
      (await write(deriveTenantSecret("fresh-core-signing-secret-0123456789", "11111111-1111-4111-8111-111111111111")))
        .status,
      401,
    );
    const written = await write("fresh-core-signing-secret-0123456789");
    assert.equal(written.status, 200, await written.text());
    assert.equal((await setup.query("SELECT count(*)::int AS n FROM tenants")).rows[0].n, 0);
    assert.equal((await setup.query("SELECT to_regclass('qm_tenant') AS singleton")).rows[0].singleton, null);
  } finally {
    front!.closeAllConnections();
    await new Promise<void>((resolve) => front!.close(() => resolve()));
    await withoutTenant(() => app.stop());
    assert.ok(
      !notices.some((message) => /explicit registered tenant|explicit tenant context/.test(message)),
      notices.join("\n"),
    );
    await setup.end();
    configurePgPooling({ tenancy: false });
    await admin.query(`DROP DATABASE ${role} WITH (FORCE)`);
    await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  }
});
