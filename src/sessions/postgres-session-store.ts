import { randomUUID } from "node:crypto";
import { createPgPool, withPgTransaction, tenantCols } from "../persistence/pg-pool.ts";
import type { Session } from "../types.ts";
import type { LeaseAttempt, LeaseHolder, LeasePeek, SessionStore, StoreOptions } from "./session-store.ts";
import { SESSION_STORE_MIGRATIONS } from "./postgres-session-migrations.ts";
import { createSessionReports } from "./postgres-session-reports.ts";
import { createLlmCapture } from "./postgres-llm-capture.ts";
import { cronIdOf, sessionOrigin } from "./thread-ref.ts";
import type { Item, NewItem } from "./items.ts";
import { rowToSession } from "./postgres-session-rows.ts";
import {
  insertItems,
  lockSession,
  sessionItemMethods,
  withLease,
  type SessionStoreCtx,
} from "./postgres-session-items.ts";
import { sessionParticipantMethods } from "./postgres-session-participants.ts";
import { sessionPinAndSearchMethods } from "./postgres-session-search.ts";
import { sessionAdminMethods } from "./postgres-session-admin.ts";

function sessionRecordMethods(ctx: SessionStoreCtx) {
  const { q, now } = ctx;
  return {
    async getOrCreateByThread(threadRef, type, scopeId, channelName, surface, clientTools): Promise<Session> {
      const heal = async (row: Record<string, unknown>): Promise<Session> => {
        const s = rowToSession(row);
        if (channelName && s.channelName !== channelName) {
          await q("UPDATE sessions SET channel_name = $2 WHERE id = $1", [s.id, channelName]);
          s.channelName = channelName;
        }
        if (surface && !s.surface) {
          await q("UPDATE sessions SET surface = $2 WHERE id = $1", [s.id, surface]);
          s.surface = surface;
        }
        return s;
      };
      const existing = await q("SELECT * FROM sessions WHERE thread_ref = $1", [threadRef]);
      if (existing[0]) return heal(existing[0]);
      const session: Session = {
        id: randomUUID(),
        type,
        scopeId,
        threadRef,
        createdAt: now(),
        ...(clientTools?.length ? { clientTools: structuredClone(clientTools) } : {}),
        ...(channelName ? { channelName } : {}),
        ...(surface ? { surface } : {}),
      };
      await q(
        `INSERT INTO sessions(id, type, scope_id, thread_ref, created_at, channel_name, surface, last_activity, messages, turns, origin, origin_id, client_tools) VALUES ($1,$2,$3,$4,$5,$6,$7,$5,0,0,$8,$9,$10::jsonb) ON CONFLICT (${tenantCols("thread_ref")}) DO NOTHING`,
        [
          session.id,
          session.type,
          session.scopeId,
          session.threadRef,
          session.createdAt,
          channelName ?? null,
          surface ?? null,
          sessionOrigin(threadRef),
          cronIdOf(threadRef),
          clientTools?.length ? JSON.stringify(clientTools) : null,
        ],
      );
      const rows = await q("SELECT * FROM sessions WHERE thread_ref = $1", [threadRef]);
      return heal(rows[0]!);
    },

    async getByThread(threadRef): Promise<Session | null> {
      const rows = await q("SELECT * FROM sessions WHERE thread_ref = $1", [threadRef]);
      return rows[0] ? rowToSession(rows[0]) : null;
    },

    async get(id): Promise<Session | null> {
      const rows = await q("SELECT * FROM sessions WHERE id = $1", [id]);
      return rows[0] ? rowToSession(rows[0]) : null;
    },

    async updateTitle(sessionId, title): Promise<void> {
      await q("UPDATE sessions SET title = $2 WHERE id = $1", [sessionId, title]);
    },

    async sideChatsOf(sessionId) {
      const rows = await q(
        "SELECT * FROM sessions WHERE forked_from_session_id = $1 AND side_chat IS NOT NULL ORDER BY created_at",
        [sessionId],
      );
      return rows.map(rowToSession);
    },

    async expandSideChat(sessionId) {
      await q(
        "UPDATE sessions SET side_chat = jsonb_set(side_chat, '{expanded}', 'true') WHERE id = $1 AND side_chat IS NOT NULL",
        [sessionId],
      );
    },

    async updateForkProvenance(sessionId, provenance): Promise<void> {
      await q(
        "UPDATE sessions SET forked_from_session_id = $2, forked_from_title = $3, fork_boundary_seq = $4, side_chat = $5 WHERE id = $1",
        [
          sessionId,
          provenance.forkedFrom.sessionId,
          provenance.forkedFrom.title ?? null,
          provenance.forkBoundarySeq,
          provenance.sideChat ? JSON.stringify(provenance.sideChat) : null,
        ],
      );
    },

    async setParentSession(sessionId, parentSessionId): Promise<void> {
      await q("UPDATE sessions SET parent_session_id = $2 WHERE id = $1", [sessionId, parentSessionId]);
    },

    async setSpawnMeta(sessionId, meta): Promise<void> {
      await q("UPDATE sessions SET spawn_meta = $2 WHERE id = $1", [sessionId, JSON.stringify(meta)]);
    },

    async childrenOf(parentSessionId): Promise<Session[]> {
      const rows = await q("SELECT * FROM sessions WHERE parent_session_id = $1 ORDER BY created_at", [
        parentSessionId,
      ]);
      return rows.map(rowToSession);
    },
  } satisfies Partial<SessionStore>;
}

function sessionLeaseMethods(
  ctx: SessionStoreCtx,
): Pick<
  SessionStore,
  "acquireLease" | "peekLease" | "renewLease" | "releaseLease" | "forceReleaseLease" | "append" | "appendMany"
> {
  const { q, pool, now, leaseTtlMs } = ctx;
  return {
    async acquireLease(sessionId, holder): Promise<LeaseAttempt> {
      const token = randomUUID();
      const t = now();
      return withPgTransaction(await pool(), async (client) => {
        await lockSession(client, sessionId);
        for (;;) {
          const granted = await client.query(
            `INSERT INTO session_leases(session_id, token, expires_at, holder, acquired_at)
               SELECT $1, $2, $3, $5, $4 WHERE EXISTS (SELECT 1 FROM sessions WHERE id = $1)
             ON CONFLICT (${tenantCols("session_id")}) DO UPDATE
               SET token = $2, expires_at = $3, holder = $5, acquired_at = $4
               WHERE session_leases.expires_at <= $4
             RETURNING token`,
            [sessionId, token, t + leaseTtlMs, t, holder ?? null],
          );
          if (granted.rows[0]) return { lease: { sessionId, token } };
          const held = await client.query(
            "SELECT expires_at, holder, acquired_at FROM session_leases WHERE session_id = $1",
            [sessionId],
          );
          const row = held.rows[0];
          if (row) {
            return {
              lease: null,
              ...(row.holder != null ? { heldBy: row.holder as LeaseHolder } : {}),
              ...(row.acquired_at != null ? { heldSince: Number(row.acquired_at) } : {}),
              heldUntil: Number(row.expires_at),
            };
          }
          const exists = await client.query("SELECT 1 FROM sessions WHERE id = $1", [sessionId]);
          if (!exists.rows[0]) return { lease: null };
        }
      });
    },

    async peekLease(sessionId): Promise<LeasePeek | null> {
      const rows = await q("SELECT holder, expires_at FROM session_leases WHERE session_id = $1", [sessionId]);
      const row = rows[0];
      if (!row) return null;
      return {
        ...(row.holder != null ? { holder: row.holder as LeaseHolder } : {}),
        heldUntil: Number(row.expires_at),
      };
    },

    async renewLease(lease): Promise<boolean> {
      const t = now();
      const rows = await q(
        "UPDATE session_leases SET expires_at = $3 WHERE session_id = $1 AND token = $2 AND expires_at > $4 RETURNING token",
        [lease.sessionId, lease.token, t + leaseTtlMs, t],
      );
      return rows.length > 0;
    },

    async releaseLease(lease): Promise<void> {
      await q("DELETE FROM session_leases WHERE session_id = $1 AND token = $2", [lease.sessionId, lease.token]);
    },

    async forceReleaseLease(sessionId): Promise<void> {
      await q("DELETE FROM session_leases WHERE session_id = $1", [sessionId]);
    },

    async append(lease, item: NewItem): Promise<Item> {
      return (await this.appendMany(lease, [item]))[0]!;
    },

    async appendMany(lease, items: readonly NewItem[]): Promise<Item[]> {
      return withLease(ctx, lease, "append without a valid session lease", (client) =>
        insertItems(now, client, lease.sessionId, items, lease.turnId),
      );
    },
  };
}

export function createPostgresSessionStore(connectionString: string, opts: StoreOptions = {}): SessionStore {
  const now = opts.now ?? (() => Date.now());
  const leaseTtlMs = opts.leaseTtlMs ?? 5 * 60_000;
  const db = createPgPool(connectionString, SESSION_STORE_MIGRATIONS);
  const { pool, q } = db;
  const reports = createSessionReports(db, now);
  const llmCapture = createLlmCapture(db, now);
  const ctx: SessionStoreCtx = { q, pool, now, leaseTtlMs };
  return {
    ...reports,
    ...llmCapture,
    leaseTtlMs,
    ...sessionRecordMethods(ctx),
    ...sessionLeaseMethods(ctx),
    ...sessionItemMethods(ctx),
    ...sessionParticipantMethods(ctx),
    ...sessionPinAndSearchMethods(ctx),
    ...sessionAdminMethods(ctx),
  };
}
