import { assertRowSecurityEnforced } from "../../src/tenants/registry.ts";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { after, before, test, configureTestTenancy } from "../support/tenant-test.ts";
import {
  configurePgTenancy,
  createPgPool,
  migrateRegisteredPgSchemas,
  type PgPool,
} from "../../src/persistence/pg-pool.ts";
import { homeTenant, tenantFor, withTenant, withoutTenant } from "../../src/tenant.ts";
import { claimTasks, emitEvent, spawnTask } from "../../src/turns/absurd.ts";
import { registerAbsurdSchema } from "../../src/turns/absurd-schema.ts";

const suffix = randomBytes(5).toString("hex");
const role = `qm_boundary_${suffix}`;
const a = tenantFor("a", randomUUID(), "a");
const b = tenantFor("b", randomUUID(), "b");
let url = "";
let pool: PgPool;

before(async () => {
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`CREATE DATABASE ${role}`);
  } finally {
    await admin.end();
  }
  const parsed = new URL(process.env.DATABASE_URL!);
  parsed.pathname = `/${role}`;
  parsed.username = role;
  parsed.password = role;
  url = parsed.toString();
  await configureTestTenancy(url);
  registerAbsurdSchema(url);
  pool = createPgPool(url, [
    { id: "test/tenant-boundary", statements: ["CREATE TABLE boundary_rows(id text PRIMARY KEY)"] },
  ]);
  await migrateRegisteredPgSchemas(url);
  for (const owner of [a, b])
    await withTenant(owner, async () => {
      await pool.q("INSERT INTO boundary_rows(id) VALUES ($1)", [owner.orgId]);
      await spawnTask(
        await pool.pool(),
        "jobs",
        "boundary",
        { secret: owner.orgId },
        { idempotencyKey: owner.id, maxAttempts: 1 },
      );
      await emitEvent(await pool.pool(), "jobs", owner.id!, { secret: owner.orgId });
    });
});

after(async () => {
  await pool?.close();
  configurePgTenancy(false);
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${role} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
  } finally {
    await admin.end();
  }
});

test("an unscoped query and both pool checkout APIs fail closed", async () => {
  await withoutTenant(async () => {
    await assert.rejects(pool.q("SELECT 1"), /explicit tenant context/);
    const direct = await pool.sessionPool();
    await assert.rejects(direct.connect(), /explicit tenant context/);
    await new Promise<void>((resolve, reject) =>
      direct.connect((error, client) => {
        try {
          assert.match(String(error), /explicit tenant context/);
          assert.equal(client, undefined);
          resolve();
        } catch (failure) {
          reject(failure);
        }
      }),
    );
  });
  await withTenant(homeTenant(), () => assert.doesNotReject(pool.q("SELECT 1")));
  const raw = new pg.Client({ connectionString: url });
  await raw.connect();
  try {
    await assert.rejects(raw.query("SELECT qm_tenant_id()"), /explicit tenant context/);
    await raw.query("SELECT set_config('qm.tenant_id', '', false)");
    await assert.rejects(raw.query("SELECT * FROM boundary_rows"), /explicit tenant context/);
  } finally {
    await raw.end();
  }
});

test("application query and session connections cannot use the removed bypass to read another tenant", async () => {
  for (const owner of [a, b])
    await withTenant(owner, async () => {
      const other = owner === a ? b : a;
      assert.deepEqual(await pool.q("SELECT id FROM boundary_rows"), [{ id: owner.orgId }]);
      const session = await (await pool.sessionPool()).connect();
      try {
        await session.query("SELECT set_config('qm.tenant_bypass', 'on', false)");
        assert.deepEqual((await session.query("SELECT id FROM boundary_rows")).rows, [{ id: owner.orgId }]);
        for (const table of ["t_jobs", "r_jobs", "e_jobs", "c_jobs", "w_jobs"]) {
          assert.equal(
            (await session.query(`SELECT * FROM absurd.${table} WHERE tenant_id = $1`, [other.id])).rowCount,
            0,
          );
        }
        assert.deepEqual((await session.query("SELECT params->>'secret' AS secret FROM absurd.t_jobs")).rows, [
          { secret: owner.orgId },
        ]);
        await assert.rejects(session.query("TRUNCATE boundary_rows"), /permission denied/);
        await assert.rejects(session.query("ALTER TABLE boundary_rows DISABLE ROW LEVEL SECURITY"), /must be owner/);
        await assert.rejects(
          session.query("SET row_security = off; SELECT * FROM boundary_rows"),
          /row-level security/,
        );
      } finally {
        session.release(true);
      }
    });
});

test("a missing or forged task header cannot redirect a tenant-scoped claim", async () => {
  await withTenant(b, async () => {
    await pool.q("UPDATE absurd.t_jobs SET headers = '{}'::jsonb");
    const [task] = await claimTasks(await pool.pool(), "jobs", "boundary-worker", 60);
    assert.equal(task?.tenantId, b.id);
    assert.deepEqual(task?.params, { secret: "b" });
    assert.deepEqual(await pool.q("SELECT id FROM boundary_rows"), [{ id: "b" }]);
    await spawnTask(
      await pool.pool(),
      "jobs",
      "forged-header",
      {},
      { idempotencyKey: `${b.id}:forged`, maxAttempts: 1 },
    );
    await pool.q("UPDATE absurd.t_jobs SET headers = jsonb_build_object('tenantId', $1::text)", [a.id]);
    const [forged] = await claimTasks(await pool.pool(), "jobs", "boundary-worker", 60);
    assert.equal(forged?.tenantId, b.id);
  });
});

test("startup rejects an application role with table-wide escape privileges", async () => {
  await assertRowSecurityEnforced(pool);
  const migration = new URL(process.env.DATABASE_URL!);
  migration.pathname = new URL(url).pathname;
  const admin = new pg.Client({ connectionString: migration.toString() });
  await admin.connect();
  try {
    await admin.query(`GRANT TRUNCATE ON boundary_rows TO ${role}`);
    await assert.rejects(assertRowSecurityEnforced(pool), /must not have TRUNCATE or TRIGGER/);
    await admin.query(`REVOKE TRUNCATE ON boundary_rows FROM ${role}`);
    await admin.query(`GRANT TRIGGER ON boundary_rows TO ${role}`);
    await assert.rejects(assertRowSecurityEnforced(pool), /must not have TRUNCATE or TRIGGER/);
    await admin.query(`REVOKE TRIGGER ON boundary_rows FROM ${role}`);
  } finally {
    await admin.end();
  }
});
