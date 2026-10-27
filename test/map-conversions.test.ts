import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import "../src/wiring.ts";
import { mapConversions, mapToTableMigration } from "../src/persistence/typed-table.ts";
import { contractMigrations } from "../src/persistence/contract-migrations.ts";
import { assertMapConversion } from "./support/map-conversion.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const CONVERSIONS = mapConversions();
const CONTRACTS = contractMigrations();

test("every former durable-map table has a conversion", () => assert.equal(CONVERSIONS.length, 82));

for (const conversion of CONVERSIONS)
  test(`${conversion.spec.table} converts in place for one tenant and for two`, () => assertMapConversion(conversion));

test("a row that does not rebuild from the typed columns fails the conversion and keeps the map", async () => {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  try {
    await pool.query(`CREATE TABLE conv_probe (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
    await pool.query(`INSERT INTO conv_probe VALUES ('a', '{"n": 1, "stray": true}'), ('b', '{"n": "two"}')`);
    const spec = { table: "conv_probe", key: "id", columns: { n: { type: "bigint", required: true } } } as const;
    for (const dropKeys of [[], ["stray"]]) {
      const { statements } = mapToTableMigration("probe", spec, { dropKeys });
      await assert.rejects(
        (async () => {
          for (const statement of statements) await pool.query(statement);
        })(),
        /conv_probe: row (a|b) does not convert/,
      );
    }
    const kept = await pool.query(`SELECT id, json FROM conv_probe ORDER BY id`);
    assert.deepEqual(kept.rows, [
      { id: "a", json: { n: 1, stray: true } },
      { id: "b", json: { n: "two" } },
    ]);
  } finally {
    await pool.end();
  }
});

test("contracts apply twice after every expand and leave only typed tables", async () => {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  try {
    for (const migration of CONTRACTS)
      for (let run = 0; run < 2; run++) for (const statement of migration.statements) await pool.query(statement);
    const tables = CONVERSIONS.map((conversion) => conversion.spec.table);
    const json = await pool.query(
      "SELECT table_name FROM information_schema.columns WHERE column_name = 'json' AND table_name = ANY($1)",
      [tables],
    );
    assert.deepEqual(json.rows, []);
    assert.equal((await pool.query("SELECT to_regclass('durable_map_versions') AS t")).rows[0].t, null);
    const triggers = await pool.query(
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text = ANY($1)",
      [tables],
    );
    assert.deepEqual(triggers.rows, []);
  } finally {
    await pool.end();
  }
});
