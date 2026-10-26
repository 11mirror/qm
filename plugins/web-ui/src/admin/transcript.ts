import { html, nothing } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { node, renderer, scroller } from "./shared.ts";
import { isUserMessage, itemFields, type Item } from "../items.ts";
import { firstLine, fmtTime, fmtTokens, plural, relTime, wakeOriginLabel } from "./format.ts";
import { copyButton, errorStripBox, metaChip } from "./dom.ts";
import { isXmlishText } from "./rich-text.ts";
import { markdown } from "../message-markdown.ts";
import {
  renderToolEntry,
  stepDurEl,
  toolCopyText,
  toolLabelText,
  toolName,
  toolPrimaryText,
  toolStatusMeta,
} from "./tool-entry.ts";
import {
  type ContextSection,
  cacheMetaItems,
  contextSections,
  fmtContextSize,
  isStablePrefixMiss,
  rawJsonLink,
  requestBody,
  sumCacheUsage,
} from "./llm-context.ts";
type Row = Record<string, any>;
let generation = 0;
export function cancel() {
  generation++;
}
const brain = html`<svg
  viewBox="0 0 24 24"
  fill="none"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path
    d="M12 4.5c-2.1 0-3.7 1.3-3.7 3.1 0 .2 0 .4.1.6A3.6 3.6 0 0 0 6 11.5c0 1 .4 2 1.1 2.6-.1.3-.1.5-.1.8 0 2 1.8 3.6 4 3.6h1.9c2.2 0 4-1.6 4-3.6 0-.3 0-.6-.1-.8.7-.7 1.1-1.6 1.1-2.6 0-1.5-.9-2.8-2.3-3.3 0-.2.1-.4.1-.6 0-1.8-1.6-3.1-3.7-3.1Z"
  />
  <path d="M9.2 9.2c.9.1 1.6.6 2 1.4" />
  <path d="M14.8 9.2c-.9.1-1.6.6-2 1.4" />
  <path d="M12 10.7v7.8" />
</svg>`;
const activate = (run: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    run();
  }
};
const requestCount = (count: number) => count + " request" + (count === 1 ? "" : "s");
const contextIcon = (label: string, title: string, onClick: (e: Event) => void, expanded?: boolean) =>
  html`<button
    type="button"
    class=${"context-icon" + (expanded ? " active" : "")}
    aria-expanded=${ifDefined(expanded === undefined ? undefined : String(expanded))}
    aria-label=${label}
    title=${title}
    @click=${onClick}
  >
    ${brain}
  </button>`;
const TOOL_KINDS = new Set(["ToolCall", "ToolResult"]);
const NOISE_KINDS = new Set(["ToolCall", "ToolResult", "Wake", "ContextCompaction", "Retraction", "RuntimeChange"]);
const kindLabel = (kind: string) =>
  kind.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/ ([A-Z])/g, (_, c) => " " + c.toLowerCase());
const json = (value: unknown) => JSON.stringify(value, null, 2);
function itemText(item: Item): string {
  if (item.kind === "Wake" && typeof item.body.text === "string") return item.body.text;
  if (item.kind === "Reasoning") return item.text || (item.body.redacted ? "[redacted thinking]" : "");
  if (item.text != null && item.kind !== "ToolCall" && item.kind !== "ToolResult") return item.text;
  return json(itemFields(item));
}
const isOriginPrompt = (item: Item) => isUserMessage(item) || item.kind === "Wake";
export function prepare(data: Row, requests: Row[]) {
  const items: Item[] = data.items || [],
    llm = new Map<any, Row[]>(),
    byItem = new Map<number, Row[]>(),
    dur = new Map<number, number>(),
    seqIndex = new Map(items.map((item, i) => [item.seq, i])),
    add = (map: Map<any, Row[]>, key: any, rows: Row[]) => map.set(key, [...(map.get(key) || []), ...rows]);
  for (const req of requests) add(llm, req.turnSeq ?? "_orphan", [req]);
  for (let i = 1; i < items.length; i++) {
    const delta = (items[i].createdAt || 0) - (items[i - 1].createdAt || 0);
    if (delta >= 0) dur.set(items[i].seq, delta);
  }
  for (const [turn, reqs] of llm) {
    if (turn === "_orphan" || turn < (items[0]?.seq || 0)) continue;
    const start = seqIndex.get(turn);
    if (start === undefined) {
      add(llm, "_orphan", reqs);
      continue;
    }
    let anchor = start;
    for (let i = start + 1; i < items.length && !isUserMessage(items[i]); i++)
      if (items[i].kind === "AgentMessage") anchor = i;
    add(
      byItem,
      items[anchor].seq,
      reqs.sort((a, b) => (a.step || 0) - (b.step || 0)),
    );
  }
  const results = new Map<string, Item>(),
    paired = new Set<number>(),
    units: Row[] = [];
  for (const item of items)
    if (item.kind === "ToolResult" && item.callId && !results.has(item.callId)) results.set(item.callId, item);
  for (const item of items) {
    if (!TOOL_KINDS.has(item.kind)) {
      units.push({ kind: "item", item, llmReqs: byItem.get(item.seq) });
      continue;
    }
    if (item.kind === "ToolResult") {
      if (!paired.has(item.seq)) units.push({ kind: "tool", call: null, result: item, llmReqs: byItem.get(item.seq) });
      continue;
    }
    const result = (item.callId && results.get(item.callId)) || null;
    if (result) paired.add(result.seq);
    units.push({ kind: "tool", call: item, result, llmReqs: byItem.get(item.seq) });
  }
  if (llm.get("_orphan")?.length) units.push({ kind: "llm", reqs: llm.get("_orphan") });
  return {
    units,
    dur,
    originPromptSeq: data.origin && !data.hasMore ? items.find(isOriginPrompt)?.seq : null,
  };
}
function contextStats(requests: Row[], s: Row, sections?: ContextSection[]) {
  const latest = requests.at(-1) || { request: {} };
  sections ??= contextSections(requestBody(latest), latest.transport);
  return html`<div class="context-stats">
    ${metaChip((latest.model || "?") + " · " + fmtContextSize(latest, sections))}${cacheMetaItems(sumCacheUsage(requests))}${rawJsonLink(requests)}
  </div>`;
}
function begin(s: Row, shell: Row) {
  const request = ++generation,
    root = document.getElementById("view-data")!;
  root.replaceChildren();
  const draw = renderer(root);
  s.pageShell(shell);
  draw(html`<div class="detail">Loading…</div>`);
  return { request, root, draw };
}
const fetchSession = (s: Row, id: string, path: string, query = "") =>
  s.api("GET", "/api/sessions/" + encodeURIComponent(id) + path + "scope=" + encodeURIComponent(s.scope) + query);
const failed = (result: Row, what: string) =>
  html`<div class="detail">${result.data?.message || `Failed to load ${what} (${result.status}).`}</div>`;
export function requestsPanel(requests: Row[], s: Row, opts: Row = {}) {
  const host = document.createDocumentFragment(),
    draw = renderer(host as unknown as HTMLElement),
    sections: ContextSection[][] = requests.map((q) => contextSections(requestBody(q), q.transport)),
    selected = sections.map((list) =>
      opts.selectLargest && list.length ? list.reduce((a, b) => (b.tokens > a.tokens ? b : a)).key : null,
    ),
    cache = sumCacheUsage(requests);
  function paint() {
    draw(
      html`<div
        class=${classMap({ llm: true, "context-turn": true, "context-page": !!opts.page, "cache-miss": !!cache && isStablePrefixMiss(cache) })}
      >
        ${opts.page ? nothing : html`<div class="who">${contextStats(requests, s, sections.at(-1) || [])}</div>`}
        <div class="context-details">
          ${requests.map((q, index) => {
            const list: ContextSection[] = sections[index],
              total = list.reduce((n, section) => n + section.tokens, 0),
              chosen = list.find((section) => section.key === selected[index]);
            return html`<div class="context-request">
              ${requests.length > 1 ? html`<div class="context-request-head"><strong>${"Request " + (index + 1)}</strong><span>${(q.model || "?") + " · " + fmtContextSize(q, list)}</span></div>` : nothing}${q.truncated ? html`<p class="context-note">Stored payload was truncated.</p>` : nothing}
              <div class="context-overview">
                <div class="context-stack" role="group" aria-label="request context">
                  ${list.map((section) => {
                    const title =
                      section.label + " · " + fmtTokens(section.tokens) + (section.note ? " · " + section.note : "");
                    return html`<button
                      type="button"
                      class=${"context-segment ctx-" + section.key + (chosen === section ? " active" : "")}
                      style=${"flex-grow:" + Math.max(section.tokens, 1) + ";flex-basis:" + (total ? Math.max(2, Math.round((section.tokens / total) * 100)) + "%" : "1%")}
                      data-tiny=${total && section.tokens / total < 0.12 ? "true" : "false"}
                      title=${title}
                      aria-label=${title}
                      aria-pressed=${String(chosen === section)}
                      @click=${() => {
                        selected[index] = section.key;
                        paint();
                      }}
                    >
                      <span>${section.label}</span><small>${"~" + fmtTokens(section.tokens)}</small>
                    </button>`;
                  })}
                </div>
              </div>
              <div class="context-selection">
                ${
                  chosen
                    ? html`<div class="context-section-view">
                        <div class="context-section-head">
                          <strong>${chosen.label}</strong
                          ><span>${fmtTokens(chosen.tokens) + (chosen.note ? " · " + chosen.note : "")}</span>
                        </div>
                        <pre>${chosen.text || "(empty)"}</pre>
                      </div>`
                    : nothing
                }
              </div>
            </div>`;
          })}
        </div>
      </div>`,
    );
  }
  paint();
  return host.firstElementChild as HTMLElement;
}
export async function contextPage(sessionId: string, turnSeq: string, s: Row) {
  const { request, draw } = begin(s, {
    back: { label: "← Back to transcript", onClick: () => history.back() },
    title: "Sent to model",
  });
  const result = await fetchSession(s, sessionId, "/llm?turnSeq=" + encodeURIComponent(turnSeq) + "&");
  if (request !== generation || !s.current(sessionId, turnSeq)) return;
  if (!result.ok) return draw(failed(result, "context"));
  const requests = (result.data.requests || []).slice().sort((a: Row, b: Row) => (a.step || 0) - (b.step || 0)),
    label = turnSeq === "orphan" ? "unattributed context" : `turn #${turnSeq}`;
  draw(
    html`<div class="detail">
      <div class="context-page-head">
        <h2>${"Sent to model · " + label + (requests.length > 1 ? " · " + requests.length + " steps" : "")}</h2>
        ${requests.length ? contextStats(requests, s) : nothing}
      </div>
      ${requests.length ? requestsPanel(requests, s, { page: true, selectLargest: true }) : html`<p class="context-empty">No context was captured for this turn.</p>`}
    </div>`,
  );
}
export async function show(sessionId: string, limit: number | undefined, expand: boolean | undefined, s: Row) {
  const back = (sessionScope?: string) => () => {
    if (history.state?.deepLink)
      s.go({ view: "history", scope: sessionScope || s.scope, session: null, historyKind: s.historyKind });
    else history.back();
  };
  const { request, root, draw } = begin(s, {
      back: { label: "← Conversations", onClick: back() },
      title: "Conversation",
      context: s.shortName(s.scope),
    }),
    reqLimit = limit || s.pageSize,
    current = () => request === generation && s.current(sessionId);
  let applyVisibility = () => {};
  const header = document.getElementById("header-controls")!;
  header.replaceChildren();
  const paintHeader = renderer(header);
  function controls() {
    paintHeader(
      html`${Object.entries({ thinking: "thinking", "tool results": "toolResults" }).map(
        ([label, key]) =>
          html`<label class="header-check"
            ><input
              type="checkbox"
              .checked=${!!s.visibility[key]}
              aria-label=${"Show " + label}
              @change=${(e: Event) => {
                s.visibility[key] = (e.target as HTMLInputElement).checked;
                applyVisibility();
              }}
            /><span class="header-check-prefix">Show </span>${label}</label
          >`,
      )}`,
    );
  }
  controls();
  const llmPromise = fetchSession(s, sessionId, "/llm?");
  const result = await fetchSession(s, sessionId, "?", "&limit=" + reqLimit);
  if (!current()) return;
  if (!result.ok) return draw(failed(result, "transcript"));
  const data = result.data,
    session = data.session || {},
    origin = data.origin,
    owner = session.scopeId?.startsWith("personal:") ? session.scopeId.slice(9) : null;
  s.pageShell({
    back: { label: "← Conversations", onClick: back(session.scopeId) },
    title: origin?.label || "Conversation",
    context:
      s.shortName(session.scopeId || s.scope) + (session.createdAt ? " · created " + relTime(session.createdAt) : ""),
    actions: owner ? [s.webUiAsButton(owner)] : [],
  });
  const llm: Row = await llmPromise;
  const requests: Row[] = llm.ok ? llm.data?.requests || [] : [];
  if (!current()) return;
  const { units, dur, originPromptSeq } = prepare(data, requests),
    open = new Set<Row>(),
    bodyNodes = new Map<Row, Node>(),
    toolNodes = new Map<Row, Row>();
  let errors: Row[] | null = [],
    first = 0,
    paused = false;
  const observer =
    "IntersectionObserver" in window
      ? new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && reveal(), {
          rootMargin: "800px 0px",
        })
      : null;
  s.setObserver(observer);
  const rewind = (from: number) => {
    first = Math.max(0, from - 60);
    while (first > 0 && units[first].kind === "llm") first--;
  };
  if (observer && !expand) rewind(units.length);
  const toggle = (unit: Row) => () => {
    if (open.has(unit)) open.delete(unit);
    else open.add(unit);
    paint();
  };
  const memo = <K, V>(map: Map<K, V>, key: K, make: () => V) => {
    if (!map.has(key)) map.set(key, make());
    return map.get(key)!;
  };
  const contextButton = (turn: any, count: number) =>
    contextIcon("View context sent to the model", "View context sent to the model · " + requestCount(count), (e) => {
      e.stopPropagation();
      s.go({ view: "history", scope: s.scope, session: sessionId, turn });
    });
  const timing = ({ call, result: res }: Row) => {
    return call && res
      ? [
          [dur.get(call.seq), "model"],
          [(res.createdAt || 0) - (call.createdAt || 0), "exec"],
        ]
      : [[dur.get((call || res)?.seq)]];
  };
  function fullTool(unit: Row) {
    const built = memo(toolNodes, unit, () =>
      renderToolEntry(
        unit.call,
        unit.result,
        unit.llmReqs?.length ? node(contextButton(unit.llmReqs[0].turnSeq, unit.llmReqs.length)) : null,
        stepDurEl(timing(unit)),
      ),
    );
    built.sync?.();
    return built.block;
  }
  const cronLink = (cronOrigin: Row | null, ownerScope?: string) =>
    cronOrigin?.kind === "cron"
      ? html`<button
          type="button"
          class="link"
          @click=${() => s.go({ view: "crons", scope: cronOrigin.cron?.ownerScopeId || ownerScope || s.scope, session: null, cron: cronOrigin.cronId })}
        >
          View cron
        </button>`
      : nothing;
  const body = (item: Item) =>
    memo(bodyNodes, item, () => {
      const text = itemText(item),
        user = isUserMessage(item);
      const markup = (user && !isXmlishText(text)) || item.kind === "AgentMessage";
      return node(markup ? html`<div class="message-body">${markdown(text)}</div>` : html`<pre>${text}</pre>`);
    });
  function unitTemplate(unit: Row) {
    if (unit.kind === "llm")
      return html`<div class="entry llm">
        <div class="who">${contextButton("orphan", unit.reqs.length)}<span class="role">captured context</span></div>
      </div>`;
    if (unit.kind === "tool") {
      const { call, result: res } = unit,
        e = call || res,
        kinds = [call, res].filter(Boolean).map((item) => item.kind),
        hidden = s.entryHidden(kinds),
        full = fullTool(unit);
      full.classList.toggle("filtered", hidden);
      if (unit.llmReqs?.length) return full;
      const cp = call ? itemFields(call) : {},
        rp = res ? itemFields(res) : {},
        name = toolName(cp, rp);
      return html`<div
        class=${classMap({ entry: true, "tool-entry": true, "tool-line-entry": true, open: open.has(unit), filtered: hidden })}
      >
        <div
          class="who tool-line"
          tabindex="0"
          role="button"
          title="Toggle full tool card"
          aria-expanded=${String(open.has(unit))}
          @click=${(e: MouseEvent) => {
            if (!(e.target as Element).closest(".copy")) toggle(unit)();
          }}
          @keydown=${activate(toggle(unit))}
        >
          <span class="tool-line-caret">${open.has(unit) ? "▾" : "▸"}</span
          ><span class="tool-label">${toolLabelText(name, cp, rp)}</span
          ><span class="tool-line-preview">${firstLine(toolPrimaryText(cp, rp, !!call, !!res) || "", 240)}</span
          >${stepDurEl(timing(unit))}<span class="when"
            >${call && res ? `#${call.seq}→#${res.seq} · ${fmtTime(call.createdAt)}` : `#${e.seq} · ${fmtTime(e.createdAt)}`}</span
          >
          <div class="meta-row">${toolStatusMeta(name, rp, !!res)}</div>
          ${copyButton("Copy", () => toolCopyText(call, res))}
        </div>
        ${full}
      </div>`;
    }
    const e: Item = unit.item,
      noise = NOISE_KINDS.has(e.kind),
      user = isUserMessage(e),
      isOrigin = origin && e.seq === originPromptSeq,
      text = itemText(e);
    let label = kindLabel(e.kind);
    if (e.kind === "AgentMessage") label = s.brandSelfLabel();
    else if (e.kind === "Reasoning") label = "Thinking";
    else if (user) label = (typeof e.body.name === "string" && e.body.name.trim()) || e.author || "User";
    if (isOrigin) label = origin.label || wakeOriginLabel(origin.trigger);
    const files =
      e.kind === "AgentMessage" && Array.isArray(e.body.files) ? s.deliveryFileBadges(e.body.files) : nothing;
    return html`<div
      class=${classMap({ entry: true, noise, collapsed: noise && !open.has(unit), "thinking-entry": e.kind === "Reasoning", "message-entry": user || e.kind === "AgentMessage", "user-entry": user, "assistant-entry": e.kind === "AgentMessage", "cron-prompt-entry": !!isOrigin, "system-entry": e.kind === "Wake", filtered: s.entryHidden([e.kind]) })}
    >
      <div class="who">
        ${unit.llmReqs?.length ? contextButton(unit.llmReqs[0].turnSeq, unit.llmReqs.length) : nothing}${noise ? html`<button type="button" class="disclosure" aria-expanded=${String(open.has(unit))} aria-label=${open.has(unit) ? "Collapse entry" : "Expand entry"} title=${open.has(unit) ? "Collapse entry" : "Expand entry"} @click=${toggle(unit)}>${open.has(unit) ? "▾" : "▸"}</button>` : nothing}<span
          class=${"entry-label" + (isOrigin ? " important" : "")}
          >${label}</span
        >${isOrigin ? cronLink(origin, session.scopeId) : nothing}${!user ? stepDurEl([[dur.get(e.seq)]]) : nothing}<span
          class="when"
          >${"#" + e.seq + " · " + fmtTime(e.createdAt)}</span
        >${copyButton("Copy", () => text)}
      </div>
      ${body(e)}${files}
    </div>`;
  }
  const load = () => {
    if (first > 0) reveal();
    else void show(sessionId, reqLimit * 4, true, s);
  };
  function paint() {
    if (!current()) return;
    controls();
    const more = first === 0 || paused;
    draw(
      html`<div class="detail">
        <div>
          ${llm.ok ? nothing : html`<div class="statline">Couldn't load the model context for this conversation.</div>`}${errors === null ? html`<div class="statline">Couldn't load this session's errors.</div>` : nothing}${errors?.length ? errorStripBox(errors, plural(errors.length, "error") + " logged in this session", 5) : nothing}
        </div>
        ${
          units.length
            ? html`<div class="transcript-stream">
                ${
                  first > 0 || data.hasMore
                    ? html`<div
                        class=${"load-earlier" + (more ? " more" : "")}
                        aria-hidden=${String(!more)}
                        role=${more ? "button" : "presentation"}
                        tabindex=${more ? 0 : -1}
                        @click=${more ? load : nothing}
                        @keydown=${more ? activate(load) : nothing}
                      >
                        ${more ? "Load earlier messages" : "Loading earlier messages…"}
                      </div>`
                    : nothing
                }${repeat(units.slice(first), (unit) => unit, unitTemplate)}
              </div>`
            : html`<p class="empty">No entries.</p>`
        }
      </div>`,
    );
  }
  function reveal() {
    if (!current() || first <= 0) return;
    observer?.disconnect();
    const pane = scroller(root),
      height = pane.scrollHeight,
      top = pane.scrollTop;
    rewind(first);
    paused = false;
    paint();
    const added = pane.scrollHeight - height;
    pane.scrollTo({ top: top + added });
    paused = !!observer && first > 0 && added <= 1;
    if (paused) paint();
    else observe();
  }
  function observe() {
    const sentinel = root.querySelector(".load-earlier");
    if (sentinel && first > 0) observer?.observe(sentinel);
  }
  applyVisibility = paint;
  paint();
  observe();
  void s
    .adminErrors("scope=" + encodeURIComponent(s.scope) + "&sessionId=" + encodeURIComponent(sessionId))
    .then((rows: Row[] | null) => {
      if (current()) {
        errors = rows;
        paint();
      }
    });
  requestAnimationFrame(() => {
    if (current()) scroller(root).scrollTo({ top: expand ? 0 : scroller(root).scrollHeight });
  });
}
