import type { PgMigrationDefinition, Rows } from "./pg-pool.ts";
import { jsonbStringify, pgTextSafe } from "../util/text.ts";

export type ColumnType = "text" | "bigint" | "double precision" | "boolean" | "jsonb" | "text[]";

interface ColumnSpec {
  type: ColumnType;
  required?: boolean;
}

export interface TableSpec {
  table: string;
  key: string;
  keyIsField?: boolean;
  columns: Readonly<Record<string, ColumnSpec>>;
}

export const columnName = (field: string): string => `"${field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}"`;

function fromJson(field: string, type: ColumnType): string {
  const v = `json->'${field}'`;
  const when = (kind: string, expr: string) => `CASE WHEN jsonb_typeof(${v}) = '${kind}' THEN ${expr} END`;
  switch (type) {
    case "text":
      return when("string", `json->>'${field}'`);
    case "bigint":
      return when("number", `round((json->>'${field}')::numeric)::bigint`);
    case "double precision":
      return when("number", `(json->>'${field}')::float8`);
    case "boolean":
      return when("boolean", `(${v})::boolean`);
    case "jsonb":
      return `CASE WHEN jsonb_typeof(${v}) <> 'null' THEN ${v} END`;
    case "text[]":
      return when("array", `ARRAY(SELECT jsonb_array_elements_text(${v}))`);
  }
}

export interface MapConversion extends PgMigrationDefinition {
  spec: TableSpec;
  dropKeys: readonly string[];
}

export function mapToTableMigration(
  id: string,
  spec: TableSpec,
  opts: { dropKeys?: readonly string[]; statements?: readonly string[] } = {},
): MapConversion {
  const { table, key } = spec;
  const keyCol = columnName(key);
  const cols = Object.entries(spec.columns).map(([field, c]) => ({ field, col: columnName(field), ...c }));
  const required = cols.filter((c) => c.required);
  const rebuilt = [
    ...(spec.keyIsField ? [`'${key}', CASE WHEN json ? '${key}' THEN to_jsonb(id) END`] : []),
    ...cols.map((c) => `'${c.field}', to_jsonb(${c.col})`),
  ];
  const dropKeys = `ARRAY[${(opts.dropKeys ?? []).map((k) => `'${k}'`).join(", ")}]::text[]`;
  const convert = `DO $convert$ DECLARE bad text; BEGIN
      IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = '${table}'::regclass AND attname = 'json' AND NOT attisdropped) THEN
        ALTER TABLE ${table} ${cols.map((c) => `ADD COLUMN IF NOT EXISTS ${c.col} ${c.type}`).join(", ")};
        UPDATE ${table} SET ${cols.map((c) => `${c.col} = ${fromJson(c.field, c.type)}`).join(", ")};
        SELECT id INTO bad FROM ${table}
         WHERE jsonb_typeof(json) <> 'object'${required.map((c) => ` OR ${c.col} IS NULL`).join("")}
            OR jsonb_strip_nulls(json) - ${dropKeys}
               IS DISTINCT FROM jsonb_strip_nulls(jsonb_build_object(${rebuilt.join(", ")}))
         LIMIT 1;
        IF bad IS NOT NULL THEN RAISE EXCEPTION '${table}: row % does not convert to typed columns', bad; END IF;
        ${required.length ? `ALTER TABLE ${table} ${required.map((c) => `ALTER COLUMN ${c.col} SET NOT NULL`).join(", ")};` : ""}
        ALTER TABLE ${table} DROP COLUMN json;
        ${keyCol === `"id"` ? "" : `ALTER TABLE ${table} RENAME COLUMN id TO ${keyCol};`}
      END IF;
      IF to_regclass('durable_map_versions') IS NOT NULL THEN DELETE FROM durable_map_versions WHERE tbl = '${table}'; END IF;
    END $convert$`;
  const create = `CREATE TABLE IF NOT EXISTS ${table} (${keyCol} TEXT PRIMARY KEY, ${cols
    .map((c) => `${c.col} ${c.type}${c.required ? " NOT NULL" : ""}`)
    .join(", ")})`;
  return { id, statements: [create, convert, ...(opts.statements ?? [])], spec, dropKeys: opts.dropKeys ?? [] };
}

function toParam(value: unknown, type: ColumnType): unknown {
  if (value === undefined || value === null) return null;
  if (type === "jsonb") return jsonbStringify(value);
  if (type === "text") return pgTextSafe(String(value));
  if (type === "text[]") return (value as string[]).map(pgTextSafe);
  return value;
}

export function tableCodec<T>(spec: TableSpec) {
  const fields = [spec.key, ...Object.keys(spec.columns)];
  const types: Record<string, ColumnType> = { [spec.key]: "text" };
  for (const [field, c] of Object.entries(spec.columns)) types[field] = c.type;
  const names = fields.map(columnName);
  const row = (r: Record<string, unknown>): T => {
    const out: Record<string, unknown> = {};
    for (const f of spec.keyIsField ? fields : fields.slice(1)) {
      const v = r[columnName(f).slice(1, -1)];
      if (v != null) out[f] = types[f] === "bigint" ? Number(v) : v;
    }
    return out as T;
  };
  return {
    columns: names.join(", "),
    placeholders: names.map((_, i) => `$${i + 1}`).join(", "),
    updates: names
      .slice(1)
      .map((n) => `${n} = EXCLUDED.${n}`)
      .join(", "),
    values: (key: string, record: T): unknown[] => [
      key,
      ...fields.slice(1).map((f) => toParam((record as Record<string, unknown>)[f], types[f]!)),
    ],
    row,
    rows: (rows: Rows): T[] => rows.map(row),
  };
}
