import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { mapToTableMigration, type TableSpec } from "../persistence/typed-table.ts";
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
  const { q } = createPgPool(databaseUrl, [RECENT_DM_POSTS_MIGRATION]);
  return {
    async remember(threadRef: string, post: RecentDmPost): Promise<void> {
      await q(
        `INSERT INTO recent_dm_posts (id, posts) VALUES ($1, jsonb_build_array($2::jsonb))
         ON CONFLICT (${tenantCols("id")}) DO UPDATE SET posts = (
           SELECT jsonb_agg(p ORDER BY n) FROM (
             SELECT p, n FROM jsonb_array_elements(recent_dm_posts.posts || EXCLUDED.posts) WITH ORDINALITY AS e(p, n)
             ORDER BY n DESC LIMIT ${KEEP}) kept)
         WHERE NOT recent_dm_posts.posts @> jsonb_build_array(jsonb_build_object('key', $3::text))`,
        [threadRef, jsonbStringify(post), post.key],
      );
    },
    async posts(threadRef: string): Promise<RecentDmPost[]> {
      const rows = await q(`SELECT posts FROM recent_dm_posts WHERE id = $1`, [threadRef]);
      return (rows[0]?.posts as RecentDmPost[] | undefined) ?? [];
    },
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
