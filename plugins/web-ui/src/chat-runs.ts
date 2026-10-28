import { storeTranscript } from "./transcript-cache";
import type { CoreSession, TranscriptPage } from "./core-bridge";
import { type MessageFields } from "./message-rows";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  continuableMessages,
  hasRecordedRunReply,
  appendConsumedSteers,
  resumeAnchor,
  attachPendingApprovals,
  currentEarlierCount,
  inheritedRefreshItems,
  inheritedTranscript,
  type AssistantWork,
} from "./transcript-messages";
import {
  api,
  approvalBlocksComposer,
  fetchItem,
  fetchTranscript,
  fetchSessionApprovals,
  cancelSessionGoal,
  resolveApproval,
  unresolvedApprovals,
  type RunPoll,
  TAIL_TURNS,
  type ApprovalDecision,
  type PendingApproval,
  type WorkBlock,
  switchedDefault,
} from "./core-bridge";
import {
  activeRunForThread,
  hasLiveRun,
  requestStop,
  runIsTerminal,
  signalLiveRun,
  makeRunResumeStreamFn,
} from "./run-stream";
import { type Item } from "./items";
import { errMessage } from "../../chassis/src/errors";
import { transcriptModel } from "./model-options";
import { appState } from "./shell";
import { refreshSessions } from "./sessions";
import { type GoalStripState } from "./goal-strip";
import { reportHandledError } from "./browser-errors.ts";
import { type ChatCore, toMessages } from "./chat-core";
import { clearLiveWork, mountReadOnlyPage, pageAnchor } from "./chat-mount";
import { drawActiveChat, scheduleStreamDraw, syncWorkTicker, redrawTranscript, messageText } from "./chat-draw";

export function onDelivery(c: ChatCore, threadRef: string): void {
  const ro = c.readOnlyView;
  if (ro && threadRef === ro.threadRef) {
    void fetchTranscript(ro.id, ro.anchorSeq !== null ? { sinceSeq: ro.anchorSeq } : { tailTurns: TAIL_TURNS })
      .then((page) => {
        if (c.readOnlyView?.id !== ro.id) return;
        storeTranscript(ro.id, page);
        mountReadOnlyPage(c, ro.session, page);
      })
      .catch((error: unknown) => reportHandledError("web:transcript_refresh", error));
    return;
  }
  const agent = c.state.agent;
  if (!agent || threadRef !== c.state.threadRef || agent.state.isStreaming) return;
  void refreshTranscriptFromItems(c, agent);
}

export async function stopLiveRun(c: ChatCore): Promise<void> {
  if (c.runSlot.stopGeneration === c.runSlot.generation) return;
  const agent = c.state.agent;
  const generation = c.runSlot.generation;
  requestStop(c.runSlot);
  drawActiveChat(c);
  if (!hasLiveRun(c.runSlot)) return;
  try {
    await signalLiveRun(c.runSlot, "abort", undefined, { threadRef: c.state.threadRef });
  } catch (err) {
    if (generation !== c.runSlot.generation || c.runSlot.stopGeneration !== generation || agent !== c.state.agent)
      return;
    c.runSlot.stopGeneration = null;
    throw err;
  } finally {
    if (agent === c.state.agent) drawActiveChat(c);
  }
}

export function resumeIfIdle(c: ChatCore): void {
  const agent = c.state.agent;
  if (!agent || agent.state.isStreaming || !c.state.threadRef || !c.state.normalStreamFn || !c.state.onWork) return;
  void resumeTrackedRun(c, agent, c.state.threadRef, c.state.normalStreamFn, c.state.onWork);
}

export async function approveCommand(c: ChatCore, agent: Agent, decision: ApprovalDecision): Promise<void> {
  if (agent !== c.state.agent || !c.state.threadRef || agent.state.isStreaming) return;
  if (c.state.resolvingApprovals.size > 0) return;
  c.state.resolvingApprovals.add(decision.requestId);
  c.approvalsEpoch++;
  let resolving = true;
  const releaseSubmission = (): void => {
    if (!resolving) return;
    resolving = false;
    if (agent === c.state.agent) c.state.resolvingApprovals.delete(decision.requestId);
  };
  c.ctx.composer.state.error = "";
  drawActiveChat(c, agent);
  try {
    const threadRef = c.state.threadRef;
    const runId = await resolveApproval(decision);
    if (runId && c.state.normalStreamFn && c.state.onWork)
      await resumeRun(c, agent, threadRef, c.state.normalStreamFn, c.state.onWork, runId, undefined, () => {
        releaseSubmission();
        drawActiveChat(c, agent);
      });
  } catch (err) {
    if (agent === c.state.agent) {
      c.ctx.composer.state.error = err instanceof Error ? err.message : "Could not send the approval.";
      drawActiveChat(c, agent);
    }
  } finally {
    releaseSubmission();
    if (agent === c.state.agent) {
      clearLiveWork(c);
      await refreshSessions({ silent: true }).catch((error: unknown) =>
        reportHandledError("web:refresh_sessions", error),
      );
      await refreshTranscriptFromItems(c, agent);
    }
    const active = c.state.agent;
    if (active) {
      await active.waitForIdle();
      await syncPendingApprovals(c, active);
      drawActiveChat(c, active);
    }
  }
}

export function activePendingApprovals(c: ChatCore): PendingApproval[] {
  const agent = c.state.agent;
  if (!agent || agent.state.isStreaming) return [];
  const byId = new Map<string, PendingApproval>();
  for (const m of agent.state.messages) {
    if ((m as MessageFields).role !== "assistant") continue;
    for (const approval of (m as AssistantWork).work?.pendingApprovals ?? []) {
      if (!c.state.resolvingApprovals.has(approval.requestId)) byId.set(approval.requestId, approval);
    }
  }
  return unresolvedApprovals([...byId.values()]);
}

export function hasUnresolvedApproval(c: ChatCore): boolean {
  return activePendingApprovals(c).some(approvalBlocksComposer);
}

async function syncPendingApprovals(
  c: ChatCore,
  agent: Agent,
  messages?: AgentMessage[],
  pending?: Promise<{ approvals: PendingApproval[] } | null>,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const id = c.state.sessionId;
  if (!id || agent !== c.state.agent) return false;
  const r = await (pending ?? fetchSessionApprovals(id));
  if (!r || id !== c.state.sessionId || agent !== c.state.agent || !isCurrent()) return false;
  const target = messages ?? agent.state.messages;
  for (const message of target) delete (message as AssistantWork).work?.pendingApprovals;
  attachPendingApprovals(target, r.approvals ?? [], transcriptModel());
  if (target === agent.state.messages) c.approvalsEpoch++;
  return true;
}

export function attachApprovalsWhenLoaded(
  c: ChatCore,
  sessionId: string,
  pending: Promise<{ approvals: PendingApproval[] } | null>,
): void {
  const agent = c.state.agent;
  if (!agent || c.state.sessionId !== sessionId) return;
  const epoch = c.approvalsEpoch;
  const isCurrent = (): boolean =>
    epoch === c.approvalsEpoch &&
    !agent.state.isStreaming &&
    c.state.pendingSend === null &&
    c.state.resolvingApprovals.size === 0;
  const nonEmpty = pending.then(async (r) => {
    await transcriptRefreshesSettled(c);
    return r?.approvals.length ? r : null;
  });
  void syncPendingApprovals(c, agent, undefined, nonEmpty, isCurrent).then((attached) => {
    if (attached) drawActiveChat(c, agent);
  });
}

export function refreshTranscriptFromItems(c: ChatCore, agent: Agent): Promise<void> {
  const refresh = replaceTranscriptFromItems(c, agent);
  c.transcriptRefresh = refresh;
  return refresh;
}

async function transcriptRefreshesSettled(c: ChatCore): Promise<void> {
  let current: Promise<void>;
  do {
    current = c.transcriptRefresh;
    await current.catch(() => undefined);
  } while (current !== c.transcriptRefresh);
}

async function replaceTranscriptFromItems(c: ChatCore, agent: Agent): Promise<void> {
  const sessionId = c.state.sessionId;
  if (!sessionId || agent !== c.state.agent || agent.state.isStreaming) return drawActiveChat(c, agent);
  const generation = ++c.transcriptRefreshGeneration;
  const originalMessages = agent.state.messages;
  const last = originalMessages.at(-1) as AssistantWork | undefined;
  const isCurrent = (): boolean =>
    generation === c.transcriptRefreshGeneration &&
    sessionId === c.state.sessionId &&
    agent === c.state.agent &&
    !agent.state.isStreaming &&
    agent.state.messages === originalMessages &&
    agent.state.messages.at(-1) === last;
  if (last?.stopReason === "error" && !last.interruptedRunId) return drawActiveChat(c, agent);
  if (last?.stopReason === "aborted") return drawActiveChat(c, agent);
  try {
    if (last?.stopReason === "error" && last.interruptedRunId) {
      const run = await api<RunPoll>(`/api/runs/${encodeURIComponent(last.interruptedRunId)}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!isCurrent()) return;
      if (
        !runIsTerminal(run) ||
        run.status === "failed" ||
        !["ok", "silent", "react"].includes(run.result?.status ?? "")
      )
        return drawActiveChat(c, agent);
    }
    const anchor = c.state.transcriptAnchorSeq;
    const page = await c.transcriptFetcher(sessionId, anchor !== null ? { sinceSeq: anchor } : undefined);
    if (!isCurrent()) return;
    if (last?.stopReason === "error" && !hasRecordedRunReply(page.items ?? [], last.interruptedRunId!))
      return drawActiveChat(c, agent);
    c.state.pins = page.pins ?? [];
    c.state.goal = page.goal ?? null;
    if (page.runtime) c.state.turnRuntime = page.runtime;
    const split = inheritedTranscript(c.state.forkSession ?? {}, page.items ?? []);
    const messages = toMessages(split.current);
    const refreshedInherited = inheritedRefreshItems(
      c.state.forkSession ?? {},
      page.items ?? [],
      c.state.inheritedLoaded,
    );
    await syncPendingApprovals(c, agent, messages);
    if (!isCurrent()) return;
    if (refreshedInherited) c.state.inheritedMessages = toMessages(refreshedInherited);
    agent.state.messages = messages;
    c.approvalsEpoch++;
    c.state.earlierCount = currentEarlierCount(c.state.forkSession ?? {}, page.earlierItems ?? 0);
    c.state.transcriptAnchorSeq = pageAnchor(page);
    if (anchor === null) storeTranscript(sessionId, page);
  } catch (error) {
    reportHandledError("web:transcript_refresh", error);
  }
  drawActiveChat(c, agent);
}

export function transcriptAnchor(c: ChatCore): number | null {
  return c.readOnlyView ? c.readOnlyView.anchorSeq : c.state.transcriptAnchorSeq;
}

export function applyTranscript(
  c: ChatCore,
  s: CoreSession,
  page: TranscriptPage,
  approvals: Promise<{ approvals: PendingApproval[] } | null> | null,
  mountedAnchor: number | null,
): Promise<void> {
  if (c.state.sessionId !== s.id || c.state.loadingEarlier || transcriptAnchor(c) !== mountedAnchor)
    return Promise.resolve();
  if (c.readOnlyView?.id === s.id) {
    mountReadOnlyPage(c, s, page);
    return Promise.resolve();
  }
  const agent = c.state.agent;
  if (!agent || agent.state.isStreaming) return Promise.resolve();
  const generation = ++c.transcriptRefreshGeneration;
  const original = agent.state.messages;
  const isCurrent = () =>
    generation === c.transcriptRefreshGeneration &&
    s.id === c.state.sessionId &&
    agent === c.state.agent &&
    !agent.state.isStreaming &&
    agent.state.messages === original;
  const refresh = (async () => {
    const fork = c.state.forkSession ?? {};
    const split = inheritedTranscript(fork, page.items ?? []);
    const messages = toMessages(split.current);
    if (approvals) {
      await syncPendingApprovals(c, agent, messages, approvals, isCurrent);
      if (!isCurrent()) return;
    }
    c.state.pins = page.pins ?? [];
    c.state.goal = page.goal ?? null;
    if (page.runtime) c.state.turnRuntime = page.runtime;
    const inherited = inheritedRefreshItems(fork, page.items ?? [], c.state.inheritedLoaded);
    if (inherited) c.state.inheritedMessages = toMessages(inherited);
    agent.state.messages = messages;
    c.approvalsEpoch++;
    c.state.earlierCount = currentEarlierCount(fork, page.earlierItems ?? 0);
    c.state.transcriptAnchorSeq = pageAnchor(page);
    drawActiveChat(c, agent);
  })();
  c.transcriptRefresh = refresh;
  return refresh;
}

export function observeLiveWork(c: ChatCore, agent: Agent): (work: WorkBlock) => void {
  return (work: WorkBlock) => {
    if (agent !== c.state.agent) return;
    appendConsumedSteers(agent.state.messages, work);
    if (work.runtime && switchedDefault(work.runtime) && work.runtime.modelId !== c.state.turnRuntime?.modelId)
      void c.ctx.composer.followScopeDefault(agent);
    if (work.runtime) c.state.turnRuntime = work.runtime;
    else if (work !== c.state.liveWork) c.state.turnRuntime = null;
    c.state.liveWork = work;
    syncWorkTicker(c);
    scheduleStreamDraw(c, agent);
  };
}

export async function followNextQueuedRun(
  c: ChatCore,
  agent: Agent,
  threadRef: string,
  normalStreamFn: Agent["streamFn"],
  onWork: (work: WorkBlock) => void,
): Promise<void> {
  const active = await activeRunForThread(threadRef).catch((error: unknown) => {
    reportHandledError("web:reattach_active_run", error);
  });
  if (!active) return;
  if (agent !== c.state.agent || threadRef !== c.state.threadRef || agent.state.isStreaming) return;
  const next = c.ctx.composer.queuedRunsFor(threadRef).find((r) => r.runId === active.runId);
  c.ctx.composer.setQueuedRuns(threadRef, active.queued);
  if (!active.runId || !active.run || runIsTerminal(active.run)) return drawActiveChat(c, agent);
  const recorded = (agent.state.messages.at(-1) as { role?: string } | undefined)?.role === "user";
  if (active.run.input) agent.state.messages = continuableMessages(agent.state.messages, active.run.input).messages;
  else if (!recorded && !next) agent.state.messages = [...agent.state.messages, resumeAnchor()];
  agent.streamFn = makeRunResumeStreamFn(active.runId, active.run, onWork, c.runSlot);
  try {
    await (!active.run.input && next && !recorded ? agent.prompt(next.text) : agent.continue());
  } catch (err) {
    if (agent === c.state.agent) c.ctx.composer.state.error = errMessage(err, "Could not follow the queued message.");
  } finally {
    if (agent === c.state.agent) {
      agent.streamFn = normalStreamFn;
      await refreshTranscriptFromItems(c, agent);
    }
  }
}

export async function resumeTrackedRun(
  c: ChatCore,
  agent: Agent,
  threadRef: string,
  normalStreamFn: Agent["streamFn"],
  onWork: (work: WorkBlock) => void,
): Promise<boolean> {
  const activeRun = await activeRunForThread(threadRef).catch((error: unknown) => {
    reportHandledError("web:resume_active_run", error);
  });
  if (!activeRun) return false;
  if (agent === c.state.agent && threadRef === c.state.threadRef)
    c.ctx.composer.setQueuedRuns(threadRef, activeRun.queued);
  if (!activeRun.runId || !activeRun.run || runIsTerminal(activeRun.run)) return false;
  return resumeRun(c, agent, threadRef, normalStreamFn, onWork, activeRun.runId, activeRun.run);
}

async function resumeRun(
  c: ChatCore,
  agent: Agent,
  threadRef: string,
  normalStreamFn: Agent["streamFn"],
  onWork: (work: WorkBlock) => void,
  runId: string,
  initialRun?: RunPoll,
  onStarted?: () => void,
): Promise<boolean> {
  if (
    agent !== c.state.agent ||
    (c.ctx.inbox ? !c.ctx.visible() : appState.currentView !== "chats") ||
    agent.state.isStreaming
  )
    return false;
  await refreshTranscriptFromItems(c, agent);
  if (agent !== c.state.agent || agent.state.isStreaming) return false;
  if (!initialRun) initialRun = await api<RunPoll>(`/api/runs/${encodeURIComponent(runId)}`);
  if (agent !== c.state.agent || agent.state.isStreaming) return false;
  const { messages: msgs, popped } = continuableMessages(agent.state.messages, initialRun.input);
  agent.state.messages = msgs;
  const seedText = popped
    .map((m) => messageText(m).trim())
    .filter(Boolean)
    .join("\n\n");
  agent.streamFn = makeRunResumeStreamFn(runId, initialRun, onWork, c.runSlot, seedText);
  try {
    const completion = agent.continue();
    if (agent.state.isStreaming) onStarted?.();
    await completion;
  } catch (err) {
    if (agent === c.state.agent)
      c.ctx.composer.state.error = err instanceof Error ? err.message : "Could not reconnect to the running task.";
  } finally {
    if (agent === c.state.agent) {
      agent.streamFn = normalStreamFn;
      await refreshTranscriptFromItems(c, agent);
    }
  }
  return true;
}

export async function cancelGoal(c: ChatCore, agent: Agent, goal: GoalStripState): Promise<void> {
  const sessionId = c.state.sessionId;
  const key = `${sessionId}:${goal.createdAt}`;
  if (!sessionId || c.goalCancels.has(key)) return;
  c.goalCancels.set(key, "pending");
  drawActiveChat(c, agent);
  try {
    await cancelSessionGoal(sessionId);
    c.goalCancels.set(key, "done");
    if (agent === c.state.agent) await refreshTranscriptFromItems(c, agent);
  } catch (err) {
    c.goalCancels.delete(key);
    c.ctx.composer.state.error = errMessage(err, "Could not cancel the goal.");
  } finally {
    if (agent === c.state.agent) drawActiveChat(c, agent);
  }
}

export async function loadFullItem(c: ChatCore, work: WorkBlock, item: Item): Promise<void> {
  const sessionId = c.state.sessionId;
  if (!sessionId || !item.truncated) return;
  try {
    const full = await fetchItem(sessionId, item.seq);
    work.activity = work.activity.map((entry) => ("item" in entry && entry.item === item ? { item: full } : entry));
  } catch (err) {
    c.ctx.composer.state.error = errMessage(err, "Couldn't load the full output.");
  }
  redrawTranscript(c);
}
