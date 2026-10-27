import { type PgPool, tenantCols, withPgTransaction } from "./pg-pool.ts";
import { columnName, tableCodec, type TableSpec } from "./typed-table.ts";

export function lockedRow<T>(pg: Pick<PgPool, "pool">, spec: TableSpec) {
  const codec = tableCodec<T>(spec);
  const keyCol = columnName(spec.key);
  return async function modify(key: string, fn: (current: T | null) => T | null): Promise<T | null> {
    return withPgTransaction(await pg.pool(), async (client) => {
      const found = await client.query(`SELECT ${codec.columns} FROM ${spec.table} WHERE ${keyCol} = $1 FOR UPDATE`, [
        key,
      ]);
      const current = found.rows[0] ? codec.row(found.rows[0]) : null;
      const next = fn(current);
      if (next === current) return current;
      if (next === null) await client.query(`DELETE FROM ${spec.table} WHERE ${keyCol} = $1`, [key]);
      else
        await client.query(
          `INSERT INTO ${spec.table} (${codec.columns}) VALUES (${codec.placeholders})
           ON CONFLICT (${tenantCols(keyCol)}) DO UPDATE SET ${codec.updates}`,
          codec.values(key, next),
        );
      return next;
    });
  };
}
