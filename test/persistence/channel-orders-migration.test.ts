import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { CHANNEL_ORDERS_MIGRATION } from "../../src/surface-cache/channel-orders-migration.ts";
import { DROP_CHANNEL_POLICY_ORDERS, pgMigrationOrder } from "../../src/persistence/contract-migrations.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

test("main channel orders become scoped instructions without losing history or crossing tenants", async () => {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  try {
    await pool.query(
      `DROP TABLE IF EXISTS channel_policy, channel_policy_history, channel_state, soul_configs, soul_history CASCADE`,
    );
    await pool.query(`CREATE TABLE channel_policy (tenant_id uuid, org_id text, container text, orders text, set_by text);
      CREATE TABLE channel_policy_history (orders text NOT NULL);
      CREATE TABLE channel_state (tenant_id uuid, org_id text, container text, kind text);
      CREATE TABLE soul_configs (tenant_id uuid, id text, json jsonb, PRIMARY KEY (tenant_id, id));
      CREATE TABLE soul_history (tenant_id uuid, id text, json jsonb)`);
    const a = "00000000-0000-4000-8000-000000000001";
    const b = "00000000-0000-4000-8000-000000000002";
    await pool.query(
      `INSERT INTO channel_policy VALUES ($1,'o','c','First orders','regan'), ($2,'o','c','Other orders',NULL), ($1,'o','web-project-x','Group orders',NULL)`,
      [a, b],
    );
    await pool.query(`INSERT INTO soul_configs VALUES ($1,'channel:c',$2)`, [
      a,
      { scopeId: "channel:c", content: "Existing", version: 2, updatedAt: 4 },
    ]);
    await pool.query(`INSERT INTO soul_history VALUES ($1,'old',$2)`, [
      a,
      { scopeId: "channel:c", content: "Previous", version: 1, updatedAt: 3 },
    ]);
    for (const s of CHANNEL_ORDERS_MIGRATION.statements) await pool.query(s);
    const { rows } = await pool.query(`SELECT tenant_id, id, json FROM soul_configs ORDER BY tenant_id, id`);
    assert.equal(rows[0].json.content, "Existing\n\n---\n\nFirst orders");
    assert.deepEqual(
      rows[0].json.history.map((r: { version: number }) => r.version),
      [3, 2, 1],
    );
    assert.equal(rows[1].id, "group:web-project-x");
    assert.equal(rows[2].json.content, "Other orders");
    assert.ok(pgMigrationOrder(CHANNEL_ORDERS_MIGRATION.id, DROP_CHANNEL_POLICY_ORDERS.id) < 0);
    for (const s of DROP_CHANNEL_POLICY_ORDERS.statements) await pool.query(s);
    for (const s of CHANNEL_ORDERS_MIGRATION.statements) await pool.query(s);
    assert.equal((await pool.query("SELECT count(*) FROM soul_configs")).rows[0].count, "3");
  } finally {
    await pool.end();
  }
});
