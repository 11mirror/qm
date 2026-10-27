import type { SessionMessage } from "../sessions/session-mailbox.ts";
import { sleep } from "../util/async.ts";
import { isReply, proseText } from "../sessions/items.ts";
import type { Item } from "../sessions/items.ts";
import type { Session } from "../types.ts";
import { contextSummary } from "../sessions/session-store.ts";
import { itemVisibleToAll, assertAudienceCompatible } from "./audience.ts";
import type { SessionReadInput, SessionChildSummary, SessionReadResult } from "./types.ts";
import type { TurnContext } from "./turn-context.ts";
import { sessionTreeRoot } from "./tree.ts";

const READ_DEFAULT_LIMIT = 30;
const READ_DEFAULT_MAX_CHARS = 4_000;

function itemText(item: Item): string | undefined {
  const text = proseText(item);
  if (text?.trim()) return text;
  if (item.tool) return `[${item.tool}]`;
  return undefined;
}

async function* newestFirst(ctx: TurnContext, target: Session): AsyncGenerator<Item[]> {
  let beforeSeq: number | undefined;
  for (let size = 1; ; size *= 2) {
    const page = await ctx.visibleHistory(target, size, beforeSeq);
    if (!page.length) return;
    yield page;
    beforeSeq = page[0]!.seq;
  }
}

function stoppedNote(stop: Item, before: Item | undefined): string {
  const partial = before && isReply(before) ? itemText(before) : "";
  const reason = stop.body.reason;
  return partial || `[system] Subagent stopped${typeof reason === "string" ? ` ${reason}` : ""}. No reply.`;
}

async function lastAssistantText(ctx: TurnContext, child: Session): Promise<string | undefined> {
  let newer: Item | undefined;
  for await (const page of newestFirst(ctx, child)) {
    for (let i = page.length - 1; i >= 0; i--) {
      const e = page[i]!;
      if (newer?.kind === "Stop") return stoppedNote(newer, e);
      if (contextSummary(e)) return undefined;
      newer = e;
      if (e.kind !== "AgentMessage" || e.variant === "files_delivered") continue;
      const text = itemText(e);
      if (text) return text;
    }
  }
  return newer?.kind === "Stop" ? stoppedNote(newer, undefined) : undefined;
}

async function readableLines(ctx: TurnContext, target: Session, limit: number, maxChars: number): Promise<string[]> {
  const lines: string[] = [];
  let entries = 0;
  let chars = 0;
  for await (const page of newestFirst(ctx, target)) {
    for (let i = page.length - 1; i >= 0 && entries < limit && chars <= maxChars; i--) {
      const entry = page[i]!;
      entries++;
      const text = itemText(entry);
      if (!text) continue;
      const line = `${entry.kind}#${entry.seq} ${text}`;
      lines.unshift(line);
      chars += line.length + 1;
    }
    if (entries >= limit || chars > maxChars) break;
  }
  return lines;
}

async function othersWorkingInTree(ctx: TurnContext): Promise<boolean> {
  const { deps, binding } = ctx;
  const root = await sessionTreeRoot(deps.sessions, binding.session);
  const tree = [root, ...(await deps.sessions.descendantsOf([root.id]))].filter(
    (session) => session.scopeId === binding.scopeId,
  );
  const inFlight = await deps.runs.inFlightForThreads(tree.map((session) => session.threadRef));
  return inFlight.some((run) => run.id !== binding.request.runId);
}

export async function receiveMessages(
  ctx: TurnContext,
  timeoutMs = 0,
  signal?: AbortSignal,
): Promise<SessionMessage[]> {
  const { deps, binding, currentCaller } = ctx;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    binding.request.cancel?.throwIfAborted();
    if (signal?.aborted) return [];
    const caller = await currentCaller();
    const messages = await deps.mailbox.pending(binding.session.id);
    const visible: SessionMessage[] = [];
    for (const message of messages) {
      const sender = await deps.sessions.getForParticipant(message.senderId, caller.actor.id);
      if (!sender || sender.scopeId !== binding.scopeId) continue;
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
    }
    if (visible.length || Date.now() >= deadline || !(await othersWorkingInTree(ctx))) return visible;
    await sleep(Math.min(250, deadline - Date.now()));
  } while (Date.now() <= deadline);
  return [];
}

export async function acknowledgeMessages(ctx: TurnContext, ids: string[]): Promise<void> {
  const { deps, binding } = ctx;
  await deps.mailbox?.acknowledge(binding.session.id, ids);
}

export async function readSession(ctx: TurnContext, input: SessionReadInput): Promise<SessionReadResult> {
  const { deps, binding, resolveTarget, peerRefusal, statusOf, visibleTitle, currentCaller } = ctx;
  await currentCaller();
  if (!input.target?.trim()) {
    const children = await deps.sessions.childrenOf(binding.session.id);
    const summaries = await Promise.all(
      children.map(async (child): Promise<SessionChildSummary | null> => {
        if (
          child.scopeId !== binding.scopeId ||
          !(await deps.sessions.getForParticipant(child.id, binding.request.actor.id))
        )
          return null;
        const [said, status] = await Promise.all([lastAssistantText(ctx, child), statusOf(child)]);
        return { sessionId: child.id, title: visibleTitle(child), status, ...(said ? { lastSaid: said } : {}) };
      }),
    );
    return { ok: true, mode: "children", children: summaries.filter((summary) => summary !== null) };
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
  const limit = Math.max(1, input.limit ?? READ_DEFAULT_LIMIT);
  const maxChars = Math.max(1, input.maxChars ?? READ_DEFAULT_MAX_CHARS);
  if (!(await deps.sessions.getForParticipant(target.id, binding.request.actor.id)))
    return { ok: false, message: "you are not a participant in that session." };
  let rendered = (await readableLines(ctx, target, limit, maxChars)).join("\n");
  if (rendered.length > maxChars)
    rendered = `…[${rendered.length - maxChars} earlier chars not shown; raise maxChars or lower limit to see them]\n${rendered.slice(rendered.length - maxChars)}`;
  return {
    ok: true,
    mode: "transcript",
    sessionId: target.id,
    title: visibleTitle(target),
    status: await statusOf(target),
    rendered: rendered || "[no readable entries yet]",
  };
}
