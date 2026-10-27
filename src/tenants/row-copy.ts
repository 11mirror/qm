import pg, { type Client } from "pg";
import { swallowAs } from "../util/errors.ts";

export interface TableRef {
  schema: string;
  name: string;
}

export function qualified(table: TableRef): string {
  return `${pg.escapeIdentifier(table.schema)}.${pg.escapeIdentifier(table.name)}`;
}

export async function insertableColumns(client: Client, table: TableRef): Promise<string[]> {
  const { rows } = await client.query<{ attname: string }>(
    `SELECT a.attname FROM pg_attribute a
      WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
      ORDER BY a.attnum`,
    [qualified(table)],
  );
  return rows.map((row) => row.attname);
}

export interface PrimaryKey {
  constraint: string;
  columns: string[];
  fixed: string[];
}

export async function primaryKey(client: Client, table: TableRef): Promise<PrimaryKey | undefined> {
  const { rows } = await client.query<{ constraint: string; columns: string[]; fixed: string[] }>(
    `SELECT k.conname AS constraint,
            ARRAY(SELECT a.attname FROM unnest(k.conkey) AS key(attnum)
                  JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = key.attnum)::text[] AS columns,
            ARRAY(SELECT a.attname FROM pg_attribute a
                   WHERE a.attrelid = k.conrelid AND a.attidentity = 'a' AND NOT a.attisdropped)::text[] AS fixed
       FROM pg_constraint k WHERE k.conrelid = $1::regclass AND k.contype = 'p'`,
    [qualified(table)],
  );
  return rows[0];
}

export async function copyRows(
  source: Client,
  target: Client,
  table: TableRef,
  options: { batchSize: number; tenantId?: string; columns?: readonly string[]; replaceOn?: PrimaryKey },
): Promise<number> {
  const columns = options.columns ?? (await insertableColumns(target, table));
  const name = qualified(table);
  const cursor = pg.escapeIdentifier(`qm_copy_${table.schema}_${table.name}`.slice(0, 60));
  const selected = columns.map((column) =>
    options.tenantId !== undefined && column === "tenant_id" ? "$2::uuid" : `r.${pg.escapeIdentifier(column)}`,
  );
  const insert = `INSERT INTO ${name} (${columns.map((column) => pg.escapeIdentifier(column)).join(", ")}) OVERRIDING SYSTEM VALUE
    SELECT ${selected.join(", ")} FROM jsonb_populate_recordset(NULL::${name}, $1::jsonb) AS r${conflictClause(columns, options.replaceOn)}`;
  await source.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS payload FROM ${name} t`);
  let copied = 0;
  try {
    for (;;) {
      const { rows } = await source.query<{ payload: string }>(`FETCH ${options.batchSize} FROM ${cursor}`);
      if (rows.length === 0) break;
      const batch = `[${rows.map((row) => row.payload).join(",")}]`;
      await target.query(insert, options.tenantId === undefined ? [batch] : [batch, options.tenantId]);
      copied += rows.length;
    }
  } finally {
    await source.query(`CLOSE ${cursor}`).catch(swallowAs("tenant import: close cursor", undefined));
  }
  return copied;
}

function conflictClause(columns: readonly string[], key: PrimaryKey | undefined): string {
  if (!key) return "";
  const assignable = columns.filter((column) => !key.columns.includes(column) && !key.fixed.includes(column));
  if (!assignable.length) return ` ON CONFLICT ON CONSTRAINT ${pg.escapeIdentifier(key.constraint)} DO NOTHING`;
  return ` ON CONFLICT ON CONSTRAINT ${pg.escapeIdentifier(key.constraint)} DO UPDATE SET ${assignable
    .map((column) => `${pg.escapeIdentifier(column)} = EXCLUDED.${pg.escapeIdentifier(column)}`)
    .join(", ")}`;
}
