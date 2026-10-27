import { html, nothing, render, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import {
  Binoculars,
  Bot,
  Target,
  ChevronDown,
  ChevronRight,
  Clock3,
  Cog,
  CornerLeftUp,
  EllipsisVertical,
  Folder,
  Hash,
  Lock,
  Pencil,
  Plus,
  SquareTerminal,
  Users,
  type IconNode,
} from "lucide";
import { fetchSessionPage, detachSession, sharedContextLabel, type CoreSession } from "./core-bridge";
import { deepLinkPath, isPlainLeftClick, UI_BASE } from "./deep-link";
import {
  activityOf,
  chatBrowseStatusMatches,
  rowIndicators,
  surfaceOf,
  upsertSessions,
  type BackgroundCounts,
  type ChatBrowseStatus,
  type RecentGroupKind,
  type RecentItem,
} from "./session-list";
import { tip } from "./tooltip";
import { errMessage } from "../../chassis/src/errors";
import { menuSelect, relTime, sheenLabel, workingWave } from "./ui";
import { slackMark } from "./slack-mark";
import { icon } from "./icons";
import { listPageTpl, listTabs } from "./list-page";
import { ensureContexts, openProjectDetail, renameProject, scopeChip } from "./contexts";
import { groupDmText } from "./group-dm-label";
import { appState } from "./shell";
import { allConversations, mainConversation } from "./conversations";
import {
  openBackgroundInCanvas,
  beginSessionDrag,
  endPaneDrag,
  canvasToast,
  sessionInCanvas,
  splitState,
} from "./split";
import { liveTurnThreadRef } from "./working-dot";
import { selectionClick } from "./session-select";
import {
  SESSION_BATCH_SIZE,
  channelLabel,
  groupDmTitle,
  openConversationIds,
  openSession,
  pendingForkThreads,
  projectMenuKey,
  projectOf,
  refreshSessions,
  renderList,
  sessionTitle,
  sessionsState,
  startNewChat,
  visibleRowOrder,
} from "./sessions";
import {
  beginRename,
  displaySessionColor,
  menuOption,
  placeSessionMenu,
  redrawSelection,
  refreshingTitleIds,
  renameInput,
  renameRow,
  sessionAction,
  sessionMenuPopover,
  startRename,
  toggleSessionMenu,
} from "./session-actions";

const GROUP_LOOK: Record<RecentGroupKind, [IconNode | null, string]> = {
  personal: [null, "Project"],
  project: [Folder, "Project"],
  channel: [Hash, "Channel"],
  group: [Users, "Group DM"],
};

export function recentItem(item: RecentItem, shownThreads: ReadonlySet<string>): TemplateResult {
  if (item.kind === "session") return sessionRow(item.session);
  const collapsed = sessionsState.collapsedProjectScopes.has(item.scopeId);
  const [glyph, fallbackName] = GROUP_LOOK[item.groupKind];
  const name = item.name ?? fallbackName;
  const childrenId = `recent-${item.scopeId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const menuKey = projectMenuKey(item.scopeId);
  const menuOpen = sessionsState.openMenuId === menuKey;
  return html`
    <section class="recent-project ${item.sessions.some(isActiveRow) ? "active" : ""}" aria-label=${`${name} project`}>
      ${
        sessionsState.renamingId === menuKey
          ? html`<div class="recent-project-head renaming">
              ${renameInput(menuKey, "Rename project", (next) => commitProjectRename(item, next))}
            </div>`
          : html`<div class="recent-project-head">
              <button
                class="recent-project-toggle"
                type="button"
                aria-expanded=${collapsed ? "false" : "true"}
                aria-controls=${childrenId}
                @click=${() => toggleRecentProject(item.scopeId)}
              >
                <span class="recent-project-glyph">
                  ${glyph && !collapsed ? html`<span class="glyph">${icon(glyph, 14)}</span>` : nothing}
                  <span class="chev">${icon(collapsed ? ChevronRight : ChevronDown, 13)}</span>
                </span>
                <span class="recent-project-name" dir="auto">${name.replace(/^#/, "")}</span>
              </button>
              <div class="session-menu recent-project-menu ${menuOpen ? "menu-open" : ""}">
                <button
                  class="session-menu-btn"
                  data-menu-id=${menuKey}
                  type="button"
                  aria-label=${`Options for ${name}`}
                  aria-haspopup="menu"
                  aria-expanded=${menuOpen ? "true" : "false"}
                  ${tip("Project options")}
                  @click=${(e: Event) => toggleSessionMenu(e, menuKey)}
                >
                  ${icon(EllipsisVertical, 15)}
                </button>
                ${menuOpen ? projectMenuPopover(item) : nothing}
              </div>
              <button
                class="recent-project-new-chat"
                type="button"
                aria-label=${`Start a new chat in ${name}`}
                ${tip("Start a new chat")}
                @click=${(event: Event) => {
                  event.stopPropagation();
                  startNewChat(item.scopeId, item.name);
                }}
              >
                ${icon(Plus, 15)}
              </button>
            </div>`
      }
      <div class="recent-project-children" id=${childrenId} ?hidden=${collapsed}>
        ${
          collapsed
            ? nothing
            : repeat(
                item.sessions.filter((session) => shownThreads.has(session.threadRef)),
                (session) => session.threadRef,
                (session) => sessionRow(session, true),
              )
        }
      </div>
    </section>
  `;
}

function toggleRecentProject(scopeId: string): void {
  if (!sessionsState.collapsedProjectScopes.delete(scopeId)) sessionsState.collapsedProjectScopes.add(scopeId);
  renderList();
}

function projectMenuPopover(item: Extract<RecentItem, { kind: "project" }>): TemplateResult {
  const owned = projectOf(item.scopeId)?.ownerId === appState.me?.user;
  return html`
    <div class="session-menu-popover" role="menu" ${ref(placeSessionMenu)} @click=${(e: Event) => e.stopPropagation()}>
      ${menuOption(Folder, "View project", () => openProjectFromMenu(item.scopeId))}
      ${owned ? menuOption(Pencil, "Rename", () => beginRename(projectMenuKey(item.scopeId), item.name ?? "")) : nothing}
    </div>
  `;
}

function openProjectFromMenu(scopeId: string): void {
  sessionsState.openMenuId = null;
  openProjectDetail(scopeId);
}

async function commitProjectRename(item: Extract<RecentItem, { kind: "project" }>, next: string): Promise<void> {
  const project = projectOf(item.scopeId);
  if (!project || !next || next === project.name) return;
  await renameProject(project, next);
  renderList();
}

export const syncWorkingPulse = (el?: Element): void => {
  if (!(el instanceof Element)) return;
  const running = (): Animation[] => el.getAnimations({ subtree: true });
  const pin = (): void => {
    for (const a of running()) a.startTime = 0;
  };
  if (running().length > 0) pin();
  else requestAnimationFrame(pin);
};

function liveThreads(): ReadonlySet<string> {
  const live = new Set<string>();
  for (const conv of allConversations()) {
    const ref = liveTurnThreadRef({
      mountedThreadRef: conv.state.threadRef,
      isStreaming: Boolean(conv.state.agent?.state.isStreaming),
      pendingSend: conv.state.pendingSend,
    });
    if (ref) live.add(ref);
  }
  return live;
}

export function liveMarks(working: boolean, awaiting: boolean): TemplateResult {
  return html`${working ? html`<span class="working-mark" ${ref(syncWorkingPulse)}>${workingWave()}</span>` : nothing}${
    awaiting ? html`<span class="awaiting-dot" aria-label="Waiting for your reply"></span>` : nothing
  }`;
}

export function backgroundGlyphs(bg: BackgroundCounts): TemplateResult {
  return html`${bg.jobs > 0 ? icon(Cog, 11) : nothing}${bg.watches > 0 ? icon(Binoculars, 11) : nothing}${
    bg.crons > 0 ? icon(Clock3, 11) : nothing
  }${bg.subagents > 0 ? icon(Bot, 11) : nothing}${bg.goal ? icon(Target, 11) : nothing}`;
}

function statusMarks(s: CoreSession): TemplateResult {
  const { working, awaiting, background } = rowIndicators(s, liveThreads());
  return html`${liveMarks(working, awaiting)}${
    background
      ? html`<span
          class="bg-chip"
          role="button"
          tabindex="0"
          aria-label="${background.label}. Click to inspect"
          ${tip(`${background.label}. Click to inspect`)}
          @click=${(e: Event) => openBackgroundInspector(e, s)}
          @keydown=${(e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && openBackgroundInspector(e, s)}
          >${backgroundGlyphs(background)}</span
        >`
      : nothing
  }`;
}

function openBackgroundInspector(e: Event, s: CoreSession): void {
  e.stopPropagation();
  e.preventDefault();
  if (openBackgroundInCanvas(s)) return;
  mainConversation().requestBackgroundPanel(s.id || null, s.threadRef);
  void openSession(s);
}

function isActiveRow(s: CoreSession): boolean {
  if (splitState.active) return Boolean(s.id) && sessionInCanvas(s.id);
  if (sessionsState.openingKey) return Boolean(s.id) && s.id === sessionsState.openingKey;
  const main = mainConversation().state;
  return Boolean((main.sessionId && s.id === main.sessionId) || (main.threadRef && s.threadRef === main.threadRef));
}

function surfaceGlyph(s: CoreSession): TemplateResult | typeof nothing {
  const surface = surfaceOf(s);
  if (surface === "slack") return html`<span class="surface-glyph">${slackMark(12, true)}</span>`;
  if (surface === "core") return html`<span class="surface-glyph">${icon(SquareTerminal, 12)}</span>`;
  return nothing;
}

function rowContext(s: CoreSession): string | null {
  let label = sharedContextLabel(s.scopeId, s.channelName ?? null);
  if (surfaceOf(s) === "slack") label = s.type === "group" ? groupDmText(s.channelName) : channelLabel(s);
  return label && label !== sessionTitle(s) ? label : null;
}

export function sessionRow(s: CoreSession, projectChild = false): TemplateResult {
  const saved = Boolean(s.id);
  if (saved && sessionsState.renamingId === s.id) return renameRow(s);
  const active = isActiveRow(s);
  const menuOpen = saved && sessionsState.openMenuId === s.id;
  const refreshingTitle = saved && refreshingTitleIds.has(s.id);
  const untitledProjectChild = projectChild && !s.title?.trim();
  let title = sessionTitle(s);
  if (untitledProjectChild) title = surfaceOf(s) === "web" ? "Web chat" : "New chat";
  const readOnly = surfaceOf(s) !== "slack" && !s.canContinue;
  const surface = surfaceOf(s);
  const context = projectChild ? null : rowContext(s);
  const working = rowIndicators(s, liveThreads()).working;
  const color = displaySessionColor(s.color);
  let titleContent: string | TemplateResult = groupDmTitle(s);
  if (refreshingTitle || pendingForkThreads.has(s.threadRef)) {
    titleContent = html`<span class="sheen-label title-sheen thinking-sheen" data-sheen=${title}>${title}</span>`;
  } else if (untitledProjectChild) {
    titleContent = title;
  }
  const ariaLabel = [
    title,
    surface !== "web" ? surface : null,
    context,
    working ? "agent is working" : null,
    s.awaitingInput ? "waiting for your reply" : null,
    readOnly ? "read-only" : null,
    showsUnread(s) ? "unread" : null,
    s.pinned ? "pinned" : null,
    sessionsState.selection.ids.has(s.id) ? "selected" : null,
    relTime(activityOf(s)),
  ]
    .filter(Boolean)
    .join(", ");
  return html`
    <div
      data-session-id=${saved ? s.id : nothing}
      class="session-row ${active ? "active" : ""} ${saved && sessionsState.selection.ids.has(s.id) ? "selected" : ""} ${menuOpen ? "menu-open" : ""} ${readOnly ? "read-only" : ""} ${refreshingTitle ? "title-refreshing" : ""} ${working ? "working" : ""} ${s.awaitingInput ? "awaiting-input" : ""} ${showsUnread(s) ? "unread" : ""} ${projectChild ? "project-child" : ""} ${color ? "colored" : ""}"
      style=${color ? `--session-color:${color}` : nothing}
    >
      <a
        class="session"
        href=${saved ? deepLinkPath(UI_BASE, "chats", s.id) : nothing}
        aria-busy=${refreshingTitle || pendingForkThreads.has(s.threadRef) ? "true" : "false"}
        aria-disabled=${pendingForkThreads.has(s.threadRef) ? "true" : nothing}
        aria-label=${ariaLabel}
        aria-keyshortcuts="Space Shift+Space Control+Space Meta+Space"
        draggable=${saved ? "true" : "false"}
        @dragstart=${(e: DragEvent) => onSessionDragStart(e, s)}
        @dragend=${() => endSessionDrag()}
        @mousedown=${(e: MouseEvent) => {
          if (saved && e.shiftKey) e.preventDefault();
        }}
        @click=${(e: MouseEvent) => {
          if (saved && e.button === 0 && (e.shiftKey || e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            sessionsState.selection = selectionClick(sessionsState.selection, visibleRowOrder(), s.id, {
              shift: e.shiftKey,
              toggle: e.metaKey || e.ctrlKey,
            });
            redrawSelection();
            return;
          }
          if (saved && !isPlainLeftClick(e)) return;
          e.preventDefault();
          const hadSelection = sessionsState.selection.ids.size > 0;
          sessionsState.selection = { ids: new Set(), anchor: saved ? s.id : null, shiftRange: new Set() };
          sessionsState.selectColorOpen = false;
          if (hadSelection) redrawSelection();
          void openSession(s);
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (!saved || e.key !== " ") return;
          e.preventDefault();
          sessionsState.selection = selectionClick(sessionsState.selection, visibleRowOrder(), s.id, {
            shift: e.shiftKey,
            toggle: !e.shiftKey || e.metaKey || e.ctrlKey,
          });
          redrawSelection();
        }}
        @dblclick=${(e: Event) => {
          if (!saved) return;
          e.preventDefault();
          startRename(s);
        }}
        @contextmenu=${(e: MouseEvent) => {
          if (!saved) return;
          e.preventDefault();
          e.stopPropagation();
          sessionsState.openMenuId = s.id;
          renderList();
        }}
      >
        <div class="title" aria-live="polite">
          ${statusMarks(s)}${surfaceGlyph(s)}<span class="tl" dir="auto">${titleContent}</span
          >${context ? html`<span class="row-context" ${tip(context)}>${context}</span>` : nothing}${unreadDot(s)}
        </div>
      </a>
      ${
        saved
          ? html`<div class="session-menu">
              ${sessionAction("session-menu-btn session-share-btn", "share", s, true)}
              ${sessionAction("session-menu-btn session-archive-btn", "archive", s, true)}
              <button
                class="session-menu-btn"
                data-menu-id=${s.id}
                type="button"
                ${tip("Chat options")}
                aria-label=${`Options for ${sessionTitle(s)}`}
                aria-haspopup="menu"
                aria-expanded=${menuOpen ? "true" : "false"}
                @click=${(e: Event) => toggleSessionMenu(e, s.id)}
              >
                ${icon(EllipsisVertical, 15)}
              </button>
              ${menuOpen ? sessionMenuPopover(s) : nothing}
            </div>`
          : nothing
      }
    </div>
  `;
}

let draggingChildId: string | null = null;

export function onSessionDragStart(e: DragEvent, s: CoreSession): void {
  if (!s.id) {
    e.preventDefault();
    return;
  }
  e.dataTransfer?.setData("application/x-webui-session", s.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  draggingChildId = s.parentSessionId ? s.id : null;
  appState.listEl?.classList.toggle("detach-drop-target", Boolean(draggingChildId));
  if (!draggingChildId) beginSessionDrag(s);
}

export function endSessionDrag(): void {
  draggingChildId = null;
  appState.listEl?.classList.remove("detach-drop-target");
  appState.listEl?.querySelector(".detach-drop-zone")?.classList.remove("over");
  endPaneDrag();
}

async function promoteSession(id: string): Promise<void> {
  sessionsState.openMenuId = null;
  endSessionDrag();
  try {
    await detachSession(id);
    await refreshSessions({ silent: true });
  } catch (error) {
    canvasToast(errMessage(error));
    renderList();
  }
}

export function detachDropZone(): TemplateResult {
  return html`<div
    class="detach-drop-zone"
    @dragenter=${(e: DragEvent) => {
      if (!draggingChildId) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).classList.add("over");
    }}
    @dragover=${(e: DragEvent) => {
      if (!draggingChildId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    }}
    @dragleave=${(e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("over")}
    @drop=${(e: DragEvent) => {
      const id = draggingChildId;
      (e.currentTarget as HTMLElement).classList.remove("over");
      if (!id) return;
      e.preventDefault();
      endSessionDrag();
      void promoteSession(id);
    }}
  >
    ${icon(CornerLeftUp, 13)}<span>Drop to make a top-level session</span>
  </div>`;
}

function showsUnread(s: CoreSession): boolean {
  return Boolean(s.id && s.unread && (sessionsState.keptUnreadId === s.id || !openConversationIds().includes(s.id)));
}

function unreadDot(s: CoreSession): TemplateResult | typeof nothing {
  return showsUnread(s) ? html`<span class="unread-dot" role="img" aria-label="Unread"></span>` : nothing;
}

let chatsPageSeq = 0;
const freshChatsPage = () => ({
  rows: [] as CoreSession[],
  cursor: null as string | null,
  loading: false,
  queryTimer: null as ReturnType<typeof setTimeout> | null,
  scope: null as string | null,
  query: "",
  status: "active" as ChatBrowseStatus,
  surface: "all" as "all" | "web" | "slack",
  host: null as HTMLElement | null,
});
let chatsPage = freshChatsPage();

export function resetChatsPage(): void {
  chatsPageSeq++;
  if (chatsPage.queryTimer) clearTimeout(chatsPage.queryTimer);
  chatsPage = freshChatsPage();
}

function listWhen(ms: number): string {
  if (Date.now() - ms < 6 * 86_400_000) return relTime(ms);
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function moreButton(cls: string, label: string, loading: boolean, run: () => void): TemplateResult {
  return html`<button
    class=${cls}
    type="button"
    ?disabled=${loading}
    aria-busy=${loading ? "true" : "false"}
    @click=${run}
  >
    ${sheenLabel(label, loading)}
  </button>`;
}

export async function renderChatsPage(): Promise<void> {
  if (appState.currentView !== "chats") return;
  await ensureContexts();
  drawChatsPage();
  await loadChatsPage(false);
}

export function chatsPageShowing(): boolean {
  return Boolean(chatsPage.host && appState.mainEl && chatsPage.host.parentElement === appState.mainEl);
}

async function loadChatsPage(append: boolean): Promise<void> {
  if (append && !chatsPage.cursor) return;
  const seq = ++chatsPageSeq;
  chatsPage.loading = true;
  if (!append) chatsPage.cursor = null;
  drawChatsPage();
  try {
    const page = await fetchSessionPage({
      limit: SESSION_BATCH_SIZE,
      before: append ? chatsPage.cursor : null,
      status: chatsPage.status,
      scope: chatsPage.scope,
      q: chatsPage.query,
      ...(chatsPage.surface === "all" ? {} : { surface: chatsPage.surface }),
    });
    if (seq !== chatsPageSeq) return;
    chatsPage.rows = append ? [...chatsPage.rows, ...page.sessions] : [...(page.pinned ?? []), ...page.sessions];
    chatsPage.cursor = page.nextCursor;
    sessionsState.list = upsertSessions(sessionsState.list, [...(page.pinned ?? []), ...page.sessions]);
    sessionsState.notice = "";
  } catch (e) {
    if (seq !== chatsPageSeq) return;
    sessionsState.notice = errMessage(e, "Failed to load conversations.");
  } finally {
    if (seq === chatsPageSeq) {
      chatsPage.loading = false;
      drawChatsPage();
    }
  }
}

function reloadChatsPage(filter: Partial<Pick<typeof chatsPage, "scope" | "status" | "surface">> = {}): void {
  Object.assign(chatsPage, filter, { rows: [] });
  void loadChatsPage(false);
}

export function drawChatsPage(): void {
  if (appState.currentView !== "chats" || !appState.mainEl || splitState.active) return;
  mainConversation().state.host = null;
  if (!chatsPage.host || chatsPage.host.parentElement !== appState.mainEl) {
    chatsPage.host = Object.assign(document.createElement("div"), { className: "pane chats-page" });
    appState.mainEl.replaceChildren(chatsPage.host);
  }
  const cached = new Map(sessionsState.list.map((s) => [s.id, s]));
  const rows = chatsPage.rows
    .map((s) => cached.get(s.id) ?? s)
    .filter((s) => chatBrowseStatusMatches(s, chatsPage.status))
    .map((s) => chatPageRow(s));
  if (chatsPage.cursor)
    rows.push(
      html`<div class="list-footer">
        ${moreButton("btn", "Show more conversations", chatsPage.loading, () => void loadChatsPage(true))}
      </div>`,
    );
  let empty = "No conversations yet. Start a new chat.";
  if (chatsPage.loading && chatsPage.rows.length === 0) empty = "Loading conversations…";
  else if (chatsPage.scope || chatsPage.query.trim() || chatsPage.status !== "active" || chatsPage.surface !== "all") {
    empty = "No conversations match.";
  }
  render(
    listPageTpl({
      title: "Chats",
      scope: chatsPage.scope,
      onScope: (scope) => reloadChatsPage({ scope }),
      action: { label: "New chat", onClick: () => startNewChat() },
      search: {
        value: chatsPage.query,
        placeholder: "Search chats…",
        onInput: (v) => {
          chatsPage.query = v;
          if (chatsPage.queryTimer) clearTimeout(chatsPage.queryTimer);
          chatsPage.queryTimer = setTimeout(() => {
            chatsPage.queryTimer = null;
            reloadChatsPage();
          }, 250);
          drawChatsPage();
        },
      },
      filters: html`<div class="chat-filters">
        ${listTabs(
          "Conversation status",
          [
            { value: "active" as const, label: "Active" },
            { value: "waiting" as const, label: "Waiting" },
            { value: "archived" as const, label: "Archived" },
          ],
          chatsPage.status,
          (status) => reloadChatsPage({ status }),
        )}
        <div class="list-select">
          ${menuSelect({
            value: chatsPage.surface,
            ariaLabel: "Filter by surface",
            onSelect: (value) => reloadChatsPage({ surface: (value ?? "all") as typeof chatsPage.surface }),
            options: [
              { value: "all", label: "All surfaces" },
              { value: "web", label: "Web" },
              { value: "slack", label: "Slack" },
            ],
          })}
        </div>
      </div>`,
      rows,
      empty,
    }),
    chatsPage.host,
  );
}

function chatPageRow(s: CoreSession): TemplateResult {
  const readOnly = surfaceOf(s) !== "slack" && !s.canContinue;
  const color = displaySessionColor(s.color);
  return html`
    <div class="list-row chat-row ${color ? "colored" : ""}" style=${color ? `--session-color:${color}` : nothing}>
      <a
        class="chat-row-open"
        href=${deepLinkPath(UI_BASE, "chats", s.id)}
        @click=${(e: MouseEvent) => {
          if (!isPlainLeftClick(e)) return;
          e.preventDefault();
          void openSession(s);
        }}
      >
        <span class="list-row-title">${statusMarks(s)}<span dir="auto">${groupDmTitle(s)}</span></span>
        <span class="list-row-meta">
          ${unreadDot(s)} ${scopeChip(s.scopeId, s.channelName ?? null)}
          ${surfaceOf(s) === "slack" ? html`<span class="surface surface-slack">${slackMark(13, true)}</span>` : nothing}
          ${readOnly ? html`<span class="ro-lock" ${tip("Read-only")}>${icon(Lock, 12)}</span>` : nothing}
          <span class="list-row-date">${listWhen(activityOf(s))}</span>
          <span class="chat-row-arrow" aria-hidden="true">${icon(ChevronRight, 16)}</span>
        </span>
      </a>
      ${
        s.id
          ? html`<span class="chat-row-actions">
              ${sessionAction("icon-btn", "pin", s)} ${sessionAction("icon-btn", "share", s)}
              ${sessionAction("icon-btn", "archive", s)}
            </span>`
          : nothing
      }
    </div>
  `;
}
