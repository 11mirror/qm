import { openSessionShare } from "./session-share";
import { html, nothing, render, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { Archive, ArrowUpLeft, ChevronDown, Expand, Link, Maximize2, MoreHorizontal, Plus, Shrink, X } from "lucide";
import {
  type GroupPanelPartInitParameters,
  type IContentRenderer,
  type IDockviewGroupPanel,
  type IDockviewPanel,
  type IGroupHeaderProps,
  type IHeaderActionsRenderer,
  type DockviewIDisposable,
  type ITabRenderer,
  type TabPartInitParameters,
} from "dockview-core";
import { MAX_PANES, MAX_TILES, type DropEdge } from "./split-layout";
import { paneKindEntry } from "./pane-kinds";
import { focusComposerOnPaneClick } from "./pane-focus";
import { attachTooltip, tip } from "./tooltip";
import { icon } from "./icons";
import { contextsState, scopeTitle } from "./contexts";
import type { DensityTier } from "./density";
import { appState } from "./shell-state";
import { switchView } from "./shell";
import { createConversation, disposeConversation, ensureDeliveryStream, paneDensity } from "./conversations";
import type { Conversation } from "./conv-types";
import { openSession, openSessionInto, refreshSessions, sessionsReady, sessionsState, sessionTitle } from "./sessions";
import { archiveSessionById, menuOption } from "./session-actions";
import { backgroundGlyphs, liveMarks } from "./session-rows";
import { conversationBackground, rowIndicators, type RowIndicators } from "./session-list";
import { scopeToolCount, SESSION_TOOLS, setScopedSession, type SessionTool } from "./session-scope";
import { fetchTranscript, TAIL_TURNS, type CoreSession, type TranscriptPage } from "./core-bridge";
import type { IconNode } from "lucide";
import { iconBtn } from "./list-page";
import {
  PaneParams,
  closePanels,
  dockApi,
  endPaneDrag,
  focusExistingPane,
  focusPane,
  groupActions,
  notePaneSession,
  notifyPanesChanged,
  openTargetInPane,
  paneContents,
  paneDrag,
  paneSeedTitle,
  paneSession,
  paneSplitWithBlank,
  paneTabs,
  panelParams,
  refreshHeaders,
  splitPane,
  splitState,
  stripDrops,
  stripJoinable,
  tabIntoPane,
} from "./split";

function zoneTpl(edge: DropEdge, label: string, onDrop: () => void): TemplateResult {
  const over = (e: DragEvent): void => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    (e.currentTarget as HTMLElement).classList.add("over");
  };
  const leave = (e: DragEvent): void => (e.currentTarget as HTMLElement).classList.remove("over");
  const drop = (e: DragEvent): void => {
    e.preventDefault();
    onDrop();
  };
  return html`<div class="split-zone zone-${edge}" @dragover=${over} @dragleave=${leave} @drop=${drop}>
    <span>${label}</span>
  </div>`;
}

function splitZonesTpl(act: (edge: DropEdge) => () => void): TemplateResult {
  return html`
    ${zoneTpl("left", "Split left", act("left"))} ${zoneTpl("right", "Split right", act("right"))}
    ${zoneTpl("top", "Split up", act("top"))} ${zoneTpl("bottom", "Split down", act("bottom"))}
  `;
}

function paneZonesTpl(paneId: string): TemplateResult | typeof nothing {
  const drag = paneDrag;
  if (!dockApi || !drag) return nothing;
  const showing = drag.existing();
  if (showing)
    return showing.id === paneId
      ? zoneTpl("center", "Show here", () => {
          endPaneDrag();
          focusPane(paneId);
        })
      : nothing;
  const act = paneZoneAct(paneId);
  const canSplit = dockApi.panels.length < MAX_PANES && dockApi.groups.length < MAX_TILES;
  return html`${zoneTpl("center", "Replace pane", act("center"))} ${canSplit ? splitZonesTpl(act) : nothing}`;
}

function paneZoneAct(paneId: string): (edge: DropEdge) => () => void {
  return (edge) => () => {
    const drag = paneDrag;
    endPaneDrag();
    if (!drag) return;
    if (edge === "center") {
      openTargetInPane(paneId, drag);
      return;
    }
    if (focusExistingPane(drag.existing)) return;
    splitPane(paneId, edge, drag.params);
  };
}

export function paneTitle(panel: IDockviewPanel): string {
  const session = paneKindEntry(panelParams(panel)) ? undefined : paneSession(panel);
  return session ? sessionTitle(session) : paneSeedTitle(panelParams(panel));
}

export function paneKindBadge(panel: IDockviewPanel): number {
  const entry = paneKindEntry(panelParams(panel));
  return entry ? entry.kind.badge(entry.id) : 0;
}

function paneScopeId(panel: IDockviewPanel): string | null {
  return paneSession(panel)?.scopeId || panelParams(panel).scopeId || null;
}

export function paneCrumb(panel: IDockviewPanel): string | null {
  const scope = paneScopeId(panel);
  if (!scope || scope.startsWith("personal:")) return null;
  const context = contextsState.list.find((c) => c.scopeId === scope);
  return scopeTitle(scope, context?.name ?? null);
}

function openPaneTool(panel: IDockviewPanel, tool: SessionTool): void {
  const params = panelParams(panel);
  const session = paneSession(panel);
  const scope = paneScopeId(panel) ?? "";
  setScopedSession({
    scopeId: scope,
    sessionId: params.sessionId ?? session?.id ?? null,
    threadRef: params.threadRef ?? null,
    title: session?.title?.trim() || "New chat",
    crumb: paneCrumb(panel),
  });
  if (scope && (tool === "crons" || tool === "files" || tool === "apps")) contextsState.selected = scope;
  switchView(tool === "apps" ? "deploys" : tool);
}

export function paneIsWorking(panel: IDockviewPanel): boolean {
  const conv = paneContents.get(panel.id)?.conversation;
  const agent = conv?.state.agent;
  if (agent?.state.isStreaming || (conv && conv.state.pendingSend !== null)) return true;
  return Boolean(paneSession(panel)?.working);
}

export function paneAwaitsInput(panel: IDockviewPanel): boolean {
  const session = paneSession(panel);
  return session ? rowIndicators(session, null).awaiting : false;
}

export function paneBackground(panel: IDockviewPanel): RowIndicators["background"] {
  const { sessionId, threadRef } = panelParams(panel);
  return conversationBackground(sessionsState.list, sessionId ?? null, threadRef ?? null);
}

export class PaneContent implements IContentRenderer {
  readonly element: HTMLElement;
  conversation: Conversation | null = null;
  private kindPane: { dispose(): void } | null = null;
  private readonly chatEl: HTMLElement;
  private readonly zonesEl: HTMLElement;
  private readonly resize: ResizeObserver;
  private panelId = "";
  private panel: IDockviewPanel | null = null;
  private params: PaneParams = {};
  private density: DensityTier = "full";
  private loaded = false;
  private disposed = false;
  private redrawOnResize: Array<() => void> = [];
  private visible = false;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "split-pane-content";
    this.chatEl = document.createElement("div");
    this.chatEl.className = "split-pane-chat";
    this.zonesEl = document.createElement("div");
    this.zonesEl.className = "split-zones";
    this.element.append(this.chatEl, this.zonesEl);
    this.element.addEventListener("focusin", () => focusPane(this.panelId));
    this.resize = new ResizeObserver(() => this.syncDensity());
  }

  private ensureConversation(): Conversation {
    this.conversation ??= createConversation({
      pane: true,
      ownsUrl: false,
      container: () => this.chatEl,
      claimContainer: () => this.chatEl,
      visible: () => splitState.active && appState.currentView === "chats" && this.visible,
      density: () => this.density,
      onDensityChange: (handler) => this.redrawOnResize.push(handler),
      ensureDeliveryStream,
      onState: (paneState) => {
        notePaneSession(this.panelId, paneState.sessionId, paneState.threadRef);
        notifyPanesChanged();
      },
      onExpand: () => {
        const panel = dockApi?.getPanel(this.panelId);
        if (panel && !panel.api.isMaximized()) panel.api.maximize();
      },
    });
    return this.conversation;
  }

  init(p: GroupPanelPartInitParameters): void {
    this.panelId = p.api.id;
    this.visible = p.api.isVisible;
    this.panel = p.containerApi.getPanel(p.api.id) ?? null;
    this.params = (p.params ?? {}) as PaneParams;
    this.element.dataset.paneId = this.panelId;
    focusComposerOnPaneClick(this.element, () => p.api.isActive);
    paneContents.set(this.panelId, this);
    this.resize.observe(this.element);
    this.syncZones();
    p.api.onDidDimensionsChange(() => this.syncDensity());
    p.api.onDidVisibilityChange((e) => {
      this.visible = e.isVisible;
      if (!e.isVisible) return;
      if (!this.loaded) {
        void this.load();
        return;
      }
      this.syncDensity();
      this.conversation?.redraw();
      this.conversation?.scrollToBottom();
    });
    if (p.api.isVisible) void this.load();
  }

  private syncDensity(): void {
    const next = paneDensity(this.element);
    if (!next) return;
    const changed = next !== this.density;
    this.element.dataset.density = this.density = next;
    if (!changed) return;
    for (const handler of this.redrawOnResize) handler();
  }

  private async load(): Promise<void> {
    if (this.loaded || this.disposed) return;
    this.loaded = true;
    this.syncDensity();
    const { sessionId, threadRef, scopeId } = this.params;
    const entry = paneKindEntry(this.params);
    if (entry) {
      this.kindPane = entry.kind.mount({
        host: this.chatEl,
        id: entry.id,
        density: () => this.density,
        onDensityChange: (handler) => this.redrawOnResize.push(handler),
      });
      return;
    }
    const conversation = this.ensureConversation();
    const wanted =
      sessionId ?? (threadRef ? (sessionsState.list.find((s) => s.threadRef === threadRef)?.id ?? null) : null);
    if (!wanted) {
      if (threadRef) {
        conversation.mountContinuable(threadRef, null, scopeId ?? null, []);
        return;
      }
      const context = scopeId ? contextsState.list.find((c) => c.scopeId === scopeId) : undefined;
      conversation.newChat(context ? { scopeId: context.scopeId, name: context.name ?? null } : undefined);
      return;
    }
    const isCurrent = conversation.mountLoadingPane();
    const find = () => sessionsState.list.find((s) => s.id === wanted);
    let session = find();
    for (const wait of [sessionsReady, () => refreshSessions({ silent: true })]) {
      if (session) break;
      await wait();
      if (this.disposed || !isCurrent()) return;
      session = find();
    }
    let page: TranscriptPage | null = null;
    if (!session) {
      page = await fetchTranscript(wanted, { tailTurns: TAIL_TURNS }).catch(() => null);
      if (this.disposed || !isCurrent()) return;
      session = page?.session;
    }
    if (!session) {
      conversation.mountLoadError(() => {
        this.loaded = false;
        void this.load();
      });
      return;
    }
    await openSessionInto(conversation, session, page ? Promise.resolve(page) : undefined);
    if (this.disposed) return;
    refreshHeaders();
  }

  update(p: { params: Record<string, unknown> }): void {
    this.params = (p.params ?? {}) as PaneParams;
    this.syncTitle();
  }

  syncTitle(): void {
    if (this.panel) attachTooltip(this.element, paneTitle(this.panel));
  }

  syncZones(): void {
    render(paneDrag ? paneZonesTpl(this.panelId) : nothing, this.zonesEl);
  }

  dispose(): void {
    this.disposed = true;
    this.resize.disconnect();
    paneContents.delete(this.panelId);
    this.kindPane?.dispose();
    this.kindPane = null;
    if (this.conversation) disposeConversation(this.conversation);
  }
}

function sessionParent(sessionId: string): CoreSession | undefined {
  const parentId = sessionsState.list.find((row) => row.id === sessionId)?.parentSessionId;
  return parentId ? sessionsState.list.find((row) => row.id === parentId) : undefined;
}

type SessionAction = { label: string; aria?: string; glyph: Parameters<typeof icon>[0]; cls?: string; run: () => void };

function sessionActionItems(sessionId: string, panelId: string): SessionAction[] {
  const parent = sessionParent(sessionId);
  const back: SessionAction[] = parent
    ? [
        {
          label: `Back to ${sessionTitle(parent)}`,
          aria: `Back to parent: ${sessionTitle(parent)}`,
          glyph: ArrowUpLeft,
          run: () => {
            focusPane(panelId);
            void openSession(parent);
          },
        },
      ]
    : [];
  return [
    ...back,
    { label: "Share conversation", glyph: Link, cls: "split-tab-share", run: () => void openSessionShare(sessionId) },
    { label: "Archive session", glyph: Archive, cls: "split-tab-archive", run: () => archiveSessionById(sessionId) },
  ];
}

const subtleButton = (cls: string, label: string, glyph: IconNode, size: number, run: EventListener, aria?: string) =>
  iconBtn(label, glyph, run, { aria, size, cls: `icon-btn subtle ${cls}`.trim() });

function sessionActions(sessionId: string, panelId: string, cls: string): TemplateResult[] {
  return sessionActionItems(sessionId, panelId).map((a) =>
    subtleButton([cls, a.cls].filter(Boolean).join(" "), a.label, a.glyph, 13, a.run, a.aria),
  );
}

let tabMenu: { panelId: string; anchor: HTMLElement } | null = null;

function toggleTabMenu(panelId: string, anchor: HTMLElement): void {
  tabMenu = tabMenu?.panelId === panelId ? null : { panelId, anchor };
  for (const a of groupActions) a.draw();
}

const placeBelow =
  (anchor: HTMLElement) =>
  (el?: Element): void => {
    if (!(el instanceof HTMLElement)) return;
    const rect = anchor.getBoundingClientRect();
    el.style.position = "fixed";
    el.style.top = `${rect.bottom + 6}px`;
    el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8))}px`;
    el.style.right = "auto";
  };

function closeTabButton(panel: IDockviewPanel): TemplateResult {
  return subtleButton("split-tab-close", "Close pane", X, 13, (e) => {
    e.stopPropagation();
    closePanels([panel]);
  });
}

export class PaneTab implements ITabRenderer {
  readonly element: HTMLElement;
  private panelId = "";
  private panel: IDockviewPanel | null = null;
  private inStrip = false;

  constructor() {
    this.element = document.createElement("span");
    this.element.className = "split-pane-title";
  }

  init(p: TabPartInitParameters): void {
    this.panelId = p.api.id;
    this.inStrip = p.tabLocation === "header";
    if (this.inStrip) paneTabs.add(this);
    this.draw();
  }

  update(): void {
    this.draw();
  }

  draw(): void {
    this.panel ??= dockApi?.getPanel(this.panelId) ?? null;
    const panel = this.panel;
    if (!panel) return;
    const entry = paneKindEntry(panelParams(panel));
    if (entry) {
      const title = entry.kind.title(entry.id);
      const count = entry.kind.badge(entry.id);
      this.element.title = title;
      render(
        html`
          <span class="pane-kind-glyph">${icon(entry.kind.glyph, 12)}</span>
          <span class="split-pane-title-text">${title}</span>
          ${count > 0 ? html`<span class="pane-kind-count" title=${`${count} waiting on you`}>${count}</span>` : nothing}
          ${this.inStrip ? html`<span class="split-tab-actions">${closeTabButton(panel)}</span>` : nothing}
        `,
        this.element,
      );
      return;
    }
    const title = paneTitle(panel);
    const crumb = paneCrumb(panel);
    const background = paneBackground(panel);
    const sessionId = panelParams(panel).sessionId ?? paneSession(panel)?.id;
    const parent = sessionId ? sessionParent(sessionId) : undefined;
    attachTooltip(this.element, [crumb, parent ? sessionTitle(parent) : null, title].filter(Boolean).join(" / "));
    render(
      html`
        ${liveMarks(paneIsWorking(panel), paneAwaitsInput(panel))}
        ${
          background
            ? html`<span class="bg-chip" aria-label=${background.label} ${tip(background.label)}
                >${backgroundGlyphs(background)}</span
              >`
            : nothing
        }
        ${
          crumb
            ? html`<span class="split-pane-crumb">${crumb}</span><span class="split-pane-crumb-sep">/</span>`
            : nothing
        }
        ${
          parent
            ? html`<button
                  type="button"
                  class="split-pane-parent"
                  aria-label=${`Back to parent: ${sessionTitle(parent)}`}
                  ${tip(sessionTitle(parent))}
                  @pointerdown=${(event: Event) => event.stopPropagation()}
                  @click=${(event: Event) => {
                    event.stopPropagation();
                    focusPane(panel.id);
                    void openSession(parent);
                  }}
                >
                  ${sessionTitle(parent)}</button
                ><span class="split-pane-crumb-sep">/</span>`
            : nothing
        }
        <span class="split-pane-title-text" dir="auto">${title}</span>
        ${
          this.inStrip
            ? html`<span class="split-tab-actions">
                ${
                  sessionId
                    ? html`<span class="split-tab-session" @click=${(e: Event) => e.stopPropagation()}
                          >${sessionActions(sessionId, panel.id, "")}</span
                        ><button
                          class="icon-btn subtle split-tab-more"
                          type="button"
                          ${tip("Session actions")}
                          aria-label="Session actions"
                          aria-haspopup="menu"
                          @click=${(e: Event) => {
                            e.stopPropagation();
                            toggleTabMenu(panel.id, e.currentTarget as HTMLElement);
                          }}
                        >
                          ${icon(ChevronDown, 13)}
                        </button>`
                    : nothing
                }
                ${closeTabButton(panel)}</span
              >`
            : nothing
        }
      `,
      this.element,
    );
  }

  dispose(): void {
    paneTabs.delete(this);
  }
}

export class StripDrop implements IHeaderActionsRenderer {
  readonly element: HTMLElement;
  private group: IDockviewGroupPanel | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "split-zones strip-zones";
  }

  init(props: IGroupHeaderProps): void {
    this.group = props.group;
    stripDrops.add(this);
    this.draw();
  }

  draw(): void {
    const group = this.group;
    render(
      group && stripJoinable()
        ? zoneTpl("center", "Open as tab", () => {
            const drag = paneDrag;
            endPaneDrag();
            const anchor = group.activePanel ?? group.panels[0];
            if (!drag || !anchor || focusExistingPane(drag.existing)) return;
            tabIntoPane(anchor.id, drag.params);
          })
        : nothing,
      this.element,
    );
  }

  dispose(): void {
    stripDrops.delete(this);
  }
}

export class GroupActions implements IHeaderActionsRenderer {
  readonly element: HTMLElement;
  private activePanelChange: DockviewIDisposable | null = null;
  private props: IGroupHeaderProps | null = null;
  private menuOpen = false;

  constructor() {
    this.element = document.createElement("span");
    this.element.className = "split-pane-actions";
  }

  init(props: IGroupHeaderProps): void {
    this.props = props;
    groupActions.add(this);
    this.activePanelChange = props.group.api.onDidActivePanelChange(() => this.draw());
    document.addEventListener("click", this.onDocClick);
    this.draw();
  }

  private readonly onDocClick = (e: Event): void => {
    if (!this.menuOpen && !tabMenu) return;
    const tools = this.element.querySelector(".split-tools");
    if (tools && e.composedPath().includes(tools)) return;
    this.menuOpen = false;
    tabMenu = null;
    this.draw();
  };

  private readonly placeMenu = (el?: Element): void => {
    if (!(el instanceof HTMLElement)) return;
    const rect = this.element.querySelector(".split-tools-btn")?.getBoundingClientRect();
    if (!rect) return;
    el.style.position = "fixed";
    el.style.top = `${rect.bottom + 6}px`;
    el.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    el.style.left = "auto";
  };

  draw(): void {
    const props = this.props;
    if (!props) return;
    const activePanel = (): IDockviewPanel | null => {
      const g = dockApi?.groups.find((x) => x.id === props.group.id);
      return g?.activePanel ?? g?.panels[0] ?? null;
    };
    const panel = activePanel();
    const scope = panel ? paneScopeId(panel) : null;
    const single = dockApi?.panels.length === 1;
    const sessionId =
      panel && !paneKindEntry(panelParams(panel)) ? (panelParams(panel).sessionId ?? paneSession(panel)?.id) : null;
    const maximized = props.api.isMaximized();
    const runTool = (tool: SessionTool): void => {
      this.menuOpen = false;
      const p = activePanel();
      this.draw();
      if (p) openPaneTool(p, tool);
    };
    if (single) this.menuOpen = false;
    const closeMenu = (): void => {
      this.menuOpen = false;
      this.draw();
    };
    const splitPane = (): void => {
      const p = activePanel();
      if (p) paneSplitWithBlank(p);
    };
    const menu = this.menuOpen
      ? html`
          <div
            class="session-menu-popover split-tools-menu"
            role="menu"
            ${ref(this.placeMenu)}
            @click=${(e: Event) => e.stopPropagation()}
          >
            ${SESSION_TOOLS.map((t) => menuOption(t.glyph, t.label, () => runTool(t.tool)))}
            <div class="split-tools-menu-sep" role="separator"></div>
            ${menuOption(Plus, "Split with a new session", () => {
              closeMenu();
              splitPane();
            })}
            ${menuOption(
              maximized ? Shrink : Expand,
              maximized ? "Restore to grid (Esc)" : "Focus over the grid",
              () => {
                closeMenu();
                if (maximized) props.api.exitMaximized();
                else props.api.maximize();
              },
            )}
          </div>
        `
      : nothing;
    const toggleFull = (): void => {
      const p = activePanel();
      if (p?.api.isMaximized()) p.api.exitMaximized();
      else p?.api.maximize();
    };
    const closeGroup = (): void => {
      const g = dockApi?.groups.find((x) => x.id === props.group.id);
      if (g) closePanels([...g.panels]);
    };
    const menuPanel = tabMenu ? props.group.panels.find((p) => p.id === tabMenu?.panelId) : undefined;
    const menuSession = menuPanel ? (panelParams(menuPanel).sessionId ?? paneSession(menuPanel)?.id) : undefined;
    const tabMenuTpl =
      tabMenu && menuPanel && menuSession
        ? html`<div
            class="session-menu-popover split-tools-menu split-tab-menu"
            role="menu"
            ${ref(placeBelow(tabMenu.anchor))}
            @click=${(e: Event) => e.stopPropagation()}
          >
            ${sessionActionItems(menuSession, menuPanel.id).map((a) =>
              menuOption(a.glyph, a.label, () => {
                tabMenu = null;
                this.draw();
                a.run();
              }),
            )}
          </div>`
        : nothing;
    render(
      html`${
          single
            ? html`<span class="split-single-tools">
                ${SESSION_TOOLS.map((t) => {
                  const count = scope ? scopeToolCount(t.tool, scope, () => this.draw()) : null;
                  return html`<button
                    class="session-tool"
                    type="button"
                    aria-label=${t.label}
                    ${tip(t.label)}
                    @click=${() => runTool(t.tool)}
                  >
                    ${icon(t.glyph, 15)}${count ? html`<span class="session-tool-count">${count}</span>` : nothing}
                  </button>`;
                })}
              </span>`
            : html`<span class="split-tools">
                <button
                  class="icon-btn subtle split-tools-btn ${this.menuOpen ? "active" : ""}"
                  type="button"
                  ${tip("Tools")}
                  aria-label="Tools"
                  aria-haspopup="menu"
                  aria-expanded=${this.menuOpen ? "true" : "false"}
                  @click=${() => {
                    tabMenu = null;
                    this.menuOpen = !this.menuOpen;
                    this.draw();
                  }}
                >
                  ${icon(MoreHorizontal, 15)}
                </button>
                ${menu}
              </span>`
        }
        ${sessionId ? sessionActions(sessionId, panel!.id, "split-group-session-action") : nothing}
        <span class="split-pane-actions-wide"
          >${
            single
              ? nothing
              : [
                  subtleButton("", "Split this pane with a new session", Plus, 15, splitPane),
                  subtleButton("", "Open full screen", Maximize2, 14, toggleFull),
                ]
          }</span
        >
        ${single ? nothing : subtleButton("split-group-close", "Close pane", X, 15, closeGroup)}${tabMenuTpl}`,
      this.element,
    );
  }

  dispose(): void {
    document.removeEventListener("click", this.onDocClick);
    groupActions.delete(this);
    this.activePanelChange?.dispose();
    this.props = null;
  }
}
