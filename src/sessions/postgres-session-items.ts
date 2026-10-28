import { turnFenceHeld } from "../turns/turn-fence.ts";
import { jsonbStringify, jsonbSafeStringify, pgTextSafe } from "../util/text.ts";
import { type PgPool, type PoolClient, withPgTransaction, tenantCols } from "../persistence/pg-pool.ts";
import type { GoalRecord } from "../harness/goal.ts";
import type { GetItemsOptions, Lease, SessionStore } from "./session-store.ts";
import { DuplicateCallError } from "./session-store.ts";
import { nextSeq, TENANT, tsOf, userTurn, withinParticipantWindow } from "./postgres-session-sql.ts";
import { rowToGoal, rowToItem, ITEM_FIELDS, ITEM_FROM } from "./postgres-session-rows.ts";
import { ITEM_COLUMNS, isOverheard, isUserMessage, storedItem, type Item, type NewItem } from "./items.ts";

export interface SessionStoreCtx {
  q: PgPool["q"];
  pool: PgPool["pool"];
  now: () => number;
  leaseTtlMs: number;
}

const LAST_ACTIVITY_DEBOUNCE_MS = 60_000;
const FIRST_PREVIEW_LEN = 160;
const LAST_PREVIEW_LEN = 100;

function userMessagePreview(text: string | null | undefined, maxLen = 160): string {
  const oneLine = (text ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen - 1) + "…" : oneLine;
}

const storedPreview = (text: string | null, maxLen: number): string => pgTextSafe(userMessagePreview(text, maxLen));

export function transcriptItemPredicate(alias: string, participant?: string): string {
  const receipt = (item: string): string => `COALESCE(${item}.body @> '{"slackReplyReceipt":true}'::jsonb, false)`;
  return `NOT (
      ${alias}.kind = 'UserMessage' AND ${receipt(alias)}
      AND EXISTS (
        SELECT 1 FROM items received
        WHERE received.tenant_id = ${alias}.tenant_id AND received.session_id = ${alias}.session_id
          AND received.kind = 'UserMessage' AND received.external_id = ${alias}.external_id
          AND NOT ${receipt("received")}
          ${participant ? `AND ${withinParticipantWindow("received", participant)}` : ""}
      )
    )`;
}

export const lockSession = (client: PoolClient, sessionId: string) =>
  client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [sessionId]);

export const withLease = async <T>(
  ctx: SessionStoreCtx,
  lease: Lease,
  invalidMsg: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> =>
  withPgTransaction(await ctx.pool(), async (client) => {
    await lockSession(client, lease.sessionId);
    const held = await client.query("SELECT token, expires_at FROM session_leases WHERE session_id = $1 FOR UPDATE", [
      lease.sessionId,
    ]);
    if (held.rows[0]?.token !== lease.token || Number(held.rows[0]!.expires_at) <= ctx.now())
      throw new Error(invalidMsg);
    if (lease.fenceToken) {
      if (!(await turnFenceHeld(client, lease.turnId ?? "", lease.fenceToken)))
        throw new Error(`${invalidMsg}: the turn no longer holds its claim`);
    }
    await client.query("UPDATE session_leases SET expires_at = $2 WHERE session_id = $1", [
      lease.sessionId,
      ctx.now() + ctx.leaseTtlMs,
    ]);
    return fn(client);
  });

export const insertItems = async (
  now: () => number,
  client: PoolClient,
  sessionId: string,
  newItems: readonly NewItem[],
  turnId?: string,
): Promise<Item[]> => {
  if (!newItems.length) return [];
  const max = await client.query(`SELECT ${nextSeq("$1")} AS n`, [sessionId]);
  const startSeq = Number(max.rows[0]!.n);
  const createdAt = now();
  const full = newItems.map(
    (item, index) =>
      JSON.parse(
        jsonbSafeStringify(storedItem(item, { sessionId, seq: startSeq + index, createdAt, turnId: turnId ?? null })),
      ) as Item,
  );
  for (const item of full) {
    if (item.kind !== "Retraction" || typeof item.body.ts !== "string") continue;
    const inBatch = full.findLast(
      (other) => other.seq < item.seq && other.kind === "UserMessage" && other.externalId === item.body.ts,
    );
    const {
      rows: [prior],
    } = await client.query(
      `SELECT max(seq) AS seq FROM items WHERE tenant_id=${TENANT} AND session_id=$1 AND external_id=$2 AND seq<$3`,
      [sessionId, item.body.ts, item.seq],
    );
    item.targetSeq = inBatch?.seq ?? (prior.seq == null ? null : Number(prior.seq));
  }
  const userTurns = full.filter((item) => isUserMessage(item) && !isOverheard(item));
  const firstUser = userTurns[0];
  const lastUser = userTurns[userTurns.length - 1];
  await client
    .query(
      `INSERT INTO items(tenant_id, session_id, seq, ${ITEM_COLUMNS.map(([column]) => column).join(",")}, created_at)
       SELECT ${TENANT}, $1, i.seq, ${ITEM_COLUMNS.map(([column, key]) => (column === "blob_sha" ? `decode(i."${key}", 'hex')` : `i."${key}"`)).join(",")}, ${tsOf("$3::bigint")}
       FROM jsonb_to_recordset($2::jsonb) AS i(seq bigint, ${ITEM_COLUMNS.map(([, key, type]) => `"${key}" ${type}`).join(",")})
       ORDER BY i.seq`,
      [sessionId, jsonbStringify(full), createdAt],
    )
    .catch((err: unknown) => {
      const e = err as { code?: unknown; constraint?: unknown };
      if (e?.code !== "23505" || e.constraint !== "items_one_call_per_kind") throw err;
      throw new DuplicateCallError(
        sessionId,
        full.flatMap((item) => (item.callId ? [item.callId] : [])),
        { cause: err },
      );
    });
  await client.query(
    `UPDATE sessions
          SET last_activity = CASE WHEN last_activity >= $2::bigint - ${LAST_ACTIVITY_DEBOUNCE_MS}
                                   THEN last_activity
                                   ELSE GREATEST(COALESCE(last_activity, 0), $2::bigint) END,
              messages = $3,
              turns = CASE WHEN turns IS NULL OR messages IS DISTINCT FROM $5
                           THEN (SELECT COUNT(*) FROM items t WHERE t.tenant_id = ${TENANT} AND t.session_id = $1 AND ${userTurn("t")})
                           ELSE turns + $4 END,
              first_user_preview = CASE WHEN first_user_preview IS NULL AND turns = 0 AND messages = $5
                                        THEN $6 ELSE first_user_preview END,
              last_user_preview = COALESCE($7, last_user_preview),
              last_user_activity = CASE WHEN $8::boolean THEN GREATEST(COALESCE(last_user_activity, 0), $2::bigint)
                                        ELSE last_user_activity END
        WHERE id = $1`,
    [
      sessionId,
      createdAt,
      startSeq + full.length,
      userTurns.length,
      startSeq,
      firstUser ? storedPreview(firstUser.text, FIRST_PREVIEW_LEN) : null,
      lastUser ? storedPreview(lastUser.text, LAST_PREVIEW_LEN) : null,
      full.some(isUserMessage),
    ],
  );
  return full;
};

export function sessionItemMethods(ctx: SessionStoreCtx) {
  const { q, now } = ctx;
  return {
    async countItemsBefore(sessionId, beforeSeq, principalId) {
      const rows =
        principalId === undefined
          ? await q(
              `SELECT count(*)::int AS n FROM items i WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq < $2 AND ${transcriptItemPredicate("i")}`,
              [sessionId, beforeSeq],
            )
          : await q(
              `SELECT count(*)::int AS n FROM items i
                 JOIN participants p ON p.session_id = i.session_id AND p.principal_id = $3
                WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq < $2 AND ${transcriptItemPredicate("i", "p")} AND ${withinParticipantWindow("i", "p")}`,
              [sessionId, beforeSeq, principalId],
            );
      return Number(rows[0]?.n ?? 0);
    },

    async latestItemSeq(sessionId): Promise<number> {
      const rows = await q(
        `SELECT COALESCE(MAX(seq), -1) AS n FROM items WHERE tenant_id = ${TENANT} AND session_id = $1`,
        [sessionId],
      );
      return Number(rows[0]?.n ?? -1);
    },

    async goals(sessionIds) {
      const found = new Map<string, GoalRecord>();
      if (!sessionIds.length) return found;
      const rows = await q("SELECT * FROM session_goals WHERE session_id = ANY($1::text[])", [[...sessionIds]]);
      for (const row of rows) found.set(row.session_id as string, rowToGoal(row));
      return found;
    },

    async setGoal(lease, goal, notices = []) {
      await withLease(ctx, lease, "set goal without a valid session lease", async (client) => {
        await insertItems(now, client, lease.sessionId, notices, lease.turnId);
        await client.query(
          `INSERT INTO session_goals(session_id, objective, status, floor, token_cap, tokens_used, active_ms,
                                     active_since, completion_note, cancel_note, governor, pause_reason,
                                     created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
           ON CONFLICT (${tenantCols("session_id")}) DO UPDATE SET
             objective = EXCLUDED.objective, status = EXCLUDED.status, floor = EXCLUDED.floor,
             token_cap = EXCLUDED.token_cap, tokens_used = EXCLUDED.tokens_used, active_ms = EXCLUDED.active_ms,
             active_since = EXCLUDED.active_since, completion_note = EXCLUDED.completion_note,
             cancel_note = EXCLUDED.cancel_note, governor = EXCLUDED.governor, pause_reason = EXCLUDED.pause_reason,
             created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
          [
            lease.sessionId,
            goal.objective,
            goal.status,
            goal.floor ? JSON.stringify(goal.floor) : null,
            goal.capTokens ?? null,
            Math.floor(goal.tokensUsed),
            goal.activeMs === undefined ? null : Math.round(goal.activeMs),
            goal.activeSince === undefined ? null : new Date(goal.activeSince),
            goal.completionNote ?? null,
            goal.cancelNote ?? null,
            goal.governor ? JSON.stringify(goal.governor) : null,
            goal.pauseReason ?? null,
            new Date(goal.createdAt),
            new Date(goal.updatedAt),
          ],
        );
      });
    },

    async hasDeliveryItem(sessionId, deliveryKey, slackTs) {
      const rows = await q(
        `SELECT 1 FROM items WHERE tenant_id = ${TENANT} AND session_id = $1 AND kind = 'UserMessage'
         AND (body ->> 'deliveryKey' = $2 OR external_id = $3) LIMIT 1`,
        [sessionId, deliveryKey, slackTs ?? null],
      );
      return rows.length > 0;
    },

    async recordedMessageTimestamps(sessionId, timestamps) {
      if (!timestamps.length) return new Set<string>();
      const rows = await q(
        `SELECT external_id AS ts FROM items
          WHERE tenant_id = ${TENANT} AND session_id = $1 AND kind = 'UserMessage' AND external_id = ANY($2::text[])
         UNION
         SELECT body ->> 'ts' AS ts FROM items
          WHERE tenant_id = ${TENANT} AND session_id = $1 AND kind = 'SteeringMessage' AND body ->> 'ts' = ANY($2::text[])`,
        [sessionId, [...timestamps]],
      );
      return new Set(rows.map((row) => row.ts as string));
    },

    async getItems(sessionId, opts?: GetItemsOptions): Promise<Item[]> {
      const params: unknown[] = [sessionId, opts?.sinceSeq ?? 0];
      let sql = `SELECT ${ITEM_FIELDS} FROM ${ITEM_FROM} WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq >= $2`;
      if (opts?.transcript) sql += ` AND ${transcriptItemPredicate("i")}`;
      if (opts?.beforeSeq !== undefined) {
        params.push(opts.beforeSeq);
        sql += ` AND i.seq < $${params.length}`;
      }
      if (opts?.turnId !== undefined) {
        params.push(opts.turnId);
        sql += ` AND i.turn_id = $${params.length}::uuid`;
      }
      sql += " ORDER BY i.seq DESC";
      if (opts?.limit !== undefined) {
        params.push(opts.limit);
        sql += ` LIMIT $${params.length}`;
      }
      return (await q(sql, params)).map(rowToItem).reverse();
    },

    async getContextWindow(sessionId) {
      const summary = await q(
        `SELECT through_seq AS through FROM items
          WHERE tenant_id = ${TENANT} AND session_id = $1 AND kind = 'ContextCompaction'
            AND through_seq IS NOT NULL AND text IS NOT NULL ORDER BY seq DESC LIMIT 1`,
        [sessionId],
      );
      const sinceSeq = summary[0]?.through == null ? 0 : Number(summary[0].through) + 1;
      const rows = await q(
        `SELECT ${ITEM_FIELDS} FROM ${ITEM_FROM} WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq >= $2 ORDER BY i.seq`,
        [sessionId, sinceSeq],
      );
      return { items: rows.map(rowToItem) };
    },

    async getItem(sessionId, seq): Promise<Item | undefined> {
      const rows = await q(
        `SELECT ${ITEM_FIELDS} FROM ${ITEM_FROM} WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq = $2`,
        [sessionId, seq],
      );
      return rows[0] ? rowToItem(rows[0]) : undefined;
    },
  } satisfies Partial<SessionStore>;
}
