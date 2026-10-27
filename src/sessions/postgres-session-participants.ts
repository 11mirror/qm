import type { PgPool, PoolClient } from "../persistence/pg-pool.ts";
import { withPgTransaction, tenantCols } from "../persistence/pg-pool.ts";
import { likeContains } from "../persistence/like.ts";
import type { Session, ScopeId } from "../types.ts";
import type {
  ParticipantPage,
  ParticipantPageQuery,
  ParticipantScope,
  SessionDescendant,
  SessionStore,
} from "./session-store.ts";
import { TENANT } from "./postgres-session-sql.ts";
import { rowToParticipantSession, LIST_COLUMNS, USER_ACTIVITY } from "./postgres-session-rows.ts";
import { lockSession, type SessionStoreCtx } from "./postgres-session-items.ts";
import { msOf, AGENT_REPLY_ITEM } from "./items.ts";

const AUTOMATION_SURFACES = "('cron', 'webhook', 'loop')";

const SEES_ITEMS = `CASE WHEN p.valid_to_seq IS NULL
         THEN COALESCE(s.messages, 0) > p.valid_from_seq
         ELSE EXISTS (SELECT 1 FROM items x WHERE x.tenant_id = ${TENANT} AND x.session_id = s.id
                        AND x.seq >= p.valid_from_seq AND x.seq < p.valid_to_seq) END`;
const HAS_CONTENT = `(NULLIF(btrim(COALESCE(p.title, s.title)), '') IS NOT NULL OR ${SEES_ITEMS})`;
export const participantSessionsSql = (extraWhere: string, columns = "s.*"): string =>
  `SELECT ${columns}, p.title AS p_title, p.archived AS p_archived, p.pinned AS p_pinned, p.color AS p_color,
            p.read_at AS p_read_at,
            (SELECT ${msOf("MAX(e.created_at)")} FROM items e
              WHERE e.tenant_id = ${TENANT} AND e.session_id = s.id AND ${AGENT_REPLY_ITEM("e")}) AS agent_last_reply,
            ${USER_ACTIVITY} AS user_last_activity,
            ${SEES_ITEMS} AS has_entries
       FROM sessions s
       JOIN participants p ON p.session_id = s.id
      WHERE p.principal_id = $1${extraWhere}`;
const participantSessions = async (
  q: PgPool["q"],
  principalId: string,
  opts?: { limit: number },
): Promise<Session[]> => {
  const limit = opts ? Math.max(0, Math.floor(opts.limit)) : undefined;
  const rows = await q(
    participantSessionsSql("", LIST_COLUMNS) +
      (limit === undefined ? "" : " ORDER BY COALESCE(s.last_activity, s.created_at) DESC, s.id LIMIT $2"),
    limit === undefined ? [principalId] : [principalId, limit],
  );
  return rows.map(rowToParticipantSession);
};
const participantScopes = async (q: PgPool["q"], principalId: string): Promise<ParticipantScope[]> => {
  const rows = await q(
    `SELECT s.scope_id, MAX(s.channel_name) AS channel_name,
              COUNT(*) FILTER (WHERE ${HAS_CONTENT}) AS session_count,
              MAX(${USER_ACTIVITY}) FILTER (WHERE ${HAS_CONTENT}) AS last_activity
         FROM sessions s
         JOIN participants p ON p.session_id = s.id
        WHERE p.principal_id = $1
        GROUP BY s.scope_id`,
    [principalId],
  );
  return rows.map((r) => ({
    scopeId: r.scope_id as ScopeId,
    ...(r.channel_name != null ? { channelName: r.channel_name as string } : {}),
    sessionCount: Number(r.session_count),
    lastActivityAt: r.last_activity == null ? null : Number(r.last_activity),
  }));
};
const participantPage = async (
  q: PgPool["q"],
  principalId: string,
  query: ParticipantPageQuery,
): Promise<ParticipantPage> => {
  const params: unknown[] = [principalId];
  const where: string[] = [
    "p.principal_id = $1",
    "s.parent_session_id IS NULL",
    `(s.surface IS NULL OR s.surface NOT IN ${AUTOMATION_SURFACES})`,
    HAS_CONTENT,
  ];
  const param = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  where.push(`COALESCE(p.archived, false) = ${param(query.archived === true)}`);
  if (query.pinned !== undefined) where.push(`COALESCE(p.pinned, false) = ${param(query.pinned)}`);
  if (query.surface !== undefined) where.push(`s.surface = ${param(query.surface)}`);
  if (query.scopeId !== undefined) where.push(`s.scope_id = ${param(query.scopeId)}`);
  if (query.sessionIds !== undefined) where.push(`s.id = ANY(${param([...query.sessionIds])}::text[])`);
  if (query.titleQuery?.trim()) {
    const pattern = param(likeContains(query.titleQuery.trim()));
    where.push(`(COALESCE(p.title, s.title) ILIKE ${pattern} OR s.channel_name ILIKE ${pattern})`);
  }
  if (query.before)
    where.push(`(${USER_ACTIVITY}, s.id) < (${param(query.before.activity)}::bigint, ${param(query.before.id)})`);
  const limit = Math.max(1, Math.min(Math.floor(query.limit), 200));
  const page = await q(
    `SELECT s.id, ${USER_ACTIVITY} AS activity
         FROM participants p JOIN sessions s ON s.id = p.session_id
        WHERE ${where.join(" AND ")}
        ORDER BY ${USER_ACTIVITY} DESC, s.id DESC
        LIMIT ${param(limit + 1)}`,
    params,
  );
  const more = page.length > limit;
  const ids = page.slice(0, limit).map((row) => row.id as string);
  if (!ids.length) return { sessions: [], next: null };
  const rows = await q(participantSessionsSql(" AND s.id = ANY($2::text[])", LIST_COLUMNS), [principalId, ids]);
  const byId = new Map(rows.map((row) => [row.id as string, rowToParticipantSession(row)]));
  const last = page[limit - 1];
  return {
    sessions: ids.flatMap((id) => byId.get(id) ?? []),
    next: more && last ? { activity: Number(last.activity), id: last.id as string } : null,
  };
};
const descendantsOf = async (q: PgPool["q"], rootIds: readonly string[]): Promise<SessionDescendant[]> => {
  if (!rootIds.length) return [];
  const rows = await q(
    `WITH RECURSIVE tree(id, root_id, thread_ref, scope_id) AS (
         SELECT id, parent_session_id, thread_ref, scope_id FROM sessions WHERE parent_session_id = ANY($1::text[])
         UNION
         SELECT s.id, t.root_id, s.thread_ref, s.scope_id FROM sessions s JOIN tree t ON s.parent_session_id = t.id
       )
       SELECT id, root_id, thread_ref, scope_id FROM tree`,
    [[...rootIds]],
  );
  return rows.map((r) => ({
    id: r.id as string,
    rootId: r.root_id as string,
    threadRef: r.thread_ref as string,
    scopeId: r.scope_id as ScopeId,
  }));
};
const deleteSessionChildren = async (client: PoolClient, sessionId: string): Promise<void> => {
  for (const table of ["session_llm_requests", "session_leases", "participants", "session_pins"])
    await client.query(`DELETE FROM ${table} WHERE session_id = $1`, [sessionId]);
};
const participantSession = async (q: PgPool["q"], sessionId: string, principalId: string): Promise<Session | null> => {
  const rows = await q(participantSessionsSql(" AND s.id = $2"), [principalId, sessionId]);
  return rows[0] ? rowToParticipantSession(rows[0]) : null;
};

export function sessionParticipantMethods(ctx: SessionStoreCtx) {
  const { q, pool, now } = ctx;
  return {
    async addParticipant(sessionId, principalId, title, opts): Promise<void> {
      const includeHistory = opts?.includeHistory === true;
      await q(
        `WITH boundary AS (
           SELECT CASE WHEN $5 THEN 0
                       ELSE GREATEST(COALESCE(MAX(seq) + 1, 0),
                                     COALESCE((SELECT messages FROM sessions WHERE id = $1), 0)) END AS seq
             FROM items WHERE tenant_id = ${TENANT} AND session_id = $1
         )
         INSERT INTO participants(session_id, principal_id, valid_from, valid_to, valid_from_seq, valid_to_seq, title)
         SELECT $1,$2,$3,NULL,boundary.seq,NULL,$4 FROM boundary
         ON CONFLICT (${tenantCols("session_id, principal_id")}) DO UPDATE
           SET valid_from = CASE
                 WHEN $5 THEN 0
                 WHEN participants.valid_to IS NULL THEN participants.valid_from
                 ELSE EXCLUDED.valid_from END,
               valid_to = NULL,
               valid_from_seq = CASE
                 WHEN $5 THEN 0
                 WHEN participants.valid_to IS NULL THEN participants.valid_from_seq
                 ELSE EXCLUDED.valid_from_seq END,
               valid_to_seq = NULL,
               title = COALESCE(EXCLUDED.title, participants.title)
           WHERE participants.valid_to IS NOT NULL
              OR EXCLUDED.title IS NOT NULL
              OR ($5 AND (participants.valid_from_seq IS DISTINCT FROM 0 OR participants.valid_from <> 0))`,
        [sessionId, principalId, includeHistory ? 0 : now(), title ?? null, includeHistory],
      );
    },

    async removeParticipant(sessionId, principalId): Promise<void> {
      await q(
        `UPDATE participants SET valid_to = $3, valid_to_seq = (SELECT COALESCE(MAX(seq) + 1, 0) FROM items WHERE tenant_id = ${TENANT} AND session_id = $1) WHERE session_id = $1 AND principal_id = $2 AND valid_to IS NULL`,
        [sessionId, principalId, now()],
      );
    },

    async deleteSession(sessionId): Promise<void> {
      await withPgTransaction(await pool(), async (client) => {
        await lockSession(client, sessionId);
        await deleteSessionChildren(client, sessionId);
        await client.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
      });
    },

    async deleteSessionIfEmpty(sessionId): Promise<boolean> {
      return withPgTransaction(await pool(), async (client) => {
        await lockSession(client, sessionId);
        const gone = await client.query(
          `DELETE FROM sessions
            WHERE id = $1
              AND NOT EXISTS (SELECT 1 FROM items WHERE tenant_id = ${TENANT} AND session_id = $1)
              AND NOT EXISTS (SELECT 1 FROM session_leases WHERE session_id = $1 AND expires_at > $2)`,
          [sessionId, now()],
        );
        if (gone.rowCount === 0) return false;
        await deleteSessionChildren(client, sessionId);
        return true;
      });
    },

    async listByParticipant(principalId, opts): Promise<Session[]> {
      return participantSessions(q, principalId, opts);
    },

    async participantScopes(principalId): Promise<ParticipantScope[]> {
      return participantScopes(q, principalId);
    },

    async listParticipantPage(principalId, query): Promise<ParticipantPage> {
      return participantPage(q, principalId, query);
    },

    async descendantsOf(rootIds): Promise<SessionDescendant[]> {
      return descendantsOf(q, rootIds);
    },

    async listDescendantsForParticipant(rootId, principalId, limit): Promise<Session[]> {
      const rows = await q(
        participantSessionsSql(
          ` AND s.id IN (WITH RECURSIVE tree(id) AS (
                SELECT id FROM sessions WHERE parent_session_id = $2
                UNION
                SELECT c.id FROM sessions c JOIN tree t ON c.parent_session_id = t.id
              ) SELECT id FROM tree)`,
          LIST_COLUMNS,
        ) + " ORDER BY s.created_at, s.id LIMIT $3",
        [principalId, rootId, Math.max(0, Math.floor(limit))],
      );
      return rows.map(rowToParticipantSession);
    },

    async getForParticipant(sessionId, principalId): Promise<Session | null> {
      return participantSession(q, sessionId, principalId);
    },

    async updateParticipantView(sessionId, principalId, patch): Promise<void> {
      const set = (
        [
          ["title", patch.title],
          ["archived", patch.archived],
          ["pinned", patch.pinned],
          ["color", patch.color],
          ["read_at", patch.readAt],
        ] as const
      ).filter(([, value]) => value !== undefined);
      if (!set.length) return;
      await q(
        `UPDATE participants SET ${set.map(([column], i) => `${column} = $${i + 3}`).join(", ")}
          WHERE session_id = $1 AND principal_id = $2`,
        [sessionId, principalId, ...set.map(([, value]) => value)],
      );
    },
  } satisfies Partial<SessionStore>;
}
