import type { Session, SessionType, ScopeId } from "../types.ts";
import type {
  ScopeActivity,
  DistinctScope,
  ParticipantWindow,
  SessionOriginFilter,
  SessionPage,
  SessionRef,
  SessionStore,
  SessionSummary,
} from "./session-store.ts";
import type { SessionOrigin } from "./thread-ref.ts";
import { rowToSession, rowToParticipantWindow } from "./postgres-session-rows.ts";
import type { SessionStoreCtx } from "./postgres-session-items.ts";

const ADMIN_READ_TIMEOUT_MS = 10_000;

const lastActivityExpr = (col: string): string => `COALESCE(${col}.last_activity, ${col}.created_at)`;
const isBackground = (alias: string): string => `${alias}.origin <> 'conversation'`;
const hasOrigin = (alias: string, origin: SessionOrigin): string => `${alias}.origin = '${origin}'`;
const originFilterClause = (alias: string, origin: SessionOriginFilter): string =>
  origin === "other_background" ? `${alias}.origin NOT IN ('conversation', 'cron')` : hasOrigin(alias, origin);

export function sessionAdminMethods(ctx: SessionStoreCtx) {
  const { q } = ctx;
  return {
    async countSessions(): Promise<number> {
      const rows = await q("SELECT COUNT(*) AS n FROM sessions");
      return Number(rows[0]?.n ?? 0);
    },

    async listByScope(scope): Promise<Session[]> {
      const rows = await q("SELECT * FROM sessions WHERE scope_id = $1 ORDER BY created_at DESC, id DESC", [scope]);
      return rows.map(rowToSession);
    },

    async scopeHasSessions(scope): Promise<boolean> {
      const rows = await q("SELECT EXISTS(SELECT 1 FROM sessions WHERE scope_id = $1) AS present", [scope]);
      return Boolean(rows[0]?.present);
    },

    async sessionsByThreadRefs(threadRefs): Promise<SessionRef[]> {
      if (threadRefs.length === 0) return [];
      const rows = await q("SELECT id, thread_ref, scope_id, type, title FROM sessions WHERE thread_ref = ANY($1)", [
        [...new Set(threadRefs)],
      ]);
      return rows.map((r) => ({
        id: r.id as string,
        threadRef: r.thread_ref as string,
        scopeId: r.scope_id as ScopeId,
        type: r.type as SessionType,
        title: (r.title as string | null) ?? null,
      }));
    },

    async distinctScopes(): Promise<DistinctScope[]> {
      const rows = await q("SELECT scope_id, MAX(channel_name) AS channel_name FROM sessions GROUP BY scope_id");
      return rows.map((r) => ({
        scopeId: r.scope_id as ScopeId,
        ...(r.channel_name != null ? { channelName: r.channel_name as string } : {}),
      }));
    },

    async scopeSessionSummaries(scope, orgWide, page: SessionPage): Promise<SessionSummary[]> {
      const options = { timeoutMs: ADMIN_READ_TIMEOUT_MS, ...(page.signal ? { signal: page.signal } : {}) };
      const params: unknown[] = [orgWide, scope];
      let categoryClause = "";
      if (page.category === "background") categoryClause = ` AND ${isBackground("s")}`;
      else if (page.category) categoryClause = ` AND NOT ${isBackground("s")}`;
      const originClause = page.origin ? ` AND ${originFilterClause("s", page.origin)}` : "";
      let cronClause = "";
      if (page.cronId) {
        params.push(page.cronId);
        cronClause = ` AND s.origin_id = $${params.length}`;
      }
      let keysetClause = "";
      if (page.before) {
        params.push(page.before.lastActivity, page.before.id);
        keysetClause = ` AND (${lastActivityExpr("s")}, s.id) < ($${params.length - 1}::bigint, $${params.length}::text)`;
      }
      params.push(page.limit);
      const rows = await q(
        `SELECT s.id, s.type, s.scope_id, s.thread_ref, s.origin, s.created_at, s.messages, s.turns,
                ${lastActivityExpr("s")} AS last_activity, s.first_user_preview, s.last_user_preview, s.title
           FROM sessions s
          WHERE ($1::boolean OR s.scope_id = $2)${categoryClause}${originClause}${cronClause}${keysetClause}
          ORDER BY ${lastActivityExpr("s")} DESC, s.id DESC
          LIMIT $${params.length}`,
        params,
        options,
      );
      return rows.map((r) => ({
        id: r.id as string,
        type: r.type as Session["type"],
        origin: r.origin as SessionOrigin,
        scopeId: r.scope_id as Session["scopeId"],
        threadRef: r.thread_ref as Session["threadRef"],
        turns: Number(r.turns ?? 0),
        messages: Number(r.messages ?? 0),
        lastActivity: Number(r.last_activity),
        createdAt: Number(r.created_at),
        firstMessage: ((r.first_user_preview ?? r.title ?? "") as string).trim(),
        lastMessage: (r.last_user_preview as string | null) ?? "",
      }));
    },

    async scopeConversationCount(scope): Promise<number> {
      const rows = await q("SELECT COUNT(*) AS n FROM sessions WHERE scope_id = $1 AND origin = 'conversation'", [
        scope,
      ]);
      return Number(rows[0]?.n ?? 0);
    },

    async scopeActivity(): Promise<ScopeActivity[]> {
      const rows = await q(
        `SELECT scope_id,
                COUNT(*) FILTER (WHERE origin = 'conversation') AS conversations,
                COUNT(*) FILTER (WHERE origin = 'cron') AS crons,
                COUNT(*) FILTER (WHERE origin NOT IN ('conversation', 'cron')) AS background,
                MAX(${lastActivityExpr("sessions")}) AS last_activity
           FROM sessions
          GROUP BY scope_id`,
        [],
        { timeoutMs: ADMIN_READ_TIMEOUT_MS },
      );
      return rows.map((r) => ({
        scopeId: r.scope_id as ScopeId,
        conversations: Number(r.conversations),
        crons: Number(r.crons),
        background: Number(r.background),
        lastActivity: Number(r.last_activity),
      }));
    },

    async listParticipants(): Promise<ParticipantWindow[]> {
      const rows = await q(
        "SELECT session_id, principal_id, valid_from, valid_to, valid_from_seq, valid_to_seq FROM participants",
      );
      return rows.map(rowToParticipantWindow);
    },

    async distinctParticipants(): Promise<string[]> {
      const rows = await q("SELECT DISTINCT principal_id FROM participants");
      return rows.map((r) => r.principal_id as string);
    },

    async participantWindowsOf(sessionId): Promise<ParticipantWindow[]> {
      const rows = await q(
        "SELECT session_id, principal_id, valid_from, valid_to, valid_from_seq, valid_to_seq FROM participants WHERE session_id = $1",
        [sessionId],
      );
      return rows.map(rowToParticipantWindow);
    },

    async participantsOf(sessionId): Promise<string[]> {
      const rows = await q("SELECT principal_id FROM participants WHERE session_id = $1", [sessionId]);
      return rows.map((r) => r.principal_id as string);
    },
  } satisfies Partial<SessionStore>;
}
