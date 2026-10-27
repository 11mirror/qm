import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import type { SessionStore } from "../sessions/session-store.ts";

export async function itemVisibleToAll(
  sessions: Pick<SessionStore, "visibleItems">,
  sessionId: string,
  seq: number,
  principalIds: readonly string[],
): Promise<boolean> {
  return (await sessions.visibleItems(sessionId, principalIds, { sinceSeq: seq, beforeSeq: seq + 1 })).length > 0;
}

export function assertAudienceCompatible(
  source: Pick<OrchestratorInput, "actor" | "conversation">,
  target: Pick<OrchestratorInput, "actor" | "conversation">,
): void {
  const allowed = new Set([source.actor.id, ...source.conversation.audience.map((person) => person.id)]);
  if ([target.actor.id, ...target.conversation.audience.map((person) => person.id)].some((id) => !allowed.has(id)))
    throw new Error("the target audience includes people outside the sender's authorized audience");
}
