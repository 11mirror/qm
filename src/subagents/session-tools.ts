import { sessionTurnOrigin } from "../core/turn-origin.ts";
import type { SessionMailbox, SessionMessage } from "../sessions/session-mailbox.ts";
import { sleep } from "../util/async.ts";
import { pgTextSafe } from "../util/text.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { errMessage } from "../util/errors.ts";
import { randomUUID } from "node:crypto";
import { hashId } from "../util/crypto.ts";
import { canonicalJson } from "../../cli/src/canonical-json.ts";
import type { CoreSearch } from "../search/core-search.ts";
import { type ScopeId, type Session, type SpawnMeta, turnSource } from "../types.ts";
import { isReply, proseText, type Item } from "../sessions/items.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import { type RunStore } from "../runs/run-store.ts";
import type { RunSignalStore } from "../runs/run-signal-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { xmlAttrEscape, xmlEscape } from "../util/message-tag.ts";
import type { SwarmBoard } from "../swarms/swarm-board.ts";
import { swarmCall, type SwarmInput, type SwarmResult } from "../swarms/swarm.ts";
import { SUBAGENT_THREAD_PREFIX, isSubagentThreadRef } from "../sessions/thread-ref.ts";
import { itemVisibleToAll, snippet, assertAudienceCompatible } from "./audience.ts";
import {
  SUBAGENT_TREE_RUN_CAP,
  sessionRunCancelled,
  sessionTreeRoot,
  sessionTreeRunCount,
  stopSessionTree,
} from "./tree.ts";

const SESSION_MESSAGE_DEPTH_CAP = 8;
const READ_DEFAULT_LIMIT = 30;
const SESSION_LIST_LIMIT = 50;
const WEB_ONLY = "sessions are a web UI feature and aren't available here.";
const READ_DEFAULT_MAX_CHARS = 4_000;
const READ_MAX_CHARS_CEILING = 20_000;
const LAST_SAID_SCAN = 40;
/** Messages handed to the agent per receive call; the rest stay pending for the next call. */
const RECEIVE_BATCH_MAX = 4;

interface SessionOpenInput {
  requestId?: string;
  task: string;
  name?: string;
  readOnly?: boolean;
  model?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
}

type SessionOpenResult =
  { ok: true; sessionId: string; title: string; liveRunsRemaining: number } | { ok: false; message: string };

interface SessionWriteInput {
  target: string;
  peer?: boolean;
  text?: string;
  interrupt?: boolean;
  followup?: boolean;
  requestId?: string;
}

type SessionWriteResult =
  | {
      ok: true;
      sessionId: string;
      title: string;
      delivered: "steered" | "queued_turn" | "interrupted" | "queued_message";
    }
  | { ok: false; message: string };

interface SessionReadInput {
  target?: string;
  peer?: boolean;
  limit?: number;
  maxChars?: number;
}

interface SessionChildSummary {
  sessionId: string;
  title: string;
  status: "running" | "pending" | "idle";
  lastSaid?: string;
}

interface SessionStartInput {
  fork: boolean;
  text?: string;
  title?: string;
}

type SessionStartResult =
  { ok: true; sessionId: string; title: string; refused?: string } | { ok: false; message: string };

interface SessionSummary {
  sessionId: string;
  title: string;
  status: "running" | "pending" | "idle";
  current: boolean;
}

type SessionListResult = { ok: true; sessions: SessionSummary[] } | { ok: false; message: string };

type SessionReadResult =
  | { ok: true; mode: "children"; children: SessionChildSummary[] }
  | { ok: true; mode: "transcript"; sessionId: string; title: string; status: string; rendered: string }
  | { ok: false; message: string };

interface SessionSyscallBinding {
  session: Session;
  scopeId: ScopeId;
  orgScopeId?: ScopeId;
  liveTurn?: boolean;
  request: Pick<
    OrchestratorInput,
    | "cancel"
    | "surface"
    | "surfaceTools"
    | "deliveryCandidates"
    | "unattendedGrants"
    | "privateSessionMessage"
    | "sessionMessageDepth"
    | "runId"
    | "conversation"
    | "actor"
    | "deliveryTarget"
    | "timezone"
    | "readOnly"
    | "scopeVersion"
    | "sessionParticipantIds"
    | "source"
    | "slackSource"
    | "externalSlack"
  > & { origin?: OrchestratorInput["origin"] };
}

export interface SessionSyscalls {
  receive?(timeoutMs?: number): Promise<SessionMessage[]>;
  acknowledge?(ids: string[]): Promise<void>;
  open(input: SessionOpenInput): Promise<SessionOpenResult>;
  write(input: SessionWriteInput): Promise<SessionWriteResult>;
  read(input: SessionReadInput): Promise<SessionReadResult>;
  search?(input: { query: string; limit?: number }): ReturnType<CoreSearch["search"]>;
  list?(): Promise<SessionListResult>;
  start?(input: SessionStartInput): Promise<SessionStartResult>;
  swarm?(input: SwarmInput): Promise<SwarmResult>;
}

export interface SessionSyscallsFactory {
  rejectMessage?(sessionId: string, messageId: string): Promise<void>;
  forTurn(binding: SessionSyscallBinding): SessionSyscalls;
}

export interface SessionSyscallDeps {
  mailbox: SessionMailbox;
  board?: SwarmBoard;
  enabled?: (actorId: string) => Promise<boolean>;
  sessions: Pick<
    SessionStore,
    | "get"
    | "getByThread"
    | "getOrCreateByThread"
    | "setParentSession"
    | "setSpawnMeta"
    | "childrenOf"
    | "descendantsOf"
    | "addParticipant"
    | "updateTitle"
    | "getItems"
    | "latestItemSeq"
    | "visibleItems"
    | "getForParticipant"
  >;
  runs: Pick<RunStore, "enqueue" | "inFlightForThread" | "latestForThread" | "getByDedupKey" | "get" | "withdraw">;
  signals: Pick<RunSignalStore, "send" | "pending">;
  maxAttempts: number;
  treeRunCap?: number;
  advisoryLock: AdvisoryLock;
  prepareRequest?: (request: OrchestratorInput) => Promise<OrchestratorInput>;
  authorize?: (session: Session, actorId: string) => Promise<boolean>;
  validateRuntime?: (input: SessionOpenInput, scopeId: ScopeId) => Promise<void>;
  conversations?: {
    search?: CoreSearch["search"];
    list(actorId: string): Promise<Session[]>;
    start(
      actorId: string,
      input: {
        scopeId: ScopeId;
        forkOf?: string;
        text?: string;
        title?: string;
        origin?: OrchestratorInput["origin"];
        sessionSenderId?: string;
        delegatingRunId?: string;
      },
    ): Promise<{ session: Session; refused?: string } | { error: string }>;
  };
}

function autoTitle(task: string): string {
  const line = task.trim().split("\n")[0] ?? "";
  return line.length <= 60 ? line : `${line.slice(0, 57).trimEnd()}…`;
}

function itemText(item: Item): string | undefined {
  const text = proseText(item);
  if (text?.trim()) return text;
  if (item.tool) return `[${item.tool}]`;
  return undefined;
}

function lastAssistantText(items: readonly Item[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const e = items[i]!;
    if (e.kind === "Stop") {
      const before = items[i - 1];
      const partial = before && isReply(before) ? itemText(before) : "";
      const reason = e.body.reason;
      return partial || `[system] Subagent stopped${typeof reason === "string" ? ` ${reason}` : ""}. No reply.`;
    }
    if (e.kind !== "AgentMessage" || e.variant === "files_delivered") continue;
    const text = itemText(e);
    if (text) return text;
  }
  return undefined;
}

function renderSubagentTask(input: { title: string; parentTitle: string; task: string }): string {
  return [
    `<subagent-task session="${xmlAttrEscape(input.title)}">`,
    `You are the subagent session "${input.title}", spawned from the conversation "${input.parentTitle}". To message your parent use subagents send_message with target="parent"; use an exact sibling title or sessionId for peers, never filesystem paths. When your turn ends, your final message is delivered to your current parent session — make it the result, stated plainly. Your parent can change while you work; detached sessions have no automatic return. Use your judgment on details within the task's real limits; if an instruction seems to work against the goal, follow the goal and say so. Do not contact people, post to conversations, or change standing configuration unless the task says to. If you are blocked, end your turn saying exactly what you need.`,
    "",
    "<task>",
    input.task.trim(),
    "</task>",
    "</subagent-task>",
  ].join("\n");
}

function renderSubagentMessage(sender: { title: string; sessionId: string }, text: string): string {
  return [
    `<subagent-message from="${xmlAttrEscape(sender.title)}" fromSessionId="${sender.sessionId}">`,
    xmlEscape(text.trim()),
    "</subagent-message>",
  ].join("\n");
}

function childRunRequest(child: Session, meta: SpawnMeta, text: string, displayText: string): OrchestratorInput {
  return {
    ...(meta.scopeVersion ? { scopeVersion: meta.scopeVersion } : {}),
    ...(meta.sessionParticipantIds ? { sessionParticipantIds: meta.sessionParticipantIds } : {}),
    surface: meta.surface,
    ...(turnSource(meta) ? { source: turnSource(meta) } : {}),
    ...(meta.externalSlack ? { externalSlack: meta.externalSlack } : {}),
    ...(meta.deliveryTarget ? { deliveryTarget: meta.deliveryTarget } : {}),
    ...(meta.deliveryCandidates ? { deliveryCandidates: meta.deliveryCandidates } : {}),
    actor: meta.actor,
    conversation: { ...meta.conversation, threadRef: child.threadRef },
    origin: sessionTurnOrigin(meta.origin, text),
    ...(meta.unattendedGrants ? { unattendedGrants: [...meta.unattendedGrants] } : {}),
    text,
    displayText,
    envelopeWrapped: true,
    ...(meta.readOnly ? { readOnly: true } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.thinkingLevel ? { thinkingLevel: meta.thinkingLevel } : {}),
    ...(meta.fastMode !== undefined ? { fastMode: meta.fastMode } : {}),
    ...(meta.timezone ? { timezone: meta.timezone } : {}),
  };
}

export function createSessionSyscalls(deps: SessionSyscallDeps): SessionSyscallsFactory {
  const lock = deps.advisoryLock;
  /** Opens and writes that add runs to one session tree queue behind each other; other trees go on in parallel. */
  const admissionKey = (root: Session) => `session-tree-admission:${root.id}`;
  const cap = deps.treeRunCap ?? SUBAGENT_TREE_RUN_CAP;

  return {
    rejectMessage: (sessionId, messageId) => deps.mailbox.acknowledge(sessionId, [messageId]),
    forTurn(binding) {
      const callerTitle = binding.session.title?.trim() || "this conversation";

      async function resolveTarget(ref: string): Promise<Session | null> {
        const trimmed = ref.trim();
        if (!trimmed) return null;
        const current = await deps.sessions.get(binding.session.id);
        if (trimmed.toLowerCase() === "parent")
          return current?.parentSessionId ? deps.sessions.get(current.parentSessionId) : null;
        const byId = await deps.sessions.get(trimmed);
        if (byId) return byId;
        const byThread = await deps.sessions.getByThread(trimmed);
        if (byThread) return byThread;
        const children = await deps.sessions.childrenOf(binding.session.id);
        const siblings = current?.parentSessionId ? await deps.sessions.childrenOf(current.parentSessionId) : [];
        return [...children, ...siblings].find((c) => c.title?.trim().toLowerCase() === trimmed.toLowerCase()) ?? null;
      }

      function sidebarRefusal(): string | null {
        if (binding.request.surface !== "web") return WEB_ONLY;
        return null;
      }

      function peerRefusal(target: Session): string | null {
        const refusal = sidebarRefusal();
        if (refusal) return refusal;
        if (target.parentSessionId || isSubagentThreadRef(target.threadRef))
          return `"${target.title?.trim() || target.id}" is a subagent, not a session — use the subagents tool for it.`;
        return null;
      }

      async function statusOf(session: Session): Promise<"running" | "pending" | "idle"> {
        const inFlight = await deps.runs.inFlightForThread(session.threadRef);
        if (inFlight.some((r) => r.status === "running")) return "running";
        return inFlight.length ? "pending" : "idle";
      }

      const visibleTitle = (target: Session) => target.title?.trim() || target.id;
      async function visibleHistory(target: Session, limit: number): Promise<Item[]> {
        const audience = binding.request.conversation.audience.length
          ? binding.request.conversation.audience
          : [binding.request.actor];
        return deps.sessions.visibleItems(target.id, [binding.request.actor.id, ...audience.map((p) => p.id)], {
          limit,
        });
      }

      async function currentCaller(): Promise<OrchestratorInput> {
        binding.request.cancel?.throwIfAborted();
        if (await sessionRunCancelled(deps.runs, deps.signals, binding.request.runId))
          throw new Error("this delegated task was stopped");
        if (deps.enabled && !(await deps.enabled(binding.request.actor.id)))
          throw new Error("persistent subagents are not enabled for this user");
        const current = await deps.sessions.get(binding.session.id);
        if (
          !current ||
          current.scopeId !== binding.scopeId ||
          (deps.authorize && !(await deps.authorize(current, binding.request.actor.id)))
        )
          throw new Error("the sender no longer has access to this session");
        const request: OrchestratorInput = {
          ...binding.request,
          origin: binding.request.origin ?? { kind: "automation" },
          text: "",
        };
        return deps.prepareRequest ? deps.prepareRequest(request) : request;
      }

      const syscalls: SessionSyscalls = {
        async receive(timeoutMs = 0) {
          const deadline = Date.now() + Math.min(60_000, Math.max(0, timeoutMs));
          do {
            binding.request.cancel?.throwIfAborted();
            const caller = await currentCaller();
            const messages = await deps.mailbox.pending(binding.session.id);
            const visible: SessionMessage[] = [];
            for (const message of messages) {
              const sender = await deps.sessions.getForParticipant(message.senderId, caller.actor.id);
              if (!sender || sender.scopeId !== binding.scopeId) continue;
              if (deps.authorize && !(await deps.authorize(sender, caller.actor.id))) continue;
              try {
                assertAudienceCompatible(
                  { actor: message.actor, conversation: { ...caller.conversation, audience: message.audience } },
                  caller,
                );
              } catch {
                continue;
              }
              if (
                message.sourceEntrySeq !== undefined &&
                !(await itemVisibleToAll(deps.sessions, sender.id, message.sourceEntrySeq, [
                  caller.actor.id,
                  ...caller.conversation.audience.map((person) => person.id),
                ]))
              )
                continue;
              visible.push(message);
              if (visible.length >= RECEIVE_BATCH_MAX) break;
            }
            if (visible.length || Date.now() >= deadline) return visible;
            await sleep(Math.min(250, deadline - Date.now()));
          } while (Date.now() <= deadline);
          return [];
        },
        async acknowledge(ids) {
          await deps.mailbox?.acknowledge(binding.session.id, ids);
        },
        async open(input) {
          return (async () => {
            const threadRef = `${SUBAGENT_THREAD_PREFIX}${
              input.requestId
                ? hashId([binding.session.id, binding.request.runId ?? "", input.requestId], 40)
                : randomUUID()
            }`;
            // Count against the tree the child already sits in (a retried child may have been detached).
            const placed =
              (await deps.sessions.getByThread(threadRef)) ?? (await deps.sessions.get(binding.session.id));
            const root = placed ? await sessionTreeRoot(deps.sessions, placed) : binding.session;
            return lock.withLock(admissionKey(root), async (): Promise<SessionOpenResult> => {
              const caller = await currentCaller();
              assertAudienceCompatible(binding.request, caller);
              if (binding.request.privateSessionMessage)
                throw new Error("private session messages cannot delegate new work");
              const task = input.task?.trim();
              if (!task)
                return { ok: false, message: "open requires a task: the full instruction the subagent works from." };
              await deps.validateRuntime?.(input, binding.scopeId);
              const fingerprint = hashId([canonicalJson(input)], 40);
              const existing = await deps.sessions.getByThread(threadRef);
              const live = await sessionTreeRunCount(deps.sessions, deps.runs, root);
              if (existing?.spawnMeta?.openFingerprint && existing.spawnMeta.openFingerprint !== fingerprint)
                throw new Error("the requestId was already used for different work");
              const initialRun = await deps.runs.getByDedupKey(`subagent-open:${threadRef}`);
              if (existing && initialRun)
                return {
                  ok: true,
                  sessionId: existing.id,
                  title: visibleTitle(existing),
                  liveRunsRemaining: Math.max(0, cap - live),
                };
              if (live >= cap) {
                return {
                  ok: false,
                  message: `all ${cap} subagent run slots for this conversation are in use — wait for one to finish, read their sessions, or interrupt one you no longer need.`,
                };
              }
              const child = await deps.sessions.getOrCreateByThread(
                threadRef,
                binding.session.type,
                binding.scopeId,
                binding.session.channelName,
                binding.session.surface ?? binding.request.surface,
              );
              const title = existing ? visibleTitle(existing) : input.name?.trim() || autoTitle(task);
              const meta: SpawnMeta = {
                origin: caller.origin,
                ...(binding.request.surfaceTools ? { surfaceTools: true } : {}),
                ...(binding.request.deliveryCandidates
                  ? { deliveryCandidates: binding.request.deliveryCandidates }
                  : {}),
                ...(caller.unattendedGrants ? { unattendedGrants: [...caller.unattendedGrants] } : {}),
                openFingerprint: fingerprint,
                ...(turnSource(binding.request) ? { source: turnSource(binding.request) } : {}),
                ...(binding.request.externalSlack ? { externalSlack: binding.request.externalSlack } : {}),
                ...(binding.request.scopeVersion ? { scopeVersion: binding.request.scopeVersion } : {}),
                ...(binding.request.sessionParticipantIds
                  ? { sessionParticipantIds: binding.request.sessionParticipantIds }
                  : {}),
                surface: binding.request.surface ?? binding.session.surface ?? "web",
                conversation: binding.request.conversation,
                actor: binding.request.actor,
                ...(binding.request.deliveryTarget ? { deliveryTarget: binding.request.deliveryTarget } : {}),
                ...(binding.request.timezone ? { timezone: binding.request.timezone } : {}),
                ...(input.readOnly || binding.request.readOnly ? { readOnly: true } : {}),
                ...(input.model ? { model: input.model } : {}),
                ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
                ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
              };
              if (!existing?.spawnMeta) {
                await deps.sessions.setParentSession(child.id, binding.session.id);
                await deps.sessions.setSpawnMeta(child.id, meta);
              }
              for (const id of new Set([
                binding.request.actor.id,
                ...(binding.request.sessionParticipantIds ?? binding.request.conversation.audience.map((p) => p.id)),
              ]))
                await deps.sessions.addParticipant(child.id, id);
              await deps.sessions.updateTitle(child.id, title);
              const text = renderSubagentTask({ title, parentTitle: callerTitle, task });
              const request = {
                ...childRunRequest(child, meta, text, task),
                sessionSenderId: binding.session.id,
                ...(binding.request.runId ? { delegatingRunId: binding.request.runId } : {}),
              };
              await deps.runs.enqueue({
                sessionId: child.threadRef,
                dedupKey: `subagent-open:${threadRef}`,
                request: deps.prepareRequest ? await deps.prepareRequest(request) : request,
                maxAttempts: deps.maxAttempts,
              });
              return { ok: true, sessionId: child.id, title, liveRunsRemaining: Math.max(0, cap - live - 1) };
            });
          })().catch((error): SessionOpenResult => ({ ok: false, message: errMessage(error) }));
        },

        async write(input) {
          return (async () => {
            const target = await resolveTarget(input.target);
            const root = target ? await sessionTreeRoot(deps.sessions, target) : binding.session;
            return lock.withLock(admissionKey(root), async (): Promise<SessionWriteResult> => {
              const caller = await currentCaller();
              assertAudienceCompatible(binding.request, caller);
              if (!target)
                return {
                  ok: false,
                  message: `no session matches "${input.target}" — use a sessionId from open, read, or list.`,
                };
              const refusal = input.peer ? peerRefusal(target) : null;
              if (refusal) return { ok: false, message: refusal };
              if (target.id === binding.session.id)
                return { ok: false, message: "a session cannot message itself — just continue your turn." };
              if (target.scopeId !== binding.scopeId)
                return {
                  ok: false,
                  message: "that session lives in a different context and cannot be reached from here.",
                };
              if (!(await deps.sessions.getForParticipant(target.id, binding.request.actor.id)))
                return { ok: false, message: "you are not a participant in that session." };
              if (deps.authorize && !(await deps.authorize(target, caller.actor.id)))
                return { ok: false, message: "you no longer have access to the target session" };
              const previous = await deps.runs.latestForThread(target.threadRef, { excludePrivateMessages: true });
              const meta = previous?.request ?? target.spawnMeta;
              if (!meta) return { ok: false, message: "the target has no verified runtime context yet" };
              const privateChild = isSubagentThreadRef(target.threadRef);
              const privateMessage = binding.request.privateSessionMessage === true || !privateChild;
              const messageDepth = (binding.request.sessionMessageDepth ?? 0) + 1;
              if (privateMessage && messageDepth > SESSION_MESSAGE_DEPTH_CAP)
                throw new Error("private session message reply limit reached");
              const prepared = childRunRequest(
                target,
                {
                  ...meta,
                  ...(target.parentSessionId
                    ? {
                        model: target.spawnMeta?.model,
                        thinkingLevel: target.spawnMeta?.thinkingLevel,
                        fastMode: target.spawnMeta?.fastMode,
                      }
                    : {}),
                  surface: meta.surface ?? target.surface ?? "web",
                  actor: caller.actor,
                  origin: caller.origin,
                  unattendedGrants: caller.unattendedGrants,
                  readOnly: privateMessage || caller.readOnly || meta.readOnly || target.spawnMeta?.readOnly,
                },
                "",
                "",
              );
              const request = deps.prepareRequest ? await deps.prepareRequest(prepared) : prepared;
              assertAudienceCompatible(caller, request);
              const title = visibleTitle(target);
              if (input.interrupt) {
                if (privateMessage)
                  return { ok: false, message: "ordinary sessions accept private messages, not interrupts" };
                if (caller.readOnly && !target.spawnMeta?.readOnly)
                  return { ok: false, message: "a read-only session cannot interrupt a writable task" };
                const stopped = await stopSessionTree(deps, target, "by the parent agent");
                return stopped
                  ? { ok: true, sessionId: target.id, title, delivered: "interrupted" }
                  : { ok: false, message: `subagent "${title}" is not running — nothing to interrupt.` };
              }
              const text = input.text?.trim();
              if (!text)
                return {
                  ok: false,
                  message: input.followup
                    ? "followup_task requires `task`: the full instruction the subagent works from."
                    : "send_message requires `text` (or interrupt: true).",
                };
              if (text.length > 16_000) return { ok: false, message: "message exceeds 16000 characters" };
              const stamped = renderSubagentMessage({ title: callerTitle, sessionId: binding.session.id }, text);
              if (!input.followup) {
                const sourceEntrySeq = await deps.sessions.latestItemSeq(binding.session.id);
                await deps.mailbox.send({
                  id: input.requestId
                    ? hashId([binding.session.id, binding.request.runId ?? "", input.requestId], 40)
                    : randomUUID(),
                  recipientId: target.id,
                  senderId: binding.session.id,
                  actor: caller.actor,
                  text: stamped,
                  ...(sourceEntrySeq >= 0 ? { sourceEntrySeq } : {}),
                  audience: caller.conversation.audience,
                  createdAt: Date.now(),
                });
                return { ok: true, sessionId: target.id, title, delivered: "queued_message" };
              }
              if (input.followup && binding.request.privateSessionMessage)
                return { ok: false, message: "private turns cannot assign follow-up work" };
              if (input.followup && !target.parentSessionId)
                return {
                  ok: false,
                  message: "follow-up tasks can only target an attached subagent; use a message for the root",
                };

              const dedupKey = input.requestId
                ? `subagent-followup:${hashId([binding.session.id, binding.request.runId ?? "", input.requestId], 40)}`
                : undefined;
              if (dedupKey) {
                const existing = await deps.runs.getByDedupKey(dedupKey);
                if (existing) {
                  if (
                    existing.sessionId !== target.threadRef ||
                    (existing.request.text !== stamped && existing.request.text !== pgTextSafe(stamped))
                  )
                    return { ok: false, message: "the requestId was already used for different work" };
                  return { ok: true, sessionId: target.id, title, delivered: "queued_turn" };
                }
              }
              request.origin = sessionTurnOrigin(request.origin, stamped);
              request.sessionSenderId = binding.session.id;
              request.delegatingRunId = binding.request.runId;
              if ((await sessionTreeRunCount(deps.sessions, deps.runs, root)) >= cap)
                return { ok: false, message: `all ${cap} session run slots are in use.` };
              await deps.runs.enqueue({
                sessionId: target.threadRef,
                dedupKey,
                request: {
                  ...request,
                  ...(privateMessage
                    ? { privateSessionMessage: true as const, sessionMessageDepth: messageDepth }
                    : {}),
                  text: stamped,
                  displayText: text,
                },
                maxAttempts: deps.maxAttempts,
              });
              return { ok: true, sessionId: target.id, title, delivered: "queued_turn" };
            });
          })().catch((error): SessionWriteResult => ({ ok: false, message: errMessage(error) }));
        },

        async read(input) {
          await currentCaller();
          if (!input.target?.trim()) {
            const children = await deps.sessions.childrenOf(binding.session.id);
            const summaries: SessionChildSummary[] = [];
            for (const child of children) {
              if (
                child.scopeId !== binding.scopeId ||
                !(await deps.sessions.getForParticipant(child.id, binding.request.actor.id))
              )
                continue;
              const entries = await visibleHistory(child, LAST_SAID_SCAN);
              const said = lastAssistantText(entries);
              summaries.push({
                sessionId: child.id,
                title: visibleTitle(child),
                status: await statusOf(child),
                ...(said ? { lastSaid: snippet(said, 200) } : {}),
              });
            }
            return { ok: true, mode: "children", children: summaries };
          }
          const target = await resolveTarget(input.target);
          if (!target)
            return {
              ok: false,
              message: `no session matches "${input.target}" — use a sessionId from open, read, or list.`,
            };
          const refusal = input.peer ? peerRefusal(target) : null;
          if (refusal) return { ok: false, message: refusal };
          if (target.scopeId !== binding.scopeId)
            return { ok: false, message: "that session lives in a different context and cannot be read from here." };
          const limit = Math.min(Math.max(1, input.limit ?? READ_DEFAULT_LIMIT), 200);
          const maxChars = Math.min(Math.max(200, input.maxChars ?? READ_DEFAULT_MAX_CHARS), READ_MAX_CHARS_CEILING);
          if (!(await deps.sessions.getForParticipant(target.id, binding.request.actor.id)))
            return { ok: false, message: "you are not a participant in that session." };
          const entries = await visibleHistory(target, limit);
          const lines: string[] = [];
          for (const entry of entries) {
            const text = itemText(entry);
            if (!text) continue;
            lines.push(`${entry.kind}#${entry.seq} ${snippet(text, 300)}`);
          }
          let rendered = lines.join("\n");
          if (rendered.length > maxChars) rendered = `…${rendered.slice(rendered.length - maxChars)}`;
          return {
            ok: true,
            mode: "transcript",
            sessionId: target.id,
            title: visibleTitle(target),
            status: await statusOf(target),
            rendered: rendered || "[no readable entries yet]",
          };
        },
        async search(input) {
          const caller = await currentCaller();
          const refusal = sidebarRefusal();
          if (refusal) throw new Error(refusal);
          const search = deps.conversations?.search;
          if (!search) throw new Error("session search isn't available on this deployment.");
          const members = caller.conversation.publishMembers;
          if (caller.conversation.kind !== "dm" && !members?.length)
            throw new Error("search requires the complete principal set for a shared conversation");
          if (!input.query.trim()) throw new Error("search requires a query");
          return search({
            query: input.query,
            principals: [caller.actor, ...(members ?? caller.conversation.audience)],
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          });
        },
        async list() {
          await currentCaller();
          const conversations = deps.conversations;
          if (!conversations) return { ok: false, message: "sessions aren't available on this deployment." };
          const refusal = sidebarRefusal();
          if (refusal) return { ok: false, message: refusal };
          const audience = binding.request.conversation.audience.length
            ? binding.request.conversation.audience
            : [binding.request.actor];
          const candidates = (await conversations.list(binding.request.actor.id)).filter(
            (s) =>
              s.scopeId === binding.scopeId && !s.parentSessionId && !isSubagentThreadRef(s.threadRef) && !s.archived,
          );
          const visible: Session[] = [];
          for (const session of candidates) {
            const seen = await Promise.all(
              audience.map((person) => deps.sessions.getForParticipant(session.id, person.id)),
            );
            if (seen.every(Boolean)) visible.push(session);
          }
          const recent = visible
            .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
            .slice(0, SESSION_LIST_LIMIT);
          const sessions: SessionSummary[] = [];
          for (const session of recent)
            sessions.push({
              sessionId: session.id,
              title: session.title?.trim() || "Untitled",
              status: await statusOf(session),
              current: session.id === binding.session.id,
            });
          return { ok: true, sessions };
        },
        async start(input) {
          try {
            await currentCaller();
          } catch (error) {
            return { ok: false, message: errMessage(error) };
          }
          const conversations = deps.conversations;
          if (!conversations) return { ok: false, message: "sessions aren't available on this deployment." };
          const refusal = sidebarRefusal();
          if (refusal) return { ok: false, message: refusal };
          const verb = input.fork ? "fork" : "new";
          if (binding.liveTurn !== true)
            return {
              ok: false,
              message: `${verb} needs a person attending this turn — not a cron, trigger, subagent, or other automation.`,
            };
          if (binding.request.readOnly) return { ok: false, message: "a read-only turn cannot create sessions." };
          const text = input.text?.trim();
          if (!input.fork && !text)
            return { ok: false, message: "new requires `text`: the new session's first message." };
          if (text && text.length > 16_000) return { ok: false, message: "text exceeds 16000 characters" };
          const out = await conversations
            .start(binding.request.actor.id, {
              scopeId: binding.scopeId,
              origin: binding.request.origin,
              sessionSenderId: binding.session.id,
              ...(binding.request.runId ? { delegatingRunId: binding.request.runId } : {}),
              ...(input.fork ? { forkOf: binding.session.id } : {}),
              ...(text ? { text } : {}),
              ...(input.title?.trim() ? { title: input.title.trim() } : {}),
            })
            .catch((error: unknown) => ({ error: errMessage(error) }));
          if ("error" in out) return { ok: false, message: out.error };
          return {
            ok: true,
            sessionId: out.session.id,
            title: out.session.title?.trim() || "Untitled",
            ...(out.refused ? { refused: out.refused } : {}),
          };
        },
      };
      const board = deps.board;
      if (board)
        syscalls.swarm = async (input) => {
          try {
            const caller = await currentCaller();
            const session = (await deps.sessions.get(binding.session.id)) ?? binding.session;
            return await swarmCall(
              {
                board,
                sessions: deps.sessions,
                mailbox: deps.mailbox,
                session,
                actor: caller.actor,
                audience: caller.conversation.audience,
                open: (member) => syscalls.open(member),
              },
              input,
            );
          } catch (error) {
            return { ok: false, message: errMessage(error) };
          }
        };
      return syscalls;
    },
  };
}
