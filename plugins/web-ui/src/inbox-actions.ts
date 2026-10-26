import { selectedSentChat } from "./sent-mail";
import type { ComposerSubmission } from "./composer";
import { ApiError } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { type InboxDraft, type InboxItem, inboxState, toInboxItem, redrawInbox, notify } from "./inbox-model";
import { upsertItem, replaceItem, refetchItem, fetchItem, postAction } from "./inbox-feed";
import { showArchiveToast } from "./inbox-toast";

export const draftConflicts = new Map<string, number>();

export const draftEdits = new Map<string, InboxDraft & { basedOnAt?: number }>();

export const acting = new Set<string>();

export const chatting = new Set<string>();

export function inboxItemById(id: string): InboxItem | undefined {
  const sent = selectedSentChat(id);
  return sent?.id === id ? toInboxItem(sent) : inboxState.items.find((item) => item.id === id);
}

export async function continueSentReply(item: InboxItem): Promise<void> {
  try {
    replaceItem(await postAction(item, "reply"));
    redrawInbox();
  } catch (error) {
    notify(`Couldn't start a reply: ${errMessage(error)}`);
  }
}

export function draftSubject(item: InboxItem, draft: InboxDraft): string {
  if (draft.subject !== undefined) return draft.subject;
  return item.gmail?.subject ? `Re: ${item.gmail.subject.replace(/^re:\s*/i, "")}` : "";
}

export function effectiveDraft(item: InboxItem): InboxDraft {
  const edited = draftEdits.get(item.id);
  if (edited) {
    const { basedOnAt: _basedOnAt, ...draft } = edited;
    return draft;
  }
  return {
    body: "",
    ...(item.source === "gmail"
      ? { to: item.gmail?.to ?? [], cc: item.gmail?.cc ?? [], subject: item.gmail?.subject }
      : {}),
    ...item.draft,
  };
}

function sameDraft(a: InboxDraft | undefined, b: InboxDraft): boolean {
  return Boolean(
    a &&
    a.body === b.body &&
    (a.subject ?? "") === (b.subject ?? "") &&
    (a.to ?? []).join(",") === (b.to ?? []).join(",") &&
    (a.cc ?? []).join(",") === (b.cc ?? []).join(","),
  );
}

export function editDraft(item: InboxItem, patch: Partial<InboxDraft>): void {
  const basedOnAt = draftEdits.get(item.id)?.basedOnAt ?? item.draftAt;
  draftEdits.set(item.id, { ...effectiveDraft(item), ...patch, ...(basedOnAt !== undefined ? { basedOnAt } : {}) });
}

function isDraftConflict(e: unknown): boolean {
  return e instanceof ApiError && (e.body as { error?: unknown } | null)?.error === "draft_changed";
}

async function explainDraftConflict(item: InboxItem, edited: boolean): Promise<void> {
  draftConflicts.set(item.id, (draftConflicts.get(item.id) ?? 0) + 1);
  await refetchItem(item);
  const fresh = inboxItemById(item.id);
  const overlay = draftEdits.get(item.id);
  if (overlay && fresh?.draftAt !== undefined) draftEdits.set(item.id, { ...overlay, basedOnAt: fresh.draftAt });
  const preview = (fresh?.draft?.body ?? "").trim().slice(0, 140);
  notify(
    edited
      ? `The agent redrafted this reply while you were editing. Your text is kept in the box. New draft: "${preview}". Send again to use yours.`
      : "The draft changed while you were looking. Review the new draft, then send again.",
  );
}

export function addressHeaderList(raw: string): string[] {
  return raw.trim() ? [raw.trim()] : [];
}

const persistQueue = new Map<string, Promise<void>>();

const persistWaiting = new Set<string>();

function enqueueForItem(itemId: string, task: () => Promise<void>): Promise<void> {
  const queued = (persistQueue.get(itemId) ?? Promise.resolve()).then(task);
  persistQueue.set(itemId, queued);
  const clear = (): void => {
    if (persistQueue.get(itemId) === queued) persistQueue.delete(itemId);
  };
  void queued.then(clear, clear);
  return queued;
}

export function persistDraft(item: InboxItem): Promise<void> {
  if (persistWaiting.has(item.id)) return persistQueue.get(item.id) ?? Promise.resolve();
  persistWaiting.add(item.id);
  return enqueueForItem(item.id, () => {
    persistWaiting.delete(item.id);
    return persistDraftNow(item.id);
  });
}

async function persistDraftNow(itemId: string): Promise<void> {
  const item = inboxItemById(itemId);
  if (!item) return;
  const edited = draftEdits.get(item.id);
  if (!edited) return;
  const saved = item.draft;
  if (sameDraft(saved, edited)) {
    draftEdits.delete(item.id);
    return;
  }
  const { basedOnAt, ...proposal } = edited;
  try {
    const next = await postAction(item, "edit", {
      proposal,
      ...(basedOnAt !== undefined ? { expectedProposalAt: basedOnAt } : {}),
    });
    const newer = draftEdits.get(item.id);
    if (newer === edited) draftEdits.delete(item.id);
    else if (newer && next.draftAt !== undefined) draftEdits.set(item.id, { ...newer, basedOnAt: next.draftAt });
    replaceItem(next);
    redrawInbox();
  } catch (e) {
    if (isDraftConflict(e)) return explainDraftConflict(item, true);
    notify(`Couldn't save the draft: ${errMessage(e)}`);
  }
}

export async function setItemStatus(item: InboxItem, status: "open" | "dismissed"): Promise<boolean> {
  if (acting.has(item.id)) return false;
  acting.add(item.id);
  redrawInbox();
  try {
    upsertItem(await postAction(item, status === "dismissed" ? "dismiss" : "reopen"));
    if (status === "dismissed") showArchiveToast(() => setItemStatus(item, "open"));
    return true;
  } catch (e) {
    notify(`Couldn't update the item: ${errMessage(e)}`);
    return false;
  } finally {
    acting.delete(item.id);
    redrawInbox();
  }
}

export async function askAgent(
  item: InboxItem,
  message: string,
  options?: ComposerSubmission,
  snapshot = { draft: effectiveDraft(item), conflictRevision: draftConflicts.get(item.id) ?? 0 },
): Promise<boolean> {
  const text = message.trim();
  if ((!text && !options?.attachments?.length) || chatting.has(item.id)) return false;
  const { draft, conflictRevision } = snapshot;
  chatting.add(item.id);
  redrawInbox();
  try {
    await enqueueForItem(item.id, async () => {
      if ((draftConflicts.get(item.id) ?? 0) !== conflictRevision)
        throw new Error("The draft changed. Review it before sending again.");
      await persistDraftNow(item.id);
      if (draftEdits.has(item.id)) throw new Error("Save the draft before continuing. Your edits have been kept.");
      const current = inboxItemById(item.id) ?? item;
      if (!sameDraft(effectiveDraft(current), draft)) {
        throw new Error("The draft changed. Review it before continuing.");
      }
      replaceItem(
        await fetchItem(item, "/followup", {
          message: text,
          ...options,
          ...(current.draftAt !== undefined ? { expectedProposalAt: current.draftAt } : {}),
        }),
      );
    });
    return true;
  } catch (e) {
    if (isDraftConflict(e)) await refetchItem(item);
    notify(`The agent couldn't answer: ${errMessage(e)}`);
    return false;
  } finally {
    chatting.delete(item.id);
    redrawInbox();
  }
}
