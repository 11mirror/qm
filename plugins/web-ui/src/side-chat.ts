import { forkCutSeq } from "./transcript-messages";
import type { Item } from "./items";
import "./side-chat.css";
import { passageOccurrence, passageRange } from "./passage-range";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { ArrowUpRight, Maximize2, Minimize2, MessageSquare, X } from "lucide";
import { tip } from "./tooltip";
import { waveLoader } from "./ui";
import { api, forkSession, type CoreSession } from "./core-bridge";
import { createConversation, disposeConversation, ensureDeliveryStream } from "./conversations";
import { openSession, openSessionInto, refreshSessions } from "./sessions";
import type { Conversation, ConvCtx } from "./conv-types";
import { messageEntrySeqs } from "./message-link";
import { icon } from "./icons";
import { errMessage } from "../../chassis/src/errors";
import { reportHandledError } from "./browser-errors";

export function createSideChatController(ctx: ConvCtx) {
  return new SideChatController(ctx);
}

class SideChatController {
  ctx: ConvCtx;
  constructor(ctx: ConvCtx) {
    this.ctx = ctx;
  }
  sourceId: string | null = null;
  chats: CoreSession[] = [];
  selected: { index: number; quote: string; occurrence: number; left: number; top: number } | null = null;
  active: CoreSession | null = null;
  conversation: Conversation | null = null;
  panel: HTMLElement | null = null;
  busy = false;
  maximized = false;
  includeExcerpt = true;
  cardLeft = 16;
  cardTop = 16;
  moved = false;
  drag: { x: number; y: number; left: number; top: number } | null = null;
  error = "";
  epoch = 0;
  redraw = () => this.ctx.chat.drawActiveChat();
  panelId = `side-chat-${crypto.randomUUID()}`;
  returnFocus: HTMLElement | null = null;
  anchors = new Map<HTMLElement, { session: CoreSession; range: Range }[]>();
  observedRows = new Map<HTMLElement, HTMLElement>();
  hovered: string | undefined;
  choices = new Set<string>();
  highlightResize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.paintHighlights());
  paintHighlights = () => {
    for (const [host, entries] of this.anchors) {
      if (!host.isConnected) {
        this.highlightResize?.unobserve(host);
        const row = this.observedRows.get(host);
        if (row) this.highlightResize?.unobserve(row);
        this.observedRows.delete(host);
        this.anchors.delete(host);
        continue;
      }
      const origin = host.getBoundingClientRect();
      const shapes = entries.flatMap(({ session, range }) => {
        const lines: Array<{ left: number; right: number; top: number; bottom: number }> = [];
        for (const rect of Array.from(range.getClientRects?.() ?? [])) {
          if (!rect.width || !rect.height) continue;
          const line = lines.find(
            (line) => Math.abs(line.top - rect.top) < 3 && rect.left <= line.right + 2 && rect.right >= line.left - 2,
          );
          if (line) {
            line.left = Math.min(line.left, rect.left);
            line.right = Math.max(line.right, rect.right);
            line.bottom = Math.max(line.bottom, rect.bottom);
          } else lines.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
        }
        return lines.map((line, index) => ({ session, index, line }));
      });
      const existing = new Map(
        Array.from(host.querySelectorAll<HTMLElement>(".side-chat-highlight")).map((element) => [
          element.dataset.key,
          element,
        ]),
      );
      for (const { session, index, line } of shapes) {
        const key = `${session.id}:${index}`;
        const element = existing.get(key) ?? document.createElement("span");
        element.dataset.key = key;
        element.className = `side-chat-highlight${session.id === this.active?.id ? " active" : ""}${session.id === this.hovered ? " hovered" : ""}`;
        element.setAttribute("aria-hidden", "true");
        element.style.left = `${line.left - origin.left - 3}px`;
        element.style.top = `${line.top - origin.top - 1}px`;
        element.style.width = `${line.right - line.left + 6}px`;
        element.style.height = `${line.bottom - line.top + 2}px`;
        if (!element.isConnected) host.append(element);
        existing.delete(key);
      }
      for (const element of existing.values()) element.remove();
    }
  };
  anchorsAt = (event: MouseEvent) => {
    return [...this.anchors.values()]
      .flat()
      .filter(({ range }) =>
        [...range.getClientRects()].some(
          (rect) =>
            event.clientX >= rect.left - 3 &&
            event.clientX <= rect.right + 3 &&
            event.clientY >= rect.top - 1 &&
            event.clientY <= rect.bottom + 1,
        ),
      );
  };
  dismissSelection = () => {
    if ((!this.selected && !this.choices.size) || this.busy) return;
    this.selected = null;
    this.choices.clear();
    this.redraw();
  };
  dismiss = () => {
    const target = this.returnFocus;
    this.close();
    this.redraw();
    if (target?.isConnected) target.focus({ preventScroll: true });
    else this.ctx.composer.focusComposerEnd();
  };
  onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (this.selected || this.choices.size) {
      event.preventDefault();
      event.stopPropagation();
      this.dismissSelection();
    }
  };
  panelKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.conversation?.composer.closeMenus()) this.conversation.drawActiveChat();
    else this.dismiss();
  };
  outsidePointerDown = (event: Event) => {
    const card = this.panel?.closest(".side-chat-panel");
    if (!card || event.composedPath().includes(card)) return;
    this.close();
    this.redraw();
  };
  close = () => {
    document.removeEventListener("pointerdown", this.outsidePointerDown, true);
    this.epoch++;
    this.busy = false;
    this.choices.clear();
    this.drag = null;
    this.moved = false;
    if (this.conversation) disposeConversation(this.conversation);
    this.conversation = null;
    this.active = null;
    this.panel = null;
    this.selected = null;
  };
  sync = () => {
    const id = this.ctx.chat.state.sessionId;
    if (id === this.sourceId) return;
    this.close();
    this.sourceId = id;
    this.highlightResize?.disconnect();
    this.observedRows.clear();
    for (const host of this.anchors.keys())
      host.querySelectorAll(".side-chat-highlight").forEach((element) => element.remove());
    this.anchors.clear();
    this.paintHighlights();
    this.chats = [];
    this.error = "";
    this.busy = false;
    if (!id) return;
    void api<{ sessions: CoreSession[] }>(`/api/sessions/${encodeURIComponent(id)}/side-chats`).then(
      (result) => {
        if (this.sourceId !== id) return;
        this.chats = result.sessions ?? [];
        this.redraw();
      },
      (cause) => {
        reportHandledError("web:side_chat_list", cause);
        if (this.sourceId !== id) return;
        this.error = errMessage(cause, "Could not load side chats.");
        this.redraw();
      },
    );
  };
  select = (event: Event) => {
    if (event.target instanceof Element && event.target.closest("button, textarea, input, [contenteditable]")) return;
    const selection = window.getSelection();
    const host = event.currentTarget as HTMLElement;
    if (this.busy) return;
    if (
      !selection ||
      selection.isCollapsed ||
      !selection.rangeCount ||
      (event instanceof KeyboardEvent && event.key === "Escape")
    ) {
      this.dismissSelection();
      if (event instanceof MouseEvent && event.type === "mouseup" && selection?.isCollapsed) {
        const matching = this.anchorsAt(event);
        const anchor = matching[0];
        if (anchor) {
          this.returnFocus = anchor.range.startContainer.parentElement?.closest<HTMLElement>(".message-row") ?? null;
          if (this.returnFocus) this.returnFocus.tabIndex = -1;
          if (matching.length > 1) {
            this.choices = new Set(matching.map(({ session }) => session.id));
            this.redraw();
          } else void this.show(anchor.session);
        }
      }
      return;
    }
    const range = selection.getRangeAt(0);
    const element = range.startContainer.parentElement;
    const row = element?.closest<HTMLElement>(".message-row[data-index]");
    if (
      !row ||
      !host.contains(row) ||
      !row.contains(range.endContainer) ||
      element?.closest("button, textarea, input, [contenteditable]")
    )
      return this.dismissSelection();
    const messages = [...this.ctx.chat.state.inheritedMessages, ...(this.ctx.chat.state.agent?.state.messages ?? [])];
    const index = Number(row.dataset.index) + this.ctx.chat.state.inheritedMessages.length;
    const quote = selection.toString().trim();
    if (index < 0 || !quote || !messages[index]) return this.dismissSelection();
    const occurrence = passageOccurrence(row, range, quote);
    if (occurrence === null) return this.dismissSelection();
    const bounds = range.getBoundingClientRect();
    const layout = host.closest(".side-chat-layout")?.getBoundingClientRect();
    if (!layout) return this.dismissSelection();
    const top = bounds.top - layout.top;
    this.returnFocus = row;
    row.tabIndex = -1;
    this.selected = {
      index,
      quote,
      occurrence,
      left: Math.max(8, Math.min(bounds.left - layout.left, layout.width - 200)),
      top: top >= 46 ? top - 40 : bounds.bottom - layout.top + 8,
    };
    this.error = "";
    this.redraw();
  };
  startDrag = (event: PointerEvent) => {
    if (this.maximized || event.button !== 0 || (event.target as Element).closest("button")) return;
    const header = event.currentTarget as HTMLElement;
    const card = header.closest<HTMLElement>(".side-chat-panel")!;
    const layout = card.parentElement!.getBoundingClientRect();
    const bounds = card.getBoundingClientRect();
    this.drag = { x: event.clientX, y: event.clientY, left: bounds.left - layout.left, top: bounds.top - layout.top };
    header.setPointerCapture(event.pointerId);
    event.preventDefault();
    card.classList.add("dragging");
  };
  moveDrag = (event: PointerEvent) => {
    if (!this.drag) return;
    const header = event.currentTarget as HTMLElement;
    const card = header.closest<HTMLElement>(".side-chat-panel")!;
    const layout = card.parentElement!.getBoundingClientRect();
    const bounds = card.getBoundingClientRect();
    this.cardLeft = Math.max(
      12,
      Math.min(this.drag.left + event.clientX - this.drag.x, layout.width - bounds.width - 12),
    );
    this.cardTop = Math.max(
      12,
      Math.min(this.drag.top + event.clientY - this.drag.y, layout.height - bounds.height - 12),
    );
    this.moved = true;
    card.style.setProperty("--side-chat-left", `${this.cardLeft}px`);
    card.style.setProperty("--side-chat-top", `${this.cardTop}px`);
  };
  endDrag = (event: PointerEvent) => {
    this.drag = null;
    const header = event.currentTarget as HTMLElement;
    header.closest(".side-chat-panel")?.classList.remove("dragging");
    if (header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId);
  };
  positionCard = () => {
    if (this.moved) return;
    const anchor = [...this.anchors.values()].flat().find((entry) => entry.session.id === this.active?.id);
    const row = anchor?.range.startContainer.parentElement;
    const layout = row?.closest(".side-chat-layout")?.getBoundingClientRect();
    const bounds = anchor?.range.getBoundingClientRect?.();
    if (!layout || !bounds) return;
    const width = Math.min(360, layout.width - 24);
    const messageBounds = row?.closest(".message-row")?.getBoundingClientRect();
    const beside = (messageBounds?.right ?? bounds.right) - layout.left + 20;
    this.cardLeft =
      beside + width <= layout.width - 12
        ? beside
        : Math.max(12, Math.min(bounds.left - layout.left, layout.width - width - 12));
    const top = beside + width <= layout.width - 12 ? bounds.top : bounds.bottom + 12;
    this.cardTop = Math.max(12, Math.min(top - layout.top, layout.height - Math.min(440, layout.height - 24) - 12));
  };
  show = async (session: CoreSession) => {
    this.close();
    this.active = session;
    this.includeExcerpt = true;
    document.addEventListener("pointerdown", this.outsidePointerDown, true);
    this.maximized = false;
    this.positionCard();
    const opening = this.epoch;
    this.redraw();
    await Promise.resolve();
    if (!this.panel || opening !== this.epoch) return;
    this.positionCard();
    this.redraw();
    const conv = createConversation(
      {
        pane: true,
        ownsUrl: false,
        container: () => this.panel,
        claimContainer: () => this.panel,
        visible: () => Boolean(this.panel?.isConnected),
        density: () => "full",
        onDensityChange: () => {},
        ensureDeliveryStream,
      },
      { placeholder: "Ask about…", includeSideChatExcerpt: () => this.includeExcerpt },
    );
    this.conversation = conv;
    try {
      await openSessionInto(conv, session);
      if (this.conversation === conv) conv.composer.focusComposerEnd();
    } catch (cause) {
      reportHandledError("web:side_chat_open", cause);
      if (opening !== this.epoch) return;
      this.error = errMessage(cause, "Could not open side chat.");
      this.redraw();
    }
  };
  discuss = async () => {
    if (!this.selected || !this.sourceId || this.busy) return;
    const anchor = this.selected;
    const id = this.sourceId;
    const messages = [...this.ctx.chat.state.inheritedMessages, ...(this.ctx.chat.state.agent?.state.messages ?? [])];
    this.busy = true;
    this.error = "";
    this.redraw();
    try {
      const { items } = await api<{ items: Item[] }>(`/api/sessions/${encodeURIComponent(id)}`);
      const floor = Math.max(
        this.ctx.chat.state.forkSession?.forkBoundarySeq ?? -1,
        (this.ctx.chat.state.transcriptAnchorSeq ?? 0) - 1,
      );
      const cut = forkCutSeq(items, messages, anchor.index, floor);
      const seq = messageEntrySeqs(messages[anchor.index]!)[0] ?? cut;
      if (cut === undefined || seq === undefined)
        throw new Error("This message is still saving. Try again in a moment.");
      const result = await forkSession(id, Math.max(cut, ...items.map((entry) => entry.seq ?? 0)), {
        entrySeq: seq,
        quote: anchor.quote,
        occurrence: anchor.occurrence,
      });
      if (this.sourceId !== id) return;
      this.chats = [...this.chats, result.session];
      this.ctx.composer.carryModelPick(this.ctx.chat.state.threadRef, result.session.threadRef);
      window.getSelection()?.removeAllRanges();
      await this.show(result.session);
    } catch (cause) {
      reportHandledError("web:side_chat_create", cause);
      if (this.sourceId === id) this.error = errMessage(cause, "Could not start side chat.");
    } finally {
      if (this.sourceId === id) {
        this.busy = false;
        this.redraw();
      }
    }
  };
  expand = async () => {
    if (!this.active || this.busy) return;
    this.busy = true;
    const session = this.active;
    const expanding = this.epoch;
    this.redraw();
    try {
      const result = session.sideChat?.expanded
        ? { session }
        : await api<{ session: CoreSession }>(`/api/sessions/${encodeURIComponent(session.id)}/expand`, {
            method: "POST",
          });
      if (expanding !== this.epoch) return;
      const expanded = { ...session, ...result.session };
      this.chats = this.chats.map((chat) => (chat.id === session.id ? expanded : chat));
      await refreshSessions({ silent: true });
      if (expanding !== this.epoch) return;
      this.close();
      await openSession(expanded);
    } catch (cause) {
      reportHandledError("web:side_chat_expand", cause);
      if (expanding !== this.epoch) return;
      this.error = errMessage(cause, "Could not expand side chat.");
    } finally {
      if (expanding === this.epoch) {
        this.busy = false;
        this.redraw();
      }
    }
  };
  onScroll = () => {
    this.dismissSelection();
    if (this.active) {
      this.positionCard();
      this.redraw();
    }
  };
  dispose = () => {
    this.close();
    for (const host of this.anchors.keys())
      host.querySelectorAll(".side-chat-highlight").forEach((element) => element.remove());
    this.anchors.clear();
    this.observedRows.clear();
    this.highlightResize?.disconnect();
  };
  hover = (event: MouseEvent) => {
    const next = this.anchorsAt(event)[0]?.session.id;
    (event.currentTarget as HTMLElement).style.cursor = next ? "pointer" : "";
    if (next !== this.hovered) {
      this.hovered = next;
      this.paintHighlights();
    }
  };
  leave = () => {
    this.hovered = undefined;
    this.paintHighlights();
  };
  markers = (seqs: readonly number[]) => {
    const matches = this.chats.filter((chat) => chat.sideChat && seqs.includes(chat.sideChat.entrySeq));
    return matches.length
      ? html`<div
          class="side-chat-markers ${matches.some((chat) => this.choices.has(chat.id)) ? "choosing" : ""}"
          ${ref((element) => {
              if (!element) return;
              const host = element as HTMLElement;
              queueMicrotask(() => {
                for (const key of this.anchors.keys()) {
                  if (key.isConnected) continue;
                  this.highlightResize?.unobserve(key);
                  const previous = this.observedRows.get(key);
                  if (previous) this.highlightResize?.unobserve(previous);
                  this.observedRows.delete(key);
                  this.anchors.delete(key);
                }
                if (!host.isConnected) return;
                const row = host.previousElementSibling;
                this.anchors.set(
                  host,
                  row
                    ? matches.flatMap((session) => {
                        const range = passageRange(row, session.sideChat!.quote, session.sideChat!.occurrence);
                        return range ? [{ session, range }] : [];
                      })
                    : [],
                );
                this.highlightResize?.observe(host);
                if (row) {
                  this.observedRows.set(host, row as HTMLElement);
                  this.highlightResize?.observe(row);
                }
                this.paintHighlights();
              });
            })}
        >
          ${matches.map(
              (chat, index) =>
                html`<button
                  class="side-chat-marker ${this.choices.has(chat.id) ? "choice" : ""}"
                  type="button"
                  aria-expanded=${this.active?.id === chat.id}
                  aria-controls=${this.active?.id === chat.id ? this.panelId : nothing}
                  aria-label=${`Open side chat: ${chat.sideChat!.quote}`}
                  @click=${(event: MouseEvent) => {
                    this.returnFocus = event.currentTarget as HTMLElement;
                    void this.show(chat);
                  }}
                  ${tip(chat.sideChat!.quote)}
                >
                  ${icon(MessageSquare, 14)}
                  <span
                    >${this.choices.has(chat.id) ? `${index + 1}. ${chat.title || "Side chat"}` : "Open side chat"}</span
                  >
                  ${chat.sideChat!.expanded ? icon(ArrowUpRight, 13) : nothing}
                </button>`,
            )}
        </div>`
      : nothing;
  };
  view = () => {
    return html`${this.selected ? html`<button class="side-chat-discuss" type="button" style=${`left:${this.selected.left}px;top:${this.selected.top}px`} @mousedown=${(event: MouseEvent) => event.preventDefault()} @click=${() => void this.discuss()} ?disabled=${this.busy} aria-busy=${this.busy}>${this.busy ? waveLoader({ width: 14, height: 14, label: "Opening side chat" }) : icon(MessageSquare, 15)} <span>${this.busy ? "Opening…" : "Ask about"}</span></button>` : nothing}
    ${
        this.error
          ? html`<div class="side-chat-error" role="alert">
              ${this.error}<button
                @click=${() => {
                  this.error = "";
                  this.redraw();
                }}
                aria-label="Dismiss error"
              >
                ${icon(X, 14)}
              </button>
            </div>`
          : nothing
      }
    ${
        this.active
          ? html`<aside
              class="side-chat-panel ${this.maximized ? "maximized" : ""}"
              style=${`--side-chat-left:${this.cardLeft}px;--side-chat-top:${this.cardTop}px`}
              id=${this.panelId}
              aria-label="Side chat"
              @keydown=${this.panelKeydown}
            >
              <header
                class="side-chat-header"
                @pointerdown=${this.startDrag}
                @pointermove=${this.moveDrag}
                @pointerup=${this.endDrag}
                @pointercancel=${this.endDrag}
                @lostpointercapture=${this.endDrag}
              >
                <button
                  class="icon-btn subtle compact"
                  aria-label=${this.maximized ? "Collapse side chat" : "Expand side chat"}
                  @click=${() => {
                    this.maximized = !this.maximized;
                    this.redraw();
                  }}
                >
                  ${icon(this.maximized ? Minimize2 : Maximize2, 15)}
                </button>
                <button
                  class="icon-btn subtle compact"
                  type="button"
                  @click=${() => void this.expand()}
                  ?disabled=${this.busy}
                  aria-busy=${this.busy}
                  aria-label="Open as session"
                  ${tip("Open as session")}
                >
                  ${icon(ArrowUpRight, 15)}
                </button>
                <button
                  class="icon-btn subtle compact"
                  type="button"
                  aria-label="Close side chat"
                  @click=${this.dismiss}
                  ${tip("Close side chat · Esc")}
                >
                  ${icon(X, 17)}
                </button>
              </header>
              ${
                this.maximized && this.includeExcerpt && this.active.sideChat?.quote
                  ? html`<div class="side-chat-excerpt">
                      <span>${this.active.sideChat.quote}</span
                      ><button
                        class="icon-btn"
                        aria-label="Remove excerpt"
                        @click=${() => {
                          this.includeExcerpt = false;
                          this.redraw();
                        }}
                      >
                        ${icon(X, 12)}
                      </button>
                    </div>`
                  : nothing
              }
              <div
                class="side-chat-conversation"
                ${ref((element) => {
                  this.panel = element as HTMLElement | null;
                })}
              ></div>
            </aside>`
          : nothing
      }`;
  };
}
