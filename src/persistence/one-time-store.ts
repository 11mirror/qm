import { randomUUID } from "node:crypto";
import { createPgPool } from "./pg-pool.ts";
import { columnName, tableCodec, type MapConversion } from "./typed-table.ts";

export type OneTimeResult<T> = { ok: true; rec: T } | { ok: false; reason: "not_found" | "expired" };

export function createOneTimeStore<T extends { createdAt: number }>(
  databaseUrl: string,
  migration: MapConversion,
  ttlMs: number,
  clock: () => number = Date.now,
) {
  const { spec } = migration;
  const { q } = createPgPool(databaseUrl, [migration]);
  const codec = tableCodec<T>(spec);
  const key = columnName(spec.key);
  const judge = (rows: Record<string, unknown>[], at: number): OneTimeResult<T> => {
    const rec = rows[0] ? codec.row(rows[0]) : null;
    if (!rec) return { ok: false, reason: "not_found" };
    if (at - rec.createdAt > ttlMs) return { ok: false, reason: "expired" };
    return { ok: true, rec };
  };
  return {
    async mint(rec: Omit<T, "createdAt">, now?: number): Promise<string> {
      const id = `${randomUUID()}${randomUUID().replace(/-/g, "")}`;
      await q(
        `INSERT INTO ${spec.table} (${codec.columns}) VALUES (${codec.placeholders})`,
        codec.values(id, { ...rec, createdAt: now ?? clock() } as T),
      );
      return id;
    },
    async peek(id: string, now?: number): Promise<OneTimeResult<T>> {
      return judge(await q(`SELECT ${codec.columns} FROM ${spec.table} WHERE ${key} = $1`, [id]), now ?? clock());
    },
    async redeem(id: string, now?: number): Promise<OneTimeResult<T>> {
      return judge(
        await q(`DELETE FROM ${spec.table} WHERE ${key} = $1 RETURNING ${codec.columns}`, [id]),
        now ?? clock(),
      );
    },
  };
}
