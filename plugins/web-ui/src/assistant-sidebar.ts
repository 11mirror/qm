import { html, nothing, type TemplateResult } from "lit";
import type { DirectiveResult } from "lit/directive.js";
import { ChevronDown } from "lucide";
import { icon } from "./icons";
type Content = TemplateResult | DirectiveResult | typeof nothing;

export function messageRow(cls: string, index: number, seqs: number[], body: TemplateResult): TemplateResult {
  return html`<article class="message-row ${cls}" data-index=${index} data-entry-seqs=${seqs.join(" ")}>
    ${body}
  </article>`;
}

export function userBubble(
  content: Content,
  opts: { hidden?: boolean; deleted?: boolean; revision?: string } = {},
): TemplateResult {
  return html`<div
    class="message-bubble user-bubble ${opts.deleted ? "deleted-bubble" : ""}"
    ?hidden=${Boolean(opts.hidden)}
  >
    <div class="pin-content">
      ${content} ${opts.revision ? html`<span class="revision-badge">(${opts.revision})</span>` : nothing}
    </div>
    <button class="pin-toggle" type="button" hidden aria-expanded="false">
      <span class="pin-toggle-label">Show more</span>${icon(ChevronDown, 14)}
    </button>
  </div>`;
}
