import { emojiCompletion } from "./emoji-completion";
import { reportHandledError } from "./browser-errors.ts";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Attachment } from "@earendil-works/pi-web-ui";
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { CornerDownRight, X } from "lucide";
import { ApiError, mintSendKey, type QueuedRun, alwaysSteer } from "./core-bridge";
import { editQueuedRun, queueTurn, withdrawRun } from "./run-stream";
import { uploadAttachments, type CoreAttachment } from "./attachments";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./icons";
import { bumpSessionActivity } from "./sessions";
import { tip } from "./tooltip";
import type { Composer } from "./composer";

export class ComposerQueue {
  readonly composer: Composer;
  readonly queuedRuns = new Map<string, QueuedRun[]>();
  readonly steeringRuns = new Map<string, Array<QueuedRun & { ts: string }>>();
  readonly pendingSteers = new Set<string>();
  queuedEdit: { runId: string; threadRef: string; original: string; text: string; saving: boolean } | null = null;
  failedQueueSend: { threadRef: string; text: string; filesKey: string; idempotencyKey: string } | null = null;

  constructor(composer: Composer) {
    this.composer = composer;
  }

  queuedRunsFor(threadRef: string | null): QueuedRun[] {
    return (threadRef ? this.queuedRuns.get(threadRef) : undefined) ?? [];
  }

  putRuns<T>(map: Map<string, T[]>, threadRef: string, runs: T[]): void {
    if (runs.length) map.set(threadRef, runs);
    else map.delete(threadRef);
  }

  setQueuedRuns(threadRef: string, runs: QueuedRun[]): void {
    this.putRuns(this.queuedRuns, threadRef, runs);
  }

  forgetQueuedRun(threadRef: string, runId: string): void {
    this.setQueuedRuns(
      threadRef,
      this.queuedRunsFor(threadRef).filter((r) => r.runId !== runId),
    );
  }

  steeringRunsFor(threadRef: string | null, agent: Agent): QueuedRun[] {
    const steering = threadRef ? this.steeringRuns.get(threadRef) : undefined;
    if (!threadRef || !steering) return [];
    const settled = !agent.state.isStreaming && !this.composer.ctx.chat.hasLiveRun();
    const intakes = new Set(
      agent.state.messages.flatMap((m) => {
        const { steered, ts } = m as { steered?: boolean; ts?: string };
        return steered && ts ? [ts] : [];
      }),
    );
    const waiting = settled ? [] : steering.filter((run) => !intakes.has(run.ts));
    this.putRuns(this.steeringRuns, threadRef, waiting);
    return waiting;
  }

  queuedStrip(agent: Agent): TemplateResult | typeof nothing {
    const threadRef = this.composer.ctx.chat.state.threadRef;
    const queued = this.queuedRunsFor(threadRef).filter((q) => !this.pendingSteers.has(q.runId));
    if (
      this.queuedEdit?.threadRef === this.composer.ctx.chat.state.threadRef &&
      !queued.some((q) => q.runId === this.queuedEdit?.runId)
    )
      queued.push({ runId: this.queuedEdit.runId, text: this.queuedEdit.original });
    if (!queued.length) return nothing;
    const steerable = this.composer.canSteer(agent);
    return html`
      <div class="queued-strip" role="list" aria-label="Queued messages">
        ${queued.map((q) =>
          this.queuedEdit?.runId === q.runId && this.queuedEdit.threadRef === this.composer.ctx.chat.state.threadRef
            ? html` <div class="queued-chip queued-editing" role="listitem">
                <textarea
                  class="queued-edit-input"
                  ${emojiCompletion(this.queuedEdit.text)}
                  aria-label="Edit queued message"
                  rows="3"
                  .value=${live(this.queuedEdit.text)}
                  ?disabled=${this.queuedEdit.saving}
                  @input=${(event: Event) => {
                    if (this.queuedEdit) this.queuedEdit.text = (event.target as HTMLTextAreaElement).value;
                  }}
                  @keydown=${(event: KeyboardEvent) => {
                    const save = event.key === "Enter" && (event.metaKey || event.ctrlKey);
                    if (event.isComposing || this.queuedEdit?.saving || (!save && event.key !== "Escape")) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (save) void this.saveQueuedEdit(agent);
                    else this.cancelQueuedEdit(agent);
                  }}
                ></textarea>
                <button
                  type="button"
                  class="queued-steer"
                  aria-keyshortcuts="Control+Enter Meta+Enter"
                  ?disabled=${this.queuedEdit.saving}
                  @click=${() => void this.saveQueuedEdit(agent)}
                >
                  Save
                </button>
                <button
                  type="button"
                  class="queued-steer"
                  ?disabled=${this.queuedEdit.saving}
                  @click=${() => this.cancelQueuedEdit(agent)}
                >
                  Cancel
                </button>
              </div>`
            : html`
                <div class="queued-chip" role="listitem">
                  <span class="queued-tag">Queued</span>
                  <span class="queued-text" dir="auto" ${tip(q.text || "Files, no text")}
                    >${q.text || (q.hasAttachments ? "(files)" : "")}</span
                  >
                  <button
                    type="button"
                    class="queued-steer"
                    ?disabled=${!steerable}
                    ${tip(
                      steerable
                        ? "Steer the running task with this instead of waiting"
                        : "Nothing running can take this. It will go out as its own turn",
                    )}
                    @click=${() => void this.steerQueued(agent, q)}
                  >
                    ${icon(CornerDownRight, 13)}<span>Steer</span>
                  </button>
                  <button
                    type="button"
                    class="queued-steer"
                    aria-label="Edit queued message"
                    @click=${() => {
                      const edit = (this.queuedEdit = {
                        runId: q.runId,
                        threadRef: this.composer.ctx.chat.state.threadRef!,
                        original: q.text,
                        text: q.text,
                        saving: false,
                      });
                      this.composer.ctx.chat.drawActiveChat(agent);
                      requestAnimationFrame(() => {
                        if (
                          this.queuedEdit === edit &&
                          this.composer.ctx.chat.state.threadRef === edit.threadRef &&
                          this.composer.ctx.chat.state.agent === agent
                        )
                          this.composer.focusField(".queued-edit-input");
                      });
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    class="chip-x"
                    aria-label="Remove queued message"
                    ${tip("Remove")}
                    @click=${() => void this.removeQueued(agent, q)}
                  >
                    ${icon(X, 13)}
                  </button>
                </div>
              `,
        )}
      </div>
    `;
  }

  queuedFilesKey(staged: readonly Attachment[]): string {
    return staged.map((a) => a.id).join(",");
  }

  queueSendKey(threadRef: string, text: string, filesKey: string): string {
    return this.failedQueueSend?.threadRef === threadRef &&
      this.failedQueueSend.text === text &&
      this.failedQueueSend.filesKey === filesKey
      ? this.failedQueueSend.idempotencyKey
      : mintSendKey();
  }

  async queueDraft(agent: Agent): Promise<void> {
    const threadRef = this.composer.ctx.chat.state.threadRef;
    const text = this.composer.state.draft.trim();
    const staged = this.composer.state.attachments;
    if ((!text && !staged.length) || !threadRef) return;
    this.composer.clearActiveDraft();
    this.composer.state.draft = "";
    this.composer.state.attachments = [];
    this.composer.state.error = "";
    this.composer.ctx.chat.drawActiveChat(agent);
    this.composer.clearComposerDom(agent);
    const { uploaded, skipped } = await uploadAttachments(staged);
    const stillHere = (): boolean => this.composer.ctx.chat.state.threadRef === threadRef;
    if (skipped.length && stillHere()) this.composer.state.error = skipped.map((s) => s.note).join(" ");
    const droppedIds = new Set(skipped.filter((s) => s.permanent).flatMap((s) => (s.id ? [s.id] : [])));
    const transientIds = new Set(skipped.filter((s) => !s.permanent).flatMap((s) => (s.id ? [s.id] : [])));
    const sendable = staged.filter((a) => !droppedIds.has(a.id));
    if (!text && !uploaded.length) {
      if (stillHere())
        this.restoreStagedOnFailure(text, sendable, this.composer.state.error || "Could not queue the files.");
      return this.composer.ctx.chat.drawActiveChat(agent);
    }
    const steer = alwaysSteer() && this.composer.canSteer(agent);
    if (!(await this.enqueueTurn(agent, threadRef, text, uploaded, this.queuedFilesKey(sendable), steer))) {
      if (stillHere()) this.restoreStagedOnFailure(text, sendable, this.composer.state.error);
    } else if (transientIds.size && stillHere()) {
      this.composer.restageAttachments(
        staged.filter((a) => transientIds.has(a.id)),
        this.composer.state.error,
      );
    }
    this.composer.ctx.chat.drawActiveChat(agent);
  }

  restoreStagedOnFailure(text: string, staged: Attachment[], note: string): void {
    const typedSince = this.composer.state.draft.trim();
    this.composer.state.draft = !typedSince || typedSince === text ? text : `${text}\n${this.composer.state.draft}`;
    this.composer.restageAttachments(staged, note);
  }

  async enqueueTurn(
    agent: Agent,
    threadRef: string,
    text: string,
    attachments: CoreAttachment[] = [],
    filesKey = "",
    steer = false,
  ): Promise<boolean> {
    const idempotencyKey = this.queueSendKey(threadRef, text, filesKey);
    try {
      const queued = await queueTurn(
        threadRef,
        text,
        agent,
        this.composer.ctx.chat.currentTurnOptions,
        idempotencyKey,
        attachments,
      );
      this.failedQueueSend = null;
      bumpSessionActivity(threadRef);
      if (steer && this.composer.canSteer(agent) && threadRef === this.composer.ctx.chat.state.threadRef)
        void this.steerQueued(agent, queued, true);
      else this.addQueuedRun(threadRef, queued);
      return true;
    } catch (err) {
      this.failedQueueSend = { threadRef, text, filesKey, idempotencyKey };
      this.composer.state.error = errMessage(err, "Could not queue the message.");
      return false;
    }
  }

  cancelQueuedEdit(agent: Agent): void {
    if (this.queuedEdit?.saving) return;
    this.queuedEdit = null;
    this.composer.state.error = "";
    this.composer.ctx.chat.drawActiveChat(agent);
    this.composer.focusComposerEnd();
  }

  async saveQueuedEdit(agent: Agent): Promise<void> {
    const edit = this.queuedEdit;
    if (!edit || edit.saving) return;
    edit.saving = true;
    this.composer.state.error = "";
    this.composer.ctx.chat.drawActiveChat(agent);
    try {
      await editQueuedRun(edit.runId, edit.text, edit.original);
      this.setQueuedRuns(
        edit.threadRef,
        this.queuedRunsFor(edit.threadRef).map((q) => (q.runId === edit.runId ? { ...q, text: edit.text } : q)),
      );
      if (this.queuedEdit === edit) {
        this.queuedEdit = null;
        if (this.composer.ctx.chat.state.threadRef === edit.threadRef && this.composer.ctx.chat.state.agent === agent)
          this.composer.focusComposerEnd();
      }
    } catch (error) {
      if (this.composer.ctx.chat.state.threadRef === edit.threadRef)
        this.composer.state.error =
          error instanceof ApiError && error.status === 409
            ? "That message changed or already started. Your edit was not saved."
            : errMessage(error, "Could not edit the queued message.");
    } finally {
      edit.saving = false;
      if (this.composer.ctx.chat.state.threadRef === edit.threadRef) this.composer.ctx.chat.drawActiveChat(agent);
    }
  }

  async removeQueued(agent: Agent, queued: QueuedRun): Promise<void> {
    const threadRef = this.composer.ctx.chat.state.threadRef;
    if (!threadRef) return;
    this.composer.state.error = "";
    try {
      await withdrawRun(queued.runId);
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 409 || err.status === 404))) {
        this.composer.state.error = errMessage(err, "Could not remove the queued message.");
        return this.composer.ctx.chat.drawActiveChat(agent);
      }
    }
    this.forgetQueuedRun(threadRef, queued.runId);
    this.composer.ctx.chat.drawActiveChat(agent);
  }

  addQueuedRun(threadRef: string, queued: QueuedRun): void {
    this.setQueuedRuns(threadRef, [...this.queuedRunsFor(threadRef).filter((r) => r.runId !== queued.runId), queued]);
  }

  markSteering(threadRef: string, queued: QueuedRun): void {
    this.steeringRuns.set(threadRef, [
      ...(this.steeringRuns.get(threadRef) ?? []).filter((run) => run.runId !== queued.runId),
      { ...queued, ts: `queued-steer:${threadRef}:${queued.runId}` },
    ]);
  }

  unmarkSteering(threadRef: string, runId: string): void {
    this.putRuns(
      this.steeringRuns,
      threadRef,
      (this.steeringRuns.get(threadRef) ?? []).filter((run) => run.runId !== runId),
    );
  }

  async steerQueued(agent: Agent, queued: QueuedRun, fresh = false): Promise<void> {
    const threadRef = this.composer.ctx.chat.state.threadRef;
    if (!threadRef || !this.composer.ctx.chat.hasLiveRun() || this.pendingSteers.has(queued.runId)) {
      if (fresh && threadRef) this.addQueuedRun(threadRef, queued);
      return;
    }
    this.pendingSteers.add(queued.runId);
    this.composer.state.error = "";
    this.markSteering(threadRef, queued);
    let steered = false;
    let fallBackToQueue = fresh;
    const here = (): boolean =>
      agent === this.composer.ctx.chat.state.agent && threadRef === this.composer.ctx.chat.state.threadRef;
    try {
      const outcome = await this.composer.ctx.chat.signalLiveRun("steer", queued.text, queued.runId);
      steered = outcome.ok;
      if (outcome.ok || outcome.replayed) {
        fallBackToQueue = false;
        this.forgetQueuedRun(threadRef, queued.runId);
        bumpSessionActivity(threadRef);
        if (!outcome.ok && here())
          agent.state.messages.push({ role: "user", content: queued.text, timestamp: Date.now() } as AgentMessage);
      } else if (outcome.reason === "queued_started" || outcome.reason === "not_found") {
        fallBackToQueue = false;
        this.forgetQueuedRun(threadRef, queued.runId);
      } else {
        reportHandledError("web:steer_refused", new Error(outcome.reason ?? "steer refused"));
        if (outcome.reason === "queued_changed" && here())
          this.composer.state.error = "The queued message changed. Try steering it again.";
      }
    } catch (err) {
      reportHandledError("web:steer_queued", err);
      if (here()) this.composer.state.error = errMessage(err, "Could not confirm steering. Try again.");
    } finally {
      this.pendingSteers.delete(queued.runId);
      if (!steered) this.unmarkSteering(threadRef, queued.runId);
    }
    if (fallBackToQueue) this.addQueuedRun(threadRef, queued);
    if (!here()) return;
    this.composer.ctx.chat.drawActiveChat(agent);
    this.composer.ctx.chat.resumeIfIdle();
  }
}
