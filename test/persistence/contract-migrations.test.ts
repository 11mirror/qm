import test from "node:test";
import assert from "node:assert/strict";
import type { PgMigrationDefinition } from "../../src/persistence/pg-migrations.ts";
import { CONTRACT_MIGRATIONS, HELD_BACK_CONTRACT_MIGRATIONS } from "../../src/persistence/contract-migrations.ts";
import { registerUpgradeMigrations } from "../../src/wiring/upgrade-migrations.ts";
import type { StoresModule } from "../../src/wiring/stores.ts";

test("boot registers the numbered contracts and leaves the held-back ones unregistered", () => {
  const ids: string[] = [];
  const pgPool = { registerMigration: (migration: PgMigrationDefinition) => void ids.push(migration.id) };
  registerUpgradeMigrations({ stores: { pgPool } as unknown as StoresModule });
  const contracts = ids.filter((id) => id.startsWith("contract/"));
  assert.deepEqual(
    contracts.map((id) => id.slice("contract/".length, "contract/".length + 4)),
    ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0026", "0027"],
  );
  for (const { id } of HELD_BACK_CONTRACT_MIGRATIONS) assert.ok(!ids.includes(id), `${id} stays held back`);
});

test("unused admin settings drop after the earlier numbered contracts", async () => {
  const { default: pg } = await import("pg");
  const { testDatabaseUrl } = await import("../support/test-database.ts");
  const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  const migration = CONTRACT_MIGRATIONS.find((m) => m.id === "contract/0026-drop-unused-admin-settings")!;
  try {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS browse_model_configs (id text); CREATE TABLE IF NOT EXISTS unfulfilled_insights_flag (id text)",
    );
    for (const statement of migration.statements) await pool.query(statement);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT to_regclass('browse_model_configs') AS browse, to_regclass('unfulfilled_insights_flag') AS insights",
        )
      ).rows,
      [{ browse: null, insights: null }],
    );
  } finally {
    await pool.end();
  }
});
