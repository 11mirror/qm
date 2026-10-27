import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import pg from "pg";
import { applyPgMigrations, definePgMigration } from "../src/persistence/pg-pool.ts";

// A refused migration run must leave the database exactly as it found it: no baseline adoption, no pending migration.

const base = process.env.DATABASE_URL;
const skip = base ? false : "set DATABASE_URL (a Postgres) to run the migration preflight tests";
const created: string[] = [];

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function createDatabase(fixture?: string): Promise<string> {
  const name = `qm_preflight_${randomBytes(6).toString("hex")}`;
  await withClient(base!, (client) => client.query(`CREATE DATABASE ${name}`));
  created.push(name);
  const url = new URL(base!);
  url.pathname = `/${name}`;
  if (fixture) {
    const sql = gunzipSync(readFileSync(new URL(`./fixtures/schema-baseline/${fixture}`, import.meta.url))).toString();
    await withClient(url.toString(), (client) => client.query(sql));
  }
  return url.toString();
}

async function withPool<T>(url: string, fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: url });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

const ledger = (pool: pg.Pool) =>
  pool
    .query<{ id: string; checksum: string }>("SELECT id, checksum FROM qm_schema_migrations ORDER BY id")
    .then((r) => r.rows);
const relation = (pool: pg.Pool, name: string) =>
  pool.query<{ r: string | null }>("SELECT to_regclass($1)::text AS r", [name]).then((r) => r.rows[0]!.r);

after(async () => {
  if (!base) return;
  for (const name of created) {
    await withClient(base, (client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  }
});

test("a checksum mismatch refuses the run before any pending migration applies", { skip }, async () => {
  const url = await createDatabase();
  await withPool(url, async (pool) => {
    await applyPgMigrations(pool, [definePgMigration("test/preflight-a", ["CREATE TABLE preflight_a(x int)"])]);
    const before = await ledger(pool);
    await assert.rejects(
      applyPgMigrations(pool, [
        // Sorts first, so a run that checked as it went would apply it before reaching the mismatch.
        definePgMigration("test/preflight-0-pending", ["CREATE TABLE preflight_pending(x int)"]),
        definePgMigration("test/preflight-a", ["CREATE TABLE preflight_a(x int, y int)"]),
      ]),
      /nothing was applied: migration test\/preflight-a checksum mismatch/,
    );
    assert.deepEqual(await ledger(pool), before);
    assert.equal(await relation(pool, "preflight_pending"), null);
  });
});

test("a checksum mismatch refuses before the baseline is adopted", { skip }, async () => {
  const url = await createDatabase("main-9be16d35.sql.gz");
  await withPool(url, async (pool) => {
    await pool.query(
      "INSERT INTO qm_schema_migrations(id, checksum) VALUES ('test/preflight-a', 'released-elsewhere')",
    );
    const before = await ledger(pool);
    await assert.rejects(
      applyPgMigrations(pool, [
        definePgMigration("test/preflight-0-pending", ["CREATE TABLE preflight_pending(x int)"]),
        definePgMigration("test/preflight-a", ["CREATE TABLE preflight_a(x int)"]),
      ]),
      /checksum mismatch \(database=released-elsewhere/,
    );
    assert.deepEqual(await ledger(pool), before);
    assert.ok(!before.some((row) => row.id === "baseline/0001"));
    assert.equal(await relation(pool, "preflight_pending"), null);
  });
});

test("an id defined twice with different statements refuses the run", { skip }, async () => {
  const url = await createDatabase();
  await withPool(url, async (pool) => {
    await assert.rejects(
      applyPgMigrations(pool, [
        definePgMigration("test/preflight-twin", ["CREATE TABLE preflight_twin(x int)"]),
        definePgMigration("test/preflight-twin", ["CREATE TABLE preflight_twin(y int)"]),
      ]),
      /test\/preflight-twin is defined twice/,
    );
    assert.equal(await relation(pool, "qm_schema_migrations"), null);
  });
});
