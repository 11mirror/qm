import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
import type { OutboundPost } from "./outbound.ts";

export interface QueuedPost {
  post: OutboundPost;
  firstFailedAt: number;
  lastError: string;
}

const QUEUED_POSTS: TableSpec = {
  table: "queued_posts",
  key: "id",
  columns: {
    post: { type: "jsonb", required: true },
    firstFailedAt: { type: "bigint", required: true },
    lastError: { type: "text", required: true },
  },
};

export const QUEUED_POSTS_MIGRATION = mapToTableMigration("surfaces/queued-posts/0001-typed", QUEUED_POSTS);

const codec = tableCodec<QueuedPost>(QUEUED_POSTS);

export function createQueuedPosts(databaseUrl: string) {
  const { q } = createPgPool(databaseUrl, [QUEUED_POSTS_MIGRATION]);
  return {
    async put(key: string, queued: QueuedPost): Promise<void> {
      await q(
        `INSERT INTO queued_posts (${codec.columns}) VALUES (${codec.placeholders})
         ON CONFLICT (${tenantCols("id")}) DO UPDATE SET ${codec.updates}`,
        codec.values(key, queued),
      );
    },
    async entries(): Promise<Array<[string, QueuedPost]>> {
      const rows = await q(`SELECT ${codec.columns} FROM queued_posts ORDER BY first_failed_at, id`);
      return rows.map((r) => [String(r.id), codec.row(r)]);
    },
    async delete(key: string): Promise<void> {
      await q(`DELETE FROM queued_posts WHERE id = $1`, [key]);
    },
  };
}

export type QueuedPosts = ReturnType<typeof createQueuedPosts>;
