import { html, nothing, render, type TemplateResult } from "lit";
import { CornerDownLeft, Search } from "lucide";
import { api, fetchSessionRow, userSendMessage } from "./core-bridge";
import { recencyGroup } from "./session-list";
import { slackWireToPlain, stripSlackDirectives } from "./slack-text";
import { openSession, sessionsState, sessionTitle, startNewChat } from "./sessions";
import { destinations } from "./browse";
import { UI_BASE } from "./deep-link";
import {
  resourceResults,
  matchResources,
  searchGroup,
  type ResourceHit,
  type ResourceSearchResponse,
} from "./search-resources";
import { icon } from "./icons";
import { swallow, swallowAs } from "../../chassis/src/errors.ts";

interface ChatSearchHit {
  sessionId: string;
  title: string | null;
  scopeId: string;
  channelName?: string;
  surface?: string;
  seq: number;
  entryType: string;
  author?: string;
  snippet: string;
  createdAt: number;
  archived?: boolean;
}

const MIN_QUERY_LEN = 2;
const DEBOUNCE_MS = 150;
const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform);

const freshSearch = () => ({
  open: false,
  query: "",
  hits: [] as ChatSearchHit[],
  resources: [] as ResourceHit[],
  resourceFailures: [] as string[],
  resourcesLoading: false,
  resourcesLimited: false,
  failed: false,
  loading: false,
  sel: 0,
  selectionMoved: false,
});
const searchState = freshSearch();

let host: HTMLDivElement | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inflight: AbortController | null = null;
let fetchSeq = 0;

export function registerChatSearchHotkey(): void {
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "k" && (isMac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      (searchState.open ? closeChatSearch : openChatSearch)();
    }
  });
}

export function openChatSearch(): void {
  if (searchState.open) return;
  Object.assign(searchState, freshSearch(), { open: true });
  draw();
  requestAnimationFrame(() => host?.querySelector<HTMLInputElement>(".chat-search-input")?.focus());
}

function closeChatSearch(): void {
  if (!searchState.open) return;
  searchState.open = false;
  cancelSearch();
  draw();
}

function cancelSearch(): void {
  fetchSeq++;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  inflight?.abort();
  inflight = null;
}

function draw(): void {
  if (!host) {
    host = document.createElement("div");
    host.className = "chat-search-host";
    document.body.appendChild(host);
  }
  render(searchState.open ? paletteTpl() : nothing, host);
}

function resourceHits(): ResourceHit[] {
  const shortcuts = destinations().map((d) => ({ title: d.label, description: d.blurb, group: "Go to", href: d.href }));
  return [...matchResources(shortcuts, searchState.query), ...searchState.resources];
}

function openResource(hit: ResourceHit): void {
  closeChatSearch();
  location.assign(hit.href);
}

function rowCount(): number {
  return resourceHits().length + searchState.hits.length + (askRowShown() ? 1 : 0);
}

function askRowShown(): boolean {
  return searchState.query.trim().length > 0;
}

function clampSel(): void {
  searchState.sel = Math.max(0, Math.min(searchState.sel, rowCount() - 1));
}

function onQueryInput(e: InputEvent): void {
  Object.assign(searchState, freshSearch(), { open: true, query: (e.currentTarget as HTMLInputElement).value });
  cancelSearch();
  const q = searchState.query.trim();
  if (q.length < MIN_QUERY_LEN) return draw();
  searchState.loading = true;
  searchState.resourcesLoading = true;
  draw();
  debounceTimer = setTimeout(() => void runSearch(q), DEBOUNCE_MS);
}

async function fetchSearch<T>(label: string, path: string, q: string, apply: (r: T | null) => void): Promise<void> {
  const ctl = inflight!;
  const seq = fetchSeq;
  try {
    const r = await api<T>(`${path}?q=${encodeURIComponent(q)}`, { signal: ctl.signal });
    if (seq !== fetchSeq || !searchState.open) return;
    apply(r);
  } catch (e) {
    if (seq !== fetchSeq || ctl.signal.aborted) return;
    swallow(label, e);
    apply(null);
  }
  clampSel();
  draw();
}

async function runSearch(q: string): Promise<void> {
  inflight?.abort();
  inflight = new AbortController();
  fetchSeq++;
  void fetchSearch<ResourceSearchResponse>("web-ui: resource search", "/api/resources/search", q, (response) => {
    searchState.resourcesLoading = false;
    if (!response) return void (searchState.resourceFailures = ["resources"]);
    const result = resourceResults(response, UI_BASE);
    const resourceCount = resourceHits().length;
    if (
      searchState.sel >= resourceCount &&
      (searchState.selectionMoved || searchState.sel < resourceCount + searchState.hits.length)
    ) {
      searchState.sel += result.hits.length - searchState.resources.length;
    }
    searchState.resources = result.hits;
    searchState.resourcesLimited = Boolean(response.limited?.length);
    searchState.resourceFailures = result.failed;
  });
  await fetchSearch<{ hits: ChatSearchHit[] }>("web-ui: chat search", "/api/search", q, (r) => {
    const hits = groupHitsBySession(r?.hits ?? []);
    if (r && searchState.selectionMoved && searchState.sel === resourceHits().length + searchState.hits.length) {
      searchState.sel += hits.length - searchState.hits.length;
    }
    searchState.hits = hits;
    searchState.failed = !r;
    searchState.loading = false;
  });
}

function groupHitsBySession(hits: ChatSearchHit[]): ChatSearchHit[] {
  const bySession = new Map<string, ChatSearchHit[]>();
  for (const hit of hits) bySession.set(hit.sessionId, [...(bySession.get(hit.sessionId) ?? []), hit]);
  const groups = [...bySession.values()];
  return [...groups.filter((g) => !g[0]!.archived), ...groups.filter((g) => g[0]!.archived)].flat();
}

function onPaletteKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    closeChatSearch();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const count = rowCount();
    if (!count) return;
    searchState.selectionMoved = true;
    searchState.sel = (searchState.sel + (e.key === "ArrowDown" ? 1 : count - 1)) % count;
    draw();
    scrollSelectedIntoView();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) return void askQm();
    const resources = resourceHits();
    const resource = resources[searchState.sel];
    if (resource) return openResource(resource);
    if (searchState.loading) return;
    const hit = searchState.hits[searchState.sel - resources.length];
    if (hit) return void openHit(hit);
    const askIndex = resources.length + searchState.hits.length;
    if (!searchState.resourcesLoading && askRowShown() && searchState.sel === askIndex) return void askQm();
  }
}

function scrollSelectedIntoView(): void {
  host?.querySelector(".chat-search-row.selected")?.scrollIntoView({ block: "nearest" });
}

async function openHit(hit: ChatSearchHit): Promise<void> {
  const session =
    sessionsState.list.find((s) => s.id === hit.sessionId) ??
    (await fetchSessionRow({ id: hit.sessionId }).catch(swallowAs("web-ui: open search hit", null)));
  if (!session) return;
  closeChatSearch();
  await openSession(session);
}

function askQm(): void {
  const q = searchState.query.trim();
  if (!q) return;
  closeChatSearch();
  const conv = startNewChat();
  void conv?.state.agent?.prompt(
    userSendMessage(
      `Find the chat, skill, cron, app, or other resource matching this search query and give me a link: ${q}`,
    ),
  );
}

function highlight(text: string): TemplateResult {
  const terms = searchState.query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (!terms.length) return html`${text}`;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");
  const parts = text.split(re);
  return html`${parts.map((part, i) => (i % 2 ? html`<mark>${part}</mark>` : html`${part}`))}`;
}

function hitSnippet(hit: ChatSearchHit): string {
  return hit.surface === "slack" ? slackWireToPlain(stripSlackDirectives(hit.snippet)) : hit.snippet;
}

function hitTitle(hit: ChatSearchHit): string {
  if (hit.title?.trim()) return hit.title;
  const session = sessionsState.list.find((s) => s.id === hit.sessionId);
  return session ? sessionTitle(session) : (hit.channelName ?? "Untitled chat");
}

function row(i: number, className: string, open: () => void, content: TemplateResult): TemplateResult {
  return html`<button
    type="button"
    class=${className}
    @click=${open}
    @pointermove=${() => {
      if (searchState.sel !== i) {
        searchState.selectionMoved = true;
        searchState.sel = i;
        draw();
      }
    }}
  >
    ${content}
  </button>`;
}

const selected = (i: number) => (i === searchState.sel ? "selected" : "");

function resultRows(): TemplateResult[] {
  const offset = resourceHits().length;
  return searchState.hits.flatMap((hit, index) => {
    const i = offset + index;
    return [
      ...(hit.sessionId === searchState.hits[index - 1]?.sessionId
        ? []
        : [searchGroup(hitTitle(hit), Boolean(hit.archived), recencyGroup(hit.createdAt))]),
      row(
        i,
        `chat-search-row ${selected(i)} ${hit.archived ? "archived" : ""}`,
        () => void openHit(hit),
        html`<span class="chat-search-who ${hit.entryType === "user" ? "user" : "agent"}" dir="auto"
            >${(hit.entryType === "user" ? (hit.author ?? "You") : "QM").slice(0, 1).toUpperCase()}</span
          >
          <span class="chat-search-text">
            <span class="chat-search-snippet" dir="auto">${highlight(hitSnippet(hit))}</span>
            <span class="chat-search-meta"
              ><bdi>${hit.entryType === "user" ? (hit.author ?? "you") : "agent"}</bdi> ·
              ${new Date(hit.createdAt).toLocaleDateString()}</span
            >
          </span>`,
      ),
    ];
  });
}

function resourceRows(): TemplateResult[] {
  return resourceHits().flatMap((hit, i, hits) => [
    ...(hit.group === hits[i - 1]?.group ? [] : [searchGroup(hit.group, false, "")]),
    row(
      i,
      `chat-search-row ${selected(i)}`,
      () => openResource(hit),
      html`<span class="chat-search-who">${icon(Search, 14)}</span>
        <span class="chat-search-text"
          ><span class="chat-search-snippet">${highlight(hit.title)}</span>
          <span class="chat-search-meta chat-search-snippet">${highlight(hit.description)}</span></span
        >`,
    ),
  ]);
}

function askRow(): TemplateResult {
  const i = resourceHits().length + searchState.hits.length;
  return row(
    i,
    `chat-search-row chat-search-ask ${selected(i)}`,
    askQm,
    html`<span class="chat-search-who ask">+</span>
      <span class="chat-search-text">
        <span class="chat-search-snippet">Ask QM to find it: <b dir="auto">“${searchState.query.trim()}”</b></span>
        <span class="chat-search-meta">starts a new chat where QM finds the matching resource and links it</span>
      </span>
      <span class="chat-search-kbd">${isMac ? "⌘" : "Ctrl"}${icon(CornerDownLeft, 11)}</span>`,
  );
}

function paletteTpl(): TemplateResult {
  const q = searchState.query.trim();
  let body: TemplateResult | typeof nothing;
  if (q.length < MIN_QUERY_LEN) {
    body = nothing;
  } else if (searchState.loading && !searchState.hits.length) {
    body = html`<div class="chat-search-empty">Searching…</div>`;
  } else if (searchState.failed) {
    body = html`<div class="chat-search-empty chat-search-failed">Search failed. Try again.</div>`;
  } else if (!searchState.hits.length && !resourceHits().length && !searchState.resourcesLoading) {
    body = html`<div class="chat-search-empty">No results match “${q}”.</div>`;
  } else {
    body = html`${resultRows()}`;
  }
  return html`
    <div
      class="chat-search-overlay"
      @pointerdown=${(e: PointerEvent) => {
        if (e.target === e.currentTarget) closeChatSearch();
      }}
    >
      <div class="chat-search-palette" role="dialog" aria-label="Search QM" @keydown=${onPaletteKeydown}>
        <div class="chat-search-inputrow">
          ${icon(Search, 16)}
          <input
            class="chat-search-input"
            type="text"
            placeholder="Search chats, skills, crons, apps…"
            autocomplete="off"
            spellcheck="false"
            .value=${searchState.query}
            @input=${onQueryInput}
          />
          <span class="chat-search-kbd">esc</span>
          <button class="chat-search-cancel" type="button" @click=${closeChatSearch}>Cancel</button>
        </div>
        <div class="chat-search-results">
          ${resourceRows()}
          ${searchState.resourcesLoading ? html`<div class="chat-search-empty">Loading resources…</div>` : nothing}
          ${searchState.resourceFailures.length ? html`<div class="chat-search-empty chat-search-failed">Could not search: ${searchState.resourceFailures.join(", ")}. Try searching again.</div>` : nothing}
          ${searchState.resourcesLimited ? html`<div class="chat-search-empty">Refine your search to see more resource matches.</div>` : nothing}
          ${body}
        </div>
        ${askRowShown() ? html`<div class="chat-search-askbar">${askRow()}</div>` : nothing}
        <div class="chat-search-foot">
          <span><span class="chat-search-kbd">↑↓</span> navigate</span>
          <span><span class="chat-search-kbd">↵</span> open</span>
          <span><span class="chat-search-kbd">${isMac ? "⌘↵" : "Ctrl+↵"}</span> ask QM in a new chat</span>
        </div>
      </div>
    </div>
  `;
}
