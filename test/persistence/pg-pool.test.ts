import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import {
  createPgPool,
  resolvePgCaTrust,
  configurePgCaTrust,
  pgConnectionOptions,
  migrateRegisteredPgSchemas,
} from "../../src/persistence/pg-pool.ts";
import {
  concurrentIndexName,
  definePgMigration,
  pgMigrationChecksum,
  applyPgMigrations,
  PG_MIGRATIONS_TABLE,
} from "../../src/persistence/pg-migrations.ts";
import { settle } from "../support/settle.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

test("createPgPool is lazy: building it neither connects nor throws (no DB needed)", async () => {
  const pg = createPgPool("postgres://does-not-exist:0/none", "test/lazy/0001", ["SELECT 1"]);
  await assert.doesNotReject(pg.close());
});

test("importing pg-pool does NOT pull `pg` into the runtime import graph (zero-dep seam)", () => {
  const poolUrl = pathToUrl(fileURLToPath(new URL("../../src/persistence/pg-pool.ts", import.meta.url)));
  const loader =
    "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(specifier, ctx, next) {
         if (specifier === "pg" || specifier.endsWith("/pg")) {
           throw new Error("FORBIDDEN: pg was loaded eagerly");
         }
         return next(specifier, ctx);
       }`,
    );
  const script = `
    import { register } from "node:module";
    register(${JSON.stringify(loader)});
    const { createPgPool } = await import(${JSON.stringify(poolUrl)});
    const p = createPgPool("postgres://x/y", "test/invalid/0001", ["SELECT 1"]);
    await p.close();
    console.log("OK");
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  assert.match(out, /OK/);
});

test("migration checksums are stable and sensitive to statement changes", () => {
  assert.equal(pgMigrationChecksum([" SELECT 1 ", "SELECT 2;"]), pgMigrationChecksum(["SELECT 1", "SELECT 2;"]));
  assert.notEqual(pgMigrationChecksum(["SELECT 1"]), pgMigrationChecksum(["SELECT 2"]));
});

test("released migrations can pin their source checksum", () => {
  const migration = definePgMigration("test/pinned/0001", ["SELECT 1"]);
  assert.equal(definePgMigration("test/pinned/0001", ["SELECT 1"], migration.checksum).checksum, migration.checksum);
  assert.throws(
    () => definePgMigration("test/pinned/0001", ["SELECT 2"], migration.checksum),
    /source checksum mismatch/,
  );
});

test("migration definitions reject invalid ids", () => {
  assert.throws(() => definePgMigration("../bad", ["SELECT 1"]), /migration id/);
});

test("concurrentIndexName recognizes retryable concurrent index creation", () => {
  assert.equal(
    concurrentIndexName("CREATE INDEX CONCURRENTLY IF NOT EXISTS session_search ON sessions(id)"),
    "session_search",
  );
  assert.equal(concurrentIndexName("CREATE INDEX IF NOT EXISTS session_search ON sessions(id)"), undefined);
});

function pathToUrl(p: string): string {
  return new URL(`file://${p}`).href;
}

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
test("configured CA trust reaches the Postgres client when the URL specifies SSL settings", (t) => {
  configurePgCaTrust({ cert: PEM });
  t.after(() => configurePgCaTrust({}));
  for (const query of [
    "sslmode=verify-full",
    "sslmode=require",
    "sslmode=disable",
    "sslmode=no-verify",
    "ssl=0",
    "ssl=true",
    "ssl=no-verify",
    "sslnegotiation=direct",
  ]) {
    const client = new pg.Client(pgConnectionOptions(`postgres://user:password@localhost/core?${query}`));
    assert.deepEqual(client.ssl, { ca: PEM });
  }
});

test("configured CA trust preserves the Postgres client certificate and key", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pgca-client-"));
  const cert = join(dir, "client.crt");
  const key = join(dir, "client.key");
  writeFileSync(cert, "client-certificate");
  writeFileSync(key, "client-key");
  const url = new URL("postgres://user:password@localhost/core?sslmode=verify-full");
  url.searchParams.set("sslcert", cert);
  url.searchParams.set("sslkey", key);
  configurePgCaTrust({ cert: PEM });
  t.after(() => configurePgCaTrust({}));
  const client = new pg.Client(pgConnectionOptions(url.toString()));
  assert.deepEqual(client.ssl, { ca: PEM, cert: "client-certificate" });
  assert.equal(Object.getOwnPropertyDescriptor(client.ssl, "key")?.value, "client-key");
});

test("Postgres URL SSL settings remain effective without a configured CA", () => {
  const client = new pg.Client(pgConnectionOptions("postgres://user:password@localhost/core?sslmode=disable"));
  assert.equal(client.ssl, false);
});

test("no CA configured → no ssl override (connection string semantics untouched)", () => {
  assert.deepEqual(resolvePgCaTrust({}), {});
  assert.deepEqual(resolvePgCaTrust({ cert: "  " }), {});
});

test("PEM content wires into ssl.ca", () => {
  assert.deepEqual(resolvePgCaTrust({ cert: PEM }), { ssl: { ca: PEM } });
});

test("a cert file is read; inline PEM wins when both are set", () => {
  const dir = mkdtempSync(join(tmpdir(), "pgca-"));
  const file = join(dir, "root.crt");
  writeFileSync(file, PEM);
  assert.deepEqual(resolvePgCaTrust({ certFile: file }), { ssl: { ca: PEM } });
  assert.deepEqual(resolvePgCaTrust({ cert: PEM, certFile: "/nope" }), { ssl: { ca: PEM } });
});

test("an unreadable cert file fails loudly, not as silent no-verify", () => {
  assert.throws(() => resolvePgCaTrust({ certFile: "/does/not/exist.crt" }), /unreadable/);
});

const databaseUrl = process.env.DATABASE_URL!;

function names(): { id: string; table: string } {
  const suffix = randomUUID().replaceAll("-", "");
  return { id: `test/integration/${suffix}/0001`, table: `migration_test_${suffix}` };
}

test("concurrent index migrations adopt prebuilt indexes and serialize retries", async () => {
  const a = new pg.Pool({ connectionString: databaseUrl });
  const b = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  const index = `${table}_idx`;
  const migration = definePgMigration(id, [`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index} ON ${table}(value)`]);
  try {
    await a.query(`CREATE TABLE ${table}(value INT NOT NULL)`);
    await a.query(`CREATE INDEX CONCURRENTLY ${index} ON ${table}(value)`);
    const original = await a.query("SELECT to_regclass($1)::oid AS oid", [index]);
    await Promise.all([applyPgMigrations(a, [migration]), applyPgMigrations(b, [migration])]);
    const adopted = await a.query("SELECT to_regclass($1)::oid AS oid", [index]);
    assert.deepEqual(adopted.rows, original.rows);
    const ledger = await a.query(`SELECT checksum FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    assert.deepEqual(ledger.rows, [{ checksum: migration.checksum }]);
  } finally {
    await a.query(`DROP TABLE IF EXISTS ${table}`);
    await a.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    await Promise.all([a.end(), b.end()]);
  }
});

test("failed concurrent index builds are unrecorded and rebuild invalid indexes on retry", async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  const index = `${table}_idx`;
  const migration = definePgMigration(id, [
    `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${index} ON ${table}(value)`,
  ]);
  try {
    await pool.query(`CREATE TABLE ${table}(value INT NOT NULL)`);
    await pool.query(`INSERT INTO ${table} VALUES (1), (1)`);
    await assert.rejects(applyPgMigrations(pool, [migration]), /could not create unique index/);
    const failed = await pool.query("SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass($1)", [index]);
    assert.deepEqual(failed.rows, [{ indisvalid: false }]);
    assert.equal((await pool.query(`SELECT 1 FROM ${PG_MIGRATIONS_TABLE} WHERE id=$1`, [id])).rowCount, 0);
    await pool.query(`DELETE FROM ${table}`);
    await pool.query(`INSERT INTO ${table} VALUES (1), (2)`);
    await applyPgMigrations(pool, [migration]);
    const repaired = await pool.query("SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass($1)", [index]);
    assert.deepEqual(repaired.rows, [{ indisvalid: true }]);
    assert.equal((await pool.query(`SELECT 1 FROM ${PG_MIGRATIONS_TABLE} WHERE id=$1`, [id])).rowCount, 1);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    await pool.end();
  }
});

test("concurrent index migrations reject mixed transactional statements before execution", async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  try {
    await assert.rejects(
      applyPgMigrations(pool, [
        definePgMigration(id, [
          `CREATE TABLE ${table}(value INT)`,
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${table}_idx ON ${table}(value)`,
        ]),
      ]),
      /must contain only concurrent indexes/,
    );
    assert.equal((await pool.query("SELECT to_regclass($1) AS name", [table])).rows[0].name, null);
  } finally {
    await pool.end();
  }
});

test("concurrent index retry resolves indexes in the target table schema", async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  const schema = `s_${table}`;
  const index = `${table}_idx`;
  const migration = definePgMigration(id, [
    `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${index} ON ${schema}.events(value)`,
  ]);
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE ${schema}.events(value INT)`);
    await pool.query(`CREATE TABLE ${table}(value INT)`);
    await pool.query(`CREATE INDEX ${index} ON ${table}(value)`);
    const original = await pool.query("SELECT to_regclass($1)::oid AS oid", [index]);
    await pool.query(`INSERT INTO ${schema}.events VALUES (1), (1)`);
    await assert.rejects(applyPgMigrations(pool, [migration]), /could not create unique index/);
    await pool.query(`DELETE FROM ${schema}.events`);
    await applyPgMigrations(pool, [migration]);
    assert.deepEqual((await pool.query("SELECT to_regclass($1)::oid AS oid", [index])).rows, original.rows);
    const repaired = await pool.query("SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass($1)", [
      `${schema}.${index}`,
    ]);
    assert.deepEqual(repaired.rows, [{ indisvalid: true }]);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id=$1`, [id]);
    await pool.end();
  }
});

test("concurrent migrators apply one version exactly once", async () => {
  const a = new pg.Pool({ connectionString: databaseUrl });
  const b = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  const migration = definePgMigration(id, [
    `CREATE TABLE ${table}(value INT NOT NULL)`,
    `INSERT INTO ${table}(value) VALUES (1)`,
  ]);
  try {
    await Promise.all([applyPgMigrations(a, [migration]), applyPgMigrations(b, [migration])]);
    const rows = await a.query(`SELECT value FROM ${table}`);
    assert.deepEqual(rows.rows, [{ value: 1 }]);
    const applied = await a.query(`SELECT checksum FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    assert.equal(applied.rows[0]?.checksum, migration.checksum);
  } finally {
    await a.query(`DROP TABLE IF EXISTS ${table}`);
    await a.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    await Promise.all([a.end(), b.end()]);
  }
});

test("an applied migration rejects checksum drift", async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  try {
    await applyPgMigrations(pool, [definePgMigration(id, [`CREATE TABLE ${table}(value INT NOT NULL)`])]);
    await assert.rejects(
      applyPgMigrations(pool, [definePgMigration(id, [`CREATE TABLE ${table}(value TEXT NOT NULL)`])]),
      /checksum mismatch/,
    );
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    await pool.end();
  }
});

test("a failed migration rolls back and is not recorded", async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { id, table } = names();
  try {
    await assert.rejects(
      applyPgMigrations(pool, [
        definePgMigration(id, [`CREATE TABLE ${table}(value INT NOT NULL)`, `INSERT INTO missing_${table} VALUES (1)`]),
      ]),
    );
    const tableState = await pool.query("SELECT to_regclass($1) AS name", [table]);
    assert.equal(tableState.rows[0]?.name, null);
    const applied = await pool.query(`SELECT 1 FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    assert.equal(applied.rowCount, 0);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    await pool.end();
  }
});

const lock = "qm:schema-migrations";
test("waiting for the schema-migrations lock does not deadlock a concurrent index build", async () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const holder = new pg.Client({ connectionString: databaseUrl });
  const { id, table } = names();
  const store = createPgPool(databaseUrl, [{ id, statements: [`ALTER TABLE ${table} ADD COLUMN extra INT`] }]);
  await holder.connect();
  try {
    await admin.query(`CREATE TABLE ${table}(value INT NOT NULL)`);
    await admin.query(`INSERT INTO ${table}(value) VALUES (1)`);
    const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await holder.query("SELECT pg_advisory_lock(hashtext($1))", [lock]);
    const ready = store.pool();
    let startFailure: unknown;
    ready.catch((error: unknown) => {
      startFailure = error;
    });
    let waiting = 0;
    await settle(async () => {
      const waiters = await admin.query(
        "SELECT 1 FROM pg_stat_activity WHERE pid NOT IN (pg_backend_pid(), $1) AND query LIKE '%advisory_lock(hashtext(%'",
        [holderPid],
      );
      waiting = waiters.rowCount ?? 0;
      return waiting > 0;
    });
    assert.ok(waiting, `the store never waited for the schema lock${startFailure ? `: ${String(startFailure)}` : ""}`);
    try {
      await holder.query(`CREATE INDEX CONCURRENTLY ${table}_idx ON ${table}(value)`);
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtext($1))", [lock]);
    }
    await ready;
    assert.deepEqual(await store.q(`SELECT value, extra FROM ${table}`), [{ value: 1, extra: null }]);
  } finally {
    await holder.end();
    await store.close();
    await admin.query(`DROP TABLE IF EXISTS ${table}`);
    await admin.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [id]);
    await admin.end();
  }
});

const exec = promisify(execFile);

async function withDatabase(run: (url: string, admin: pg.Pool) => Promise<void>): Promise<void> {
  const parent = new pg.Pool({ connectionString: databaseUrl });
  const name = `migration_startup_${randomUUID().replaceAll("-", "")}`;
  await parent.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  const admin = new pg.Pool({ connectionString: url.toString() });
  try {
    await run(url.toString(), admin);
  } finally {
    await admin.end();
    await parent.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await parent.end();
  }
}

test("slow lazy migrations queue with dynamic and bulk migrations before pool acquisition", async () => {
  await withDatabase(async (url, admin) => {
    const slow = createPgPool(url, "startup/0001", ["SELECT pg_sleep(11)"]);
    const next = createPgPool(url, "startup/0002", ["CREATE TABLE startup_result(value INT)"]);
    try {
      const first = slow.q("SELECT 1");
      const second = next.q("SELECT 2");
      const dynamic = next.migrate({ id: "startup/0003", statements: ["INSERT INTO startup_result VALUES (3)"] });
      await Promise.all([first, second, dynamic, migrateRegisteredPgSchemas(url)]);
      assert.deepEqual((await admin.query("SELECT value FROM startup_result")).rows, [{ value: 3 }]);
      assert.equal(
        (await admin.query(`SELECT count(*)::int AS count FROM ${PG_MIGRATIONS_TABLE} WHERE id LIKE 'startup/%'`))
          .rows[0].count,
        3,
      );
      await assert.rejects(next.migrate({ id: "startup/0004", statements: ["SELECT * FROM missing_table"] }));
      await next.migrate({ id: "startup/0005", statements: ["INSERT INTO startup_result VALUES (5)"] });
      assert.deepEqual((await admin.query("SELECT value FROM startup_result ORDER BY value")).rows, [
        { value: 3 },
        { value: 5 },
      ]);
    } finally {
      await Promise.all([slow.close(), next.close()]);
    }
  });
});

test("concurrent cold and repeat migration entrypoints exit and reject checksum drift", async () => {
  await withDatabase(async (url, admin) => {
    const run = () =>
      exec(process.execPath, ["src/migrate-main.ts"], {
        cwd: new URL("../..", import.meta.url),
        timeout: 60_000,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_URL: url,
          SANDBOX_BACKEND: "local",
          ORG_ID: "migration-test",
          CONNECTOR_SECRET_KEY: "test-connector-secret-0123456789abcdef",
        },
      });
    const cold = await Promise.all([run(), run()]);
    for (const result of [...cold, await run()]) {
      assert.match(result.stdout, /\[qm:migrate\] database migrations applied/);
    }
    const applied = await admin.query(`SELECT id FROM ${PG_MIGRATIONS_TABLE} ORDER BY id`);
    assert.ok(applied.rowCount! > 10);
    await admin.query(`UPDATE ${PG_MIGRATIONS_TABLE} SET checksum = 'invalid' WHERE id = $1`, [applied.rows[0].id]);
    await assert.rejects(run(), (error: unknown) => {
      const failure = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1);
      assert.match(failure.stderr, /checksum mismatch/);
      assert.doesNotMatch(failure.stdout, /\[qm:migrate\] database migrations applied/);
      return true;
    });
  });
});

test("pg pool: a failed init is retried with a fresh attempt (rejection not cached)", async () => {
  const pg = createPgPool("postgres://127.0.0.1:9/nope", "test/retry/unreachable/0001", ["SELECT 1"]);
  const first = await pg.q("SELECT 1").catch((e: unknown) => e);
  const second = await pg.q("SELECT 1").catch((e: unknown) => e);
  assert.ok(first instanceof Error);
  assert.ok(second instanceof Error);
  assert.notEqual(first, second, "each call gets a fresh attempt, not the same cached rejection");
  await pg.close();
});

test("pg pool: an idle-client 'error' is logged, not fatal", async () => {
  const pg = createPgPool(testDatabaseUrl(), "test/retry/live/0001", ["SELECT 1"]);
  const pool = await pg.pool();
  assert.doesNotThrow(() => pool.emit("error", new Error("backend died")));
  assert.deepEqual((await pg.query("SELECT 1 AS one")).rows, [{ one: 1 }], "pool keeps serving queries");
  await pg.close();
});

test("pg pool: a timeoutMs query gives the connection back usable, not poisoned", async () => {
  const pg = createPgPool(testDatabaseUrl(), "test/retry/timeout/0001", ["SELECT 1"]);
  await assert.rejects(
    () => pg.q("SELECT pg_sleep(5)", [], { timeoutMs: 150 }),
    /statement timeout/i,
    "a query past its budget is cancelled by Postgres instead of hanging",
  );
  assert.deepEqual(await pg.q("SELECT 1 AS one"), [{ one: 1 }], "the pool keeps serving after a timeout");
  assert.deepEqual(
    await pg.q("SELECT 2 AS two", [], { timeoutMs: 5_000 }),
    [{ two: 2 }],
    "a query inside its budget returns normally",
  );
  const [row] = await pg.q("SHOW statement_timeout");
  assert.equal(row!.statement_timeout, "0", "the budget does not leak onto the next borrower of the connection");
  await pg.close();
});
