import type { SlackReply } from "./slack-reply";
import { pinnedStrip } from "./pinned-strip";
import { type MessageFields } from "./message-rows";
import { appEditSlug } from "./app-edit";
import { loadGeneratedActivities } from "./generated-activities";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Attachment } from "@earendil-works/pi-web-ui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { html, nothing, render, type TemplateResult } from "lit";
import { currentEarlierCount, inheritedTranscript } from "./transcript-messages";
import {
  fetchTranscript,
  TAIL_TURNS,
  type CoreSession,
  type TurnOptions,
  type TranscriptPage,
  type WorkBlock,
} from "./core-bridge";
import { makeCoreStreamFn, makeOpenerStreamFn } from "./run-stream";
import { errMessage } from "../../chassis/src/errors";
import { defaultEffortForModel } from "./model-options";
import { waveLoader } from "./ui";
import { appState, renderSidebarTop, syncUrlFromState } from "./shell";
import {
  addPendingSession,
  dropPendingSession,
  groupDmTitle,
  refreshSessions,
  renderList,
  sessionsState,
  sessionSlackUrl,
} from "./sessions";
import { clearWorking, isAbandonedNewChat, shouldStartProactiveOpener, markWorking, surfaceOf } from "./session-list";
import { liveTurnThreadRef } from "./working-dot";
import { newChatDraftKey, saveDraft, storedDraft } from "./drafts";
import { decorateTextCodeBlocks } from "./text-code";
import { reportHandledError } from "./browser-errors.ts";
import { type ChatCore, detachedAgents, connectedConnectors, redrawHooks, toMessages } from "./chat-core";
import {
  onDelivery,
  refreshTranscriptFromItems,
  observeLiveWork,
  followNextQueuedRun,
  resumeTrackedRun,
} from "./chat-runs";
import {
  drawActiveChat,
  earlierNotice,
  inheritedHeader,
  scheduleStreamDraw,
  syncWorkTicker,
  redrawTranscript,
  scrollTranscript,
  togglePins,
  chatMessage,
  messageText,
} from "./chat-draw";

let proactiveOpenerStarted = false;

const freshWindow = () => ({ transcriptAnchorSeq: null, earlierCount: 0, loadingEarlier: false });

const freshView = () => ({ ...freshWindow(), inheritedExpanded: false, pins: [], goal: null, turnRuntime: null });

export async function openSessionPage(c: ChatCore, id: string): Promise<void> {
  const listed = sessionsState.list.find((session) => session.id === id);
  const page = await c.transcriptFetcher(id, { tailTurns: TAIL_TURNS });
  const source = listed ?? page.session;
  if (!source) throw new Error("missing session");
  await c.sessionOpener(source, Promise.resolve(page));
}

export async function openSessionById(c: ChatCore, id: string): Promise<void> {
  try {
    await openSessionPage(c, id);
  } catch {
    c.ctx.composer.state.error = "Couldn't open that session.";
    redrawTranscript(c);
  }
}

export function notePendingSessionOnSend(c: ChatCore): void {
  if (!c.state.threadRef || c.state.sessionId !== null) return;
  const existing = sessionsState.list.find((s) => s.id && s.threadRef === c.state.threadRef);
  if (existing) {
    if (c.state.agent) adoptActiveSessionFromList(c, c.state.agent);
    return;
  }
  addPendingSession(c.state.threadRef, c.state.scopeId, c.state.contextName);
}

export function teardownActiveChat(c: ChatCore): void {
  c.sideChats.dispose();
  c.transcriptViewport.dispose();
  c.transcriptRefreshGeneration++;
  c.readOnlyView = null;
  preserveOutgoingWorkingDot(c, null);
  detachActiveAgent(c);
  c.state.agent = null;
  clearLiveWork(c);
  resetBackgroundPanel(c);
  setChat(c, { host: null, threadRef: null, sessionId: null, scopeId: null, contextName: null });
  setChat(c, { normalStreamFn: null, onWork: null, ...freshWindow() });
  c.state.resolvingApprovals.clear();
}

export function resetChatState(c: ChatCore): void {
  dropAbandonedNewChat(c, null);
  teardownActiveChat(c);
  proactiveOpenerStarted = false;
  remember(c);
  connectedConnectors.clear();
}

export function setChat(c: ChatCore, patch: Partial<typeof c.state>): void {
  Object.assign(c.state, patch);
}

function remember(c: ChatCore): void {
  c.state.rememberedThreadRef = c.state.threadRef;
  c.state.rememberedSessionId = c.state.sessionId;
}

export function newChat(c: ChatCore, context?: { scopeId: string; name: string | null }): string {
  appState.currentView = "chats";
  renderSidebarTop();
  const user = appState.me?.user ?? "anon";
  const threadRef = `web:${user}:${crypto.randomUUID()}`;
  const carried = storedDraft(newChatDraftKey(user));
  if (carried) saveDraft(threadRef, carried);
  c.ctx.composer.resetComposer();
  c.forkOriginController.reset();
  mountContinuable(c, threadRef, null, context?.scopeId ?? null, [], context?.name ?? null);
  renderList();
  c.ctx.composer.focusComposerEnd();
  return threadRef;
}

function dropAbandonedNewChat(c: ChatCore, nextThreadRef: string | null): void {
  const ref = c.state.threadRef;
  if (
    isAbandonedNewChat({
      threadRef: ref,
      nextThreadRef,
      sessionId: c.state.sessionId,
      pendingSend: c.state.pendingSend,
      hasHumanMessage: (c.state.agent?.state.messages ?? []).some((m) => !(m as MessageFields).opener),
      draft: c.ctx.composer.state.draft || storedDraft(ref ?? ""),
      attachments: c.ctx.composer.state.attachments.length,
    })
  )
    dropPendingSession(ref!);
}

function liveThreadRef(c: ChatCore): string | null {
  return liveTurnThreadRef({
    mountedThreadRef: c.state.threadRef,
    isStreaming: Boolean(c.state.agent?.state.isStreaming),
    pendingSend: c.state.pendingSend,
  });
}

function preserveOutgoingWorkingDot(c: ChatCore, nextThreadRef: string | null): void {
  const live = liveThreadRef(c);
  if (!live || live === nextThreadRef) return;
  sessionsState.list = markWorking(sessionsState.list, live);
}

function detachActiveAgent(c: ChatCore): void {
  if (c.state.host) render(nothing, c.state.host);
  if (!c.state.agent) return;
  detachedAgents.add(c.state.agent);
  c.state.agent.abort();
}

export function mountContinuable(
  c: ChatCore,
  threadRef: string,
  sessionId: string | null,
  scopeId: string | null,
  messages: AgentMessage[],
  contextName: string | null = null,
  session?: CoreSession,
  inheritedMessages: AgentMessage[] = [],
): void {
  const container = c.ctx.claimContainer();
  if (!container) return;
  c.readOnlyView = null;
  preserveOutgoingWorkingDot(c, threadRef);
  dropAbandonedNewChat(c, threadRef);
  detachActiveAgent(c);
  c.ctx.composer.resetComposer();
  c.forkOriginController.reset();
  setChat(c, { threadRef, sessionId, scopeId, contextName, forkSession: session ?? null, inheritedMessages });
  setChat(c, { ...freshView(), inheritedLoaded: !session?.forkedFrom });
  remember(c);
  c.ctx.composer.state.draft = storedDraft(threadRef);
  syncLocation(c);
  c.state.host = document.createElement("div");
  c.state.host.className = "custom-chat";

  const model = c.ctx.composer.currentModelOption()?.model;
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
  c.state.agent = agent;
  clearLiveWork(c);
  resetBackgroundPanel(c);
  c.state.resolvingApprovals.clear();
  c.resetThinking();
  const onWork = observeLiveWork(c, agent);
  const onSendIssues = (issues: string[], retryable: Attachment[]): void => {
    if (agent !== c.state.agent || !issues.length) return;
    c.ctx.composer.restageAttachments(retryable, issues.join(" "));
    drawActiveChat(c, agent);
  };
  const normalStreamFn = makeCoreStreamFn(
    threadRef,
    agent,
    () => currentTurnOptions(c),
    onWork,
    c.runSlot,
    onSendIssues,
  );
  agent.streamFn = normalStreamFn;
  c.state.normalStreamFn = normalStreamFn;
  c.state.onWork = onWork;
  void c.ctx.composer.refreshRuntimeSelection(scopeId, agent);

  let listedWorking = false;
  agent.subscribe((e) => {
    scheduleStreamDraw(c, agent);
    if (agent === c.state.agent && (agent.state.isStreaming || e.type === "agent_end")) c.state.pendingSend = null;
    if (e.type === "agent_end" && !detachedAgents.has(agent))
      sessionsState.list = clearWorking(sessionsState.list, threadRef);
    const working = agent.state.isStreaming || c.state.pendingSend !== null;
    if (working !== listedWorking || e.type === "agent_end") {
      listedWorking = working;
      renderList();
    }
    if (e.type !== "agent_end") return;
    void agent.waitForIdle().then(async () => {
      if (agent === c.state.agent) clearLiveWork(c);
      await refreshSessions({ silent: true }).catch((error: unknown) =>
        reportHandledError("web:refresh_sessions", error),
      );
      if (!detachedAgents.has(agent)) {
        sessionsState.list = clearWorking(sessionsState.list, threadRef);
        renderList();
      }
      if (agent !== c.state.agent) return;
      adoptActiveSessionFromList(c, agent);
      await refreshTranscriptFromItems(c, agent);
      void c.ctx.composer.refreshRuntimeSelection(scopeId, agent, true);
      void followNextQueuedRun(c, agent, threadRef, normalStreamFn, onWork);
    });
  });

  container.replaceChildren(c.state.host);
  const opening = startProactiveOpenerIfNew(c, agent, threadRef, normalStreamFn, onWork, sessionId, scopeId, messages);
  drawActiveChat(c, agent, { forceScroll: true });
  const me = appState.me;
  if (!sessionId && me && (scopeId === null || scopeId === `personal:${me.user}`)) {
    void loadGeneratedActivities(me, () => {
      if (appState.me === me && c.state.agent === agent && !c.state.sessionId) drawActiveChat(c, agent);
    });
  }
  c.ctx.composer.focusComposerEnd();
  c.ctx.ensureDeliveryStream();
  if (!opening) void resumeTrackedRun(c, agent, threadRef, normalStreamFn, onWork);
  c.consumeBackgroundPanelRequest();
}

function startProactiveOpenerIfNew(
  c: ChatCore,
  agent: Agent,
  threadRef: string,
  normalStreamFn: Agent["streamFn"],
  onWork: (work: WorkBlock) => void,
  sessionId: string | null,
  scopeId: string | null,
  messages: AgentMessage[],
): boolean {
  if (appEditSlug(threadRef, appState.me?.user)) return false;
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
  agent.streamFn = makeOpenerStreamFn(threadRef, agent, () => currentTurnOptions(c), onWork, c.runSlot);
  void (async () => {
    try {
      await agent.continue();
    } catch (err) {
      if (agent === c.state.agent) c.ctx.composer.state.error = errMessage(err, "Could not start the conversation.");
    } finally {
      if (agent === c.state.agent) {
        agent.streamFn = normalStreamFn;
        const last = agent.state.messages[agent.state.messages.length - 1] as AssistantMessage | undefined;
        if (
          last?.role === "assistant" &&
          (last.stopReason === "error" || last.stopReason === "aborted") &&
          !messageText(last).trim()
        ) {
          agent.state.messages = [];
        }
        drawActiveChat(c, agent);
      }
    }
  })();
  return true;
}

export function currentTurnOptions(c: ChatCore): TurnOptions {
  const selected = c.ctx.composer.currentModelOption();
  if (!selected) throw new Error("No model is available");
  const target = { scopeId: c.state.scopeId, channelName: c.state.contextName };
  if (c.ctx.composer.followsDefault()) return target;
  return { effortLevel: c.ctx.composer.state.effortLevel, fastMode: c.ctx.composer.state.fastMode, ...target };
}

function syncLocation(c: ChatCore): void {
  if (c.ctx.ownsUrl) syncUrlFromState();
  else postCurrentPaneState(c);
}

export function dispose(c: ChatCore): void {
  redrawHooks.delete(c.redrawHook);
  c.stopPrefsWatch();
  teardownActiveChat(c);
}

export function adoptActiveSessionFromList(c: ChatCore, agent: Agent): void {
  if (agent !== c.state.agent || c.state.sessionId !== null || c.state.threadRef === null) return;
  const match = sessionsState.list.find((s) => s.id && s.threadRef === c.state.threadRef);
  if (!match) return;
  setChat(c, {
    sessionId: match.id,
    scopeId: match.scopeId,
    contextName: match.channelName || c.state.contextName,
  });
  remember(c);
  syncLocation(c);
}

export function postCurrentPaneState(c: ChatCore): void {
  if (!c.ctx.pane) return;
  c.ctx.onState?.({
    threadRef: c.state.threadRef ?? c.state.rememberedThreadRef,
    sessionId: c.state.sessionId ?? c.state.rememberedSessionId,
    working: liveThreadRef(c) !== null,
  });
}

function mountPane(c: ChatCore, className: string, content: TemplateResult): () => boolean {
  const container = c.ctx.container();
  if (!container) return () => false;
  const host = document.createElement("div");
  host.className = className;
  render(content, host);
  container.replaceChildren(host);
  return () => container.contains(host);
}

export function mountLoadingPane(c: ChatCore): () => boolean {
  dropAbandonedNewChat(c, null);
  teardownActiveChat(c);
  return mountPane(
    c,
    "custom-chat",
    html`<div class="custom-chat-shell">
      <div class="chat-loading">${waveLoader()}</div>
    </div>`,
  );
}

export function mountLoadError(c: ChatCore, retry: () => void): void {
  mountPane(
    c,
    "empty compact",
    html`<p role="alert">Couldn't load this conversation.</p>
      <button class="btn" @click=${retry}>Retry</button>`,
  );
}

export function clearLiveWork(c: ChatCore): void {
  if (c.state.liveWork?.goal) c.state.goal = c.state.liveWork.goal;
  c.state.liveWork = null;
  c.resetLiveStep();
  c.state.pendingSend = null;
  syncWorkTicker(c);
}

function resetBackgroundPanel(c: ChatCore): void {
  c.resetBackgroundPanel();
  c.readonlyRedraw = null;
}

export function mountReadOnly(
  c: ChatCore,
  s: CoreSession,
  messages: AgentMessage[],
  earlierCount = 0,
  anchorSeq: number | null = null,
  inheritedMessages: AgentMessage[] = [],
): void {
  const container = c.ctx.claimContainer();
  if (!container) return;
  preserveOutgoingWorkingDot(c, s.threadRef);
  dropAbandonedNewChat(c, s.threadRef);
  detachActiveAgent(c);
  c.state.agent = null;
  clearLiveWork(c);
  c.state.host = null;
  c.ctx.composer.resetComposer();
  const sameSession = c.state.sessionId === s.id && c.state.threadRef === null;
  if (!sameSession) c.forkOriginController.reset();
  c.state.threadRef = null;
  c.state.sessionId = s.id;
  c.state.scopeId = s.scopeId;
  c.state.forkSession = s;
  if (!(sameSession && c.state.inheritedLoaded)) {
    c.state.inheritedMessages = inheritedMessages;
    c.state.inheritedLoaded = !s.forkedFrom;
  }
  if (!sameSession) setChat(c, freshView());
  syncLocation(c);

  resetBackgroundPanel(c);
  const host = document.createElement("div");
  host.className = "custom-chat readonly-chat";
  const priorReply = sameSession ? container.querySelector<SlackReply>("qm-slack-reply") : null;
  const slackReply =
    surfaceOf(s) === "slack" ? (priorReply ?? (document.createElement("qm-slack-reply") as SlackReply)) : null;
  if (slackReply) {
    slackReply.sessionId = s.id;
    slackReply.user = appState.me?.user ?? "";
    if (!priorReply) slackReply.addEventListener("slack-sent", () => onDelivery(c, s.threadRef));
  }
  const draw = () => {
    const shownMessages = c.state.inheritedExpanded ? [...c.state.inheritedMessages, ...messages] : messages;
    c.prepareMessageRows(shownMessages);
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
          ${c.backgroundActivityStrip()}
          <section class="chat-scroll readonly-scroll" tabindex="0" aria-label="Conversation">
            ${pinnedStrip(c.state.pins, c.state.pinsExpanded, (e: Event) => togglePins(c, e))}
            <div class="message-stack">
              ${inheritedHeader(c)}
              ${earlierCount > 0 ? earlierNotice(c, () => loadEarlierReadOnly(c, s, messages, anchorSeq)) : nothing}
              ${
                shownMessages.length
                  ? shownMessages.map((m, i) => chatMessage(c, m, i))
                  : html`<div class="empty compact">No readable messages in this conversation.</div>`
              }
              ${c.ctx.composer.state.error ? html`<div class="composer-error inline">${c.ctx.composer.state.error}</div>` : nothing}
            </div>
          </section>
          ${slackReply ?? nothing}
        </div>
      `,
      host,
    );
    requestAnimationFrame(() => {
      decorateTextCodeBlocks(host);
      if (host.isConnected) c.transcriptViewport.sync(host.querySelector<HTMLElement>(".chat-scroll"));
    });
  };
  c.readonlyRedraw = draw;
  draw();
  container.replaceChildren(host);
  if (!sameSession) scrollTranscript(c, true);
  c.readOnlyView = { id: s.id, threadRef: s.threadRef, session: s, anchorSeq };
  c.ctx.ensureDeliveryStream();
  c.consumeBackgroundPanelRequest();
}

export function mountReadOnlyPage(
  c: ChatCore,
  s: CoreSession,
  page: TranscriptPage,
  messages: AgentMessage[] = [],
  inherited: AgentMessage[] = [],
): void {
  const split = inheritedTranscript(s, page.items ?? []);
  mountReadOnly(
    c,
    s,
    [...toMessages(split.current), ...messages],
    currentEarlierCount(s, page.earlierItems ?? 0),
    pageAnchor(page),
    [...toMessages(split.inherited), ...inherited],
  );
}

async function loadEarlierReadOnly(
  c: ChatCore,
  s: CoreSession,
  messages: AgentMessage[],
  anchorSeq: number | null,
): Promise<void> {
  if (c.state.loadingEarlier) return;
  c.state.loadingEarlier = true;
  c.readonlyRedraw?.();
  try {
    const page = await fetchTranscript(
      s.id,
      anchorSeq !== null ? { beforeSeq: anchorSeq, tailTurns: TAIL_TURNS } : undefined,
    );
    if (c.state.sessionId !== s.id) return;
    c.state.loadingEarlier = false;
    keepScrollAfterPrepend(
      () => c.ctx.container()?.querySelector<HTMLElement>(".chat-scroll"),
      () => mountReadOnlyPage(c, s, page, messages, c.state.inheritedMessages),
    );
  } catch (error) {
    reportHandledError("web:load_earlier", error);
    c.state.loadingEarlier = false;
    c.readonlyRedraw?.();
  }
}

export async function loadEarlierMessages(c: ChatCore): Promise<void> {
  const agent = c.state.agent;
  const sessionId = c.state.sessionId;
  const anchor = c.state.transcriptAnchorSeq;
  if (!agent || !sessionId || anchor === null || c.state.loadingEarlier) return;
  c.state.loadingEarlier = true;
  c.transcriptViewport.cancelFollow();
  drawActiveChat(c, agent);
  try {
    const page = await fetchTranscript(sessionId, { beforeSeq: anchor, tailTurns: TAIL_TURNS });
    if (agent !== c.state.agent || sessionId !== c.state.sessionId || anchor !== c.state.transcriptAnchorSeq) return;
    const split = inheritedTranscript(c.state.forkSession ?? {}, page.items ?? []);
    const earlierMessages = toMessages(split.current);
    if (!c.state.inheritedLoaded)
      c.state.inheritedMessages = [...toMessages(split.inherited), ...c.state.inheritedMessages];
    const scroller = (): HTMLElement | null | undefined => c.state.host?.querySelector<HTMLElement>(".chat-scroll");
    const before = scroller();
    keepScrollAfterPrepend(
      scroller,
      () => {
        agent.state.messages = [...earlierMessages, ...agent.state.messages];
        c.state.transcriptAnchorSeq = pageAnchor(page);
        c.state.earlierCount = currentEarlierCount(c.state.forkSession ?? {}, page.earlierItems ?? 0);
        c.state.loadingEarlier = false;
        drawActiveChat(c, agent);
      },
      (now) => agent === c.state.agent && sessionId === c.state.sessionId && now === before,
    );
  } catch (error) {
    reportHandledError("web:load_earlier", error);
  } finally {
    if (agent === c.state.agent && sessionId === c.state.sessionId && c.state.loadingEarlier) {
      c.state.loadingEarlier = false;
      drawActiveChat(c, agent);
    }
  }
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

export function pageAnchor(page: TranscriptPage): number | null {
  return (page.earlierItems ?? 0) > 0 ? (page.items?.[0]?.seq ?? null) : null;
}

export function setTranscriptWindow(
  c: ChatCore,
  anchorSeq: number | null,
  earlierCount: number,
  hasEarlier = earlierCount > 0,
): void {
  c.state.transcriptAnchorSeq = hasEarlier ? anchorSeq : null;
  c.state.earlierCount = earlierCount;
  if (c.state.agent) drawActiveChat(c, c.state.agent);
}
