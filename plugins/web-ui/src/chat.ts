import "./slack-reply";
import type { SlackReply } from "./slack-reply";
import { assistantSidebar, assistantMessage } from "./assistant-sidebar";
import { formatMessageTime } from "./message-time.ts";
import { messageEntrySeqs, highlightMessage } from "./message-link.ts";
import { appEditSlug } from "./app-edit";
import { isConnectionReturn } from "./connection-return";
import "./connect-apps";
import {
  activityDescription,
  activityLabel,
  activityGroupSummary,
  activityGroups,
  thinkingPresentation,
  sessionPresentation,
} from "./activity-presentation";
import { dismissGeneratedActivity, loadGeneratedActivities } from "./generated-activities";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Attachment } from "@earendil-works/pi-web-ui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { UserMessageWithAttachments } from "@earendil-works/pi-web-ui";
import { markdown } from "./message-markdown";
import { html, nothing, render, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { ref } from "lit/directives/ref.js";
import { guard } from "lit/directives/guard.js";
import {
  Activity,
  Ban,
  BookOpen,
  Search,
  Brain,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  Copy,
  FileImage,
  Files,
  GitFork,
  Link2,
  Maximize2,
  MessageSquare,
  Paperclip,
  Pause,
  Pencil,
  Pin,
  Radar,
  RefreshCw,
  Target,
  Rocket,
  ScrollText,
  SquareTerminal as Terminal,
  TriangleAlert,
  Wrench,
  X,
  type IconNode,
} from "lucide";
import {
  continuableMessages,
  hasRecordedRunReply,
  messagesWithStreaming,
  userItemMessage,
  appendConsumedSteers,
  withBase,
  type SessionPin,
  activeRunForThread,
  api,
  approvalBlocksComposer,
  createRunSlot,
  hasLiveRun,
  requestStop,
  resumeAnchor,
  runIsTerminal,
  signalLiveRun,
  attachPendingApprovals,
  itemsToMessages,
  fetchItem,
  fetchTranscript,
  fetchSessionApprovals,
  currentEarlierCount,
  forkOriginDetails,
  forkCutSeq,
  forkSession,
  cancelSessionGoal,
  inheritedRefreshItems,
  inheritedTranscript,
  loadInheritedTranscript,
  makeCoreStreamFn,
  makeOpenerStreamFn,
  makeRunResumeStreamFn,
  resolveApproval,
  unresolvedApprovals,
  type RunPoll,
  TAIL_TURNS,
  type ApprovalDecision,
  type AssistantWork,
  type CoreSession,
  type DeliveredFile,
  type HistorySystemNote,
  type HistoryApprovalDecision,
  type PendingApproval,
  type SessionBackgroundOutput,
  type SessionBackgroundView,
  type SubagentMailRef,
  type TurnOptions,
  type TranscriptPage,
  type TurnRuntime,
  type WorkBlock,
  fileContentUrl,
  onChatPrefsChange,
  pinLatestPrompt,
  switchedDefault,
} from "./core-bridge";
import {
  buildTimeline,
  rowArgs,
  rowTool,
  toolBody,
  messageWorkTimeline,
  workTimelineSegments,
  streamedAnswer,
  currentTextPhase,
  postSpeechText,
  toolCategory,
  toolRowKind,
  sessionToolView,
  type TimelineItem,
  type ToolPayload,
  type ToolRowModel,
} from "./timeline";
import { activityItems, type Item } from "./items";
import "./slack-setup";
import { connectorCard, connectorLinksIn, setupContent, stripConnectorLinks } from "./connector-link";
import type { ConnectorLink } from "./connector-link";
import { deepLinkPath, sessionLink, UI_BASE } from "./deep-link";
import type { ChatSurface, ConvCtx } from "./conv-types";
import { errMessage, swallow } from "../../chassis/src/errors";
import { showStateError } from "./error-banner";
import { splitLinks } from "./linkify";
import { slackWireToPlain, splitSlackWire, stripSlackDirectives } from "./slack-text";
import { installMarkdownSanitizer } from "./markdown-sanitize";
import { transcriptModel, defaultEffortForModel } from "./model-options";
import {
  attachmentGallery,
  avatarTpl,
  brandMark,
  brandName,
  browserRenderableImage,
  chipBadge,
  copyText,
  formatBytes,
  relTime,
  sheenLabel,
  waveLoader,
  workingWave,
} from "./ui";
import { icon } from "./icons";
import { appState, renderSidebarTop, switchView, syncUrlFromState } from "./shell";
import { contextsState, scopeTitle } from "./contexts";
import { openProjectPage, scopeToolCount, sessionTopbarTpl, setScopedSession } from "./session-scope";
import {
  addPendingSession,
  onSessionDragStart,
  endSessionDrag,
  dropPendingSession,
  replacePendingSession,
  groupDmTitle,
  refreshSessions,
  renderList,
  sessionsState,
  sessionSlackUrl,
  openSession,
  syncWorkingPulse,
} from "./sessions";
import {
  backgroundLabel,
  clearWorking,
  conversationBackground,
  cronRowMeta,
  isAbandonedNewChat,
  shouldStartProactiveOpener,
  markWorking,
  surfaceOf,
  watchActivityLabel,
} from "./session-list";
import { liveTurnThreadRef } from "./working-dot";
import { goalElapsedLabel, goalObjectiveLabel, goalWorkedLabel, type GoalStripState } from "./goal-strip";
import {
  ackKey,
  peekLines,
  subagentRows,
  subagentSummary,
  visibleSubagents,
  type PeekLine,
  type SubagentRow,
} from "./subagent-activity";
import { newChatDraftKey, saveDraft, storedDraft } from "./drafts";
import { createForkOriginController, forkOriginView } from "./fork-origin";
import { base64ToBytes } from "./paste-text";
import { tip } from "./tooltip";
import { goalWorked, workSeconds, workedLabel } from "./work-duration";
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
type JobOutput = { text: string; cursor: number; state: "running" | "exited"; exitCode?: number };
type MessageFields = Partial<{
  role: string;
  opener: boolean;
  resumeAnchor: boolean;
  steered: boolean;
  subagentMail: SubagentMailRef;
  sendFailure: string;
  edited: boolean;
  deleted: boolean;
  approvalDecision: string;
  speaker: string;
  speakerId: string;
  timestamp: number;
  entrySeq: number;
}>;
const GENERIC_DETAIL_KEYS =
  "command path query pattern glob url name action file filename database filter repository resource title".split(" ");

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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  const transcriptViewport = createTranscriptViewport({ pinPrompt: pinLatestPrompt });
  const stopPrefsWatch = onChatPrefsChange(() => transcriptViewport.refresh());
  let preserveConnectionScroll = isConnectionReturn();
  let connectionReturnMessageCount: number | null = null;
  const transcriptFetcher = dependencies.fetchTranscript ?? fetchTranscript;
  const sessionOpener = dependencies.openSession ?? openSession;

  const goalCancels = new Map<string, "pending" | "done">();
  const freshWindow = () => ({ transcriptAnchorSeq: null, earlierCount: 0, loadingEarlier: false });
  const freshView = () => ({ ...freshWindow(), inheritedExpanded: false, pins: [], goal: null, turnRuntime: null });
  const chatState = {
    agent: null as Agent | null,
    host: null as HTMLElement | null,
    threadRef: null as string | null,
    sessionId: null as string | null,
    scopeId: null as string | null,
    contextName: null as string | null,
    rememberedThreadRef: null as string | null,
    rememberedSessionId: null as string | null,
    rememberedScopeId: null as string | null,
    rememberedContextName: null as string | null,
    liveWork: null as WorkBlock | null,
    goal: null as GoalStripState | null,
    turnRuntime: null as TurnRuntime | null,
    pendingSend: null as string | null,
    normalStreamFn: null as Agent["streamFn"] | null,
    onWork: null as ((work: WorkBlock) => void) | null,
    resolvingApprovals: new Set<string>(),
    transcriptAnchorSeq: null as number | null,
    earlierCount: 0,
    loadingEarlier: false,
    forkSession: null as CoreSession | null,
    inheritedMessages: [] as AgentMessage[],
    inheritedExpanded: false,
    inheritedLoaded: false,
    pins: [] as SessionPin[],
    pinsExpanded: false,
    labelSpeakers: false,
    assistantSpeakerLabel: "",
  };

  const inlineSteers = new Map<number, { message: AgentMessage; index: number }>();
  const steerMessageCache = new WeakMap<WorkBlock["activity"], Array<{ seq: number; message: AgentMessage }>>();

  function prepareMessageRows(messages: AgentMessage[]): void {
    inlineSteers.clear();
    const messageIndices = new Map(messages.map((message, index) => [(message as MessageFields).entrySeq, index]));
    for (const message of messages) {
      const activity = (message as AssistantWork).work?.activity;
      if (!activity) continue;
      let steers = steerMessageCache.get(activity);
      if (!steers) {
        steers = activityItems(activity).flatMap((item) => {
          if (item.kind !== "SteeringMessage") return [];
          const user = userItemMessage(item);
          return user ? [{ seq: item.seq, message: user as AgentMessage }] : [];
        });
        steerMessageCache.set(activity, steers);
      }
      for (const steer of steers) {
        const index = messageIndices.get(steer.seq);
        inlineSteers.set(steer.seq, {
          message: index === undefined ? steer.message : messages[index]!,
          index:
            index === undefined ? -1 : index - (chatState.inheritedExpanded ? chatState.inheritedMessages.length : 0),
        });
      }
    }
    updateSpeakerLabels([...messages, ...[...inlineSteers.values()].map((steer) => steer.message)]);
  }

  function updateSpeakerLabels(messages: AgentMessage[]): void {
    const names = new Set<string>();
    for (const m of messages) {
      const { role, speaker } = m as MessageFields;
      if (role === "user" && typeof speaker === "string" && speaker.trim()) names.add(speaker.trim());
    }
    const viewer = appState.me?.displayName?.trim().toLowerCase();
    chatState.labelSpeakers = names.size > 1 || (Boolean(viewer) && [...names].some((n) => n.toLowerCase() !== viewer));
    chatState.assistantSpeakerLabel = chatState.labelSpeakers ? brandName() : "";
  }

  function speakerLabelFor(message: AgentMessage): string | undefined {
    if (!chatState.labelSpeakers) return undefined;
    const speaker = (message as MessageFields).speaker;
    return typeof speaker === "string" && speaker.trim() ? speaker.trim() : undefined;
  }

  function speakerMember(message: AgentMessage): { principalId: string; avatarUrl?: string } | undefined {
    const speakerId = (message as MessageFields).speakerId;
    if (!speakerId) return undefined;
    const project = contextsState.list.find((c) => c.scopeId === chatState.scopeId)?.project;
    return project?.members.find((m) => m.principalId === speakerId);
  }

  function speakerLabelTpl(speaker: string | undefined, message: AgentMessage): TemplateResult | typeof nothing {
    if (!speaker) return nothing;
    const member = speakerMember(message);
    return html`<div class="speaker-label">
      ${avatarTpl({ key: member?.principalId ?? speaker, name: speaker, avatarUrl: member?.avatarUrl })}<span
        title=${speaker}
        >${speaker.split(/\s+/, 1)[0]!.toLowerCase()}</span
      >
    </div>`;
  }
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
  let liveWorkExpanded = false;
  const openThinking = new Set<string>();

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
    openThinking.clear();
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
    let titlePollStarted = false;
    agent.subscribe((e) => {
      if (!titlePollStarted && agent.state.isStreaming) {
        titlePollStarted = true;
        const row = sessionsState.list.find((r) => r.threadRef === threadRef);
        if (!row?.title?.trim()) void settleNewSessionTitle(agent, threadRef);
      }
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
        const wasUnsaved = agent === chatState.agent && chatState.sessionId === null;
        await refreshSessions({ silent: true }).catch(() => {});
        if (!detachedAgents.has(agent)) {
          sessionsState.list = clearWorking(sessionsState.list, threadRef);
          renderList();
        }
        if (agent !== chatState.agent) return;
        adoptActiveSessionFromList(agent);
        await refreshTranscriptFromItems(agent);
        void ctx.composer.refreshRuntimeSelection(scopeId, agent, true);
        void followNextQueuedRun(agent, threadRef, normalStreamFn, onWork);
        if (wasUnsaved && chatState.sessionId) void settleNewSessionTitle(agent, threadRef);
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
            toggle: () => void forkOriginController.toggle().catch(() => {}),
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
        .catch(() => {});
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
        await refreshSessions({ silent: true }).catch(() => {});
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

  async function settleNewSessionTitle(agent: Agent, threadRef: string): Promise<void> {
    const titled = (): boolean => {
      const s = sessionsState.list.find((row) => row.threadRef === threadRef);
      return Boolean(s?.title && s.title.trim());
    };
    if (titled()) return;
    for (const delay of [1200, 1800, 2400, 3600, 4800, 6400, 8000, 8000]) {
      await sleep(delay);
      if (agent !== chatState.agent || chatState.threadRef !== threadRef) return;
      await refreshSessions({ silent: true }).catch(() => {});
      if (titled()) return;
    }
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
              ${pinnedStrip()}
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

  function linkifiedText(text: string): TemplateResult {
    return html`${splitLinks(text).map((seg) =>
      seg.kind === "link"
        ? html`<a href=${seg.href} target="_blank" rel="noreferrer noopener">${seg.href}</a>`
        : seg.text,
    )}`;
  }

  function pinText(pin: SessionPin): TemplateResult {
    return linkifiedText(pin.text ?? pin.preview ?? `entry #${pin.entrySeq}`);
  }

  function pinnedStrip(): TemplateResult | typeof nothing {
    const pins = chatState.pins;
    if (!pins.length) return nothing;
    const expanded = chatState.pinsExpanded;
    const first = pins[0]!;
    return html`<div class="pinned-strip ${expanded ? "expanded" : "collapsed"}">
      <div class="pinned-strip-head" @click=${togglePins}>
        ${icon(Pin, 13)}<span class="pinned-strip-count">${pins.length}</span>
        ${
          expanded
            ? html`<span class="pinned-strip-label">Pinned</span>`
            : html`<span class="pinned-strip-peek">${pinText(first)}</span>`
        }
        <button class="pinned-strip-toggle" aria-expanded=${expanded} title=${expanded ? "Collapse pins" : "Show pins"}>
          ${icon(expanded ? ChevronUp : ChevronDown, 13)}
        </button>
      </div>
      ${
        expanded
          ? pins.map(
              (p) =>
                html`<div class="pinned-item">
                  <span class="pinned-item-text">${pinText(p)}</span>
                  ${p.text && p.preview ? html`<span class="pinned-item-preview">${linkifiedText(p.preview)}</span>` : nothing}
                </div>`,
            )
          : nothing
      }
    </div>`;
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
    } catch {
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
        messages: html`${pinnedStrip()} ${inheritedHeader()} ${chatState.earlierCount > 0 ? earlierNotice() : nothing}
        ${messageContent} ${waitingSteerRows(agent)}
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
            ${pinnedStrip()}
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

  function messageRow(cls: string, index: number, seqs: number[], body: TemplateResult): TemplateResult {
    return html`<article class="message-row ${cls}" data-index=${index} data-entry-seqs=${seqs.join(" ")}>
      ${body}
    </article>`;
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
      if (ctx.inbox)
        return assistantMessage({
          role: "human",
          text: `${text}${revision ? ` (${revision})` : ""}`,
          index,
          entrySeqs: seqs.join(" "),
          before,
          after: failure,
          meta: messageMeta(message, index),
        });
      return messageRow(
        `user-row ${speaker ? "named-user-row" : ""} ${m.steered ? "steered-row" : ""}`,
        index,
        seqs,
        html`${before}
          <div
            class="message-bubble user-bubble ${m.deleted ? "deleted-bubble" : ""}"
            ?hidden=${!text.trim() && !revision}
          >
            <div class="pin-content">
              ${isReadOnlySlackView() ? slackWireBubble(text) : markdown(text)}
              ${revision ? html`<span class="revision-badge">(${revision})</span>` : nothing}
            </div>
            <button class="pin-toggle" type="button" hidden aria-expanded="false">
              <span class="pin-toggle-label">Show more</span>${icon(ChevronDown, 14)}
            </button>
          </div>
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
    if (ctx.inbox)
      return assistantMessage({
        role: "agent",
        index,
        entrySeqs: shownSeqs.join(" "),
        streaming: isStreaming,
        content: body,
        meta,
      });
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
    return connectorCard(link, connectedConnectors.has(link.provider), withReturnTo);
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
    return html`<div class="slack-wire-text" dir="auto">
      ${splitSlackWire(text).map((seg) => {
        if (seg.kind === "mention") return chip(seg.handle);
        if (seg.kind === "link")
          return html`<a class="inbox-text-link" href=${seg.href} target="_blank" rel="noreferrer noopener"
            >${seg.label}</a
          >`;
        return seg.text;
      })}
    </div>`;
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
      (chatState.liveWork?.status === "working" && !chatState.liveWork.stale) || goalTicking || subagentUi.ticking;
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

  function shouldShowWork(work: WorkBlock | null | undefined, finalText: string): work is WorkBlock {
    return Boolean(work && (messageWorkTimeline(work, finalText).length || work.pendingApprovals?.length));
  }

  let readonlyRedraw: (() => void) | null = null;

  const bgPanel = {
    requested: null as { sessionId: string | null; threadRef: string | null } | null,
    open: false,
    loading: false,
    error: "",
    detail: null as SessionBackgroundView | null,
    openJob: null as string | null,
    output: new Map<string, JobOutput>(),
    timer: null as ReturnType<typeof setInterval> | null,
    fetchSeq: 0,
    epoch: 0,
  };

  function requestBackgroundPanel(sessionId: string | null, threadRef: string | null): void {
    const mounted = sessionId ? sessionId === chatState.sessionId : threadRef === chatState.threadRef;
    if (mounted) {
      openBackgroundPanel();
      return;
    }
    bgPanel.requested = { sessionId, threadRef };
  }

  function resetBackgroundPanel(): void {
    stopBackgroundPanel();
    Object.assign(bgPanel, { loading: false, error: "", detail: null });
    bgPanel.output.clear();
    bgPanel.fetchSeq++;
    bgPanel.epoch++;
    readonlyRedraw = null;
  }

  function consumeBackgroundPanelRequest(): void {
    const req = bgPanel.requested;
    bgPanel.requested = null;
    if (!req) return;
    const matches = req.sessionId ? req.sessionId === chatState.sessionId : req.threadRef === chatState.threadRef;
    if (matches) openBackgroundPanel();
  }

  function openBackgroundPanel(): void {
    if (bgPanel.open) return;
    bgPanel.open = true;
    void refreshBackgroundDetail();
    bgPanel.timer = setInterval(() => void backgroundPanelTick(), 2_500);
    redrawTranscript();
  }

  function stopBackgroundPanel(): void {
    if (bgPanel.timer) clearInterval(bgPanel.timer);
    Object.assign(bgPanel, { timer: null, open: false, openJob: null });
  }

  function toggleBackgroundPanel(): void {
    if (!bgPanel.open) return openBackgroundPanel();
    stopBackgroundPanel();
    redrawTranscript();
  }

  async function refreshBackgroundDetail(): Promise<void> {
    const id = chatState.sessionId;
    if (!id) {
      bgPanel.detail = { jobs: [], watches: [], crons: [] };
      return;
    }
    const seq = ++bgPanel.fetchSeq;
    bgPanel.loading = !bgPanel.detail;
    try {
      const d = await api<SessionBackgroundView>(`/api/sessions/${encodeURIComponent(id)}/background`);
      if (seq !== bgPanel.fetchSeq) return;
      bgPanel.detail = d;
      bgPanel.error = "";
    } catch (e) {
      if (seq !== bgPanel.fetchSeq) return;
      bgPanel.error = errMessage(e, "Failed to load background activity.");
    } finally {
      if (seq === bgPanel.fetchSeq) {
        bgPanel.loading = false;
        redrawTranscript();
      }
    }
  }

  async function backgroundPanelTick(): Promise<void> {
    await refreshBackgroundDetail();
    if (bgPanel.openJob) await pollJobOutput(bgPanel.openJob);
    const d = bgPanel.detail;
    if (d) {
      const row = sessionsState.list.find((r) =>
        chatState.sessionId ? r.id === chatState.sessionId : r.threadRef === chatState.threadRef,
      );
      if (
        row &&
        ((row.backgroundJobs ?? 0) !== d.jobs.length ||
          (row.watches ?? 0) !== d.watches.length ||
          (row.crons ?? 0) !== d.crons.length)
      ) {
        await refreshSessions({ silent: true });
        redrawTranscript();
      }
    }
  }

  function toggleJobOutput(processId: string): void {
    bgPanel.openJob = bgPanel.openJob === processId ? null : processId;
    if (bgPanel.openJob && !bgPanel.output.has(processId)) void pollJobOutput(processId);
    redrawTranscript();
  }

  async function pollJobOutput(processId: string): Promise<void> {
    const id = chatState.sessionId;
    if (!id) return;
    const epoch = bgPanel.epoch;
    const out: JobOutput = { text: "", cursor: 0, state: "running", ...bgPanel.output.get(processId) };
    try {
      for (let i = 0; i < 8; i++) {
        const read = await api<SessionBackgroundOutput>(
          `/api/sessions/${encodeURIComponent(id)}/background/${encodeURIComponent(processId)}/output?sinceCursor=${out.cursor}`,
        );
        const text = (out.text + read.chunk).slice(-16_384);
        Object.assign(out, { text, cursor: read.cursor, state: read.state, exitCode: read.exitCode });
        if (read.chunk.length < 60_000) break;
      }
      if (epoch !== bgPanel.epoch) return;
      bgPanel.output.set(processId, out);
    } catch (e) {
      swallow("web-ui: background job output read", e);
    }
    if (epoch !== bgPanel.epoch) return;
    redrawTranscript();
  }

  function timeLeft(expiresAt: number): string {
    const mins = Math.round((expiresAt - Date.now()) / 60_000);
    if (mins <= 0) return "expiring";
    if (mins < 60) return `${mins}m left`;
    return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m left`;
  }

  function backgroundActivityStrip(): TemplateResult | typeof nothing {
    const counts = conversationBackground(sessionsState.list, chatState.sessionId, chatState.threadRef);
    const row = counts ? backgroundLabel(counts.jobs, counts.watches, counts.crons) : null;
    const live =
      bgPanel.open && bgPanel.detail
        ? backgroundLabel(bgPanel.detail.jobs.length, bgPanel.detail.watches.length, bgPanel.detail.crons.length)
        : null;
    const label = (live ?? row)?.label;
    if (!label && !bgPanel.open) return nothing;
    return html`
      <section class="bg-activity ${bgPanel.open ? "expanded" : ""}">
        <button
          type="button"
          class="bg-activity-strip"
          aria-expanded=${String(bgPanel.open)}
          @click=${toggleBackgroundPanel}
        >
          ${icon(Activity, 13)}<span class="bg-activity-label">${label ?? "Background activity"}</span>
          <span class="bg-activity-toggle">${icon(ChevronRight, 14)}</span>
        </button>
        ${bgPanel.open ? backgroundPanelBody() : nothing}
      </section>
    `;
  }

  function backgroundPanelBody(): TemplateResult {
    const d = bgPanel.detail;
    const empty = d && d.jobs.length === 0 && d.watches.length === 0 && d.crons.length === 0;
    return html`<div class="bg-panel" role="region" aria-label="Background activity">
      ${bgPanel.error ? html`<div class="bg-panel-note">${bgPanel.error}</div>` : nothing}
      ${!d && bgPanel.loading ? html`<div class="bg-panel-note">Loading…</div>` : nothing}
      ${empty && !bgPanel.error ? html`<div class="bg-panel-note">Nothing running here anymore.</div>` : nothing}
      ${d ? d.jobs.map((j) => backgroundJobRow(j)) : nothing}
      ${d ? d.watches.map((w) => backgroundWatchRow(w)) : nothing}
      ${d ? d.crons.map((c) => backgroundCronRow(c)) : nothing}
    </div>`;
  }

  function backgroundJobRow(j: SessionBackgroundView["jobs"][number]): TemplateResult {
    const open = bgPanel.openJob === j.processId;
    const out = bgPanel.output.get(j.processId);
    const status =
      out?.state === "exited"
        ? `exited${out.exitCode !== undefined ? ` (${out.exitCode})` : ""}`
        : timeLeft(j.expiresAt);
    return html`
      <div class="bg-row ${open ? "open" : ""}">
        <button
          type="button"
          class="bg-row-head"
          aria-expanded=${String(open)}
          ${tip(open ? "Hide output" : "Show live output")}
          @click=${() => toggleJobOutput(j.processId)}
        >
          ${icon(Terminal, 13)}
          ${
            j.purpose
              ? html`<span class="bg-row-cmd bg-job-purpose">${j.purpose}</span>`
              : html`<code class="bg-row-cmd">${j.command}</code>`
          }
          <span class="bg-row-meta">started ${relTime(j.startedAt)} · ${status}</span>
          <span class="bg-row-toggle">${icon(ChevronRight, 13)}</span>
        </button>
        ${open ? html`<pre class="bg-row-output">${j.purpose ? `${j.command}\n\n` : ""}${out ? out.text || "(no output yet)" : "Loading output…"}</pre>` : nothing}
      </div>
    `;
  }

  function backgroundCronRow(c: SessionBackgroundView["crons"][number]): TemplateResult {
    return html`
      <div class="bg-row watch">
        <a class="bg-row-head" href=${deepLinkPath(UI_BASE, "crons", null, null, c.id)}>
          ${icon(Clock3, 13)}
          <span class="bg-row-cmd">Cron: <bdi>${c.title ?? "scheduled task"}</bdi></span>
          <span class="bg-row-meta">${cronRowMeta(c)}</span>
        </a>
      </div>
    `;
  }

  function backgroundWatchRow(w: SessionBackgroundView["watches"][number]): TemplateResult {
    const what = w.pattern ? `output matching /${w.pattern}/` : "any new output";
    const note = w.instructions?.trim();
    return html`
      <div class="bg-row watch">
        <div class="bg-row-head static">
          ${icon(Radar, 13)}
          <span class="bg-row-cmd">Watch: wakes on ${what}${note ? ` · “${note}”` : ""}</span>
          <span class="bg-row-meta"
            >armed ${relTime(w.createdAt)} · ${watchActivityLabel(w)} · ${timeLeft(w.expiresAt)}</span
          >
        </div>
      </div>
    `;
  }

  const SUBAGENT_ACK_KEY = "qm.subagentAck";
  const subagentUi = {
    expanded: false,
    peekId: null as string | null,
    peek: null as PeekLine[] | null,
    ticking: false,
    timer: null as ReturnType<typeof setInterval> | null,
    approvals: new Map<string, PendingApproval[]>(),
    approvalsKey: "",
    acknowledged: new Set<string>(
      (() => {
        try {
          return JSON.parse(localStorage.getItem(SUBAGENT_ACK_KEY) ?? "[]") as string[];
        } catch {
          return [];
        }
      })(),
    ),
  };

  function stopSubagentPeek(): void {
    if (subagentUi.timer) clearInterval(subagentUi.timer);
    subagentUi.timer = null;
    subagentUi.peekId = null;
    subagentUi.peek = null;
  }

  async function refreshSubagentPeek(id: string): Promise<void> {
    const page = await fetchTranscript(id, { tailTurns: 1 }).catch(() => null);
    if (subagentUi.peekId !== id) return;
    subagentUi.peek = page ? peekLines(page.items) : [];
    drawActiveChat();
  }

  function toggleSubagentPeek(row: SubagentRow): void {
    const id = row.session.id;
    const same = subagentUi.peekId === id;
    stopSubagentPeek();
    if (same) return drawActiveChat();
    subagentUi.peekId = id;
    void refreshSubagentPeek(id);
    if (row.state === "working") subagentUi.timer = setInterval(() => void refreshSubagentPeek(id), 4000);
    drawActiveChat();
  }

  function acknowledgeSubagent(row: SubagentRow): void {
    subagentUi.acknowledged.add(ackKey(row));
    try {
      localStorage.setItem(SUBAGENT_ACK_KEY, JSON.stringify([...subagentUi.acknowledged].slice(-200)));
    } catch {
      return drawActiveChat();
    }
    if (subagentUi.peekId === row.session.id) stopSubagentPeek();
    drawActiveChat();
  }

  function syncSubagentApprovals(rows: readonly SubagentRow[]): void {
    const waiting = rows.filter((row) => row.state === "waiting").map((row) => row.session.id);
    const key = waiting.join(",");
    if (key === subagentUi.approvalsKey) return;
    subagentUi.approvalsKey = key;
    for (const id of subagentUi.approvals.keys()) if (!waiting.includes(id)) subagentUi.approvals.delete(id);
    for (const id of waiting)
      void fetchSessionApprovals(id).then((r) => {
        if (!subagentUi.approvalsKey.split(",").includes(id)) return;
        subagentUi.approvals.set(id, r?.approvals ?? []);
        drawActiveChat();
      });
  }

  function resolveSubagentApproval(childId: string, decision: ApprovalDecision): void {
    if (chatState.resolvingApprovals.has(decision.requestId)) return;
    chatState.resolvingApprovals.add(decision.requestId);
    ctx.composer.state.error = "";
    drawActiveChat();
    void resolveApproval(decision)
      .then(() => {
        subagentUi.approvals.set(
          childId,
          (subagentUi.approvals.get(childId) ?? []).filter((a) => a.requestId !== decision.requestId),
        );
      })
      .catch((err: unknown) => {
        ctx.composer.state.error = err instanceof Error ? err.message : "Could not send the approval.";
      })
      .finally(() => {
        chatState.resolvingApprovals.delete(decision.requestId);
        subagentUi.approvalsKey = "";
        void refreshSessions({ silent: true }).finally(() => drawActiveChat());
      });
  }

  function subagentRowTpl(row: SubagentRow): TemplateResult {
    const now = Date.now();
    const elapsed = goalElapsedLabel(row.startedAt, row.endedAt ?? now);
    const peeking = subagentUi.peekId === row.session.id;
    const approvals = unresolvedApprovals(subagentUi.approvals.get(row.session.id) ?? []);
    const title = row.session.title?.trim() || "Subagent";
    return html`<div
      class="subagent-row ${row.state} ${peeking ? "peeking" : ""}"
      style=${`--subagent-depth:${row.depth - 1}`}
    >
      <button
        type="button"
        class="subagent-row-head"
        aria-expanded=${String(peeking)}
        @click=${() => toggleSubagentPeek(row)}
      >
        ${row.state === "working" ? html`<span class="working-mark" ${ref(syncWorkingPulse)}>${workingWave()}</span>` : nothing}
        ${row.state === "waiting" ? html`<span class="awaiting-dot" aria-hidden="true"></span>` : nothing}
        ${row.state === "failed" ? html`<span class="subagent-failed-mark">${icon(TriangleAlert, 12)}</span>` : nothing}
        <span class="subagent-row-title" dir="auto">${title}</span>
        <span class="subagent-row-meta">${row.state} · ${elapsed}</span>
      </button>
      ${
        row.state === "failed"
          ? html`<button type="button" class="subagent-row-action" @click=${() => acknowledgeSubagent(row)}>
              Dismiss
            </button>`
          : nothing
      }
      <button type="button" class="subagent-row-action" @click=${() => void openSessionById(row.session.id)}>
        Open
      </button>
      ${
        approvals.length
          ? ctx.composer.composerApprovalPanel(approvals, (decision) =>
              resolveSubagentApproval(row.session.id, decision),
            )
          : nothing
      }
      ${peeking ? subagentPeekTpl() : nothing}
    </div>`;
  }

  function subagentPeekTpl(): TemplateResult {
    const lines = subagentUi.peek;
    if (!lines) return html`<div class="subagent-peek bg-panel-note">Loading…</div>`;
    if (!lines.length) return html`<div class="subagent-peek bg-panel-note">No activity yet</div>`;
    return html`<ol class="subagent-peek" aria-live="polite">
      ${lines.map(
        (line) =>
          html`<li class="subagent-peek-line ${line.kind}">
            ${line.kind === "tool" ? icon(Wrench, 11) : nothing}<span dir="auto">${line.text}</span>
          </li>`,
      )}
    </ol>`;
  }

  function subagentStrip(): TemplateResult | typeof nothing {
    const rootId = chatState.sessionId;
    if (!rootId) return nothing;
    const rows = visibleSubagents(subagentRows(sessionsState.list, rootId), subagentUi.acknowledged);
    if (subagentUi.peekId && !rows.some((row) => row.session.id === subagentUi.peekId)) stopSubagentPeek();
    syncSubagentApprovals(rows);
    subagentUi.ticking = rows.some((row) => row.state === "working" || row.state === "waiting");
    syncWorkTicker();
    if (!rows.length) return nothing;
    const single = rows.length === 1;
    const expanded = single || subagentUi.expanded || rows.some((row) => row.state === "waiting");
    const failed = rows.some((row) => row.state === "failed");
    return html`
      <section class="bg-activity subagent-activity ${expanded ? "expanded" : ""} ${failed ? "has-failed" : ""}">
        ${
          single
            ? nothing
            : html`<button
                type="button"
                class="bg-activity-strip"
                aria-expanded=${String(expanded)}
                @click=${() => {
                  subagentUi.expanded = !subagentUi.expanded;
                  if (!subagentUi.expanded) stopSubagentPeek();
                  drawActiveChat();
                }}
              >
                ${icon(Bot, 13)}<span class="bg-activity-label">${subagentSummary(rows)}</span>
                <span class="bg-activity-toggle">${icon(ChevronRight, 14)}</span>
              </button>`
        }
        ${expanded ? html`<div class="subagent-list ${single ? "single" : "bg-panel"}">${rows.map(subagentRowTpl)}</div>` : nothing}
      </section>
    `;
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

  function liveWorkStatus(agent: Agent): TemplateResult | typeof nothing {
    if (!agent.state.isStreaming && chatState.resolvingApprovals.size === 0) return nothing;
    if (runSlot.stopGeneration === runSlot.generation)
      return html`<div class="stopped-head" role="status">${icon(Ban, 13)}<span>Stop requested</span></div>`;
    const work = chatState.liveWork ?? { status: "thinking", activity: [] };
    if (work.status !== "thinking" && work.status !== "working") return nothing;
    if (currentTextPhase(work)?.phase === "final_answer" || shouldShowWork(work, "")) return nothing;
    const summary = liveWorkSummary(work);
    const expandable = Boolean(summary?.detail);
    const expanded = expandable && liveWorkExpanded;
    let title = "";
    if (expandable) title = liveWorkExpanded ? "Show less" : "Show more";
    return html`
      <section class="live-work-status ${expanded ? "expanded" : ""}" aria-live="polite">
        <button
          type="button"
          class="live-work-line ${expandable ? "" : "static"}"
          ?disabled=${!expandable}
          aria-expanded=${expandable ? String(liveWorkExpanded) : nothing}
          ${tip(title)}
          @click=${() => {
            liveWorkExpanded = !liveWorkExpanded;
            drawActiveChat();
          }}
        >
          ${summary ? html`<span class="tool-icon">${icon(summary.icon, 15)}</span>` : nothing}
          <span class="live-work-label"
            >${summary ? summary.label : sheenLabel(`Thinking${usedToolsSuffix(work)}`, true)}</span
          >
          ${summary?.detail ? html`<span class="live-work-detail">${summary.detail}</span>` : nothing}
          ${expandable ? html`<span class="live-work-toggle">${icon(ChevronRight, 14)}</span>` : nothing}
        </button>
      </section>
    `;
  }

  function liveWorkSummary(work: WorkBlock): { icon: IconNode; label: string; detail: string } | null {
    if (work.stale) {
      const active = activeToolRow(work);
      const call = toolBody(active?.call);
      const tool = active?.call?.tool ?? "";
      const verb = active ? (TOOL_META[toolCategory(active.call?.tool ?? null, call)] ?? UNKNOWN_TOOL).active : null;
      return {
        icon: RefreshCw,
        label: verb ? `${verb} interrupted, resuming…` : "Interrupted, resuming…",
        detail: active ? toolDetail(tool, call, toolBody(active.result)) : "",
      };
    }
    const active = activeToolRow(work);
    return active ? activeToolSummary(active, work) : null;
  }

  function activeToolRow(work: WorkBlock): ToolRowModel | null {
    const timeline = buildTimeline(work);
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i]!;
      if (item.kind === "tool" && toolRowKind(item.row, work.status) === "running") return item.row;
    }
    return null;
  }

  function activeToolSummary(row: ToolRowModel, work: WorkBlock): { icon: IconNode; label: string; detail: string } {
    const call = toolBody(row.call);
    const result = toolBody(row.result);
    const tool = rowTool(row) ?? "unknown";
    const meta = TOOL_META[toolCategory(rowTool(row), rowArgs(row))] ?? UNKNOWN_TOOL;
    const secs = elapsedSeconds(row.call?.createdAt) || workSeconds(work);
    const posting = postSpeechText(row, true);
    if (posting) {
      return {
        icon: MessageSquare,
        label: secs > 0 ? `Posting message for ${secs}s` : "Posting message",
        detail: firstLine(posting, 60),
      };
    }
    return {
      icon: meta.icon,
      label: secs > 0 ? `${meta.active} for ${secs}s` : meta.active,
      detail: toolDetail(tool, call, result),
    };
  }

  function elapsedSeconds(startedAt: number | null | undefined): number {
    if (typeof startedAt !== "number" || startedAt <= 0) return 0;
    return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  }

  function usedToolsSuffix(work: WorkBlock): string {
    const n = activityItems(work.activity).filter((item) => item.kind === "ToolCall").length;
    return n > 0 ? ` (used ${n} tool${n === 1 ? "" : "s"})` : "";
  }

  function workLabel(work: WorkBlock): string {
    if (work.stale && (work.status === "thinking" || work.status === "working")) return "Interrupted, resuming…";
    if (currentTextPhase(work)?.phase === "final_answer") return workedLabel("Worked", workSeconds(work));
    if (work.status === "thinking") return "Thinking";
    const secs = workSeconds(work);
    return workedLabel(work.status === "working" ? "Working" : "Worked", secs);
  }

  function timelineKey(item: TimelineItem): string {
    if (item.kind === "tool") return `tool:${item.row.call?.seq ?? item.row.result?.seq ?? item.row.approval?.seq}`;
    if (item.kind === "approval") return `approval:${item.approval.requestId}`;
    if (item.kind === "thinking") return `thinking:${item.step ?? item.seq}`;
    return `${item.kind}:${item.item.seq}`;
  }

  function workBlock(
    work: WorkBlock,
    isStreaming: boolean,
    text: string,
    baseline: string,
    stopped = false,
  ): TemplateResult {
    const active =
      isStreaming &&
      currentTextPhase(work)?.phase !== "final_answer" &&
      (work.status === "working" || work.status === "thinking");
    const segments = workTimelineSegments(messageWorkTimeline(work, active ? "" : text));
    return html`${segments.map((segment, index) => {
      const steer = segment[0];
      if (steer?.kind === "steer") return renderTimelineItem(steer, work);
      const last = index === segments.length - 1;
      const replies: string[] = [];
      const timeline = segment.filter((item) => {
        const speech = item.kind === "tool" ? postSpeechText(item.row) : null;
        if (speech === null) return true;
        replies.push(speech);
        return false;
      });
      const tail = active && last ? streamedAnswer(text, work) : "";
      const stopping = isStreaming && runSlot.stopGeneration === runSlot.generation;
      const animating = active && last && !stopping;
      let label = last ? workLabel(work) : "Worked";
      if (stopping && last) label = "Stop requested";
      if (stopped && last) label = `You stopped after ${goalElapsedLabel(0, workSeconds(work) * 1000)}`;
      if (
        timeline.length === 1 &&
        !tail.trim() &&
        !(last && (stopped || stopping || work.stale || work.pendingApprovals?.length))
      )
        return html`${renderTimelineItem(timeline[0]!, work)}${replies.map((reply) => html`<div class="streaming-text" dir="auto">${markdown(reply)}</div>`)}`;
      let fold =
        timeline.length || tail.trim() || (last && (active || work.pendingApprovals?.length))
          ? html`<details
              class=${stopped && last ? "stopped-work" : `work work-fold work-${work.status}`}
              ?open=${last && (active || !!work.pendingApprovals?.length)}
            >
              <summary class=${stopped && last ? "stopped-head" : "work-head"}>
                ${sheenLabel(label, animating)}<span class="activity-chevron">${icon(ChevronRight, 14)}</span>
              </summary>
              ${stopped && last ? nothing : html`<div class="work-divider"></div>`}
              <div class="work-rows">
                ${guard(
                  [
                    work,
                    work.activity,
                    work.reasoning,
                    work.status,
                    work.stale,
                    work.pendingApprovals,
                    active,
                    active ? "" : text,
                    sessionsState.list,
                    index,
                    last,
                  ],
                  () =>
                    repeat(
                      activityGroups(timeline),
                      (items) => timelineKey(items[0]!),
                      (items) => {
                        if (items.length === 1 || items[0]?.kind === "text") return renderTimelineItem(items[0]!, work);
                        const summary = activityGroupSummary(items, work.status);
                        const groupIcon = { read: BookOpen, search: Search, execute: Terminal, other: Wrench }[
                          summary.category
                        ];
                        return html`<details
                          class="activity-group work-fold"
                          ?open=${(active && last) || summary.attention}
                        >
                          <summary class="work-head">
                            ${icon(groupIcon, 15)}<span>${summary.label}</span
                            ><span class="activity-chevron">${icon(ChevronRight, 14)}</span>
                          </summary>
                          <div class="work-rows">
                            ${repeat(items, timelineKey, (item) => renderTimelineItem(item, work))}
                          </div>
                        </details>`;
                      },
                    ),
                )}
                ${tail.trim() ? html`<div class="work-said streaming-text ${animating ? "live-stream" : ""}">${markdown(tail, animating, streamedAnswer(baseline, work))}</div>` : nothing}
              </div>
            </details>`
          : nothing;
      if (stopped && last && fold === nothing) fold = html`<div class="stopped-head">${label}</div>`;
      return html`${fold}${replies.map((reply) => html`<div class="streaming-text" dir="auto">${markdown(reply)}</div>`)}`;
    })}`;
  }

  function approvalSummaryView(a: PendingApproval, expanded = false): TemplateResult {
    const summary = firstLine(a.command, 80);
    const truncated = a.command.includes("\n") || a.command.length > 80;
    return html`
      <div class="approval-head">
        <span class="approval-title">Approval needed</span>
        ${a.reason ? html`<span class="approval-reason-badge">${a.reason}</span>` : nothing}
      </div>
      ${a.summary ? html`<div class="approval-summary-line">${a.summary}</div>` : nothing}
      ${a.purpose ? html`<div class="approval-why"><span class="approval-why-label">Why</span>${a.purpose}</div>` : nothing}
      ${
        expanded
          ? html`<code class="approval-cmd approval-cmd-full">${a.command}</code>`
          : html`<code class="approval-summary" ${tip(a.command)}>${summary}</code>`
      }
      ${
        a.matched
          ? html`<div class="approval-match">
              <span class="approval-match-label">Triggered by</span
              ><code class="approval-match-snippet">${a.matched}</code>
            </div>`
          : nothing
      }
      ${
        !expanded && truncated
          ? html`<details class="approval-full">
              <summary>Show full command</summary>
              <code class="approval-cmd">${a.command}</code>
            </details>`
          : nothing
      }
    `;
  }

  function approvalMarker(a: PendingApproval): TemplateResult {
    return html`<div class="approval-card inline-approval-marker">
      <div class="approval-text">${approvalSummaryView(a)}</div>
    </div>`;
  }

  function waitingSteerRows(agent: Agent): TemplateResult[] {
    return ctx.composer.waitingSteers(agent).map(
      (q) =>
        html`<div class="inline-steer waiting-steer" aria-busy="true">
          ${chatMessage(
            {
              role: "user",
              content: q.text || (q.hasAttachments ? "(files)" : ""),
              steered: true,
            } as unknown as AgentMessage,
            -1,
            false,
            true,
          )}
        </div>`,
    );
  }

  function renderTimelineItem(item: TimelineItem, work: WorkBlock): TemplateResult {
    const status = work.status;
    const stale = work.stale === true;
    if (item.kind === "steer") {
      const steer = inlineSteers.get(item.item.seq);
      return html`<div class="inline-steer">
        ${steer ? chatMessage(steer.message, steer.index, false, true) : nothing}
      </div>`;
    }
    if (item.kind === "thinking") {
      const thought = thinkingPresentation(item.text);
      const key = timelineKey(item);
      return html`<details
        class="thinking-row"
        ?open=${openThinking.has(key)}
        @toggle=${(event: Event) => {
          if ((event.currentTarget as HTMLDetailsElement).open) openThinking.add(key);
          else openThinking.delete(key);
        }}
      >
        <summary class="thinking-summary">
          <span class="tool-icon">${icon(Brain, 15)}</span><span class="thinking-title">${thought.title}</span>
          <span class="activity-chevron">${icon(ChevronRight, 14)}</span>
        </summary>
        <div class="thinking-body">${markdown(thought.body)}</div>
      </details>`;
    }
    if (item.kind === "text") return html`<div class="work-message">${markdown(item.item.text ?? "")}</div>`;
    if (item.kind === "approval") return approvalMarker(item.approval);
    return toolRow(item.row, work, status, stale);
  }

  const toolMeta = (icon: IconNode, active: string, done: string, attempted: string) => ({
    icon,
    active,
    done,
    attempted,
  });
  const TOOL_META: Record<string, ReturnType<typeof toolMeta>> = {
    execute: toolMeta(Terminal, "Running command", "Ran command", "Tried command"),
    read: toolMeta(BookOpen, "Reading file", "Read file", "Tried reading file"),
    skill: toolMeta(BookOpen, "Loading skill", "Loaded skill", "Tried loading skill"),
    write: toolMeta(Pencil, "Writing file", "Wrote file", "Tried writing file"),
    publish: toolMeta(Rocket, "Publishing", "Published", "Tried publishing"),
    recall: toolMeta(Brain, "Searching memory", "Searched memory", "Tried searching memory"),
    memory: toolMeta(Brain, "Using memory", "Used memory", "Tried using memory"),
    history: toolMeta(ScrollText, "Searching history", "Searched history", "Tried searching history"),
    background: toolMeta(Terminal, "Managing process", "Managed process", "Tried managing process"),
  };
  const UNKNOWN_TOOL = toolMeta(Wrench, "Working", "Finished step", "Tried step");

  function toolName(tool: string): string {
    const parts = tool.split(/__|[/:.]/).filter(Boolean);
    const meaningful = ["mcp", "connector"].includes(parts[0]?.toLowerCase() ?? "") ? parts.slice(1) : parts;
    const names: Record<string, string> = { github: "GitHub", api: "API", url: "URL", id: "ID" };
    return meaningful
      .flatMap((part) => part.split(/[-_]/))
      .filter(Boolean)
      .map((part) => names[part.toLowerCase()] ?? part[0]?.toUpperCase() + part.slice(1))
      .join(" ");
  }

  const SUBAGENT_MAIL_NOTES: Record<string, string> = {
    final_answer: "finished",
    no_reply: "finished without a reply",
    awaiting_input: "needs an approval",
    errored: "failed",
    refused: "was refused",
  };

  function subagentChip(title: string, sessionId?: string): TemplateResult {
    const session = sessionsState.list.find((row) => row.id === sessionId);
    const inner = html`<span dir="auto">${session?.title || title}</span>`;
    if (!sessionId) return html`<span class="subagent-chip">${inner}</span>`;
    return html`<button
      class="subagent-chip"
      type="button"
      title="Open subagent · Drag to the sidebar to make a top-level session"
      draggable=${session ? "true" : "false"}
      @dragstart=${(e: DragEvent) => {
        if (session) onSessionDragStart(e, session);
        else e.preventDefault();
      }}
      @dragend=${endSessionDrag}
      @click=${(e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        void openSessionById(sessionId);
      }}
    >
      ${inner}
    </button>`;
  }

  function firstLine(s: string, max?: number): string {
    const line = s.split("\n")[0] ?? "";
    return max !== undefined && line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }

  function toolDetail(tool: string, call: ToolPayload, result: ToolPayload): string {
    if (typeof call.purpose === "string" && call.purpose.trim()) return call.purpose.trim();
    const query = call.query ?? result.query ?? "";
    const counted =
      result.count === undefined ? query : `${query} · ${result.count} result${result.count === 1 ? "" : "s"}`;
    switch (toolCategory(tool, { ...result, ...call })) {
      case "execute":
        return call.command ? firstLine(call.command) : "";
      case "read":
        return call.path ?? result.path ?? "";
      case "skill": {
        const name = call.name ?? result.name ?? "";
        const path = call.path ?? result.path ?? "SKILL.md";
        return path === "SKILL.md" ? name : `${name}/${path}`;
      }
      case "write": {
        const path = call.path ?? result.path ?? "";
        const bytes = result.bytes ?? call.bytes;
        return bytes !== undefined ? `${path} · ${formatBytes(bytes)}` : path;
      }
      case "publish":
        return result.url ?? result.name ?? call.name ?? "";
      case "recall":
      case "history": {
        const seq = call.seq ?? result.seq;
        if (seq !== undefined) return result.found === false ? `entry #${seq} · not found` : `entry #${seq}`;
        return counted;
      }
      case "memory": {
        const detail = result.count === undefined && result.added !== undefined ? `${result.added} saved` : counted;
        return [call.action ?? result.action ?? "", detail].filter(Boolean).join(" ");
      }
      case "background": {
        const action = call.action ?? result.action ?? "";
        const target = call.command ? firstLine(call.command, 48) : (call.process_id ?? call.monitor_id ?? "");
        return [action, target].filter(Boolean).join(" ");
      }
      default:
        return genericToolDetail(call, result);
    }
  }

  function genericToolDetail(call: ToolPayload, result: ToolPayload): string {
    for (const source of [call, nestedToolInput(call), result, nestedToolInput(result)]) {
      for (const key of GENERIC_DETAIL_KEYS) {
        const value = (source as Record<string, unknown>)[key];
        if (typeof value === "string" && value.trim()) return firstLine(value.trim());
      }
    }
    return "";
  }

  function nestedToolInput(payload: ToolPayload): ToolPayload {
    const record = payload as Record<string, unknown>;
    for (const key of ["input", "arguments", "args"]) {
      const value = record[key];
      if (value && typeof value === "object" && !Array.isArray(value)) return value as ToolPayload;
    }
    return {};
  }

  function toolPayloadText(payload: ToolPayload): string {
    const hidden = new Set(["tool", "callId", "workStartedAt", "workFinishedAt", "isError", "retrySafe", "rerun"]);
    const entries = Object.entries(payload as Record<string, unknown>).filter(
      ([key, value]) => !hidden.has(key) && value !== undefined,
    );
    if (!entries.length) return "";
    if (entries.length === 1 && typeof entries[0]![1] === "string") return entries[0]![1] as string;
    return JSON.stringify(Object.fromEntries(entries), null, 2);
  }

  function toolPayloadCard(label: string | null, text: string, loadFull?: () => void): TemplateResult | typeof nothing {
    if (!text) return nothing;
    return html`<div class="tool-payload-card">
      ${label ? html`<div class="tool-payload-label">${label}</div>` : nothing}
      <pre class="tool-payload-body">${text}</pre>
      ${loadFull ? html`<div class="code-card-foot"><button class="show-full-btn" type="button" @click=${loadFull}>Show full ${label?.toLowerCase() ?? "command"}</button></div>` : nothing}
    </div>`;
  }

  function toolDisclosure(
    tool: string,
    call: ToolPayload,
    result: ToolPayload,
    work: WorkBlock,
    row: ToolRowModel,
  ): TemplateResult {
    const execution = toolCategory(tool, { ...result, ...call }) === "execute";
    const input = execution ? (call.command ?? "") : toolPayloadText(call);
    const text = row.result?.text ?? null;
    const output = execution ? "" : toolPayloadText({ ...result, ...(text !== null ? { result: text } : {}) });
    return html`<div class="tool-disclosure">
      ${toolPayloadCard(execution ? null : "Input", input, row.call?.truncated ? () => void loadFullItem(work, row.call!) : undefined)}
      ${toolPayloadCard("Result", output, row.result?.truncated ? () => void loadFullItem(work, row.result!) : undefined)}
    </div>`;
  }

  function toolRow(row: ToolRowModel, work: WorkBlock, status: WorkBlock["status"], stale = false): TemplateResult {
    if (row.approval) {
      const p = toolBody(row.approval);
      return html`<div class="tool-row tool-approval">
        <span class="tool-icon">${icon(Wrench, 13)}</span>
        <span class="tool-label"
          >Approval
          needed${p.reason ? html` <span class="tool-detail">${firstLine(p.reason, 90)}</span>` : nothing}</span
        >
      </div>`;
    }
    const call = toolBody(row.call);
    const result = toolBody(row.result);
    const tool = rowTool(row) ?? "unknown";
    const knownMeta = TOOL_META[toolCategory(tool, rowArgs(row))];
    const meta = knownMeta ?? UNKNOWN_TOOL;
    const name = toolName(tool) || "Tool";
    const kind = toolRowKind(row, status);
    let label = knownMeta ? meta.attempted : `Tried ${name}`;
    if (kind === "approval") label = row.pending ? "Approval needed" : "Approval requested";
    else if (kind === "running") {
      const active = knownMeta ? meta.active : name;
      label = stale ? `${active} — interrupted` : active;
    } else if (kind === "ok") label = knownMeta ? meta.done : name;
    else if (kind === "failed") label = `Failed ${name}`;
    let why = "";
    if (kind === "approval") why = firstLine(result.reason ?? "", 90);
    else if (kind === "failed") why = firstLine(result.error ?? result.reason ?? "", 90);
    const base = kind === "approval" ? "" : toolDetail(tool, call, result);
    const attempts = row.attempts && row.attempts > 1 ? `${row.attempts} attempts` : "";
    const detail = [base, why, attempts].filter(Boolean).join(" · ");
    const semantic = activityLabel(row, status);
    const visible = semantic
      ? [semantic, why, attempts, stale && kind === "running" ? "interrupted" : ""].filter(Boolean).join(" · ")
      : [label, detail].filter(Boolean).join(" ");
    const description = activityDescription(row);
    const session = sessionPresentation(row, status);
    const sessionView = session ? sessionToolView(row, sessionsState.list) : null;
    const sessionDetail = [sessionView?.detail, session?.preview].filter(Boolean).join(" · ");
    const sessionText = session ? [session.label, sessionDetail].filter(Boolean).join(" ") : null;
    const rowIcon = session
      ? Bot
      : { search: Search, read: BookOpen, execute: meta.icon, other: meta.icon }[description.category];
    const classes = ["tool-row", `tool-${kind}`].join(" ");
    const head = html`<span class="tool-icon">${icon(rowIcon, 15)}</span>
      ${session && sessionView?.chipTitle ? html`<span class="session-action">${session.label}</span>${subagentChip(sessionView.chipTitle, sessionView.sessionId)}${sessionDetail ? html`<span class="tool-label session-message" title=${sessionDetail}>${sessionDetail}</span>` : nothing}` : html`<span class="tool-label" title=${sessionText ?? (detail ? `${label}: ${detail}` : label)}>${sessionText ?? visible}</span>`}`;
    if (!row.call && !row.result) return html`<div class="${classes}">${head}</div>`;
    const renderDisclosure = (details: HTMLDetailsElement): void => {
      const host = details.querySelector<HTMLElement>(".tool-disclosure-host");
      if (host) render(details.open ? toolDisclosure(tool, call, result, work, row) : nothing, host);
    };
    return html`<details
      class="${classes} tool-expandable"
      @toggle=${(event: Event) => renderDisclosure(event.currentTarget as HTMLDetailsElement)}
    >
      <summary class="tool-summary">${head}<span class="activity-chevron">${icon(ChevronRight, 14)}</span></summary>
      <div
        class="tool-disclosure-host"
        ${ref((element) => {
          const details = element?.closest<HTMLDetailsElement>("details");
          if (details) renderDisclosure(details);
        })}
      ></div>
    </details>`;
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

  function inlineHtmlName(name?: string, mimeType?: string): boolean {
    if (mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "text/html") return true;
    return /\.html?$/i.test(name ?? "");
  }

  const dismissedHtmlPreviews = new Set<string>();

  function inlineHtmlFrame(name: string, src: string, size?: number, href?: string): TemplateResult {
    const key = `${chatState.sessionId ?? "new"}:${href ?? src}:${name}`;
    const chip = chipBadge(Paperclip, name, size, href, false);
    if (dismissedHtmlPreviews.has(key)) return chip;
    return html`<span class="file-html-unfurl"
      ><span class="file-html-header"
        ><span dir="auto">${name}</span
        ><button
          type="button"
          aria-label="Dismiss ${name} preview"
          title="Dismiss preview"
          @click=${() => {
            dismissedHtmlPreviews.add(key);
            redrawTranscript();
          }}
        >
          ${icon(X, 14)}
        </button></span
      ><iframe sandbox="allow-scripts" src=${src} title=${name} loading="lazy"></iframe>${chip}</span
    >`;
  }

  interface UserAttachmentView {
    fileName: string;
    mimeType?: string;
    size?: number;
    content?: string;
    artifactId?: string;
  }

  const localAttachmentUrls = new Map<UserAttachmentView, string>();

  function localContentUrl(a: UserAttachmentView): string | undefined {
    if (!a.content) return undefined;
    const cached = localAttachmentUrls.get(a);
    if (cached) return cached;
    try {
      const b64 = a.content.startsWith("data:") ? (a.content.split(",")[1] ?? "") : a.content;
      const bytes = base64ToBytes(b64);
      const blob = new Blob([bytes as BlobPart], { type: a.mimeType || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      localAttachmentUrls.set(a, url);
      return url;
    } catch {
      return undefined;
    }
  }

  let attachmentPeek: HTMLElement | null = null;

  function unpeekAttachment(): void {
    attachmentPeek?.remove();
    attachmentPeek = null;
    document.removeEventListener("scroll", unpeekAttachment, true);
  }

  function peekAttachment(e: Event): void {
    const link = e.currentTarget as HTMLElement | null;
    const img = link?.querySelector("img");
    if (!link || !img || getComputedStyle(link).getPropertyValue("--attachment-compact").trim() !== "1") return;
    unpeekAttachment();
    const bounds = (link.closest(".split-pane-content") ?? document.documentElement).getBoundingClientRect();
    const anchor = link.getBoundingClientRect();
    const pad = 12;
    const chrome = 12;
    const maxW = Math.max(80, Math.min(360, bounds.width - pad * 2 - chrome));
    const maxH = Math.max(60, Math.min(320, bounds.height - anchor.height - pad * 3 - chrome));
    const natural = { w: img.naturalWidth || maxW, h: img.naturalHeight || maxH };
    const scale = Math.min(maxW / natural.w, maxH / natural.h, 1);
    const w = Math.round(natural.w * scale);
    const h = Math.round(natural.h * scale);
    const copy = Object.assign(document.createElement("img"), { src: img.currentSrc || img.src, alt: "" });
    Object.assign(copy.style, { width: `${w}px`, height: `${h}px` });
    const peek = Object.assign(document.createElement("div"), { className: "attachment-peek" });
    peek.setAttribute("aria-hidden", "true");
    peek.append(copy);
    const below = anchor.bottom + 8;
    const top =
      below + h + chrome <= bounds.bottom - pad ? below : Math.max(bounds.top + pad, anchor.top - 8 - h - chrome);
    const left = Math.max(bounds.left + pad, Math.min(anchor.right - w - chrome, bounds.right - pad - w - chrome));
    Object.assign(peek.style, { top: `${top}px`, left: `${left}px` });
    document.body.append(peek);
    attachmentPeek = peek;
    document.addEventListener("scroll", unpeekAttachment, true);
  }

  function userAttachmentBadge(a: UserAttachmentView): TemplateResult {
    const artifactHref = a.artifactId ? fileContentUrl(a.artifactId, a.fileName) : undefined;
    if (a.mimeType?.startsWith("image/")) {
      const dataUrl =
        a.content && (a.content.startsWith("data:") ? a.content : `data:${a.mimeType};base64,${a.content}`);
      const href = artifactHref ?? localContentUrl(a) ?? dataUrl;
      if (href && browserRenderableImage(a.mimeType)) {
        return html`<a
          class="file-image"
          href=${href}
          target="_blank"
          rel="noreferrer"
          ${tip(a.fileName)}
          @mouseenter=${peekAttachment}
          @mouseleave=${unpeekAttachment}
          @focus=${peekAttachment}
          @blur=${unpeekAttachment}
          ><img src=${href} alt=${a.fileName} loading="lazy" /><span class="file-image-name" dir="auto"
            >${a.fileName}</span
          >${typeof a.size === "number" ? html`<small class="file-image-size">${formatBytes(a.size)}</small>` : nothing}</a
        >`;
      }
      return chipBadge(FileImage, a.fileName, a.size, href || undefined, true);
    }
    if (inlineHtmlName(a.fileName, a.mimeType)) {
      let src = artifactHref;
      if (!src && a.content) {
        src = a.content.startsWith("data:") ? a.content : `data:text/html;base64,${a.content}`;
      }
      if (src) return inlineHtmlFrame(a.fileName, src, a.size, artifactHref);
    }
    return chipBadge(Paperclip, a.fileName, a.size, artifactHref ?? localContentUrl(a), false, a.mimeType);
  }

  function deliveredFileBadge(file: DeliveredFile): TemplateResult {
    if (!file.artifactId) return chipBadge(Paperclip, file.name, file.sizeBytes, undefined, false);
    const href = fileContentUrl(file.artifactId, file.name);
    if (file.mimetype?.startsWith("image/")) {
      if (!browserRenderableImage(file.mimetype)) return chipBadge(FileImage, file.name, file.sizeBytes, href, true);
      return html`<a class="file-image" href=${href} target="_blank" rel="noreferrer" ${tip(file.name)}
        ><img src=${href} alt=${file.name} loading="lazy"
      /></a>`;
    }
    if (inlineHtmlName(file.name, file.mimetype)) return inlineHtmlFrame(file.name, href, file.sizeBytes, href);
    return chipBadge(Paperclip, file.name, file.sizeBytes, href, false, file.mimetype);
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
