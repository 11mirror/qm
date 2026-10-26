import { html, nothing, type TemplateResult } from "lit";
import type { DirectiveResult } from "lit/directive.js";
import { ChevronDown, Send } from "lucide";
import { markdown } from "./message-markdown";
import { icon } from "./icons";
import { tip } from "./tooltip";

type Content = TemplateResult | DirectiveResult | typeof nothing;

export type AssistantSidebarContext =
  | { kind: "thread"; source: string; hasDraft: boolean; sent: boolean; resolved: boolean }
  | { kind: "inbox"; hasEmail: boolean; hasSlack: boolean; hasDrafts: boolean };

export function assistantPrompts(context: AssistantSidebarContext): readonly string[] {
  if (context.kind === "inbox") {
    const prompts = [context.hasEmail && !context.hasSlack ? "Summarize my recent emails" : "Summarize my inbox"];
    prompts.push(context.hasDrafts ? "Which drafts should I review first?" : "What needs my attention?");
    return prompts;
  }
  if (context.sent) return ["Summarize this email", "What should I follow up on?"];
  if (context.source === "generic") return ["Explain the proposal", "What needs my input?"];
  if (context.resolved) return ["Summarize this thread", "Does this still need a reply?"];
  if (context.hasDraft) return ["Make it shorter", "Make it more friendly", "Remove the salutations"];
  return ["Summarize this thread", "Help me write a reply"];
}

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

export function threadMessage(
  message: { role: "human" | "agent" | "system"; text: string },
  index: number,
): TemplateResult {
  if (message.role === "human")
    return messageRow("user-row", index, [], userBubble(markdown(message.text), { hidden: !message.text.trim() }));
  if (message.role === "system")
    return messageRow(
      "system-note-row",
      index,
      [],
      html`<div class="system-note"><span class="system-note-text">${message.text}</span></div>`,
    );
  return messageRow("assistant-row", index, [], html`<div class="assistant-body">${markdown(message.text)}</div>`);
}

export function assistantSidebar(options: {
  context: AssistantSidebarContext;
  messages: Content;
  composer: Content;
  showPrompts: boolean;
  busy?: boolean;
  status?: Content;
  toolbar?: Content;
  send?: { disabled: boolean; run: (event: MouseEvent) => void };
  onPrompt: (prompt: string, event: MouseEvent) => void;
  overlay?: Content;
  onDragEnter?: (event: DragEvent) => void;
  onDragOver?: (event: DragEvent) => void;
  onDragLeave?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
}): TemplateResult {
  return html`<div
    class="inbox-chat assistant-sidebar"
    @dragenter=${options.onDragEnter}
    @dragover=${options.onDragOver}
    @dragleave=${options.onDragLeave}
    @drop=${options.onDrop}
  >
    ${options.overlay ?? nothing}
    <section class="chat-scroll inbox-chat-log" tabindex="0" aria-label="Conversation">
      <div class="message-stack">${options.messages}</div>
    </section>
    ${options.status ?? nothing}
    <div class="chat-bottom-dock">
      ${options.toolbar ?? nothing}
      ${
        options.send || options.showPrompts
          ? html`<div class="inbox-chat-suggestions">
              ${options.send ? html`<button class="inbox-suggest-chip primary" type="button" ?disabled=${options.send.disabled} ${tip("Send the draft with your instructions")} @click=${options.send.run}>${icon(Send, 12)}<span>Send it</span></button>` : nothing}
              <div class="inbox-edit-suggestions">
                ${(options.showPrompts ? assistantPrompts(options.context) : []).map((prompt) => html`<button class="inbox-suggest-chip inbox-chat-suggestion" type="button" ?disabled=${options.busy} @click=${(event: MouseEvent) => options.onPrompt(prompt, event)}>${prompt}</button>`)}
              </div>
            </div>`
          : nothing
      }
      <div class="inbox-chat-composer">${options.composer}</div>
    </div>
  </div>`;
}
