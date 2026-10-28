import { surfaceHas } from "../../surfaces/surface.ts";
import type { MemoryStrategy } from "../../memory/strategy.ts";
import type { MemoryPolicy } from "../../memory/policy.ts";
import { ProjectRosterChanged, rosterChangedRefusal } from "./admit.ts";
import { parkApprovals, summarizeApproval, type ApprovalRequest } from "./approvals.ts";
import type { TurnCtx } from "./turn-context.ts";
import type { Session } from "../../types.ts";
import type { MemoryProvenance } from "../../memory/facts.ts";
import type { PartialTurn } from "../turn-resume.ts";
import { type ScopeId, type TurnResult } from "../../types.ts";
import { deriveTurnOutcome, approvalBlocksInput } from "../turn-outcome.ts";
import type { Lease } from "../../sessions/session-store.ts";
import { isReply, isUserMessage, type Item, type NewItem } from "../../sessions/items.ts";
import type { HarnessTurnResult } from "../../harness/harness.ts";
import { commandApprovalId } from "../approval-id.ts";
import { NeedsApproval, CommandDenied } from "../../tools/primitives.ts";
import { errMessage, swallowAs } from "../../util/errors.ts";
import {
  isModelBudget,
  isNonRetryable,
  ProviderTurnError,
  turnFailureMessage,
  turnFailureItem,
} from "../turn-error.ts";
import { stripAckPrefix } from "./turn-helpers.ts";
import { type SpineState } from "./surface-tools.ts";
import { createAttachStaging } from "./attach-tool.ts";

type ApprovalAsk = Omit<ApprovalRequest, "requestId" | "blocksInput">;

async function approvalRequest(
  ctx: TurnCtx,
  sessionId: string,
  ask: ApprovalAsk,
  blocksInput: boolean,
): Promise<ApprovalRequest> {
  const summary = ask.summary ?? (await summarizeApproval(ctx.deps, ctx.scopeId, ask.command, ask.reason, ask.purpose));
  return {
    ...ask,
    requestId: commandApprovalId(sessionId, ask.command, ask.approvalKey),
    blocksInput,
    ...(summary ? { summary } : {}),
  };
}

export async function mapTurnFailure(
  ctx: TurnCtx,
  turn: { session: Session; lease: Lease; failureUserItem: NewItem<"UserMessage"> | undefined },
  err: unknown,
): Promise<TurnResult> {
  const { deps, input, withManagedRosterVersion, approvalOwner, scopeId } = ctx;
  const { session, lease, failureUserItem } = turn;
  if (err instanceof ProjectRosterChanged) {
    return rosterChangedRefusal(session.id);
  }
  if (err instanceof NeedsApproval) {
    const request = await approvalRequest(
      ctx,
      session.id,
      {
        command: err.command,
        reason: err.approvalReason,
        grantModes: { session: err.grantModes?.session ?? true, always: err.grantModes?.always ?? true },
        ...(err.matched ? { matched: err.matched } : {}),
        ...(err.approvalKey ? { approvalKey: err.approvalKey } : {}),
        ...(err.kind ? { kind: err.kind } : {}),
      },
      true,
    );
    try {
      const pendingApprovals = await withManagedRosterVersion(() =>
        parkApprovals(deps.approvals, approvalOwner(session.id), [request]),
      );
      return { status: "pending_approval", sessionId: session.id, pendingApprovals };
    } catch (writeErr) {
      if (writeErr instanceof ProjectRosterChanged) {
        return rosterChangedRefusal(session.id);
      }
      throw writeErr;
    }
  }
  if (err instanceof CommandDenied) {
    deps.errors?.record({
      category: "command_policy",
      code: "denied",
      message: err.message,
      scopeLabel: scopeId,
      sessionId: session.id,
    });
    return { status: "refused", sessionId: session.id, reason: err.message };
  }
  const budget = isModelBudget(err) && !input.cancel?.aborted;
  deps.errors?.record(
    {
      category: "turn",
      code: budget ? "model_budget" : "error",
      message: err instanceof ProviderTurnError ? err.raw : errMessage(err),
      scopeLabel: scopeId,
      sessionId: session.id,
    },
    err,
  );
  if ((isNonRetryable(err) || input.finalAttempt) && !input.cancel?.aborted) {
    if (failureUserItem) {
      await deps.sessions
        .append(lease, failureUserItem)
        .catch(swallowAs("orchestrator: turn failure user back-fill", undefined));
    }
    await deps.sessions
      .append(lease, turnFailureItem(turnFailureMessage(err), input.runId))
      .catch(swallowAs("orchestrator: terminal turn failure record", undefined));
  }
  if (budget)
    return {
      status: "refused",
      sessionId: session.id,
      reason: turnFailureMessage(err),
      refusalKind: "model_budget",
    };
  throw err;
}

export async function settleTurn(
  ctx: TurnCtx,
  turn: {
    session: Session;
    result: HarnessTurnResult;
    attachStaging: ReturnType<typeof createAttachStaging>;
    spine: SpineState;
    partial: PartialTurn | null;
    turnInput: string;
    emittedEntries: Item[];
    memoryScopeId: ScopeId;
    captureDependencies: () => MemoryProvenance[];
    memoryStrategy: MemoryStrategy;
    memoryPolicy: MemoryPolicy;
    hasSurfaceToolDeps: boolean;
    isPollFire: boolean;
  },
): Promise<{ settled: TurnResult; completed: boolean }> {
  const { deps, input, withManagedRosterVersion, approvalOwner, strictReadOnly } = ctx;
  const { session, result, partial, emittedEntries, hasSurfaceToolDeps, isPollFire } = turn;
  const stagedAttachments = turn.attachStaging.staged();
  const harvestedAck =
    surfaceHas(input.surface, "earlyAck") && !input.surfaceTools && input.runId
      ? await deps.turnStream?.savedFirstBlock(input.runId)
      : undefined;
  const reply = stripAckPrefix(result.reply ?? "", harvestedAck);
  const cancelStopped = input.cancel?.aborted === true && result.stopped === true;
  const outcome = deriveTurnOutcome({
    reply,
    attachments: stagedAttachments.length,
    pendingApprovals: result.pendingApprovals ?? [],
    terminatedOnApproval: result.pausedOnApproval === true,
  });
  if (input.runId && !outcome.paused && reply.trim()) deps.turnStream?.markReplyDone(input.runId, input.runLeaseToken);
  if (!outcome.paused && !cancelStopped) await captureTurnMemory(ctx, turn, reply);
  const sourceUserSeq = partial?.userSeq ?? emittedEntries.find(isUserMessage)?.seq;
  const sourceAssistantEntrySeq = emittedEntries.findLast(isReply)?.seq;
  const ok = (): TurnResult => ({
    status: "ok",
    sessionId: session.id,
    reply,
    ...(stagedAttachments.length ? { attachments: stagedAttachments } : {}),
    ...(sourceUserSeq !== undefined ? { sourceUserSeq } : {}),
    ...(sourceAssistantEntrySeq !== undefined ? { sourceAssistantEntrySeq } : {}),
  });
  const settle = (settled: TurnResult) => ({ settled, completed: outcome.completed });
  if (cancelStopped && !result.pendingApprovals?.length)
    return settle({ status: "silent", sessionId: session.id, stopped: true });
  if (isPollFire && result.silent && !stagedAttachments.length && result.pausedOnApproval !== true)
    return settle({ status: "silent", sessionId: session.id });
  if (result.pendingApprovals?.length) {
    const requests: ApprovalRequest[] = [];
    for (const pa of result.pendingApprovals)
      requests.push(await approvalRequest(ctx, session.id, pa, approvalBlocksInput(pa.kind, outcome)));
    const pendingApprovals = await withManagedRosterVersion(() =>
      parkApprovals(deps.approvals, approvalOwner(session.id), requests),
    );
    return settle(
      outcome.completed
        ? { ...ok(), pendingApprovals }
        : { status: "pending_approval", sessionId: session.id, pendingApprovals },
    );
  }
  if (isPollFire && !stagedAttachments.length && !reply.trim())
    return settle({ status: "silent", sessionId: session.id });
  if (input.surfaceTools && hasSurfaceToolDeps && !strictReadOnly)
    return settle({ status: "silent", sessionId: session.id, ...(result.stopped ? { stopped: true } : {}) });
  return settle({ ...ok(), ...(result.stopped ? { stopped: true } : {}) });
}

async function captureTurnMemory(
  ctx: TurnCtx,
  turn: {
    session: Session;
    spine: SpineState;
    turnInput: string;
    memoryScopeId: ScopeId;
    captureDependencies: () => MemoryProvenance[];
    memoryStrategy: MemoryStrategy;
    memoryPolicy: MemoryPolicy;
  },
  reply: string,
): Promise<void> {
  const { deps, input, actor, automatedTurn, scopeId, useMemory } = ctx;
  const { session, memoryStrategy } = turn;
  const onTurnEnd = memoryStrategy.onTurnEnd?.bind(memoryStrategy);
  if (!useMemory || turn.memoryPolicy.capture === "off" || !onTurnEnd) return;
  try {
    await onTurnEnd({
      scopeId: turn.memoryScopeId,
      conversationScopeId: scopeId,
      inheritedFacts: turn.captureDependencies(),
      input: turn.turnInput,
      reply,
      actorId: actor.id,
      ...(automatedTurn ? { autonomous: true } : {}),
      sessionId: session.id,
      idempotencyKey: input.runId ?? `${session.id}:${turn.spine.turnUserEntrySeq ?? "turn"}`,
    });
  } catch (e) {
    deps.errors?.record(
      {
        category: "memory",
        code: "capture_failed",
        message: errMessage(e),
        scopeLabel: scopeId,
        sessionId: session.id,
      },
      e,
    );
  }
}
