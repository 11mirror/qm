import { reportHandledError } from "./browser-errors";
import { preserveTranscriptScroll } from "./transcript-viewport";
import { swallow, swallowAs } from "../../chassis/src/errors.ts";
import { html, nothing, render } from "lit";
import {
  createDockview,
  type DockviewApi,
  type DockviewWillDropEvent,
  type IDockviewGroupPanel,
  type IDockviewPanel,
  type SerializedDockview,
} from "dockview-core";
import {
  dropAddsTile,
  layoutNeedsSessionList,
  MAX_PANES,
  MAX_TILES,
  serializedTileCount,
  type SplitEdge,
} from "./split-layout";
import { paneKindByKey, paneKindEntry } from "./pane-kinds";
import { focusPaneComposer, preservingFocus } from "./pane-focus";
import { appState } from "./shell-state";
import { renderSidebarTop, switchView, syncDocumentTitle, syncUrlFromState } from "./shell";
import { ensureDeliveryStream, mainConversation } from "./conversations";
import type { Conversation } from "./conv-types";
import { openSession, renderList, sessionsState } from "./sessions";
import { fetchUiState, putUiState, type CoreSession, type UiStateRecord } from "./core-bridge";
import { isPhone, onPhoneChange } from "./viewport";
import {
  GroupActions,
  PaneContent,
  PaneTab,
  StripDrop,
  paneAwaitsInput,
  paneBackground,
  paneCrumb,
  paneIsWorking,
  paneKindBadge,
  paneTitle,
} from "./split-renderers";

export const splitState = {
  active: false,
  focusedId: null as string | null,
};

const STORE_KEY = "web-ui:split-canvas:v1";
const REMOTE_STATE_KEY = "split-canvas";

export interface PaneParams {
  sessionId?: string;
  threadRef?: string;
  scopeId?: string;
  [kindParamsKey: string]: string | undefined;
}

interface PaneDrag {
  params: PaneParams;
  existing(): IDockviewPanel | null;
}

let canvasHost: HTMLElement | null = null;
export let dockApi: DockviewApi | null = null;
let toastEl: HTMLElement | null = null;
let lastLayout: SerializedDockview | null = null;
let pendingSeed: SerializedDockview | null = null;
export const paneContents = new Map<string, PaneContent>();
export const paneTabs = new Set<PaneTab>();
export const groupActions = new Set<GroupActions>();
export const stripDrops = new Set<StripDrop>();
export let paneDrag: PaneDrag | null = null;
let toastMsg = "";
let toastTimer: number | null = null;
let headerSignature = "";
let persistTimer: number | null = null;
let remoteTimer: number | null = null;
let remotePayload: { updatedAt: number } | null = null;
let persistedUpdatedAt = 0;

let suspended = false;

function persist(): void {
  if (suspended) return;
  try {
    if (dockApi) lastLayout = dockApi.toJSON();
    persistedUpdatedAt = Date.now();
    const payload = { v: 2, active: splitState.active, layout: lastLayout, updatedAt: persistedUpdatedAt };
    localStorage.setItem(STORE_KEY, JSON.stringify(payload));
    pushRemoteSoon(payload);
  } catch (e) {
    swallow("web-ui: persist split layout", e);
  }
}

function pushRemoteSoon(payload: { updatedAt: number }): void {
  remotePayload = payload;
  if (remoteTimer !== null) window.clearTimeout(remoteTimer);
  remoteTimer = window.setTimeout(() => {
    remoteTimer = null;
    const p = remotePayload;
    remotePayload = null;
    if (p) void putUiState(REMOTE_STATE_KEY, p, p.updatedAt).catch(swallowAs("web-ui: sync split layout", undefined));
  }, 400);
}

function flushRemoteNow(): void {
  if (persistTimer !== null) {
    window.clearTimeout(persistTimer);
    persistTimer = null;
    persist();
  }
  if (remoteTimer !== null) window.clearTimeout(remoteTimer);
  remoteTimer = null;
  const p = remotePayload;
  if (!p) return;
  remotePayload = null;
  void putUiState(REMOTE_STATE_KEY, p, p.updatedAt, { keepalive: true }).catch(
    swallowAs("web-ui: flush split layout", undefined),
  );
}

window.addEventListener("pagehide", flushRemoteNow);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushRemoteNow();
});

function persistSoon(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persist();
  }, 150);
}

function buildDock(): DockviewApi {
  const host = canvasHost!;
  const dockEl = document.createElement("div");
  dockEl.className = "split-dock";
  host.appendChild(dockEl);
  toastEl = document.createElement("div");
  toastEl.className = "split-toast-layer";
  host.appendChild(toastEl);
  const api = createDockview(dockEl, {
    theme: { name: "qm", className: "dockview-theme-qm", gap: 1 },
    createComponent: () => new PaneContent(),
    createTabComponent: () => new PaneTab(),
    createRightHeaderActionComponent: () => new GroupActions(),
    createPrefixHeaderActionComponent: () => new StripDrop(),
    singleTabMode: "fullwidth",
    disableFloatingGroups: true,
  });
  const inner = dockEl.querySelector(":scope > .dv-dockview") as HTMLElement | null;
  let restoreScroll = () => {};
  api.onWillMutateLayout(() => {
    restoreScroll = preserveTranscriptScroll(host);
  });
  api.onDidMutateLayout(() => {
    restoreScroll();
    restoreScroll = () => {};
  });
  const box = (inner ?? dockEl).getBoundingClientRect();
  if (box.width > 0) api.layout(box.width, box.height, true);
  const holdTileCap = (e: DockviewWillDropEvent): void => {
    if (e.getData() === undefined) return;
    if (api.groups.length >= MAX_TILES && dropAddsTile(nativeDrop(api, e))) {
      e.preventDefault();
      canvasToast(`${MAX_TILES} tiles is the limit. Drop it on a tab strip instead`);
    }
  };
  api.onWillDrop(holdTileCap);
  api.onUnhandledDragOver((e) => {
    if (paneDrag && (e.target === "tab" || e.target === "header_space")) e.accept();
  });
  api.onDidDrop((e) => {
    const drag = paneDrag;
    endPaneDrag();
    const anchor = e.group?.activePanel ?? e.group?.panels[0];
    if (!anchor || !drag || focusExistingPane(drag.existing)) return;
    const at = e.panel ? e.group?.panels.indexOf(e.panel) : undefined;
    tabIntoPane(anchor.id, drag.params, at === -1 ? undefined : at);
  });
  const guarded = new WeakSet<IDockviewGroupPanel>();
  api.onDidLayoutChange(() => {
    const wasSingle = host.classList.contains("single-pane");
    host.classList.toggle("single-pane", api.panels.length === 1);
    if (wasSingle !== host.classList.contains("single-pane")) {
      for (const actions of groupActions) actions.draw();
    }
    for (const group of api.groups) {
      if (guarded.has(group)) continue;
      guarded.add(group);
      group.model.onWillDrop(holdTileCap);
    }
    if (appState.currentView === "chats") syncUrlFromState();
    if (paneDrag) refreshPaneDrag();
    persistSoon();
  });
  api.onDidActivePanelChange((e) => {
    splitState.focusedId = e.panel?.id ?? null;
    syncDocumentTitle();
    if (e.panel) focusPaneComposer(paneContents.get(e.panel.id)?.element);
  });
  api.onDidMaximizedGroupChange(() => {
    for (const a of groupActions) a.draw();
    persistSoon();
  });
  dockEl.addEventListener("pointerdown", (e) => {
    if (!(e.target instanceof Element) || !e.target.closest(".dv-sash")) return;
    host.classList.add("resizing");
    const up = (): void => {
      host.classList.remove("resizing");
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
  return api;
}

function nativeDrop(api: DockviewApi, e: DockviewWillDropEvent): Parameters<typeof dropAddsTile>[0] {
  const from = e.getData();
  return {
    edge: e.position !== "center",
    wholeTile: from !== undefined && from.panelId === null && !from.tabGroupId,
    sourceTilePanes: from ? (api.getGroup(from.groupId)?.panels.length ?? 0) : 0,
  };
}

function disposeDock(): void {
  dockApi?.dispose();
  dockApi = null;
  paneContents.clear();
  paneTabs.clear();
  groupActions.clear();
  stripDrops.clear();
  toastEl = null;
}

function ensureCanvas(): boolean {
  if (!appState.mainEl) return false;
  if (canvasHost && dockApi) {
    if (canvasHost.parentElement !== appState.mainEl) appState.mainEl.replaceChildren(canvasHost);
    return true;
  }
  disposeDock();
  canvasHost = document.createElement("div");
  canvasHost.className = "split-canvas";
  appState.mainEl.replaceChildren(canvasHost);
  mainConversation().state.host = null;
  dockApi = buildDock();
  const seed = pendingSeed;
  pendingSeed = null;
  try {
    if (lastLayout) {
      dockApi.fromJSON(lastLayout);
    } else if (seed) {
      dockApi.fromJSON(seed);
    }
  } catch (error) {
    reportHandledError("web:split_layout_restore", error);
    disposeDock();
    canvasHost.replaceChildren();
    lastLayout = null;
    dockApi = buildDock();
  }
  ensureDeliveryStream();
  splitState.focusedId = dockApi.activePanel?.id ?? dockApi.panels[0]?.id ?? null;
  syncDocumentTitle();
  headerSignature = computeHeaderSignature();
  return true;
}

export function paneSeedTitle(params: PaneParams): string {
  const entry = paneKindEntry(params);
  if (entry) return entry.kind.title(entry.id);
  return params.sessionId ? "Conversation" : "New session";
}

function addPane(
  params: PaneParams,
  position?: {
    referencePanel: string;
    direction: "left" | "right" | "above" | "below" | "within";
    index?: number;
  },
): IDockviewPanel {
  return dockApi!.addPanel({
    id: crypto.randomUUID().slice(0, 8),
    component: "pane",
    tabComponent: "pane",
    title: paneSeedTitle(params),
    params: { ...params },
    ...(position ? { position } : {}),
  });
}

function edgeToDirection(edge: SplitEdge): "left" | "right" | "above" | "below" {
  if (edge === "top") return "above";
  if (edge === "bottom") return "below";
  return edge;
}

function closeCanvas(): void {
  if (dockApi) lastLayout = dockApi.toJSON();
  splitState.active = false;
  splitState.focusedId = null;
  disposeDock();
  canvasHost = null;
  headerSignature = "";
  syncDocumentTitle();
  renderSidebarTop();
}

onPhoneChange((phone) => {
  if (phone) {
    if (!splitState.active) return;
    const focused = focusedPaneSession();
    suspended = true;
    if (persistTimer !== null) window.clearTimeout(persistTimer);
    persistTimer = null;
    closeCanvas();
    if (appState.currentView !== "chats") return;
    if (focused) void openSession(focused);
    else mainConversation().newChat();
    return;
  }
  if (!suspended && splitState.active) return;
  suspended = false;
  loadPersistedSplit();

  if (!splitState.active || appState.currentView !== "chats") return;

  sessionsState.openingKey = null;
  mainConversation().teardown();
  mainConversation().composer.resetComposer();
  if (!mountRestoredCanvas()) {
    mainConversation().newChat();
    return;
  }
  syncUrlFromState();
  renderList();
});

export function exitSplitIfActive(): void {
  if (!splitState.active) return;
  splitState.active = false;
  persist();
  closeCanvas();
}

function adoptPersisted(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const o = raw as { v?: unknown; active?: unknown; layout?: unknown; updatedAt?: unknown };
  const phone = isPhone();
  if (o.v !== 2 && !phone) return;
  if (typeof o.updatedAt === "number") persistedUpdatedAt = o.updatedAt;
  pendingSeed = null;
  splitState.active = false;
  if (phone || o.active !== true || !o.layout || typeof o.layout !== "object") return;
  const panels = (o.layout as { panels?: object }).panels;
  const n = panels && typeof panels === "object" ? Object.keys(panels).length : 0;
  if (n < 1 || n > MAX_PANES || serializedTileCount(o.layout) > MAX_TILES) return;
  pendingSeed = o.layout as SerializedDockview;
  splitState.active = true;
}

export function loadPersistedSplit(): void {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
  } catch {
    return;
  }
  adoptPersisted(raw);
}

export function fetchRemoteSplit(timeoutMs = 2000): Promise<UiStateRecord | null> {
  return Promise.race([
    fetchUiState(REMOTE_STATE_KEY).catch(swallowAs("web-ui: fetch synced split layout", null)),
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

export async function adoptRemoteSplit(pending: Promise<UiStateRecord | null>): Promise<void> {
  const rec = await pending;
  if (!rec || typeof rec !== "object") return;
  const at = typeof rec.updatedAt === "number" ? rec.updatedAt : 0;
  if (!rec.value || typeof rec.value !== "object" || at <= persistedUpdatedAt) return;
  adoptPersisted(rec.value);
  persistedUpdatedAt = at;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...rec.value, updatedAt: at }));
  } catch (e) {
    swallow("web-ui: cache synced split layout", e);
  }
}

export function restoredCanvasNeedsSessionList(): boolean {
  return pendingSeed !== null && layoutNeedsSessionList(pendingSeed);
}

export function mountRestoredCanvas(restoreOnly = false): boolean {
  if (isPhone() || (restoreOnly && !splitState.active)) return false;
  splitState.active = true;
  if (!ensureCanvas() || !dockApi) return false;
  if (dockApi.panels.length === 0) addPane({});
  renderSidebarTop();
  renderList();
  return true;
}

export function panelParams(panel: IDockviewPanel): PaneParams {
  return (panel.params ?? {}) as PaneParams;
}

function paneShowing(sessionId: string): IDockviewPanel | null {
  return dockApi?.panels.find((p) => panelParams(p).sessionId === sessionId) ?? null;
}

export function sessionInCanvas(sessionId: string): boolean {
  return splitState.active && paneShowing(sessionId) !== null;
}

export function closeSessionSurfaces(sessionId: string): boolean {
  if (!sessionId) return false;
  if (splitState.active && dockApi) {
    const showing = dockApi.panels.filter((p) => panelParams(p).sessionId === sessionId);
    if (showing.length) {
      closePanels(showing);
      return true;
    }
    return false;
  }
  const conv = mainConversation();
  if (conv.state.sessionId !== sessionId) return false;
  conv.newChat();
  return true;
}

export function splitInterceptsOpen(s: CoreSession): Conversation | null {
  if (!splitState.active || appState.currentView !== "chats") return null;
  const target = splitState.focusedId ?? dockApi?.panels[0]?.id ?? "";
  const panel = openTargetInPane(target, {
    ...sessionTarget(s.id, s.threadRef),
    params: { scopeId: s.scopeId },
  });
  renderList();
  return panel ? (paneContents.get(panel.id)?.conversation ?? null) : null;
}

export function openBackgroundInCanvas(s: CoreSession): boolean {
  if (!s.id || !mountRestoredCanvas() || !dockApi) return false;
  const showing = paneShowing(s.id);
  if (showing) {
    activatePanel(showing);
    paneContents.get(showing.id)?.conversation?.requestBackgroundPanel(s.id, s.threadRef);
    return true;
  }
  const target = splitState.focusedId ?? dockApi.activePanel?.id ?? dockApi.panels[0]?.id ?? "";
  openTargetInPane(target, {
    ...sessionTarget(s.id, s.threadRef),
    params: { sessionId: s.id, threadRef: s.threadRef },
  });
  const opened = paneShowing(s.id);
  if (opened) paneContents.get(opened.id)?.conversation?.requestBackgroundPanel(s.id, s.threadRef);
  renderList();
  return true;
}

function sessionTarget(sessionId: string, threadRef: string): Pick<PaneDrag, "params" | "existing"> {
  return {
    params: sessionId ? { sessionId, threadRef } : { threadRef },
    existing: () =>
      sessionId
        ? paneShowing(sessionId)
        : (dockApi?.panels.find((p) => panelParams(p).threadRef === threadRef) ?? null),
  };
}

export function focusExistingPane(existing: () => IDockviewPanel | null, exceptPaneId?: string): boolean {
  const dup = existing();
  if (!dup) return false;
  if (dup.id !== exceptPaneId) {
    activatePanel(dup);
    canvasToast("Already open in a pane");
  }
  return true;
}

export function openTargetInPane(paneId: string, target: Pick<PaneDrag, "params" | "existing">): IDockviewPanel | null {
  if (!dockApi) return null;
  const showing = target.existing();
  if (showing) {
    focusExistingPane(target.existing, paneId);
    return showing;
  }
  const panel = dockApi.getPanel(paneId);
  if (!panel) return null;
  const fresh = addPane(target.params, { referencePanel: panel.id, direction: "within" });
  dockApi.removePanel(panel);
  fresh.api.setActive();
  persist();
  return fresh;
}

function roomForAnotherPane(): boolean {
  if ((dockApi?.panels.length ?? 0) < MAX_PANES) return true;
  canvasToast(`${MAX_PANES} conversations is all one canvas holds. Close one first`);
  return false;
}

export function splitPane(paneId: string, edge: SplitEdge, params: PaneParams): void {
  if (!dockApi || !roomForAnotherPane()) return;
  if (dockApi.groups.length >= MAX_TILES) {
    if (tabIntoPane(paneId, params)) canvasToast(`${MAX_TILES} tiles is the limit, so it opened as a tab`);
    return;
  }
  const fresh = addPane(params, { referencePanel: paneId, direction: edgeToDirection(edge) });
  fresh.api.setActive();
  persist();
}

export function tabIntoPane(paneId: string, params: PaneParams, index?: number): boolean {
  if (!dockApi || !roomForAnotherPane()) return false;
  const fresh = addPane(params, {
    referencePanel: paneId,
    direction: "within",
    ...(index === undefined ? {} : { index }),
  });
  fresh.api.setActive();
  persist();
  return true;
}

export function startNewChatInCanvas(scopeId?: string, threadRef?: string): Conversation | null {
  if (!mountRestoredCanvas() || !dockApi) return null;
  if (appState.currentView !== "chats") switchView("chats");
  if (!ensureCanvas() || !dockApi) return null;
  const target = dockApi.activePanel ?? dockApi.panels[0];
  if (!target) return null;
  const replace = dockApi.panels.length === 1 || dockApi.panels.length >= MAX_PANES;
  const tile = !replace && dockApi.groups.length === 2;
  const { width, height } = target.group.element.getBoundingClientRect();
  const direction = width >= height ? "right" : "below";
  const fresh = addPane(
    { ...(scopeId ? { scopeId } : {}), ...(threadRef ? { threadRef } : {}) },
    { referencePanel: target.id, direction: tile ? direction : "within" },
  );
  if (replace) dockApi.removePanel(target);
  fresh.api.setActive();
  persist();
  return paneContents.get(fresh.id)?.conversation ?? null;
}

export function paneSplitWithBlank(panel: IDockviewPanel): void {
  const r = panel.group.element.getBoundingClientRect();
  splitPane(panel.id, r.width >= r.height ? "right" : "bottom", {});
}

export function closePanels(panels: IDockviewPanel[]): void {
  if (!dockApi) return;
  for (const p of panels) dockApi.removePanel(p);
  if (dockApi.panels.length === 0) addPane({});
  persist();
}

function activatePanel(panel: IDockviewPanel): void {
  if (panel.group.activePanel === panel) panel.group.api.setActive();
  else panel.api.setActive();
}

export function focusPane(paneId: string): void {
  const panel = dockApi?.getPanel(paneId);
  if (!panel || panel.api.isActive) return;
  preservingFocus(document, () => activatePanel(panel));
}

export function canvasToast(msg: string): void {
  toastMsg = msg;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastTimer = null;
    toastMsg = "";
    drawToast();
  }, 2500);
  drawToast();
}

function drawToast(): void {
  if (!toastEl) return;
  render(toastMsg ? html`<div class="split-toast" role="status">${toastMsg}</div>` : nothing, toastEl);
}

export function beginSessionDrag(s: CoreSession): void {
  if (s.id) beginPaneDrag(sessionTarget(s.id, s.threadRef));
}

export function beginPaneKindDrag(paramsKey: string, id: string): void {
  const kind = paneKindByKey(paramsKey);
  if (!kind) return;
  beginPaneDrag({
    params: { [kind.paramsKey]: id },
    existing: () => dockApi?.panels.find((p) => panelParams(p)[kind.paramsKey] === id) ?? null,
  });
}

function beginPaneDrag(drag: PaneDrag): void {
  paneDrag = drag;
  if (splitState.active) refreshPaneDrag();
}

function refreshPaneDrag(): void {
  if (!paneDrag) return;
  canvasHost?.classList.toggle("session-dragging", stripJoinable());
  drawStripDrops();
  syncAllZones();
}

export function stripJoinable(drag = paneDrag): boolean {
  return Boolean(drag && !drag.existing() && (dockApi?.panels.length ?? 0) < MAX_PANES);
}

function drawStripDrops(): void {
  for (const s of stripDrops) s.draw();
}

export function endPaneDrag(): void {
  if (!paneDrag) return;
  paneDrag = null;
  canvasHost?.classList.remove("session-dragging");
  drawStripDrops();
  if (splitState.active) syncAllZones();
}

function syncAllZones(): void {
  for (const c of paneContents.values()) c.syncZones();
}

document.addEventListener("mousemove", (e) => {
  if (e.buttons === 0) endPaneDrag();
});

export function drawCanvas(): void {
  if (!splitState.active || appState.currentView !== "chats" || !appState.mainEl) return;
  if (!ensureCanvas()) return;
  refreshHeaders();
}

function computeHeaderSignature(): string {
  return (dockApi?.panels ?? [])
    .map((p) => {
      const session = paneSession(p);
      const parent = session?.parentSessionId
        ? sessionsState.list.find((row) => row.id === session.parentSessionId)
        : undefined;
      return `${p.id}|${session?.id ?? ""}|${paneCrumb(p) ?? ""}|${paneTitle(p)}|${paneIsWorking(p)}|${paneAwaitsInput(p)}|${paneBackground(p)?.label ?? ""}|${paneKindBadge(p)}|${session?.parentSessionId ?? ""}|${parent?.title ?? ""}`;
    })
    .join("~");
}

export function notifyPanesChanged(): void {
  if (!splitState.active || !dockApi) return;
  if (computeHeaderSignature() === headerSignature) return;
  refreshHeaders();
}

export function refreshHeaders(): void {
  headerSignature = computeHeaderSignature();
  for (const t of paneTabs) t.draw();
  for (const a of groupActions) a.draw();
  for (const c of paneContents.values()) c.syncTitle();
  syncDocumentTitle();
  if (appState.currentView === "chats") syncUrlFromState();
}

export function singlePaneSessionId(): string | null {
  if (!dockApi || dockApi.panels.length !== 1) return null;
  const params = panelParams(dockApi.panels[0]!);
  return paneKindEntry(params) ? null : (params.sessionId ?? null);
}

export function paneSession(panel: IDockviewPanel): CoreSession | undefined {
  const { sessionId } = panelParams(panel);
  return sessionId ? sessionsState.list.find((s) => s.id === sessionId) : undefined;
}

export function focusedPaneConversation(): Conversation | null {
  if (!splitState.active) return null;
  return paneContents.get(splitState.focusedId ?? "")?.conversation ?? null;
}

export function focusedPaneSession(): CoreSession | undefined {
  if (!splitState.active || !dockApi) return undefined;
  const panel = (splitState.focusedId && dockApi.getPanel(splitState.focusedId)) || dockApi.activePanel;
  return panel ? paneSession(panel) : undefined;
}

export function notePaneSession(paneId: string, sessionId: string | null, threadRef: string | null): void {
  const panel = dockApi?.getPanel(paneId);
  if (!panel) return;
  const params = panelParams(panel);
  if (sessionId ? sessionId === params.sessionId : params.sessionId || !threadRef || threadRef === params.threadRef)
    return;
  panel.api.updateParameters({
    ...(sessionId ? { sessionId } : {}),
    ...(threadRef ? { threadRef } : {}),
  });
  persist();
  refreshHeaders();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && splitState.active && dockApi?.hasMaximizedGroup()) dockApi.exitMaximizedGroup();
});

window.addEventListener("qm:cycle-tab", (e) => {
  const step = (e as CustomEvent<unknown>).detail;
  if (!dockApi || !canvasHost?.isConnected || (step !== 1 && step !== -1)) return;
  const group = dockApi.groups.find((g) => g.element.contains(document.activeElement)) ?? dockApi.activeGroup;
  const panels = group?.panels ?? [];
  const at = group?.activePanel ? panels.indexOf(group.activePanel) : -1;
  if (panels.length < 2 || at < 0) return;
  activatePanel(panels[(at + step + panels.length) % panels.length]);
});
