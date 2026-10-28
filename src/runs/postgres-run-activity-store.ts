import { createPgPool } from "../persistence/pg-pool.ts";
import type { Item } from "../sessions/items.ts";

export type RunActivityEntry =
  | { item: Item }
  | { marker: "text_start"; seq: number; createdAt: number; phase?: string; streamOffset?: number }
  | { marker: "sandbox_status"; seq: number; createdAt: number; text: string };

export interface RunActivityStore {
  append(runId: string, entry: RunActivityEntry): Promise<void>;
  list(runId: string): Promise<RunActivityEntry[]>;
  close?(): Promise<void>;
}

const RUN_ACTIVITY_TTL_MS = 60 * 60_000;

const activityCreatedAt = (entry: RunActivityEntry): number =>
  "item" in entry ? entry.item.createdAt : entry.createdAt;

export function createPostgresRunActivityStore(
  connectionString: string,
): RunActivityStore & { prune(): Promise<void> } {
  const pg = createPgPool(connectionString, []);
  const q = pg.query;

  return {
    async append(runId, entry) {
      const [type, seq, payload] =
        "item" in entry ? ["item", entry.item.seq, entry.item] : [entry.marker, entry.seq, entry];
      await q(
        `INSERT INTO run_activity(run_id, seq, type, payload, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [runId, seq, type, JSON.stringify(payload), activityCreatedAt(entry)],
      );
    },

    async list(runId) {
      const { rows } = await q(
        `SELECT type, payload FROM run_activity WHERE run_id=$1 AND type IN ('item', 'text_start', 'sandbox_status') ORDER BY id`,
        [runId],
      );
      return rows.map((r): RunActivityEntry =>
        r.type === "item" ? { item: r.payload as Item } : (r.payload as RunActivityEntry),
      );
    },

    async prune() {
      await q("DELETE FROM run_activity WHERE created_at < $1", [Date.now() - RUN_ACTIVITY_TTL_MS]);
    },

    async close() {
      await pg.close();
    },
  };
}
