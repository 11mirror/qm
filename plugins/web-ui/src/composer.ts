import { createPasteView } from "./paste-view";
import { createComposerQueue } from "./composer-queue";
import {
  attachmentSrc,
  createComposerAttachments,
  loadAnyAttachment,
  openImagePreview,
  textAttachment,
} from "./composer-attachments";
import { composerInput, resizeComposerInput } from "./composer-input";
import { reportHandledError } from "./browser-errors.ts";
import { appEditSlug } from "./app-edit";
import { runtimeConfigKey, loadRuntimeConfig, saveRuntimeConfig, subscribeRuntimeConfig } from "./runtime-config-store";
import { getRuntimeConfig } from "./runtime-config-cache.ts";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createFileDragState } from "./file-open";
import type { Attachment } from "@earendil-works/pi-web-ui";
import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { ArrowUp, Box, FileText, Paperclip, Square, X } from "lucide";
import {
  api,
  approvalBlocksComposer,
  userSendMessage,
  type ApprovalDecision,
  type PendingApproval,
  alwaysSteer,
  switchedDefault,
} from "./core-bridge";
import { PENDING_APPROVAL_REASON } from "./run-stream";
import { MAX_FILES_PER_MESSAGE, uploadAttachments, type CoreAttachment } from "./attachments";
import { errMessage } from "../../chassis/src/errors";
import { browserRenderableImage, fieldSelect } from "./ui";
import { icon } from "./icons";
import {
  defaultEffortForModel,
  defaultModelValue,
  getModelOptions,
  type EffortLevel,
  type ModelOption,
  type ModelOptionValue,
} from "./model-options";
import { modelSupportsFastMode } from "./pi-models";
import type { ComposerSurface, ConvCtx } from "./conv-types";
import { bumpSessionActivity, dropPendingSession, renderList } from "./sessions";
import { appState } from "./shell";
import { pasteChipLabel } from "./paste-text";
import { clearDraft, newChatDraftKey, saveDraft } from "./drafts";
import { tip } from "./tooltip";
import { isPhone } from "./viewport";
import {
  LOADOUT_CAP,
  isUltrafastModel,
  presetModelId,
  ultrafastChoice,
  loadLoadout,
  saveLoadout,
  reconcileLoadout,
  upsertLoadout,
  effortLevelsForModel,
  modelLoadoutOptions,
  supportedEffort,
  type LoadoutEntry,
} from "./composer-loadout";

import { createModelPicker } from "./model-picker";
import {
  carryModelPick,
  forgetThreadPick,
  hasThreadModelPick,
  rememberThreadPick,
  threadModelPick,
} from "./thread-model-picks";

export type ComposerMenu = "effort" | "model" | "settings" | "loadout";

function runtimeScopeKey(scopeId: string | null): string | null {
  if (scopeId) return scopeId;
  const user = appState.me?.user;
  return user ? `personal:${user}` : null;
}

function modelOptionFor(value: ModelOptionValue, scopeKey?: string | null): ModelOption | undefined {
  return getModelOptions(scopeKey).find((option) => option.value === value);
}

export interface SkillItem {
  id?: string;
  name: string;
  description: string;
  body?: string;
  scope: string;
  shadowed?: boolean;
  editable?: boolean;
  scopeId?: string;
  status?: string;
  version?: number;
  source?: "native" | "pack";
  pack?: { packId: string; commit: string; upstreamName: string };
  assetCount?: number;
  requiredCapabilities?: string[];
  createdBy?: string;
  files?: Array<{ path: string; executable?: boolean }>;
}
interface SkillMatch {
  skill: SkillItem;
  start: number;
  end: number;
}

let skillsCache: SkillItem[] | null = null;

export function clearSkillsCache(): void {
  skillsCache = null;
}

const SLASH_TOKEN = /(^|\s)\/([a-zA-Z0-9_-]*)$/;

function slashQuery(draft: string): string | null {
  const m = SLASH_TOKEN.exec(draft);
  return m ? (m[2] ?? "") : null;
}

export interface ComposerSubmission {
  model: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  attachments?: CoreAttachment[];
}

export interface ComposerOptions {
  prepareSubmit?: () => (text: string, options: ComposerSubmission) => Promise<void>;
  placeholder?: string;
  preferenceKey?: string;
  runtimeAccount?: "company";
}

export function createComposerSurface(ctx: ConvCtx, options: ComposerOptions = {}): ComposerSurface {
  let submitting = false;
  const loadoutKey = options.preferenceKey ? `web-ui:loadout:${options.preferenceKey}` : undefined;
  const reloadRuntime = (agent = ctx.chat.state.agent ?? undefined) =>
    refreshRuntimeSelection(ctx.chat.state.scopeId, agent, true);
  const refreshAccount = () => {
    loadoutRestored = false;
    void reloadRuntime();
  };
  window.addEventListener("model-account-changed", refreshAccount);
  const revalidateRuntime = () => {
    if (document.visibilityState === "visible") void reloadRuntime();
  };
  document.addEventListener("visibilitychange", revalidateRuntime);
  window.addEventListener("online", revalidateRuntime);
  let runtimeRequest = 0;
  let runtimeIdentity = "";
  let unsubscribeRuntime: (() => void) | undefined;
  let effortOverride: EffortLevel | undefined;
  let fastModeOverride: boolean | undefined;
  let restoredLoadout: LoadoutEntry | undefined;
  let loadoutRestored = false;
  const revision = { model: 0, effort: 0, fast: 0 };

  function isUnsentNewChat(): boolean {
    return (
      !options.prepareSubmit &&
      ctx.chat.state.sessionId === null &&
      !(ctx.chat.state.agent?.state.messages ?? []).some((m) => !(m as { opener?: boolean }).opener)
    );
  }

  function persistDraft(): void {
    if (!ctx.chat.state.threadRef) return;
    saveDraft(ctx.chat.state.threadRef, composerState.draft);
    if (isUnsentNewChat()) saveDraft(newChatDraftKey(appState.me?.user), composerState.draft);
  }

  function clearActiveDraft(): void {
    if (ctx.chat.state.threadRef) clearDraft(ctx.chat.state.threadRef);
    if (!options.prepareSubmit && ctx.chat.state.sessionId === null) clearDraft(newChatDraftKey(appState.me?.user));
  }

  const composerState = {
    draft: "",
    attachments: [] as Attachment[],
    error: "",
    processingFiles: false,
    dragging: false,
    openMenu: null as ComposerMenu | null,
    menuQuery: "",
    slashDismissed: false,
    get effortLevel(): EffortLevel {
      const selected = currentModelOption();
      const effort =
        effortOverride ??
        (restoredLoadout?.value === selected?.value ? restoredLoadout?.effort : undefined) ??
        (getRuntimeConfig(scopeKey())?.effective.effortLevel as EffortLevel | undefined) ??
        defaultEffortForModel(selected?.model);
      return supportedEffort(selected?.model, effort);
    },
    set effortLevel(value: EffortLevel) {
      ++revision.effort;
      effortOverride = value;
    },
    get fastMode(): boolean | undefined {
      const selected = currentModelOption();
      const fast =
        fastModeOverride ??
        (restoredLoadout?.value === selected?.value ? restoredLoadout?.fast : undefined) ??
        getRuntimeConfig(scopeKey())?.effective.fastMode === true;
      return fast && modelSupportsFastMode(scopeKey(), selected?.model.id);
    },
    set fastMode(value: boolean | undefined) {
      ++revision.fast;
      fastModeOverride = value;
    },
    pasteView: null as { id: string; text: string; initial: string; dirty: boolean } | null,
  };

  const pastedTextIds = new Set<string>();

  const fileDrag = createFileDragState((dragging) => {
    composerState.dragging = dragging;
    ctx.chat.drawActiveChat();
  });
  let skillsLoading = false;
  let skillsLoadFailed = false;
  let slashActiveIndex = 0;
  function effectiveFastMode(): boolean {
    return composerState.fastMode === true;
  }

  function resetComposer(): void {
    Object.assign(composerState, {
      draft: "",
      attachments: [],
      pasteView: null,
      error: "",
      processingFiles: false,
      openMenu: null,
      slashDismissed: false,
    });
    pastedTextIds.clear();
    slashActiveIndex = 0;
  }

  function scopeKey(): string | null {
    return runtimeConfigKey(runtimeScopeKey(ctx.chat.state.scopeId), options.runtimeAccount);
  }

  function threadPick(): ModelOptionValue | undefined {
    return ctx.chat.state.threadRef ? threadModelPick(ctx.chat.state.threadRef) : undefined;
  }

  function currentModelOption(): ModelOption | undefined {
    return modelOptionFor(threadPick() ?? defaultModelValue(scopeKey()), scopeKey());
  }

  function followsDefault(): boolean {
    const selected = currentModelOption();
    const threadRef = ctx.chat.state.threadRef;
    return (
      !!selected &&
      !(threadRef && hasThreadModelPick(threadRef)) &&
      effortOverride === undefined &&
      fastModeOverride === undefined &&
      restoredLoadout?.value !== selected.value
    );
  }

  async function refreshRuntimeSelection(scopeId: string | null, agent?: Agent, refresh = false): Promise<void> {
    const request = ++runtimeRequest;
    const actualScope = runtimeScopeKey(scopeId);
    const key = runtimeConfigKey(actualScope, options.runtimeAccount);
    const identity = `${key}:${ctx.chat.state.threadRef}`;
    const changedIdentity = identity !== runtimeIdentity;
    if (changedIdentity) {
      effortOverride = undefined;
      fastModeOverride = undefined;
      restoredLoadout = undefined;
      loadoutRestored = false;
      runtimeIdentity = identity;
    }
    unsubscribeRuntime?.();
    let defaults = getRuntimeConfig(key)?.effective;
    unsubscribeRuntime =
      key === null
        ? undefined
        : subscribeRuntimeConfig(key, () => {
            if (key !== scopeKey()) return;
            const next = getRuntimeConfig(key)?.effective;
            if (
              (["modelId", "effortLevel", "fastMode"] as const).some((field) => defaults?.[field] !== next?.[field])
            ) {
              restoredLoadout = undefined;
              followDefault(defaults);
            }
            defaults = next;
            syncRuntimeSelection(ctx.chat.state.agent ?? undefined);
          });
    composerState.error = "";
    syncRuntimeSelection(agent);
    const config = actualScope === null ? null : await loadRuntimeConfig(actualScope, refresh, options.runtimeAccount);
    if (request !== runtimeRequest) return;
    if (!config) composerState.error = "Could not load runtime settings.";
    if (config && !loadoutRestored) {
      restoreLoadoutSelection();
      loadoutRestored = true;
    }
    syncRuntimeSelection(agent);
  }

  function followDefault(previous: { modelId: string } | undefined): void {
    const threadRef = ctx.chat.state.threadRef;
    const pick = threadPick();
    const picked = pick ? modelOptionFor(pick, scopeKey()) : undefined;
    if (!threadRef || !previous || !picked) return;
    if (picked.model.id !== previous.modelId) return;
    forgetThreadPick(threadRef);
    effortOverride = undefined;
    fastModeOverride = undefined;
    loadoutRestored = false;
  }

  function restoreLoadoutSelection(): void {
    loadout = loadLoadout(loadoutKey);
    let selected = currentModelOption();
    const threadRef = ctx.chat.state.threadRef;
    if (selected && threadRef && !hasThreadModelPick(threadRef)) {
      const preferred = modelLoadoutOptions(getModelOptions(scopeKey()), loadout).find(
        (option) => presetModelId(option.value) === presetModelId(selected!.value),
      );
      if (preferred && preferred.value !== selected.value) {
        rememberThreadPick(threadRef, preferred.value);
        selected = preferred;
      }
    }
    if (!selected) return;
    const saved = loadout.find((entry) => entry.value === selected.value);
    if (!saved) return;
    const normalized = normalizeLoadoutEntry(saved, selected);
    if (threadRef && hasThreadModelPick(threadRef)) {
      effortOverride ??= normalized.effort;
      fastModeOverride ??= normalized.fast;
    } else {
      restoredLoadout = normalized;
    }
  }

  function syncRuntimeSelection(agent?: Agent): void {
    const selected = currentModelOption();
    if (agent && selected) agent.state.model = selected.model;
    ctx.chat.drawActiveChat(agent);
    if (pendingComposerFocus) focusComposerEnd();
  }

  async function changeScopeRuntime(
    change: {
      modelId?: string;
      effortLevel?: string;
      fastMode?: boolean;
      inherit?: boolean;
      keep?: boolean;
    },
    agent: Agent,
    preserveSelection = false,
  ): Promise<void> {
    if (options.prepareSubmit) {
      if (change.modelId) selectModel(change.modelId, agent);
      return;
    }
    const request = ++runtimeRequest;
    const scopeId = scopeKey();
    if (!scopeId) return;
    composerState.error = "";
    const current = preserveSelection ? currentModelOption() : undefined;
    const settings = current ? activeLoadoutEntry(current) : undefined;
    const before = { ...revision };
    try {
      await saveRuntimeConfig(scopeId, change);
      if (request !== runtimeRequest || scopeId !== scopeKey()) return;
      if (revision.model === before.model) {
        if (current && settings) {
          if (revision.effort === before.effort) effortOverride = settings.effort;
          if (revision.fast === before.fast) fastModeOverride = settings.fast;
          if (ctx.chat.state.threadRef) rememberThreadPick(ctx.chat.state.threadRef, current.value);
          rememberActiveTweaks(current);
        } else if (!change.keep && revision.effort === before.effort && revision.fast === before.fast) {
          clearChatSelection();
        }
      }
      syncRuntimeSelection(agent);
      placeLoadout();
    } catch (e) {
      if (request !== runtimeRequest || scopeId !== scopeKey()) return;
      composerState.error = errMessage(e, "Could not update the scope default.");
      ctx.chat.drawActiveChat(agent);
    }
  }

  function composerForm(agent: Agent, header: TemplateResult | typeof nothing = nothing): TemplateResult {
    const activeRuntimeConfig = getRuntimeConfig(scopeKey());
    const selectedModel = currentModelOption();
    if (!selectedModel) {
      const selected = threadPick() ?? defaultModelValue(scopeKey());
      return html`<div class="composer-wrap">
        ${header} ${composerApprovalPanel(ctx.chat.activePendingApprovals())}
        <p role="status">
          ${composerState.error || activeRuntimeConfig?.unavailableReason || "Selected model is unavailable. Choose a replacement to continue."}
          ${selected}
        </p>
        <label
          >Replacement model
          ${fieldSelect({
            ariaLabel: "Replacement model",
            value: "",
            options: html`<option value="" selected>Select a model…</option>
              ${getModelOptions(scopeKey()).map((option) => html`<option value=${option.value}>${option.label}</option>`)}`,
            onChange: async (value) => {
              const option = modelOptionFor(value, scopeKey());
              if (!option) return;
              await changeScopeRuntime({ modelId: option.model.id }, agent);
              if (getRuntimeConfig(scopeKey())?.effective.modelId === option.model.id) selectModel(value, agent);
            },
          })}
        </label>
        <button type="button" @click=${() => void reloadRuntime(agent)}>Refresh models</button>
      </div>`;
    }
    const approvalPauses = ctx.chat.activePendingApprovals();
    const blockingPauses = approvalPauses.filter(approvalBlocksComposer);
    const runtimePending = activeRuntimeConfig === null;
    const inputBlocked = runtimePending || ctx.chat.state.resolvingApprovals.size > 0 || blockingPauses.length > 0;
    let placeholder =
      options.placeholder ??
      (appEditSlug(ctx.chat.state.threadRef, appState.me?.user) ? "Describe a change…" : "Ask anything");
    if (inputBlocked) placeholder = runtimePending ? "Loading runtime…" : "Approve or deny to continue";
    else if (agent.state.isStreaming) placeholder = "Queue a message for after this turn…";
    let composerNotice: TemplateResult | typeof nothing = nothing;
    if (composerState.processingFiles) {
      composerNotice = html`<div class="composer-note">Preparing files...</div>`;
    } else if (!approvalPauses.length && runtimePending) {
      composerNotice = composerState.error
        ? html`<div class="composer-error">
            ${composerState.error}
            <button type="button" @click=${() => void reloadRuntime(agent)}>Retry</button>
          </div>`
        : html`<div class="composer-note">Loading runtime settings…</div>`;
    } else if (composerState.error) {
      composerNotice = html`<div class="composer-error">${composerState.error}</div>`;
    }

    const compact = Boolean(ctx.pane) || isPhone();
    const turnRuntime = ctx.chat.turnRuntime();
    const routed =
      turnRuntime?.change && !switchedDefault(turnRuntime) && turnRuntime.modelId !== selectedModel.model.id
        ? turnRuntime
        : undefined;
    const runtimeControls = modelPicker.render(agent, selectedModel, inputBlocked, routed);
    return html`
      <form
        class="composer-wrap ${compact ? "compact" : ""}"
        @submit=${(e: Event) => submitComposer(e, agent)}
        @keydown=${(e: KeyboardEvent) => composerShortcut(e, agent, inputBlocked)}
      >
        ${header} ${slashMenu(agent)}
        ${
          !options.prepareSubmit && activeRuntimeConfig?.upgradeAvailable
            ? html`<div class="runtime-upgrade">
                <span
                  >The org now recommends
                  ${modelOptionFor(activeRuntimeConfig.orgDefault.modelId, scopeKey())?.buttonLabel ?? activeRuntimeConfig.orgDefault.modelId}.</span
                >
                <button
                  type="button"
                  @click=${() => changeScopeRuntime({ modelId: activeRuntimeConfig!.orgDefault.modelId }, agent)}
                >
                  Upgrade
                </button>
                <button type="button" @click=${() => changeScopeRuntime({ keep: true }, agent)}>Keep mine</button>
                <button type="button" @click=${() => changeScopeRuntime({ inherit: true }, agent)}>
                  Inherit future defaults
                </button>
              </div>`
            : nothing
        }
        ${
          composerState.attachments.length
            ? html`
                <div class="attachment-strip">
                  ${repeat(
                    composerState.attachments,
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
                          pastedTextIds.has(a.id)
                            ? html`
                                <button
                                  type="button"
                                  class="chip-open"
                                  aria-label="View pasted text"
                                  ${tip("View pasted text")}
                                  @click=${() => openPasteView(a.id, agent)}
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
                          @click=${() => removeAttachment(a.id, agent)}
                        >
                          ${icon(X, 13)}
                        </button>
                      </span>
                    `,
                  )}
                </div>
              `
            : nothing
        }
        ${approvalPauses.length ? composerApprovalPanel(approvalPauses) : nothing}
        ${
          blockingPauses.length
            ? nothing
            : composerInput({
                value: composerState.draft,
                placeholder,
                disabled: inputBlocked,
                onInput: (e) => onDraftInput(e, agent),
                onKeydown: (e) => onComposerKeydown(e, agent),
                onPaste: (e) => void onComposerPaste(e, agent),
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
              @change=${(e: Event) => void onFilesSelected(e, agent)}
            />
            <button
              class="icon-btn composer-attach"
              type="button"
              aria-label="Attach files"
              ${tip("Attach files")}
              ?disabled=${inputBlocked}
              @click=${() => pickFiles()}
            >
              ${icon(Paperclip, 18)}
            </button>
            ${runtimeControls}
          </div>
          <div class="composer-right">${sendControls(agent)}</div>
        </div>
        ${composerNotice}
      </form>
      ${pasteViewDialog(agent)}
    `;
  }

  function focusField(selector: string, cursor?: number): void {
    const input = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(selector);
    input?.focus();
    input?.setSelectionRange(cursor ?? input.value.length, cursor ?? input.value.length);
  }

  function sendControls(agent: Agent): TemplateResult {
    if (!agent.state.isStreaming || ctx.chat.isStopping()) {
      return html`<button
        class="send-btn"
        type="submit"
        aria-label="Send"
        ${tip("Send")}
        ?disabled=${!composerCanSend()}
      >
        ${icon(ArrowUp, 16)}
      </button>`;
    }
    const label = alwaysSteer() && canSteer(agent) ? "Steer the running task" : "Queue for after this turn";
    return html`
      <button class="stop-btn" type="button" aria-label="Stop" ${tip("Stop")} @click=${() => stopStreaming(agent)}>
        ${icon(Square, 16)}
      </button>
      <button class="send-btn" type="submit" ${tip(label)} aria-label=${label} ?disabled=${!composerCanSend()}>
        ${icon(ArrowUp, 16)}
      </button>
    `;
  }

  function canSteer(agent: Agent): boolean {
    return agent.state.isStreaming && !ctx.chat.isStopping() && ctx.chat.hasLiveRun();
  }

  function composerApprovalPanel(
    approvals: PendingApproval[],
    resolve: (decision: ApprovalDecision) => void = ctx.chat.resolveCommandApproval,
  ): TemplateResult {
    const decide = (decision: ApprovalDecision): void => {
      if (!ctx.chat.state.resolvingApprovals.has(decision.requestId)) resolve(decision);
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
            <div class="composer-approval-copy">${ctx.chat.approvalSummaryView(a, true)}</div>
            <div class="approval-actions">
              ${choices
                .filter((c) => !("scope" in c) || c.scope === "once" || a.grantModes?.[c.scope] !== false)
                .map(
                  ({ label, className, ...choice }) =>
                    html`<button
                      class=${className}
                      type="button"
                      ?disabled=${ctx.chat.state.resolvingApprovals.has(a.requestId)}
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

  let loadout = loadLoadout(loadoutKey);
  const modelPicker = createModelPicker<Agent>({
    host: () => ctx.chat.state.host,
    redraw: () => ctx.chat.drawActiveChat(),
    scopeKey,
    state: composerState,
    presets: {
      entries: seededLoadout,
      save: (entries) => {
        loadout = entries;
        saveLoadout(entries, loadoutKey);
      },
      add: addLoadoutEntry,
    },
    activeEntry: activeLoadoutEntry,
    apply: applyLoadout,
    selectEffort,
    toggleFastMode,
    effectiveFastMode,
    changeDefault: changeScopeRuntime,
    showDefaultAction: !options.prepareSubmit,
    showInheritAction: !options.prepareSubmit,
  });
  const placeLoadout = modelPicker.place;

  function activeLoadoutEntry(selected: ModelOption): LoadoutEntry {
    return {
      value: selected.value,
      effort: composerState.effortLevel,
      fast: modelSupportsFastMode(scopeKey(), selected.model.id) && effectiveFastMode(),
    };
  }

  function normalizeLoadoutEntry(entry: LoadoutEntry, option: ModelOption): LoadoutEntry {
    return {
      value: option.value,
      effort: supportedEffort(option.model, entry.effort, defaultEffortForModel(option.model)),
      fast: entry.fast && modelSupportsFastMode(scopeKey(), option.model.id),
    };
  }

  function seededLoadout(selected: ModelOption): LoadoutEntry[] {
    const latest = loadLoadout(loadoutKey);
    if (latest.length) loadout = latest;
    const active = activeLoadoutEntry(selected);
    if (!loadout.length) {
      loadout = [active];
      const other = getModelOptions(scopeKey()).find(
        (option) => option.model.id !== selected.model.id && option.model.provider !== selected.model.provider,
      );
      if (other) loadout.push({ value: other.value, effort: defaultEffortForModel(other.model), fast: false });
    }
    return reconcileLoadout(loadout, getModelOptions(scopeKey()), active).map((entry) =>
      normalizeLoadoutEntry(entry, modelOptionFor(entry.value, scopeKey())!),
    );
  }

  function rememberActiveTweaks(selected: ModelOption): void {
    loadout = upsertLoadout(seededLoadout(selected), activeLoadoutEntry(selected));
    saveLoadout(loadout, loadoutKey);
  }

  function applyLoadout(entry: LoadoutEntry, agent: Agent): void {
    const option = modelOptionFor(entry.value, scopeKey());
    if (!option) return;
    const previous = currentModelOption();
    if (previous) rememberActiveTweaks(previous);
    const wasOpen = composerState.openMenu === "loadout";
    selectModel(entry.value, agent);
    const normalized = normalizeLoadoutEntry(entry, option);
    composerState.effortLevel = normalized.effort;
    composerState.fastMode = normalized.fast;
    loadout = upsertLoadout(loadout, activeLoadoutEntry(option));
    saveLoadout(loadout, loadoutKey);
    modelPicker.resetSection();
    composerState.openMenu = wasOpen ? "loadout" : null;
    ctx.chat.drawActiveChat(agent);
    placeLoadout();
  }

  function composerShortcut(e: KeyboardEvent, agent: Agent, disabled: boolean): void {
    if (disabled || e.defaultPrevented || !e.metaKey) return;
    if (e.shiftKey && e.code === "KeyE") {
      e.preventDefault();
      toggleFastMode(agent);
    }
  }

  function addLoadoutEntry(option: ModelOption, agent: Agent): void {
    const current = currentModelOption();
    if (!current || seededLoadout(current).length >= LOADOUT_CAP) return;
    applyLoadout({ value: option.value, effort: defaultEffortForModel(option.model), fast: false }, agent);
    composerState.menuQuery = "";
  }

  function matchSkills(query: string, skills: SkillItem[]): SkillMatch[] {
    const q = query.toLowerCase();
    if (!q) return skills.map((skill) => ({ skill, start: -1, end: -1 }));
    const out: SkillMatch[] = [];
    for (const skill of skills) {
      const at = skill.name.toLowerCase().indexOf(q);
      if (at >= 0) out.push({ skill, start: at, end: at + q.length });
    }
    return out.sort((a, b) => a.start - b.start || a.skill.name.localeCompare(b.skill.name));
  }

  function currentSlashMenu(): { open: boolean; loading: boolean; matches: SkillMatch[] } {
    const query = slashQuery(composerState.draft);
    if (query === null || composerState.slashDismissed) return { open: false, loading: false, matches: [] };
    const loading = skillsLoading;
    const matches = skillsCache ? matchSkills(query, skillsCache) : [];
    return { open: loading || matches.length > 0, loading, matches };
  }

  function clampedActive(matchCount: number): number {
    return Math.max(0, Math.min(slashActiveIndex, matchCount - 1));
  }

  async function loadSkills(agent: Agent): Promise<void> {
    if (skillsLoading || skillsCache !== null) return;
    skillsLoading = true;
    ctx.chat.drawActiveChat(agent);
    try {
      const r = await api<{ skills: SkillItem[] }>("/api/skills");
      skillsCache = r.skills ?? [];
    } catch (error) {
      reportHandledError("web:skills_load", error);
      skillsLoadFailed = true;
    } finally {
      skillsLoading = false;
      if (agent === ctx.chat.state.agent) ctx.chat.drawActiveChat(agent);
    }
  }

  function acceptSkill(skill: SkillItem, agent: Agent): void {
    composerState.draft = composerState.draft.replace(SLASH_TOKEN, (_m, pre: string) => `${pre}/${skill.name} `);
    persistDraft();
    slashActiveIndex = 0;
    composerState.slashDismissed = false;
    ctx.chat.drawActiveChat(agent);
    focusComposerEnd();
  }

  function fillSuggestedPrompt(prompt: string, agent: Agent): boolean {
    if (
      agent !== ctx.chat.state.agent ||
      agent.state.isStreaming ||
      composerState.draft ||
      composerState.attachments.length ||
      composerState.processingFiles
    )
      return false;
    composerState.draft = prompt;
    composerState.error = "";
    persistDraft();
    ctx.chat.drawActiveChat(agent);
    focusComposerEnd();
    return true;
  }

  let pendingComposerFocus = false;

  function focusComposerEnd(): void {
    requestAnimationFrame(() => {
      const ta = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".composer-input");
      if (!ta) return;
      if (ta.disabled) {
        pendingComposerFocus = true;
        return;
      }
      pendingComposerFocus = false;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }

  function slashMenu(agent: Agent): TemplateResult | typeof nothing {
    const slash = currentSlashMenu();
    if (!slash.open) return nothing;
    if (slash.loading && slash.matches.length === 0) {
      return html`<div class="slash-popover">
        <div class="menu-title">Skills</div>
        <div class="slash-empty">Loading skills…</div>
      </div>`;
    }
    const active = clampedActive(slash.matches.length);
    return html`
      <div class="slash-popover" role="listbox" aria-label="Skills">
        <div class="menu-title">Skills</div>
        ${slash.matches.map((m, i) => slashRow(m, i === active, agent))}
      </div>
    `;
  }

  function slashRow(m: SkillMatch, active: boolean, agent: Agent): TemplateResult {
    return html`
      <button
        type="button"
        role="option"
        aria-selected=${active ? "true" : "false"}
        class="slash-option ${active ? "active" : ""}"
        ${tip(m.skill.description)}
        @mousedown=${(e: Event) => e.preventDefault()}
        @click=${() => acceptSkill(m.skill, agent)}
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

  function submitComposer(e: Event, agent: Agent): void {
    e.preventDefault();
    void sendPrompt(agent);
  }

  function onDraftInput(e: InputEvent, agent: Agent): void {
    const wasEmpty = !composerState.draft;
    composerState.draft = (e.currentTarget as HTMLTextAreaElement).value;
    persistDraft();
    const hadError = Boolean(composerState.error);
    composerState.error = "";
    composerState.slashDismissed = false;
    slashActiveIndex = 0;
    const armed = slashQuery(composerState.draft) !== null;
    if (!armed) skillsLoadFailed = false;
    else if (skillsCache === null && !skillsLoading && !skillsLoadFailed) void loadSkills(agent);
    const popoverShown = Boolean(ctx.chat.state.host?.querySelector(".slash-popover"));
    if (
      armed ||
      popoverShown ||
      hadError ||
      (Boolean(appState.me?.suggestedActivities?.length) && wasEmpty !== !composerState.draft)
    ) {
      ctx.chat.drawActiveChat(agent);
      return;
    }
    syncComposerControls(agent);
    resizeComposer();
  }

  function approvalPending(): boolean {
    return ctx.chat.hasUnresolvedApproval() || ctx.chat.state.resolvingApprovals.size > 0;
  }

  function composerCanSend(): boolean {
    if (!currentModelOption()) return false;
    return (
      Boolean(composerState.draft.trim() || composerState.attachments.length) &&
      !composerState.processingFiles &&
      !submitting &&
      getRuntimeConfig(scopeKey()) !== null &&
      !approvalPending()
    );
  }

  function syncComposerControls(agent: Agent): void {
    if (!ctx.chat.state.host || agent !== ctx.chat.state.agent) return;
    const send = ctx.chat.state.host.querySelector<HTMLButtonElement>(".send-btn");
    if (send) send.disabled = !composerCanSend();
  }

  function clearComposerDom(agent: Agent): void {
    if (!ctx.chat.state.host || agent !== ctx.chat.state.agent) return;
    const input = ctx.chat.state.host.querySelector<HTMLTextAreaElement>(".composer-input");
    if (input) {
      input.value = "";
      input.style.height = "auto";
      input.style.overflowY = "hidden";
      input.scrollTop = 0;
    }
    const send = ctx.chat.state.host.querySelector<HTMLButtonElement>(".send-btn");
    if (send) send.disabled = true;
  }

  function onComposerKeydown(e: KeyboardEvent, agent: Agent): void {
    if (e.isComposing || e.keyCode === 229) return;
    const slash = currentSlashMenu();
    if (slash.open) {
      if (e.key === "Escape") {
        e.preventDefault();
        composerState.slashDismissed = true;
        return ctx.chat.drawActiveChat(agent);
      }
      if (slash.matches.length) {
        const count = slash.matches.length;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          slashActiveIndex = (clampedActive(count) + (e.key === "ArrowDown" ? 1 : count - 1)) % count;
          return ctx.chat.drawActiveChat(agent);
        }
        if (!e.shiftKey && (e.key === "Enter" || e.key === "Tab")) {
          e.preventDefault();
          return acceptSkill(slash.matches[clampedActive(count)]!.skill, agent);
        }
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        return;
      }
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    void sendPrompt(agent);
  }

  function stopStreaming(agent: Agent): void {
    composerState.error = "";
    void ctx.chat.stopLiveRun().catch(() => {
      if (agent !== ctx.chat.state.agent) return;
      composerState.error = "Could not request stop. Try again.";
      ctx.chat.drawActiveChat(agent);
    });
    focusComposerEnd();
  }

  let pendingSubmissions = 0;
  let disposed = false;
  const preventUnsafeUpdate = (event: Event): void => {
    if (
      pendingSubmissions ||
      composerState.attachments.length ||
      composerState.processingFiles ||
      composerState.pasteView
    ) {
      event.preventDefault();
    }
  };
  window.addEventListener("qm:prepare-update", preventUnsafeUpdate);

  async function sendPrompt(agent: Agent): Promise<void> {
    pendingSubmissions++;
    try {
      await sendPromptNow(agent);
    } finally {
      pendingSubmissions--;
      if (disposed && !pendingSubmissions) window.removeEventListener("qm:prepare-update", preventUnsafeUpdate);
    }
  }

  async function sendPromptNow(agent: Agent): Promise<void> {
    if (!composerCanSend()) return;
    if (composerState.pasteView) closePasteView(agent);
    if (agent.state.isStreaming) return queueDraft(agent);
    const text = composerState.draft.trim();
    if (!text && composerState.attachments.length === 0) return;
    const submit = options.prepareSubmit?.();
    if (submit) {
      const selected = currentModelOption()!;
      const attachments = [...composerState.attachments];
      const selection: ComposerSubmission = {
        model: selected.model.id,
        thinkingLevel: composerState.effortLevel,
        fastMode: modelSupportsFastMode(scopeKey(), selected.model.id) && effectiveFastMode(),
      };
      submitting = true;
      clearActiveDraft();
      resetComposer();
      ctx.chat.drawActiveChat(agent);
      try {
        const { uploaded, skipped } = await uploadAttachments(attachments);
        if (skipped.length) throw new Error(skipped.map((file) => file.note).join(" "));
        await submit(text, { ...selection, ...(uploaded.length ? { attachments: uploaded } : {}) });
      } catch (error) {
        restoreStagedOnFailure(text, attachments, errMessage(error, "Could not send message."));
        persistDraft();
      } finally {
        submitting = false;
        ctx.chat.drawActiveChat(agent);
      }
      return;
    }
    if (ctx.chat.state.threadRef) {
      bumpSessionActivity(ctx.chat.state.threadRef);
      ctx.chat.state.pendingSend = ctx.chat.state.threadRef;
      renderList();
    }
    const attachments = composerState.attachments;
    const sentFromThread = ctx.chat.state.threadRef;
    ctx.chat.notePendingSessionOnSend();
    clearActiveDraft();
    resetComposer();
    ctx.chat.drawActiveChat(agent);
    clearComposerDom(agent);
    try {
      if (ctx.chat.state.normalStreamFn) agent.streamFn = ctx.chat.state.normalStreamFn;
      ctx.chat.scrollToBottom();
      await agent.prompt(userSendMessage(text, attachments.length ? attachments : undefined));
      restoreFailedSend(agent, sentFromThread, text, attachments);
    } catch (err) {
      abandonPendingSend();
      composerState.error = errMessage(err, "Could not send message.");
      ctx.chat.drawActiveChat(agent);
    }
  }

  function abandonPendingSend(): void {
    ctx.chat.state.pendingSend = null;
    if (ctx.chat.state.threadRef && ctx.chat.state.sessionId === null) dropPendingSession(ctx.chat.state.threadRef);
    renderList();
  }

  function unwindSend(agent: Agent, text: string, attachments: Attachment[], note: string): void {
    const messages = agent.state.messages;
    messages.pop();
    const prompt = messages[messages.length - 1] as { role?: string } | undefined;
    if (prompt?.role === "user" || prompt?.role === "user-with-attachments") messages.pop();
    (agent.state as { errorMessage?: string }).errorMessage = undefined;
    abandonPendingSend();
    restoreStagedOnFailure(text, attachments, note);
    persistDraft();
    ctx.chat.drawActiveChat(agent);
  }

  function restoreFailedSend(
    agent: Agent,
    sentFromThread: string | null,
    text: string,
    attachments: Attachment[],
  ): void {
    const messages = agent.state.messages;
    const last = messages[messages.length - 1] as
      | {
          role?: string;
          sendBlocked?: string;
          sendFailed?: string;
          errorMessage?: string;
          droppedAttachmentIds?: string[];
        }
      | undefined;
    if (last?.role !== "assistant") return;
    if (last.sendBlocked === "pending_approval") {
      if (agent === ctx.chat.state.agent)
        return unwindSend(agent, text, attachments, last.errorMessage || PENDING_APPROVAL_REASON);
      if (sentFromThread) saveDraft(sentFromThread, text);
      return;
    }
    if (last.sendFailed !== "attachments" || agent !== ctx.chat.state.agent) return;
    const dropped = new Set(last.droppedAttachmentIds ?? []);
    const retryable = attachments.filter((a) => !dropped.has(a.id));
    unwindSend(
      agent,
      text,
      retryable,
      retryable.length
        ? "Couldn't attach the files, so the message wasn't sent. Try again."
        : "Nothing could be attached, so the message wasn't sent.",
    );
  }

  const {
    onComposerPaste,
    onDragEnter,
    onDragOver,
    onDrop,
    onFilesSelected,
    pickFiles,
    removeAttachment,
    restageAttachments,
  } = createComposerAttachments({ ctx, composerState, fileDrag, pastedTextIds, approvalPending });

  const { queueDraft, queuedRunsFor, queuedStrip, restoreStagedOnFailure, setQueuedRuns, steeringRunsFor } =
    createComposerQueue({
      ctx,
      composerState,
      canSteer,
      clearActiveDraft,
      clearComposerDom,
      focusComposerEnd,
      focusField,
      restageAttachments,
    });
  const { closePasteView, openPasteView, pasteViewDialog } = createPasteView({
    ctx,
    composerState,
    focusField,
    persistDraft,
    removeAttachment,
    resizeComposer,
  });

  function clearChatSelection(): void {
    if (ctx.chat.state.threadRef) forgetThreadPick(ctx.chat.state.threadRef);
    effortOverride = undefined;
    fastModeOverride = undefined;
    restoredLoadout = undefined;
  }

  async function followScopeDefault(agent: Agent): Promise<void> {
    clearChatSelection();
    await reloadRuntime(agent);
  }

  function selectModel(value: string, agent: Agent): void {
    const option = getModelOptions(scopeKey()).find((candidate) => candidate.value === value);
    if (!option) return;
    ++revision.model;
    const previousDefaultEffort = defaultEffortForModel(currentModelOption()?.model);
    if (ctx.chat.state.threadRef) rememberThreadPick(ctx.chat.state.threadRef, option.value);
    agent.state.model = option.model;
    if (composerState.effortLevel === previousDefaultEffort) {
      composerState.effortLevel = defaultEffortForModel(option.model);
    }
    composerState.openMenu = null;
    ctx.chat.drawActiveChat(agent);
  }

  function selectEffort(level: EffortLevel, agent: Agent): void {
    const selected = currentModelOption();
    if (!selected || !effortLevelsForModel(selected.model).some((option) => option.value === level)) return;
    composerState.effortLevel = level;
    rememberActiveTweaks(selected);
    ctx.chat.drawActiveChat(agent);
    placeLoadout();
  }

  function toggleFastMode(agent: Agent): void {
    const selected = currentModelOption();
    if (approvalPending()) return;
    if (selected && isUltrafastModel(selected.model.id)) {
      const target = ultrafastChoice(getModelOptions(scopeKey()), selected);
      if (target) applyLoadout({ ...activeLoadoutEntry(selected), value: target.value, fast: true }, agent);
      return;
    }
    if (!selected || !modelSupportsFastMode(scopeKey(), selected.model.id)) return;
    composerState.fastMode = !effectiveFastMode();
    rememberActiveTweaks(selected);
    ctx.chat.drawActiveChat(agent);
    placeLoadout();
  }

  let autosizedTa: HTMLTextAreaElement | null = null;
  let autosizedValue: string | null = null;
  let autosizeObserver: ResizeObserver | null = null;

  function resizeComposer(): void {
    requestAnimationFrame(() => {
      const ta = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".composer-input");
      if (!ta) return;
      if (autosizedTa !== ta && typeof ResizeObserver !== "undefined") {
        autosizeObserver ??= new ResizeObserver(() => {
          autosizedValue = null;
          resizeComposer();
        });
        if (autosizedTa) autosizeObserver.unobserve(autosizedTa);
        autosizeObserver.observe(ta);
        autosizedTa = ta;
        autosizedValue = null;
      }
      if (ta.value === autosizedValue) return;
      autosizedValue = ta.value;
      resizeComposerInput(ta, ctx.pane ? 0 : 48);
    });
  }

  function closeMenus(): boolean {
    let changed = false;
    if (composerState.openMenu) {
      modelPicker.resetSection();
      composerState.openMenu = null;
      changed = true;
    }
    if (!composerState.slashDismissed && slashQuery(composerState.draft) !== null) {
      composerState.slashDismissed = true;
      changed = true;
    }
    return changed;
  }

  function dispose(): void {
    disposed = true;
    if (!pendingSubmissions) window.removeEventListener("qm:prepare-update", preventUnsafeUpdate);
    window.removeEventListener("model-account-changed", refreshAccount);
    document.removeEventListener("visibilitychange", revalidateRuntime);
    window.removeEventListener("online", revalidateRuntime);
    modelPicker.dispose();
    unsubscribeRuntime?.();
    ++runtimeRequest;
    fileDrag.dispose();
    autosizeObserver?.disconnect();
    autosizeObserver = null;
    autosizedTa = null;
  }

  return {
    state: composerState,
    submit: async (instruction = "") => {
      if (submitting || !getRuntimeConfig(scopeKey())) return;
      const agent = ctx.chat.state.agent;
      if (!agent) return;
      if (instruction) composerState.draft = [composerState.draft.trim(), instruction].filter(Boolean).join("\n\n");
      await sendPrompt(agent);
    },
    restageAttachments,
    composerForm,
    composerApprovalPanel,
    queuedStrip,
    waitingSteers: (agent: Agent) => steeringRunsFor(ctx.chat.state.threadRef, agent),
    queuedRunsFor,
    setQueuedRuns,
    resetComposer,
    focusComposerEnd,
    fillSuggestedPrompt,
    addAnnotations: async (
      text: string,
      files: File[],
      annotationId = crypto.randomUUID(),
      remove = false,
    ): Promise<boolean> => {
      const agent = ctx.chat.state.agent;
      if (!agent || composerState.processingFiles || approvalPending()) return false;
      const prefix = `annotation_${annotationId}_`;
      const retained = composerState.attachments.filter((attachment) => !attachment.id.startsWith(prefix));
      if (remove) {
        composerState.attachments = retained;
        ctx.chat.drawActiveChat(agent);
        return true;
      }
      if (retained.length + 1 + files.length > MAX_FILES_PER_MESSAGE) return false;
      composerState.processingFiles = true;
      ctx.chat.drawActiveChat(agent);
      try {
        const loaded = await Promise.all(files.map((file) => loadAnyAttachment(file)));
        if (agent !== ctx.chat.state.agent) return false;
        const remaining = composerState.attachments.filter((attachment) => !attachment.id.startsWith(prefix));
        if (remaining.length + 1 + loaded.length > MAX_FILES_PER_MESSAGE) return false;
        composerState.attachments = [
          ...remaining,
          textAttachment(prefix + "context", "App annotation.md", "text/markdown", text),
          ...loaded.map((attachment, index) => ({ ...attachment, id: prefix + index })),
        ];
        composerState.error = "";
        return true;
      } catch {
        composerState.error = "Could not prepare annotation attachments. Retrying automatically.";
        return false;
      } finally {
        composerState.processingFiles = false;
        ctx.chat.drawActiveChat(agent);
      }
    },
    sendSuggestedPrompt: async (prompt: string, agent: Agent): Promise<void> => {
      if (fillSuggestedPrompt(prompt, agent)) await sendPrompt(agent);
    },
    resizeComposer,
    currentModelOption,
    followsDefault,
    followScopeDefault,
    carryModelPick,
    refreshRuntimeSelection,
    onDragEnter,
    onDragOver,
    onDragLeave: fileDrag.leave,
    onDrop,
    closeMenus,
    dispose,
  };
}
