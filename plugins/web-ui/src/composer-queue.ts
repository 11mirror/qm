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
import type { ConvCtx } from "./conv-types";

export function createComposerQueue({
  ctx,
  composerState,
  canSteer,
  clearActiveDraft,
  clearComposerDom,
  focusComposerEnd,
  focusField,
  restageAttachments,
}: {
  ctx: ConvCtx;
  composerState: { draft: string; attachments: Attachment[]; error: string };
  canSteer: (agent: Agent) => boolean;
  clearActiveDraft: () => void;
  clearComposerDom: (agent: Agent) => void;
  focusComposerEnd: () => void;
  focusField: (selector: string, cursor?: number) => void;
  restageAttachments: (attachments: Attachment[], note: string) => void;
}) {
  const queuedRuns = new Map<string, QueuedRun[]>();
  let queuedEdit: { runId: string; threadRef: string; original: string; text: string; saving: boolean } | null = null;

  function queuedRunsFor(threadRef: string | null): QueuedRun[] {
    return (threadRef ? queuedRuns.get(threadRef) : undefined) ?? [];
  }

  function putRuns<T>(map: Map<string, T[]>, threadRef: string, runs: T[]): void {
    if (runs.length) map.set(threadRef, runs);
    else map.delete(threadRef);
  }

  function setQueuedRuns(threadRef: string, runs: QueuedRun[]): void {
    putRuns(queuedRuns, threadRef, runs);
  }

  function forgetQueuedRun(threadRef: string, runId: string): void {
    setQueuedRuns(
      threadRef,
      queuedRunsFor(threadRef).filter((r) => r.runId !== runId),
    );
  }

  const steeringRuns = new Map<string, Array<QueuedRun & { ts: string }>>();

  function steeringRunsFor(threadRef: string | null, agent: Agent): QueuedRun[] {
    const steering = threadRef ? steeringRuns.get(threadRef) : undefined;
    if (!threadRef || !steering) return [];
    const settled = !agent.state.isStreaming && !ctx.chat.hasLiveRun();
    const intakes = new Set(
      agent.state.messages.flatMap((m) => {
        const { steered, ts } = m as { steered?: boolean; ts?: string };
        return steered && ts ? [ts] : [];
      }),
    );
    const waiting = settled ? [] : steering.filter((run) => !intakes.has(run.ts));
    putRuns(steeringRuns, threadRef, waiting);
    return waiting;
  }

  function queuedStrip(agent: Agent): TemplateResult | typeof nothing {
    const threadRef = ctx.chat.state.threadRef;
    const queued = queuedRunsFor(threadRef).filter((q) => !pendingSteers.has(q.runId));
    if (queuedEdit?.threadRef === ctx.chat.state.threadRef && !queued.some((q) => q.runId === queuedEdit?.runId))
      queued.push({ runId: queuedEdit.runId, text: queuedEdit.original });
    if (!queued.length) return nothing;
    const steerable = canSteer(agent);
    return html`
      <div class="queued-strip" role="list" aria-label="Queued messages">
        ${queued.map((q) =>
          queuedEdit?.runId === q.runId && queuedEdit.threadRef === ctx.chat.state.threadRef
            ? html` <div class="queued-chip queued-editing" role="listitem">
                <textarea
                  class="queued-edit-input"
                  ${emojiCompletion(queuedEdit.text)}
                  aria-label="Edit queued message"
                  rows="3"
                  .value=${live(queuedEdit.text)}
                  ?disabled=${queuedEdit.saving}
                  @input=${(event: Event) => {
                    if (queuedEdit) queuedEdit.text = (event.target as HTMLTextAreaElement).value;
                  }}
                  @keydown=${(event: KeyboardEvent) => {
                    const save = event.key === "Enter" && (event.metaKey || event.ctrlKey);
                    if (event.isComposing || queuedEdit?.saving || (!save && event.key !== "Escape")) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (save) void saveQueuedEdit(agent);
                    else cancelQueuedEdit(agent);
                  }}
                ></textarea>
                <button
                  type="button"
                  class="queued-steer"
                  aria-keyshortcuts="Control+Enter Meta+Enter"
                  ?disabled=${queuedEdit.saving}
                  @click=${() => void saveQueuedEdit(agent)}
                >
                  Save
                </button>
                <button
                  type="button"
                  class="queued-steer"
                  ?disabled=${queuedEdit.saving}
                  @click=${() => cancelQueuedEdit(agent)}
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
                    @click=${() => void steerQueued(agent, q)}
                  >
                    ${icon(CornerDownRight, 13)}<span>Steer</span>
                  </button>
                  <button
                    type="button"
                    class="queued-steer"
                    aria-label="Edit queued message"
                    @click=${() => {
                      const edit = (queuedEdit = {
                        runId: q.runId,
                        threadRef: ctx.chat.state.threadRef!,
                        original: q.text,
                        text: q.text,
                        saving: false,
                      });
                      ctx.chat.drawActiveChat(agent);
                      requestAnimationFrame(() => {
                        if (
                          queuedEdit === edit &&
                          ctx.chat.state.threadRef === edit.threadRef &&
                          ctx.chat.state.agent === agent
                        )
                          focusField(".queued-edit-input");
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
                    @click=${() => void removeQueued(agent, q)}
                  >
                    ${icon(X, 13)}
                  </button>
                </div>
              `,
        )}
      </div>
    `;
  }

  let failedQueueSend: { threadRef: string; text: string; filesKey: string; idempotencyKey: string } | null = null;

  function queuedFilesKey(staged: readonly Attachment[]): string {
    return staged.map((a) => a.id).join(",");
  }

  function queueSendKey(threadRef: string, text: string, filesKey: string): string {
    return failedQueueSend?.threadRef === threadRef &&
      failedQueueSend.text === text &&
      failedQueueSend.filesKey === filesKey
      ? failedQueueSend.idempotencyKey
      : mintSendKey();
  }

  async function queueDraft(agent: Agent): Promise<void> {
    const threadRef = ctx.chat.state.threadRef;
    const text = composerState.draft.trim();
    const staged = composerState.attachments;
    if ((!text && !staged.length) || !threadRef) return;
    clearActiveDraft();
    composerState.draft = "";
    composerState.attachments = [];
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    clearComposerDom(agent);
    const { uploaded, skipped } = await uploadAttachments(staged);
    const stillHere = (): boolean => ctx.chat.state.threadRef === threadRef;
    if (skipped.length && stillHere()) composerState.error = skipped.map((s) => s.note).join(" ");
    const droppedIds = new Set(skipped.filter((s) => s.permanent).flatMap((s) => (s.id ? [s.id] : [])));
    const transientIds = new Set(skipped.filter((s) => !s.permanent).flatMap((s) => (s.id ? [s.id] : [])));
    const sendable = staged.filter((a) => !droppedIds.has(a.id));
    if (!text && !uploaded.length) {
      if (stillHere()) restoreStagedOnFailure(text, sendable, composerState.error || "Could not queue the files.");
      return ctx.chat.drawActiveChat(agent);
    }
    const steer = alwaysSteer() && canSteer(agent);
    if (!(await enqueueTurn(agent, threadRef, text, uploaded, queuedFilesKey(sendable), steer))) {
      if (stillHere()) restoreStagedOnFailure(text, sendable, composerState.error);
    } else if (transientIds.size && stillHere()) {
      restageAttachments(
        staged.filter((a) => transientIds.has(a.id)),
        composerState.error,
      );
    }
    ctx.chat.drawActiveChat(agent);
  }

  function restoreStagedOnFailure(text: string, staged: Attachment[], note: string): void {
    const typedSince = composerState.draft.trim();
    composerState.draft = !typedSince || typedSince === text ? text : `${text}\n${composerState.draft}`;
    restageAttachments(staged, note);
  }

  async function enqueueTurn(
    agent: Agent,
    threadRef: string,
    text: string,
    attachments: CoreAttachment[] = [],
    filesKey = "",
    steer = false,
  ): Promise<boolean> {
    const idempotencyKey = queueSendKey(threadRef, text, filesKey);
    try {
      const queued = await queueTurn(threadRef, text, agent, ctx.chat.currentTurnOptions, idempotencyKey, attachments);
      failedQueueSend = null;
      bumpSessionActivity(threadRef);
      if (steer && canSteer(agent) && threadRef === ctx.chat.state.threadRef) void steerQueued(agent, queued, true);
      else addQueuedRun(threadRef, queued);
      return true;
    } catch (err) {
      failedQueueSend = { threadRef, text, filesKey, idempotencyKey };
      composerState.error = errMessage(err, "Could not queue the message.");
      return false;
    }
  }

  function cancelQueuedEdit(agent: Agent): void {
    if (queuedEdit?.saving) return;
    queuedEdit = null;
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    focusComposerEnd();
  }

  async function saveQueuedEdit(agent: Agent): Promise<void> {
    const edit = queuedEdit;
    if (!edit || edit.saving) return;
    edit.saving = true;
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    try {
      await editQueuedRun(edit.runId, edit.text, edit.original);
      setQueuedRuns(
        edit.threadRef,
        queuedRunsFor(edit.threadRef).map((q) => (q.runId === edit.runId ? { ...q, text: edit.text } : q)),
      );
      if (queuedEdit === edit) {
        queuedEdit = null;
        if (ctx.chat.state.threadRef === edit.threadRef && ctx.chat.state.agent === agent) focusComposerEnd();
      }
    } catch (error) {
      if (ctx.chat.state.threadRef === edit.threadRef)
        composerState.error =
          error instanceof ApiError && error.status === 409
            ? "That message changed or already started. Your edit was not saved."
            : errMessage(error, "Could not edit the queued message.");
    } finally {
      edit.saving = false;
      if (ctx.chat.state.threadRef === edit.threadRef) ctx.chat.drawActiveChat(agent);
    }
  }

  async function removeQueued(agent: Agent, queued: QueuedRun): Promise<void> {
    const threadRef = ctx.chat.state.threadRef;
    if (!threadRef) return;
    composerState.error = "";
    try {
      await withdrawRun(queued.runId);
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 409 || err.status === 404))) {
        composerState.error = errMessage(err, "Could not remove the queued message.");
        return ctx.chat.drawActiveChat(agent);
      }
    }
    forgetQueuedRun(threadRef, queued.runId);
    ctx.chat.drawActiveChat(agent);
  }

  const pendingSteers = new Set<string>();

  function addQueuedRun(threadRef: string, queued: QueuedRun): void {
    setQueuedRuns(threadRef, [...queuedRunsFor(threadRef).filter((r) => r.runId !== queued.runId), queued]);
  }

  function markSteering(threadRef: string, queued: QueuedRun): void {
    steeringRuns.set(threadRef, [
      ...(steeringRuns.get(threadRef) ?? []).filter((run) => run.runId !== queued.runId),
      { ...queued, ts: `queued-steer:${threadRef}:${queued.runId}` },
    ]);
  }

  function unmarkSteering(threadRef: string, runId: string): void {
    putRuns(
      steeringRuns,
      threadRef,
      (steeringRuns.get(threadRef) ?? []).filter((run) => run.runId !== runId),
    );
  }

  async function steerQueued(agent: Agent, queued: QueuedRun, fresh = false): Promise<void> {
    const threadRef = ctx.chat.state.threadRef;
    if (!threadRef || !ctx.chat.hasLiveRun() || pendingSteers.has(queued.runId)) {
      if (fresh && threadRef) addQueuedRun(threadRef, queued);
      return;
    }
    pendingSteers.add(queued.runId);
    composerState.error = "";
    markSteering(threadRef, queued);
    let steered = false;
    let fallBackToQueue = fresh;
    const here = (): boolean => agent === ctx.chat.state.agent && threadRef === ctx.chat.state.threadRef;
    try {
      const outcome = await ctx.chat.signalLiveRun("steer", queued.text, queued.runId);
      steered = outcome.ok;
      if (outcome.ok || outcome.replayed) {
        fallBackToQueue = false;
        forgetQueuedRun(threadRef, queued.runId);
        bumpSessionActivity(threadRef);
        if (!outcome.ok && here())
          agent.state.messages.push({ role: "user", content: queued.text, timestamp: Date.now() } as AgentMessage);
      } else if (outcome.reason === "queued_started" || outcome.reason === "not_found") {
        fallBackToQueue = false;
        forgetQueuedRun(threadRef, queued.runId);
      } else {
        reportHandledError("web:steer_refused", new Error(outcome.reason ?? "steer refused"));
        if (outcome.reason === "queued_changed" && here())
          composerState.error = "The queued message changed. Try steering it again.";
      }
    } catch (err) {
      reportHandledError("web:steer_queued", err);
      if (here()) composerState.error = errMessage(err, "Could not confirm steering. Try again.");
    } finally {
      pendingSteers.delete(queued.runId);
      if (!steered) unmarkSteering(threadRef, queued.runId);
    }
    if (fallBackToQueue) addQueuedRun(threadRef, queued);
    if (!here()) return;
    ctx.chat.drawActiveChat(agent);
    ctx.chat.resumeIfIdle();
  }

  return { queueDraft, queuedRunsFor, queuedStrip, restoreStagedOnFailure, setQueuedRuns, steeringRunsFor };
}
