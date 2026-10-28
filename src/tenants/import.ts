import { spawn } from "node:child_process";
import pg from "pg";
import { pgConnectionOptions } from "../persistence/pg-pool.ts";
import { TENANCY_EXCLUDED_TABLES } from "../persistence/tenancy.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import type { SqlRunner } from "./registry.ts";
import { copyRows, insertableColumns, primaryKey, qualified, type TableRef } from "./row-copy.ts";

const STAGED_SCHEMAS = ["public", "absurd", "pgboss"];

export interface TenantImportOptions {
  sourceUrl: string;
  stagingUrl: string;
  targetUrl: string;
  slug: string;
  orgId: string;
  hosts: string[];
  tenantId?: string;
  dryRun: boolean;
  replace: boolean;
  createStaging: boolean;
  maintenanceUrl?: string;
  batchSize: number;
  migrate: (stagingUrl: string) => Promise<void>;
  writeTenant: (tenantId: string, db: SqlRunner) => Promise<void>;
  log: (line: string) => void;
}

interface TableCount {
  table: string;
  staging: number;
  target: number;
}

export interface TenantImportResult {
  tenantId: string;
  tables: TableCount[];
  committed: boolean;
}

const UNSCOPED_TABLES = new Set(TENANCY_EXCLUDED_TABLES);

function describeDatabase(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
}

async function connect(url: string, readOnly = false): Promise<pg.Client> {
  const client = new pg.Client({
    ...pgConnectionOptions(url),
    ...(readOnly ? { options: "-c default_transaction_read_only=on" } : {}),
  });
  await client.connect();
  return client;
}

async function closingAfter<T>(fn: () => Promise<T>, close: () => Promise<unknown>): Promise<T> {
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    await close().catch((closeError: unknown) => {
      throw new AggregateError([error, closeError], errMessage(error));
    });
    throw error;
  }
  await close();
  return result;
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>, readOnly = false): Promise<T> {
  const client = await connect(url, readOnly);
  return closingAfter(
    () => fn(client),
    () => client.end(),
  );
}

async function createDatabase(options: TenantImportOptions): Promise<void> {
  const url = options.stagingUrl;
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if ([options.sourceUrl, options.targetUrl].some((other) => describeDatabase(other) === describeDatabase(url))) {
    throw new Error("the staging database must differ from the source and target databases");
  }
  const maintenance = new URL(options.maintenanceUrl ?? url);
  if (!options.maintenanceUrl) maintenance.pathname = "/postgres";
  await withClient(maintenance.toString(), async (client) => {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (rowCount && !options.replace) return;
    if (rowCount) {
      await client.query(`DROP DATABASE ${pg.escapeIdentifier(name)} WITH (FORCE)`);
      options.log(`dropped staging database ${name}`);
    }
    await client.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
    options.log(`created staging database ${name}`);
  });
}

async function tenantSingleton(client: pg.Client): Promise<string | undefined> {
  const { rows } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('public.qm_tenant') IS NOT NULL AS present",
  );
  if (!rows[0]?.present) return undefined;
  const { rows: tenants } = await client.query<{ id: string }>("SELECT id::text AS id FROM public.qm_tenant LIMIT 1");
  return tenants[0]?.id;
}

async function unstagedSchemas(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
      WHERE nspname <> ALL($1::text[]) AND nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg\\_%'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_namespace'::regclass AND d.objid = pg_namespace.oid AND d.deptype = 'e')`,
    [STAGED_SCHEMAS],
  );
  return rows.map((row) => row.nspname);
}

async function assertEmptyDatabase(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')`,
  );
  if ((rows[0]?.count ?? 0) > 0) throw new Error("the staging database must be empty");
}

function pipeCommands(sourceUrl: string, stagingUrl: string, excluded: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const dump = spawn(
      "pg_dump",
      [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        ...excluded.map((schema) => `--exclude-schema=${schema}`),
        `--dbname=${sourceUrl}`,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const restore = spawn(
      "pg_restore",
      ["--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction", `--dbname=${stagingUrl}`],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    const errors: string[] = [];
    dump.stderr.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
    restore.stderr.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
    dump.stdout.pipe(restore.stdin);
    let pending = 2;
    let failed = false;
    const finish = (name: string) => (code: number | null) => {
      if (code !== 0 && !failed) {
        failed = true;
        reject(new Error(`${name} exited with ${code}: ${errors.join("").trim()}`));
      }
      if (--pending === 0 && !failed) resolve();
    };
    dump.on("error", reject);
    restore.on("error", reject);
    dump.on("close", finish("pg_dump"));
    restore.on("close", finish("pg_restore"));
  });
}

interface ColumnShape {
  table: string;
  column: string;
  type: string;
}

async function publicColumns(client: pg.Client): Promise<ColumnShape[]> {
  const { rows } = await client.query<ColumnShape>(
    `SELECT c.relname AS table, a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname, a.attnum`,
  );
  return rows;
}

function schemaDifferences(staging: readonly ColumnShape[], target: readonly ColumnShape[]): string[] {
  const key = (shape: ColumnShape) => `${shape.table}.${shape.column}`;
  const stagingColumns = new Map(staging.map((shape) => [key(shape), shape]));
  const targetColumns = new Map(target.map((shape) => [key(shape), shape]));
  const targetTables = new Set(target.map((shape) => shape.table));
  const stagingTables = new Set(staging.map((shape) => shape.table));
  const differences: string[] = [];
  for (const [name, shape] of stagingColumns) {
    if (!targetTables.has(shape.table)) continue;
    const other = targetColumns.get(name);
    if (!other) {
      differences.push(`column ${name} is missing in the target`);
    } else if (other.type !== shape.type) {
      differences.push(`column ${name} is ${shape.type} in staging but ${other.type} in the target`);
    }
  }
  for (const [name, shape] of targetColumns) {
    if (stagingTables.has(shape.table) && !stagingColumns.has(name))
      differences.push(`column ${name} is missing in staging`);
  }
  return differences;
}

async function tenantTables(client: pg.Client): Promise<TableRef[]> {
  const { rows } = await client.query<TableRef>(
    `SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      ORDER BY c.relname`,
  );
  return rows.filter((table) => !UNSCOPED_TABLES.has(table.name));
}

async function dependencyOrder(client: pg.Client, tables: readonly TableRef[]): Promise<TableRef[]> {
  const { rows } = await client.query<{ child: string; parent: string }>(
    `SELECT c.relname AS child, p.relname AS parent FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace cn ON cn.oid = c.relnamespace
       JOIN pg_class p ON p.oid = k.confrelid JOIN pg_namespace pn ON pn.oid = p.relnamespace
      WHERE k.contype = 'f' AND cn.nspname = 'public' AND pn.nspname = 'public' AND k.conrelid <> k.confrelid`,
  );
  const names = new Set(tables.map((table) => table.name));
  const parents = new Map<string, Set<string>>(tables.map((table) => [table.name, new Set<string>()]));
  for (const { child, parent } of rows) if (names.has(child) && names.has(parent)) parents.get(child)!.add(parent);
  const ordered: TableRef[] = [];
  const placed = new Set<string>();
  while (ordered.length < tables.length) {
    const ready = tables.filter(
      (table) => !placed.has(table.name) && [...parents.get(table.name)!].every((parent) => placed.has(parent)),
    );
    const next = ready.length ? ready : tables.filter((table) => !placed.has(table.name)).slice(0, 1);
    for (const table of next) {
      ordered.push(table);
      placed.add(table.name);
    }
  }
  return ordered;
}

async function countRows(client: pg.Client, table: TableRef, tenantId?: string): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${qualified(table)}${tenantId === undefined ? "" : " WHERE tenant_id = $1"}`,
    tenantId === undefined ? [] : [tenantId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function bumpSequences(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ sequence: string; table: string; column: string }>(
    `SELECT DISTINCT format('%I.%I', sn.nspname, s.relname) AS sequence, format('%I.%I', tn.nspname, t.relname) AS table,
            a.attname AS column
       FROM pg_depend d
       JOIN pg_attrdef ad ON d.classid = 'pg_attrdef'::regclass AND ad.oid = d.objid
       JOIN pg_class s ON s.oid = d.refobjid AND s.relkind = 'S' AND d.refclassid = 'pg_class'::regclass
       JOIN pg_namespace sn ON sn.oid = s.relnamespace
       JOIN pg_class t ON t.oid = ad.adrelid JOIN pg_namespace tn ON tn.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ad.adnum
      WHERE tn.nspname = 'public'
     UNION
     SELECT format('%I.%I', sn.nspname, s.relname), format('%I.%I', tn.nspname, t.relname), a.attname
       FROM pg_depend d
       JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S' AND d.classid = 'pg_class'::regclass
       JOIN pg_namespace sn ON sn.oid = s.relnamespace
       JOIN pg_class t ON t.oid = d.refobjid AND d.refclassid = 'pg_class'::regclass
       JOIN pg_namespace tn ON tn.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      WHERE d.deptype IN ('a', 'i') AND tn.nspname = 'public'`,
  );
  let bumped = 0;
  for (const { sequence, table, column } of rows) {
    const { rows: updated } = await client.query<{ bumped: boolean }>(
      `WITH highest AS (SELECT max(${pg.escapeIdentifier(column)})::bigint AS value FROM ${table}),
            current AS (SELECT last_value FROM ${sequence})
       SELECT setval($1::regclass, highest.value, true) IS NOT NULL AS bumped
         FROM highest, current WHERE highest.value IS NOT NULL AND highest.value > current.last_value`,
      [sequence],
    );
    if (updated.length) bumped += 1;
  }
  return bumped;
}

async function stage(options: TenantImportOptions): Promise<string | undefined> {
  if (options.createStaging) await createDatabase(options);
  return withClient(
    options.sourceUrl,
    async (source) => {
      const sourceTenant = await tenantSingleton(source);
      await withClient(options.stagingUrl, async (staging) => {
        await assertEmptyDatabase(staging);
        options.log(`copying ${describeDatabase(options.sourceUrl)} to staging with pg_dump`);
        await pipeCommands(options.sourceUrl, options.stagingUrl, await unstagedSchemas(source));
      });
      return sourceTenant;
    },
    true,
  );
}

async function prepareStaging(options: TenantImportOptions): Promise<string | undefined> {
  options.log(`migrating staging ${describeDatabase(options.stagingUrl)}`);
  await options.migrate(options.stagingUrl);
  return withClient(options.stagingUrl, async (staging) => {
    await staging.query("SET qm.tenant_bypass = 'on'");
    const { rows } = await staging.query<{ present: boolean }>(
      "SELECT to_regprocedure('qm_tenantize()') IS NOT NULL AS present",
    );
    if (rows[0]?.present) await staging.query("SELECT qm_tenantize()");
    return tenantSingleton(staging);
  });
}

async function copyToTarget(
  options: TenantImportOptions,
  tenantId: string,
  staging: pg.Client,
  target: pg.Client,
  targetTables: ReadonlySet<string>,
): Promise<TableCount[]> {
  const tables = await dependencyOrder(
    target,
    (await tenantTables(staging)).filter((table) => targetTables.has(table.name)),
  );
  await target.query("BEGIN");
  await target.query("SELECT set_config('qm.tenant_id', $1, true)", [tenantId]);
  const existing: string[] = [];
  for (const table of tables) if ((await countRows(target, table, tenantId)) > 0) existing.push(table.name);
  if (existing.length && !options.replace) {
    throw new Error(
      `the target already has rows for tenant ${tenantId} (${existing.join(", ")}); pass --replace to overwrite them`,
    );
  }
  for (const table of [...tables].reverse()) {
    if (!existing.includes(table.name)) continue;
    const { rowCount } = await target.query(`DELETE FROM ${qualified(table)} WHERE tenant_id = $1`, [tenantId]);
    options.log(`removed ${rowCount ?? 0} existing rows from ${table.name}`);
  }
  const counts: TableCount[] = [];
  for (const table of tables) {
    const columns = await insertableColumns(staging, table);
    const replaceOn = await primaryKey(target, table);
    const copied = await copyRows(staging, target, table, {
      batchSize: options.batchSize,
      tenantId,
      columns,
      ...(replaceOn ? { replaceOn } : {}),
    });
    options.log(`copied ${table.name}: ${copied} rows`);
    counts.push({
      table: table.name,
      staging: await countRows(staging, table),
      target: await countRows(target, table, tenantId),
    });
  }
  return counts;
}

function formatCounts(counts: readonly TableCount[]): string {
  const width = Math.max(5, ...counts.map((count) => count.table.length));
  const lines = [`${"table".padEnd(width)}  ${"staging".padStart(10)}  ${"target".padStart(10)}`];
  for (const count of counts) {
    let flag = "";
    if (count.target < count.staging) flag = "  MISSING";
    else if (count.target > count.staging) flag = "  EXTRA";
    lines.push(
      `${count.table.padEnd(width)}  ${String(count.staging).padStart(10)}  ${String(count.target).padStart(10)}${flag}`,
    );
  }
  return lines.join("\n");
}

async function checkUnsharedTables(
  staging: pg.Client,
  stagingTables: ReadonlySet<string>,
  targetTables: ReadonlySet<string>,
  log: (line: string) => void,
): Promise<void> {
  const targetOnly = [...targetTables].filter((table) => !stagingTables.has(table)).sort();
  if (targetOnly.length) log(`tables only in the target (nothing to copy): ${targetOnly.join(", ")}`);
  const stagingOnly = [...stagingTables].filter((table) => !targetTables.has(table)).sort();
  if (!stagingOnly.length) return;
  await staging.query("SET qm.tenant_bypass = 'on'");
  const populated: string[] = [];
  for (const table of stagingOnly) {
    const rows = await countRows(staging, { schema: "public", name: table });
    if (rows > 0) populated.push(`${table} (${rows} rows)`);
  }
  if (populated.length) throw new Error(`tables with rows are missing in the target: ${populated.join(", ")}`);
  log(`empty tables only in staging (skipped): ${stagingOnly.join(", ")}`);
}

export async function importTenant(options: TenantImportOptions): Promise<TenantImportResult> {
  const sourceTenant = await stage(options);
  const stagedTenant = await prepareStaging(options);
  const tenantId = options.tenantId ?? sourceTenant ?? stagedTenant;
  if (!tenantId) throw new Error("no tenant id: pass --tenant-id or migrate a build that defines qm_tenant");
  options.log(`importing as tenant ${tenantId}`);
  const staging = await connect(options.stagingUrl);
  const target = await connect(options.targetUrl);
  return closingAfter(
    async () => {
      const stagingShape = await publicColumns(staging);
      const targetShape = await publicColumns(target);
      const differences = schemaDifferences(stagingShape, targetShape);
      if (differences.length) {
        throw new Error(`staging and target schemas differ:\n  ${differences.join("\n  ")}`);
      }
      const targetTables = new Set(targetShape.map((shape) => shape.table));
      await checkUnsharedTables(staging, new Set(stagingShape.map((shape) => shape.table)), targetTables, options.log);
      await staging.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await staging.query("SET LOCAL qm.tenant_bypass = 'on'");
      let counts: TableCount[];
      try {
        counts = await copyToTarget(options, tenantId, staging, target, targetTables);
        options.log(formatCounts(counts));
        for (const count of counts.filter((count) => count.target > count.staging)) {
          options.log(
            `warning: ${count.table} has ${count.target} target rows for ${count.staging} staging rows (trigger-derived rows)`,
          );
        }
        const missing = counts.filter((count) => count.target < count.staging);
        if (missing.length) {
          throw new Error(`rows are missing from the target for ${missing.map((count) => count.table).join(", ")}`);
        }
        if (options.dryRun) {
          await target.query("ROLLBACK");
          options.log("dry run: rolled back the target transaction");
          return { tenantId, tables: counts, committed: false };
        }
        await target.query("SELECT set_config('qm.tenant_bypass', 'on', true)");
        const bumped = await bumpSequences(target);
        options.log(`advanced ${bumped} sequences`);
        await options.writeTenant(tenantId, target);
        await target.query("COMMIT");
      } catch (error) {
        await target.query("ROLLBACK").catch(swallowAs("tenant import: rollback target", undefined));
        throw error;
      } finally {
        await staging.query("ROLLBACK").catch(swallowAs("tenant import: release staging", undefined));
      }
      options.log(`tenant ${options.slug} (${tenantId}) is active`);
      return { tenantId, tables: counts, committed: true };
    },
    () => Promise.all([staging.end(), target.end()]),
  );
}

function runMigrate(entry: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`staging migration exited with ${code}`))));
  });
}

export function migrateWithBuild(
  env: NodeJS.ProcessEnv,
  options: { tenantize: boolean; orgId?: string },
): (stagingUrl: string) => Promise<void> {
  const entry = new URL("../migrate-main.ts", import.meta.url).pathname;
  const { DATABASE_POOL_URL: _poolUrl, DATABASE_POOL_CA_CERT: _poolCa, ...base } = env;
  const childEnv = { ...base, ...(options.orgId ? { ORG_ID: options.orgId } : {}) };
  return async (stagingUrl) => {
    await runMigrate(entry, { ...childEnv, DATABASE_URL: stagingUrl, QM_MULTITENANT: "" });
    if (options.tenantize) await runMigrate(entry, { ...childEnv, DATABASE_URL: stagingUrl, QM_MULTITENANT: "1" });
  };
}
