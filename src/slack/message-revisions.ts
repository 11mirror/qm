import { isReply, isUserMessage, messageTs, type Item, type NewItem } from "../sessions/items.ts";
import type { Lease, SessionStore } from "../sessions/session-store.ts";
import { parseSlackThreadRef, slackThreadRefCandidates } from "./message-gating.ts";
import type { IngestEvent, SurfaceCache } from "../surface-cache/types.ts";
import { isoFromTs, xmlAttrEscape, xmlEscape } from "../util/message-tag.ts";

export interface MessageRevisionPayload {
  action: "edited" | "deleted";
  ts: string;
  text?: string;
  name?: string;
  sourceRole?: "agent";
}

interface MessageRevisionSource {
  self?: boolean;
  ts: string;
  deleted?: boolean;
  text?: string;
}

export type RevisionSessions = Pick<
  SessionStore,
  "append" | "sessionsByThreadRefs" | "acquireLease" | "releaseLease" | "getItems"
>;

export function messageRevision(e: Pick<Item, "kind" | "body">): MessageRevisionPayload | null {
  if (e.kind !== "Retraction") return null;
  const p = e.body;
  if (p.action !== "edited" && p.action !== "deleted") return null;
  if (typeof p.ts !== "string" || !p.ts) return null;
  return p as unknown as MessageRevisionPayload;
}

export function renderMessageRevision(p: MessageRevisionPayload): string {
  const attrs = [
    `id="${xmlAttrEscape(p.ts)}"`,
    ...(p.sourceRole ? [`from="${p.sourceRole}"`] : []),
    ...(p.name?.trim() ? [`author="${xmlAttrEscape(p.name.trim())}"`] : []),
    ...(isoFromTs(p.ts) ? [`sent-at="${isoFromTs(p.ts)}"`] : []),
  ].join(" ");
  return p.action === "deleted"
    ? `<message-deleted ${attrs}>the author deleted this message</message-deleted>`
    : `<message-edited ${attrs}>${xmlEscape(p.text ?? "")}</message-edited>`;
}

function isRevisionEvent(e: IngestEvent): boolean {
  return Boolean(e.ts) && (e.deleted === true || e.editedAt !== undefined);
}

export function hasRevisionEvents(events: readonly IngestEvent[]): boolean {
  return events.some(isRevisionEvent);
}

interface OriginalMessage {
  text: string;
  name?: string;
  sourceRole?: "agent";
}

function findOriginal(items: readonly Item[], ts: string): OriginalMessage | null {
  let found: OriginalMessage | null = null;
  for (const e of items) {
    if (!isUserMessage(e) || messageTs(e) !== ts) continue;
    if (e.hidden === true) return null;
    const { name, sourceRole } = e.body;
    found = {
      text: e.text ?? "",
      ...(sourceRole === "agent" ? { sourceRole: "agent" as const } : {}),
      ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
    };
  }
  return found;
}

function revisionToRecord(entries: readonly Item[], source: MessageRevisionSource): MessageRevisionPayload | null {
  const original = findOriginal(entries, source.ts);
  if (!original || (source.self && original.sourceRole !== "agent")) return null;
  let last: MessageRevisionPayload | null = null;
  for (const e of entries) {
    const r = messageRevision(e);
    if (r && r.ts === source.ts) last = r;
  }
  const named = {
    ...(original.name ? { name: original.name } : {}),
    ...(original.sourceRole ? { sourceRole: original.sourceRole } : {}),
  };
  if (source.deleted) {
    if (last?.action === "deleted") return null;
    return { action: "deleted", ts: source.ts, ...named };
  }
  const text = String(source.text ?? "");
  const effective = last?.action === "deleted" ? null : (last?.text ?? original.text);
  if (!text.trim() || text === effective) return null;
  return { action: "edited", ts: source.ts, text, ...named };
}

async function recordRevision(
  sessions: Pick<SessionStore, "append">,
  lease: Lease,
  entries: readonly Item[],
  source: MessageRevisionSource,
): Promise<boolean> {
  const revision = revisionToRecord(entries, source);
  if (!revision) return false;
  const item: NewItem<"Retraction"> = { kind: "Retraction", body: { ...revision } };
  await sessions.append(lease, item);
  return true;
}

async function recordWhenIdle(
  sessions: RevisionSessions,
  session: { id: string },
  source: MessageRevisionSource,
): Promise<void> {
  if (!revisionToRecord(await sessions.getItems(session.id), source)) return;
  const { lease } = await sessions.acquireLease(session.id, "append");
  if (!lease) return;
  try {
    await recordRevision(sessions, lease, await sessions.getItems(session.id), source);
  } finally {
    await sessions.releaseLease(lease);
  }
}

export async function recordMessageRevisions(
  sessions: RevisionSessions,
  events: readonly IngestEvent[],
): Promise<void> {
  for (const event of events.filter(isRevisionEvent)) {
    const refs = await sessions.sessionsByThreadRefs(
      slackThreadRefCandidates(event.container, event.ts, event.sub ?? undefined),
    );
    for (const ref of refs) await recordWhenIdle(sessions, ref, event);
  }
}

export async function revisionAnchorAt(
  sessions: Pick<SessionStore, "getContextWindow">,
  sessionId: string,
): Promise<number | undefined> {
  const { items } = await sessions.getContextWindow(sessionId);
  return items.findLast((item) => isUserMessage(item) || isReply(item))?.createdAt;
}

export function slackTsToMs(ts: string | undefined): number | undefined {
  const seconds = Number(ts);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000) : undefined;
}

export async function reconcileMessageRevisions(opts: {
  sessions: Pick<SessionStore, "append" | "getItems">;
  surfaceCache: Pick<SurfaceCache, "revisedSince">;
  lease: Lease;
  session: { id: string; threadRef: string };
  anchorAt: number | undefined;
  fallbackSince: number;
  triggerTs?: string;
}): Promise<number> {
  const ref = parseSlackThreadRef(opts.session.threadRef);
  if (!ref) return 0;
  const since = Math.max(1, Math.min(opts.anchorAt ?? opts.fallbackSince, slackTsToMs(opts.triggerTs) ?? Infinity));
  const entries = await opts.sessions.getItems(opts.session.id);
  const ts = [
    ...new Set(
      entries
        .filter(isUserMessage)
        .map(messageTs)
        .filter((t): t is string => Boolean(t)),
    ),
  ];
  const revised = await opts.surfaceCache.revisedSince(ref.container, since, {
    ts,
    ...(ref.root ? { thread: ref.root } : {}),
  });
  if (!revised.length) return 0;
  let recorded = 0;
  for (const row of revised) {
    if (await recordRevision(opts.sessions, opts.lease, entries, row)) recorded++;
  }
  return recorded;
}
