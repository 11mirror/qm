import {
  ensureSentMail,
  openSentEmailById,
  resetSentMail,
  selectedSentEmail,
  sentEmailPageTpl,
  sentChatTpl,
  selectedSentChat,
} from "./sent-mail";
import { html, nothing, render, type TemplateResult } from "lit";
import { Inbox as InboxGlyph, PanelRightClose, PanelRightOpen } from "lucide";
import { api, ApiError } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import type { DensityTier } from "./density";
import { appState, can } from "./shell-state";
import { renderSidebarTop, switchView } from "./shell";
import { listBackLink } from "./list-page";
import { registerPaneKind } from "./pane-kinds";
import { exitSplitIfActive, notifyPanesChanged } from "./split";
import { tip } from "./tooltip";
import { relTime } from "./ui";
import { icon } from "./icons";
import { inboxChat } from "./inbox-chat";
import { readStorage, writeStorage } from "./drafts";
import {
  type LedgerItem,
  type InboxItem,
  inboxViewIdForSegment,
  freshInboxState,
  inboxState,
  type InboxSurface,
  surfaces,
  inboxViewName,
  inboxOpenCount,
  toInboxItem,
  inboxPage,
  notify,
  onInboxRedraw,
} from "./inbox-model";
import { ensurePolling, feedWindows, refreshInbox, upsertItem, ensureRealtime, ensureItemSource } from "./inbox-feed";
import { draftConflicts, draftEdits, acting, chatting, continueSentReply } from "./inbox-actions";
import { closeArchiveToast } from "./inbox-toast";
import { sourceGlyph, fmtClock, participantsTpl } from "./inbox-people";
import {
  reviewTpl,
  contextTpl,
  chatTpl,
  draftMessageTpl,
  itemSideMark,
  handledNoteTpl,
  dismissItemTpl,
} from "./inbox-item-view";
import {
  syncLineTpl,
  surfaceTpl,
  syncInboxUrl,
  showFullView,
  resetActiveInboxItem,
  selectInboxView,
} from "./inbox-surface";

export { resetActiveInboxItem, selectInboxView } from "./inbox-surface";

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
  } catch (error) {
    if (inboxPage.surface?.selectedId === id) inboxPage.surface.selectedId = null;
    if (!(error instanceof ApiError && error.status === 404))
      return notify(`Couldn't open this item: ${errMessage(error)}`);
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
