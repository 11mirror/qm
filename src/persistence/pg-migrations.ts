import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { sleep } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";
import { SCHEMA_BASELINE, schemaBaselineChain, type ChainMigration } from "./schema-baseline.ts";
import { rollbackOrReport } from "./pg-query.ts";

export const PG_MIGRATIONS_TABLE = "qm_schema_migrations";

export interface PgMigrationDefinition {
  id: string;
  statements: readonly string[];
  expectedChecksum?: string;
  acceptedChecksums?: readonly string[];
  before?: readonly PgMigrationDefinition[];
  contract?: PgMigrationDefinition;
  transform?: { version: string; run: (client: PoolClient) => Promise<void> };
}

export interface PgMigration extends PgMigrationDefinition {
  checksum: string;
}

export function concurrentIndexName(stmt: string): string | undefined {
  return /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_$]*)\s+ON\s/i.exec(
    stmt,
  )?.[1];
}

export function pgMigrationChecksum(statements: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(statements.map((statement) => statement.trim())))
    .digest("hex");
}

export function definePgMigration(
  id: string,
  statements: readonly string[],
  expectedChecksum?: string,
  acceptedChecksums?: readonly string[],
): PgMigration {
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(id) || id.includes("..")) {
    throw new Error(`pg-migrations: invalid migration id ${JSON.stringify(id)}`);
  }
  const normalized = statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
  const checksum = pgMigrationChecksum(normalized);
  if (expectedChecksum !== undefined && checksum !== expectedChecksum) {
    throw new Error(
      `pg-migrations: migration ${id} source checksum mismatch (expected=${expectedChecksum}, actual=${checksum})`,
    );
  }
  return {
    id,
    statements: normalized,
    checksum,
    ...(acceptedChecksums?.length ? { acceptedChecksums } : {}),
  };
}

export function pgMigrationFrom(definition: PgMigrationDefinition): PgMigration {
  const result = definePgMigration(
    definition.id,
    definition.transform
      ? [...definition.statements, `SELECT '${definition.transform.version.replaceAll("'", "''")}'`]
      : definition.statements,
    definition.expectedChecksum,
    definition.acceptedChecksums,
  );
  return { ...result, ...(definition.transform ? { transform: definition.transform } : {}) };
}

const SCHEMA_LOCK_POLL_MS = 50;

async function lockSchema(client: PoolClient, name: string): Promise<void> {
  for (;;) {
    const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [
      name,
    ]);
    if (result.rows[0]?.locked) return;
    await sleep(SCHEMA_LOCK_POLL_MS);
  }
}

type BaselinePlan = "recorded" | "apply" | "adopt" | "upgrade";

async function planSchemaBaseline(client: PoolClient, ledger: ReadonlyMap<string, string>): Promise<BaselinePlan> {
  const { id, checksum } = SCHEMA_BASELINE;
  const recorded = ledger.get(id);
  if (recorded !== undefined) {
    if (recorded !== checksum) {
      throw new Error(
        `pg-migrations: schema baseline ${id} checksum mismatch (database=${recorded}, source=${checksum})`,
      );
    }
    return "recorded";
  }
  if (ledger.size === 0) {
    const existing = await client.query<{ present: boolean }>(
      "SELECT COALESCE(to_regclass('sessions'), to_regclass('durable_map_versions'), to_regclass('schema_migrations')) IS NOT NULL AS present",
    );
    if (!existing.rows[0]?.present) return "apply";
  }
  return schemaBaselineChain().migrations.every((migration) => ledger.has(migration.id)) ? "adopt" : "upgrade";
}

async function applyInTransaction(
  client: PoolClient,
  label: string,
  statements: readonly string[],
  record: PgMigration | undefined,
  failure: { discard?: Error },
): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const statement of statements) await client.query(statement);
    if (record) {
      await record.transform?.run(client);
      await client.query(`INSERT INTO ${PG_MIGRATIONS_TABLE}(id, checksum) VALUES ($1, $2)`, [
        record.id,
        record.checksum,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    failure.discard = await rollbackOrReport(client, `pg-migrations: rollback ${label}`);
    throw error;
  }
}

async function appliedUnderPreLedgerId(client: PoolClient, preLedgerId: string): Promise<boolean> {
  const legacy = await client.query<{ present: boolean }>(
    "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
  );
  if (!legacy.rows[0]?.present) return false;
  return Boolean((await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [preLedgerId])).rowCount);
}

async function withoutStatementTimeout<T>(client: PoolClient, work: () => Promise<T>): Promise<T> {
  await client.query("SET statement_timeout = 0");
  try {
    return await work();
  } finally {
    await client.query("RESET statement_timeout").catch(swallowAs("pg-migrations: reset statement timeout", undefined));
  }
}

async function runUntimed(client: PoolClient, statements: readonly string[]): Promise<void> {
  await withoutStatementTimeout(client, async () => {
    for (const statement of statements) await client.query(statement);
  });
}

async function upgradeToSchemaBaseline(
  client: PoolClient,
  pending: readonly ChainMigration[],
  failure: { discard?: Error },
): Promise<void> {
  const { before, after } = schemaBaselineChain();
  for (const step of before)
    await applyInTransaction(client, `maintenance ${step.id}`, step.statements, undefined, failure);
  for (const migration of pending) {
    if (migration.prepare) await runUntimed(client, migration.prepare);
    if (migration.statements.some((statement) => concurrentIndexName(statement))) {
      await createConcurrentIndexes(client, migration);
      await applyInTransaction(client, `migration ${migration.id}`, [], migration, failure);
      continue;
    }
    const adopted =
      migration.preLedgerId !== undefined && (await appliedUnderPreLedgerId(client, migration.preLedgerId));
    await applyInTransaction(
      client,
      `migration ${migration.id}`,
      adopted ? [] : migration.statements,
      migration,
      failure,
    );
  }
  for (const step of after)
    await applyInTransaction(client, `maintenance ${step.id}`, step.statements, undefined, failure);
}

async function createConcurrentIndexes(client: PoolClient, migration: PgMigration): Promise<void> {
  for (const statement of migration.statements) {
    const name = concurrentIndexName(statement)!;
    const table = /\sON\s+(?:ONLY\s+)?([a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?)\s*(?:USING\s+[a-z_]+\s*)?\(/i.exec(
      statement,
    )?.[1];
    if (!table) throw new Error(`pg-migrations: unsupported concurrent index target in ${migration.id}`);
    const inspect = () =>
      client.query<{ indisvalid: boolean; indisready: boolean; same_table: boolean; qualified_name: string }>(
        `SELECT i.indisvalid, i.indisready, i.indrelid = t.oid AS same_table,
              quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS qualified_name
       FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = $2
       JOIN pg_index i ON i.indexrelid = c.oid WHERE t.oid = to_regclass($1)`,
        [table.toLowerCase(), name.toLowerCase()],
      );
    const existing = (await inspect()).rows[0];
    if (existing && !existing.same_table)
      throw new Error(`pg-migrations: concurrent index ${name} belongs to a different table`);
    if (existing?.indisvalid === false) await client.query(`DROP INDEX CONCURRENTLY ${existing.qualified_name}`);
    await client.query(statement);
    const built = (await inspect()).rows[0];
    if (!built?.indisvalid || !built.indisready || !built.same_table) {
      throw new Error(`pg-migrations: concurrent index ${name} is not ready and valid`);
    }
  }
}

async function applySchemaBaseline(client: PoolClient, plan: BaselinePlan): Promise<void> {
  const { id, checksum, sql } = SCHEMA_BASELINE;
  await client.query("BEGIN");
  try {
    if (plan === "apply") {
      await client.query("SET LOCAL check_function_bodies = false");
      await client.query(sql);
    }
    await client.query(`INSERT INTO ${PG_MIGRATIONS_TABLE}(id, checksum) VALUES ($1, $2)`, [id, checksum]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(swallowAs(`pg-migrations: rollback schema baseline ${id}`, undefined));
    throw error;
  }
}

function preflightPgMigrations<M extends PgMigration>(
  ledger: ReadonlyMap<string, string>,
  migrations: readonly M[],
): { pending: M[]; acceptedPrior: string[] } {
  const seen = new Map<string, string>();
  const problems: string[] = [];
  const pending: M[] = [];
  const acceptedPrior: string[] = [];
  for (const migration of migrations) {
    const twin = seen.get(migration.id);
    if (twin !== undefined) {
      if (twin !== migration.checksum) problems.push(`${migration.id} is defined twice with different checksums`);
      continue;
    }
    seen.set(migration.id, migration.checksum);
    const recorded = ledger.get(migration.id);
    if (recorded === undefined) {
      if (
        migration.statements.some((statement) => concurrentIndexName(statement)) &&
        !migration.statements.every((statement) => concurrentIndexName(statement))
      ) {
        problems.push(`concurrent index migration ${migration.id} must contain only concurrent indexes`);
      }
      pending.push(migration);
    } else if (recorded !== migration.checksum) {
      if (migration.acceptedChecksums?.includes(recorded)) acceptedPrior.push(migration.id);
      else
        problems.push(
          `migration ${migration.id} checksum mismatch (database=${recorded}, source=${migration.checksum})`,
        );
    }
  }
  if (problems.length) {
    throw new Error(`pg-migrations: refusing to migrate; nothing was applied: ${problems.join("; ")}`);
  }
  return { pending, acceptedPrior };
}

const BASELINE_PLAN_LOG = {
  recorded: "already recorded",
  apply: "applying to an empty database",
  adopt: "adopting over the folded migrations",
  upgrade: "upgrading through the pre-baseline migrations",
} as const;

export async function applyPgMigrations(pool: Pool, migrations: readonly PgMigration[]): Promise<number> {
  const client = await pool.connect();
  const failure: { discard?: Error } = {};
  try {
    await lockSchema(client, "qm:schema-migrations");
    const hasLedger = (
      await client.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [PG_MIGRATIONS_TABLE])
    ).rows[0]?.present;
    const ledger = new Map(
      hasLedger
        ? (
            await client.query<{ id: string; checksum: string }>(`SELECT id, checksum FROM ${PG_MIGRATIONS_TABLE}`)
          ).rows.map((row) => [row.id, row.checksum] as const)
        : [],
    );
    const baseline = await planSchemaBaseline(client, ledger);
    const chainPending =
      baseline === "adopt" || baseline === "upgrade"
        ? preflightPgMigrations(ledger, schemaBaselineChain().migrations).pending
        : [];
    const { pending, acceptedPrior } = preflightPgMigrations(ledger, migrations);
    console.log(
      `[pg] migration preflight ok: ${pending.length} pending (${ledger.size} recorded); baseline ${BASELINE_PLAN_LOG[baseline]}` +
        (chainPending.length ? ` (${chainPending.length} to run)` : "") +
        (acceptedPrior.length ? `; accepted an earlier checksum for ${acceptedPrior.join(", ")}` : ""),
    );
    if (baseline === "recorded" && pending.length === 0) return 0;
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${PG_MIGRATIONS_TABLE}(
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    );
    let applied = 0;
    if (baseline !== "recorded") {
      if (baseline === "upgrade") await upgradeToSchemaBaseline(client, chainPending, failure);
      await applySchemaBaseline(client, baseline);
      applied += chainPending.length + 1;
    }
    let remaining = pending;
    while (remaining.length) {
      const migration = remaining[0]!;
      remaining = remaining.slice(1);
      if (migration.statements.some((statement) => concurrentIndexName(statement))) {
        await client.query("SELECT pg_advisory_unlock(hashtext('qm:schema-migrations'))");
        const indexLock = `qm:schema-migrations:${migration.id}`;
        await lockSchema(client, indexLock);
        try {
          const done = await client.query(`SELECT 1 FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [migration.id]);
          if (!done.rowCount) {
            await createConcurrentIndexes(client, migration);
            await client.query(`INSERT INTO ${PG_MIGRATIONS_TABLE}(id, checksum) VALUES ($1, $2)`, [
              migration.id,
              migration.checksum,
            ]);
            applied++;
          }
        } finally {
          await client
            .query("SELECT pg_advisory_unlock(hashtext($1))", [indexLock])
            .catch(swallowAs("pg-migrations: concurrent index unlock", undefined));
        }
        await lockSchema(client, "qm:schema-migrations");
        const ledgerNow = new Map(
          (
            await client.query<{ id: string; checksum: string }>(`SELECT id, checksum FROM ${PG_MIGRATIONS_TABLE}`)
          ).rows.map((row) => [row.id, row.checksum] as const),
        );
        remaining = preflightPgMigrations(ledgerNow, remaining).pending;
        continue;
      }
      await applyInTransaction(client, `migration ${migration.id}`, migration.statements, migration, failure);
      applied++;
    }
    return applied;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext('qm:schema-migrations'))")
      .catch(swallowAs("pg-migrations: schema-migrations unlock", undefined));
    client.release(failure.discard);
  }
}
