import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import { pgTextSafe } from "../util/text.ts";
import type { OutboundPost } from "./outbound.ts";

export interface QueuedPost {
  post: OutboundPost;
  firstFailedAt: number;
  lastError: string;
}

export type QueuedPostOutcome = { settled: true } | { failed: string } | { kept: true };

const QUEUED_POSTS: TableSpec = {
  table: "queued_posts",
  key: "id",
  columns: cols(`post jsonb!, firstFailedAt bigint!, lastError text!`),
};

const QUEUED_POSTS_MIGRATION = mapToTableMigration("surfaces/queued-posts/0001-typed", QUEUED_POSTS);

export function createQueuedPosts(databaseUrl: string) {
  const pg = createPgPool(databaseUrl, [QUEUED_POSTS_MIGRATION]);
  const { put, get, codec } = typedTable<QueuedPost>(pg, QUEUED_POSTS);
  const claimNext = `SELECT ${codec.columns} FROM queued_posts
    WHERE (first_failed_at, id) > ($1, $2) ORDER BY first_failed_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
  return {
    put,
    get,
    async drain(handle: (key: string, queued: QueuedPost) => Promise<QueuedPostOutcome>): Promise<void> {
      let after: [number, string] = [Number.MIN_SAFE_INTEGER, ""];
      for (;;) {
        const claimed = await withPgTransaction(await pg.pool(), async (client) => {
          const row = (await client.query(claimNext, after)).rows[0];
          if (!row) return null;
          const key = String(row.id);
          const queued = codec.row(row);
          const outcome = await handle(key, queued);
          if ("settled" in outcome) await client.query(`DELETE FROM queued_posts WHERE id = $1`, [key]);
          else if ("failed" in outcome)
            await client.query(`UPDATE queued_posts SET last_error = $2 WHERE id = $1`, [
              key,
              pgTextSafe(outcome.failed),
            ]);
          return [queued.firstFailedAt, key] as [number, string];
        });
        if (!claimed) return;
        after = claimed;
      }
    },
  };
}

export type QueuedPosts = ReturnType<typeof createQueuedPosts>;
