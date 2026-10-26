import { html, render, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { repeat } from "lit/directives/repeat.js";
import { copyText, linkClick, type ErrorRow } from "./dom.ts";
import { firstLine, pick, relTime, titleCase } from "./format.ts";

export function node(template: unknown): HTMLElement {
  const fragment = document.createDocumentFragment();
  render(template, fragment);
  return fragment.firstElementChild as HTMLElement;
}

export function badge(text: unknown, kind = "", title = "") {
  return html`<span class=${"badge" + (kind ? " " + kind : "")} title=${ifDefined(title || undefined)}>${text}</span>`;
}

export const empty = (text: unknown) => html`<p class="empty">${text}</p>`;

export const stacked = (primary: unknown, secondary: unknown) =>
  html`<div>
    <div class="primaryline">${primary}</div>
    ${secondary ? html`<div class="subline">${secondary}</div>` : nothing}
  </div>`;

export const subline = (text: unknown) => html`<span class="subline">${text}</span>`;

export const matches = (needle: string, ...parts: unknown[]) =>
  parts.join(" ").toLowerCase().includes(needle.trim().toLowerCase());

export function keepSearch(doc: Document, previous: HTMLElement | null, shell: () => void) {
  if (previous && !previous.isConnected) return previous;
  const active = doc.activeElement as HTMLElement | null;
  const focused = !!active && !!previous?.contains(active);
  shell();
  const search = doc.querySelector<HTMLElement>("#shellbar .shell-search");
  if (!previous || !search) return search;
  search.replaceWith(previous);
  if (focused) active?.focus({ preventScroll: true });
  return previous;
}

function cell(value: any): unknown {
  if (value?.node) return value.node;
  if (value?.action) {
    const a = value.action;
    return html`<button
      type="button"
      class=${"rowbtn" + (a.danger ? " danger" : "")}
      ?disabled=${!!a.disabled}
      title=${ifDefined(a.title || undefined)}
      @click=${a.run}
    >
      ${a.label}
    </button>`;
  }
  if (value && typeof value === "object") return value.text;
  return value == null ? "" : String(value);
}

export function table(
  headers: unknown[],
  rows: any[][],
  none: string,
  onOpen?: (index: number) => void,
  options: { className?: string; wrapClass?: string } = {},
) {
  if (!rows.length) return empty(none);
  return html`<div class=${"tablewrap" + (options.wrapClass ? " " + options.wrapClass : "")}>
    <table class=${ifDefined(options.className)}>
      <thead>
        <tr>
          ${headers.map((h) => html`<th>${h}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (row, i) =>
            html`<tr class=${ifDefined(onOpen ? "openable" : undefined)} @click=${onOpen ? () => onOpen(i) : nothing}>
              ${row.map((value, j) => html`<td class=${ifDefined(value?.cls)}>${onOpen && j === 0 ? html`<div class="open">${cell(value)}</div>` : cell(value)}</td>`)}
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

export function card(title: unknown, subtitle: unknown, content: unknown, headExtra: unknown = nothing) {
  return html`<section class="card">
    <div class="head">
      <h2>${title}</h2>
      ${subtitle ? html`<p>${subtitle}</p>` : nothing}${headExtra}
    </div>
    <div class="body">${content}</div>
  </section>`;
}

export const bareCard = (content: unknown) => html`<section class="card"><div class="body">${content}</div></section>`;

export function pager(total: number, limit: number, offset: number, go: (page: number) => void) {
  if (total <= limit) return nothing;
  const current = Math.floor(offset / limit) + 1;
  return html`<div class="pager">
    <button type="button" class="page" ?disabled=${current <= 1} @click=${() => go(current - 1)}>← Prev</button
    ><span class="pageinfo">${offset + 1}–${Math.min(offset + limit, total)} of ${total}</span
    ><button
      type="button"
      class="page"
      ?disabled=${current >= Math.ceil(total / limit)}
      @click=${() => go(current + 1)}
    >
      Next →
    </button>
  </div>`;
}

export function renderer(root: HTMLElement) {
  const end = root.appendChild(document.createComment(""));
  return (template: unknown) => {
    if (end.parentNode === root) render(template, root, { renderBefore: end });
  };
}

export const mount = (root: HTMLElement, template: unknown) => renderer(root)(template);

export function denseList(items: any[], rowOf: (item: any) => any, open: (item: any) => void, none: string) {
  if (!items.length) return empty(none);
  return html`<div class="dense-list">
    ${repeat(
      items,
      (item) => item.id || item.scopeId || item.container || item,
      (item) => {
        const r = rowOf(item);
        const content = html`${r.icon ? html`<span class="dense-icon">${r.icon}</span>` : nothing}<span
            class="dense-name"
            >${r.name}</span
          ><span class="dense-preview">${r.preview ?? ""}</span
          >${r.time != null ? html`<span class="dense-time">${r.time}</span>` : nothing}`;
        const click = (e: MouseEvent) => {
          if (r.href && (r.target || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return;
          if (r.href) e.preventDefault();
          open(item);
        };
        return r.href
          ? html`<a
              class=${"dense-row" + (r.cls ? " " + r.cls : "")}
              href=${r.href}
              target=${ifDefined(r.target)}
              rel=${ifDefined(r.target ? "noopener" : undefined)}
              @click=${click}
              >${content}</a
            >`
          : html`<div
              class=${"dense-row" + (r.cls ? " " + r.cls : "")}
              tabindex="0"
              role="button"
              @click=${click}
              @keydown=${(e: KeyboardEvent) => e.key === "Enter" && open(item)}
            >
              ${content}
            </div>`;
      },
    )}
  </div>`;
}

export function mountTemplate(selector: string, template: () => unknown) {
  const placeholder = document.querySelector(selector);
  if (!placeholder) return () => {};
  const root = document.createDocumentFragment();
  const draw = () => render(template(), root);
  draw();
  placeholder.replaceWith(root);
  return draw;
}

export function scroller(from: Element): HTMLElement {
  return from.closest<HTMLElement>(".pane") ?? (document.scrollingElement as HTMLElement);
}

const STATUS_KIND = { done: "ok", failed: "err", running: "info", pending: "warn" };
export const statusBadge = (status: string | null | undefined) =>
  badge(titleCase(status || "unknown"), pick(STATUS_KIND, status, "muted"));

export const metaChip = (text: string, kind = "") =>
  html`<span class=${"meta-chip" + (kind ? " " + kind : "")}>${text}</span>`;

export function copyButton(label: string, getText: () => string) {
  return html`<button
    type="button"
    class="copy"
    @click=${async (ev: Event) => {
      ev.stopPropagation();
      const btn = ev.currentTarget as HTMLButtonElement;
      const ok = await copyText(getText());
      btn.textContent = ok ? "Copied" : "Copy failed";
      if (ok) btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove("copied");
      }, 1200);
    }}
  >
    ${label}
  </button>`;
}

export function errorStripBox(
  errs: ErrorRow[],
  headText: string,
  max: number,
  rowLink?: (e: ErrorRow) => { href: string; go: () => void } | null,
) {
  const row = (e: ErrorRow) => {
    const link = rowLink ? rowLink(e) : null;
    const meta = [e.category || "uncategorized", e.code, relTime(e.ts)].filter(Boolean).join(" · ");
    const content = html`<span class="mono" title=${e.message || ""}
        >${firstLine(e.message || "(no message)", 160)}</span
      ><span class="subline">${meta}</span>`;
    return link
      ? html`<a class="error-strip-row" href=${link.href} @click=${linkClick(link.go)}>${content}</a>`
      : html`<div class="error-strip-row">${content}</div>`;
  };
  return html`<div class="error-strip">
    <div class="error-strip-head">${headText}</div>
    ${errs.slice(0, max).map(row)}${
      errs.length > max ? html`<div class="subline">${"…and " + (errs.length - max) + " more"}</div>` : nothing
    }
  </div>`;
}
