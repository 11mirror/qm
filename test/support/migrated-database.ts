import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { tableCodec, type TableSpec } from "../../src/persistence/typed-table.ts";
import { testDatabaseUrl } from "./test-database.ts";

export const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run migration tests";
const exec = promisify(execFile);

export const migrate = (url: string) =>
  exec(process.execPath, ["src/migrate-main.ts"], {
    cwd: new URL("../..", import.meta.url),
    timeout: 120_000,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DATABASE_URL: url,
      SANDBOX_BACKEND: "local",
      ORG_ID: "o",
      CONNECTOR_SECRET_KEY: "test-connector-secret-0123456789abcdef",
    },
  });

export async function withMigratedDatabase(run: (url: string, admin: pg.Pool) => Promise<void>): Promise<void> {
  const url = testDatabaseUrl();
  const admin = new pg.Pool({ connectionString: url });
  try {
    await run(url, admin);
  } finally {
    await admin.end();
  }
}

export async function typedRows<T = Record<string, unknown>>(pool: pg.Pool, spec: TableSpec) {
  const codec = tableCodec<Record<string, unknown>>(spec);
  const found = await pool.query(`SELECT ${codec.columns} FROM ${spec.table}`);
  return Object.fromEntries(codec.rows(found.rows).map((row) => [row[spec.key], row])) as Record<string, T>;
}

export async function asMapTables(pool: pg.Pool, specs: readonly TableSpec[]) {
  for (const { table } of specs) {
    await pool.query(`DROP TABLE ${table}`);
    await pool.query(`DELETE FROM qm_schema_migrations WHERE id = $1`, [`typed/config/${table}/0001`]);
  }
}
