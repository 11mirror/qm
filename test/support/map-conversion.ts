import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { applyPgMigrations, definePgMigration } from "../../src/persistence/pg-pool.ts";
import { applyTenancy, TENANT_BYPASS_OPTION } from "../../src/persistence/tenancy.ts";
import {
  columnName,
  tableCodec,
  type ColumnType,
  type MapConversion,
  type TableSpec,
} from "../../src/persistence/typed-table.ts";
import { testDatabaseUrl } from "./test-database.ts";

type Json = Record<string, unknown>;
type Seed = [tenant: string | null, rows: ReadonlyArray<{ id: string; json: Json }>];

const SAMPLES: Record<ColumnType, (field: string, n: number) => unknown> = {
  text: (field, n) => `${field} ${n} \u00e9\u{1F600}`,
  bigint: (_field, n) => 1_761_000_000_000 + n,
  "double precision": (_field, n) => n + 0.5,
  boolean: (_field, n) => n % 2 === 0,
  jsonb: (field, n) => ({ field, list: [n, "x", { deep: null }], ok: true }),
  "text[]": (field, n) => [`${field}-${n}`, "b"],
};

function sampleRows(spec: TableSpec, dropKeys: readonly string[]) {
  return [1, 2].map((n) => {
    const id = `${spec.table}-${n}`;
    const json: Json = spec.keyIsField ? { [spec.key]: id } : {};
    for (const [field, c] of Object.entries(spec.columns))
      if (n === 1 || c.required) json[field] = SAMPLES[c.type](field, n);
    const want = { ...json };
    for (const key of n === 1 ? dropKeys : []) json[key] = `legacy ${key}`;
    return { id, json, want };
  });
}

async function seedMap(pool: pg.Pool, table: string, seeds: readonly Seed[]) {
  await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  await pool.query(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS durable_map_versions (tbl TEXT PRIMARY KEY, v BIGINT NOT NULL)`);
  if (seeds[0]![0]) await applyTenancy(pool);
  for (const [tenant, rows] of seeds) {
    const cols = tenant ? "tenant_id, " : "";
    const args = tenant ? [tenant] : [];
    const at = tenant ? "$1, $2" : "$1";
    for (const row of rows)
      await pool.query(`INSERT INTO ${table} (${cols}id, json) VALUES (${at}, $${args.length + 2})`, [
        ...args,
        row.id,
        row.json,
      ]);
    await pool.query(`INSERT INTO durable_map_versions (${cols}tbl, v) VALUES (${at}, 7) ON CONFLICT DO NOTHING`, [
      ...args,
      table,
    ]);
  }
}

export async function assertMapConversion(conversion: MapConversion): Promise<void> {
  const { spec } = conversion;
  const codec = tableCodec<Json>(spec);
  const rows = sampleRows(spec, conversion.dropKeys);
  const wanted = new Map(rows.map((row) => [row.id, row.want]));
  const cases: Seed[][] = [
    [[null, rows]],
    [
      [randomUUID(), rows],
      [randomUUID(), rows.slice(1)],
    ],
  ];
  for (const seeds of cases) {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), options: TENANT_BYPASS_OPTION });
    try {
      await seedMap(pool, spec.table, seeds);
      await pool.query(`DELETE FROM qm_schema_migrations WHERE id = $1`, [conversion.id]);
      await applyPgMigrations(pool, [definePgMigration(conversion.id, conversion.statements)]);
      for (const statement of conversion.statements) await pool.query(statement);
      const columns = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'json'`,
        [spec.table],
      );
      assert.equal(columns.rowCount, 0, `${spec.table} keeps no json column`);
      const versions = await pool.query(`SELECT 1 FROM durable_map_versions WHERE tbl = $1`, [spec.table]);
      assert.equal(versions.rowCount, 0, `${spec.table} leaves no durable_map_versions row`);
      for (const [tenant, seeded] of seeds) {
        const found = await pool.query(
          `SELECT ${codec.columns} FROM ${spec.table} ${tenant ? "WHERE tenant_id = $1" : ""} ORDER BY ${columnName(spec.key)}`,
          tenant ? [tenant] : [],
        );
        const want = seeded.map((row) => wanted.get(row.id));
        assert.deepEqual(codec.rows(found.rows), want, `${spec.table} rows for tenant ${tenant}`);
      }
    } finally {
      await pool.end();
    }
  }
}
