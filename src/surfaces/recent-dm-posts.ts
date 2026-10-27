import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import { jsonbStringify } from "../util/text.ts";
import { FIRE_RETENTION_MS } from "../cron/cron-store.ts";

export interface RecentDmPost {
  key: string;
  text: string;
  at: number;
  onBehalfOf?: string;
  trigger?: string;
}

const RECENT_DM_POSTS: TableSpec = {
  table: "recent_dm_posts",
  key: "id",
  columns: { posts: { type: "jsonb", required: true } },
};

const RECENT_DM_POSTS_MIGRATION = mapToTableMigration("surfaces/recent-dm-posts/0001-typed", RECENT_DM_POSTS);

export function createRecentDmPosts(databaseUrl: string) {
  const pg = createPgPool(databaseUrl, [RECENT_DM_POSTS_MIGRATION]);
  const table = typedTable<{ posts: RecentDmPost[] }>(pg, RECENT_DM_POSTS);
  return {
    async remember(threadRef: string, post: RecentDmPost): Promise<void> {
      await pg.q(
        `INSERT INTO recent_dm_posts (id, posts) VALUES ($1, jsonb_build_array($2::jsonb))
         ON CONFLICT (${tenantCols("id")}) DO UPDATE SET posts = (
           SELECT COALESCE(jsonb_agg(p ORDER BY n), '[]'::jsonb)
             FROM jsonb_array_elements(recent_dm_posts.posts || EXCLUDED.posts) WITH ORDINALITY AS e(p, n)
            WHERE (p->>'at')::float8 > $4)
         WHERE NOT recent_dm_posts.posts @> jsonb_build_array(jsonb_build_object('key', $3::text))`,
        [threadRef, jsonbStringify(post), post.key, post.at - FIRE_RETENTION_MS],
      );
    },
    posts: async (threadRef: string) => (await table.get(threadRef))?.posts ?? [],
    async forgetThrough(threadRef: string, at: number): Promise<void> {
      await pg.q(
        `UPDATE recent_dm_posts SET posts = COALESCE((
           SELECT jsonb_agg(p ORDER BY n) FROM jsonb_array_elements(posts) WITH ORDINALITY AS e(p, n)
            WHERE (p->>'at')::float8 > $2), '[]'::jsonb)
         WHERE id = $1`,
        [threadRef, at],
      );
    },
  };
}

export type RecentDmPosts = ReturnType<typeof createRecentDmPosts>;

export async function recentPrincipalDeliveryNote(
  store: Pick<RecentDmPosts, "posts" | "forgetThrough"> | undefined,
  threadRef: string,
  since = 0,
): Promise<string> {
  if (!store) return "";
  const all = await store.posts(threadRef);
  const recent = all.filter((p) => p.at > since);
  if (recent.length < all.length) await store.forgetThrough(threadRef, since);
  if (!recent.length) return "";
  const lines = recent.map((p) => {
    const from = p.onBehalfOf ? ` from ${p.onBehalfOf}` : "";
    const trigger = p.trigger ? ` [${p.trigger}]` : "";
    const body = p.text.trim().split("\n");
    const text = body.length === 1 ? ` ${body[0]}` : `\n${body.map((line) => `  ${line}`).join("\n")}`;
    return `- ${new Date(p.at).toISOString()}${trigger}${from}:${text}`;
  });
  return ["Delivered here since the user's last message (delivery events, not your turns):", ...lines].join("\n");
}
