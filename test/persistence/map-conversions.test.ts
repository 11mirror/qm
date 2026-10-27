import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import "../../src/wiring.ts";
import { mapConversions, mapToTableMigration } from "../../src/persistence/typed-table.ts";
import { assertMapConversion } from "../support/map-conversion.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

const CONVERSIONS = mapConversions();

test("every former durable-map table has a conversion", () => assert.equal(CONVERSIONS.length, 80));

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
