import { postCallText, postResultOk } from "./surface-post.ts";
import type { Attachment } from "@earendil-works/pi-web-ui";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { messageEntrySeqs } from "./message-link.ts";
import {
  type Item,
  activityCreatedAt,
  activityItems,
  isHidden,
  isNarration,
  isUserMessage,
  messageTs,
  stepMessage,
} from "./items.ts";
import {
  type CoreSession,
  type DeliveredFile,
  type PendingApproval,
  type RunPoll,
  TAIL_TURNS,
  type WebUserMessage,
  type WorkBlock,
  fetchTranscript,
  unresolvedApprovals,
  workPausedForApproval,
} from "./core-bridge.ts";

export function isUserRole(message: unknown): boolean {
  const role = (message as { role?: string } | undefined)?.role;
  return role === "user" || role === "user-with-attachments";
}

type ForkFields = Pick<CoreSession, "forkedFrom" | "forkBoundarySeq">;

function forkBoundary(session: ForkFields): number | undefined {
  return session.forkedFrom ? session.forkBoundarySeq : undefined;
}

export function inheritedTranscript(session: ForkFields, items: Item[]): { inherited: Item[]; current: Item[] } {
  const boundary = forkBoundary(session);
  if (boundary === undefined) return { inherited: [], current: items };
  return {
    inherited: items.filter((item) => item.seq <= boundary),
    current: items.filter((item) => item.seq > boundary),
  };
}

export function inheritedRefreshItems(session: ForkFields, items: Item[], inheritedLoaded: boolean): Item[] | null {
  const inherited = inheritedTranscript(session, items).inherited;
  return inherited.length && !inheritedLoaded ? inherited : null;
}

export function forkOriginDetails(
  session: ForkFields,
  inheritedCount: number,
): { sessionId: string; title: string; messageCount?: number } | null {
  if (!session.forkedFrom || session.forkBoundarySeq === undefined) return null;
  return {
    sessionId: session.forkedFrom.sessionId,
    title: session.forkedFrom.title?.trim() || "another conversation",
    ...(inheritedCount > 0 ? { messageCount: inheritedCount } : {}),
  };
}

export function currentEarlierCount(session: ForkFields, earlierItems: number): number {
  const boundary = forkBoundary(session);
  return boundary === undefined ? earlierItems : Math.max(0, earlierItems - (boundary + 1));
}

export async function loadInheritedTranscript(
  session: ForkFields & { id: string },
  loaded: Item[],
  fetcher: typeof fetchTranscript = fetchTranscript,
): Promise<Item[]> {
  const boundary = forkBoundary(session);
  if (loaded.length || boundary === undefined) return loaded;
  let beforeSeq = boundary + 1;
  let inherited: Item[] = [];
  for (;;) {
    const page = await fetcher(session.id, { beforeSeq, tailTurns: TAIL_TURNS });
    const items = inheritedTranscript(session, page.items ?? []).inherited;
    inherited = [...items, ...inherited];
    const earliestSeq = items[0]?.seq;
    if (!(page.earlierItems ?? 0) || earliestSeq === undefined || earliestSeq <= 0 || earliestSeq >= beforeSeq) break;
    beforeSeq = earliestSeq;
  }
  return inherited;
}

export function forkCutSeq(
  items: Item[],
  messages: readonly unknown[],
  index: number,
  floorSeq = -1,
): number | undefined {
  const isUser = (message: unknown): boolean => {
    const m = message as { opener?: boolean; resumeAnchor?: boolean } | undefined;
    return isUserRole(m) && !m?.opener && !m?.resumeAnchor;
  };
  let base = floorSeq;
  let unsaved = 0;
  for (let i = index; i >= 0; i--) {
    const seqs = messageEntrySeqs(messages[i]);
    if (seqs.length) {
      base = Math.max(...seqs);
      break;
    }
    if (isUser(messages[i])) unsaved++;
  }
  if (isUser(messages[index]) && !unsaved) return base;
  const later = items.flatMap((item) =>
    item.kind === "UserMessage" && item.seq > base && userItemMessage(item) ? [item.seq] : [],
  );
  if (isUser(messages[index])) return later[unsaved - 1];
  const nextUser = later[unsaved];
  return nextUser !== undefined ? nextUser - 1 : items.at(-1)?.seq;
}

export type AssistantWork = AssistantMessage & {
  persisted?: boolean;
  streamingBaseline?: string;
  work?: WorkBlock;
  deliveredFiles?: DeliveredFile[];
  retryableSend?: boolean;
  interruptedRunId?: string;
  sendBlocked?: "pending_approval";
  sendFailed?: "attachments";
  droppedAttachmentIds?: string[];
};

export function hasRecordedRunReply(items: Item[], runId: string): boolean {
  let matchesRun = false;
  for (const item of items) {
    if (isUserMessage(item)) {
      if (item.kind === "UserMessage" || item.turnId !== null) matchesRun = item.turnId === runId;
    } else if (matchesRun && item.kind === "AgentMessage" && item.variant === null) {
      return true;
    }
  }
  return false;
}

export function resumeAnchor(): AgentMessage {
  return { role: "user", content: "", resumeAnchor: true } as unknown as AgentMessage;
}

export function continuableMessages(
  messages: AgentMessage[],
  input?: RunPoll["input"],
): { messages: AgentMessage[]; popped: AgentMessage[] } {
  const kept = messages.slice();
  const popped: AgentMessage[] = [];
  if (
    input &&
    !kept.some((message) => {
      const user = message as unknown as HistoryUserMessage;
      return isUserRole(user) && (user.runId === input.runId || (input.seq !== null && user.entrySeq === input.seq));
    })
  ) {
    const user: HistoryUserMessage = {
      role: "user",
      runId: input.runId,
      content: input.text,
      timestamp: input.createdAt,
      ...(input.attachments?.length ? { attachments: historyAttachments(input.attachments, input.runId) } : {}),
    };
    return { messages: [...kept, user as AgentMessage], popped };
  }
  while (kept.length && (kept[kept.length - 1] as { role?: string }).role === "assistant") {
    const work = (kept.at(-1) as AssistantWork).work;
    if (!input && work && workPausedForApproval(work)) {
      kept.push(resumeAnchor());
      break;
    }
    popped.unshift(kept.pop()!);
  }
  return { messages: kept.length ? kept : [resumeAnchor()], popped };
}

export function baseAssistant(model: Model<Api> | undefined, timestamp = Date.now(), text = ""): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model?.api ?? "unknown",
    provider: model?.provider ?? "unknown",
    model: model?.id ?? "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function isRenderableThinking(item: Item): boolean {
  return item.body.redacted !== true && Boolean(item.text?.trim());
}

export function deliveredFilesFromAttachments(attachments: UserAttachment[] | undefined): DeliveredFile[] {
  return (attachments ?? [])
    .filter((a) => typeof a?.name === "string" && a.name.trim())
    .map((a) => ({
      name: a.name!,
      ...(a.mimetype ? { mimetype: a.mimetype } : {}),
      ...(typeof a.sizeBytes === "number" ? { sizeBytes: a.sizeBytes } : {}),
      ...(a.artifactId ? { artifactId: a.artifactId } : {}),
    }));
}

type HistoryAttachment = Pick<Attachment, "id" | "type" | "fileName" | "mimeType"> & {
  size?: number;
  artifactId?: string;
};

export interface HistoryUserMessage {
  role: "user" | "user-with-attachments";
  runId?: string;
  entrySeq?: number;
  content: string;
  timestamp?: number;
  attachments?: HistoryAttachment[];
  steered?: boolean;
  speaker?: string;
  speakerId?: string;
  ts?: string;
  edited?: boolean;
  deleted?: boolean;
  subagentMail?: SubagentMailRef;
}

export interface SubagentMailRef {
  sessionId: string;
  title: string;
  kind: string;
}

const SUBAGENT_MAIL_RE = /^<wake reason="subagent" name="([^"]*)" sessionId="([^"]*)" kind="([^"]*)"/;

const XML_ENTITIES: Record<string, string> = { "&quot;": '"', "&lt;": "<", "&gt;": ">", "&amp;": "&" };

function subagentMailOf(text: string | null): SubagentMailRef | undefined {
  const m = text === null ? null : SUBAGENT_MAIL_RE.exec(text);
  if (!m) return undefined;
  return { title: m[1]!.replace(/&(?:quot|lt|gt|amp);/g, (e) => XML_ENTITIES[e]!), sessionId: m[2]!, kind: m[3]! };
}

interface MessageRevisionNote {
  role: "system-note";
  note: "message_revision";
  action: "edited" | "deleted";
  ts: string;
  content: string;
  speaker?: string;
  timestamp?: number;
}

interface GoalCancelledNote {
  role: "system-note";
  note: "goal_cancelled";
  content: string;
  timestamp?: number;
}

export type HistorySystemNote = MessageRevisionNote | GoalCancelledNote;

export interface HistoryApprovalDecision {
  role: "approval-decision";
  entrySeq?: number;
  requestId?: string;
  approved: boolean;
  command: string;
  scope?: string;
  timestamp: number;
}

function approvalDecisionMessage(item: Item): HistoryApprovalDecision | null {
  if (item.kind !== "ElicitationResponse") return null;
  const { command, scope } = item.body;
  if (typeof item.approved !== "boolean" || typeof command !== "string") return null;
  return {
    role: "approval-decision",
    entrySeq: item.seq,
    approved: item.approved,
    command,
    requestId: item.elicitId,
    ...(typeof scope === "string" ? { scope } : {}),
    timestamp: item.createdAt,
  };
}

export function messagesWithStreaming(messages: AgentMessage[], streaming?: AgentMessage | null): AgentMessage[] {
  const source = streaming ? [...messages, streaming] : messages;
  const out: AgentMessage[] = [];
  const recorded = source.filter(
    (message) => (message as { role: string }).role === "approval-decision",
  ) as unknown as HistoryApprovalDecision[];
  for (const message of source) {
    for (const item of activityItems((message as AssistantWork).work?.activity ?? [])) {
      const decision = approvalDecisionMessage(item);
      if (
        !decision ||
        recorded.some(
          (existing) =>
            existing.timestamp === decision.timestamp &&
            (decision.requestId
              ? existing.requestId === decision.requestId
              : existing.command === decision.command && existing.approved === decision.approved),
        )
      )
        continue;
      out.push(decision as unknown as AgentMessage);
      recorded.push(decision);
    }
    out.push(message);
  }
  return out.map((message) => {
    const assistant = message as AssistantWork;
    const work = assistant.work;
    if (!work?.pendingApprovals?.length) return message;
    const requestedAt = work.activity.length ? Math.max(...work.activity.map(activityCreatedAt)) : assistant.timestamp;
    const pendingApprovals = work.pendingApprovals.filter(
      (approval) =>
        !recorded.some((decision) => decision.requestId === approval.requestId && decision.timestamp >= requestedAt),
    );
    if (pendingApprovals.length === work.pendingApprovals.length) return message;
    return { ...assistant, work: { ...work, pendingApprovals } };
  });
}

function goalCancelledNote(item: Item): GoalCancelledNote | null {
  if (item.kind !== "Wake" || item.body.kind !== "goal_cancelled" || typeof item.body.objective !== "string")
    return null;
  return { role: "system-note", note: "goal_cancelled", content: item.body.objective };
}

function messageRevisionNote(item: Item): MessageRevisionNote | null {
  if (item.kind !== "Retraction") return null;
  const { action, ts, text, name } = item.body;
  if (action !== "edited" && action !== "deleted") return null;
  if (typeof ts !== "string" || !ts) return null;
  return {
    role: "system-note",
    note: "message_revision",
    action,
    ts,
    content: typeof text === "string" ? text : "",
    ...(typeof name === "string" && name.trim() ? { speaker: name.trim() } : {}),
  };
}

function userItemText(item: Item): string | null {
  const display = item.body.display;
  if (typeof display === "string" && display.trim()) return display;
  return item.text?.trim() ? item.text : null;
}

type UserAttachment = { name?: string; mimetype?: string; sizeBytes?: number; artifactId?: string };

export function userItemMessage(item: Item): HistoryUserMessage | null {
  if (isHidden(item)) return null;
  const text = userItemText(item) ?? "";
  const attachments = Array.isArray(item.body.attachments) ? (item.body.attachments as UserAttachment[]) : [];
  if (!text && !attachments.length) return null;
  const mail = subagentMailOf(item.text);
  const { name, speakerId } = item.body;
  const ts = messageTs(item);
  return {
    role: "user",
    ...(item.turnId !== null ? { runId: item.turnId } : {}),
    entrySeq: item.seq,
    content: text,
    timestamp: item.createdAt,
    ...(mail ? { subagentMail: mail } : {}),
    ...(item.kind === "SteeringMessage" ? { steered: true } : {}),
    ...(typeof speakerId === "string" && speakerId ? { speakerId } : {}),
    ...(typeof name === "string" && name.trim() ? { speaker: name.trim() } : {}),
    ...(ts ? { ts } : {}),
    ...(attachments.length ? { attachments: historyAttachments(attachments, String(item.seq)) } : {}),
  };
}

function historyAttachments(list: UserAttachment[], idPrefix: string): HistoryAttachment[] {
  return list.map((a, i) => ({
    id: a.artifactId ?? `${idPrefix}:${i}`,
    type: a.mimetype?.startsWith("image/") ? "image" : "document",
    fileName: a.name ?? "file",
    mimeType: a.mimetype ?? "application/octet-stream",
    ...(typeof a.sizeBytes === "number" ? { size: a.sizeBytes } : {}),
    ...(a.artifactId ? { artifactId: a.artifactId } : {}),
  }));
}

export function appendConsumedSteers(messages: AgentMessage[], work: WorkBlock): void {
  const recorded = new Set(messages.map((message) => (message as { entrySeq?: number }).entrySeq));
  for (const item of activityItems(work.activity)) {
    if (item.kind !== "SteeringMessage" || recorded.has(item.seq)) continue;
    const message = userItemMessage(item);
    if (!message) continue;
    messages.push(message as AgentMessage);
    recorded.add(item.seq);
  }
}

const SILENCE_TOOLS = new Set(["finish_silently", "stay_silent"]);

function deliveredSilence(item: Item): boolean {
  if (item.kind !== "ToolResult") return false;
  return (
    (item.tool === "finish_silently" && item.body.silent === true) ||
    (item.tool === "stay_silent" && item.body.ok === true)
  );
}

function isFinishedReplyItem(item: Item): boolean {
  return isNarration(item) && stepMessage(item)?.stopReason === "stop" && Boolean(item.text?.trim());
}

export function isWorkHistoryItem(item: Item): boolean {
  if (item.kind === "Reasoning") return isRenderableThinking(item);
  return item.kind === "ToolCall" || item.kind === "ToolResult" || item.kind === "Elicitation" || isNarration(item);
}

export function itemsToMessages(items: Item[], model?: Model<Api>): AgentMessage[] {
  const out: AgentMessage[] = [];
  const userByTs = new Map<string, HistoryUserMessage>();
  let pending: Item[] = [];
  let deliveryFiles: DeliveredFile[] = [];
  let posted = false;
  let stoppedShown = false;
  let hiddenPrompt = false;
  const heldPosts = new Map<string, { text: string; item: Item }>();
  const spillHeldPosts = (): void => {
    for (const held of heldPosts.values()) pending.push(held.item);
    heldPosts.clear();
  };
  const filesOf = (item: Item): DeliveredFile[] =>
    deliveredFilesFromAttachments(item.body.files as UserAttachment[] | undefined);
  const appendDeliveryFiles = (files: DeliveredFile[]): void => {
    const last = out.at(-1) as AssistantWork | undefined;
    if (files.length && last?.role === "assistant") last.deliveredFiles = [...(last.deliveredFiles ?? []), ...files];
    else deliveryFiles.push(...files);
  };
  const appendAttachedFiles = (result: Item): void => {
    const files = filesOf(result);
    const restaged = new Set(files.map((f) => f.name));
    deliveryFiles = [...deliveryFiles.filter((f) => !restaged.has(f.name)), ...files];
  };
  const flushWork = (
    text: string,
    at?: number,
    closed = false,
    timing?: { startedAt?: number; finishedAt?: number },
    stopped = false,
    entrySeqs: number[] = [],
  ): void => {
    if (!text && !pending.length && !deliveryFiles.length && !stopped) return;
    if (stopped) stoppedShown = true;
    if (hiddenPrompt && !text && !stopped && pending.some(deliveredSilence)) {
      pending = pending.filter((item) => !SILENCE_TOOLS.has(item.tool ?? ""));
      if (!pending.some((item) => item.kind === "ToolCall") && !deliveryFiles.length) {
        pending = [];
        return;
      }
    }
    entrySeqs = [...entrySeqs, ...pending.map((item) => item.seq)];
    const lastText = pending.findLastIndex(isNarration);
    if (lastText >= 0) {
      const segment = (pending[lastText]!.text ?? "").trim();
      if (text) {
        if (segment === text.trim() && pending[lastText]!.body.phase !== "commentary") pending.splice(lastText, 1);
      } else if (closed && !stopped && segment && !pending.some(deliveredSilence)) {
        text = segment;
        pending.splice(lastText, 1);
      }
    }
    const msg: AssistantWork = {
      ...baseAssistant(model, 0, text),
      persisted: true,
      ...(entrySeqs.length ? { entrySeqs } : {}),
      stopReason: stopped ? "aborted" : "stop",
      timestamp: at ?? pending[pending.length - 1]?.createdAt,
    };
    if (pending.length || (stopped && timing?.startedAt !== undefined)) {
      const boundary = pending.findLast((item) => typeof item.body.workStartedAt === "number")?.body.workStartedAt as
        number | undefined;
      msg.work = {
        status: "complete",
        startedAt: timing?.startedAt ?? boundary ?? pending[0]?.createdAt,
        finishedAt: timing?.finishedAt ?? at ?? pending[pending.length - 1]?.createdAt,
        activity: pending.map((item) => ({ item })),
      };
    }
    if (deliveryFiles.length) msg.deliveredFiles = deliveryFiles;
    out.push(msg as AgentMessage);
    pending = [];
    deliveryFiles = [];
  };
  for (const e of items) {
    const text = e.text ?? "";
    const note = goalCancelledNote(e) ?? messageRevisionNote(e);
    if (e.kind === "ElicitationResponse") {
      const decision = approvalDecisionMessage(e);
      if (decision) {
        spillHeldPosts();
        flushWork("", e.createdAt);
        out.push(decision as unknown as AgentMessage);
      }
      continue;
    }
    if (isFinishedReplyItem(e)) {
      spillHeldPosts();
      flushWork(text, e.createdAt, true, undefined, false, [e.seq]);
      posted = false;
      continue;
    }
    if (isWorkHistoryItem(e)) {
      if (e.kind === "ToolCall") {
        const postText = postCallText(e);
        if (postText !== null && e.callId) {
          heldPosts.set(e.callId, { text: postText, item: e });
          continue;
        }
      }
      if (e.kind === "ToolResult" && e.callId && heldPosts.has(e.callId)) {
        const held = heldPosts.get(e.callId)!;
        heldPosts.delete(e.callId);
        if (postResultOk(e)) {
          deliveryFiles.push(...filesOf(e));
          flushWork(held.text, e.createdAt, false, undefined, false, [held.item.seq, e.seq]);
          posted = true;
        } else {
          pending.push(held.item, e);
        }
        continue;
      }
      if (e.kind === "ToolResult" && e.tool === "attach" && postResultOk(e)) appendAttachedFiles(e);
      pending.push(e);
      continue;
    }
    if (isUserMessage(e)) {
      const steered = e.kind === "SteeringMessage";
      if (!steered) {
        stoppedShown = false;
        hiddenPrompt = e.hidden === true;
      }
      if (isHidden(e)) continue;
      if (!steered) {
        posted = false;
        spillHeldPosts();
        flushWork("", e.createdAt);
      }
      const msg = userItemMessage(e);
      if (msg) {
        if (msg.ts) userByTs.set(msg.ts, msg);
        if (steered) pending.push(e);
        out.push(msg as AgentMessage);
      }
    } else if (e.kind === "AgentMessage" && e.variant === null) {
      const { workStartedAt, workFinishedAt } = e.body;
      const timing = {
        ...(typeof workStartedAt === "number" ? { startedAt: workStartedAt } : {}),
        ...(typeof workFinishedAt === "number" ? { finishedAt: workFinishedAt } : {}),
      };
      const stopped = e.body.stopped === true || text.trim() === "(stopped)";
      if (text || pending.length || heldPosts.size || stopped) {
        spillHeldPosts();
        if (posted && text) {
          pending.push({ ...e, variant: "narration", body: { demoted: true } });
          flushWork("", e.createdAt, false, timing, stopped, [e.seq]);
        } else {
          flushWork(text, e.createdAt, !posted, timing, stopped, [e.seq]);
        }
      }
      posted = false;
    } else if (e.kind === "AgentMessage" && e.variant === "files_delivered") {
      appendDeliveryFiles(filesOf(e));
    } else if (e.kind === "Stop") {
      spillHeldPosts();
      if (pending.length || !stoppedShown) flushWork("", e.createdAt, !posted, undefined, true, [e.seq]);
      posted = false;
    } else if (note || (e.kind === "Error" && e.text)) {
      spillHeldPosts();
      flushWork("", e.createdAt);
      const original = note?.note === "message_revision" ? userByTs.get(note.ts) : undefined;
      if (original && note?.note === "message_revision") original[note.action] = true;
      out.push(
        (note
          ? { ...note, timestamp: e.createdAt }
          : { ...baseAssistant(model, e.createdAt), stopReason: "error", errorMessage: e.text }) as AgentMessage,
      );
    }
  }
  spillHeldPosts();
  flushWork("");
  return out;
}

export function attachPendingApprovals(
  messages: AgentMessage[],
  approvals: PendingApproval[],
  model?: Model<Api>,
): void {
  approvals = unresolvedApprovals(approvals);
  if (!approvals.length) return;

  const turnForCommand = (command: string): AssistantWork | undefined =>
    (messages as AssistantWork[]).findLast(
      (m) =>
        m.role === "assistant" &&
        activityItems(m.work?.activity ?? []).some((item) => item.kind === "ToolCall" && item.body.command === command),
    );

  let trailing: AssistantWork | undefined;
  const trailingTurn = (): AssistantWork => {
    if (trailing) return trailing;
    const tail = messages[messages.length - 1] as AssistantWork | undefined;
    if (tail && tail.role === "assistant") return (trailing = tail);
    trailing = baseAssistant(model);
    messages.push(trailing as AgentMessage);
    return trailing;
  };

  for (const approval of approvals) {
    const target = turnForCommand(approval.command) ?? trailingTurn();
    if (!target.work) target.work = { status: "complete", activity: [] };
    (target.work.pendingApprovals ??= []).push(approval);
  }
}

export function latestUserMessage(agent: Agent): WebUserMessage | undefined {
  return agent.state.messages.findLast(isUserRole) as WebUserMessage | undefined;
}
