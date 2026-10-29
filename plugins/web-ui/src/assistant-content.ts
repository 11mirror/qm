import type { AssistantMessage } from "@earendil-works/pi-ai";
import { markdown } from "./message-markdown";
import { html, nothing, type TemplateResult } from "lit";
import type { AssistantWork } from "./transcript-messages";
import { withBase, type DeliveredFile } from "./core-bridge";
import { streamedAnswer, currentTextPhase } from "./timeline";
import {
  connectorCard,
  connectorLinksIn,
  setupContent,
  stripConnectorLinks,
  type ConnectorLink,
} from "./connector-link";
import { deepLinkPath, UI_BASE } from "./deep-link";
import { splitSlackWire, stripSlackDirectives } from "./slack-text";
import { sheenLabel } from "./ui";
import { appState } from "./shell";
import { surfaceOf } from "./session-list";
import type { ConvCtx } from "./conv-types";
import type { ChatState } from "./chat-state";
import type { RunSlot } from "./run-stream";

export function createAssistantContent({
  ctx,
  chatState,
  runSlot,
  deliveredFileBadge,
  isConnectorConnected,
}: {
  ctx: ConvCtx;
  chatState: ChatState;
  runSlot: RunSlot;
  deliveredFileBadge: (file: DeliveredFile) => TemplateResult;
  isConnectorConnected: (provider: string) => boolean;
}) {
  function withReturnTo(url: string): string {
    const returnTo = deepLinkPath(UI_BASE, "chats", chatState.sessionId);
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}returnTo=${encodeURIComponent(returnTo)}`;
  }

  async function continueAfterConnection(name: string): Promise<void> {
    const agent = chatState.agent;
    if (!agent) return;
    await ctx.composer.refreshRuntimeSelection(chatState.scopeId, agent);
    await ctx.composer.sendSuggestedPrompt(`I connected ${name}. Please continue.`, agent);
  }

  function connectorWidget(link: ConnectorLink): TemplateResult {
    if (link.provider === "slack-bot") return html`<qm-slack-setup></qm-slack-setup>`;
    return connectorCard(link, isConnectorConnected(link.provider), withReturnTo);
  }

  function isReadOnlySlackView(): boolean {
    return !chatState.agent && chatState.forkSession !== null && surfaceOf(chatState.forkSession) === "slack";
  }

  function assistantDisplayText(text: string, stopReason?: string): string {
    if (stopReason === "aborted" && text.trim() === "(stopped)") return "";
    return isReadOnlySlackView() ? stripSlackDirectives(text) : text;
  }

  function slackWireBubble(text: string): TemplateResult {
    const self = (appState.me?.user?.split("@")[0] ?? "").trim().toLowerCase();
    const chip = (handle: string): TemplateResult =>
      html`<span class="slack-mention ${handle.toLowerCase() === self ? "self" : ""}">@${handle}</span>`;
    const segments = splitSlackWire(text).map((seg) => {
      if (seg.kind === "mention") return chip(seg.handle);
      if (seg.kind === "link")
        return html`<a class="assistant-text-link" href=${seg.href} target="_blank" rel="noreferrer noopener"
          >${seg.label}</a
        >`;
      return seg.text;
    });
    return html`<div class="slack-wire-text" dir="auto">${segments}</div>`;
  }

  function assistantContent(message: AssistantMessage, isStreaming = false, hasWork = false): TemplateResult[] {
    const animating = isStreaming && runSlot.stopGeneration !== runSlot.generation;
    const parts: TemplateResult[] = [];
    for (const [chunkIndex, chunk] of message.content.entries()) {
      if (chunk.type === "text") {
        const work = (message as AssistantWork).work;
        const phase = work ? currentTextPhase(work) : null;
        const streamingFinal = isStreaming && phase?.phase === "final_answer";
        const workActive =
          hasWork && isStreaming && !streamingFinal && (work?.status === "working" || work?.status === "thinking");
        const text = isStreaming && work ? streamedAnswer(chunk.text, work) : chunk.text;
        for (const [partIndex, part] of setupContent(
          assistantDisplayText(workActive ? "" : text, message.stopReason),
        ).entries()) {
          if (part.type !== "text") {
            if (!(message as AssistantWork).persisted) continue;
            parts.push(
              html`<qm-connect-apps
                .me=${appState.me}
                .base=${withBase("")}
                .widget=${part.type === "setup" ? "apps" : part.type}
                .toolkit=${part.type === "setup" ? (part.toolkit ?? "") : ""}
                .onConnected=${continueAfterConnection}
                .returnKey=${`reply:${message.timestamp}:${chunkIndex}:${partIndex}`}
              ></qm-connect-apps>`,
            );
            continue;
          }
          const shown = part.text;
          const links = shown.trim() ? connectorLinksIn(shown, location.origin) : [];
          const body = links.length ? stripConnectorLinks(shown, links) : shown;
          if (body.trim())
            parts.push(
              html`<div class="streaming-text ${animating ? "live-stream" : ""}" dir="auto">
                ${markdown(body, animating, isStreaming && work ? streamedAnswer((message as AssistantWork).streamingBaseline ?? "", work) : ((message as AssistantWork).streamingBaseline ?? ""))}
              </div>`,
            );
          for (const link of links) parts.push(connectorWidget(link));
        }
      }
      if (chunk.type === "thinking" && chunk.thinking.trim()) {
        parts.push(
          html`<details class="thinking">
            <summary>${sheenLabel("Thinking", animating)}</summary>
            ${markdown(chunk.thinking)}
          </details>`,
        );
      }
    }
    return parts;
  }

  function assistantFileList(files: DeliveredFile[] | undefined): TemplateResult | typeof nothing {
    if (!files?.length) return nothing;
    return html`<div class="message-files">${files.map((f) => deliveredFileBadge(f))}</div>`;
  }
  return { assistantContent, assistantDisplayText, assistantFileList, isReadOnlySlackView, slackWireBubble };
}
