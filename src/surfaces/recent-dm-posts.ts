import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import { jsonbStringify } from "../util/text.ts";

export interface RecentDmPost {
  key: string;
  text: string;
  at: number;
  onBehalfOf?: string;
  trigger?: string;
}

const KEEP = 5;
const NOTE_ITEM_MAX_CHARS = 200;

const RECENT_DM_POSTS: TableSpec = {
  table: "recent_dm_posts",
  key: "id",
  columns: { posts: { type: "jsonb", required: true } },
};

export const RECENT_DM_POSTS_MIGRATION = mapToTableMigration("surfaces/recent-dm-posts/0001-typed", RECENT_DM_POSTS);

export function createRecentDmPosts(databaseUrl: string) {
  const pg = createPgPool(databaseUrl, [RECENT_DM_POSTS_MIGRATION]);
  const table = typedTable<{ posts: RecentDmPost[] }>(pg, RECENT_DM_POSTS);
  return {
    async remember(threadRef: string, post: RecentDmPost): Promise<void> {
      await pg.q(
        `INSERT INTO recent_dm_posts (id, posts) VALUES ($1, jsonb_build_array($2::jsonb))
         ON CONFLICT (${tenantCols("id")}) DO UPDATE SET posts = (
           SELECT jsonb_agg(p ORDER BY n) FROM (
             SELECT p, n FROM jsonb_array_elements(recent_dm_posts.posts || EXCLUDED.posts) WITH ORDINALITY AS e(p, n)
             ORDER BY n DESC LIMIT ${KEEP}) kept)
         WHERE NOT recent_dm_posts.posts @> jsonb_build_array(jsonb_build_object('key', $3::text))`,
        [threadRef, jsonbStringify(post), post.key],
      );
    },
    posts: async (threadRef: string) => (await table.get(threadRef))?.posts ?? [],
  };
}

export type RecentDmPosts = ReturnType<typeof createRecentDmPosts>;

export async function recentPrincipalDeliveryNote(
  store: Pick<RecentDmPosts, "posts"> | undefined,
  threadRef: string,
  since = 0,
): Promise<string> {
  if (!store) return "";
  const recent = (await store.posts(threadRef)).filter((p) => p.at > since);
  if (!recent.length) return "";
  const lines = recent.map((p) => {
    const from = p.onBehalfOf ? ` from ${p.onBehalfOf}` : "";
    const trigger = p.trigger ? ` [${p.trigger}]` : "";
    const flattened = p.text.trim().replace(/\s+/g, " ");
    const text = flattened.length > NOTE_ITEM_MAX_CHARS ? `${flattened.slice(0, NOTE_ITEM_MAX_CHARS)}…` : flattened;
    return `- ${new Date(p.at).toISOString()}${trigger}${from}: ${text}`;
  });
  return ["Delivered here since the user's last message (delivery events, not your turns):", ...lines].join("\n");
}
