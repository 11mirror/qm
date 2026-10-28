import { createPasteView } from "./paste-view";
import { ComposerQueue } from "./composer-queue";
import { createComposerAttachments, loadAnyAttachment, textAttachment } from "./composer-attachments";
import { resizeComposerInput } from "./composer-input";
import { reportHandledError } from "./browser-errors.ts";
import { getRuntimeConfig } from "./runtime-config-cache.ts";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createFileDragState } from "./file-open";
import type { Attachment } from "@earendil-works/pi-web-ui";
import { nothing, type TemplateResult } from "lit";
import { api, userSendMessage, type ApprovalDecision, type PendingApproval, type QueuedRun } from "./core-bridge";
import { PENDING_APPROVAL_REASON } from "./run-stream";
import { MAX_FILES_PER_MESSAGE, uploadAttachments, type CoreAttachment } from "./attachments";
import { errMessage } from "../../chassis/src/errors";
import { type EffortLevel, defaultModelValue, type ModelOption, type ModelOptionValue } from "./model-options";
import { modelSupportsFastMode } from "./pi-models";
import type { ComposerSurface, ConvCtx } from "./conv-types";
import { bumpSessionActivity, dropPendingSession, renderList } from "./sessions";
import { appState } from "./shell";
import { clearDraft, newChatDraftKey, saveDraft } from "./drafts";
import { loadLoadout, type LoadoutEntry } from "./composer-loadout";
import { carryModelPick, threadModelPick, forgetThreadPick, hasThreadModelPick } from "./thread-model-picks";
import { composerStateFor, refreshRuntimeSelection, modelOptionFor, composerPicker } from "./composer-runtime";
import { composerForm, composerApprovalPanel } from "./composer-form";
import { runtimeConfigKey } from "./runtime-config-store";

export type ComposerMenu = "effort" | "model" | "settings" | "loadout";

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
export interface SkillMatch {
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
  includeSideChatExcerpt?: () => boolean;
  prepareSubmit?: () => (text: string, options: ComposerSubmission) => Promise<void>;
  placeholder?: string;
  preferenceKey?: string;
  runtimeAccount?: "company";
}

export type ComposerState = ComposerSurface["state"] & { menuQuery: string };

export class Composer implements ComposerSurface {
  readonly ctx: ConvCtx;
  readonly options: ComposerOptions;
  readonly loadoutKey: string | undefined;
  readonly state: ComposerState = composerStateFor(this);
  readonly pastedTextIds = new Set<string>();
  readonly fileDrag = createFileDragState((dragging) => {
    this.state.dragging = dragging;
    this.ctx.chat.drawActiveChat();
  });
  readonly revision = { model: 0, effort: 0, fast: 0 };
  readonly modelPicker: ReturnType<typeof composerPicker>;
  readonly attachments: ReturnType<typeof createComposerAttachments>;
  readonly queue: ComposerQueue;
  readonly paste: ReturnType<typeof createPasteView>;
  loadout: LoadoutEntry[];
  submitting = false;
  runtimeRequest = 0;
  runtimeIdentity = "";
  unsubscribeRuntime: (() => void) | undefined;
  effortOverride: EffortLevel | undefined;
  fastModeOverride: boolean | undefined;
  restoredLoadout: LoadoutEntry | undefined;
  loadoutRestored = false;
  skillsLoading = false;
  skillsLoadFailed = false;
  slashActiveIndex = 0;
  pendingComposerFocus = false;
  pendingSubmissions = 0;
  disposed = false;
  autosizedTa: HTMLTextAreaElement | null = null;
  autosizedValue: string | null = null;
  autosizeObserver: ResizeObserver | null = null;

  constructor(ctx: ConvCtx, options: ComposerOptions) {
    this.ctx = ctx;
    this.options = options;
    this.loadoutKey = options.preferenceKey ? `web-ui:loadout:${options.preferenceKey}` : undefined;
    this.loadout = loadLoadout(this.loadoutKey);
    window.addEventListener("model-account-changed", this.refreshAccount);
    document.addEventListener("visibilitychange", this.revalidateRuntime);
    window.addEventListener("online", this.revalidateRuntime);
    this.modelPicker = composerPicker(this);
    window.addEventListener("qm:prepare-update", this.preventUnsafeUpdate);
    this.attachments = createComposerAttachments(this);
    this.queue = new ComposerQueue(this);
    this.paste = createPasteView({
      ctx,
      composerState: this.state,
      focusField: (selector, cursor) => this.focusField(selector, cursor),
      persistDraft: () => this.persistDraft(),
      removeAttachment: this.attachments.removeAttachment,
      resizeComposer: () => this.resizeComposer(),
    });
  }

  refreshAccount = (): void => {
    this.loadoutRestored = false;
    void this.reloadRuntime();
  };

  revalidateRuntime = (): void => {
    if (document.visibilityState === "visible") void this.reloadRuntime();
  };

  preventUnsafeUpdate = (event: Event): void => {
    const { pendingSubmissions, state } = this;
    if (pendingSubmissions || state.attachments.length || state.processingFiles || state.pasteView) {
      event.preventDefault();
    }
  };

  restageAttachments = (attachments: Attachment[], note: string) =>
    this.attachments.restageAttachments(attachments, note);
  composerForm = (agent: Agent, header?: TemplateResult | typeof nothing) => composerForm(this, agent, header);
  composerApprovalPanel = (approvals: PendingApproval[], resolve?: (decision: ApprovalDecision) => void) =>
    composerApprovalPanel(this, approvals, resolve);
  queuedStrip = (agent: Agent) => this.queue.queuedStrip(agent);
  waitingSteers = (agent: Agent) => this.queue.steeringRunsFor(this.ctx.chat.state.threadRef, agent);
  queuedRunsFor = (threadRef: string | null) => this.queue.queuedRunsFor(threadRef);
  setQueuedRuns = (threadRef: string, runs: QueuedRun[]) => this.queue.setQueuedRuns(threadRef, runs);
  carryModelPick = carryModelPick;
  refreshRuntimeSelection = (scopeId: string | null, agent?: Agent, refresh?: boolean) =>
    refreshRuntimeSelection(this, scopeId, agent, refresh);
  onDragEnter = (e: DragEvent) => this.attachments.onDragEnter(e);
  onDragOver = (e: DragEvent) => this.attachments.onDragOver(e);
  onDragLeave = (e: DragEvent) => this.fileDrag.leave(e);
  onDrop = (e: DragEvent, agent: Agent) => this.attachments.onDrop(e, agent);

  reloadRuntime(agent = this.ctx.chat.state.agent ?? undefined) {
    return refreshRuntimeSelection(this, this.ctx.chat.state.scopeId, agent, true);
  }

  scopeKey(): string | null {
    return runtimeConfigKey(runtimeScopeKey(this.ctx.chat.state.scopeId), this.options.runtimeAccount);
  }

  threadPick(): ModelOptionValue | undefined {
    return this.ctx.chat.state.threadRef ? threadModelPick(this.ctx.chat.state.threadRef) : undefined;
  }

  currentModelOption(): ModelOption | undefined {
    return modelOptionFor(this.threadPick() ?? defaultModelValue(this.scopeKey()), this.scopeKey());
  }

  followsDefault(): boolean {
    const selected = this.currentModelOption();
    const threadRef = this.ctx.chat.state.threadRef;
    return (
      !!selected &&
      !(threadRef && hasThreadModelPick(threadRef)) &&
      this.effortOverride === undefined &&
      this.fastModeOverride === undefined &&
      this.restoredLoadout?.value !== selected.value
    );
  }

  clearChatSelection(): void {
    if (this.ctx.chat.state.threadRef) forgetThreadPick(this.ctx.chat.state.threadRef);
    this.effortOverride = undefined;
    this.fastModeOverride = undefined;
    this.restoredLoadout = undefined;
  }

  async followScopeDefault(agent: Agent): Promise<void> {
    this.clearChatSelection();
    await this.reloadRuntime(agent);
  }

  async submit(instruction = ""): Promise<void> {
    if (this.submitting || !getRuntimeConfig(this.scopeKey())) return;
    const agent = this.ctx.chat.state.agent;
    if (!agent) return;
    if (instruction) this.state.draft = [this.state.draft.trim(), instruction].filter(Boolean).join("\n\n");
    await this.sendPrompt(agent);
  }

  async sendSuggestedPrompt(prompt: string, agent: Agent): Promise<void> {
    if (this.fillSuggestedPrompt(prompt, agent)) await this.sendPrompt(agent);
  }

  isUnsentNewChat(): boolean {
    return (
      !this.options.prepareSubmit &&
      this.ctx.chat.state.sessionId === null &&
      !(this.ctx.chat.state.agent?.state.messages ?? []).some((m) => !(m as { opener?: boolean }).opener)
    );
  }

  persistDraft(): void {
    if (!this.ctx.chat.state.threadRef) return;
    saveDraft(this.ctx.chat.state.threadRef, this.state.draft);
    if (this.isUnsentNewChat()) saveDraft(newChatDraftKey(appState.me?.user), this.state.draft);
  }

  clearActiveDraft(): void {
    if (this.ctx.chat.state.threadRef) clearDraft(this.ctx.chat.state.threadRef);
    if (!this.options.prepareSubmit && this.ctx.chat.state.sessionId === null)
      clearDraft(newChatDraftKey(appState.me?.user));
  }

  resetComposer(): void {
    Object.assign(this.state, {
      draft: "",
      attachments: [],
      pasteView: null,
      error: "",
      processingFiles: false,
      openMenu: null,
      slashDismissed: false,
    });
    this.pastedTextIds.clear();
    this.slashActiveIndex = 0;
  }

  focusField(selector: string, cursor?: number): void {
    const input = this.ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(selector);
    input?.focus();
    input?.setSelectionRange(cursor ?? input.value.length, cursor ?? input.value.length);
  }

  canSteer(agent: Agent): boolean {
    return agent.state.isStreaming && !this.ctx.chat.isStopping() && this.ctx.chat.hasLiveRun();
  }

  currentSlashMenu(): { open: boolean; loading: boolean; matches: SkillMatch[] } {
    const query = slashQuery(this.state.draft);
    if (query === null || this.state.slashDismissed) return { open: false, loading: false, matches: [] };
    const loading = this.skillsLoading;
    const matches = skillsCache ? matchSkills(query, skillsCache) : [];
    return { open: loading || matches.length > 0, loading, matches };
  }

  clampedActive(matchCount: number): number {
    return Math.max(0, Math.min(this.slashActiveIndex, matchCount - 1));
  }

  async loadSkills(agent: Agent): Promise<void> {
    if (this.skillsLoading || skillsCache !== null) return;
    this.skillsLoading = true;
    this.ctx.chat.drawActiveChat(agent);
    try {
      const r = await api<{ skills: SkillItem[] }>("/api/skills");
      skillsCache = r.skills ?? [];
    } catch (error) {
      reportHandledError("web:skills_load", error);
      this.skillsLoadFailed = true;
    } finally {
      this.skillsLoading = false;
      if (agent === this.ctx.chat.state.agent) this.ctx.chat.drawActiveChat(agent);
    }
  }

  acceptSkill(skill: SkillItem, agent: Agent): void {
    this.state.draft = this.state.draft.replace(SLASH_TOKEN, (_m, pre: string) => `${pre}/${skill.name} `);
    this.persistDraft();
    this.slashActiveIndex = 0;
    this.state.slashDismissed = false;
    this.ctx.chat.drawActiveChat(agent);
    this.focusComposerEnd();
  }

  fillSuggestedPrompt(prompt: string, agent: Agent): boolean {
    if (
      agent !== this.ctx.chat.state.agent ||
      agent.state.isStreaming ||
      this.state.draft ||
      this.state.attachments.length ||
      this.state.processingFiles
    )
      return false;
    this.state.draft = prompt;
    this.state.error = "";
    this.persistDraft();
    this.ctx.chat.drawActiveChat(agent);
    this.focusComposerEnd();
    return true;
  }

  focusComposerEnd(): void {
    requestAnimationFrame(() => {
      const ta = this.ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".composer-input");
      if (!ta) return;
      if (ta.disabled) {
        this.pendingComposerFocus = true;
        return;
      }
      this.pendingComposerFocus = false;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }

  onDraftInput(e: InputEvent, agent: Agent): void {
    const wasEmpty = !this.state.draft;
    this.state.draft = (e.currentTarget as HTMLTextAreaElement).value;
    this.persistDraft();
    const hadError = Boolean(this.state.error);
    this.state.error = "";
    this.state.slashDismissed = false;
    this.slashActiveIndex = 0;
    const armed = slashQuery(this.state.draft) !== null;
    if (!armed) this.skillsLoadFailed = false;
    else if (skillsCache === null && !this.skillsLoading && !this.skillsLoadFailed) void this.loadSkills(agent);
    const popoverShown = Boolean(this.ctx.chat.state.host?.querySelector(".slash-popover"));
    if (
      armed ||
      popoverShown ||
      hadError ||
      (Boolean(appState.me?.suggestedActivities?.length) && wasEmpty !== !this.state.draft)
    ) {
      this.ctx.chat.drawActiveChat(agent);
      return;
    }
    this.syncComposerControls(agent);
    this.resizeComposer();
  }

  approvalPending(): boolean {
    return this.ctx.chat.hasUnresolvedApproval() || this.ctx.chat.state.resolvingApprovals.size > 0;
  }

  composerCanSend(): boolean {
    if (!this.currentModelOption()) return false;
    return (
      Boolean(this.state.draft.trim() || this.state.attachments.length) &&
      !this.state.processingFiles &&
      !this.submitting &&
      getRuntimeConfig(this.scopeKey()) !== null &&
      !this.approvalPending()
    );
  }

  syncComposerControls(agent: Agent): void {
    if (!this.ctx.chat.state.host || agent !== this.ctx.chat.state.agent) return;
    const send = this.ctx.chat.state.host.querySelector<HTMLButtonElement>(".send-btn");
    if (send) send.disabled = !this.composerCanSend();
  }

  clearComposerDom(agent: Agent): void {
    if (!this.ctx.chat.state.host || agent !== this.ctx.chat.state.agent) return;
    const input = this.ctx.chat.state.host.querySelector<HTMLTextAreaElement>(".composer-input");
    if (input) {
      input.value = "";
      input.style.height = "auto";
      input.style.overflowY = "hidden";
      input.scrollTop = 0;
    }
    const send = this.ctx.chat.state.host.querySelector<HTMLButtonElement>(".send-btn");
    if (send) send.disabled = true;
  }

  onComposerKeydown(e: KeyboardEvent, agent: Agent): void {
    if (e.isComposing || e.keyCode === 229) return;
    const slash = this.currentSlashMenu();
    if (slash.open) {
      if (e.key === "Escape") {
        e.preventDefault();
        this.state.slashDismissed = true;
        return this.ctx.chat.drawActiveChat(agent);
      }
      if (slash.matches.length) {
        const count = slash.matches.length;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          this.slashActiveIndex = (this.clampedActive(count) + (e.key === "ArrowDown" ? 1 : count - 1)) % count;
          return this.ctx.chat.drawActiveChat(agent);
        }
        if (!e.shiftKey && (e.key === "Enter" || e.key === "Tab")) {
          e.preventDefault();
          return this.acceptSkill(slash.matches[this.clampedActive(count)]!.skill, agent);
        }
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        return;
      }
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    void this.sendPrompt(agent);
  }

  stopStreaming(agent: Agent): void {
    this.state.error = "";
    void this.ctx.chat.stopLiveRun().catch(() => {
      if (agent !== this.ctx.chat.state.agent) return;
      this.state.error = "Could not request stop. Try again.";
      this.ctx.chat.drawActiveChat(agent);
    });
    this.focusComposerEnd();
  }

  async sendPrompt(agent: Agent): Promise<void> {
    this.pendingSubmissions++;
    try {
      await this.sendPromptNow(agent);
    } finally {
      this.pendingSubmissions--;
      if (this.disposed && !this.pendingSubmissions)
        window.removeEventListener("qm:prepare-update", this.preventUnsafeUpdate);
    }
  }

  async sendPromptNow(agent: Agent): Promise<void> {
    if (!this.composerCanSend()) return;
    if (this.state.pasteView) this.paste.closePasteView(agent);
    if (agent.state.isStreaming) return this.queue.queueDraft(agent);
    const draft = this.state.draft.trim();
    if (!draft && this.state.attachments.length === 0) return;
    const sideChat = this.ctx.chat.state.forkSession?.sideChat;
    const text =
      sideChat?.quote &&
      !sideChat.expanded &&
      !agent.state.messages.length &&
      (this.options.includeSideChatExcerpt?.() ?? true)
        ? `${sideChat.quote
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")}\n\n${draft}`
        : draft;
    const submit = this.options.prepareSubmit?.();
    if (submit) {
      const selected = this.currentModelOption()!;
      const attachments = [...this.state.attachments];
      const selection: ComposerSubmission = {
        model: selected.model.id,
        thinkingLevel: this.state.effortLevel,
        fastMode: modelSupportsFastMode(this.scopeKey(), selected.model.id) && this.state.fastMode === true,
      };
      this.submitting = true;
      this.clearActiveDraft();
      this.resetComposer();
      this.ctx.chat.drawActiveChat(agent);
      try {
        const { uploaded, skipped } = await uploadAttachments(attachments);
        if (skipped.length) throw new Error(skipped.map((file) => file.note).join(" "));
        await submit(text, { ...selection, ...(uploaded.length ? { attachments: uploaded } : {}) });
      } catch (error) {
        this.queue.restoreStagedOnFailure(draft, attachments, errMessage(error, "Could not send message."));
        this.persistDraft();
      } finally {
        this.submitting = false;
        this.ctx.chat.drawActiveChat(agent);
      }
      return;
    }
    if (this.ctx.chat.state.threadRef) {
      bumpSessionActivity(this.ctx.chat.state.threadRef);
      this.ctx.chat.state.pendingSend = this.ctx.chat.state.threadRef;
      renderList();
    }
    const attachments = this.state.attachments;
    const sentFromThread = this.ctx.chat.state.threadRef;
    this.ctx.chat.notePendingSessionOnSend();
    this.clearActiveDraft();
    this.resetComposer();
    this.ctx.chat.drawActiveChat(agent);
    this.clearComposerDom(agent);
    try {
      if (this.ctx.chat.state.normalStreamFn) agent.streamFn = this.ctx.chat.state.normalStreamFn;
      this.ctx.chat.scrollToBottom();
      await agent.prompt(userSendMessage(text, attachments.length ? attachments : undefined));
      this.restoreFailedSend(agent, sentFromThread, draft, attachments);
    } catch (err) {
      this.abandonPendingSend();
      this.state.error = errMessage(err, "Could not send message.");
      this.ctx.chat.drawActiveChat(agent);
    }
  }

  abandonPendingSend(): void {
    this.ctx.chat.state.pendingSend = null;
    if (this.ctx.chat.state.threadRef && this.ctx.chat.state.sessionId === null)
      dropPendingSession(this.ctx.chat.state.threadRef);
    renderList();
  }

  unwindSend(agent: Agent, text: string, attachments: Attachment[], note: string): void {
    const messages = agent.state.messages;
    messages.pop();
    const prompt = messages[messages.length - 1] as { role?: string } | undefined;
    if (prompt?.role === "user" || prompt?.role === "user-with-attachments") messages.pop();
    (agent.state as { errorMessage?: string }).errorMessage = undefined;
    this.abandonPendingSend();
    this.queue.restoreStagedOnFailure(text, attachments, note);
    this.persistDraft();
    this.ctx.chat.drawActiveChat(agent);
  }

  restoreFailedSend(agent: Agent, sentFromThread: string | null, text: string, attachments: Attachment[]): void {
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
      if (agent === this.ctx.chat.state.agent)
        return this.unwindSend(agent, text, attachments, last.errorMessage || PENDING_APPROVAL_REASON);
      if (sentFromThread) saveDraft(sentFromThread, text);
      return;
    }
    if (last.sendFailed !== "attachments" || agent !== this.ctx.chat.state.agent) return;
    const dropped = new Set(last.droppedAttachmentIds ?? []);
    const retryable = attachments.filter((a) => !dropped.has(a.id));
    this.unwindSend(
      agent,
      text,
      retryable,
      retryable.length
        ? "Couldn't attach the files, so the message wasn't sent. Try again."
        : "Nothing could be attached, so the message wasn't sent.",
    );
  }

  resizeComposer(): void {
    requestAnimationFrame(() => {
      const ta = this.ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".composer-input");
      if (!ta) return;
      if (this.autosizedTa !== ta && typeof ResizeObserver !== "undefined") {
        this.autosizeObserver ??= new ResizeObserver(() => {
          this.autosizedValue = null;
          this.resizeComposer();
        });
        if (this.autosizedTa) this.autosizeObserver.unobserve(this.autosizedTa);
        this.autosizeObserver.observe(ta);
        this.autosizedTa = ta;
        this.autosizedValue = null;
      }
      if (ta.value === this.autosizedValue) return;
      this.autosizedValue = ta.value;
      resizeComposerInput(ta, this.ctx.pane ? 0 : 48);
    });
  }

  closeMenus(): boolean {
    let changed = false;
    if (this.state.openMenu) {
      this.modelPicker.resetSection();
      this.state.openMenu = null;
      changed = true;
    }
    if (!this.state.slashDismissed && slashQuery(this.state.draft) !== null) {
      this.state.slashDismissed = true;
      changed = true;
    }
    return changed;
  }

  dispose(): void {
    this.disposed = true;
    if (!this.pendingSubmissions) window.removeEventListener("qm:prepare-update", this.preventUnsafeUpdate);
    window.removeEventListener("model-account-changed", this.refreshAccount);
    document.removeEventListener("visibilitychange", this.revalidateRuntime);
    window.removeEventListener("online", this.revalidateRuntime);
    this.modelPicker.dispose();
    this.unsubscribeRuntime?.();
    ++this.runtimeRequest;
    this.fileDrag.dispose();
    this.autosizeObserver?.disconnect();
    this.autosizeObserver = null;
    this.autosizedTa = null;
  }

  async addAnnotations(
    text: string,
    files: File[],
    annotationId: string = crypto.randomUUID(),
    remove = false,
  ): Promise<boolean> {
    const agent = this.ctx.chat.state.agent;
    if (!agent || this.state.processingFiles || this.approvalPending()) return false;
    const prefix = `annotation_${annotationId}_`;
    const retained = this.state.attachments.filter((attachment) => !attachment.id.startsWith(prefix));
    if (remove) {
      this.state.attachments = retained;
      this.ctx.chat.drawActiveChat(agent);
      return true;
    }
    if (retained.length + 1 + files.length > MAX_FILES_PER_MESSAGE) return false;
    this.state.processingFiles = true;
    this.ctx.chat.drawActiveChat(agent);
    try {
      const loaded = await Promise.all(files.map((file) => loadAnyAttachment(file)));
      if (agent !== this.ctx.chat.state.agent) return false;
      const remaining = this.state.attachments.filter((attachment) => !attachment.id.startsWith(prefix));
      if (remaining.length + 1 + loaded.length > MAX_FILES_PER_MESSAGE) return false;
      this.state.attachments = [
        ...remaining,
        textAttachment(prefix + "context", "App annotation.md", "text/markdown", text),
        ...loaded.map((attachment, index) => ({ ...attachment, id: prefix + index })),
      ];
      this.state.error = "";
      return true;
    } catch {
      this.state.error = "Could not prepare annotation attachments. Retrying automatically.";
      return false;
    } finally {
      this.state.processingFiles = false;
      this.ctx.chat.drawActiveChat(agent);
    }
  }
}

export function runtimeScopeKey(scopeId: string | null): string | null {
  if (scopeId) return scopeId;
  const user = appState.me?.user;
  return user ? `personal:${user}` : null;
}

export function createComposerSurface(ctx: ConvCtx, options: ComposerOptions = {}): ComposerSurface {
  return new Composer(ctx, options);
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
