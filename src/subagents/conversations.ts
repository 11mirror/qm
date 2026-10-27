import { errMessage } from "../util/errors.ts";
import type { CoreSearch } from "../search/core-search.ts";
import { isSubagentThreadRef } from "../sessions/thread-ref.ts";
import type { SessionStartInput, SessionStartResult, SessionSummary, SessionListResult } from "./types.ts";
import type { TurnContext } from "./turn-context.ts";

export async function searchSessions(
  ctx: TurnContext,
  input: { query: string; limit?: number },
): ReturnType<CoreSearch["search"]> {
  const { deps, sidebarRefusal, currentCaller } = ctx;
  const caller = await currentCaller();
  const refusal = sidebarRefusal();
  if (refusal) throw new Error(refusal);
  const search = deps.conversations?.search;
  if (!search) throw new Error("session search isn't available on this deployment.");
  const members = caller.conversation.publishMembers;
  if (caller.conversation.kind !== "dm" && !members?.length)
    throw new Error("search requires the complete principal set for a shared conversation");
  if (!input.query.trim()) throw new Error("search requires a query");
  return search({
    query: input.query,
    principals: [caller.actor, ...(members ?? caller.conversation.audience)],
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
}

export async function listSessions(ctx: TurnContext): Promise<SessionListResult> {
  const { deps, binding, sidebarRefusal, statusesOf, currentCaller } = ctx;
  await currentCaller();
  const conversations = deps.conversations;
  if (!conversations) return { ok: false, message: "sessions aren't available on this deployment." };
  const refusal = sidebarRefusal();
  if (refusal) return { ok: false, message: refusal };
  const audience = binding.request.conversation.audience.length
    ? binding.request.conversation.audience
    : [binding.request.actor];
  const candidates = (await conversations.list(binding.request.actor.id)).filter(
    (s) => s.scopeId === binding.scopeId && !s.parentSessionId && !isSubagentThreadRef(s.threadRef) && !s.archived,
  );
  const seenBy = await Promise.all(
    audience.map(async (person) => new Set((await deps.sessions.listByParticipant(person.id)).map(({ id }) => id))),
  );
  const recent = candidates
    .filter((session) => seenBy.every((seen) => seen.has(session.id)))
    .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt));
  const statuses = await statusesOf(recent);
  const sessions: SessionSummary[] = recent.map((session) => ({
    sessionId: session.id,
    title: session.title?.trim() || "Untitled",
    status: statuses.get(session.threadRef) ?? "idle",
    current: session.id === binding.session.id,
  }));
  return { ok: true, sessions };
}

export async function startSession(ctx: TurnContext, input: SessionStartInput): Promise<SessionStartResult> {
  const { deps, binding, sidebarRefusal, currentCaller } = ctx;
  try {
    await currentCaller();
  } catch (error) {
    return { ok: false, message: errMessage(error) };
  }
  const conversations = deps.conversations;
  if (!conversations) return { ok: false, message: "sessions aren't available on this deployment." };
  const refusal = sidebarRefusal();
  if (refusal) return { ok: false, message: refusal };
  const verb = input.fork ? "fork" : "new";
  if (binding.liveTurn !== true)
    return {
      ok: false,
      message: `${verb} needs a person attending this turn — not a cron, trigger, subagent, or other automation.`,
    };
  if (binding.request.readOnly) return { ok: false, message: "a read-only turn cannot create sessions." };
  const text = input.text?.trim();
  if (!input.fork && !text) return { ok: false, message: "new requires `text`: the new session's first message." };
  const out = await conversations
    .start(binding.request.actor.id, {
      scopeId: binding.scopeId,
      origin: binding.request.origin,
      sessionSenderId: binding.session.id,
      ...(binding.request.runId ? { delegatingRunId: binding.request.runId } : {}),
      ...(input.fork ? { forkOf: binding.session.id } : {}),
      ...(text ? { text } : {}),
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    })
    .catch((error: unknown) => ({ error: errMessage(error) }));
  if ("error" in out) return { ok: false, message: out.error };
  return {
    ok: true,
    sessionId: out.session.id,
    title: out.session.title?.trim() || "Untitled",
    ...(out.refused ? { refused: out.refused } : {}),
  };
}
