import { AsyncLocalStorage } from "node:async_hooks";
import { tenantLockKey, type PgPool, type PoolClient } from "./pg-pool.ts";
import { sleep } from "../util/async.ts";

export interface AdvisoryLock {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  withSharedLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  tryWithLock<T>(key: string, fn: () => Promise<T>): Promise<T | null>;
}

const DEFAULT_ADVISORY_LOCK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_ADVISORY_LOCK_POLL_MS = 300;

export function createPostgresAdvisoryLock(
  pg: PgPool,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): AdvisoryLock {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ADVISORY_LOCK_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_ADVISORY_LOCK_POLL_MS;

  type Context = {
    client: PoolClient;
    references: number;
    keys: Map<string, { shared: boolean; count: number }>;
    unlockFailure?: Error;
  };
  const sessions = new AsyncLocalStorage<{ context: Context; active: boolean }>();
  const withClient = async <T>(action: (context: Context) => Promise<T>): Promise<T> => {
    const parent = sessions.getStore();
    const context: Context = parent?.active
      ? parent.context
      : { client: await (await pg.sessionPool()).connect(), references: 0, keys: new Map() };
    context.references++;
    const lease = { context, active: true };
    try {
      return await sessions.run(lease, () => action(context));
    } finally {
      lease.active = false;
      if (--context.references === 0) context.client.release(context.unlockFailure);
    }
  };
  const holding = async <T>(context: Context, key: string, shared: boolean, fn: () => Promise<T>): Promise<T> => {
    const unlock = async () => {
      try {
        await context.client.query(`SELECT pg_advisory_unlock${shared ? "_shared" : ""}(hashtextextended($1, 0))`, [
          tenantLockKey(key),
        ]);
        return undefined;
      } catch (error) {
        context.unlockFailure = error instanceof Error ? error : new Error(String(error));
        return context.unlockFailure;
      }
    };
    let value: T;
    try {
      value = await fn();
    } catch (error) {
      const unlockError = await unlock();
      if (unlockError)
        throw new AggregateError([error, unlockError], `advisory lock ${key}: callback failed, then unlock failed`, {
          cause: error,
        });
      throw error;
    }
    const unlockError = await unlock();
    if (unlockError) throw unlockError;
    return value;
  };
  const run = async <T>(key: string, fn: () => Promise<T>, shared: boolean, wait: boolean): Promise<T | null> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const attempt = await withClient(async (context): Promise<{ acquired: false } | { acquired: true; value: T }> => {
        const { client, keys } = context;
        const held = keys.get(key);
        if (held && !(shared && held.shared)) return { acquired: false };
        const reservation = held ?? { shared, count: 0 };
        reservation.count++;
        keys.set(key, reservation);
        try {
          const res = await client.query<{ locked: boolean }>(
            `SELECT pg_try_advisory_lock${shared ? "_shared" : ""}(hashtextextended($1, 0)) AS locked`,
            [tenantLockKey(key)],
          );
          if (res.rows[0]?.locked !== true) return { acquired: false };
          return { acquired: true, value: await holding(context, key, shared, fn) };
        } finally {
          if (--reservation.count === 0) keys.delete(key);
        }
      });
      if (attempt.acquired) return attempt.value;
      if (!wait) return null;
      if (Date.now() >= deadline) throw new Error(`timeout acquiring advisory lock for ${key}`);
      await sleep(pollMs);
    }
  };
  return {
    withLock: <T>(key: string, fn: () => Promise<T>) => run(key, fn, false, true) as Promise<T>,
    withSharedLock: <T>(key: string, fn: () => Promise<T>) => run(key, fn, true, true) as Promise<T>,
    tryWithLock: <T>(key: string, fn: () => Promise<T>) => run(key, fn, false, false),
  };
}
