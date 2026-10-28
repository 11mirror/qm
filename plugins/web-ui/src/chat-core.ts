import { createSideChatController } from "./side-chat";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { createChatState } from "./chat-state";
import { createAssistantContent } from "./assistant-content";
import { createLiveWork } from "./live-work";
import { createMessageRows } from "./message-rows";
import { createBackgroundPanel } from "./background-panel";
import { createSubagentStrip } from "./subagent-strip";
import { createChatAttachments } from "./chat-attachments";
import { createToolRows } from "./tool-rows";
import { isConnectionReturn } from "./connection-return";
import { itemsToMessages, loadInheritedTranscript } from "./transcript-messages";
import { fetchTranscript, onChatPrefsChange, pinLatestPrompt, type CoreSession } from "./core-bridge";
import { createRunSlot } from "./run-stream";
import type { Item } from "./items";
import type { ConvCtx } from "./conv-types";
import { transcriptModel } from "./model-options";
import { openSession } from "./sessions";
import { createForkOriginController } from "./fork-origin";
import { createTranscriptViewport } from "./transcript-viewport";
import { chatMessage, drawActiveChat, redrawTranscript, syncWorkTicker } from "./chat-draw";
import { openSessionById, openSessionPage } from "./chat-mount";
import { loadFullItem } from "./chat-runs";

export const detachedAgents = new WeakSet<Agent>();
export const connectedConnectors = new Set<string>();
export const redrawHooks = new Set<() => void>();

export const toMessages = (items: Item[]): AgentMessage[] => itemsToMessages(items, transcriptModel());

export type ChatDependencies = { fetchTranscript?: typeof fetchTranscript; openSession?: typeof openSession };

function chatCoreState(ctx: ConvCtx, dependencies: ChatDependencies) {
  const runSlot = createRunSlot((message) => {
    ctx.composer.state.error = message;
  });
  const transcriptViewport = createTranscriptViewport({ pinPrompt: () => !ctx.inbox && pinLatestPrompt() });
  return {
    ctx,
    sideChats: createSideChatController(ctx),
    runSlot,
    transcriptViewport,
    stopPrefsWatch: onChatPrefsChange(() => transcriptViewport.refresh()),
    preserveConnectionScroll: isConnectionReturn(),
    connectionReturnMessageCount: null as number | null,
    transcriptFetcher: dependencies.fetchTranscript ?? fetchTranscript,
    sessionOpener: dependencies.openSession ?? openSession,
    pendingFork: null as { index: number } | null,
    goalCancels: new Map<string, "pending" | "done">(),
    state: createChatState(),
    transcriptRefreshGeneration: 0,
    approvalsEpoch: 0,
    ctaThreadRef: undefined as string | null | undefined,
    ctaText: "",
    workTicker: null as ReturnType<typeof setInterval> | null,
    readOnlyView: null as { id: string; threadRef: string; session: CoreSession; anchorSeq: number | null } | null,
    transcriptRefresh: Promise.resolve(),
    streamDrawAgent: null as Agent | null,
    readonlyRedraw: null as (() => void) | null,
  };
}

export type ChatCore = ReturnType<typeof chatCoreState> &
  ReturnType<typeof createMessageRows> &
  ReturnType<typeof createChatAttachments> &
  ReturnType<typeof createAssistantContent> &
  ReturnType<typeof createBackgroundPanel> &
  ReturnType<typeof createSubagentStrip> &
  ReturnType<typeof createToolRows> &
  ReturnType<typeof createLiveWork> & {
    forkOriginController: ReturnType<typeof createForkOriginController<AgentMessage>>;
    redrawHook: () => void;
  };

export function createChatCore(ctx: ConvCtx, dependencies: ChatDependencies): ChatCore {
  const base = chatCoreState(ctx, dependencies);
  const { state: chatState, runSlot } = base;
  const redraw = (): void => redrawTranscript(c);
  const draw = (): void => drawActiveChat(c);
  const openById = (id: string): Promise<void> => openSessionById(c, id);
  const rows = createMessageRows(chatState);
  const attachments = createChatAttachments({ chatState, redrawTranscript: redraw });
  const { deliveredFileBadge } = attachments;
  const isConnectorConnected = (provider: string): boolean => connectedConnectors.has(provider);
  const content = createAssistantContent({ ctx, chatState, runSlot, deliveredFileBadge, isConnectorConnected });
  const background = createBackgroundPanel({ chatState, redrawTranscript: redraw });
  const syncTicker = (): void => syncWorkTicker(c);
  const subagents = createSubagentStrip({
    ctx,
    chatState,
    drawActiveChat: draw,
    openSessionById: openById,
    syncWorkTicker: syncTicker,
  });
  const tools = createToolRows({
    loadFullItem: (work, item) => loadFullItem(c, work, item),
    openSessionById: openById,
  });
  const { inlineSteers } = rows;
  const { toolRow } = tools;
  const liveWork = createLiveWork({
    ctx,
    chatState,
    runSlot,
    drawActiveChat: draw,
    chatMessage: (...args) => chatMessage(c, ...args),
    inlineSteers,
    toolRow,
  });
  const forkOriginController = createForkOriginController({
    state: chatState,
    load: async () => {
      const session = chatState.forkSession;
      if (!session) return [];
      const entries = await loadInheritedTranscript(session, [], base.transcriptFetcher);
      return toMessages(entries);
    },
    navigate: async () => {
      const sourceId = chatState.forkSession?.forkedFrom?.sessionId;
      if (sourceId) await openSessionPage(c, sourceId);
    },
    current: () => Boolean(chatState.forkSession && chatState.sessionId === chatState.forkSession.id),
    redraw,
    setError: (error) => {
      ctx.composer.state.error = error;
    },
  });
  const redrawHook = (): void => {
    if (chatState.agent) draw();
  };
  const extra = { forkOriginController, redrawHook };
  const c: ChatCore = Object.assign(base, rows, attachments, content, background, subagents, tools, liveWork, extra);
  return c;
}
