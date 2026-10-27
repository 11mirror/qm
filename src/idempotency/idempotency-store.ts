import { randomUUID } from "node:crypto";
import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
import { errMessage } from "../util/errors.ts";

/** A committed key, or — while `claim` is set — a key some process is running right now. */
interface IdempotencyRecord {
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

const IDEMPOTENCY: TableSpec = {
  table: "idempotency",
  key: "key",
  keyIsField: true,
  columns: cols(`at bigint!, claim text`),
};

export const IDEMPOTENCY_MIGRATION = mapToTableMigration("idempotency/store/0001-typed", IDEMPOTENCY, {
  statements: [`CREATE INDEX IF NOT EXISTS idempotency_at ON idempotency (at)`],
});

const codec = tableCodec<IdempotencyRecord>(IDEMPOTENCY);

export function createIdempotencyStore(databaseUrl: string, opts: IdempotencyStoreOptions = {}): IdempotencyStore {
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const pruneIntervalMs = opts.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const claimLeaseMs = opts.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
  const now = opts.now ?? Date.now;
  const { q } = createPgPool(databaseUrl, [IDEMPOTENCY_MIGRATION]);
  const done = new Map<string, number>();
  let lastPruneAt = now();

  function pruneIfDue(t: number): void {
    if (t - lastPruneAt < pruneIntervalMs) return;
    lastPruneAt = t;
    const cutoff = t - retentionMs;
    for (const [key, at] of done) if (at < cutoff) done.delete(key);
    void q(`DELETE FROM idempotency WHERE at < $1`, [cutoff]).catch((e: unknown) => {
      console.error("[idempotency] retention prune failed:", errMessage(e));
    });
  }

  const isCommitted = async (key: string): Promise<boolean> => {
    const cutoff = now() - retentionMs;
    const cached = done.get(key);
    if (cached != null && cached >= cutoff) return true;
    const record = codec.rows(await q(`SELECT ${codec.columns} FROM idempotency WHERE key = $1`, [key]))[0];
    if (record != null && !record.claim && record.at >= cutoff) {
      done.set(record.key, record.at);
      return true;
    }
    return false;
  };

  async function claimKey(key: string): Promise<string | null> {
    const t = now();
    const claim = randomUUID();
    const rows = await q(
      `INSERT INTO idempotency (${codec.columns}) VALUES (${codec.placeholders})
       ON CONFLICT (${tenantCols("key")}) DO UPDATE SET at = EXCLUDED.at, claim = EXCLUDED.claim
       WHERE CASE WHEN idempotency.claim IS NULL THEN idempotency.at < $4 ELSE idempotency.at <= $5 END
       RETURNING claim`,
      [...codec.values(key, { key, at: t, claim }), t - retentionMs, t - claimLeaseMs],
    );
    return rows[0]?.claim === claim ? claim : null;
  }

  return {
    async once(key, fn) {
      if (await isCommitted(key)) return false;
      const claim = await claimKey(key);
      if (!claim) return false;
      try {
        await fn();
      } catch (error) {
        await q(`DELETE FROM idempotency WHERE key = $1 AND claim = $2`, [key, claim]);
        throw error;
      }
      const at = now();
      await q(
        `INSERT INTO idempotency (key, at) VALUES ($1, $2)
         ON CONFLICT (${tenantCols("key")}) DO UPDATE SET at = EXCLUDED.at, claim = NULL`,
        [key, at],
      );
      done.set(key, at);
      pruneIfDue(at);
      return true;
    },
    committed: isCommitted,
  };
}
