import { updateSentChat } from "./sent-mail";
import { api, ApiError, putUiState } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { onInboxItemEvent, onInboxResync } from "./conversations";
import { createInboxEventCoalescer, type InboxItemRef } from "./inbox-coalesce";
import { appState, can } from "./shell-state";
import {
  type LedgerItem,
  type InboxItem,
  type InboxFilter,
  inboxState,
  surfaces,
  toInboxItem,
  syncCrons,
  inboxPage,
  redrawInbox,
  notify,
} from "./inbox-model";

let pollTimer: number | null = null;

function anySurfaceVisible(): boolean {
  if (!can("inbox")) return false;
  if (appState.currentView === "inbox") return true;
  return [...surfaces].some((s) => s.pane && s.host.isConnected);
}

export function ensurePolling(): void {
  if (!can("inbox")) return;
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    if (document.visibilityState !== "visible" || !anySurfaceVisible()) return;
    void refreshInbox({ silent: true });
  }, 120_000);
}

export const feedWindows = new Map<string, { limit: number; nextCursor: string | null }>();

let refreshFollowUp = false;

let resyncMissedWhileHidden = false;

type Feed = {
  filter: InboxFilter;
  selected: typeof inboxState.selected;
  available: typeof inboxState.available;
  items: LedgerItem[];
  total: number;
  nextCursor: string | null;
};

function shownViewIds(): string[] {
  const shown = [...surfaces].filter((surface) => surface.host.isConnected).map((surface) => surface.viewId);
  if (appState.currentView === "inbox") shown.push(inboxPage.viewId);
  return [...new Set(shown)];
}

function applyFeedMetadata(feed: Feed): void {
  inboxState.selected = feed.selected;
  inboxState.available = feed.available;
  inboxState.total = feed.total;
  inboxState.filter = feed.filter;
}

async function refreshChangedItems(refs: InboxItemRef[]): Promise<void> {
  const [feed, ...results] = await Promise.all([
    api<Feed>(`/api/inbox?${new URLSearchParams({ filter: inboxState.filter })}`),
    ...refs.map((ref) => fetchItem({ id: ref.itemId, cronId: ref.cronId }, "").catch((error: unknown) => error)),
  ]);
  if ((feed.filter ?? "human") !== inboxState.filter) {
    refreshFollowUp = true;
    return;
  }
  applyFeedMetadata({ ...feed, filter: inboxState.filter });
  refs.forEach((ref, i) => {
    const result = results[i];
    if (result instanceof ApiError && result.status === 404)
      inboxState.items = inboxState.items.filter((item) => item.id !== ref.itemId);
    else if (result instanceof Error) refreshFollowUp = true;
    else if (result && !(result as InboxItem).sentChat) upsertItem(result as InboxItem);
  });
}

export async function refreshInbox(
  opts: { silent?: boolean; ifStaleMs?: number; more?: boolean; viewId?: string; changed?: InboxItemRef[] } = {},
): Promise<void> {
  if (!can("inbox")) return;
  if (inboxState.loading) {
    if (opts.ifStaleMs === undefined || resyncMissedWhileHidden) refreshFollowUp = true;
    return;
  }
  if (opts.ifStaleMs !== undefined && !resyncMissedWhileHidden && Date.now() - inboxState.fetchedAt < opts.ifStaleMs)
    return;
  resyncMissedWhileHidden = false;
  inboxState.loading = true;
  if (!opts.silent || inboxState.loaded) redrawInbox();
  try {
    if (opts.changed && inboxState.loaded) await refreshChangedItems(opts.changed);
    else await refreshFeeds(opts);
  } catch (e) {
    inboxState.error = errMessage(e);
  } finally {
    inboxState.loading = false;
    redrawInbox();
  }
  if (refreshFollowUp) {
    refreshFollowUp = false;
    void refreshInbox({ silent: true });
  }
}

async function refreshFeeds(opts: { more?: boolean; viewId?: string }): Promise<void> {
  const shown = shownViewIds();
  const moreView = opts.viewId ?? inboxPage.viewId;
  const windows = new Map<string, { limit: number; nextCursor: string | null }>();
  let refreshFilter: InboxFilter | undefined;
  let metadata: Feed | undefined;
  const fetchFeed = async (qs: URLSearchParams): Promise<Feed> => {
    if (refreshFilter) qs.set("filter", refreshFilter);
    const feed = await api<Feed>(`/api/inbox?${qs}`);
    const filter = feed.filter ?? "human";
    if (refreshFilter && filter !== refreshFilter) throw new Error("Inbox filter changed during refresh. Try again.");
    refreshFilter = filter;
    return feed;
  };
  const fetchView = async (viewId: string): Promise<LedgerItem[]> => {
    const handled = viewId.startsWith("handled:");
    const filterView = handled ? viewId.slice(8) : viewId;
    const limit = (feedWindows.get(viewId)?.limit ?? 40) + (opts.more && moreView === viewId ? 40 : 0);
    const qs = new URLSearchParams();
    if (handled) qs.set("view", "handled");
    else if (filterView === "sent") qs.set("view", "sent");
    if (filterView !== "all" && filterView !== "sent")
      qs.set(
        "cronId",
        (metadata?.selected ?? inboxState.selected).find((cron) => cron.source === filterView)?.id ?? filterView,
      );
    let found = await fetchFeed(qs);
    while (found.nextCursor && found.items.length < limit) {
      qs.set("cursor", found.nextCursor);
      const page = await fetchFeed(qs);
      found = { ...page, items: [...found.items, ...page.items] };
    }
    windows.set(viewId, { limit, nextCursor: found.nextCursor });
    metadata = found;
    return found.items;
  };
  const first = await fetchView("all");
  const rest = await Promise.all(
    [...shown.filter((id) => id !== "all"), ...shown.filter((id) => id !== "sent").map((id) => `handled:${id}`)].map(
      fetchView,
    ),
  );
  if (!metadata) return;
  const combined = new Map<string, InboxItem>();
  for (const entry of [first, ...rest].flat()) combined.set(entry.id, toInboxItem(entry));
  feedWindows.clear();
  for (const [view, window] of windows) feedWindows.set(view, window);
  applyFeedMetadata({ ...metadata, filter: refreshFilter! });
  const next = [...combined.values()];
  const openId = inboxPage.surface?.selectedId;
  const detail = openId ? inboxState.items.find((item) => item.id === openId && item.detailLoaded) : undefined;
  inboxState.items = next;
  if (detail && inboxState.selected.some((cron) => cron.id === detail.cronId)) {
    upsertItem(detail);
    void loadDetail(detail.id, detail.cronId);
  }
  if (openId && !detail) {
    const entry = inboxState.items.find((item) => item.id === openId);
    if (entry) void loadDetail(entry.id, entry.cronId);
  }
  inboxState.loaded = true;
  inboxState.error = null;
  inboxState.fetchedAt = Date.now();
}

export async function loadDetail(itemId: string, cronId: string): Promise<void> {
  try {
    const detail = await fetchItem({ id: itemId, cronId }, "");
    if (!inboxState.selected.some((cron) => cron.id === cronId)) return;
    upsertItem(detail);
    redrawInbox();
  } catch (error) {
    if (!inboxState.items.find((item) => item.id === itemId)?.detailLoaded)
      for (const surface of [...surfaces, inboxPage.surface])
        if (surface?.selectedId === itemId) surface.selectedId = null;
    if (error instanceof ApiError && error.status === 404)
      inboxState.items = inboxState.items.filter((item) => item.id !== itemId);
    notify(errMessage(error, "Could not load item"));
  }
}

async function busyAction(
  flag: "filterBusy" | "selectionBusy" | "syncBusy",
  run: () => Promise<void>,
  failure: (error: unknown) => string,
): Promise<void> {
  if (inboxState[flag]) return;
  inboxState[flag] = true;
  redrawInbox();
  try {
    await run();
  } catch (error) {
    notify(failure(error));
  } finally {
    inboxState[flag] = false;
    redrawInbox();
  }
}

export async function selectInboxFilter(filter: InboxFilter): Promise<void> {
  if (inboxState.loading || inboxState.filter === filter) return;
  await busyAction(
    "filterBusy",
    async () => {
      const saved = await putUiState("inbox-filter", filter, Date.now());
      feedWindows.clear();
      await refreshInbox();
      if (inboxState.error) notify(inboxState.error);
      else if (!saved.ok)
        notify("A newer inbox filter was already saved. Your selection wasn't saved. Please try again.");
    },
    (error) => errMessage(error, "Could not save inbox filter"),
  );
}

export async function toggleSelection(id: string): Promise<void> {
  const ids = inboxState.selected.map((cron) => cron.id);
  await busyAction(
    "selectionBusy",
    async () => {
      await api("/api/inbox/selection", {
        method: "POST",
        body: JSON.stringify({ cronIds: ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id] }),
      });
      if (inboxPage.viewId === id) inboxPage.viewId = "all";
      await refreshInbox();
    },
    (error) => errMessage(error, "Could not update Inbox"),
  );
}

let realtimeWired = false;

const enqueueRealtimeEvent = createInboxEventCoalescer(
  250,
  (changed) => void refreshWhenVisible(changed),
  (fn, ms) => void window.setTimeout(fn, ms),
);

async function refreshWhenVisible(changed?: InboxItemRef[]): Promise<void> {
  if (document.visibilityState !== "visible" || !anySurfaceVisible()) {
    resyncMissedWhileHidden = true;
    return;
  }
  await refreshInbox({ silent: true, changed });
}

export function upsertItem(next: InboxItem): void {
  if (inboxState.items.some((i) => i.id === next.id)) replaceItem(next);
  else inboxState.items = [next, ...inboxState.items];
}

export function ensureRealtime(): void {
  if (realtimeWired) return;
  realtimeWired = true;
  onInboxItemEvent((event) => {
    if (!can("inbox")) return;
    if (inboxState.loaded && !inboxState.selected.some((cron) => cron.id === event.cronId)) return;
    enqueueRealtimeEvent({ cronId: event.cronId, itemId: event.itemId });
  });
  onInboxResync(() => {
    if (!can("inbox")) return;
    void refreshWhenVisible();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !anySurfaceVisible()) return;
    void refreshInbox({ ifStaleMs: 30_000, silent: true });
  });
}

export function replaceItem(next: InboxItem): void {
  inboxState.items = inboxState.items.map((i) => (i.id === next.id ? next : i));
}

export function itemPath(cronId: string, itemId: string, leaf = ""): string {
  return `/api/crons/${encodeURIComponent(cronId)}/items/${encodeURIComponent(itemId)}${leaf}`;
}

const sourceRefreshAt = new Map<string, number>();

export function ensureItemSource(item: InboxItem): void {
  if (!item.slack || Date.now() - (sourceRefreshAt.get(item.id) ?? 0) < 60_000) return;
  for (const [id, at] of sourceRefreshAt) if (Date.now() - at >= 60_000) sourceRefreshAt.delete(id);
  sourceRefreshAt.set(item.id, Date.now());
  void refetchItem(item, true);
}

export async function refetchItem(item: InboxItem, refreshSource = false): Promise<void> {
  try {
    replaceItem(await fetchItem(item, refreshSource ? "?refreshSource=1" : ""));
    redrawInbox();
  } catch (error) {
    const current = inboxState.items.find((entry) => entry.id === item.id);
    if (current) replaceItem({ ...current, sourceRefreshError: `Couldn't refresh this item: ${errMessage(error)}` });
    redrawInbox();
  }
}

export async function fetchItem(
  item: Pick<InboxItem, "id" | "cronId">,
  leaf: string,
  body?: Record<string, unknown>,
): Promise<InboxItem> {
  const { item: next } = await api<{ item: LedgerItem }>(
    itemPath(item.cronId, item.id, leaf),
    body ? { method: "POST", body: JSON.stringify(body) } : undefined,
  );
  updateSentChat(next);
  return { ...toInboxItem(next), detailLoaded: true };
}

export function postAction(item: InboxItem, kind: string, args?: Record<string, unknown>): Promise<InboxItem> {
  return fetchItem(item, "/action", { kind, ...(args ? { args } : {}) });
}

export async function setUpSync(cronId: string): Promise<void> {
  await busyAction(
    "syncBusy",
    async () => {
      await api("/api/inbox/sync-cron", { method: "POST", body: JSON.stringify({ enabled: true, cronId }) });
      notify("Sync is on. First pass runs within 15 minutes.");
      await refreshInbox({ silent: true });
    },
    (e) => `Couldn't set up sync: ${errMessage(e)}`,
  );
}

export async function syncNow(viewId: string): Promise<void> {
  const crons = syncCrons(viewId).flatMap((cron) => (cron.syncCron ? [cron.syncCron] : []));
  if (!crons.length) return;
  await busyAction(
    "syncBusy",
    async () => {
      for (const cron of crons)
        await api(`/api/crons/${encodeURIComponent(cron.id)}/run`, { method: "POST", body: "{}" });
      notify("Sync kicked off. New items appear as the agent finishes drafting.");
    },
    (e) => `Couldn't start a sync: ${errMessage(e)}`,
  );
}
