import { attachmentSrc, openImagePreview } from "./composer-attachments";
import { composerInput } from "./composer-input";
import { appEditSlug } from "./app-edit";
import { getRuntimeConfig } from "./runtime-config-cache.ts";
import type { Agent } from "@earendil-works/pi-agent-core";
import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { ArrowUp, Box, FileText, Paperclip, Square, X } from "lucide";
import {
  approvalBlocksComposer,
  type ApprovalDecision,
  type PendingApproval,
  alwaysSteer,
  switchedDefault,
} from "./core-bridge";
import { browserRenderableImage, fieldSelect } from "./ui";
import { icon } from "./icons";
import { defaultModelValue, getModelOptions } from "./model-options";
import { appState } from "./shell";
import { pasteChipLabel } from "./paste-text";
import { tip } from "./tooltip";
import { isPhone } from "./viewport";
import type { SkillMatch, Composer } from "./composer";
import { modelOptionFor, changeScopeRuntime, selectModel, toggleFastMode } from "./composer-runtime";

export function composerForm(c: Composer, agent: Agent, header: TemplateResult | typeof nothing = nothing) {
  const activeRuntimeConfig = getRuntimeConfig(c.scopeKey());
  const selectedModel = c.currentModelOption();
  if (!selectedModel) return unavailableModelForm(c, agent, header, activeRuntimeConfig);
  const approvalPauses = c.ctx.chat.activePendingApprovals();
  const blockingPauses = approvalPauses.filter(approvalBlocksComposer);
  const runtimePending = activeRuntimeConfig === null;
  const inputBlocked = runtimePending || c.ctx.chat.state.resolvingApprovals.size > 0 || blockingPauses.length > 0;
  let placeholder =
    c.options.placeholder ??
    (appEditSlug(c.ctx.chat.state.threadRef, appState.me?.user) ? "Describe a change…" : "Ask anything");
  if (inputBlocked) placeholder = runtimePending ? "Loading runtime…" : "Approve or deny to continue";
  else if (agent.state.isStreaming) placeholder = "Queue a message for after this turn…";
  let composerNotice: TemplateResult | typeof nothing = nothing;
  if (c.state.processingFiles) {
    composerNotice = html`<div class="composer-note">Preparing files...</div>`;
  } else if (!approvalPauses.length && runtimePending) {
    composerNotice = c.state.error
      ? html`<div class="composer-error">
          ${c.state.error}
          <button type="button" @click=${() => void c.reloadRuntime(agent)}>Retry</button>
        </div>`
      : html`<div class="composer-note">Loading runtime settings…</div>`;
  } else if (c.state.error) {
    composerNotice = html`<div class="composer-error">${c.state.error}</div>`;
  }

  const compact = Boolean(c.ctx.pane) || isPhone();
  const turnRuntime = c.ctx.chat.turnRuntime();
  const routed =
    turnRuntime?.change && !switchedDefault(turnRuntime) && turnRuntime.modelId !== selectedModel.model.id
      ? turnRuntime
      : undefined;
  const runtimeControls = c.modelPicker.render(agent, selectedModel, inputBlocked, routed);
  return html`
    <form
      class="composer-wrap ${compact ? "compact" : ""}"
      @submit=${(e: Event) => submitComposer(c, e, agent)}
      @keydown=${(e: KeyboardEvent) => composerShortcut(c, e, agent, inputBlocked)}
    >
      ${header} ${slashMenu(c, agent)}
      ${
        !c.options.prepareSubmit && activeRuntimeConfig?.upgradeAvailable
          ? html`<div class="runtime-upgrade">
              <span
                >The org now recommends
                ${modelOptionFor(activeRuntimeConfig.orgDefault.modelId, c.scopeKey())?.buttonLabel ?? activeRuntimeConfig.orgDefault.modelId}.</span
              >
              <button
                type="button"
                @click=${() => changeScopeRuntime(c, { modelId: activeRuntimeConfig!.orgDefault.modelId }, agent)}
              >
                Upgrade
              </button>
              <button type="button" @click=${() => changeScopeRuntime(c, { keep: true }, agent)}>Keep mine</button>
              <button type="button" @click=${() => changeScopeRuntime(c, { inherit: true }, agent)}>
                Inherit future defaults
              </button>
            </div>`
          : nothing
      }
      ${attachmentStrip(c, agent)} ${approvalPauses.length ? composerApprovalPanel(c, approvalPauses) : nothing}
      ${
        blockingPauses.length
          ? nothing
          : composerInput({
              value: c.state.draft,
              placeholder,
              disabled: inputBlocked,
              onInput: (e) => c.onDraftInput(e, agent),
              onKeydown: (e) => c.onComposerKeydown(e, agent),
              onPaste: (e) => void c.attachments.onComposerPaste(e, agent),
            })
      }
      <div class="composer-toolbar">
        <div class="composer-left">
          <input
            class="file-input"
            type="file"
            multiple
            hidden
            ?disabled=${inputBlocked}
            @change=${(e: Event) => void c.attachments.onFilesSelected(e, agent)}
          />
          <button
            class="icon-btn composer-attach"
            type="button"
            aria-label="Attach files"
            ${tip("Attach files")}
            ?disabled=${inputBlocked}
            @click=${() => c.attachments.pickFiles()}
          >
            ${icon(Paperclip, 18)}
          </button>
          ${runtimeControls}
        </div>
        <div class="composer-right">${sendControls(c, agent)}</div>
      </div>
      ${composerNotice}
    </form>
    ${c.paste.pasteViewDialog(agent)}
  `;
}

function unavailableModelForm(
  c: Composer,
  agent: Agent,
  header: TemplateResult | typeof nothing,
  activeRuntimeConfig: ReturnType<typeof getRuntimeConfig>,
): TemplateResult {
  const selected = c.threadPick() ?? defaultModelValue(c.scopeKey());
  return html`<div class="composer-wrap">
    ${header} ${composerApprovalPanel(c, c.ctx.chat.activePendingApprovals())}
    <p role="status">
      ${c.state.error || activeRuntimeConfig?.unavailableReason || "Selected model is unavailable. Choose a replacement to continue."}
      ${selected}
    </p>
    <label
      >Replacement model
      ${fieldSelect({
        ariaLabel: "Replacement model",
        value: "",
        options: html`<option value="" selected>Select a model…</option>
          ${getModelOptions(c.scopeKey()).map((option) => html`<option value=${option.value}>${option.label}</option>`)}`,
        onChange: async (value) => {
          const option = modelOptionFor(value, c.scopeKey());
          if (!option) return;
          await changeScopeRuntime(c, { modelId: option.model.id }, agent);
          if (getRuntimeConfig(c.scopeKey())?.effective.modelId === option.model.id) selectModel(c, value, agent);
        },
      })}
    </label>
    <button type="button" @click=${() => void c.reloadRuntime(agent)}>Refresh models</button>
  </div>`;
}

function attachmentStrip(c: Composer, agent: Agent): TemplateResult | typeof nothing {
  if (!c.state.attachments.length) return nothing;
  return html`
    <div class="attachment-strip">
      ${repeat(
        c.state.attachments,
        (a) => a.id,
        (a) => html`
          <span class=${browserRenderableImage(a.mimeType) ? "file-chip composer-image" : "file-chip"}>
            ${
              browserRenderableImage(a.mimeType)
                ? html`<button
                    type="button"
                    class="composer-image-open"
                    aria-label=${`Preview ${a.fileName}`}
                    @click=${() => openImagePreview(a)}
                  >
                    <img
                      src=${attachmentSrc(a)}
                      alt=${a.fileName}
                      @error=${(event: Event) => {
                        (event.currentTarget as HTMLImageElement).parentElement!.hidden = true;
                      }}
                    />
                  </button>`
                : nothing
            }
            ${
              c.pastedTextIds.has(a.id)
                ? html`
                    <button
                      type="button"
                      class="chip-open"
                      aria-label="View pasted text"
                      ${tip("View pasted text")}
                      @click=${() => c.paste.openPasteView(a.id, agent)}
                    >
                      ${icon(FileText, 14)}
                      <span>${pasteChipLabel(a.extractedText?.length ?? 0)}</span>
                    </button>
                  `
                : html`${browserRenderableImage(a.mimeType) ? nothing : icon(Paperclip, 14)}<span
                      dir="auto"
                      title=${a.fileName}
                      >${a.fileName}</span
                    >`
            }
            <button
              type="button"
              class="chip-x"
              aria-label="Remove attachment"
              ${tip("Remove")}
              @click=${() => c.attachments.removeAttachment(a.id, agent)}
            >
              ${icon(X, 13)}
            </button>
          </span>
        `,
      )}
    </div>
  `;
}

function sendControls(c: Composer, agent: Agent): TemplateResult {
  if (!agent.state.isStreaming || c.ctx.chat.isStopping()) {
    return html`<button
      class="send-btn"
      type="submit"
      aria-label="Send"
      ${tip("Send")}
      ?disabled=${!c.composerCanSend()}
    >
      ${icon(ArrowUp, 16)}
    </button>`;
  }
  const label = alwaysSteer() && c.canSteer(agent) ? "Steer the running task" : "Queue for after this turn";
  return html`
    <button class="stop-btn" type="button" aria-label="Stop" ${tip("Stop")} @click=${() => c.stopStreaming(agent)}>
      ${icon(Square, 16)}
    </button>
    <button class="send-btn" type="submit" ${tip(label)} aria-label=${label} ?disabled=${!c.composerCanSend()}>
      ${icon(ArrowUp, 16)}
    </button>
  `;
}

export function composerApprovalPanel(
  c: Composer,
  approvals: PendingApproval[],
  resolve: (decision: ApprovalDecision) => void = c.ctx.chat.resolveCommandApproval,
): TemplateResult {
  const decide = (decision: ApprovalDecision): void => {
    if (!c.ctx.chat.state.resolvingApprovals.has(decision.requestId)) resolve(decision);
  };
  const choices = [
    { label: "Deny", className: "approval-btn deny", approved: false },
    { label: "Allow once", className: "approval-btn", approved: true, scope: "once" },
    { label: "Allow for session", className: "approval-btn primary", approved: true, scope: "session" },
    { label: "Allow always", className: "approval-btn", approved: true, scope: "always" },
  ] as const;
  return html`<div class="composer-approval-panel" role="group" aria-label="Command approval">
    ${approvals.map(
      (a) =>
        html`<div class="composer-approval">
          <div class="composer-approval-copy">${c.ctx.chat.approvalSummaryView(a, true)}</div>
          <div class="approval-actions">
            ${choices
              .filter(
                (option) => !("scope" in option) || option.scope === "once" || a.grantModes?.[option.scope] !== false,
              )
              .map(
                ({ label, className, ...choice }) =>
                  html`<button
                    class=${className}
                    type="button"
                    ?disabled=${c.ctx.chat.state.resolvingApprovals.has(a.requestId)}
                    @click=${() => decide({ requestId: a.requestId, ...choice })}
                  >
                    ${label}
                  </button>`,
              )}
          </div>
        </div>`,
    )}
  </div>`;
}

function composerShortcut(c: Composer, e: KeyboardEvent, agent: Agent, disabled: boolean): void {
  if (disabled || e.defaultPrevented || !e.metaKey) return;
  if (e.shiftKey && e.code === "KeyE") {
    e.preventDefault();
    toggleFastMode(c, agent);
  }
}

function slashMenu(c: Composer, agent: Agent): TemplateResult | typeof nothing {
  const slash = c.currentSlashMenu();
  if (!slash.open) return nothing;
  if (slash.loading && slash.matches.length === 0) {
    return html`<div class="slash-popover">
      <div class="menu-title">Skills</div>
      <div class="slash-empty">Loading skills…</div>
    </div>`;
  }
  const active = c.clampedActive(slash.matches.length);
  return html`
    <div class="slash-popover" role="listbox" aria-label="Skills">
      <div class="menu-title">Skills</div>
      ${slash.matches.map((m, i) => slashRow(c, m, i === active, agent))}
    </div>
  `;
}

function slashRow(c: Composer, m: SkillMatch, active: boolean, agent: Agent): TemplateResult {
  return html`
    <button
      type="button"
      role="option"
      aria-selected=${active ? "true" : "false"}
      class="slash-option ${active ? "active" : ""}"
      ${tip(m.skill.description)}
      @mousedown=${(e: Event) => e.preventDefault()}
      @click=${() => c.acceptSkill(m.skill, agent)}
    >
      <span class="slash-icon">${icon(Box, 16)}</span>
      <span class="slash-name">${highlightName(m)}</span>
      <span class="slash-desc">${m.skill.description}</span>
      <span class="slash-scope">${scopeBadge(m.skill.scope)}</span>
    </button>
  `;
}

function highlightName(m: SkillMatch): TemplateResult {
  const { name } = m.skill;
  if (m.start < 0 || m.end <= m.start) return html`${name}`;
  return html`${name.slice(0, m.start)}<b>${name.slice(m.start, m.end)}</b>${name.slice(m.end)}`;
}

function scopeBadge(scope: string): string {
  return scope ? scope.charAt(0).toUpperCase() + scope.slice(1) : "";
}

function submitComposer(c: Composer, e: Event, agent: Agent): void {
  e.preventDefault();
  void c.sendPrompt(agent);
}
