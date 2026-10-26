import { randomUUID } from "node:crypto";
import type { DurableMap } from "./durable-map.ts";

export type OneTimeResult<T> = { ok: true; rec: T } | { ok: false; reason: "not_found" | "expired" };

export function createOneTimeStore<T extends { createdAt: number }>(
  backing: DurableMap<T>,
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
      await backing.put(id, { ...rec, createdAt: now ?? clock() } as T);
      return id;
    },
    async peek(id: string, now?: number): Promise<OneTimeResult<T>> {
      return judge(await backing.get(id), now ?? clock());
    },
    async redeem(id: string, now?: number): Promise<OneTimeResult<T>> {
      return judge(await backing.take(id), now ?? clock());
    },
  };
}
