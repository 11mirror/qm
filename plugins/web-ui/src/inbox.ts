import {
  ensureSentMail,
  openSentEmail,
  openSentEmailById,
  isSentMailLoading,
  loadSentMail,
  resetSentMail,
  resetSelectedSentEmail,
  selectedSentEmail,
  sentEmailPageTpl,
  sentChatTpl,
  selectedSentChat,
  sentMailTpl,
} from "./sent-mail";
import { html, nothing, render, type TemplateResult } from "lit";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Inbox as InboxGlyph,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  X,
} from "lucide";
import { api } from "./core-bridge";
import type { DensityTier } from "./density";
import { deepLinkPath, UI_BASE } from "./deep-link";
import { appState, can } from "./shell-state";
import { renderSidebarTop, switchView } from "./shell";
import { listBackLink } from "./list-page";
import { registerPaneKind } from "./pane-kinds";
import { exitSplitIfActive, notifyPanesChanged } from "./split";
import { tip } from "./tooltip";
import { menuSelect, avatarTpl, relTime, sheenLabel, workingWave } from "./ui";
import { slackMark } from "./slack-mark";
import { icon } from "./icons";
import { inboxChat } from "./inbox-chat";
import { readStorage, writeStorage } from "./drafts";
import {
  type LedgerItem,
  type InboxItem,
  type InboxSyncCron,
  isInboxViewId,
  inboxViewIdForSegment,
  inboxViewSegment,
  INBOX_FILTERS,
  type InboxFilter,
  freshInboxState,
  inboxState,
  type InboxSurface,
  surfaces,
  inboxViews,
  inboxViewName,
  itemsFor,
  inboxOpenCount,
  toInboxItem,
  syncCrons,
  inboxPage,
  onInboxRedraw,
} from "./inbox-model";
import {
  ensurePolling,
  feedWindows,
  refreshInbox,
  loadDetail,
  selectInboxFilter,
  toggleSelection,
  upsertItem,
  ensureRealtime,
  ensureItemSource,
  setUpSync,
  syncNow,
} from "./inbox-feed";
import {
  draftConflicts,
  draftEdits,
  acting,
  chatting,
  continueSentReply,
  persistDraft,
  setItemStatus,
} from "./inbox-actions";
import { closeArchiveToast } from "./inbox-toast";
import {
  sourceIcon,
  sourceGlyph,
  fmtClock,
  participantName,
  participantKey,
  participantsOf,
  participantsTpl,
  slackTextTpl,
} from "./inbox-people";
import {
  reviewTpl,
  contextTpl,
  chatTpl,
  draftMessageTpl,
  itemSideMark,
  handledNoteTpl,
  dismissItemTpl,
} from "./inbox-item-view";

export function resetInboxState(): void {
  resetSentMail();
  closeArchiveToast();
  Object.assign(inboxState, freshInboxState());
  feedWindows.clear();
  draftEdits.clear();
  draftConflicts.clear();
  acting.clear();
  chatting.clear();
}

function itemRowTpl(surface: InboxSurface, item: InboxItem): TemplateResult {
  const inlineDetail = surface.pane;
  const open = surface.selectedId === item.id;
  const expanded = inlineDetail && open;
  const expandedAttr = inlineDetail ? String(open) : nothing;
  const handled = item.status !== "open";
  const gmail = item.source === "gmail";
  const slack = item.source === "slack";
  const senderId = item.slack?.userId ?? item.participants?.[0]?.key;
  const sender = item.participants?.find((person) => person.key === senderId) ?? {
    key: senderId ?? participantKey(item.from),
    name: participantName(item.from) || "Slack",
  };
  const heading = gmail ? item.from || item.title : (item.slack?.channelLabel ?? item.title);
  const sub = gmail ? item.title : item.from || inboxViewName(item.cronId);
  return html`
    <div class="inbox-item ${expanded ? "expanded" : ""} ${handled ? "handled" : ""} src-${item.source}">
      <div class="inbox-item-summary">
        <button
          class="inbox-item-row"
          type="button"
          aria-expanded=${expandedAttr}
          @click=${() => {
            const previous = surface.selectedId;
            if (previous && previous !== item.id) {
              const prevItem = inboxState.items.find((i) => i.id === previous);
              if (prevItem) void persistDraft(prevItem);
            }
            surface.selectedId = inlineDetail && open ? null : item.id;
            if (surface.selectedId) void loadDetail(item.id, item.cronId);
            if (!inlineDetail) syncInboxUrl(surface.selectedId, true);
            drawAll();
          }}
        >
          <span class="inbox-item-glyph ${slack ? "inbox-sender-avatar" : ""}">
            ${
              slack
                ? html`${participantsOf(item).length > 1 ? participantsTpl(item) : avatarTpl(sender)}<span
                      class="inbox-sender-badge"
                      aria-hidden="true"
                      >${slackMark(10)}</span
                    >`
                : sourceGlyph(item)
            }
          </span>
          <span class="inbox-item-main">
            <span class="inbox-item-top">
              <span class="inbox-item-heading">${heading}</span>
              <span class="inbox-item-sub">${sub}</span>
            </span>
            <span class="inbox-item-snippet">${slackTextTpl(item, item.snippet, { links: false })}</span>
          </span>
          <span class="inbox-item-side">
            ${slack ? nothing : participantsTpl(item)} ${itemSideMark(item, handled)}
            <span class="inbox-item-time" title=${fmtClock(item.receivedAt)}>${relTime(item.receivedAt)}</span>
            ${icon(expanded ? ChevronDown : ChevronRight, 13)}
          </span>
        </button>
        ${
          !handled
            ? html`<button
                class="session-menu-btn inbox-item-dismiss"
                type="button"
                aria-label=${`Archive ${item.title || heading}`}
                ${tip("Archive")}
                ?disabled=${acting.has(item.id)}
                @click=${() => void setItemStatus(item, "dismissed")}
              >
                ${icon(Archive, 13.5)}
              </button>`
            : nothing
        }
      </div>
      ${
        expanded
          ? html`<div class="inbox-item-detail">
              ${
                item.source === "generic"
                  ? reviewTpl(item)
                  : html`${handled ? nothing : html`<div class="inbox-item-detail-actions">${dismissItemTpl(item)}</div>`}
                    ${contextTpl(item)} ${draftMessageTpl(item)} ${handled ? handledNoteTpl(item) : chatTpl(item, true)}`
              }
            </div>`
          : nothing
      }
    </div>
  `;
}

function syncStatusLabel(cron: InboxSyncCron): string {
  if (!cron.enabled) return "Sync paused";
  return cron.lastFiredAt ? `Synced ${relTime(cron.lastFiredAt)}` : "First sync pending";
}

function syncActionTpl(opts: {
  label: string;
  busyLabel: string;
  busy: boolean;
  disabled?: boolean;
  tooltip: string;
  action: () => void;
}): TemplateResult {
  return html`<button
    class="btn inbox-sync-action"
    type="button"
    ${tip(opts.tooltip)}
    ?disabled=${opts.busy || opts.disabled}
    @click=${opts.action}
  >
    ${icon(RefreshCw, 13)}<span>${opts.busy ? opts.busyLabel : opts.label}</span>
  </button>`;
}

const ASSISTANT_HIDDEN_KEY = "web-ui:inbox-assistant-hidden";

let assistantHidden = readStorage(ASSISTANT_HIDDEN_KEY) === "1";

function assistantToggleTpl(): TemplateResult {
  const label = assistantHidden ? "Show assistant" : "Hide assistant";
  return html`<button
    class="icon-btn compact subtle inbox-assistant-toggle"
    type="button"
    aria-label=${label}
    aria-expanded=${String(!assistantHidden)}
    ${tip(label)}
    @click=${() => {
      assistantHidden = !assistantHidden;
      writeStorage(ASSISTANT_HIDDEN_KEY, assistantHidden ? "1" : "0");
      drawAll();
    }}
  >
    ${icon(assistantHidden ? PanelRightOpen : PanelRightClose, 17)}
  </button>`;
}

function syncLineTpl(surface: InboxSurface): TemplateResult | typeof nothing {
  if (surface.viewId === "sent") {
    const busy = isSentMailLoading();
    return syncActionTpl({
      label: "Refresh",
      busyLabel: "Refreshing…",
      busy,
      tooltip: "Refresh sent mail",
      action: () => void loadSentMail(drawAll),
    });
  }
  const crons = syncCrons(surface.viewId).flatMap((cron) => (cron.syncCron ? [cron.syncCron] : []));
  if (!crons.length) return nothing;
  const status =
    crons.length === 1 ? syncStatusLabel(crons[0]!) : `${crons.filter((cron) => cron.enabled).length} syncs on`;
  return html`<span class="inbox-sync-line">
    ${syncActionTpl({
      label: "Sync",
      busyLabel: "Syncing…",
      busy: inboxState.syncBusy,
      tooltip: "Sync now",
      action: () => void syncNow(surface.viewId),
    })}
    <span class="inbox-sync-status">${status}</span>
  </span>`;
}

const thenDraw = (change: () => unknown) => (): void => {
  change();
  drawAll();
};

function pickView(surface: InboxSurface, viewId: string): void {
  if (surface === inboxPage.surface) selectInboxView(viewId, true);
  else surface.viewId = viewId;
}

function surfaceTpl(surface: InboxSurface): TemplateResult {
  const density = surface.density();
  const compact = density !== "full";
  const allOpen = itemsFor(surface.viewId, "open");
  const resolvedItems = allOpen.filter((item) => item.source !== "gmail" && item.probablyResolved);
  const openItems = allOpen.filter((item) => item.source === "gmail" || !item.probablyResolved);
  const selectedCron = inboxState.selected.find((cron) => cron.id === surface.viewId);
  const showEmailFilter =
    surface.viewId === "all" ||
    surface.viewId === "gmail" ||
    selectedCron?.source === "gmail" ||
    selectedCron?.sources?.includes("gmail");
  let emptyMessage = "No messages in this view yet. Sync to check for new messages.";
  if (showEmailFilter && inboxState.filter === "triaged")
    emptyMessage = "Nothing is waiting on you. Choose Light filtering or All emails to see more emails.";
  if (surface.viewId === "sent") emptyMessage = "No sent messages yet. Sent Email and Slack replies will appear here.";
  const handledItems = itemsFor(surface.viewId, "handled");
  const hasMore = !!feedWindows.get(surface.viewId)?.nextCursor;
  const setupCrons = inboxState.selected.filter(
    (cron) =>
      cron.source &&
      cron.syncCron &&
      !cron.syncCron.enabled &&
      cron.syncCron.lastFiredAt === undefined &&
      (surface.viewId === cron.id || surface.viewId === "all"),
  );
  const chips = html`
    <div class="inbox-chips" role="tablist" aria-label="Inbox views">
      ${inboxViews().map((v) => {
        const count = inboxOpenCount(v.id);
        return html`<button
          class="inbox-chip ${surface.viewId === v.id ? "active" : ""}"
          type="button"
          role="tab"
          aria-selected=${surface.viewId === v.id ? "true" : "false"}
          @click=${thenDraw(() => {
            pickView(surface, v.id);
            void refreshInbox(feedWindows.has(v.id) ? { ifStaleMs: 30_000 } : {});
          })}
        >
          ${v.id === "all" ? nothing : sourceIcon(inboxState.selected.find((cron) => cron.id === v.id) ?? {})}<span>${v.name}</span>${count > 0 ? html`<span class="inbox-chip-count">${count}</span>` : nothing}
        </button>`;
      })}
      <button
        class="inbox-chip ${surface.viewId === "sent" ? "active" : ""}"
        type="button"
        role="tab"
        aria-selected=${surface.viewId === "sent"}
        @click=${thenDraw(() => {
          pickView(surface, "sent");
          ensureSentMail(drawAll);
        })}
      >
        Sent
      </button>
    </div>
    <div class="inbox-view-actions">
      <button
        class="icon-btn subtle compact inbox-add"
        type="button"
        aria-label="Add inbox"
        aria-expanded=${inboxState.picker}
        @click=${thenDraw(() => (inboxState.picker = !inboxState.picker))}
      >
        ${icon(Plus, 16)}
      </button>
      ${
        surface.viewId !== "all" && surface.viewId !== "sent"
          ? html`<button
              class="icon-btn subtle compact"
              aria-label=${`Options for ${inboxViewName(surface.viewId)}`}
              @click=${thenDraw(() => (inboxState.menuId = inboxState.menuId === surface.viewId ? null : surface.viewId))}
            >
              ${icon(MoreHorizontal, 16)}
            </button>`
          : nothing
      }
    </div>
  `;
  const list = html`
    ${
      !inboxState.loaded && inboxState.loading
        ? html`<div class="empty compact" role="status" aria-label="Reading your inbox…">
            <span aria-hidden="true">
              <span class="working-mark">${workingWave()}</span>${sheenLabel("Reading your inbox…", true)}
            </span>
          </div>`
        : nothing
    }
    ${
      inboxState.error && !inboxState.loaded
        ? html`<div class="empty compact">Couldn't load the inbox: ${inboxState.error}</div>`
        : nothing
    }
    ${
      inboxState.loaded && openItems.length === 0
        ? html`<div class="empty compact inbox-zero">${emptyMessage}</div>`
        : nothing
    }
    <div class="inbox-list">${openItems.map((i) => itemRowTpl(surface, i))}</div>
    ${
      resolvedItems.length
        ? html`<div class="inbox-resolved-sect">
            <div class="inbox-resolved-head">Probably resolved · no reply likely needed</div>
            <div class="inbox-list inbox-resolved-list">${resolvedItems.map((i) => itemRowTpl(surface, i))}</div>
          </div>`
        : nothing
    }
    ${
      handledItems.length
        ? html`
            <button
              class="inbox-handled-toggle"
              type="button"
              aria-expanded=${surface.showHandled ? "true" : "false"}
              @click=${thenDraw(() => (surface.showHandled = !surface.showHandled))}
            >
              ${icon(surface.showHandled ? ChevronDown : ChevronRight, 13)}
              <span>Handled (${handledItems.length})</span>
            </button>
            ${surface.showHandled ? html`<div class="inbox-list handled">${handledItems.map((i) => itemRowTpl(surface, i))}</div>` : nothing}${surface.showHandled && feedWindows.get(`handled:${surface.viewId}`)?.nextCursor ? html`<button class="inbox-load-more" type="button" ?disabled=${inboxState.loading} @click=${() => void refreshInbox({ more: true, viewId: `handled:${surface.viewId}` })}>Load more handled</button>` : nothing}
          `
        : nothing
    }
  `;
  return html`
    <div class="inbox-surface ${compact ? "compact" : ""}" data-density=${density}>
      <div class="inbox-toolbar">
        ${chips} ${surface.pane ? html`<span class="inbox-toolbar-spacer"></span>${syncLineTpl(surface)}` : nothing}
      </div>
      ${
        showEmailFilter || hasMore
          ? html`
              <div class="inbox-filter-bar">
                ${
                  showEmailFilter
                    ? html`<div class="inbox-filter">
                        <span>Emails</span>
                        ${menuSelect({
                          className: "inbox-email-filter-control",
                          ariaLabel: "Email filter",
                          ariaDescription: INBOX_FILTERS.find((filter) => filter.id === inboxState.filter)?.description,
                          value: inboxState.filter,
                          disabled: inboxState.filterBusy || inboxState.loading,
                          keyboardNavigation: true,
                          onSelect: (value) => void selectInboxFilter(value as InboxFilter),
                          options: INBOX_FILTERS.map((filter) => ({ value: filter.id, label: filter.label })),
                        })}
                      </div>`
                    : nothing
                }
                ${
                  hasMore
                    ? html`<button
                        class="inbox-load-more"
                        type="button"
                        ?disabled=${inboxState.loading}
                        @click=${() => void refreshInbox({ more: true, viewId: surface.viewId })}
                      >
                        Load more
                      </button>`
                    : nothing
                }
              </div>
            `
          : nothing
      }
      ${
        setupCrons.length
          ? html`<section class="inbox-setup" aria-label="Set up account sync">
              ${setupCrons.map(
                (cron) =>
                  html`<div class="inbox-setup-row">
                    <span class="inbox-setup-icon" aria-hidden="true">${sourceIcon(cron, 17)}</span>
                    <div class="inbox-setup-copy">
                      <span class="inbox-setup-title">${cron.name}</span
                      ><span class="inbox-setup-description">Sync not set up</span>
                    </div>
                    <button
                      class="inbox-setup-action"
                      aria-label=${`Set up ${cron.name}`}
                      ?disabled=${inboxState.syncBusy}
                      @click=${() => void setUpSync(cron.id)}
                    >
                      <span>${inboxState.syncBusy ? "Setting up…" : "Set up"}</span>${icon(ChevronRight, 14)}
                    </button>
                  </div>`,
              )}
            </section>`
          : nothing
      }
      ${
        inboxState.menuId
          ? html`<div class="inbox-view-menu" role="menu">
              <button
                class="btn"
                role="menuitem"
                @click=${() => {
                  const id = inboxState.menuId!;
                  inboxState.menuId = null;
                  void toggleSelection(id);
                }}
              >
                Remove from Inbox
              </button>
            </div>`
          : nothing
      }
      ${
        inboxState.picker
          ? html`<section class="inbox-picker" aria-label="Add inbox">
              <div class="inbox-draft-head">
                <strong>Inboxes</strong
                ><button
                  class="icon-btn"
                  aria-label="Close picker"
                  @click=${thenDraw(() => (inboxState.picker = false))}
                >
                  ${icon(X, 16)}
                </button>
              </div>
              <p>Choose the inboxes you want to review here.</p>
              ${inboxState.available.map((cron) => html`<label><input type="checkbox" .checked=${cron.selected} ?disabled=${inboxState.selectionBusy} @change=${() => void toggleSelection(cron.id)} />${sourceIcon(cron)}<span>${cron.name}</span><span>${cron.selected ? "Included" : "Add"}</span></label>`)}
            </section>`
          : nothing
      }
      ${inboxState.notice ? html`<div class="inbox-notice" role="status">${inboxState.notice}</div>` : nothing}
      <div class="inbox-scroll">
        ${
          surface.viewId === "sent"
            ? sentMailTpl(drawAll, (message) => {
                resetActiveInboxItem();
                if (surface.pane) {
                  exitSplitIfActive();
                  switchView("inbox");
                }
                inboxPage.viewId = "sent";
                if (inboxPage.surface) inboxPage.surface.selectedId = null;
                syncInboxUrl(message.id, true);
                void openSentEmail(message, drawAll);
              })
            : list
        }
      </div>
    </div>
  `;
}

function itemPageTpl(item: InboxItem): TemplateResult {
  const handled = item.status !== "open";
  const gmail = item.source === "gmail";
  let heading = item.slack?.channelLabel ?? item.title;
  if (gmail) heading = item.from || item.title;
  else if (item.source === "generic") heading = inboxViewName(item.cronId);
  const sub = gmail ? item.title : "";
  let detail: TemplateResult;
  if (!item.detailLoaded) detail = html`<div class="empty compact">Loading message…</div>`;
  else if (item.source === "generic") detail = reviewTpl(item, false);
  else detail = html`${contextTpl(item)} ${draftMessageTpl(item)} ${handled ? handledNoteTpl(item) : nothing}`;
  return html`
    <div class="pane-head inbox-item-head src-${item.source}">
      <div class="inbox-item-head-copy">
        ${listBackLink("Inbox", closeInboxItem)}
        <h1 class="pane-title">
          <span class="inbox-item-glyph">${sourceGlyph(item)}</span><span>${heading}</span>
          <span class="inbox-item-head-meta">
            ${participantsTpl(item)} ${itemSideMark(item, handled)}
            <span class="inbox-item-time" title=${fmtClock(item.receivedAt)}>${relTime(item.receivedAt)}</span>
          </span>
        </h1>
        ${sub ? html`<div class="pane-subtitle">${sub}</div>` : nothing}
      </div>
      ${dismissItemTpl(item)} ${item.detailLoaded ? assistantToggleTpl() : nothing}
    </div>
    <div class="inbox-surface inbox-item-surface">
      <div class="inbox-scroll inbox-item-thread">
        ${inboxState.notice ? html`<div class="inbox-notice" role="status">${inboxState.notice}</div>` : nothing}
        ${detail}
      </div>
    </div>
    ${
      item.detailLoaded && !assistantHidden
        ? html`<aside class="inbox-item-aside" aria-label="Conversation assistant">${chatTpl(item)}</aside>`
        : nothing
    }
  `;
}

function sentDraftTpl(): TemplateResult | undefined {
  const saved = selectedSentChat();
  if (!saved) return;
  const item = toInboxItem(saved);
  if (item.status === "open" && item.draft) return html`${draftMessageTpl(item)}`;
  if (item.status !== "open")
    return html`<div class="inbox-draft">
      <p>Reply sent.</p>
      <button class="btn" @click=${() => void continueSentReply(item)}>Write another reply</button>
    </div>`;
  return undefined;
}

function keepingChatLogsPinned(host: HTMLElement, draw: () => void): void {
  const logs = () => [...host.querySelectorAll<HTMLElement>(".inbox-chat-log")];
  const wasAtBottom = logs().map((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  draw();
  logs().forEach((el, i) => {
    if (wasAtBottom[i] ?? true) el.scrollTop = el.scrollHeight;
  });
}

function drawSurface(surface: InboxSurface): void {
  if (!can("inbox")) {
    render(nothing, surface.host);
    return;
  }
  if (!surface.host.isConnected && surface.pane) return;
  keepingChatLogsPinned(surface.host, () => render(surfaceTpl(surface), surface.host));
  const selected = inboxState.items.find((item) => item.id === surface.selectedId);
  if (selected) ensureItemSource(selected);
}

let pendingItemId: string | null = null;

let loadingDeepLink = false;

async function loadDeepLink(id: string): Promise<void> {
  try {
    const result = await api<{ item: LedgerItem }>(`/api/inbox?itemId=${encodeURIComponent(id)}`);
    upsertItem({ ...toInboxItem(result.item), detailLoaded: true });
  } catch {
    if (inboxPage.surface?.selectedId === id) inboxPage.surface.selectedId = null;
    inboxPage.viewId = "sent";
    await openSentEmailById(id, drawAll);
  } finally {
    loadingDeepLink = false;
    drawAll();
  }
}

function drawFull(): void {
  if (!can("inbox") || appState.currentView !== "inbox" || !appState.mainEl) return;
  if (
    !inboxPage.surface ||
    !inboxPage.surface.host.isConnected ||
    inboxPage.surface.host.parentElement !== appState.mainEl
  ) {
    const host = document.createElement("div");
    host.className = "pane inbox-page content-wide-page";
    inboxPage.surface = {
      host,
      viewId: inboxPage.viewId,
      pane: false,
      density: () => "full" as DensityTier,
      selectedId: inboxPage.surface?.selectedId ?? null,
      showHandled: inboxPage.surface?.showHandled ?? false,
    };
    appState.mainEl.replaceChildren(host);
  }
  inboxPage.surface.viewId = inboxPage.viewId;
  if (pendingItemId) {
    inboxPage.surface.selectedId = pendingItemId;
    pendingItemId = null;
  }
  const openItem = inboxPage.surface.selectedId
    ? inboxState.items.find((i) => i.id === inboxPage.surface?.selectedId)
    : undefined;
  const openSentEmail = selectedSentEmail();
  if (inboxPage.surface.selectedId && !openItem?.detailLoaded && inboxState.loaded && !loadingDeepLink) {
    loadingDeepLink = true;
    void loadDeepLink(inboxPage.surface.selectedId);
  }
  syncInboxUrl(openSentEmail?.id ?? inboxPage.surface.selectedId);
  const host = inboxPage.surface.host;
  host.classList.toggle("inbox-thread-page", Boolean(openItem?.detailLoaded) && !assistantHidden);
  const surface = inboxPage.surface;
  let page: TemplateResult | typeof nothing;
  if (openItem) page = itemPageTpl(openItem);
  else if (openSentEmail) {
    page = sentEmailPageTpl(
      drawAll,
      sentChatTpl(drawAll, (item) => chatTpl(toInboxItem(item))),
      sentDraftTpl(),
      closeInboxItem,
    );
  } else
    page = html`
      <div class="inbox-index-layout">
        <div class="inbox-index-feed">
          <div class="pane-head">
            <h1 class="pane-title">Inbox</h1>
            <div class="pane-head-actions">${syncLineTpl(surface)} ${assistantToggleTpl()}</div>
          </div>
          ${surfaceTpl(surface)}
        </div>
        ${
          assistantHidden
            ? nothing
            : inboxChat({
                kind: "inbox",
                hasEmail: selectedHas("gmail"),
                hasSlack: selectedHas("slack"),
                hasDrafts: inboxState.items.some((item) => Boolean(item.draft) && item.status === "open"),
              })
        }
      </div>
    `;
  keepingChatLogsPinned(host, () => render(page, host));
  if (openItem) ensureItemSource(openItem);
}

function selectedHas(source: string): boolean {
  return inboxState.selected.some((cron) => cron.sources?.includes(source) || cron.source === source);
}

function syncInboxUrl(itemId: string | null, push = false): void {
  if (appState.currentView !== "inbox") return;
  const next = deepLinkPath(UI_BASE, "inbox", null, null, itemId ?? inboxViewSegment(inboxPage.viewId));
  if (`${location.pathname}${location.search}` === next) return;
  if (push) history.pushState(null, "", next);
  else history.replaceState(null, "", next);
}

export function resetActiveInboxItem(): void {
  const sent = selectedSentChat();
  if (sent) void persistDraft(toInboxItem(sent));
  resetSelectedSentEmail();
  const open = inboxPage.surface?.selectedId;
  if (!open || !inboxPage.surface) return;
  const item = inboxState.items.find((i) => i.id === open);
  if (item) void persistDraft(item);
  inboxPage.surface.selectedId = null;
}

function closeInboxItem(): void {
  resetActiveInboxItem();
  syncInboxUrl(null);
  if (inboxPage.viewId === "sent") ensureSentMail(drawAll);
  drawAll();
}

export function routeInboxHistory(segment: string | null): void {
  if (!can("inbox")) return;
  resetActiveInboxItem();
  const viewId = inboxViewIdForSegment(segment);
  pendingItemId = viewId ? null : segment;
  showFullView(viewId ?? "all", pendingItemId);
  if (viewId === "sent") ensureSentMail(drawAll);
  if (appState.currentView === "inbox") drawAll();
}

export function drawAll(): void {
  for (const s of surfaces) drawSurface(s);
  drawFull();
  renderSidebarTop();
  notifyPanesChanged();
}

export function selectInboxView(viewId: string, push = false): void {
  resetActiveInboxItem();
  showFullView(isInboxViewId(viewId) ? viewId : "all");
  syncInboxUrl(null, push);
}

function showFullView(viewId: string, selectedId: string | null = null): void {
  inboxPage.viewId = viewId;
  if (inboxPage.surface) {
    inboxPage.surface.viewId = viewId;
    inboxPage.surface.selectedId = selectedId;
  }
}

export async function renderInbox(): Promise<void> {
  ensurePolling();
  ensureRealtime();
  drawFull();
  await refreshInbox({ ifStaleMs: 30_000, silent: true });
}

export function mountInboxPane(opts: {
  host: HTMLElement;
  viewId: string;
  density: () => DensityTier;
  onDensityChange: (handler: () => void) => void;
}): { dispose: () => void } {
  const surface: InboxSurface = {
    host: opts.host,
    viewId: opts.viewId,
    pane: true,
    density: opts.density,
    selectedId: null,
    showHandled: false,
  };
  surfaces.add(surface);
  opts.host.classList.add("inbox-pane-host");
  opts.onDensityChange(() => drawSurface(surface));
  ensurePolling();
  ensureRealtime();
  drawSurface(surface);
  void refreshInbox({ ifStaleMs: 30_000, silent: true });
  return {
    dispose() {
      surfaces.delete(surface);
      opts.host.classList.remove("inbox-pane-host");
    },
  };
}

onInboxRedraw(drawAll);

registerPaneKind({
  paramsKey: "inboxView",
  glyph: InboxGlyph,
  title: (id) => inboxViewName(id),
  badge: (id) => (can("inbox") ? inboxOpenCount(id) : 0),
  mount: ({ host, id, density, onDensityChange }) => mountInboxPane({ host, viewId: id, density, onDensityChange }),
  maximize: (id) => {
    exitSplitIfActive();
    selectInboxView(id);
    switchView("inbox");
  },
});
