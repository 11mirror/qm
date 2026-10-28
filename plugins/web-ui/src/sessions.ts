import { reportHandledError, reportSessionSwitch } from "./browser-errors";
import { cachedTranscript, clearTranscriptCache, dropTranscript, storeTranscript } from "./transcript-cache";
import { mountTranscript, reconcileCachedTranscript } from "./session-transcript";
import { html, nothing, render, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { ChevronDown, ChevronRight, Pin } from "lucide";
import {
  fetchSessionApprovals,
  fetchSessionChildren,
  fetchSessionPage,
  fetchSessionRow,
  fetchTranscript,
  slackThreadUrl,
  TAIL_TURNS,
  type TranscriptPage,
  type PendingApproval,
  type CoreProject,
  type CoreSession,
} from "./core-bridge";
import {
  activityOf,
  automationRunLabel,
  bumpActivity,
  sidebarSessions,
  groupProjectSessions,
  recencyGroup,
  recentProjectSeeds,
  mergeChildren,
  mergeFirstPage,
  surfaceOf,
  splitPinned,
  upsertSessions,
  withPendingSession,
  withoutUnsentPending,
  type RecentItem,
} from "./session-list";
import { tip } from "./tooltip";
import { errMessage, swallowAs } from "../../chassis/src/errors";
import { sheenLabel } from "./ui";
import { icon } from "./icons";
import { contextsState, ensureContexts, personalScopeId } from "./contexts";
import { groupDmLabel, groupDmText } from "./group-dm-label";
import { quietly } from "./shell-state";
import { appState, renderSidebarTop, syncDocumentTitle, syncUrlFromState } from "./shell";
import { closeSidebarOnNarrowView } from "./shell-sidebar";
import { allConversations, isLiveConversation, mainConversation } from "./conversations";
import type { Conversation } from "./conv-types";
import {
  startNewChatInCanvas,
  mountRestoredCanvas,
  focusedPaneConversation,
  notifyPanesChanged,
  drawCanvas,
  splitInterceptsOpen,
  splitState,
} from "./split";
import { bumpSessionPatchEpoch, resetSessionPatches, sessionPatchEpoch } from "./session-patches";
import { emptySelection, pruneSelection, type SessionSelection } from "./session-select";
import { markOpenSessionsRead, placeSessionMenu, refreshingTitleIds } from "./session-actions";
import {
  chatsPageShowing,
  detachDropZone,
  drawChatsPage,
  moreButton,
  recentItem,
  resetChatsPage,
  sessionRow,
} from "./session-rows";

const WEB_ONLY_KEY = "web-ui:web-only";

const freshSessionsState = () => ({
  list: [] as CoreSession[],
  loaded: false,
  openMenuId: null as string | null,
  renamingId: null as string | null,
  openingKey: null as string | null,
  hasArchived: false,
  collapsedProjectScopes: new Set<string>(),
  selection: emptySelection() as SessionSelection,
  selectColorOpen: false,
  renameDraft: "",
});

export const sessionsState = {
  ...freshSessionsState(),
  webOnly: quietly(() => localStorage.getItem(WEB_ONLY_KEY) === "1", false),
  keptUnreadId: null as string | null,
  notice: "",
};

export function visibleRowOrder(): string[] {
  const el = appState.listEl;
  if (!el) return [];
  return [...el.querySelectorAll<HTMLElement>("[data-session-id]")]
    .filter((row) => !row.closest("[hidden]"))
    .map((n) => n.dataset.sessionId ?? "")
    .filter(Boolean);
}

let sessionsLoading = false;
let sessionRefreshSeq = 0;
let recentContextsRequest: Promise<void> | null = null;
const RECENT_CONTEXT_MAX_AGE_MS = 30_000;
let showArchived = false;
export const SESSION_BATCH_SIZE = 50;
const freshPaging = () => ({
  activeCursor: null as string | null,
  activePaged: false,
  archivedCursor: null as string | null,
  archivedLoaded: false,
  loading: null as "active" | "archived" | null,
});
let paging = freshPaging();

export function resetSessionsState(): void {
  clearTranscriptCache();
  resetSessionPatches();
  Object.assign(sessionsState, freshSessionsState());
  listCurrent = false;
  listRequestedAt = 0;
  sessionsRefreshRunning = false;
  queuedSessionsRefresh = null;
  sessionRefreshSeq++;
  refreshingTitleIds.clear();
  showArchived = false;
  paging = freshPaging();
  resetChatsPage();
  recentContextsRequest = null;
}

function recentItemActivity(item: RecentItem): number {
  if (item.kind === "session") return activityOf(item.session);
  if (item.sessions[0]) return activityOf(item.sessions[0]);
  const context = contextsState.list.find((candidate) => candidate.scopeId === item.scopeId);
  return context?.lastActivityAt ?? context?.project?.createdAt ?? context?.project?.updatedAt ?? 0;
}

function recentItemsFor(sessions: readonly CoreSession[]): RecentItem[] {
  return groupProjectSessions(sessions, recentProjectSeeds(contextsState.list)).sort(
    (a, b) => recentItemActivity(b) - recentItemActivity(a),
  );
}

function loadRecentContexts(force = false): void {
  const fresh = contextsState.loaded && Date.now() - contextsState.loadedAt < RECENT_CONTEXT_MAX_AGE_MS;
  if (appState.currentView !== "chats" || recentContextsRequest || (!force && fresh)) return;
  const request = ensureContexts(force || !fresh).then(() => {
    if (appState.currentView === "chats") renderList();
  });
  recentContextsRequest = request;
  void request.finally(() => {
    if (recentContextsRequest === request) recentContextsRequest = null;
  });
}

export function sessionSlackUrl(s: Pick<CoreSession, "threadRef">): string | null {
  return slackThreadUrl(appState.me?.slackWorkspaceUrl ?? null, s.threadRef);
}

function projectName(scopeId: string): string | null {
  return projectOf(scopeId)?.name ?? null;
}

export function projectOf(scopeId: string): CoreProject | null {
  return contextsState.list.find((context) => context.scopeId === scopeId)?.project ?? null;
}

export function projectMenuKey(scopeId: string): string {
  return `project:${scopeId}`;
}

export function defaultSessionTitle(s: CoreSession): string {
  const automation = automationRunLabel(s);
  if (automation) return automation;
  const project = projectName(s.scopeId);
  if (project) return project;
  const surface = surfaceOf(s);
  if (surface === "web") return "Web chat";
  if (s.type === "channel") return channelLabel(s) ?? "Channel";
  if (s.type === "group") return groupDmText(s.channelName) ?? s.channelName?.trim() ?? "Group DM";
  return surface === "slack" ? "Direct message" : "Untitled chat";
}

export function channelLabel(s: CoreSession): string | null {
  return s.channelName && s.channelName.trim() ? `#${s.channelName.replace(/^#/, "")}` : null;
}

export function groupDmTitle(s: CoreSession): TemplateResult | string {
  if (s.title && s.title.trim()) return s.title;
  const label = s.type === "group" && !projectName(s.scopeId) ? groupDmLabel(s.channelName) : null;
  if (!label) return defaultSessionTitle(s);
  return html`<span class="group-dm-title" ${tip(label.text)}>
    <span class="group-dm-count">${label.count}</span>
    <span class="group-dm-names">${label.text}</span>
  </span>`;
}

export function sessionTitle(s: CoreSession): string {
  return s.title && s.title.trim() ? s.title : defaultSessionTitle(s);
}

function visibleSessions(): CoreSession[] {
  const sorted = sidebarSessions(sessionsState.list).sort((a, b) => activityOf(b) - activityOf(a));
  return sessionsState.webOnly ? sorted.filter((s) => surfaceOf(s) === "web") : sorted;
}

export function renderList(): void {
  markOpenSessionsRead();
  syncDocumentTitle();
  if (chatsPageShowing()) drawChatsPage();
  if (!appState.listEl) return;
  const visible = visibleSessions();
  const active = visible.filter((s) => !s.archived);
  const archived = visible.filter((s) => s.archived);
  const { pinned, rest } = splitPinned(active);
  const shownThreads = new Set(visible.map((session) => session.threadRef));
  const activeItems = recentItemsFor(rest);
  const archivedItems: RecentItem[] = archived.map((session) => ({
    kind: "session",
    session,
  }));
  armMidnightRefresh();
  render(
    html`
      ${detachDropZone()}
      ${
        pinned.length
          ? html`
              <div class="recents-group pinned-head">
                <span class="pinned-head-glyph">${icon(Pin, 11)}</span><span>Pinned</span>
              </div>
              <div class="pinned-children">
                ${repeat(
                  pinned,
                  (session) => session.threadRef,
                  (session) => sessionRow(session),
                )}
              </div>
            `
          : nothing
      }
      ${groupedRows(activeItems, shownThreads)}
      ${paging.activeCursor ? moreSessionsButton("active", "Show more conversations") : nothing}
      ${
        archived.length || sessionsState.hasArchived
          ? html`
              <button class="archived-toggle ${showArchived ? "open" : ""}" @click=${toggleShowArchived}>
                ${icon(showArchived ? ChevronDown : ChevronRight, 14)}
                ${sheenLabel("Archived", paging.loading === "archived" && !paging.archivedLoaded)}
              </button>
              ${
                showArchived
                  ? html`<div class="archived-children">
                      ${groupedRows(archivedItems, shownThreads)}
                      ${
                        paging.archivedCursor
                          ? moreSessionsButton("archived", "Show more archived conversations")
                          : nothing
                      }
                    </div>`
                  : nothing
              }
            `
          : nothing
      }
      ${sessionsState.notice ? html`<div class="empty" style="padding:16px">${sessionsState.notice}</div>` : ""}
      ${sessionsLoading ? html`<div class="empty" style="padding:16px">Loading conversations...</div>` : ""}
      ${
        !sessionsLoading && !sessionsState.notice && visible.length === 0
          ? html`<div class="empty" style="padding:16px">
              ${sessionsState.list.length ? "Slack conversations hidden." : "No conversations yet."}
            </div>`
          : ""
      }
    `,
    appState.listEl,
  );
  const beforePrune = sessionsState.selection.ids.size;
  sessionsState.selection = pruneSelection(sessionsState.selection, new Set(visibleRowOrder()));
  if (sessionsState.selection.ids.size !== beforePrune) renderSidebarTop();
  if (sessionsState.openMenuId) {
    requestAnimationFrame(() => placeSessionMenu(appState.listEl?.querySelector(".session-menu-popover") ?? undefined));
  }
  notifyPanesChanged();
}

function moreSessionsButton(kind: "active" | "archived", label: string): TemplateResult {
  return moreButton("archived-toggle", label, paging.loading === kind, () => void loadMoreSessions(kind));
}

export function startNewChat(
  scopeId: string | null = null,
  name: string | null = null,
  threadRef?: string,
): Conversation | null {
  closeSidebarOnNarrowView();
  if (scopeId) sessionsState.collapsedProjectScopes.delete(scopeId);
  const pane = startNewChatInCanvas(scopeId ?? undefined, threadRef);
  if (pane) return pane;
  const conv = mainConversation();
  if (threadRef) conv.mountContinuable(threadRef, null, scopeId, [], name);
  else addPendingSession(conv.newChat(scopeId ? { scopeId, name } : undefined), scopeId, name);
  return conv;
}

export function startNewChatInLastScope(): void {
  const mounted = (focusedPaneConversation() ?? mainConversation()).state;
  const scopeId = mounted.scopeId ?? visibleSessions().find((s) => !s.archived)?.scopeId ?? null;
  startNewChat(scopeId, scopeId ? projectName(scopeId) : null);
}

export const pendingForkThreads = new Set<string>();

export function addPendingSession(
  threadRef: string,
  scopeId: string | null,
  channelName: string | null,
  pendingFork = false,
): void {
  const scope = scopeId ?? personalScopeId();
  let type: CoreSession["type"] = "dm";
  if (scope?.startsWith("group:")) type = "group";
  else if (scope?.startsWith("channel:")) type = "channel";
  const pending: CoreSession = {
    id: "",
    type,
    scopeId: scope ?? "",
    threadRef,
    createdAt: Date.now(),
    title: pendingFork ? "Forking…" : null,
    channelName,
    archived: false,
    canContinue: true,
  };
  if (pendingFork) pendingForkThreads.add(threadRef);
  sessionsState.list = withPendingSession(sessionsState.list, pending);
  renderList();
}

export function replacePendingSession(threadRef: string, session: CoreSession): void {
  bumpSessionPatchEpoch();
  pendingForkThreads.delete(threadRef);
  sessionsState.list = withPendingSession(withoutUnsentPending(sessionsState.list, threadRef), session);
  renderList();
}

export function dropPendingSession(threadRef: string): void {
  pendingForkThreads.delete(threadRef);
  sessionsState.list = withoutUnsentPending(sessionsState.list, threadRef);
  renderList();
}

export function bumpSessionActivity(threadRef: string): void {
  sessionsState.list = bumpActivity(sessionsState.list, threadRef, Date.now());
  renderList();
}

function groupedRows(list: RecentItem[], shownThreads: ReadonlySet<string>): TemplateResult {
  const now = Date.now();
  const items: { key: string; tpl: TemplateResult }[] = [];
  let group: string | null = null;
  for (const item of list) {
    const key = item.kind === "session" ? item.session.threadRef : projectMenuKey(item.scopeId);
    if (
      item.kind === "session"
        ? !shownThreads.has(item.session.threadRef)
        : item.sessions.length > 0 &&
          sessionsState.openMenuId !== key &&
          sessionsState.renamingId !== key &&
          !item.sessions.some((session) => shownThreads.has(session.threadRef))
    )
      continue;
    const dateless = item.kind === "project" && item.sessions.length === 0;
    const g = recencyGroup(recentItemActivity(item), now);
    if (!dateless && g !== group) {
      group = g;
      items.push({ key: `group:${g}`, tpl: html`<div class="recents-group">${g}</div>` });
    }
    items.push({ key, tpl: recentItem(item, shownThreads) });
  }
  return html`${repeat(
    items,
    (it) => it.key,
    (it) => it.tpl,
  )}`;
}

let midnightTimer: number | undefined;
function armMidnightRefresh(): void {
  if (midnightTimer !== undefined) window.clearTimeout(midnightTimer);
  const d = new Date();
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  midnightTimer = window.setTimeout(
    () => {
      midnightTimer = undefined;
      renderList();
    },
    Math.max(1_000, next - Date.now()),
  );
}

function toggleShowArchived(): void {
  showArchived = !showArchived;
  if (showArchived && !paging.archivedLoaded) void loadMoreSessions("archived");
  renderList();
}

async function loadMoreSessions(kind: "active" | "archived"): Promise<void> {
  if (paging.loading) return;
  const archived = kind === "archived";
  const before = archived ? paging.archivedCursor : paging.activeCursor;
  if (!archived && !before) return;
  paging.loading = kind;
  const epoch = sessionPatchEpoch();
  renderList();
  try {
    const page = await fetchSessionPage({
      limit: SESSION_BATCH_SIZE,
      before,
      status: kind,
      ...(sessionsState.webOnly ? { surface: "web" } : {}),
    });
    if (epoch !== sessionPatchEpoch()) return;
    sessionsState.list = upsertSessions(sessionsState.list, page.sessions);
    Object.assign(
      paging,
      archived
        ? { archivedCursor: page.nextCursor, archivedLoaded: true }
        : { activeCursor: page.nextCursor, activePaged: true },
    );
  } catch (e) {
    sessionsState.notice = errMessage(e, "Failed to load conversations.");
  } finally {
    paging.loading = null;
    renderList();
  }
}

export function setWebOnly(webOnly: boolean): void {
  if (sessionsState.webOnly === webOnly) return;
  sessionsState.webOnly = webOnly;
  quietly(() => localStorage.setItem(WEB_ONLY_KEY, webOnly ? "1" : "0"), undefined);
  paging = { ...freshPaging(), loading: paging.loading };
  if (showArchived) void loadMoreSessions("archived");
  renderList();
  void refreshSessions({ silent: true });
}

export function revealSessionSurface(s: CoreSession): void {
  if (!sessionsState.webOnly || surfaceOf(s) === "web" || automationRunLabel(s)) return;
  setWebOnly(false);
}

let listSettled: (() => void) | null = null;
const listReady = new Promise<void>((resolve) => (listSettled = resolve));

export function sessionsReady(): Promise<void> {
  return sessionsState.loaded ? Promise.resolve() : listReady;
}

export function openConversationIds(): string[] {
  const opening = sessionsState.openingKey ? [sessionsState.openingKey] : [];
  return [...opening, ...allConversations().flatMap((conv) => (conv.state.sessionId ? [conv.state.sessionId] : []))];
}

type SessionsRefreshOptions = {
  showLoading?: boolean;
  silent?: boolean;
  refreshContexts?: boolean;
  patchEpoch?: number;
};
let latestSessionsRefresh: Promise<boolean> | null = null;
let queuedSessionsRefresh: SessionsRefreshOptions | null = null;
let sessionsRefreshRunning = false;
let listRequestedAt = 0;
let listDiscards = 0;
let listCurrent = false;
const LIST_STALL_MS = 10_000;

export function refreshSessionsOnOpen(): void {
  if (listCurrent) return;
  const joinable =
    sessionsRefreshRunning && Date.now() - listRequestedAt < LIST_STALL_MS ? latestSessionsRefresh : null;
  if (!joinable) {
    void refreshSessions({ silent: true });
    return;
  }
  const discards = listDiscards;
  void joinable.then(
    (applied) => {
      if (applied || listDiscards === discards || latestSessionsRefresh !== joinable) return;
      void refreshSessions({ silent: true });
    },
    () => void 0,
  );
}

export function refreshSessions(opts: SessionsRefreshOptions = {}): Promise<boolean> {
  if (sessionsRefreshRunning && Date.now() - listRequestedAt < LIST_STALL_MS && latestSessionsRefresh) {
    queuedSessionsRefresh = {
      ...opts,
      showLoading: queuedSessionsRefresh?.showLoading || opts.showLoading,
      refreshContexts: queuedSessionsRefresh?.refreshContexts || opts.refreshContexts,
      silent: queuedSessionsRefresh ? queuedSessionsRefresh.silent && opts.silent : opts.silent,
    };
    sessionRefreshSeq++;
    return latestSessionsRefresh;
  }
  sessionsRefreshRunning = true;
  const isLatest = (): boolean => latestSessionsRefresh === run;
  const run: Promise<boolean> = (async () => {
    try {
      let next: SessionsRefreshOptions | null = opts;
      let applied: boolean;
      do {
        queuedSessionsRefresh = null;
        applied = await runSessionsRefresh(next, () => (isLatest() ? null : latestSessionsRefresh));
        next = isLatest() ? queuedSessionsRefresh : null;
      } while (next);
      return applied;
    } finally {
      if (isLatest()) sessionsRefreshRunning = false;
    }
  })();
  latestSessionsRefresh = run;
  return run;
}

async function runSessionsRefresh(
  opts: SessionsRefreshOptions,
  newerRun: () => Promise<boolean> | null,
): Promise<boolean> {
  loadRecentContexts(opts.refreshContexts === true);
  const seq = ++sessionRefreshSeq;
  const patchEpoch = opts.patchEpoch ?? sessionPatchEpoch();
  if (opts.showLoading) {
    sessionsLoading = true;
    sessionsState.notice = "";
    renderList();
  }
  listRequestedAt = Date.now();
  try {
    const surface = sessionsState.webOnly ? "web" : undefined;
    const roots = [...new Set(openConversationIds())];
    const nested = roots.filter((id) => sessionsState.list.some((row) => row.id === id && row.parentSessionId));
    const [page, children, nestedRows] = await Promise.all([
      fetchSessionPage({ limit: SESSION_BATCH_SIZE, ...(surface ? { surface } : {}) }),
      Promise.all(
        roots.map(
          async (id) => [id, await fetchSessionChildren(id).catch(swallowAs("web-ui: load subagents", null))] as const,
        ),
      ),
      Promise.all(nested.map((id) => fetchSessionRow({ id }).catch(swallowAs("web-ui: refresh subagent", null)))),
    ]);
    if (seq !== sessionRefreshSeq) return sessionsState.loaded || ((await newerRun()) ?? false);
    if (patchEpoch !== sessionPatchEpoch()) {
      listDiscards++;
      return false;
    }
    const last = page.sessions[page.sessions.length - 1];
    let list = mergeFirstPage(
      sessionsState.list,
      page,
      {
        archived: false,
        ...(surface ? { surface } : {}),
        floor: page.nextCursor && last ? activityOf(last) : null,
      },
      openConversationIds(),
    );
    for (const [id, rows] of children) if (rows) list = mergeChildren(list, id, rows);
    list = upsertSessions(
      list,
      nestedRows.filter((row) => row !== null),
    );
    sessionsState.list = list;
    sessionsState.hasArchived = Boolean(page.hasArchived);
    if (!paging.activePaged) paging.activeCursor = page.nextCursor;
    sessionsState.loaded = true;
    listCurrent = true;
    sessionsState.notice = "";
    return true;
  } catch (e) {
    if (seq !== sessionRefreshSeq) return sessionsState.loaded || ((await newerRun()) ?? false);
    listCurrent = false;
    if (!opts.silent) sessionsState.notice = errMessage(e, "Failed to load conversations.");
    return false;
  } finally {
    if (seq === sessionRefreshSeq) {
      listSettled?.();
      listSettled = null;
      sessionsLoading = false;
      renderList();
      for (const conversation of allConversations()) conversation.redraw();
    }
  }
}

export async function loadScopeSessions(scopeId: string): Promise<void> {
  const page = await fetchSessionPage({ limit: SESSION_BATCH_SIZE, scope: scopeId });
  sessionsState.list = upsertSessions(sessionsState.list, page.sessions);
}

async function loadSessionNeighbors(s: CoreSession): Promise<void> {
  const parentId = s.parentSessionId;
  const needsParent = Boolean(parentId) && !sessionsState.list.some((row) => row.id === parentId);
  const [children, parent] = await Promise.all([
    fetchSessionChildren(s.id).catch(swallowAs("web-ui: load subagents", null)),
    needsParent && parentId
      ? fetchSessionRow({ id: parentId }).catch(swallowAs("web-ui: load parent chat", null))
      : Promise.resolve(null),
  ]);
  let list = sessionsState.list.some((row) => row.id === s.id)
    ? sessionsState.list
    : upsertSessions(sessionsState.list, [s]);
  if (children) list = mergeChildren(list, s.id, children);
  if (parent) list = upsertSessions(list, [parent]);
  if (list === sessionsState.list) return;
  sessionsState.list = list;
  renderList();
  for (const conversation of allConversations()) conversation.redraw();
}

export async function openSession(
  s: CoreSession,
  transcriptPrefetch?: Promise<TranscriptPage | null>,
  approvalsPrefetch?: Promise<{ approvals: PendingApproval[] } | null>,
): Promise<void> {
  if (pendingForkThreads.has(s.threadRef)) return;
  if (sessionsState.keptUnreadId !== s.id) sessionsState.keptUnreadId = null;
  if (appState.currentView !== "chats") {
    appState.currentView = "chats";
    appState.viewRenderSeq++;
    renderSidebarTop();
    renderList();
    if (splitState.active) drawCanvas();
    syncUrlFromState(s.id || null);
  }
  mountRestoredCanvas();
  const pane = splitInterceptsOpen(s);
  closeSidebarOnNarrowView();
  if (projectName(s.scopeId) && sessionsState.collapsedProjectScopes.delete(s.scopeId)) renderList();
  return openSessionInto(pane ?? mainConversation(), s, transcriptPrefetch, approvalsPrefetch, true);
}

export async function openSessionInto(
  conv: Conversation,
  s: CoreSession,
  transcriptPrefetch?: Promise<TranscriptPage | null>,
  approvalsPrefetch?: Promise<{ approvals: PendingApproval[] } | null>,
  tracked = conv === mainConversation(),
): Promise<void> {
  if (pendingForkThreads.has(s.threadRef)) return;
  if (sessionsState.keptUnreadId !== s.id) sessionsState.keptUnreadId = null;
  if (!s.id) {
    if (conv.state.threadRef !== s.threadRef) {
      conv.mountContinuable(s.threadRef, null, s.scopeId || null, [], s.channelName ?? null);
      renderList();
    }
    return;
  }
  if (s.id === conv.state.sessionId && !transcriptPrefetch) return;
  const started = Date.now();
  const reportPainted = (fetched: number, page: TranscriptPage | null, prefetched: boolean) => {
    if (document.visibilityState !== "visible") return;
    requestAnimationFrame(() =>
      setTimeout(() =>
        reportSessionSwitch(started, {
          fetchedMs: fetched,
          endMs: Date.now(),
          loaded: page !== null,
          prefetched,
          tracked,
          entries: page?.items.length ?? 0,
        }),
      ),
    );
  };

  refreshSessionsOnOpen();
  void loadSessionNeighbors(s);

  const cached = transcriptPrefetch ? undefined : cachedTranscript(s.id);
  if (cached) {
    if (!isLiveConversation(conv)) return;
    if (tracked) sessionsState.openingKey = null;
    conv.mountLoadingPane();
    const approvals = s.canContinue === true ? fetchSessionApprovals(s.id) : null;
    mountTranscript(conv, s, cached, approvals);
    renderList();
    reportPainted(Date.now(), cached, true);
    void reconcileCachedTranscript(conv, s, cached, approvals, conv.transcriptAnchor()).catch((error: unknown) =>
      reportHandledError("web:transcript_reconcile", error),
    );
    return;
  }
  const opening = s.id;
  if (tracked) {
    sessionsState.openingKey = opening;
    renderList();
  }
  if (!isLiveConversation(conv)) return;
  const isCurrent = conv.mountLoadingPane();

  const fetchPage = (): Promise<TranscriptPage | null> =>
    fetchTranscript(s.id, { tailTurns: TAIL_TURNS }).catch(swallowAs("web-ui: load session transcript", null));
  const continuable = s.canContinue === true;
  const approvals = continuable ? (approvalsPrefetch ?? fetchSessionApprovals(s.id)) : null;
  let prefetched = false;
  const transcriptRes = await (transcriptPrefetch
    ? transcriptPrefetch.then((r) => {
        prefetched = r !== null;
        return r ?? fetchPage();
      })
    : fetchPage());
  if (!isLiveConversation(conv) || !isCurrent()) return;
  const fetched = Date.now();

  if (tracked) {
    if (sessionsState.openingKey !== opening) return;
    sessionsState.openingKey = null;
  }
  if (!transcriptPrefetch && conv.state.sessionId === s.id) {
    renderList();
    return;
  }

  if (!transcriptRes) {
    dropTranscript(s.id);
    conv.mountLoadError(() => void openSessionInto(conv, s, undefined, undefined, tracked));
    renderList();
    reportPainted(fetched, null, prefetched);
    return;
  }

  storeTranscript(s.id, transcriptRes);
  mountTranscript(conv, s, transcriptRes, approvals);
  renderList();
  reportPainted(fetched, transcriptRes, prefetched);
}
