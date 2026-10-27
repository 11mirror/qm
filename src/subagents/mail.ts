import { principalDestination } from "../reach/reach.ts";
import type { Outbound } from "../surfaces/outbound.ts";
import { deliveryCandidatesFor } from "../core/orchestrator/turn-helpers.ts";
import type { SessionMailbox } from "../sessions/session-mailbox.ts";
import { type Session, type SpawnMeta } from "../types.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import type { Run, RunStore } from "../runs/run-store.ts";
import type { RunSignalStore } from "../runs/run-signal-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { xmlAttrEscape, xmlEscape } from "../util/message-tag.ts";
import { isSubagentThreadRef } from "../sessions/thread-ref.ts";
import { itemVisibleToAll, snippet, assertAudienceCompatible } from "./audience.ts";
import { sessionRunCancelled } from "./tree.ts";

const MAIL_ERROR_CAP = 1_000;

export type SubagentMailKind = "final_answer" | "no_reply" | "awaiting_input" | "errored" | "refused";

export function renderSubagentMail(input: {
  title: string;
  sessionId: string;
  kind: SubagentMailKind;
  body: string;
}): string {
  const why: Record<SubagentMailKind, string> = {
    final_answer: "finished a turn and sent back its result",
    no_reply: "finished a turn without sending a reply",
    awaiting_input: "is blocked waiting for a human approval",
    errored: "failed",
    refused: "was refused",
  };
  return [
    `<wake reason="subagent" name="${xmlAttrEscape(input.title)}" sessionId="${input.sessionId}" kind="${input.kind}" at="${new Date().toISOString()}">`,
    `  <why>Your subagent session "${xmlEscape(input.title)}" ${why[input.kind]}.</why>`,
    `  <content>${xmlEscape(input.body)}</content>`,
    `  <instructions>If the person who asked for this work is waiting on it, relay what matters in your own words. Otherwise act on it internally without acknowledging it. Never repeat a result already reported or send a no-action-needed update. The subagent's full transcript is kept with it; use the subagents tool to read it or give it another task.</instructions>`,
    "</wake>",
  ].join("\n");
}

export interface SubagentMailDeps {
  signals?: Pick<RunSignalStore, "pending">;
  outbound?: Pick<Outbound, "send">;
  mailbox: SessionMailbox;
  sessions: Pick<SessionStore, "get" | "getByThread" | "getItems" | "latestItemSeq" | "visibleItems">;
  runs: Partial<Pick<RunStore, "latestForThread" | "get">>;
  prepareRequest?: (request: OrchestratorInput) => Promise<OrchestratorInput>;
}

function mailContent(run: Run): { kind: SubagentMailKind; body: string } {
  const result = run.result;
  let kind: SubagentMailKind;
  let body: string;
  if (run.status === "failed" || result?.status === "failed") {
    kind = "errored";
    body = snippet(result?.reason ?? "the turn failed", MAIL_ERROR_CAP);
  } else if (result?.pendingApprovals?.length || result?.status === "pending_approval") {
    kind = "awaiting_input";
    body = snippet(
      result.pendingApprovals?.map((a) => a.command).join("; ") ?? "a command needs human approval",
      MAIL_ERROR_CAP,
    );
  } else if (result?.status === "refused") {
    kind = "refused";
    body = snippet(result.reason ?? "the turn was refused", MAIL_ERROR_CAP);
  } else if (result?.status === "ok" && (result.reply?.trim() || result.attachments?.length)) {
    kind = "final_answer";
    body = result.reply?.trim() || `Produced ${result.attachments!.map((file) => file.name).join(", ")}.`;
  } else {
    kind = "no_reply";
    body = "completed without sending a reply.";
  }
  return { kind, body };
}

async function sendChildFiles(
  outbound: Pick<Outbound, "send">,
  run: Run,
  meta: OrchestratorInput | SpawnMeta,
  parent: Session,
  child: Session,
  attachments: NonNullable<NonNullable<Run["result"]>["attachments"]>,
): Promise<void> {
  const delivery = deliveryCandidatesFor(meta.surface, meta.deliveryTarget, meta.deliveryCandidates, parent.scopeId);
  const candidate = delivery.candidates.find((item) => item.key === delivery.defaultKey);
  const destination =
    candidate ??
    (meta.origin?.kind === "automation" ? meta.origin.destination : undefined) ??
    principalDestination(meta.actor.id, meta.actor.id);
  await outbound.send({
    destination,
    text: "",
    attachments,
    idempotencyKey: `subagent-files:${run.id}`,
    provenance: {
      trigger: "subagent",
      surface: meta.surface ?? "unknown",
      fireKey: `subagent-files:${run.id}`,
      sourceScopeId: child.scopeId,
      sourceThreadRef: child.threadRef,
      sourceSessionId: child.id,
    },
  });
}

export async function deliverSubagentMail(deps: SubagentMailDeps, run: Run): Promise<void> {
  if (!isSubagentThreadRef(run.sessionId) || run.request.privateSessionMessage) return;
  if (
    run.result?.stopped ||
    (deps.signals && deps.runs.get && (await sessionRunCancelled({ get: deps.runs.get }, deps.signals, run.id)))
  )
    return;
  const child = await deps.sessions.getByThread(run.sessionId);
  if (!child?.parentSessionId || !child.spawnMeta) return;
  const parent = await deps.sessions.get(child.parentSessionId);
  if (!parent) return;
  const latestParent = await deps.runs.latestForThread?.(parent.threadRef, { excludePrivateMessages: true });
  if (parent.scopeId !== child.scopeId) throw new Error("parent and child contexts no longer match");
  const initiatingRun = run.request.delegatingRunId ? await deps.runs.get?.(run.request.delegatingRunId) : undefined;
  if (run.request.delegatingRunId && !initiatingRun) throw new Error("the delegation's originating run is unavailable");
  const initiatingContext = initiatingRun?.request ?? child.spawnMeta;
  const currentContext = latestParent?.request ?? parent.spawnMeta;
  const originalParent = parent.threadRef === initiatingContext.conversation.threadRef;
  if (!originalParent && !currentContext) throw new Error("the current parent has no verified runtime context yet");
  const meta = originalParent
    ? initiatingContext
    : {
        ...currentContext!,
        actor: run.request.actor,
        origin: {
          kind: "automation" as const,
          ...(currentContext!.origin?.kind === "automation" && currentContext!.origin.destination
            ? { destination: currentContext!.origin.destination }
            : {}),
        },
        unattendedGrants: undefined,
      };
  const title = child.title?.trim() || child.id;
  const result = run.result;
  const { kind, body } = mailContent(run);
  const text = renderSubagentMail({
    title,
    sessionId: child.id,
    kind,
    body:
      body.length > 16_000 ? `${body.slice(0, 16_000)}\n[truncated; read the child session for the full result]` : body,
  });
  const inherited = { ...meta };
  delete (inherited as Partial<SpawnMeta>).openFingerprint;
  const request: OrchestratorInput = {
    ...inherited,
    conversation: {
      ...meta.conversation,
      ...(currentContext
        ? { audience: currentContext.conversation.audience, publishMembers: currentContext.conversation.publishMembers }
        : {}),
      threadRef: parent.threadRef,
    },
    origin: meta.origin ?? { kind: "automation" },
    text,
  };
  const prepared = deps.prepareRequest ? await deps.prepareRequest(request) : request;
  assertAudienceCompatible(run.request, prepared);
  const outputSeq = run.result?.sourceAssistantEntrySeq ?? run.turnUserSeq ?? run.result?.sourceUserSeq;
  if (outputSeq !== undefined && outputSeq !== null) {
    if (
      !(await itemVisibleToAll(deps.sessions, child.id, outputSeq, [
        prepared.actor.id,
        ...prepared.conversation.audience.map((person) => person.id),
      ]))
    )
      throw new Error("the current parent audience cannot read this child result");
  }
  if (result?.attachments?.length && deps.outbound)
    await sendChildFiles(deps.outbound, run, meta, parent, child, result.attachments);
  await deps.mailbox.send({
    id: `subagent-mail-${run.id}`,
    recipientId: parent.id,
    senderId: child.id,
    actor: prepared.actor,
    text,
    ...(outputSeq !== undefined && outputSeq !== null ? { sourceEntrySeq: outputSeq } : {}),
    audience: prepared.conversation.audience,
    createdAt: Date.now(),
  });
}
