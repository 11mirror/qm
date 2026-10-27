import { randomUUID } from "node:crypto";
import type { TypedTable } from "./typed-table.ts";

export type OneTimeResult<T> = { ok: true; rec: T } | { ok: false; reason: "not_found" | "expired" };

export function createOneTimeStore<T extends { createdAt: number }>(
  table: TypedTable<T>,
  ttlMs: number,
  clock: () => number = Date.now,
) {
  const judge = (rec: T | null, at: number): OneTimeResult<T> => {
    if (!rec) return { ok: false, reason: "not_found" };
    if (at - rec.createdAt > ttlMs) return { ok: false, reason: "expired" };
    return { ok: true, rec };
  };
  return {
    async mint(rec: Omit<T, "createdAt">, now?: number): Promise<string> {
      const id = `${randomUUID()}${randomUUID().replace(/-/g, "")}`;
      await table.insert(id, { ...rec, createdAt: now ?? clock() } as T);
      return id;
    },
    peek: async (id: string, now?: number) => judge(await table.get(id), now ?? clock()),
    redeem: async (id: string, now?: number) => judge(await table.take(id), now ?? clock()),
  };
}
