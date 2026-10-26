import pg, { type Client } from "pg";
import { copyRows, quoteIdent, qualified, type TableRef } from "./row-copy.ts";
import { errMessage, swallowAs } from "../util/errors.ts";

export const STAGED_SCHEMAS = ["public", "absurd", "pgboss"];
const STAGED = STAGED_SCHEMAS.map((schema) => `'${schema}'`).join(", ");
const USER_SCHEMAS = `n.nspname IN (${STAGED})`;
const ANY_USER_SCHEMA = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`;
const NOT_EXTENSION_MEMBER = (classid: string, objid: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${classid}'::regclass AND d.objid = ${objid} AND d.deptype = 'e')`;

async function rows<T>(client: Client, text: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(text, params)).rows as T[];
}

async function run(target: Client, statements: readonly string[]): Promise<void> {
  for (const statement of statements) {
    try {
      await target.query(statement);
    } catch (error) {
      throw new Error(`${errMessage(error)} while running: ${statement.slice(0, 300)}`, { cause: error });
    }
  }
}

async function extensionStatements(source: Client): Promise<string[]> {
  const extensions = await rows<{ extname: string; schema: string }>(
    source,
    `SELECT e.extname, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname <> 'plpgsql' ORDER BY e.oid`,
  );
  return extensions.flatMap(({ extname, schema }) => [
    `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`,
    `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(extname)} WITH SCHEMA ${quoteIdent(schema)}`,
  ]);
}

async function schemaStatements(source: Client): Promise<string[]> {
  const schemas = await rows<{ nspname: string }>(
    source,
    `SELECT n.nspname FROM pg_namespace n WHERE ${USER_SCHEMAS} AND n.nspname <> 'public'
       AND ${NOT_EXTENSION_MEMBER("pg_namespace", "n.oid")} ORDER BY n.oid`,
  );
  return schemas.map(({ nspname }) => `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(nspname)}`);
}

async function typeStatements(source: Client): Promise<string[]> {
  const enums = await rows<{ name: string; labels: string[] }>(
    source,
    `SELECT format('%I.%I', n.nspname, t.typname) AS name,
            array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS labels
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE ${USER_SCHEMAS} AND ${NOT_EXTENSION_MEMBER("pg_type", "t.oid")}
      GROUP BY n.nspname, t.typname, t.oid ORDER BY t.oid`,
  );
  const domains = await rows<{ name: string; base: string; notnull: boolean; def: string | null; checks: string[] }>(
    source,
    `SELECT format('%I.%I', n.nspname, t.typname) AS name, format_type(t.typbasetype, t.typtypmod) AS base,
            t.typnotnull AS notnull, t.typdefault AS def,
            COALESCE(array_agg(pg_get_constraintdef(c.oid)) FILTER (WHERE c.oid IS NOT NULL), '{}')::text[] AS checks
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       LEFT JOIN pg_constraint c ON c.contypid = t.oid
      WHERE t.typtype = 'd' AND ${USER_SCHEMAS} AND ${NOT_EXTENSION_MEMBER("pg_type", "t.oid")}
      GROUP BY n.nspname, t.typname, t.oid ORDER BY t.oid`,
  );
  const composites = await rows<{ name: string; columns: string }>(
    source,
    `SELECT format('%I.%I', n.nspname, t.typname) AS name,
            string_agg(format('%I %s', a.attname, format_type(a.atttypid, a.atttypmod)), ', ' ORDER BY a.attnum) AS columns
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_class c ON c.oid = t.typrelid AND c.relkind = 'c'
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE ${USER_SCHEMAS} AND ${NOT_EXTENSION_MEMBER("pg_type", "t.oid")}
      GROUP BY n.nspname, t.typname, t.oid ORDER BY t.oid`,
  );
  return [
    ...enums.map(
      ({ name, labels }) =>
        `CREATE TYPE ${name} AS ENUM (${labels.map((label) => pg.escapeLiteral(label)).join(", ")})`,
    ),
    ...domains.map(
      ({ name, base, notnull, def, checks }) =>
        `CREATE DOMAIN ${name} AS ${base}${def === null ? "" : ` DEFAULT ${def}`}${notnull ? " NOT NULL" : ""}${checks
          .map((check) => ` ${check}`)
          .join("")}`,
    ),
    ...composites.map(({ name, columns }) => `CREATE TYPE ${name} AS (${columns})`),
  ];
}

async function functionStatements(source: Client): Promise<string[]> {
  const functions = await rows<{ def: string }>(
    source,
    `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE ${USER_SCHEMAS} AND p.prokind IN ('f', 'p') AND ${NOT_EXTENSION_MEMBER("pg_proc", "p.oid")}
      ORDER BY p.oid`,
  );
  return functions.map(({ def }) => def);
}

interface SequenceRow {
  name: string;
  type: string;
  start: string;
  increment: string;
  min: string;
  max: string;
  cache: string;
  cycle: boolean;
}

async function sequenceStatements(source: Client): Promise<string[]> {
  const sequences = await rows<SequenceRow>(
    source,
    `SELECT format('%I.%I', n.nspname, c.relname) AS name, format_type(s.seqtypid, NULL) AS type,
            s.seqstart::text AS start, s.seqincrement::text AS increment, s.seqmin::text AS min,
            s.seqmax::text AS max, s.seqcache::text AS cache, s.seqcycle AS cycle
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_sequence s ON s.seqrelid = c.oid
      WHERE c.relkind = 'S' AND ${USER_SCHEMAS} AND ${NOT_EXTENSION_MEMBER("pg_class", "c.oid")}
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'i')
      ORDER BY c.oid`,
  );
  return sequences.map(
    (s) =>
      `CREATE SEQUENCE ${s.name} AS ${s.type} INCREMENT ${s.increment} MINVALUE ${s.min} MAXVALUE ${s.max} START ${s.start} CACHE ${s.cache}${s.cycle ? " CYCLE" : ""}`,
  );
}

interface UserTable extends TableRef {
  options: string[] | null;
}

interface ColumnRow extends TableRef {
  column: string;
  type: string;
  notnull: boolean;
  def: string | null;
  identity: string;
  generated: string;
  collation: string | null;
}

async function userTables(source: Client): Promise<UserTable[]> {
  return rows<UserTable>(
    source,
    `SELECT n.nspname AS schema, c.relname AS name, c.reloptions AS options FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND ${USER_SCHEMAS} AND ${NOT_EXTENSION_MEMBER("pg_class", "c.oid")} ORDER BY c.oid`,
  );
}

async function tableStatements(source: Client, tables: readonly UserTable[]): Promise<string[]> {
  const columns = await rows<ColumnRow>(
    source,
    `SELECT n.nspname AS schema, c.relname AS name, a.attname AS column,
            format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
            pg_get_expr(ad.adbin, ad.adrelid) AS def, a.attidentity AS identity, a.attgenerated AS generated,
            CASE WHEN a.attcollation <> t.typcollation THEN format('%I.%I', cn.nspname, co.collname) END AS collation
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       JOIN pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
       LEFT JOIN pg_collation co ON co.oid = a.attcollation
       LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace
      WHERE c.oid = ANY($1::regclass[]) ORDER BY c.oid, a.attnum`,
    [tables.map(qualified)],
  );
  const byTable = new Map<string, ColumnRow[]>();
  for (const column of columns) byTable.set(qualified(column), [...(byTable.get(qualified(column)) ?? []), column]);
  return tables.map((table) => {
    const definitions = (byTable.get(qualified(table)) ?? []).map((column) => {
      let definition = `${quoteIdent(column.column)} ${column.type}`;
      if (column.collation) definition += ` COLLATE ${column.collation}`;
      if (column.generated === "s") definition += ` GENERATED ALWAYS AS (${column.def}) STORED`;
      else if (column.identity === "a") definition += " GENERATED ALWAYS AS IDENTITY";
      else if (column.identity === "d") definition += " GENERATED BY DEFAULT AS IDENTITY";
      else if (column.def !== null) definition += ` DEFAULT ${column.def}`;
      if (column.notnull) definition += " NOT NULL";
      return definition;
    });
    const storage = table.options?.length ? ` WITH (${table.options.join(", ")})` : "";
    return `CREATE TABLE ${qualified(table)} (${definitions.join(", ")})${storage}`;
  });
}

async function constraintStatements(source: Client): Promise<string[]> {
  const constraints = await rows<{ table: string; name: string; def: string }>(
    source,
    `SELECT format('%I.%I', n.nspname, c.relname) AS table, k.conname AS name, pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND ${USER_SCHEMAS} AND ${NOT_EXTENSION_MEMBER("pg_class", "c.oid")}
        AND k.contype IN ('p', 'u', 'x', 'c', 'f')
      ORDER BY array_position(ARRAY['p', 'u', 'x', 'c', 'f']::"char"[], k.contype), k.oid`,
  );
  return constraints.map(({ table, name, def }) => `ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdent(name)} ${def}`);
}

async function indexStatements(source: Client): Promise<string[]> {
  const indexes = await rows<{ def: string }>(
    source,
    `SELECT pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'm') AND ${USER_SCHEMAS} AND ${NOT_EXTENSION_MEMBER("pg_class", "c.oid")}
        AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.conrelid = i.indrelid)
      ORDER BY i.indexrelid`,
  );
  return indexes.map(({ def }) => def);
}

async function viewStatements(source: Client): Promise<string[]> {
  const views = await rows<{ name: string; kind: string; def: string }>(
    source,
    `SELECT format('%I.%I', n.nspname, c.relname) AS name, c.relkind AS kind, pg_get_viewdef(c.oid) AS def
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('v', 'm') AND ${USER_SCHEMAS} AND ${NOT_EXTENSION_MEMBER("pg_class", "c.oid")}
      ORDER BY c.oid`,
  );
  return views.map(({ name, kind, def }) =>
    kind === "m" ? `CREATE MATERIALIZED VIEW ${name} AS ${def}` : `CREATE VIEW ${name} AS ${def}`,
  );
}

async function statisticsStatements(source: Client): Promise<string[]> {
  const statistics = await rows<{ def: string }>(
    source,
    `SELECT pg_get_statisticsobjdef(s.oid) AS def FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid = s.stxnamespace
      WHERE ${USER_SCHEMAS} ORDER BY s.oid`,
  );
  return statistics.map(({ def }) => def);
}

async function triggerStatements(source: Client): Promise<string[]> {
  const triggers = await rows<{ def: string }>(
    source,
    `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND ${USER_SCHEMAS} AND ${NOT_EXTENSION_MEMBER("pg_class", "c.oid")}
      ORDER BY t.oid`,
  );
  return triggers.map(({ def }) => def);
}

async function policyStatements(source: Client): Promise<string[]> {
  const tables = await rows<{ table: string; enabled: boolean; forced: boolean }>(
    source,
    `SELECT format('%I.%I', n.nspname, c.relname) AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND ${USER_SCHEMAS} AND (c.relrowsecurity OR c.relforcerowsecurity) ORDER BY c.oid`,
  );
  const policies = await rows<{
    table: string;
    name: string;
    permissive: string;
    cmd: string;
    roles: string[];
    qual: string | null;
    check: string | null;
  }>(
    source,
    `SELECT format('%I.%I', schemaname, tablename) AS table, policyname AS name, permissive, cmd,
            roles::text[] AS roles, qual, with_check AS check
       FROM pg_policies WHERE schemaname IN (${STAGED})`,
  );
  return [
    ...policies.map(
      (p) =>
        `CREATE POLICY ${quoteIdent(p.name)} ON ${p.table} AS ${p.permissive} FOR ${p.cmd} TO ${p.roles
          .map((role) => (role === "public" ? "PUBLIC" : quoteIdent(role)))
          .join(
            ", ",
          )}${p.qual === null ? "" : ` USING (${p.qual})`}${p.check === null ? "" : ` WITH CHECK (${p.check})`}`,
    ),
    ...tables.flatMap(({ table, enabled, forced }) => [
      ...(enabled ? [`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`] : []),
      ...(forced ? [`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`] : []),
    ]),
  ];
}

async function sequenceValueStatements(source: Client): Promise<string[]> {
  const sequences = await rows<{ name: string }>(
    source,
    `SELECT format('%I.%I', n.nspname, c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'S' AND ${USER_SCHEMAS} AND ${NOT_EXTENSION_MEMBER("pg_class", "c.oid")} ORDER BY c.oid`,
  );
  const statements: string[] = [];
  for (const { name } of sequences) {
    const [state] = await rows<{ last_value: string; is_called: boolean }>(
      source,
      `SELECT last_value::text, is_called FROM ${name}`,
    );
    if (state) statements.push(`SELECT setval(${pg.escapeLiteral(name)}, ${state.last_value}, ${state.is_called})`);
  }
  const owned = await rows<{ sequence: string; table: string; column: string }>(
    source,
    `SELECT format('%I.%I', sn.nspname, s.relname) AS sequence, format('%I.%I', tn.nspname, t.relname) AS table,
            a.attname AS column
       FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
       JOIN pg_namespace sn ON sn.oid = s.relnamespace
       JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype = 'a'`,
  );
  return [
    ...statements,
    ...owned.map(({ sequence, table, column }) => `ALTER SEQUENCE ${sequence} OWNED BY ${table}.${quoteIdent(column)}`),
  ];
}

export async function assertEmptyDatabase(client: Client): Promise<void> {
  const [found] = await rows<{ count: number }>(
    client,
    `SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S') AND ${ANY_USER_SCHEMA} AND ${NOT_EXTENSION_MEMBER("pg_class", "c.oid")}`,
  );
  if ((found?.count ?? 0) > 0) throw new Error("the staging database must be empty");
}

export async function cloneDatabase(
  source: Client,
  target: Client,
  options: { batchSize: number; log: (line: string) => void },
): Promise<void> {
  await assertEmptyDatabase(target);
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await source.query("SET LOCAL qm.tenant_bypass = 'on'");
    const tables = await userTables(source);
    await target.query("BEGIN");
    await target.query("SET LOCAL check_function_bodies = off");
    await run(target, await extensionStatements(source));
    await run(target, await schemaStatements(source));
    await run(target, await typeStatements(source));
    await run(target, await functionStatements(source));
    await run(target, await sequenceStatements(source));
    await run(target, await tableStatements(source, tables));
    for (const table of tables) {
      const copied = await copyRows(source, target, table, { batchSize: options.batchSize });
      options.log(`staged ${qualified(table)}: ${copied} rows`);
    }
    await run(target, await constraintStatements(source));
    await run(target, await viewStatements(source));
    await run(target, await indexStatements(source));
    await run(target, await statisticsStatements(source));
    await run(target, await triggerStatements(source));
    await run(target, await policyStatements(source));
    await run(target, await sequenceValueStatements(source));
    await target.query("COMMIT");
  } catch (error) {
    await target.query("ROLLBACK").catch(swallowAs("tenant import: rollback clone", undefined));
    throw error;
  } finally {
    await source.query("ROLLBACK").catch(swallowAs("tenant import: rollback clone", undefined));
  }
}
