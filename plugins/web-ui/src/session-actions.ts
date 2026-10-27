import { openSessionShare } from "./session-share";
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { ref } from "lit/directives/ref.js";
import {
  Archive,
  Ban,
  ArchiveRestore,
  Link,
  Mail,
  MailOpen,
  Palette,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  X,
  type IconNode,
} from "lucide";
import { regenerateTitle, type CoreSession } from "./core-bridge";
import { sessionLink, UI_BASE } from "./deep-link";
import { tip } from "./tooltip";
import { iconBtn } from "./list-page";
import { swallow } from "../../chassis/src/errors";
import { copyText } from "./ui";
import { icon } from "./icons";
import { appState, renderSidebarTop } from "./shell";
import { canvasToast, closeSessionSurfaces } from "./split";
import { queueSessionPatch, sessionPatchEpoch, sessionPatchGeneration, type SessionPatch } from "./session-patches";
import { emptySelection } from "./session-select";
import {
  defaultSessionTitle,
  openConversationIds,
  refreshSessions,
  renderList,
  sessionTitle,
  sessionsState,
} from "./sessions";
import { drawChatsPage } from "./session-rows";

const SAVE_FAILED_NOTICE = "Couldn't save that change.";

export function clearSessionSelection(): boolean {
  if (!sessionsState.selection.ids.size && !sessionsState.selection.anchor) return false;
  sessionsState.selection = emptySelection();
  sessionsState.selectColorOpen = false;
  redrawSelection();
  return true;
}

export function redrawSelection(): void {
  renderList();
  renderSidebarTop();
}
export const refreshingTitleIds = new Set<string>();

export const placeSessionMenu = (el?: Element): void => {
  if (!(el instanceof HTMLElement)) return;
  el.classList.remove("drop-up");
  const margin = 8;
  const scrollport = el.closest(".list")?.getBoundingClientRect();
  const bottomLimit = Math.min(window.innerHeight, scrollport?.bottom ?? Infinity) - margin;
  const topLimit = Math.max(0, scrollport?.top ?? 0) + margin;
  const rect = el.getBoundingClientRect();
  const anchorTop = el.parentElement?.getBoundingClientRect().top ?? rect.top;
  if (rect.bottom > bottomLimit && anchorTop - 4 - rect.height >= topLimit) {
    el.classList.add("drop-up");
  }
};

const pinLabel = (s: Pick<CoreSession, "pinned">): string => (s.pinned ? "Unpin" : "Pin");
const archiveLabel = (s: Pick<CoreSession, "archived">): string => (s.archived ? "Unarchive" : "Archive");
const archiveGlyph = (s: Pick<CoreSession, "archived">): IconNode => (s.archived ? ArchiveRestore : Archive);

type SessionAction = "pin" | "share" | "archive";

export function sessionAction(cls: string, action: SessionAction, s: CoreSession, inSidebar = false): TemplateResult {
  const looks: Record<SessionAction, [string, string, IconNode, () => void]> = {
    pin: [pinLabel(s), pinLabel(s), s.pinned ? PinOff : Pin, () => setPinned(s, !s.pinned)],
    share: ["Share conversation", "Share", Link, () => void openSessionShare(s.id)],
    archive: [archiveLabel(s), archiveLabel(s), archiveGlyph(s), () => setArchived(s, !s.archived)],
  };
  const [hint, verb, glyph, run] = looks[action];
  const click = (e: Event) => {
    if (inSidebar) e.stopPropagation();
    run();
    if (!inSidebar) drawChatsPage();
  };
  return iconBtn(hint, glyph, click, { aria: `${verb} ${sessionTitle(s)}`, cls, size: 13.5 });
}

export function menuOption(glyph: IconNode, label: string, run: () => void, disabled = false): TemplateResult {
  return html`<button class="session-menu-option" type="button" role="menuitem" ?disabled=${disabled} @click=${run}>
    ${icon(glyph, 15)}<span>${label}</span>
  </button>`;
}

export function sessionMenuPopover(s: CoreSession): TemplateResult {
  const refreshing = refreshingTitleIds.has(s.id);
  return html`
    <div class="session-menu-popover" role="menu" ${ref(placeSessionMenu)} @click=${(e: Event) => e.stopPropagation()}>
      ${menuOption(Link, "Copy link", () => void copySessionLink(s))}
      ${menuOption(s.unread ? MailOpen : Mail, s.unread ? "Mark as read" : "Mark as unread", () => setUnread(s, !s.unread))}
      ${menuOption(s.pinned ? PinOff : Pin, pinLabel(s), () => setPinned(s, !s.pinned))}
      ${menuOption(Pencil, "Rename", () => startRename(s))}
      ${menuOption(RefreshCw, refreshing ? "Refreshing title" : "Refresh title", () => void refreshSessionTitle(s), refreshing)}
      ${menuOption(archiveGlyph(s), archiveLabel(s), () => setArchived(s, !s.archived))} ${sessionColorRow(s)}
    </div>
  `;
}

const SESSION_COLORS = ["#f43f5e", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899"] as const;
const LEGACY_SESSION_COLORS = new Map([
  ["#ef4444", SESSION_COLORS[0]],
  ["#f59e0b", SESSION_COLORS[1]],
  ["#22c55e", SESSION_COLORS[2]],
  ["#3b82f6", SESSION_COLORS[3]],
  ["#a855f7", SESSION_COLORS[4]],
  ["#ec4899", SESSION_COLORS[5]],
]);

export function displaySessionColor(color: string | null | undefined): string | null {
  if (!color) return null;
  const normalized = color.toLowerCase();
  return LEGACY_SESSION_COLORS.get(normalized) ?? normalized;
}

function sessionColorRow(s: CoreSession): TemplateResult {
  const current = displaySessionColor(s.color);
  const isPreset = SESSION_COLORS.includes(current as (typeof SESSION_COLORS)[number]);
  return html`
    <div class="session-menu-colors" role="group" aria-label="Row color">
      ${SESSION_COLORS.map(
        (c) => html`
          <button
            class="color-swatch ${current === c ? "selected" : ""}"
            type="button"
            style=${`--swatch:${c}`}
            aria-label=${`Color row ${c}`}
            aria-pressed=${current === c ? "true" : "false"}
            @click=${() => setColor(s, current === c ? null : c)}
          ></button>
        `,
      )}
      <label class="color-swatch custom ${current && !isPreset ? "selected" : ""}" ${tip("Custom color (RGB picker)")}>
        <input
          type="color"
          aria-label="Custom row color"
          value=${current ?? SESSION_COLORS[3]}
          @click=${(e: Event) => e.stopPropagation()}
          @input=${(e: InputEvent) => previewColor(s, (e.currentTarget as HTMLInputElement).value)}
          @change=${(e: Event) => setColor(s, (e.currentTarget as HTMLInputElement).value)}
        />
      </label>
      ${
        current
          ? html`<button
              class="color-swatch clear"
              type="button"
              ${tip("Clear color")}
              aria-label="Clear row color"
              @click=${() => setColor(s, null)}
            >
              ${icon(X, 12)}
            </button>`
          : nothing
      }
    </div>
  `;
}

export function renameRow(s: CoreSession): TemplateResult {
  return html`<div class="session-row renaming">
    ${renameInput(s.id, "Rename conversation", (next) => commitRename(s, next))}
  </div>`;
}

export function renameInput(
  menuKey: string,
  ariaLabel: string,
  commit: (next: string) => Promise<void>,
): TemplateResult {
  const finish = (): void => {
    if (sessionsState.renamingId !== menuKey) return;
    const next = sessionsState.renameDraft.trim();
    sessionsState.renamingId = null;
    sessionsState.renameDraft = "";
    renderList();
    void commit(next);
  };
  return html`
    <input
      class="session-rename-input"
      aria-label=${ariaLabel}
      .value=${live(sessionsState.renameDraft)}
      @input=${(e: InputEvent) => {
        sessionsState.renameDraft = (e.currentTarget as HTMLInputElement).value;
      }}
      @keydown=${(e: KeyboardEvent) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") {
          e.preventDefault();
          finish();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelRename(menuKey);
        }
      }}
      @blur=${finish}
      @click=${(e: Event) => e.stopPropagation()}
    />
  `;
}

async function copySessionLink(s: CoreSession): Promise<void> {
  sessionsState.openMenuId = null;
  renderList();
  await copyText(sessionLink(location.origin, UI_BASE, s.id));
}

export function toggleSessionMenu(e: Event, id: string): void {
  e.stopPropagation();
  sessionsState.openMenuId = sessionsState.openMenuId === id ? null : id;
  renderList();
}

export function startRename(s: CoreSession): void {
  beginRename(s.id, sessionTitle(s));
}

export function beginRename(key: string, draft: string): void {
  sessionsState.openMenuId = null;
  sessionsState.renamingId = key;
  sessionsState.renameDraft = draft;
  renderList();
  requestAnimationFrame(() => {
    const input = appState.listEl?.querySelector<HTMLInputElement>(".session-rename-input");
    if (!input) return;
    input.focus();
    input.select();
  });
}

function focusSessionMenuButton(menuKey: string): void {
  requestAnimationFrame(() => {
    const buttons = appState.listEl?.querySelectorAll<HTMLButtonElement>(".session-menu-btn") ?? [];
    [...buttons].find((button) => button.dataset.menuId === menuKey)?.focus();
  });
}

function cancelRename(menuKey: string): void {
  sessionsState.renamingId = null;
  sessionsState.renameDraft = "";
  renderList();
  focusSessionMenuButton(menuKey);
}

export function closeOpenSessionMenu(): boolean {
  const menuKey = sessionsState.openMenuId;
  if (!menuKey) return false;
  sessionsState.openMenuId = null;
  renderList();
  focusSessionMenuButton(menuKey);
  return true;
}

async function commitRename(s: CoreSession, next: string): Promise<void> {
  const resolved = (s.title ?? "").trim();
  if (next === resolved) return;
  const desired = !next || next === defaultSessionTitle(s) ? null : next;
  if (desired === null && !resolved) return;
  await persistSessionPatch(s.id, { title: desired });
}

export function archiveSessionById(sessionId: string): void {
  const s = sessionsState.list.find((x) => x.id === sessionId);
  if (s && !s.archived) {
    setArchived(s, true);
    return;
  }
  closeSessionSurfaces(sessionId);
  if (!s) void persistSessionPatch(sessionId, { archived: true });
}

export function sessionSelectionBar(): TemplateResult | null {
  const n = sessionsState.selection.ids.size;
  if (!n) return null;
  const rows = sessionsState.list.filter((s) => sessionsState.selection.ids.has(s.id));
  const allArchived = rows.length > 0 && rows.every((s) => s.archived);
  const allPinned = rows.length > 0 && rows.every((s) => s.pinned);
  const bulk = (verb: string, glyph: IconNode, patch: SessionPatch) =>
    iconBtn(`${verb} selected`, glyph, () => void bulkPatch(patch), { aria: `${verb} selected conversations` });
  return html`
    <div
      class="section-label recents-label multi-select-bar"
      role="toolbar"
      aria-label=${`${n} conversations selected`}
    >
      <span class="multi-select-summary">
        ${iconBtn("Clear selection (Esc)", X, () => clearSessionSelection(), { aria: "Clear selection" })}
        <span class="multi-select-count">${n} selected</span>
      </span>
      <span class="multi-select-actions">
        ${bulk(allPinned ? "Unpin" : "Pin", allPinned ? PinOff : Pin, { pinned: !allPinned })}
        <span class="multi-select-color">
          <button
            class="icon-btn"
            type="button"
            ${tip("Color selected")}
            aria-label="Color selected conversations"
            aria-haspopup="true"
            aria-expanded=${sessionsState.selectColorOpen ? "true" : "false"}
            @click=${(e: Event) => {
              e.stopPropagation();
              sessionsState.selectColorOpen = !sessionsState.selectColorOpen;
              renderSidebarTop();
            }}
          >
            ${icon(Palette, 14)}
          </button>
        </span>
        ${bulk(archiveLabel({ archived: allArchived }), archiveGlyph({ archived: allArchived }), { archived: !allArchived })}
      </span>
      ${sessionsState.selectColorOpen ? colorPopover() : nothing}
    </div>
  `;
}

export function closeSessionSelectionColor(): boolean {
  if (!sessionsState.selectColorOpen) return false;
  sessionsState.selectColorOpen = false;
  renderSidebarTop();
  return true;
}

function colorPopover(): TemplateResult {
  return html`
    <div
      class="session-menu-popover multi-select-color-popover"
      role="menu"
      @click=${(e: Event) => e.stopPropagation()}
    >
      <div class="session-menu-colors" role="group" aria-label="Color selected conversations">
        ${SESSION_COLORS.map(
          (c) => html`
            <button
              class="color-swatch"
              type="button"
              style=${`--swatch:${c}`}
              ${tip(`Color selected ${c}`)}
              aria-label=${`Color selected conversations ${c}`}
              @click=${() => void bulkPatch({ color: c })}
            ></button>
          `,
        )}
        <button
          class="color-swatch clear"
          type="button"
          ${tip("Clear color")}
          aria-label="Clear color on selected conversations"
          @click=${() => void bulkPatch({ color: null })}
        >
          ${icon(Ban, 10)}
        </button>
      </div>
    </div>
  `;
}

async function bulkPatch(patch: SessionPatch): Promise<void> {
  const generation = sessionPatchGeneration();
  const ids = [...sessionsState.selection.ids];
  sessionsState.selectColorOpen = false;
  if (patch.archived !== undefined) sessionsState.selection = emptySelection();
  if (patch.archived) for (const id of ids) closeSessionSurfaces(id);
  sessionsState.list = sessionsState.list.map((s) => (ids.includes(s.id) ? { ...s, ...patch } : s));
  redrawSelection();
  const patches = ids.map((id) => queueSessionPatch(id, patch, applyResolvedSession));
  const results = await Promise.allSettled(patches);
  if (sessionPatchGeneration() === generation && results.some((r) => r.status === "rejected")) {
    canvasToast(SAVE_FAILED_NOTICE);
    await refreshSessions({ silent: true, patchEpoch: sessionPatchEpoch() });
  }
  redrawSelection();
}

function setArchived(s: CoreSession, archived: boolean): void {
  sessionsState.openMenuId = null;
  if (archived && s.id) closeSessionSurfaces(s.id);
  void persistSessionPatch(s.id, { archived });
}

function setUnread(s: CoreSession, unread: boolean): void {
  sessionsState.openMenuId = null;
  sessionsState.keptUnreadId = unread && openConversationIds().includes(s.id) ? s.id : null;
  void persistSessionPatch(s.id, { unread });
}

export function markOpenSessionsRead(): void {
  const open = new Set(openConversationIds());
  for (const s of sessionsState.list) {
    if (s.unread && open.has(s.id) && s.id !== sessionsState.keptUnreadId)
      void persistSessionPatch(s.id, { unread: false });
  }
}

function setPinned(s: CoreSession, pinned: boolean): void {
  sessionsState.openMenuId = null;
  void persistSessionPatch(s.id, { pinned });
}

function previewColor(s: CoreSession, color: string): void {
  sessionsState.list = sessionsState.list.map((x) => (x.id === s.id ? { ...x, color } : x));
  renderList();
}

function setColor(s: CoreSession, color: string | null): void {
  void persistSessionPatch(s.id, { color });
}

function applyResolvedSession(updated: CoreSession): void {
  sessionsState.list = sessionsState.list.map((s) =>
    s.id === updated.id
      ? {
          ...s,
          ...updated,
          title: updated.title ?? null,
          archived: Boolean(updated.archived),
          pinned: Boolean(updated.pinned),
          color: updated.color ?? null,
          unread: Boolean(updated.unread),
        }
      : s,
  );
}

async function refreshSessionTitle(s: CoreSession): Promise<void> {
  sessionsState.openMenuId = null;
  if (refreshingTitleIds.has(s.id)) {
    renderList();
    return;
  }
  refreshingTitleIds.add(s.id);
  renderList();
  try {
    const refreshed = await regenerateTitle(s.id);
    if (refreshed.title && !(s.title && s.title.trim())) {
      sessionsState.list = sessionsState.list.map((row) =>
        row.id === s.id ? { ...row, title: refreshed.title } : row,
      );
    }
    renderList();
  } catch (e) {
    swallow("web-ui: regenerate session title", e);
  } finally {
    await refreshSessions({ silent: true });
    refreshingTitleIds.delete(s.id);
    renderList();
  }
}

async function persistSessionPatch(id: string, patch: SessionPatch): Promise<void> {
  const generation = sessionPatchGeneration();
  sessionsState.list = sessionsState.list.map((s) => (s.id === id ? { ...s, ...patch } : s));
  renderList();
  const request = queueSessionPatch(id, patch, applyResolvedSession);
  try {
    await request;
    renderList();
  } catch (e) {
    swallow("web-ui: save session change", e);
    if (sessionPatchGeneration() !== generation) return;
    canvasToast(SAVE_FAILED_NOTICE);
    await refreshSessions({ silent: true, patchEpoch: sessionPatchEpoch() });
  }
}
