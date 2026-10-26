import { html, nothing, type TemplateResult } from "lit";
import { ChevronDown, ChevronUp, Pin } from "lucide";
import type { SessionPin } from "./core-bridge";
import { splitLinks } from "./linkify";
import { icon } from "./icons";

function linkifiedText(text: string): TemplateResult {
  return html`${splitLinks(text).map((seg) =>
    seg.kind === "link"
      ? html`<a href=${seg.href} target="_blank" rel="noreferrer noopener">${seg.href}</a>`
      : seg.text,
  )}`;
}

function pinText(pin: SessionPin): TemplateResult {
  return linkifiedText(pin.text ?? pin.preview ?? `entry #${pin.entrySeq}`);
}

export function pinnedStrip(
  pins: readonly SessionPin[],
  expanded: boolean,
  togglePins: (e: Event) => void,
): TemplateResult | typeof nothing {
  if (!pins.length) return nothing;
  const first = pins[0]!;
  return html`<div class="pinned-strip ${expanded ? "expanded" : "collapsed"}">
    <div class="pinned-strip-head" @click=${togglePins}>
      ${icon(Pin, 13)}<span class="pinned-strip-count">${pins.length}</span>
      ${
        expanded
          ? html`<span class="pinned-strip-label">Pinned</span>`
          : html`<span class="pinned-strip-peek">${pinText(first)}</span>`
      }
      <button class="pinned-strip-toggle" aria-expanded=${expanded} title=${expanded ? "Collapse pins" : "Show pins"}>
        ${icon(expanded ? ChevronUp : ChevronDown, 13)}
      </button>
    </div>
    ${
      expanded
        ? pins.map(
            (p) =>
              html`<div class="pinned-item">
                <span class="pinned-item-text">${pinText(p)}</span>
                ${p.text && p.preview ? html`<span class="pinned-item-preview">${linkifiedText(p.preview)}</span>` : nothing}
              </div>`,
          )
        : nothing
    }
  </div>`;
}
