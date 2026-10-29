import { readFileSync } from "node:fs";
import type { ClientConfig, Pool, PoolClient } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import { createKeyedQueue } from "../util/async.ts";
import { errMessage } from "../util/errors.ts";
import { applyPgMigrations, type PgMigration, type PgMigrationDefinition } from "./pg-migrations.ts";
import { pgMigrationOrder, pgMigrationsFrom } from "./contract-migrations.ts";
import { applyTenancy, prepareTenancy } from "./tenancy.ts";
import { rollbackOrReport, runPgQuery } from "./pg-query.ts";

export type { Pool, PoolClient };

export type Rows = Record<string, unknown>[];

interface PgPoolingConfig {
  databaseUrl?: string;
  migrationUrl?: string;
  poolUrl?: string;
  caCert?: string;
  queryMax?: number;
  sessionMax?: number;
  tenancy?: boolean;
}

let poolingConfig: PgPoolingConfig = {};

let tenantSource: () => string | null | undefined = () => undefined;

export function configurePgTenantSource(source: () => string | null | undefined): void {
  tenantSource = source;
}

export function tenantLockKey(key: string): string {
  const id = tenancyEnabled ? tenantSource() : undefined;
  return id ? `tenant:${id}:${key}` : key;
}

function tenantScopedPool(pool: Pool): Pool {
  const connect = pool.connect.bind(pool) as () => Promise<PoolClient>;
  const scoped = (
    callback?: (err: Error | undefined, client?: PoolClient, done?: (release?: unknown) => void) => void,
  ) => {
    const id = tenantSource();
    const ready = Promise.resolve().then(async () => {
      if (tenancyEnabled && !id) throw new Error("Postgres query requires an explicit tenant context");
      const client = await connect();
      if (tenancyEnabled) {
        try {
          await client.query("SELECT set_config('qm.tenant_id', $1, false)", [id]);
        } catch (error) {
          client.release(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      }
      return client as PoolClient;
    });
    if (!callback) return ready;
    ready.then(
      (client) => callback(undefined, client, (release?: unknown) => client.release(release as Error | undefined)),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
    return undefined;
  };
  (pool as unknown as { connect: typeof scoped }).connect = scoped;
  return pool;
}

export function configurePgPooling(config: PgPoolingConfig): void {
  if (config.poolUrl && !config.databaseUrl) throw new Error("DATABASE_POOL_URL requires DATABASE_URL");
  for (const [name, value] of [
    ["DATABASE_POOL_MAX", config.queryMax],
    ["DATABASE_DIRECT_POOL_MAX", config.sessionMax],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  poolingConfig = { ...config };
  if (config.tenancy !== undefined) configurePgTenancy(config.tenancy);
}

let tenancyEnabled = false;

export function pgTenancyEnabled(): boolean {
  return tenancyEnabled;
}

export function configurePgTenancy(enabled: boolean): void {
  tenancyEnabled = enabled;
}

export function tenantCols(cols: string): string {
  return tenancyEnabled ? `tenant_id, ${cols}` : cols;
}

const migrationQueue = createKeyedQueue();

const sharedPools = new Map<string, { pool: Pool; users: number }>();

const tenantized = new Set<string>();

const settledMigrations = new Map<string, Set<string>>();
const startupMigrated = new Set<string>();

async function applyAndSettle(
  pool: Pool,
  connectionString: string,
  migrations: readonly PgMigration[],
  retenantize = false,
): Promise<void> {
  const lock = tenancyEnabled ? await pool.connect() : undefined;
  let failed: Error | undefined;
  try {
    if (lock) await lock.query("SELECT pg_advisory_lock(hashtext('qm:bootstrap'))");
    const existing = tenancyEnabled && (await prepareTenancy(pool));
    const applied = await applyPgMigrations(pool, migrations);
    let settled = settledMigrations.get(connectionString);
    if (!settled) settledMigrations.set(connectionString, (settled = new Set()));
    for (const migration of migrations) settled.add(migration.id);
    if (!tenancyEnabled || (!retenantize && applied === 0 && tenantized.has(connectionString))) return;
    await applyTenancy(pool, existing);
    tenantized.add(connectionString);
  } finally {
    if (lock) {
      await lock.query("SELECT pg_advisory_unlock(hashtext('qm:bootstrap'))").catch((error: unknown) => {
        failed = error instanceof Error ? error : new Error(String(error));
      });
      lock.release(failed);
    }
  }
}

const DEFAULT_QUERY_POOL_MAX = 10;
const DEFAULT_SESSION_POOL_MAX = 32;

export function pgPoolMax(kind: "query" | "session"): number {
  return kind === "query"
    ? (poolingConfig.queryMax ?? DEFAULT_QUERY_POOL_MAX)
    : (poolingConfig.sessionMax ?? DEFAULT_SESSION_POOL_MAX);
}

async function retainPool(
  connectionString: string,
  kind: "query" | "session" | "migration" | "deployment",
): Promise<Pool> {
  const pg = (await import("pg")).default;
  const key = `${kind}:${connectionString}`;
  const existing = sharedPools.get(key);
  if (existing) {
    existing.users++;
    return existing.pool;
  }
  const setting = kind === "query" ? "DATABASE_POOL_MAX" : "DATABASE_DIRECT_POOL_MAX";
  const max = kind === "migration" ? 2 : pgPoolMax(kind === "deployment" ? "session" : kind);
  if (!Number.isInteger(max) || max < 1) throw new Error(`${setting} must be a positive integer`);
  const connection = pgConnectionOptions(
    kind === "migration" ? migrationDatabaseUrl(connectionString) : connectionString,
    kind === "query" && connectionString === poolingConfig.poolUrl ? poolingConfig.caCert : undefined,
  );
  const poolOptions = {
    ...connection,
    ...(kind === "deployment" ? { options: "-c qm.tenant_id=" } : {}),
    max,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  };
  const pool =
    kind === "migration" || kind === "deployment"
      ? guardedPool(new pg.Pool(poolOptions))
      : tenantScopedPool(guardedPool(new pg.Pool(poolOptions)));
  sharedPools.set(key, { pool, users: 1 });
  return pool;
}

function migrationDatabaseUrl(connectionString: string): string {
  if (!tenancyEnabled) return connectionString;
  if (!poolingConfig.migrationUrl) throw new Error("Multitenant migrations require DATABASE_MIGRATION_URL");
  const migration = new URL(poolingConfig.migrationUrl);
  const application = new URL(connectionString);
  migration.pathname = application.pathname;
  return migration.toString();
}

function guardedPool(pool: Pool): Pool {
  pool.on("error", (error) => console.error("[pg] idle client error:", errMessage(error)));
  pool.on("connect", (client) => client.on("error", (error) => console.error("[pg] client error:", errMessage(error))));
  return pool;
}

async function releasePool(
  connectionString: string,
  pool: Pool,
  kind: "query" | "session" | "migration" | "deployment",
): Promise<void> {
  const key = `${kind}:${connectionString}`;
  const entry = sharedPools.get(key);
  if (!entry || entry.pool !== pool) return;
  if (--entry.users === 0) {
    sharedPools.delete(key);
    await pool.end();
  }
}

function pooledDatabaseUrl(connectionString: string): string {
  const pooled = poolingConfig.poolUrl;
  if (!pooled || connectionString !== poolingConfig.databaseUrl) return connectionString;
  const directUrl = new URL(connectionString);
  const pooledUrl = new URL(pooled);
  if (
    directUrl.username !== pooledUrl.username ||
    directUrl.password !== pooledUrl.password ||
    directUrl.pathname !== pooledUrl.pathname
  ) {
    throw new Error("DATABASE_POOL_URL must preserve the DATABASE_URL database and credentials");
  }
  return pooled;
}

export interface PgQueryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PgPool {
  pool(): Promise<Pool>;
  sessionPool(): Promise<Pool>;
  deploymentPool(): Promise<Pool>;
  q(text: string, params?: unknown[], options?: PgQueryOptions): Promise<Rows>;
  query(text: string, params?: unknown[], options?: PgQueryOptions): Promise<{ rows: Rows; rowCount: number }>;
  registerMigration(migration: PgMigrationDefinition): void;
  migrate(migration: PgMigrationDefinition): Promise<void>;
  close(): Promise<void>;
}

export async function withPgTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let rollbackError: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    rollbackError = await rollbackOrReport(client, "pg-pool: rollback transaction");
    throw error;
  } finally {
    client.release(rollbackError);
  }
}

export function resolvePgCaTrust(opts: { cert?: string; certFile?: string }): { ssl?: { ca: string } } {
  if (opts.cert?.trim()) return { ssl: { ca: opts.cert } };
  if (opts.certFile?.trim()) {
    try {
      return { ssl: { ca: readFileSync(opts.certFile, "utf8") } };
    } catch (e) {
      throw new Error(`DATABASE_CA_CERT_FILE is set but unreadable (${opts.certFile}): ${errMessage(e)}`, {
        cause: e,
      });
    }
  }
  return {};
}

let installedCaTrust: { ssl?: { ca: string } } = {};

export function configurePgCaTrust(opts: { cert?: string; certFile?: string }): void {
  installedCaTrust = resolvePgCaTrust(opts);
}

export function pgConnectionOptions(connectionString: string, ca = installedCaTrust.ssl?.ca): ClientConfig {
  if (!ca) return { connectionString };
  const url = new URL(connectionString);
  url.searchParams.delete("ssl");
  url.searchParams.delete("sslrootcert");
  url.searchParams.set("sslmode", "verify-full");
  const config = parseIntoClientConfig(url.toString());
  return { ...config, ssl: { ...(typeof config.ssl === "object" ? config.ssl : {}), ca } };
}

const registeredMigrations = new Map<string, Map<string, PgMigration>>();

function registerPgMigration(connectionString: string, migration: PgMigration): void {
  let database = registeredMigrations.get(connectionString);
  if (!database) {
    database = new Map();
    registeredMigrations.set(connectionString, database);
  }
  const existing = database.get(migration.id);
  if (tenancyEnabled && startupMigrated.has(connectionString) && !existing)
    throw new Error("Multitenant migrations must be registered before startup");
  if (existing && existing.checksum !== migration.checksum) {
    throw new Error(`pg-pool: migration ${migration.id} was registered twice with different checksums`);
  }
  database.set(migration.id, migration);
}

export function registeredPgMigrations(connectionString: string): readonly PgMigration[] {
  return [...(registeredMigrations.get(connectionString)?.values() ?? [])].sort((a, b) => pgMigrationOrder(a.id, b.id));
}

export async function migrateRegisteredPgSchemas(connectionString?: string): Promise<void> {
  const databases = connectionString
    ? [[connectionString, registeredMigrations.get(connectionString)] as const]
    : [...registeredMigrations.entries()];
  for (const [databaseUrl, registered] of databases) {
    if (!registered?.size) continue;
    await migrationQueue(databaseUrl, async () => {
      const pg = (await import("pg")).default;
      const pool = guardedPool(new pg.Pool({ ...pgConnectionOptions(migrationDatabaseUrl(databaseUrl)), max: 1 }));
      try {
        await applyAndSettle(pool, databaseUrl, registeredPgMigrations(databaseUrl), true);
        if (tenancyEnabled) startupMigrated.add(databaseUrl);
      } finally {
        await pool.end();
      }
    });
  }
}

export function createPgPool(connectionString: string, definitions?: readonly PgMigrationDefinition[]): PgPool {
  const migrates = definitions !== undefined;
  const migrations = (definitions ?? []).flatMap(pgMigrationsFrom);
  for (const migration of migrations) registerPgMigration(connectionString, migration);
  let readyP: Promise<void> | null = null;
  let sessionPoolP: Promise<Pool> | null = null;
  let deploymentPoolP: Promise<Pool> | null = null;
  let queryPoolP: Promise<Pool> | null = null;
  let closed = false;
  const queryUrl = pooledDatabaseUrl(connectionString);
  async function withMigrationPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
    return migrationQueue(connectionString, async () => {
      const instance = await retainPool(connectionString, "migration");
      try {
        return await fn(instance);
      } finally {
        await releasePool(connectionString, instance, "migration");
      }
    });
  }
  async function settle(): Promise<void> {
    if (!migrates && !tenancyEnabled) return;
    const migrations = registeredPgMigrations(connectionString);
    const settled = settledMigrations.get(connectionString);
    const current = settled && migrations.every((migration) => settled.has(migration.id));
    if (current && (!tenancyEnabled || tenantized.has(connectionString))) return;
    if (tenancyEnabled && startupMigrated.has(connectionString))
      throw new Error("Multitenant schemas must be initialized before startup");
    await withMigrationPool((instance) => applyAndSettle(instance, connectionString, migrations));
  }

  async function ready(): Promise<void> {
    if (closed) throw new Error("Postgres store is closed");
    await (readyP ??= settle().catch((error) => {
      readyP = null;
      throw error;
    }));
    if (closed) throw new Error("Postgres store is closed");
  }
  async function pool(): Promise<Pool> {
    await ready();
    if (closed) throw new Error("Postgres store is closed");
    return (queryPoolP ??= retainPool(queryUrl, "query"));
  }
  async function deploymentPool(): Promise<Pool> {
    await ready();
    return (deploymentPoolP ??= retainPool(connectionString, "deployment"));
  }

  async function sessionPool(): Promise<Pool> {
    await ready();
    if (closed) throw new Error("Postgres store is closed");
    return (sessionPoolP ??= retainPool(connectionString, "session"));
  }
  async function query(
    text: string,
    params: unknown[] = [],
    options: PgQueryOptions = {},
  ): Promise<{ rows: Rows; rowCount: number }> {
    return runPgQuery(await pool(), text, params, options);
  }
  async function q(text: string, params: unknown[] = [], options?: PgQueryOptions): Promise<Rows> {
    return (await query(text, params, options)).rows;
  }
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await readyP?.catch(() => {});
    await Promise.all([
      queryPoolP?.then((instance) => releasePool(queryUrl, instance, "query")),
      sessionPoolP?.then((instance) => releasePool(connectionString, instance, "session")),
      deploymentPoolP?.then((instance) => releasePool(connectionString, instance, "deployment")),
    ]);
  }
  async function migrate(definition: PgMigrationDefinition): Promise<void> {
    const migrations = pgMigrationsFrom(definition);
    for (const migration of migrations) registerPgMigration(connectionString, migration);
    if (closed) throw new Error("Postgres store is closed");
    await ready();
    if (tenancyEnabled && startupMigrated.has(connectionString)) return;
    await withMigrationPool((instance) => applyAndSettle(instance, connectionString, migrations));
  }
  function registerMigration(definition: PgMigrationDefinition): void {
    for (const migration of pgMigrationsFrom(definition)) registerPgMigration(connectionString, migration);
  }
  return { pool, sessionPool, deploymentPool, q, query, registerMigration, migrate, close };
}
