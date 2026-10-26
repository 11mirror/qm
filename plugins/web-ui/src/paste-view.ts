import type { Agent } from "@earendil-works/pi-agent-core";
import { html, nothing, type TemplateResult } from "lit";
import { X } from "lucide";
import { icon } from "./icons";
import { base64ToText, bytesToBase64, insertIntoDraft } from "./paste-text";
import { tip } from "./tooltip";
import type { ConvCtx } from "./conv-types";
import type { Attachment } from "@earendil-works/pi-web-ui";

export function createPasteView({
  ctx,
  composerState,
  focusField,
  persistDraft,
  removeAttachment,
  resizeComposer,
}: {
  ctx: ConvCtx;
  composerState: {
    draft: string;
    attachments: Attachment[];
    pasteView: { id: string; text: string; initial: string; dirty: boolean } | null;
  };
  focusField: (selector: string, cursor?: number) => void;
  persistDraft: () => void;
  removeAttachment: (id: string, agent: Agent) => void;
  resizeComposer: () => void;
}) {
  function pasteViewDialog(agent: Agent): TemplateResult | typeof nothing {
    const view = composerState.pasteView;
    if (!view) return nothing;
    return html`
      <div
        class="project-dialog-backdrop"
        @click=${(e: MouseEvent) => e.target === e.currentTarget && closePasteView(agent)}
        @keydown=${(e: KeyboardEvent) => e.key === "Escape" && closePasteView(agent)}
      >
        <div class="project-dialog paste-dialog" role="dialog" aria-modal="true" aria-labelledby="paste-dialog-title">
          <div class="project-dialog-head">
            <div><h2 id="paste-dialog-title">Pasted text</h2></div>
            <button
              class="chip-x"
              type="button"
              aria-label="Close"
              ${tip("Close")}
              @click=${() => closePasteView(agent)}
            >
              ${icon(X, 16)}
            </button>
          </div>
          <textarea
            class="paste-dialog-text"
            dir="auto"
            @input=${(e: InputEvent) => {
              view.text = (e.currentTarget as HTMLTextAreaElement).value;
              view.dirty = true;
            }}
          >
  ${view.initial}</textarea>
          <div class="project-dialog-actions">
            <button class="btn" type="button" @click=${() => removeAttachment(view.id, agent)}>Remove</button>
            <button class="btn" type="button" @click=${() => insertPasteIntoDraft(agent)}>Insert into message</button>
            <button class="btn primary" type="button" @click=${() => closePasteView(agent)}>Done</button>
          </div>
        </div>
      </div>
    `;
  }

  function openPasteView(id: string, agent: Agent): void {
    const attachment = composerState.attachments.find((a) => a.id === id);
    if (!attachment) return;
    const text = attachment.extractedText ?? base64ToText(attachment.content);
    composerState.pasteView = { id, text, initial: text, dirty: false };
    ctx.chat.drawActiveChat(agent);
    requestAnimationFrame(() => ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".paste-dialog-text")?.focus());
  }

  function closePasteView(agent: Agent): void {
    const view = composerState.pasteView;
    if (!view) return;
    const attachment = composerState.attachments.find((a) => a.id === view.id);
    if (attachment && view.dirty) {
      const bytes = new TextEncoder().encode(view.text);
      attachment.content = bytesToBase64(bytes);
      attachment.size = bytes.length;
      attachment.extractedText = view.text;
    }
    composerState.pasteView = null;
    ctx.chat.drawActiveChat(agent);
  }

  function insertPasteIntoDraft(agent: Agent): void {
    const view = composerState.pasteView;
    if (!view) return;
    const ta = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".composer-input");
    const { draft, cursor } = insertIntoDraft(composerState.draft, view.text, ta ? ta.selectionStart : null);
    composerState.draft = draft;
    persistDraft();
    composerState.pasteView = null;
    removeAttachment(view.id, agent);
    resizeComposer();
    requestAnimationFrame(() => focusField(".composer-input", cursor));
  }

  return { closePasteView, openPasteView, pasteViewDialog };
}
