import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import { errMessage } from "../util/errors.ts";

/** A committed key, or — while `claim` is set — a key some process is running right now. */
export interface IdempotencyRecord {
  key: string;
  at: number;
  claim?: string;
}

export interface IdempotencyStore {
  once(key: string, fn: () => Promise<void>): Promise<boolean>;
  committed(key: string): Promise<boolean>;
}

export interface IdempotencyStoreOptions {
  retentionMs?: number;
  pruneIntervalMs?: number;
  claimLeaseMs?: number;
  now?: () => number;
}

const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60_000;
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60_000;
/** How long an in-flight claim blocks other processes before it is presumed dead (its holder crashed). */
const DEFAULT_CLAIM_LEASE_MS = 10 * 60_000;

export function createIdempotencyStore(
  backing: DurableMap<IdempotencyRecord>,
  opts: IdempotencyStoreOptions = {},
): IdempotencyStore {
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const pruneIntervalMs = opts.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const claimLeaseMs = opts.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
  const now = opts.now ?? Date.now;
  const done = new Map<string, number>();
  let lastPruneAt = now();

  function pruneIfDue(t: number): void {
    if (t - lastPruneAt < pruneIntervalMs) return;
    lastPruneAt = t;
    const cutoff = t - retentionMs;
    for (const [key, at] of done) if (at < cutoff) done.delete(key);
    void backing.deleteBelow("at", cutoff).catch((e: unknown) => {
      console.error("[idempotency] retention prune failed:", errMessage(e));
    });
  }

  const live = (record: IdempotencyRecord | null, t: number): boolean =>
    record != null && (record.claim ? t - record.at < claimLeaseMs : record.at >= t - retentionMs);

  const isCommitted = async (key: string): Promise<boolean> => {
    const cutoff = now() - retentionMs;
    const cached = done.get(key);
    if (cached != null && cached >= cutoff) return true;
    const record = await backing.get(key);
    if (record != null && !record.claim && record.at >= cutoff) {
      done.set(record.key, record.at);
      return true;
    }
    return false;
  };

  /** Claim `key` for this call across every process: insert a claim, or take over an expired record. */
  async function claimKey(key: string): Promise<string | null> {
    const t = now();
    const claim = randomUUID();
    const mine: IdempotencyRecord = { key, at: t, claim };
    if (await backing.insertIfAbsent(key, mine)) return claim;
    const taken = await backing.update(key, (current) => (live(current, t) ? current : mine));
    if (taken === null) return (await backing.insertIfAbsent(key, mine)) ? claim : null;
    return taken.claim === claim ? claim : null;
  }

  return {
    async once(key, fn) {
      if (await isCommitted(key)) return false;
      const claim = await claimKey(key);
      if (!claim) return false;
      try {
        await fn();
      } catch (error) {
        await backing.deleteIf(key, (record) => record.claim === claim);
        throw error;
      }
      const at = now();
      await backing.put(key, { key, at });
      done.set(key, at);
      pruneIfDue(at);
      return true;
    },
    committed: isCommitted,
  };
}
