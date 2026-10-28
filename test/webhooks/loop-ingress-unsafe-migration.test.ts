import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { CRONS_MIGRATION } from "../../src/cron/cron-store.ts";
import { applyTenancy } from "../../src/persistence/tenancy.ts";
import {
  LOOP_INGRESS_TO_WEBHOOKS_MIGRATION,
  LOOP_INGRESS_UNSAFE_IMPORTS_MIGRATION,
} from "../../src/webhooks/loop-ingress-migration.ts";
import { WEBHOOKS_MIGRATION } from "../../src/webhooks/webhook-store.ts";

const URL = process.env.DATABASE_URL!;

type Pool = import("pg").Pool;

async function withDatabase(body: (pool: Pool) => Promise<void>): Promise<void> {
  const pg = (await import("pg")).default;
  const db = `qm_loop_unsafe_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  const target = new globalThis.URL(URL);
  target.pathname = `/${db}`;
  const pool = new pg.Pool({ connectionString: target.toString() });
  try {
    for (const table of ["loops", "loop_ingress", "loop_ingress_deliveries"])
      await pool.query(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
    for (const sql of [...CRONS_MIGRATION.statements, ...WEBHOOKS_MIGRATION.statements]) await pool.query(sql);
    await applyTenancy(pool);
    await body(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
}

const ids = {
  safe: randomUUID(),
  noSecret: randomUUID(),
  noFilter: randomUUID(),
  hookNoSecret: randomUUID(),
  gmail: randomUUID(),
};

const ingress = {
  [ids.safe]: {
    kind: "slack",
    owner: "U1",
    enabled: true,
    secret: "slack-secret",
    channels: ["C1"],
    lastError: "boom",
  },
  [ids.noSecret]: { kind: "slack", owner: "U1", enabled: true, teamId: "T1", channels: ["C1"] },
  [ids.noFilter]: { kind: "slack", owner: "U1", enabled: true, secret: "slack-secret", channels: [] },
  [ids.hookNoSecret]: { kind: "webhook", owner: "U1", enabled: true },
  [ids.gmail]: { kind: "gmail", owner: "U1", enabled: true },
};

async function seed(pool: Pool, tenant: string): Promise<void> {
  for (const [id, json] of Object.entries(ingress))
    await pool.query("INSERT INTO loop_ingress (tenant_id, id, json) VALUES ($1, $2, $3)", [
      tenant,
      id,
      JSON.stringify({ id, loopId: "L1", ...json }),
    ]);
  await pool.query("INSERT INTO loops (tenant_id, id, json) VALUES ($1, 'L1', $2)", [
    tenant,
    JSON.stringify({ id: "L1", cronId: "c1", playbook: "p" }),
  ]);
  await pool.query("INSERT INTO crons (tenant_id, id, json) VALUES ($1, 'c1', $2)", [
    tenant,
    JSON.stringify({
      id: "c1",
      ownerScopeId: "channel:C1",
      owner: "U1",
      createdBy: "U1",
      enabled: true,
      createdAt: 1,
      schedule: { cron: "0 9 * * *" },
      action: "triage",
    }),
  ]);
  await pool.query(
    `INSERT INTO webhooks (tenant_id, id, owner_scope_id, owner, created_by, enabled, created_at, action, verification)
     VALUES ($1, 'abcdef0123456789', 'channel:C1', 'U1', 'U1', true, 1, 'native', '{"scheme":"slack","secret":"s"}')`,
    [tenant],
  );
}

async function run(pool: Pool, migration: { statements: readonly string[] }): Promise<void> {
  for (const sql of migration.statements) await pool.query(sql);
}

test("imported loop endpoints with no secret or no Slack filter end up disabled, in every tenant", async () => {
  await withDatabase(async (pool) => {
    const home = (await pool.query("SELECT id::text AS id FROM qm_tenant")).rows[0].id;
    const other = randomUUID();
    await seed(pool, home);
    await seed(pool, other);
    await run(pool, LOOP_INGRESS_TO_WEBHOOKS_MIGRATION);
    await run(pool, LOOP_INGRESS_UNSAFE_IMPORTS_MIGRATION);
    await run(pool, LOOP_INGRESS_UNSAFE_IMPORTS_MIGRATION);
    const rows = (
      await pool.query("SELECT tenant_id::text AS t, id, enabled, last_error, json FROM webhooks ORDER BY id")
    ).rows;
    for (const tenant of [home, other]) {
      const byId = Object.fromEntries(rows.filter((row) => row.t === tenant).map((row) => [row.id, row]));
      assert.equal(Object.keys(byId).length, 6);
      assert.equal(byId[ids.safe].enabled, true);
      assert.equal(byId[ids.safe].last_error, "boom");
      assert.equal(byId[ids.noSecret].enabled, false);
      assert.match(byId[ids.noSecret].last_error, /no signing secret/);
      assert.equal(byId[ids.noSecret].json.enabled, false);
      assert.equal(byId[ids.noFilter].enabled, false);
      assert.match(byId[ids.noFilter].last_error, /no channel or team filter/);
      assert.equal(byId[ids.hookNoSecret].enabled, false);
      assert.match(byId[ids.hookNoSecret].last_error, /no signing secret/);
      assert.equal(byId[ids.gmail].last_error, null);
      assert.equal(byId.abcdef0123456789.enabled, true);
      assert.equal(byId.abcdef0123456789.last_error, null);
    }
  });
});

test("a database without webhooks from loop ingress is untouched", async () => {
  await withDatabase(async (pool) => {
    await run(pool, LOOP_INGRESS_TO_WEBHOOKS_MIGRATION);
    await run(pool, LOOP_INGRESS_UNSAFE_IMPORTS_MIGRATION);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM webhooks")).rows[0].n, 0);
  });
});
