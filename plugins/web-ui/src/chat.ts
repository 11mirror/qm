import "./slack-reply";
import type { SlackReply } from "./slack-reply";
import { createChatState } from "./chat-state";
import { createAssistantContent } from "./assistant-content";
import { pinnedStrip } from "./pinned-strip";
import { createLiveWork, shouldShowWork } from "./live-work";
import { createMessageRows, type MessageFields } from "./message-rows";
import { createBackgroundPanel } from "./background-panel";
import { createSubagentStrip } from "./subagent-strip";
import { createChatAttachments, type UserAttachmentView } from "./chat-attachments";
import { approvalSummaryView, createToolRows, SUBAGENT_MAIL_NOTES } from "./tool-rows";
import { liveWorkSummary } from "./work-summary";
import { assistantSidebar, messageRow, userBubble } from "./assistant-sidebar";
import { formatMessageTime } from "./message-time.ts";
import { messageEntrySeqs, highlightMessage } from "./message-link.ts";
import { appEditSlug } from "./app-edit";
import { isConnectionReturn } from "./connection-return";
import "./connect-apps";
import { dismissGeneratedActivity, loadGeneratedActivities } from "./generated-activities";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Attachment } from "@earendil-works/pi-web-ui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { UserMessageWithAttachments } from "@earendil-works/pi-web-ui";
import { markdown } from "./message-markdown";
import { html, nothing, render, type TemplateResult } from "lit";
import { Check, Copy, Files, GitFork, Link2, Maximize2, Pause, RefreshCw, Target, X, type IconNode } from "lucide";
import {
  continuableMessages,
  hasRecordedRunReply,
  messagesWithStreaming,
  appendConsumedSteers,
  resumeAnchor,
  attachPendingApprovals,
  itemsToMessages,
  currentEarlierCount,
  forkOriginDetails,
  forkCutSeq,
  inheritedRefreshItems,
  inheritedTranscript,
  loadInheritedTranscript,
  type AssistantWork,
  type HistorySystemNote,
  type HistoryApprovalDecision,
} from "./transcript-messages";
import {
  type SessionPin,
  api,
  approvalBlocksComposer,
  fetchItem,
  fetchTranscript,
  fetchSessionApprovals,
  forkSession,
  cancelSessionGoal,
  resolveApproval,
  unresolvedApprovals,
  type RunPoll,
  TAIL_TURNS,
  type ApprovalDecision,
  type CoreSession,
  type PendingApproval,
  type TurnOptions,
  type TranscriptPage,
  type TurnRuntime,
  type WorkBlock,
  onChatPrefsChange,
  pinLatestPrompt,
  switchedDefault,
} from "./core-bridge";
import {
  activeRunForThread,
  createRunSlot,
  hasLiveRun,
  requestStop,
  runIsTerminal,
  signalLiveRun,
  makeCoreStreamFn,
  makeOpenerStreamFn,
  makeRunResumeStreamFn,
} from "./run-stream";
import { messageWorkTimeline, currentTextPhase } from "./timeline";
import { activityItems, type Item } from "./items";
import "./slack-setup";
import { sessionLink, UI_BASE } from "./deep-link";
import type { ChatSurface, ConvCtx } from "./conv-types";
import { errMessage } from "../../chassis/src/errors";
import { showStateError } from "./error-banner";
import { slackWireToPlain, stripSlackDirectives } from "./slack-text";
import { installMarkdownSanitizer } from "./markdown-sanitize";
import { transcriptModel, defaultEffortForModel } from "./model-options";
import { attachmentGallery, brandMark, browserRenderableImage, copyText, waveLoader } from "./ui";
import { icon } from "./icons";
import { appState, renderSidebarTop, switchView, syncUrlFromState } from "./shell";
import { contextsState, scopeTitle } from "./contexts";
import { openProjectPage, scopeToolCount, sessionTopbarTpl, setScopedSession } from "./session-scope";
import {
  addPendingSession,
  dropPendingSession,
  replacePendingSession,
  groupDmTitle,
  refreshSessions,
  renderList,
  sessionsState,
  sessionSlackUrl,
  openSession,
} from "./sessions";
import { clearWorking, isAbandonedNewChat, shouldStartProactiveOpener, markWorking, surfaceOf } from "./session-list";
import { liveTurnThreadRef } from "./working-dot";
import { goalObjectiveLabel, goalWorkedLabel, type GoalStripState } from "./goal-strip";
import { newChatDraftKey, saveDraft, storedDraft } from "./drafts";
import { createForkOriginController, forkOriginView } from "./fork-origin";
import { tip } from "./tooltip";
import { goalWorked } from "./work-duration";
import { decorateTextCodeBlocks } from "./text-code";

import { createTranscriptViewport } from "./transcript-viewport";
import { suggestedActivities } from "./suggested-activities";
import { reportHandledError } from "./browser-errors.ts";
import { uiCanvasPanel } from "./ui-canvas";

installMarkdownSanitizer();

const detachedAgents = new WeakSet<Agent>();
const settledRowCache = new WeakMap<object, { key: unknown[]; tpl: TemplateResult | typeof nothing }>();
const CHAT_CTAS = [
  "What can I help with?",
  "Ahoy, what are we after?",
  "What are we charting today?",
  "Where shall we set sail?",
  "What's the heading, captain?",
];
const CTA_INDEX_KEY = "web-ui:chat-cta";
const APPROVED_LABELS: Record<string, string> = {
  once: "Approved once",
  session: "Approved for this session",
  always: "Approved always",
};
function nextChatCta(): string {
  let index = 0;
  try {
    const stored = Number(localStorage.getItem(CTA_INDEX_KEY));
    index = (Number.isInteger(stored) ? stored + 1 : 0) % CHAT_CTAS.length;
    localStorage.setItem(CTA_INDEX_KEY, String(index));
  } catch {
    void 0;
  }
  return CHAT_CTAS[index]!;
}
const connectedConnectors = new Set<string>();
const redrawHooks = new Set<() => void>();
let proactiveOpenerStarted = false;

const toMessages = (items: Item[]): AgentMessage[] => itemsToMessages(items, transcriptModel());

export function markConnectorConnected(provider: string): void {
  if (!provider) return;
  connectedConnectors.add(provider);
  for (const hook of redrawHooks) hook();
}

export function createChatSurface(
  ctx: ConvCtx,
  dependencies: { fetchTranscript?: typeof fetchTranscript; openSession?: typeof openSession } = {},
): ChatSurface {
  const runSlot = createRunSlot((message) => {
    ctx.composer.state.error = message;
  });
  let pendingFork: { index: number } | null = null;
  const transcriptViewport = createTranscriptViewport({ pinPrompt: () => !ctx.inbox && pinLatestPrompt() });
  const stopPrefsWatch = onChatPrefsChange(() => transcriptViewport.refresh());
  let preserveConnectionScroll = isConnectionReturn();
  let connectionReturnMessageCount: number | null = null;
  const transcriptFetcher = dependencies.fetchTranscript ?? fetchTranscript;
  const sessionOpener = dependencies.openSession ?? openSession;

  const goalCancels = new Map<string, "pending" | "done">();
  const freshWindow = () => ({ transcriptAnchorSeq: null, earlierCount: 0, loadingEarlier: false });
  const freshView = () => ({ ...freshWindow(), inheritedExpanded: false, pins: [], goal: null, turnRuntime: null });
  const chatState = createChatState();

  const { inlineSteers, prepareMessageRows, speakerLabelFor, speakerLabelTpl, speakerMember } =
    createMessageRows(chatState);
  const { userAttachmentBadge, deliveredFileBadge } = createChatAttachments({ chatState, redrawTranscript });
  const { assistantContent, assistantDisplayText, assistantFileList, isReadOnlySlackView, slackWireBubble } =
    createAssistantContent({
      ctx,
      chatState,
      runSlot,
      deliveredFileBadge,
      isConnectorConnected: (provider) => connectedConnectors.has(provider),
    });

  const background = createBackgroundPanel({ chatState, redrawTranscript });
  const { backgroundActivityStrip, consumeBackgroundPanelRequest, requestBackgroundPanel } = background;

  const { subagentStrip, subagentsTicking } = createSubagentStrip({
    ctx,
    chatState,
    drawActiveChat,
    openSessionById,
    syncWorkTicker,
  });
  const { toolRow, subagentChip } = createToolRows({ loadFullItem, openSessionById });
  const { liveWorkStatus, renderTimelineItem, waitingSteerRows, workBlock, resetThinking } = createLiveWork({
    ctx,
    chatState,
    runSlot,
    drawActiveChat,
    chatMessage,
    inlineSteers,
    toolRow,
  });

  let transcriptRefreshGeneration = 0;
  let approvalsEpoch = 0;
  const forkOriginController = createForkOriginController({
    state: chatState,
    load: async () => {
      const session = chatState.forkSession;
      if (!session) return [];
      const entries = await loadInheritedTranscript(session, [], transcriptFetcher);
      return toMessages(entries);
    },
    navigate: async () => {
      const sourceId = chatState.forkSession?.forkedFrom?.sessionId;
      if (sourceId) await openSessionPage(sourceId);
    },
    current: () => Boolean(chatState.forkSession && chatState.sessionId === chatState.forkSession.id),
    redraw: redrawTranscript,
    setError: (error) => {
      ctx.composer.state.error = error;
    },
  });

  async function openSessionPage(id: string): Promise<void> {
    const listed = sessionsState.list.find((session) => session.id === id);
    const page = await transcriptFetcher(id, { tailTurns: TAIL_TURNS });
    const source = listed ?? page.session;
    if (!source) throw new Error("missing session");
    await sessionOpener(source, Promise.resolve(page));
  }

  async function openSessionById(id: string): Promise<void> {
    try {
      await openSessionPage(id);
    } catch {
      ctx.composer.state.error = "Couldn't open that session.";
      redrawTranscript();
    }
  }

  let ctaThreadRef: string | null | undefined;
  let ctaText = CHAT_CTAS[0]!;
  let workTicker: ReturnType<typeof setInterval> | null = null;

  function notePendingSessionOnSend(): void {
    if (!chatState.threadRef || chatState.sessionId !== null) return;
    const existing = sessionsState.list.find((s) => s.id && s.threadRef === chatState.threadRef);
    if (existing) {
      if (chatState.agent) adoptActiveSessionFromList(chatState.agent);
      return;
    }
    addPendingSession(chatState.threadRef, chatState.scopeId, chatState.contextName);
  }

  let readOnlyView: { id: string; threadRef: string; session: CoreSession; anchorSeq: number | null } | null = null;

  function teardownActiveChat(): void {
    transcriptViewport.dispose();
    transcriptRefreshGeneration++;
    readOnlyView = null;
    preserveOutgoingWorkingDot(null);
    detachActiveAgent();
    chatState.agent = null;
    clearLiveWork();
    resetBackgroundPanel();
    setChat({ host: null, threadRef: null, sessionId: null, scopeId: null, contextName: null });
    setChat({ normalStreamFn: null, onWork: null, ...freshWindow() });
    chatState.resolvingApprovals.clear();
  }

  function resetChatState(): void {
    dropAbandonedNewChat(null);
    teardownActiveChat();
    proactiveOpenerStarted = false;
    remember();
    connectedConnectors.clear();
  }

  function setChat(patch: Partial<typeof chatState>): void {
    Object.assign(chatState, patch);
  }

  function remember(): void {
    chatState.rememberedThreadRef = chatState.threadRef;
    chatState.rememberedSessionId = chatState.sessionId;
    chatState.rememberedScopeId = chatState.scopeId;
    chatState.rememberedContextName = chatState.contextName;
  }

  function newChat(context?: { scopeId: string; name: string | null }): string {
    appState.currentView = "chats";
    renderSidebarTop();
    const user = appState.me?.user ?? "anon";
    const threadRef = `web:${user}:${crypto.randomUUID()}`;
    const carried = storedDraft(newChatDraftKey(user));
    if (carried) saveDraft(threadRef, carried);
    ctx.composer.resetComposer();
    forkOriginController.reset();
    mountContinuable(threadRef, null, context?.scopeId ?? null, [], context?.name ?? null);
    renderList();
    ctx.composer.focusComposerEnd();
    return threadRef;
  }

  function dropAbandonedNewChat(nextThreadRef: string | null): void {
    const ref = chatState.threadRef;
    if (
      isAbandonedNewChat({
        threadRef: ref,
        nextThreadRef,
        sessionId: chatState.sessionId,
        pendingSend: chatState.pendingSend,
        hasHumanMessage: (chatState.agent?.state.messages ?? []).some((m) => !(m as MessageFields).opener),
        draft: ctx.composer.state.draft || storedDraft(ref ?? ""),
        attachments: ctx.composer.state.attachments.length,
      })
    )
      dropPendingSession(ref!);
  }

  function liveThreadRef(): string | null {
    return liveTurnThreadRef({
      mountedThreadRef: chatState.threadRef,
      isStreaming: Boolean(chatState.agent?.state.isStreaming),
      pendingSend: chatState.pendingSend,
    });
  }

  function preserveOutgoingWorkingDot(nextThreadRef: string | null): void {
    const live = liveThreadRef();
    if (!live || live === nextThreadRef) return;
    sessionsState.list = markWorking(sessionsState.list, live);
  }

  function detachActiveAgent(): void {
    if (!chatState.agent) return;
    detachedAgents.add(chatState.agent);
    chatState.agent.abort();
  }

  function mountContinuable(
    threadRef: string,
    sessionId: string | null,
    scopeId: string | null,
    messages: AgentMessage[],
    contextName: string | null = null,
    session?: CoreSession,
    inheritedMessages: AgentMessage[] = [],
  ): void {
    const container = ctx.claimContainer();
    if (!container) return;
    readOnlyView = null;
    preserveOutgoingWorkingDot(threadRef);
    dropAbandonedNewChat(threadRef);
    detachActiveAgent();
    ctx.composer.resetComposer();
    forkOriginController.reset();
    setChat({ threadRef, sessionId, scopeId, contextName, forkSession: session ?? null, inheritedMessages });
    setChat({ ...freshView(), inheritedLoaded: !session?.forkedFrom });
    remember();
    ctx.composer.state.draft = storedDraft(threadRef);
    syncLocation();
    chatState.host = document.createElement("div");
    chatState.host.className = "custom-chat";

    const model = ctx.composer.currentModelOption()?.model;
    const defaultThinkingLevel = defaultEffortForModel(model);
    const agent = new Agent({
      initialState: {
        systemPrompt: "",
        ...(model ? { model } : {}),
        ...(defaultThinkingLevel === "low" ? { thinkingLevel: "low" as const } : {}),
        messages,
        tools: [],
      },
      convertToLlm: () => [],
    });
    chatState.agent = agent;
    clearLiveWork();
    resetBackgroundPanel();
    chatState.resolvingApprovals.clear();
    resetThinking();
    const onWork = observeLiveWork(agent);
    const onSendIssues = (issues: string[], retryable: Attachment[]): void => {
      if (agent !== chatState.agent || !issues.length) return;
      ctx.composer.restageAttachments(retryable, issues.join(" "));
      drawActiveChat(agent);
    };
    const normalStreamFn = makeCoreStreamFn(threadRef, agent, currentTurnOptions, onWork, runSlot, onSendIssues);
    agent.streamFn = normalStreamFn;
    chatState.normalStreamFn = normalStreamFn;
    chatState.onWork = onWork;
    void ctx.composer.refreshRuntimeSelection(scopeId, agent);

    let listedWorking = false;
    agent.subscribe((e) => {
      scheduleStreamDraw(agent);
      if (agent === chatState.agent && (agent.state.isStreaming || e.type === "agent_end"))
        chatState.pendingSend = null;
      if (e.type === "agent_end" && !detachedAgents.has(agent))
        sessionsState.list = clearWorking(sessionsState.list, threadRef);
      const working = agent.state.isStreaming || chatState.pendingSend !== null;
      if (working !== listedWorking || e.type === "agent_end") {
        listedWorking = working;
        renderList();
      }
      if (e.type !== "agent_end") return;
      void agent.waitForIdle().then(async () => {
        if (agent === chatState.agent) clearLiveWork();
        await refreshSessions({ silent: true }).catch((error: unknown) =>
          reportHandledError("web:refresh_sessions", error),
        );
        if (!detachedAgents.has(agent)) {
          sessionsState.list = clearWorking(sessionsState.list, threadRef);
          renderList();
        }
        if (agent !== chatState.agent) return;
        adoptActiveSessionFromList(agent);
        await refreshTranscriptFromItems(agent);
        void ctx.composer.refreshRuntimeSelection(scopeId, agent, true);
        void followNextQueuedRun(agent, threadRef, normalStreamFn, onWork);
      });
    });

    container.replaceChildren(chatState.host);
    const opening = startProactiveOpenerIfNew(agent, threadRef, normalStreamFn, onWork, sessionId, scopeId, messages);
    drawActiveChat(agent, { forceScroll: true });
    const me = appState.me;
    if (!sessionId && me && (scopeId === null || scopeId === `personal:${me.user}`)) {
      void loadGeneratedActivities(me, () => {
        if (appState.me === me && chatState.agent === agent && !chatState.sessionId) drawActiveChat(agent);
      });
    }
    ctx.composer.focusComposerEnd();
    ctx.ensureDeliveryStream();
    if (!opening) void resumeTrackedRun(agent, threadRef, normalStreamFn, onWork);
    consumeBackgroundPanelRequest();
  }

  function startProactiveOpenerIfNew(
    agent: Agent,
    threadRef: string,
    normalStreamFn: Agent["streamFn"],
    onWork: (work: WorkBlock) => void,
    sessionId: string | null,
    scopeId: string | null,
    messages: AgentMessage[],
  ): boolean {
    if (ctx.inbox || appEditSlug(threadRef, appState.me?.user)) return false;
    if (
      !shouldStartProactiveOpener({
        started: proactiveOpenerStarted,
        sessionId,
        scopeId,
        messageCount: messages.length,
        loaded: sessionsState.loaded,
        sessions: sessionsState.list,
      })
    )
      return false;
    proactiveOpenerStarted = true;
    agent.state.messages = [{ role: "user", content: "", opener: true } as unknown as AgentMessage];
    agent.streamFn = makeOpenerStreamFn(threadRef, agent, currentTurnOptions, onWork, runSlot);
    void (async () => {
      try {
        await agent.continue();
      } catch (err) {
        if (agent === chatState.agent) ctx.composer.state.error = errMessage(err, "Could not start the conversation.");
      } finally {
        if (agent === chatState.agent) {
          agent.streamFn = normalStreamFn;
          const last = agent.state.messages[agent.state.messages.length - 1] as AssistantMessage | undefined;
          if (
            last?.role === "assistant" &&
            (last.stopReason === "error" || last.stopReason === "aborted") &&
            !messageText(last).trim()
          ) {
            agent.state.messages = [];
          }
          drawActiveChat(agent);
        }
      }
    })();
    return true;
  }

  function currentTurnOptions(): TurnOptions {
    const selected = ctx.composer.currentModelOption();
    if (!selected) throw new Error("No model is available");
    const target = { scopeId: chatState.scopeId, channelName: chatState.contextName };
    if (ctx.composer.followsDefault()) return target;
    return {
      effortLevel: ctx.composer.state.effortLevel,
      fastMode: ctx.composer.state.fastMode,
      ...target,
    };
  }

  function inheritedHeader(): TemplateResult | typeof nothing {
    const origin = chatState.forkSession
      ? forkOriginDetails(chatState.forkSession, chatState.inheritedLoaded ? chatState.inheritedMessages.length : 0)
      : null;
    return forkOriginView(
      origin
        ? {
            title: origin.title,
            messageCount: origin.messageCount,
            expanded: chatState.inheritedExpanded,
            icon: icon(GitFork, 14),
            navigate: () => void forkOriginController.navigate(),
            toggle: () =>
              void forkOriginController
                .toggle()
                .catch((error: unknown) => reportHandledError("web:fork_origin", error)),
          }
        : null,
    );
  }

  function onDelivery(threadRef: string): void {
    const ro = readOnlyView;
    if (ro && threadRef === ro.threadRef) {
      void fetchTranscript(ro.id, ro.anchorSeq !== null ? { sinceSeq: ro.anchorSeq } : { tailTurns: TAIL_TURNS })
        .then((page) => {
          if (readOnlyView?.id === ro.id) mountReadOnlyPage(readOnlyView.session, page);
        })
        .catch((error: unknown) => reportHandledError("web:transcript_refresh", error));
      return;
    }
    const agent = chatState.agent;
    if (!agent || threadRef !== chatState.threadRef || agent.state.isStreaming) return;
    void refreshTranscriptFromItems(agent);
  }

  async function stopLiveRun(): Promise<void> {
    if (runSlot.stopGeneration === runSlot.generation) return;
    const agent = chatState.agent;
    const generation = runSlot.generation;
    requestStop(runSlot);
    drawActiveChat();
    if (!hasLiveRun(runSlot)) return;
    try {
      await signalLiveRun(runSlot, "abort", undefined, { threadRef: chatState.threadRef });
    } catch (err) {
      if (generation !== runSlot.generation || runSlot.stopGeneration !== generation || agent !== chatState.agent)
        return;
      runSlot.stopGeneration = null;
      throw err;
    } finally {
      if (agent === chatState.agent) drawActiveChat();
    }
  }

  function resumeIfIdle(): void {
    const agent = chatState.agent;
    if (!agent || agent.state.isStreaming || !chatState.threadRef || !chatState.normalStreamFn || !chatState.onWork)
      return;
    void resumeTrackedRun(agent, chatState.threadRef, chatState.normalStreamFn, chatState.onWork);
  }

  function syncLocation(): void {
    if (ctx.ownsUrl) syncUrlFromState();
    else postCurrentPaneState();
  }

  function redrawForConnector(): void {
    if (chatState.agent) drawActiveChat();
  }

  function dispose(): void {
    redrawHooks.delete(redrawForConnector);
    stopPrefsWatch();
    teardownActiveChat();
  }

  async function approveCommand(agent: Agent, decision: ApprovalDecision): Promise<void> {
    if (agent !== chatState.agent || !chatState.threadRef || agent.state.isStreaming) return;
    if (chatState.resolvingApprovals.size > 0) return;
    chatState.resolvingApprovals.add(decision.requestId);
    approvalsEpoch++;
    let resolving = true;
    const releaseSubmission = (): void => {
      if (!resolving) return;
      resolving = false;
      if (agent === chatState.agent) chatState.resolvingApprovals.delete(decision.requestId);
    };
    ctx.composer.state.error = "";
    drawActiveChat(agent);
    try {
      const threadRef = chatState.threadRef;
      const runId = await resolveApproval(decision);
      if (runId && chatState.normalStreamFn && chatState.onWork)
        await resumeRun(agent, threadRef, chatState.normalStreamFn, chatState.onWork, runId, undefined, () => {
          releaseSubmission();
          drawActiveChat(agent);
        });
    } catch (err) {
      if (agent === chatState.agent) {
        ctx.composer.state.error = err instanceof Error ? err.message : "Could not send the approval.";
        drawActiveChat(agent);
      }
    } finally {
      releaseSubmission();
      if (agent === chatState.agent) {
        clearLiveWork();
        await refreshSessions({ silent: true }).catch((error: unknown) =>
          reportHandledError("web:refresh_sessions", error),
        );
        await refreshTranscriptFromItems(agent);
      }
      const active = chatState.agent;
      if (active) {
        await active.waitForIdle();
        await syncPendingApprovals(active);
        drawActiveChat(active);
      }
    }
  }

  function activePendingApprovals(): PendingApproval[] {
    const agent = chatState.agent;
    if (!agent || agent.state.isStreaming) return [];
    const byId = new Map<string, PendingApproval>();
    for (const m of agent.state.messages) {
      if ((m as MessageFields).role !== "assistant") continue;
      for (const approval of (m as AssistantWork).work?.pendingApprovals ?? []) {
        if (!chatState.resolvingApprovals.has(approval.requestId)) byId.set(approval.requestId, approval);
      }
    }
    return unresolvedApprovals([...byId.values()]);
  }

  function hasUnresolvedApproval(): boolean {
    return activePendingApprovals().some(approvalBlocksComposer);
  }

  async function syncPendingApprovals(
    agent: Agent,
    messages?: AgentMessage[],
    pending?: Promise<{ approvals: PendingApproval[] } | null>,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    const id = chatState.sessionId;
    if (!id || agent !== chatState.agent) return false;
    const r = await (pending ?? fetchSessionApprovals(id));
    if (!r || id !== chatState.sessionId || agent !== chatState.agent || !isCurrent()) return false;
    const target = messages ?? agent.state.messages;
    for (const message of target) delete (message as AssistantWork).work?.pendingApprovals;
    attachPendingApprovals(target, r.approvals ?? [], transcriptModel());
    if (target === agent.state.messages) approvalsEpoch++;
    return true;
  }

  function attachApprovalsWhenLoaded(
    sessionId: string,
    pending: Promise<{ approvals: PendingApproval[] } | null>,
  ): void {
    const agent = chatState.agent;
    if (!agent || chatState.sessionId !== sessionId) return;
    const epoch = approvalsEpoch;
    const isCurrent = (): boolean =>
      epoch === approvalsEpoch &&
      !agent.state.isStreaming &&
      chatState.pendingSend === null &&
      chatState.resolvingApprovals.size === 0;
    const nonEmpty = pending.then(async (r) => {
      await transcriptRefreshesSettled();
      return r?.approvals.length ? r : null;
    });
    void syncPendingApprovals(agent, undefined, nonEmpty, isCurrent).then((attached) => {
      if (attached) drawActiveChat(agent);
    });
  }

  let transcriptRefresh: Promise<void> = Promise.resolve();

  function refreshTranscriptFromItems(agent: Agent): Promise<void> {
    const refresh = replaceTranscriptFromItems(agent);
    transcriptRefresh = refresh;
    return refresh;
  }

  async function transcriptRefreshesSettled(): Promise<void> {
    let current: Promise<void>;
    do {
      current = transcriptRefresh;
      await current.catch(() => undefined);
    } while (current !== transcriptRefresh);
  }

  async function replaceTranscriptFromItems(agent: Agent): Promise<void> {
    const sessionId = chatState.sessionId;
    if (!sessionId || agent !== chatState.agent || agent.state.isStreaming) return drawActiveChat(agent);
    const generation = ++transcriptRefreshGeneration;
    const originalMessages = agent.state.messages;
    const last = originalMessages.at(-1) as AssistantWork | undefined;
    const isCurrent = (): boolean =>
      generation === transcriptRefreshGeneration &&
      sessionId === chatState.sessionId &&
      agent === chatState.agent &&
      !agent.state.isStreaming &&
      agent.state.messages === originalMessages &&
      agent.state.messages.at(-1) === last;
    if (last?.stopReason === "error" && !last.interruptedRunId) return drawActiveChat(agent);
    if (last?.stopReason === "aborted") return drawActiveChat(agent);
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
          return drawActiveChat(agent);
      }
      const anchor = chatState.transcriptAnchorSeq;
      const page = await transcriptFetcher(sessionId, anchor !== null ? { sinceSeq: anchor } : undefined);
      if (!isCurrent()) return;
      if (last?.stopReason === "error" && !hasRecordedRunReply(page.items ?? [], last.interruptedRunId!))
        return drawActiveChat(agent);
      chatState.pins = page.pins ?? [];
      chatState.goal = page.goal ?? null;
      if (page.runtime) chatState.turnRuntime = page.runtime;
      const split = inheritedTranscript(chatState.forkSession ?? {}, page.items ?? []);
      const messages = toMessages(split.current);
      const refreshedInherited = inheritedRefreshItems(
        chatState.forkSession ?? {},
        page.items ?? [],
        chatState.inheritedLoaded,
      );
      await syncPendingApprovals(agent, messages);
      if (!isCurrent()) return;
      if (refreshedInherited) chatState.inheritedMessages = toMessages(refreshedInherited);
      agent.state.messages = messages;
      approvalsEpoch++;
      chatState.earlierCount = currentEarlierCount(chatState.forkSession ?? {}, page.earlierItems ?? 0);
      chatState.transcriptAnchorSeq = pageAnchor(page);
    } catch (error) {
      reportHandledError("web:transcript_refresh", error);
    }
    drawActiveChat(agent);
  }

  function observeLiveWork(agent: Agent): (work: WorkBlock) => void {
    return (work: WorkBlock) => {
      if (agent !== chatState.agent) return;
      appendConsumedSteers(agent.state.messages, work);
      if (work.runtime && switchedDefault(work.runtime) && work.runtime.modelId !== chatState.turnRuntime?.modelId)
        void ctx.composer.followScopeDefault(agent);
      if (work.runtime) chatState.turnRuntime = work.runtime;
      else if (work !== chatState.liveWork) chatState.turnRuntime = null;
      chatState.liveWork = work;
      syncWorkTicker();
      scheduleStreamDraw(agent);
    };
  }

  async function followNextQueuedRun(
    agent: Agent,
    threadRef: string,
    normalStreamFn: Agent["streamFn"],
    onWork: (work: WorkBlock) => void,
  ): Promise<void> {
    const active = await activeRunForThread(threadRef).catch((error: unknown) => {
      reportHandledError("web:reattach_active_run", error);
    });
    if (!active) return;
    if (agent !== chatState.agent || threadRef !== chatState.threadRef || agent.state.isStreaming) return;
    const next = ctx.composer.queuedRunsFor(threadRef).find((r) => r.runId === active.runId);
    ctx.composer.setQueuedRuns(threadRef, active.queued);
    if (!active.runId || !active.run || runIsTerminal(active.run)) return drawActiveChat(agent);
    const recorded = (agent.state.messages.at(-1) as { role?: string } | undefined)?.role === "user";
    if (active.run.input) agent.state.messages = continuableMessages(agent.state.messages, active.run.input).messages;
    else if (!recorded && !next) agent.state.messages = [...agent.state.messages, resumeAnchor()];
    agent.streamFn = makeRunResumeStreamFn(active.runId, active.run, onWork, runSlot);
    try {
      await (!active.run.input && next && !recorded ? agent.prompt(next.text) : agent.continue());
    } catch (err) {
      if (agent === chatState.agent) ctx.composer.state.error = errMessage(err, "Could not follow the queued message.");
    } finally {
      if (agent === chatState.agent) {
        agent.streamFn = normalStreamFn;
        await refreshTranscriptFromItems(agent);
      }
    }
  }

  async function resumeTrackedRun(
    agent: Agent,
    threadRef: string,
    normalStreamFn: Agent["streamFn"],
    onWork: (work: WorkBlock) => void,
  ): Promise<boolean> {
    const activeRun = await activeRunForThread(threadRef).catch((error: unknown) => {
      reportHandledError("web:resume_active_run", error);
    });
    if (!activeRun) return false;
    if (agent === chatState.agent && threadRef === chatState.threadRef)
      ctx.composer.setQueuedRuns(threadRef, activeRun.queued);
    if (!activeRun.runId || !activeRun.run || runIsTerminal(activeRun.run)) return false;
    return resumeRun(agent, threadRef, normalStreamFn, onWork, activeRun.runId, activeRun.run);
  }

  async function resumeRun(
    agent: Agent,
    threadRef: string,
    normalStreamFn: Agent["streamFn"],
    onWork: (work: WorkBlock) => void,
    runId: string,
    initialRun?: RunPoll,
    onStarted?: () => void,
  ): Promise<boolean> {
    if (
      agent !== chatState.agent ||
      (ctx.inbox ? !ctx.visible() : appState.currentView !== "chats") ||
      agent.state.isStreaming
    )
      return false;
    await refreshTranscriptFromItems(agent);
    if (agent !== chatState.agent || agent.state.isStreaming) return false;
    if (!initialRun) initialRun = await api<RunPoll>(`/api/runs/${encodeURIComponent(runId)}`);
    if (agent !== chatState.agent || agent.state.isStreaming) return false;
    const { messages: msgs, popped } = continuableMessages(agent.state.messages, initialRun.input);
    agent.state.messages = msgs;
    const seedText = popped
      .map((m) => messageText(m).trim())
      .filter(Boolean)
      .join("\n\n");
    agent.streamFn = makeRunResumeStreamFn(runId, initialRun, onWork, runSlot, seedText);
    try {
      const completion = agent.continue();
      if (agent.state.isStreaming) onStarted?.();
      await completion;
    } catch (err) {
      if (agent === chatState.agent)
        ctx.composer.state.error = err instanceof Error ? err.message : "Could not reconnect to the running task.";
    } finally {
      if (agent === chatState.agent) {
        agent.streamFn = normalStreamFn;
        await refreshTranscriptFromItems(agent);
      }
    }
    return true;
  }

  function adoptActiveSessionFromList(agent: Agent): void {
    if (agent !== chatState.agent || chatState.sessionId !== null || chatState.threadRef === null) return;
    const match = sessionsState.list.find((s) => s.id && s.threadRef === chatState.threadRef);
    if (!match) return;
    setChat({ sessionId: match.id, scopeId: match.scopeId, contextName: match.channelName || chatState.contextName });
    remember();
    syncLocation();
  }

  function postCurrentPaneState(): void {
    if (!ctx.pane) return;
    ctx.onState?.({
      threadRef: chatState.threadRef ?? chatState.rememberedThreadRef,
      sessionId: chatState.sessionId ?? chatState.rememberedSessionId,
      working: liveThreadRef() !== null,
    });
  }

  function mountPane(className: string, content: TemplateResult): () => boolean {
    const container = ctx.container();
    if (!container) return () => false;
    const host = document.createElement("div");
    host.className = className;
    render(content, host);
    container.replaceChildren(host);
    return () => container.contains(host);
  }

  function mountLoadingPane(): () => boolean {
    dropAbandonedNewChat(null);
    teardownActiveChat();
    return mountPane(
      "custom-chat",
      html`<div class="custom-chat-shell">
        <div class="chat-loading">${waveLoader()}</div>
      </div>`,
    );
  }

  function mountLoadError(retry: () => void): void {
    mountPane(
      "empty compact",
      html`<p role="alert">Couldn't load this conversation.</p>
        <button class="btn" @click=${retry}>Retry</button>`,
    );
  }

  function mountReadOnly(
    s: CoreSession,
    messages: AgentMessage[],
    earlierCount = 0,
    anchorSeq: number | null = null,
    inheritedMessages: AgentMessage[] = [],
  ): void {
    const container = ctx.claimContainer();
    if (!container) return;
    preserveOutgoingWorkingDot(s.threadRef);
    dropAbandonedNewChat(s.threadRef);
    detachActiveAgent();
    chatState.agent = null;
    clearLiveWork();
    chatState.host = null;
    ctx.composer.resetComposer();
    const sameSession = chatState.sessionId === s.id && chatState.threadRef === null;
    if (!sameSession) forkOriginController.reset();
    chatState.threadRef = null;
    chatState.sessionId = s.id;
    chatState.scopeId = s.scopeId;
    chatState.forkSession = s;
    if (!(sameSession && chatState.inheritedLoaded)) {
      chatState.inheritedMessages = inheritedMessages;
      chatState.inheritedLoaded = !s.forkedFrom;
    }
    if (!sameSession) setChat(freshView());
    syncLocation();

    resetBackgroundPanel();
    const host = document.createElement("div");
    host.className = "custom-chat readonly-chat";
    const priorReply = sameSession ? container.querySelector<SlackReply>("qm-slack-reply") : null;
    const slackReply =
      surfaceOf(s) === "slack" ? (priorReply ?? (document.createElement("qm-slack-reply") as SlackReply)) : null;
    if (slackReply) {
      slackReply.sessionId = s.id;
      slackReply.user = appState.me?.user ?? "";
      if (!priorReply) slackReply.addEventListener("slack-sent", () => onDelivery(s.threadRef));
    }
    const draw = () => {
      const shownMessages = chatState.inheritedExpanded ? [...chatState.inheritedMessages, ...messages] : messages;
      prepareMessageRows(shownMessages);
      render(
        html`
          <div class="custom-chat-shell">
            <header class="chat-topbar">
              <div class="chat-heading">
                <div class="chat-title" dir="auto">${groupDmTitle(s)}</div>
                <div class="chat-subtitle">${surfaceOf(s) === "slack" ? "slack" : "Read-only"}</div>
              </div>
            </header>
            <div class="readonly-banner">
              ${
                surfaceOf(s) === "slack"
                  ? html`Replies are sent to this Slack conversation as
                    you.${
                      sessionSlackUrl(s)
                        ? html` <a
                            class="readonly-banner-link"
                            href=${sessionSlackUrl(s)!}
                            target="_blank"
                            rel="noreferrer"
                            >Open in Slack</a
                          >`
                        : nothing
                    }`
                  : "This conversation is read-only here."
              }
            </div>
            ${backgroundActivityStrip()}
            <section class="chat-scroll readonly-scroll" tabindex="0" aria-label="Conversation">
              ${pinnedStrip(chatState.pins, chatState.pinsExpanded, togglePins)}
              <div class="message-stack">
                ${inheritedHeader()}
                ${earlierCount > 0 ? earlierNotice(() => loadEarlierReadOnly(s, messages, anchorSeq)) : nothing}
                ${
                  shownMessages.length
                    ? shownMessages.map((m, i) => chatMessage(m, i))
                    : html`<div class="empty compact">No readable messages in this conversation.</div>`
                }
                ${ctx.composer.state.error ? html`<div class="composer-error inline">${ctx.composer.state.error}</div>` : nothing}
              </div>
            </section>
            ${slackReply ?? nothing}
          </div>
        `,
        host,
      );
      requestAnimationFrame(() => {
        decorateTextCodeBlocks(host);
        if (host.isConnected) transcriptViewport.sync(host.querySelector<HTMLElement>(".chat-scroll"));
      });
    };
    readonlyRedraw = draw;
    draw();
    container.replaceChildren(host);
    if (!sameSession) scrollTranscript(true);
    readOnlyView = { id: s.id, threadRef: s.threadRef, session: s, anchorSeq };
    ctx.ensureDeliveryStream();
    consumeBackgroundPanelRequest();
  }

  function setTurnRuntime(turnRuntime: TurnRuntime | null): void {
    setChat({ turnRuntime });
    drawActiveChat();
  }

  function setGoal(goal: GoalStripState | null): void {
    setChat({ goal });
    drawActiveChat();
  }

  function setPins(pins: SessionPin[]): void {
    setChat({ pins });
    redrawTranscript();
  }

  function togglePins(e: Event): void {
    if ((e.target as Element | null)?.closest("a")) return;
    chatState.pinsExpanded = !chatState.pinsExpanded;
    redrawTranscript();
  }

  function chatCta(): string {
    if (chatState.threadRef !== ctaThreadRef) {
      ctaThreadRef = chatState.threadRef;
      ctaText = nextChatCta();
    }
    return ctaText;
  }

  function setTranscriptWindow(anchorSeq: number | null, earlierCount: number, hasEarlier = earlierCount > 0): void {
    chatState.transcriptAnchorSeq = hasEarlier ? anchorSeq : null;
    chatState.earlierCount = earlierCount;
    if (chatState.agent) drawActiveChat(chatState.agent);
  }

  function earlierNotice(load: () => Promise<void> = loadEarlierMessages): TemplateResult {
    return html`<div class="earlier-messages">
      <button class="earlier-messages-btn" ?disabled=${chatState.loadingEarlier} @click=${() => void load()}>
        ${chatState.loadingEarlier ? "Loading earlier messages…" : "Show earlier messages"}
      </button>
    </div>`;
  }

  function keepScrollAfterPrepend(
    scroller: () => HTMLElement | null | undefined,
    prepend: () => void,
    current: (scroller: HTMLElement) => boolean = () => true,
  ): void {
    const before = scroller();
    const priorHeight = before?.scrollHeight ?? 0;
    const priorTop = before?.scrollTop ?? 0;
    prepend();
    requestAnimationFrame(() => {
      const now = scroller();
      if (!now || !current(now)) return;
      const prev = now.style.scrollBehavior;
      now.style.scrollBehavior = "auto";
      now.scrollTop = priorTop + (now.scrollHeight - priorHeight);
      now.style.scrollBehavior = prev;
    });
  }

  function pageAnchor(page: TranscriptPage): number | null {
    return (page.earlierItems ?? 0) > 0 ? (page.items?.[0]?.seq ?? null) : null;
  }

  function mountReadOnlyPage(
    s: CoreSession,
    page: TranscriptPage,
    messages: AgentMessage[] = [],
    inherited: AgentMessage[] = [],
  ): void {
    const split = inheritedTranscript(s, page.items ?? []);
    mountReadOnly(
      s,
      [...toMessages(split.current), ...messages],
      currentEarlierCount(s, page.earlierItems ?? 0),
      pageAnchor(page),
      [...toMessages(split.inherited), ...inherited],
    );
  }

  async function loadEarlierReadOnly(
    s: CoreSession,
    messages: AgentMessage[],
    anchorSeq: number | null,
  ): Promise<void> {
    if (chatState.loadingEarlier) return;
    chatState.loadingEarlier = true;
    readonlyRedraw?.();
    try {
      const page = await fetchTranscript(
        s.id,
        anchorSeq !== null ? { beforeSeq: anchorSeq, tailTurns: TAIL_TURNS } : undefined,
      );
      if (chatState.sessionId !== s.id) return;
      chatState.loadingEarlier = false;
      keepScrollAfterPrepend(
        () => ctx.container()?.querySelector<HTMLElement>(".chat-scroll"),
        () => mountReadOnlyPage(s, page, messages, chatState.inheritedMessages),
      );
    } catch (error) {
      reportHandledError("web:load_earlier", error);
      chatState.loadingEarlier = false;
      readonlyRedraw?.();
    }
  }

  async function loadEarlierMessages(): Promise<void> {
    const agent = chatState.agent;
    const sessionId = chatState.sessionId;
    const anchor = chatState.transcriptAnchorSeq;
    if (!agent || !sessionId || anchor === null || chatState.loadingEarlier) return;
    chatState.loadingEarlier = true;
    transcriptViewport.cancelFollow();
    drawActiveChat(agent);
    try {
      const page = await fetchTranscript(sessionId, { beforeSeq: anchor, tailTurns: TAIL_TURNS });
      if (agent !== chatState.agent || sessionId !== chatState.sessionId || anchor !== chatState.transcriptAnchorSeq)
        return;
      const split = inheritedTranscript(chatState.forkSession ?? {}, page.items ?? []);
      const earlierMessages = toMessages(split.current);
      if (!chatState.inheritedLoaded)
        chatState.inheritedMessages = [...toMessages(split.inherited), ...chatState.inheritedMessages];
      const scroller = (): HTMLElement | null | undefined => chatState.host?.querySelector<HTMLElement>(".chat-scroll");
      const before = scroller();
      keepScrollAfterPrepend(
        scroller,
        () => {
          agent.state.messages = [...earlierMessages, ...agent.state.messages];
          chatState.transcriptAnchorSeq = pageAnchor(page);
          chatState.earlierCount = currentEarlierCount(chatState.forkSession ?? {}, page.earlierItems ?? 0);
          chatState.loadingEarlier = false;
          drawActiveChat(agent);
        },
        (now) => agent === chatState.agent && sessionId === chatState.sessionId && now === before,
      );
    } catch (error) {
      reportHandledError("web:load_earlier", error);
    } finally {
      if (agent === chatState.agent && sessionId === chatState.sessionId && chatState.loadingEarlier) {
        chatState.loadingEarlier = false;
        drawActiveChat(agent);
      }
    }
  }

  let streamDrawAgent: Agent | null = null;
  function scheduleStreamDraw(agent: Agent): void {
    const scheduled = streamDrawAgent !== null;
    streamDrawAgent = agent;
    if (scheduled) return;
    requestAnimationFrame(() => {
      const target = streamDrawAgent;
      streamDrawAgent = null;
      if (target) drawActiveChat(target);
    });
  }

  function paneGlance(agent: Agent, messages: AgentMessage[], tier: "card" | "strip"): TemplateResult {
    const now = paneNowLine(agent);
    const last = [...messages].reverse().find((m) => m.role === "assistant" && messageText(m).trim());
    const snippet = last ? messageText(last).trim() : "";
    if (tier === "strip") {
      return html`
        <button type="button" class="pane-strip" ${tip("Expand this pane")} @click=${() => ctx.onExpand?.()}>
          <span class="pane-strip-text" dir="auto">${now ?? snippet}</span>
          ${icon(Maximize2, 13)}
        </button>
      `;
    }
    return html`
      <section class="pane-card" aria-live="polite">
        ${now ? html`<div class="pane-card-now"><span class="pane-card-now-label">Now</span><span class="pane-card-now-text" dir="auto">${now}</span></div>` : nothing}
        ${snippet ? html`<div class="pane-card-last" dir="auto">${snippet}</div>` : nothing}
      </section>
    `;
  }

  function paneNowLine(agent: Agent): string | null {
    if (activePendingApprovals().length) return "Needs your approval";
    if (agent.state.isStreaming || chatState.resolvingApprovals.size > 0) {
      const work = chatState.liveWork ?? { status: "thinking", activity: [] };
      if (runSlot.stopGeneration === runSlot.generation) return "Stop requested";
      if (currentTextPhase(work)?.phase === "final_answer") return "Responding…";
      const summary = liveWorkSummary(work);
      if (!summary) return "Thinking…";
      return summary.detail ? `${summary.label}: ${summary.detail}` : summary.label;
    }
    return null;
  }

  ctx.onDensityChange(() => drawActiveChat());

  function drawActiveChat(agent = chatState.agent, opts: { forceScroll?: boolean } = {}): void {
    if (!agent || agent !== chatState.agent || !chatState.host || (!ctx.inbox && appState.currentView !== "chats"))
      return;
    for (const message of agent.state.messages) {
      const work = (message as AssistantWork).work;
      if (work?.pendingApprovals) work.pendingApprovals = unresolvedApprovals(work.pendingApprovals);
    }
    adoptActiveSessionFromList(agent);
    if (!ctx.visible()) {
      postCurrentPaneState();
      return;
    }
    transcriptViewport.beforeRender();
    const currentMessages = visibleMessages(agent);
    if (preserveConnectionScroll) {
      connectionReturnMessageCount ??= currentMessages.length;
      if (connectionReturnMessageCount !== currentMessages.length) preserveConnectionScroll = false;
    }
    const messages = chatState.inheritedExpanded
      ? [...chatState.inheritedMessages, ...currentMessages]
      : currentMessages;
    prepareMessageRows(messages);
    const isNewUser = sessionsState.list.filter((s) => s.id).length === 0;
    const editingApp = appEditSlug(chatState.threadRef, appState.me?.user);
    const inheritedOffset = chatState.inheritedExpanded ? chatState.inheritedMessages.length : 0;
    const messageContent = messages.map((m, i) =>
      settledChatMessage(m, i - inheritedOffset, agent.state.isStreaming && m === agent.state.streamingMessage),
    );
    const tier = ctx.density();
    const glanceTier = tier === "card" || tier === "strip" ? tier : null;
    const emptyChat = !messages.length && !chatState.forkSession;
    const showSuggestions =
      !ctx.inbox &&
      emptyChat &&
      !editingApp &&
      !glanceTier &&
      (!ctx.pane || tier === "full") &&
      !chatState.sessionId &&
      (chatState.scopeId === null || chatState.scopeId === `personal:${appState.me?.user}`) &&
      !agent.state.isStreaming;
    const me = appState.me;
    const redrawSuggestions = () => {
      if (appState.me === me && !chatState.sessionId) drawActiveChat();
    };
    const suggestions = showSuggestions
      ? suggestedActivities(me?.suggestedActivities, {
          onSelect: (activity) => ctx.composer.fillSuggestedPrompt(activity.prompt, agent),
          ...(me?.suggestedActivitiesGeneration
            ? { onDismiss: (activity) => dismissGeneratedActivity(me, activity, redrawSuggestions) }
            : {}),
          redraw: redrawSuggestions,
          collapsed: Boolean(
            ctx.composer.state.draft || ctx.composer.state.attachments.length || ctx.composer.state.processingFiles,
          ),
        })
      : nothing;
    const dropOverlay = ctx.composer.state.dragging
      ? html`<div class="drop-overlay">
          <div class="drop-overlay-card">${icon(Files, 30)}<span>Drop files or folders to attach</span></div>
        </div>`
      : nothing;
    let content: TemplateResult;
    if (ctx.inbox) {
      content = assistantSidebar({
        context: ctx.inbox.context(),
        messages: html`${pinnedStrip(chatState.pins, chatState.pinsExpanded, togglePins)} ${inheritedHeader()}
        ${chatState.earlierCount > 0 ? earlierNotice() : nothing} ${messageContent} ${waitingSteerRows(agent)}
        ${showStateError(messages, agent.state.errorMessage) ? html`<div class="composer-error inline">${agent.state.errorMessage}</div>` : nothing}`,
        status: liveWorkStatus(agent),
        busy: agent.state.isStreaming,
        showPrompts: !messages.length,
        toolbar: html`${goalStrip(agent)} ${ctx.composer.queuedStrip(agent)} ${subagentStrip()}
        ${backgroundActivityStrip()}`,
        composer: ctx.composer.composerForm(agent),
        onPrompt: (prompt) => ctx.composer.fillSuggestedPrompt(prompt, agent),
        onDragEnter: (event) => ctx.composer.onDragEnter(event),
        onDragOver: (event) => ctx.composer.onDragOver(event),
        onDragLeave: (event) => ctx.composer.onDragLeave(event),
        onDrop: (event) => void ctx.composer.onDrop(event, agent),
        overlay: dropOverlay,
      });
    } else {
      content = html`
        <div
          class="custom-chat-shell ${editingApp ? "app-edit-chat" : ""} ${ctx.pane ? "in-pane" : ""} ${ctx.composer.state.dragging ? "dragging" : ""} ${
            emptyChat && !glanceTier && !editingApp ? "empty-chat" : ""
          }"
          @dragenter=${(e: DragEvent) => ctx.composer.onDragEnter(e)}
          @dragover=${(e: DragEvent) => ctx.composer.onDragOver(e)}
          @dragleave=${(e: DragEvent) => ctx.composer.onDragLeave(e)}
          @drop=${(e: DragEvent) => void ctx.composer.onDrop(e, agent)}
        >
          ${dropOverlay} ${uiCanvasPanel(ctx)} ${glanceTier || ctx.pane || editingApp ? nothing : sessionTopbar()}
          ${glanceTier ? paneGlance(agent, messages, glanceTier) : nothing}
          <section class="chat-scroll" tabindex="0" aria-label="Conversation">
            ${pinnedStrip(chatState.pins, chatState.pinsExpanded, togglePins)}
            <div class="message-stack ${emptyChat ? "empty-stack" : ""}">
              ${inheritedHeader()} ${chatState.earlierCount > 0 ? earlierNotice() : nothing} ${messageContent}
              ${waitingSteerRows(agent)} ${glanceTier ? nothing : liveWorkStatus(agent)}
              ${emptyChat && !isNewUser && !editingApp ? html`<h1 class="chat-cta">${chatCta()}</h1>` : nothing}
              ${ctx.pane ? suggestions : nothing}
              ${showStateError(messages, agent.state.errorMessage) ? html`<div class="composer-error inline">${agent.state.errorMessage}</div>` : nothing}
            </div>
          </section>
          <div class="chat-bottom-dock">
            ${goalStrip(agent)} ${ctx.composer.queuedStrip(agent)} ${subagentStrip()} ${backgroundActivityStrip()}
            ${ctx.composer.composerForm(agent)} ${ctx.pane ? nothing : suggestions}
          </div>
        </div>
      `;
    }
    render(content, chatState.host);
    transcriptViewport.afterRender();
    const host = chatState.host;
    requestAnimationFrame(() => {
      if (chatState.host !== host || chatState.agent !== agent || !host.isConnected) return;
      decorateTextCodeBlocks(host);
      ctx.composer.resizeComposer();
      scrollTranscript(opts.forceScroll);
    });
    postCurrentPaneState();
  }

  function sessionTopbar(): TemplateResult {
    const scope = chatState.scopeId;
    const session = sessionsState.list.find((s) =>
      chatState.sessionId
        ? s.id === chatState.sessionId
        : Boolean(chatState.threadRef) && s.threadRef === chatState.threadRef,
    );
    const currentSession = session ?? chatState.forkSession;
    const parentId = currentSession?.parentSessionId;
    const parent = parentId ? sessionsState.list.find((row) => row.id === parentId) : undefined;
    const title = currentSession?.title?.trim() ?? "";
    const crumb = scope && !scope.startsWith("personal:") ? scopeTitle(scope, chatState.contextName) : null;
    const forkedFrom =
      chatState.forkSession && chatState.sessionId === chatState.forkSession.id
        ? chatState.forkSession.forkedFrom
        : undefined;
    return sessionTopbarTpl({
      sessionId: chatState.sessionId ?? session?.id,
      crumb,
      title,
      parent: parentId
        ? { title: parent?.title?.trim() || "Parent session", onClick: () => void openSessionById(parentId) }
        : null,
      fork: forkedFrom
        ? {
            title: forkedFrom.title?.trim() || "another conversation",
            onClick: () => void forkOriginController.navigate(),
          }
        : null,
      onCrumb: crumb && scope ? () => openProjectPage(scope) : null,
      toolCount: scope ? (t) => scopeToolCount(t, scope, () => drawActiveChat()) : null,
      onTool: (tool) => {
        setScopedSession({
          scopeId: scope ?? "",
          sessionId: chatState.sessionId,
          threadRef: chatState.threadRef,
          title: title || "New chat",
          crumb,
        });
        if (scope && (tool === "crons" || tool === "files" || tool === "apps")) contextsState.selected = scope;
        switchView(tool === "apps" ? "deploys" : tool);
      },
    });
  }

  async function retryFailedSend(message: AgentMessage, index: number): Promise<void> {
    const agent = chatState.agent;
    if (!agent || agent.state.isStreaming || agent.state.messages[index] !== message) return;
    const failed = message as MessageFields;
    const error = agent.state.messages[index + 1] as AssistantWork | undefined;
    if (!failed.sendFailure || !error?.retryableSend) return;
    delete failed.sendFailure;
    agent.state.messages = agent.state.messages.filter((_, current) => current !== index + 1);
    ctx.composer.state.error = "";
    drawActiveChat(agent);
    try {
      await agent.continue();
    } catch (err) {
      if (agent === chatState.agent) ctx.composer.state.error = errMessage(err, "Could not retry the message.");
    }
  }

  function visibleMessages(agent: Agent): AgentMessage[] {
    return messagesWithStreaming(agent.state.messages, agent.state.streamingMessage);
  }

  function settledChatMessage(
    message: AgentMessage,
    index: number,
    isStreaming: boolean,
  ): TemplateResult | typeof nothing {
    const msg = message as AssistantWork & MessageFields;
    if (msg.steered) return nothing;
    const work = msg.work;
    const cacheable =
      !isStreaming &&
      !msg.subagentMail &&
      !activityItems(work?.activity ?? []).some(
        (item) => item.kind === "SteeringMessage" || ["session", "sessions", "subagents"].includes(item.tool ?? ""),
      ) &&
      (!work || ((work.status === "complete" || work.status === "failed") && !work.pendingApprovals?.length));
    if (!cacheable) return chatMessage(message, index, isStreaming);
    const forkable = Boolean(chatState.threadRef && chatState.sessionId && chatState.agent);
    const forking = pendingFork !== null;
    const speaker = speakerLabelFor(message);
    const speakerLabel =
      message.role === "assistant" && chatState.labelSpeakers
        ? chatState.assistantSpeakerLabel
        : speaker && `${speaker}\n${speakerMember(message)?.avatarUrl ?? ""}`;
    const key = [
      new Date().toDateString(),
      index,
      work?.activity,
      work?.status,
      work?.stale,
      msg.deliveredFiles,
      msg.stopReason,
      msg.errorMessage,
      msg.approvalDecision,
      msg.sendFailure,
      forkable,
      forking,
      speakerLabel,
      Boolean(msg.edited),
      Boolean(msg.deleted),
    ];
    const hit = settledRowCache.get(message as object);
    if (hit?.key.every((value, i) => value === key[i])) return hit.tpl;
    const tpl = chatMessage(message, index, isStreaming);
    settledRowCache.set(message as object, { key, tpl });
    return tpl;
  }

  function chatMessage(
    message: AgentMessage,
    index: number,
    isStreaming = false,
    inline = false,
  ): TemplateResult | typeof nothing {
    const m = message as MessageFields;
    if (m.opener || m.resumeAnchor || (!inline && m.steered)) return nothing;
    const seqs = messageEntrySeqs(message);
    if (m.role === "user" || m.role === "user-with-attachments") {
      const mail = m.subagentMail;
      if (mail)
        return messageRow(
          "subagent-mail-row",
          index,
          seqs,
          html`${subagentChip(mail.title, mail.sessionId)}
            <span class="subagent-mail-note">${SUBAGENT_MAIL_NOTES[mail.kind] ?? mail.kind.replace(/_/g, " ")}</span>`,
        );
      const text = messageText(message);
      const speaker = speakerLabelFor(message);
      let revision = m.edited ? "edited" : "";
      if (m.deleted) revision = "deleted";
      const attachments = ((message as UserMessageWithAttachments).attachments ?? []) as UserAttachmentView[];
      const before = html`${speakerLabelTpl(speaker, message)}${attachmentGallery(attachments, (attachment) => browserRenderableImage(attachment.mimeType), userAttachmentBadge)}`;
      const failure = m.sendFailure
        ? html`<div class="send-failure">
            <span>${m.sendFailure}</span>
            <button class="btn compact" type="button" @click=${() => void retryFailedSend(message, index)}>
              ${icon(RefreshCw, 12)} Retry
            </button>
          </div>`
        : nothing;
      return messageRow(
        `user-row ${speaker ? "named-user-row" : ""} ${m.steered ? "steered-row" : ""}`,
        index,
        seqs,
        html`${before}
        ${userBubble(isReadOnlySlackView() ? slackWireBubble(text) : markdown(text), {
          hidden: !text.trim() && !revision,
          deleted: m.deleted,
          revision,
        })}
        ${failure} ${messageMeta(message, index)}`,
      );
    }
    if (m.role === "approval-decision") {
      const decision = message as unknown as HistoryApprovalDecision;
      const label = decision.approved ? (APPROVED_LABELS[decision.scope ?? "once"] ?? "Approved") : "Approval denied";
      return messageRow(
        "system-note-row",
        index,
        seqs,
        html`<div class="system-note approval-decision">
          ${label}<code class="approval-cmd approval-cmd-full">${decision.command}</code>
        </div>`,
      );
    }
    if (m.role === "system-note") {
      const note = message as unknown as HistorySystemNote;
      let body = html`Goal cancelled: <span class="system-note-text">${goalObjectiveLabel(note.content)}</span>`;
      if (note.note !== "goal_cancelled")
        body =
          note.action === "deleted"
            ? html`${note.speaker ?? "The user"} deleted their message`
            : html`${note.speaker ?? "The user"} edited their message:
                <span class="system-note-text">${note.content}</span>`;
      return messageRow("system-note-row", index, seqs, html`<div class="system-note">${body}</div>`);
    }
    if (m.role !== "assistant") return nothing;
    const msg = message as AssistantWork;
    if (msg.retryableSend) return nothing;
    const work = msg.work;
    const stoppedEarly = msg.stopReason === "error" || msg.stopReason === "aborted";
    const text = assistantDisplayText(messageText(msg), msg.stopReason).trim();
    const showWork = m.approvalDecision !== "denied" && shouldShowWork(work, isStreaming || stoppedEarly ? "" : text);
    const steeringOnly =
      !showWork && work ? messageWorkTimeline(work, text).filter((item) => item.kind === "steer") : [];
    let workView: TemplateResult | typeof nothing =
      work && steeringOnly.length ? html`${steeringOnly.map((item) => renderTimelineItem(item, work))}` : nothing;
    if (showWork) {
      const workText = isStreaming ? messageText(msg) : text;
      workView = workBlock(work, isStreaming, stoppedEarly ? "" : workText, msg.streamingBaseline ?? "");
    }
    if (msg.stopReason === "aborted")
      workView = work ? workBlock(work, false, "", "", true) : html`<div class="stopped-head">You stopped</div>`;
    const hasVisibleContent =
      showWork ||
      steeringOnly.length > 0 ||
      Boolean(text) ||
      Boolean(msg.deliveredFiles?.length) ||
      msg.content.some((chunk) => chunk.type === "thinking" && chunk.thinking.trim());
    if (!hasVisibleContent && !stoppedEarly) return nothing;
    const shownSeqs = seqs.filter((seq) => !inlineSteers.has(seq));
    const body = html`${workView} ${assistantContent(msg, isStreaming, showWork)}
    ${assistantFileList(msg.deliveredFiles)}
    ${msg.stopReason === "error" && msg.errorMessage ? html`<div class="composer-error inline">${msg.errorMessage}</div>` : nothing}`;
    const meta = isStreaming ? nothing : messageMeta(msg, index);
    return messageRow(
      `assistant-row ${chatState.labelSpeakers ? "named-assistant-row" : ""} ${isStreaming ? "streaming" : ""}`,
      index,
      shownSeqs,
      html`${
          chatState.labelSpeakers
            ? html`<div class="speaker-label">${brandMark()}<span>${chatState.assistantSpeakerLabel}</span></div>`
            : nothing
        }
        <div class="assistant-body">${body} ${meta}</div>`,
    );
  }

  function copyableText(message: AgentMessage): string {
    const raw =
      message.role === "assistant"
        ? assistantDisplayText(messageText(message), (message as AssistantMessage).stopReason)
        : messageText(message);
    if (!isReadOnlySlackView()) return raw;
    const role = (message as MessageFields).role;
    return role === "user" || role === "user-with-attachments" ? slackWireToPlain(raw) : stripSlackDirectives(raw);
  }

  function messageMeta(message: AgentMessage, index: number): TemplateResult | typeof nothing {
    const text = copyableText(message).trim();
    const ts = (message as MessageFields).timestamp;
    if (!text && ts === undefined) return nothing;
    const forkable = Boolean(index >= 0 && chatState.threadRef && chatState.sessionId && chatState.agent);
    const seqs = messageEntrySeqs(message);
    return html`
      <div class="message-meta">
        ${ts !== undefined ? html`<span class="message-time">${formatMessageTime(ts)}</span>` : nothing}
        ${text ? copyButton("Copy", "Copy message", Copy, () => text) : nothing}
        ${
          chatState.sessionId && seqs.length
            ? copyButton("Copy message link", "Copy message link", Link2, () =>
                sessionLink(location.origin, UI_BASE, chatState.sessionId!, seqs[0]),
              )
            : nothing
        }
        ${
          forkable
            ? html`<button
                class="msg-copy msg-fork"
                type="button"
                ${tip(pendingFork ? "Forking..." : "Fork conversation from here")}
                aria-label=${pendingFork?.index === index ? "Forking conversation…" : "Fork conversation from here"}
                ?disabled=${pendingFork !== null}
                aria-busy=${pendingFork?.index === index ? "true" : "false"}
                @click=${() => void forkFromMessage(index)}
              >
                ${pendingFork?.index === index ? waveLoader({ width: 13, height: 13, label: "Forking" }) : icon(GitFork, 13)}
              </button>`
            : nothing
        }
      </div>
    `;
  }

  function copyButton(tipText: string, label: string, glyph: IconNode, text: () => string): TemplateResult {
    return html`<button
      class="msg-copy"
      type="button"
      ${tip(tipText)}
      aria-label=${label}
      @click=${(e: Event) => void copyText(text(), e.currentTarget as HTMLButtonElement)}
    >
      ${icon(glyph, 13)}${icon(Check, 13)}
    </button>`;
  }

  async function forkFromMessage(index: number): Promise<void> {
    const agent = chatState.agent;
    const sessionId = chatState.sessionId;
    const sourceThreadRef = chatState.threadRef;
    if (!agent || !sessionId || pendingFork) return;
    const messages = agent.state.messages;
    if (!messages[index]) return;
    const floorSeq = Math.max(chatState.forkSession?.forkBoundarySeq ?? -1, (chatState.transcriptAnchorSeq ?? 0) - 1);
    const pendingRef = `web:fork:${crypto.randomUUID()}`;
    pendingFork = { index };
    ctx.composer.state.error = "";
    addPendingSession(pendingRef, chatState.scopeId, chatState.contextName, true);
    if (chatState.scopeId) sessionsState.collapsedProjectScopes.delete(chatState.scopeId);
    renderList();
    drawActiveChat();
    try {
      const { items } = await api<{ items: Item[] }>(`/api/sessions/${encodeURIComponent(sessionId)}`);
      const upToSeq = forkCutSeq(items ?? [], messages, index, floorSeq);
      if (upToSeq === undefined) throw new Error("That message is still saving. Try forking again in a moment.");
      const forked = await forkSession(sessionId, upToSeq);
      replacePendingSession(pendingRef, forked.session);
      if (chatState.agent !== agent || chatState.sessionId !== sessionId) return;
      const split = inheritedTranscript(forked.session, forked.items ?? []);
      ctx.composer.carryModelPick(sourceThreadRef, forked.session.threadRef);
      mountContinuable(
        forked.session.threadRef,
        forked.session.id,
        forked.session.scopeId,
        toMessages(split.current),
        forked.session.channelName ?? null,
        forked.session,
        toMessages(split.inherited),
      );
      renderList();
    } catch (err) {
      ctx.composer.state.error = errMessage(err, "Could not fork the conversation.");
    } finally {
      pendingFork = null;
      dropPendingSession(pendingRef);
      drawActiveChat();
    }
  }

  function messageText(message: AgentMessage): string {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter(
          (c): c is TextContent => Boolean(c) && typeof c === "object" && (c as { type?: string }).type === "text",
        )
        .map((c) => c.text ?? "")
        .join("\n");
    }
    return "";
  }

  function syncWorkTicker(): void {
    const goalTicking = Boolean(chatState.agent?.state.isStreaming && currentGoal()?.status === "active");
    const active =
      (chatState.liveWork?.status === "working" && !chatState.liveWork.stale) || goalTicking || subagentsTicking();
    if (active && !workTicker) {
      workTicker = setInterval(() => drawActiveChat(), 1000);
    } else if (!active && workTicker) {
      clearInterval(workTicker);
      workTicker = null;
    }
  }

  function currentGoal(): GoalStripState | null {
    return chatState.liveWork?.goal ?? chatState.goal;
  }

  function clearLiveWork(): void {
    if (chatState.liveWork?.goal) chatState.goal = chatState.liveWork.goal;
    chatState.liveWork = null;
    chatState.pendingSend = null;
    syncWorkTicker();
  }

  let readonlyRedraw: (() => void) | null = null;

  function resetBackgroundPanel(): void {
    background.resetBackgroundPanel();
    readonlyRedraw = null;
  }

  async function cancelGoal(agent: Agent, goal: GoalStripState): Promise<void> {
    const sessionId = chatState.sessionId;
    const key = `${sessionId}:${goal.createdAt}`;
    if (!sessionId || goalCancels.has(key)) return;
    goalCancels.set(key, "pending");
    drawActiveChat(agent);
    try {
      await cancelSessionGoal(sessionId);
      goalCancels.set(key, "done");
      if (agent === chatState.agent) await refreshTranscriptFromItems(agent);
    } catch (err) {
      goalCancels.delete(key);
      ctx.composer.state.error = errMessage(err, "Could not cancel the goal.");
    } finally {
      if (agent === chatState.agent) drawActiveChat(agent);
    }
  }

  function goalStrip(agent: Agent): TemplateResult | typeof nothing {
    const messages = visibleMessages(agent);
    const goal = currentGoal();
    if (!goal) return nothing;
    const cancel = goalCancels.get(`${chatState.sessionId}:${goal.createdAt}`);
    if (cancel === "done") return nothing;
    const { workedMs, paused: stopped } = goalWorked(messages, goal);
    const paused = goal.status === "paused" || (goal.status === "active" && stopped);
    if (goal.status !== "active" && !paused) return nothing;
    let title = "Goal";
    if (paused) title = "Goal paused";
    else if (agent.state.isStreaming) title = "Pursuing goal";
    return html`
      <section class="goal-strip ${paused ? "paused" : ""}" aria-live="polite" title=${goal.objective}>
        <span class="goal-strip-icon">${icon(paused ? Pause : Target, 13)}</span>
        <span class="goal-strip-title">${title}</span>
        <span class="goal-strip-objective" dir="auto">${goalObjectiveLabel(goal.objective)}</span>
        <span class="goal-strip-meta">${goalWorkedLabel(workedMs, goal.floor)}</span>
        <button
          type="button"
          class="chip-x"
          aria-label="Cancel goal"
          ${tip("Cancel goal")}
          ?disabled=${cancel === "pending"}
          @click=${() => void cancelGoal(agent, goal)}
        >
          ${icon(X, 13)}
        </button>
      </section>
    `;
  }

  function redrawTranscript(): void {
    if (readonlyRedraw) readonlyRedraw();
    else drawActiveChat();
  }

  async function loadFullItem(work: WorkBlock, item: Item): Promise<void> {
    const sessionId = chatState.sessionId;
    if (!sessionId || !item.truncated) return;
    try {
      const full = await fetchItem(sessionId, item.seq);
      work.activity = work.activity.map((entry) => ("item" in entry && entry.item === item ? { item: full } : entry));
    } catch (err) {
      ctx.composer.state.error = errMessage(err, "Couldn't load the full output.");
    }
    redrawTranscript();
  }

  function scrollTranscript(force = false): void {
    if (preserveConnectionScroll) {
      transcriptViewport.sync(null);
      return;
    }
    transcriptViewport.sync(ctx.container()?.querySelector<HTMLElement>(".chat-scroll") ?? null);
    transcriptViewport.follow(force);
  }

  redrawHooks.add(redrawForConnector);

  return {
    state: chatState,
    hasLiveRun: () => hasLiveRun(runSlot),
    signalLiveRun: (kind, text, queuedRunId) =>
      signalLiveRun(
        runSlot,
        kind,
        text,
        {
          threadRef: chatState.threadRef,
          scopeId: chatState.scopeId,
          channelName: chatState.contextName,
        },
        queuedRunId,
      ),
    stopLiveRun,
    isStopping: () => runSlot.stopGeneration === runSlot.generation,
    currentTurnOptions,
    turnRuntime: () => chatState.turnRuntime,
    newChat,
    teardown: teardownActiveChat,
    resetChatState,
    mountContinuable,
    mountReadOnly,
    attachApprovalsWhenLoaded,
    mountLoadingPane,
    mountLoadError,
    scrollToBottom: () => scrollTranscript(true),
    revealEntry: (seq: number) => {
      if (chatState.inheritedMessages.some((message) => messageEntrySeqs(message).includes(seq))) {
        chatState.inheritedExpanded = true;
        redrawTranscript();
      }
      const host = chatState.host ?? ctx.container()?.querySelector<HTMLElement>(".custom-chat");
      transcriptViewport.cancelFollow();
      const found = host ? highlightMessage(host, seq) : false;
      if (!found) {
        ctx.composer.state.error = "The linked message is unavailable or isn't visible in this conversation.";
        redrawTranscript();
      }
      return found;
    },
    drawActiveChat,
    setTranscriptWindow,
    setPins,
    setGoal,
    setTurnRuntime,
    requestBackgroundPanel,
    activePendingApprovals,
    hasUnresolvedApproval,
    resolveCommandApproval: (decision) => {
      if (chatState.agent) void approveCommand(chatState.agent, decision);
    },
    approvalSummaryView,
    notePendingSessionOnSend,
    syncPaneState: postCurrentPaneState,
    onDelivery,
    resumeIfIdle,
    redraw: () => drawActiveChat(),
    dispose,
  };
}
