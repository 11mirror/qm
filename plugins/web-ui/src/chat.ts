import "./slack-reply";
import "./connect-apps";
import { approvalSummaryView } from "./tool-rows";
import { messageEntrySeqs, highlightMessage } from "./message-link.ts";
import { hasLiveRun, signalLiveRun } from "./run-stream";
import "./slack-setup";
import type { ChatSurface, ConvCtx } from "./conv-types";
import { installMarkdownSanitizer } from "./markdown-sanitize";
import { connectedConnectors, createChatCore, redrawHooks, type ChatDependencies } from "./chat-core";
import { drawActiveChat, redrawTranscript, scrollTranscript, setGoal, setPins, setTurnRuntime } from "./chat-draw";
import * as mount from "./chat-mount";
import * as runs from "./chat-runs";

installMarkdownSanitizer();

export function markConnectorConnected(provider: string): void {
  if (!provider) return;
  connectedConnectors.add(provider);
  for (const hook of redrawHooks) hook();
}

export function createChatSurface(ctx: ConvCtx, dependencies: ChatDependencies = {}): ChatSurface {
  const c = createChatCore(ctx, dependencies);
  const { state: chatState, runSlot } = c;
  ctx.onDensityChange(() => drawActiveChat(c));
  redrawHooks.add(c.redrawHook);
  const target = () => ({
    threadRef: chatState.threadRef,
    scopeId: chatState.scopeId,
    channelName: chatState.contextName,
  });

  return {
    state: chatState,
    hasLiveRun: () => hasLiveRun(runSlot),
    signalLiveRun: (kind, text, queuedRunId) => signalLiveRun(runSlot, kind, text, target(), queuedRunId),
    stopLiveRun: () => runs.stopLiveRun(c),
    isStopping: () => runSlot.stopGeneration === runSlot.generation,
    currentTurnOptions: () => mount.currentTurnOptions(c),
    turnRuntime: () => chatState.turnRuntime,
    newChat: (context) => mount.newChat(c, context),
    teardown: () => mount.teardownActiveChat(c),
    resetChatState: () => mount.resetChatState(c),
    mountContinuable: (...args) => mount.mountContinuable(c, ...args),
    mountReadOnly: (...args) => mount.mountReadOnly(c, ...args),
    attachApprovalsWhenLoaded: (sessionId, pending) => runs.attachApprovalsWhenLoaded(c, sessionId, pending),
    mountLoadingPane: () => mount.mountLoadingPane(c),
    mountLoadError: (retry) => mount.mountLoadError(c, retry),
    scrollToBottom: () => scrollTranscript(c, true),
    revealEntry: (seq: number) => {
      if (chatState.inheritedMessages.some((message) => messageEntrySeqs(message).includes(seq))) {
        chatState.inheritedExpanded = true;
        redrawTranscript(c);
      }
      const host = chatState.host ?? ctx.container()?.querySelector<HTMLElement>(".custom-chat");
      c.transcriptViewport.cancelFollow();
      const found = host ? highlightMessage(host, seq) : false;
      if (!found) {
        ctx.composer.state.error = "The linked message is unavailable or isn't visible in this conversation.";
        redrawTranscript(c);
      }
      return found;
    },
    drawActiveChat: (agent, opts) => drawActiveChat(c, agent, opts),
    setTranscriptWindow: (...args) => mount.setTranscriptWindow(c, ...args),
    setPins: (pins) => setPins(c, pins),
    setGoal: (goal) => setGoal(c, goal),
    setTurnRuntime: (runtime) => setTurnRuntime(c, runtime),
    requestBackgroundPanel: c.requestBackgroundPanel,
    activePendingApprovals: () => runs.activePendingApprovals(c),
    hasUnresolvedApproval: () => runs.hasUnresolvedApproval(c),
    resolveCommandApproval: (decision) => {
      if (chatState.agent) void runs.approveCommand(c, chatState.agent, decision);
    },
    approvalSummaryView,
    notePendingSessionOnSend: () => mount.notePendingSessionOnSend(c),
    onDelivery: (threadRef) => runs.onDelivery(c, threadRef),
    applyTranscript: (...args) => runs.applyTranscript(c, ...args),
    mountReadOnlyPage: (...args) => mount.mountReadOnlyPage(c, ...args),
    transcriptAnchor: () => runs.transcriptAnchor(c),
    resumeIfIdle: () => runs.resumeIfIdle(c),
    redraw: () => drawActiveChat(c),
    dispose: () => mount.dispose(c),
  };
}
