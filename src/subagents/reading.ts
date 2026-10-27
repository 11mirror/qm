import type { SessionMessage } from "../sessions/session-mailbox.ts";
import { sleep } from "../util/async.ts";
import { isReply, proseText } from "../sessions/items.ts";
import type { Item } from "../sessions/items.ts";
import { itemVisibleToAll, snippet, assertAudienceCompatible } from "./audience.ts";
import type { SessionReadInput, SessionChildSummary, SessionReadResult } from "./types.ts";
import type { TurnContext } from "./turn-context.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import type { Session } from "../types.ts";

const READ_DEFAULT_LIMIT = 30;
const READ_DEFAULT_MAX_CHARS = 4_000;
const READ_MAX_CHARS_CEILING = 20_000;
const LAST_SAID_SCAN = 40;
/** Messages handed to the agent per receive call; the rest stay pending for the next call. */
const RECEIVE_BATCH_MAX = 4;

function itemText(item: Item): string | undefined {
  const text = proseText(item);
  if (text?.trim()) return text;
  if (item.tool) return `[${item.tool}]`;
  return undefined;
}

function lastAssistantText(items: readonly Item[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const e = items[i]!;
    if (e.kind === "Stop") {
      const before = items[i - 1];
      const partial = before && isReply(before) ? itemText(before) : "";
      const reason = e.body.reason;
      return partial || `[system] Subagent stopped${typeof reason === "string" ? ` ${reason}` : ""}. No reply.`;
    }
    if (e.kind !== "AgentMessage" || e.variant === "files_delivered") continue;
    const text = itemText(e);
    if (text) return text;
  }
  return undefined;
}

export interface MailReader {
  sessions: Pick<SessionStore, "getForParticipant" | "visibleItems">;
  authorize?: (session: Session, actorId: string) => Promise<boolean>;
}

export async function visibleMail(
  deps: MailReader,
  scopeId: string,
  caller: Pick<OrchestratorInput, "actor" | "conversation">,
  messages: readonly SessionMessage[],
  limit: number,
): Promise<SessionMessage[]> {
  const visible: SessionMessage[] = [];
  for (const message of messages) {
    const sender = await deps.sessions.getForParticipant(message.senderId, caller.actor.id);
    if (!sender || sender.scopeId !== scopeId) continue;
    if (deps.authorize && !(await deps.authorize(sender, caller.actor.id))) continue;
    try {
      assertAudienceCompatible(
        { actor: message.actor, conversation: { ...caller.conversation, audience: message.audience } },
        caller,
      );
    } catch {
      continue;
    }
    if (
      message.sourceEntrySeq !== undefined &&
      !(await itemVisibleToAll(deps.sessions, sender.id, message.sourceEntrySeq, [
        caller.actor.id,
        ...caller.conversation.audience.map((person) => person.id),
      ]))
    )
      continue;
    visible.push(message);
    if (visible.length >= limit) break;
  }
  return visible;
}

export async function receiveMessages(ctx: TurnContext, timeoutMs = 0): Promise<SessionMessage[]> {
  const { deps, binding, currentCaller } = ctx;
  const deadline = Date.now() + Math.min(60_000, Math.max(0, timeoutMs));
  do {
    binding.request.cancel?.throwIfAborted();
    const caller = await currentCaller();
    const messages = await deps.mailbox.pending(binding.session.id);
    const visible = await visibleMail(deps, binding.scopeId, caller, messages, RECEIVE_BATCH_MAX);
    if (visible.length || Date.now() >= deadline) return visible;
    await sleep(Math.min(250, deadline - Date.now()));
  } while (Date.now() <= deadline);
  return [];
}

export async function acknowledgeMessages(ctx: TurnContext, ids: string[]): Promise<void> {
  const { deps, binding } = ctx;
  await deps.mailbox?.acknowledge(binding.session.id, ids);
}

export async function readSession(ctx: TurnContext, input: SessionReadInput): Promise<SessionReadResult> {
  const { deps, binding, resolveTarget, peerRefusal, statusOf, visibleTitle, visibleHistory, currentCaller } = ctx;
  await currentCaller();
  if (!input.target?.trim()) {
    const children = await deps.sessions.childrenOf(binding.session.id);
    const summaries: SessionChildSummary[] = [];
    for (const child of children) {
      if (
        child.scopeId !== binding.scopeId ||
        !(await deps.sessions.getForParticipant(child.id, binding.request.actor.id))
      )
        continue;
      const entries = await visibleHistory(child, LAST_SAID_SCAN);
      const said = lastAssistantText(entries);
      summaries.push({
        sessionId: child.id,
        title: visibleTitle(child),
        status: await statusOf(child),
        ...(said ? { lastSaid: snippet(said, 200) } : {}),
      });
    }
    return { ok: true, mode: "children", children: summaries };
  }
  const target = await resolveTarget(input.target);
  if (!target)
    return {
      ok: false,
      message: `no session matches "${input.target}" — use a sessionId from open, read, or list.`,
    };
  const refusal = input.peer ? peerRefusal(target) : null;
  if (refusal) return { ok: false, message: refusal };
  if (target.scopeId !== binding.scopeId)
    return { ok: false, message: "that session lives in a different context and cannot be read from here." };
  const limit = Math.min(Math.max(1, input.limit ?? READ_DEFAULT_LIMIT), 200);
  const maxChars = Math.min(Math.max(200, input.maxChars ?? READ_DEFAULT_MAX_CHARS), READ_MAX_CHARS_CEILING);
  if (!(await deps.sessions.getForParticipant(target.id, binding.request.actor.id)))
    return { ok: false, message: "you are not a participant in that session." };
  const entries = await visibleHistory(target, limit);
  const lines: string[] = [];
  for (const entry of entries) {
    const text = itemText(entry);
    if (!text) continue;
    lines.push(`${entry.kind}#${entry.seq} ${snippet(text, 300)}`);
  }
  let rendered = lines.join("\n");
  if (rendered.length > maxChars) rendered = `…${rendered.slice(rendered.length - maxChars)}`;
  return {
    ok: true,
    mode: "transcript",
    sessionId: target.id,
    title: visibleTitle(target),
    status: await statusOf(target),
    rendered: rendered || "[no readable entries yet]",
  };
}
