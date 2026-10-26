import { html, nothing, type TemplateResult } from "lit";
import { ArrowUpRight, ChevronRight, Mail } from "lucide";
import type { LedgerItem } from "./inbox-model";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { listBackLink } from "./list-page";
import { initials, relTime } from "./ui";
import { icon } from "./icons";

export interface SentEmail {
  accountType?: "default" | "personal" | "company";
  id: string;
  threadId: string;
  to: string;
  subject: string;
  snippet: string;
  sentAt: number;
}

type SentDetail = SentEmail & {
  from: string;
  cc: string;
  body: string;
  rfcMessageId?: string;
  html: boolean;
  attachments: string[];
};

interface SentMailPage {
  accountType?: SentEmail["accountType"];
  messages: SentEmail[];
  nextPageToken?: string;
  accountEmail: string;
}

let messages: SentEmail[] = [];
let nextPageToken: string | undefined;
let accountEmail = "";
let accountType: SentEmail["accountType"];
let loading = false;
let loaded = false;
let error = "";
let generation = 0;
let selected: SentEmail | null = null;
let detail: SentDetail | null = null;
let detailError = "";
const chatItems = new Map<string, LedgerItem>();
let chatItemId: string | null = null;
let chatError = "";
let detailGeneration = 0;

export async function openSentEmail(message: SentEmail, draw: () => void): Promise<void> {
  resetSelectedSentEmail();
  selected = message;
  const current = detailGeneration;
  draw();
  try {
    const result = await api<SentDetail>(
      `/api/inbox/sent/${encodeURIComponent(message.id)}?${new URLSearchParams(message.accountType ? { accountType: message.accountType } : {})}`,
    );
    if (current === detailGeneration) {
      detail = result;
      selected = { ...message, ...result };
      draw();
      await loadSentChat(draw, current);
    }
  } catch (cause) {
    if (current === detailGeneration) detailError = errMessage(cause, "Couldn't load this email.");
  } finally {
    if (current === detailGeneration) draw();
  }
}

async function loadSentChat(draw: () => void, current = detailGeneration): Promise<void> {
  if (!detail) return;
  chatError = "";
  draw();
  try {
    const text = detail.html ? plainSnippet(detail.body) : detail.body;
    const result = await api<{ item: LedgerItem }>("/api/inbox/sent-chat", {
      method: "POST",
      body: JSON.stringify({
        accountType: detail.accountType ?? selected?.accountType ?? "default",
        messageId: detail.id,
        threadId: detail.threadId,
        subject: detail.subject,
        from: detail.from,
        to: detail.to,
        cc: detail.cc,
        rfcMessageId: detail.rfcMessageId,
        text: text.slice(0, 50000),
      }),
    });
    if (current === detailGeneration) {
      chatItemId = result.item.id;
      updateSentChat(result.item);
    }
  } catch (cause) {
    if (current === detailGeneration) chatError = errMessage(cause, "Couldn't load chat.");
  } finally {
    if (current === detailGeneration) draw();
  }
}

export function sentChatTpl(draw: () => void, renderChat: (item: LedgerItem) => TemplateResult): TemplateResult {
  const item = selectedSentChat();
  if (item) return renderChat(item);
  return html`<div class="inbox-chat">
    <h2 class="inbox-chat-cta">Ask about this email</h2>
    ${chatError ? html`<div role="alert">${chatError}<button class="btn" @click=${() => void loadSentChat(draw)}>Try again</button></div>` : html`<div role="status">Loading chat…</div>`}
  </div>`;
}

export function selectedSentChat(id: string | null = chatItemId): LedgerItem | null {
  return id ? (chatItems.get(id) ?? null) : null;
}

export function updateSentChat(item: LedgerItem): void {
  if (chatItemId === item.id || chatItems.has(item.id)) chatItems.set(item.id, item);
}

export async function openSentEmailById(id: string, draw: () => void): Promise<void> {
  await openSentEmail(
    messages.find((message) => message.id === id) ?? {
      id,
      threadId: "",
      to: "",
      subject: "",
      snippet: "",
      sentAt: 0,
    },
    draw,
  );
}

export function resetSentMail(): void {
  chatItems.clear();
  generation++;
  resetSelectedSentEmail();
  messages = [];
  nextPageToken = undefined;
  accountEmail = "";
  accountType = undefined;
  loading = false;
  loaded = false;
  error = "";
}

export async function loadSentMail(draw: () => void, more = false): Promise<void> {
  if (loading) return;
  loading = true;
  error = "";
  const current = ++generation;
  const params = new URLSearchParams();
  if (more) {
    if (nextPageToken) params.set("pageToken", nextPageToken);
    if (accountType) params.set("accountType", accountType);
  }
  draw();
  try {
    const page = await api<SentMailPage>(`/api/inbox/sent?${params}`);
    if (current !== generation) return;
    accountType = page.accountType ?? (more ? accountType : "default");
    messages = [
      ...new Map(
        [
          ...(more ? messages : []),
          ...page.messages.map((message) => ({
            ...message,
            accountType: page.accountType ?? accountType ?? "default",
          })),
        ].map((message) => [message.id, message]),
      ).values(),
    ].sort((a, b) => b.sentAt - a.sentAt);
    accountEmail = page.accountEmail;
    nextPageToken = page.nextPageToken;
    loaded = true;
  } catch (cause) {
    if (current !== generation) return;
    error = errMessage(cause, "Couldn't load sent mail. Try again.");
  } finally {
    if (current === generation) {
      loading = false;
      draw();
    }
  }
}

export function isSentMailLoading(): boolean {
  return loading;
}

export function ensureSentMail(draw: () => void): void {
  if (!loaded && !loading) void loadSentMail(draw);
}

export function selectedSentEmail(): SentEmail | null {
  return selected;
}

export function resetSelectedSentEmail(): void {
  detailGeneration++;
  selected = null;
  chatItemId = null;
  chatError = "";
  detail = null;
  detailError = "";
}

function closeSentEmail(draw: () => void): void {
  resetSelectedSentEmail();
  ensureSentMail(draw);
  draw();
}

function plainSnippet(value: string): string {
  const doc = new DOMParser().parseFromString(value, "text/html");
  return doc.body.textContent ?? "";
}

export function sentMailTpl(
  draw: () => void,
  open: (message: SentEmail) => void = (message) => void openSentEmail(message, draw),
): TemplateResult {
  return html`
    ${error ? html`<div class="inbox-notice" role="alert">${error} <button class="btn" ?disabled=${loading} @click=${() => void loadSentMail(draw, Boolean(nextPageToken))}>Try again</button></div>` : nothing}
    ${!messages.length && !error ? html`<div class="empty compact">${loading ? "Loading sent mail…" : "No sent emails in this account."}</div>` : nothing}
    <div class="inbox-list">
      ${messages.map(
        (message) =>
          html`<div class="inbox-item src-gmail">
            <div class="inbox-item-summary">
              <button
                class="inbox-item-row inbox-sent-row"
                type="button"
                @click=${() => open(message)}
                aria-label=${`Open sent email: ${message.subject || "No subject"}`}
              >
                <span class="inbox-item-glyph">${icon(Mail, 14)}</span>
                <span class="inbox-item-main">
                  <span class="inbox-item-top"
                    ><span class="inbox-item-heading">To: ${message.to || "Undisclosed recipients"}</span
                    ><span class="inbox-item-sub">${message.subject || "(No subject)"}</span></span
                  >
                  <span class="inbox-item-snippet">${plainSnippet(message.snippet)}</span>
                </span>
                <span class="inbox-item-side"
                  ><span class="inbox-item-time" title=${new Date(message.sentAt).toLocaleString()}
                    >${relTime(message.sentAt)}</span
                  >${icon(ChevronRight, 13)}</span
                >
              </button>
            </div>
          </div>`,
      )}
    </div>
    ${nextPageToken ? html`<button class="btn inbox-sent-more" ?disabled=${loading} @click=${() => void loadSentMail(draw, true)}>${loading ? "Loading…" : "Load more"}</button>` : nothing}
  `;
}

function sentMessageTpl(detail: SentDetail, message: SentEmail, body: string | undefined): TemplateResult {
  return html`<div class="inbox-context-msg inbox-sent-message">
    <span class="inbox-avatar" aria-hidden="true">${initials(detail.from)}</span>
    <div class="inbox-context-body">
      <div class="inbox-context-head">
        <span class="inbox-context-author">${detail.from}</span>
        <span class="inbox-context-at" title=${new Date(message.sentAt).toLocaleString()}
          >${relTime(message.sentAt)}</span
        >
      </div>
      <div class="inbox-sent-recipients">
        To: ${message.to}${detail.cc ? html`<span> · Cc: ${detail.cc}</span>` : nothing}
      </div>
      <div class="inbox-context-text">${body || "This email has no text body."}</div>
      ${
        detail.attachments.length
          ? html`<div class="inbox-sent-attachments">Attachments: ${detail.attachments.join(", ")}</div>`
          : nothing
      }
    </div>
  </div>`;
}

export function sentEmailPageTpl(
  draw: () => void,
  aside?: TemplateResult,
  draft?: TemplateResult,
  close: () => void = () => closeSentEmail(draw),
): TemplateResult | typeof nothing {
  if (!selected) return nothing;
  const message = selected;
  const body = detail?.html
    ? plainSnippet(detail.body.replace(/<br\s*\/?>(|\s)|<\/(p|div|tr|li|h[1-6])>/gi, "\n"))
    : detail?.body;
  return html`
    <div class="pane-head inbox-item-head src-gmail">
      <div class="inbox-item-head-copy">
        ${listBackLink("Sent", close)}
        <h1 class="pane-title">
          <span class="inbox-item-glyph">${icon(Mail, 18)}</span>
          <span>To: ${message.to || "Undisclosed recipients"}</span>
          <span class="inbox-item-head-meta">
            <span class="inbox-item-state">Sent</span>
            <span class="inbox-item-time" title=${new Date(message.sentAt).toLocaleString()}
              >${relTime(message.sentAt)}</span
            >
          </span>
        </h1>
        <div class="pane-subtitle">${message.subject || "(No subject)"}</div>
      </div>
    </div>
    <div class="inbox-surface inbox-item-surface">
      <div class="inbox-scroll inbox-item-thread">
        ${
          detailError
            ? html`<div class="inbox-notice" role="alert">
                ${detailError} <button class="btn" @click=${() => void openSentEmail(message, draw)}>Try again</button>
              </div>`
            : nothing
        }
        ${!detail && !detailError ? html`<div role="status" class="empty compact">Loading email…</div>` : nothing}
        ${detail ? html`<div class="inbox-context">${sentMessageTpl(detail, message, body)}</div>` : nothing}
        ${draft ?? nothing}
        <div class="inbox-draft-head inbox-sent-actions">
          <a
            class="inbox-external-link"
            href=${`https://mail.google.com/mail/?authuser=${encodeURIComponent(accountEmail)}#sent/${encodeURIComponent(message.threadId)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            ${icon(ArrowUpRight, 12)}<span>Open in Gmail</span>
          </a>
        </div>
        ${aside ?? nothing}
      </div>
    </div>
  `;
}
