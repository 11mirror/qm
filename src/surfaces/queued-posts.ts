import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import type { OutboundPost } from "./outbound.ts";

export interface QueuedPost {
  post: OutboundPost;
  firstFailedAt: number;
  lastError: string;
}

const QUEUED_POSTS: TableSpec = {
  table: "queued_posts",
  key: "id",
  columns: cols(`post jsonb!, firstFailedAt bigint!, lastError text!`),
};

const QUEUED_POSTS_MIGRATION = mapToTableMigration("surfaces/queued-posts/0001-typed", QUEUED_POSTS);

export function createQueuedPosts(databaseUrl: string) {
  const pg = createPgPool(databaseUrl, [QUEUED_POSTS_MIGRATION]);
  const { put, delete: remove, codec } = typedTable<QueuedPost>(pg, QUEUED_POSTS);
  return {
    put,
    async entries(): Promise<Array<[string, QueuedPost]>> {
      const rows = await pg.q(`SELECT ${codec.columns} FROM queued_posts ORDER BY first_failed_at, id`);
      return rows.map((r) => [String(r.id), codec.row(r)]);
    },
    delete: remove,
  };
}

export type QueuedPosts = ReturnType<typeof createQueuedPosts>;
