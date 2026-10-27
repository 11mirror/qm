import type { Session, SessionType, ScopeId } from "../types.ts";
import type { GoalRecord } from "../harness/goal.ts";
import type { ParticipantWindow } from "./session-store.ts";
import { ITEM_COLUMNS, type Item, msOf } from "./items.ts";

export function rowToGoal(r: Record<string, unknown>): GoalRecord {
  return {
    objective: r.objective as string,
    status: r.status as GoalRecord["status"],
    tokensUsed: Number(r.tokens_used),
    createdAt: (r.created_at as Date).getTime(),
    updatedAt: (r.updated_at as Date).getTime(),
    ...(r.floor != null ? { floor: r.floor as GoalRecord["floor"] } : {}),
    ...(r.token_cap != null ? { capTokens: Number(r.token_cap) } : {}),
    ...(r.active_ms != null ? { activeMs: Number(r.active_ms) } : {}),
    ...(r.active_since != null ? { activeSince: (r.active_since as Date).getTime() } : {}),
    ...(r.completion_note != null ? { completionNote: r.completion_note as string } : {}),
    ...(r.cancel_note != null ? { cancelNote: r.cancel_note as string } : {}),
    ...(r.governor != null ? { governor: r.governor as GoalRecord["governor"] } : {}),
    ...(r.pause_reason != null ? { pauseReason: r.pause_reason as string } : {}),
  };
}

export function rowToSession(r: Record<string, unknown>): Session {
  return {
    id: r.id as string,
    type: r.type as SessionType,
    scopeId: r.scope_id as ScopeId,
    threadRef: r.thread_ref as string,
    ...(r.surface != null ? { surface: r.surface as string } : {}),
    ...(r.client_tools ? { clientTools: r.client_tools as Session["clientTools"] } : {}),
    createdAt: Number(r.created_at),
    ...(r.title != null ? { title: r.title as string } : {}),
    ...(r.channel_name != null ? { channelName: r.channel_name as string } : {}),
    ...(r.forked_from_session_id != null && r.fork_boundary_seq != null
      ? {
          forkedFrom: {
            sessionId: r.forked_from_session_id as string,
            ...(r.forked_from_title != null ? { title: r.forked_from_title as string } : {}),
          },
          forkBoundarySeq: Number(r.fork_boundary_seq),
        }
      : {}),
    ...(r.parent_session_id != null ? { parentSessionId: r.parent_session_id as string } : {}),
    ...(r.spawn_meta != null ? { spawnMeta: JSON.parse(r.spawn_meta as string) as Session["spawnMeta"] } : {}),
  };
}

export function rowToParticipantSession(r: Record<string, unknown>): Session {
  const s = rowToSession(r);
  if (r.p_title != null) s.title = r.p_title as string;
  if (r.p_archived) s.archived = true;
  if (r.p_pinned) s.pinned = true;
  if (r.p_color != null) s.color = r.p_color as string;
  if (r.agent_last_reply != null && Number(r.agent_last_reply) > Number(r.p_read_at ?? 0) && s.surface === "web")
    s.unread = true;
  if (r.user_last_activity != null) s.lastActivityAt = Number(r.user_last_activity);
  if (r.has_entries != null) s.hasEntries = Boolean(r.has_entries);
  return s;
}

export function rowToParticipantWindow(r: Record<string, unknown>): ParticipantWindow {
  return {
    sessionId: r.session_id as string,
    principalId: r.principal_id as string,
    validFrom: Number(r.valid_from),
    validTo: r.valid_to == null ? null : Number(r.valid_to),
    validFromSeq: Number(r.valid_from_seq),
    validToSeq: r.valid_to_seq == null ? null : Number(r.valid_to_seq),
  };
}

export function rowToItem(r: Record<string, unknown>): Item {
  const item: Record<string, unknown> = {
    sessionId: r.sessionId as string,
    seq: Number(r.seq),
    createdAt: Number(r.createdAt),
  };
  for (const [, key, type] of ITEM_COLUMNS)
    item[key] = type === "bigint" && r[key] != null ? Number(r[key]) : (r[key] ?? null);
  return item as unknown as Item;
}

export const ITEM_FIELDS = `i.session_id AS "sessionId", i.seq, ${ITEM_COLUMNS.map(([column, key]) => `${column === "blob_sha" ? "encode(i.blob_sha, 'hex')" : `i.${column}`} AS "${key}"`).join(",")}, ${msOf("i.created_at")} AS "createdAt"`;
export const ITEM_FROM = "items i";
export const LIST_COLUMNS = `s.id, s.type, s.scope_id, s.thread_ref, s.surface, s.created_at, s.title, s.channel_name,
  s.forked_from_session_id, s.forked_from_title, s.fork_boundary_seq, s.parent_session_id`;
export const USER_ACTIVITY = "COALESCE(s.last_user_activity, s.created_at)";
