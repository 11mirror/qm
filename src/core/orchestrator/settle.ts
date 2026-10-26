import type { Session } from "../../types.ts";
import type { Lease } from "../../sessions/session-store.ts";
import type { TurnOutcome } from "../turn-outcome.ts";
import type { OutgoingAttachment } from "../../types.ts";
import { type TurnResult, type PendingApprovalRecord } from "../../types.ts";
import { approvalBlocksInput } from "../turn-outcome.ts";
import { isReply, type Item, type NewItem } from "../../sessions/items.ts";
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
import { hashId } from "../../util/crypto.ts";
import { ProjectRosterChanged, rosterChangedRefusal } from "./admit.ts";
import { parkApprovals, summarizeApproval, type ApprovalRequest } from "./approvals.ts";

import type { TurnCtx } from "./turn-context.ts";
import type { QuarantineReleaseApproval } from "./approvals.ts";

export async function settleTurnResult(
  ctx: TurnCtx,
  turn: {
    session: Session;
    strictReadOnly: boolean;
    quarantineReleaseApprovals: QuarantineReleaseApproval[];
    hasSurfaceToolDeps: boolean;
    isPollFire: boolean;
    emittedEntries: Item[];
    result: HarnessTurnResult;
    stagedAttachments: OutgoingAttachment[];
    reply: string;
    cancelStopped: boolean;
    outcome: TurnOutcome;
    turnCompleted: boolean;
    turnUserSeq: number | undefined;
  },
): Promise<TurnResult> {
  const { deps, input, withManagedRosterVersion, approvalOwner, scopeId } = ctx;
  const {
    session,
    strictReadOnly,
    quarantineReleaseApprovals,
    hasSurfaceToolDeps,
    isPollFire,
    emittedEntries,
    result,
    stagedAttachments,
    reply,
    cancelStopped,
    outcome,
    turnCompleted,
    turnUserSeq,
  } = turn;
  const pending = deps.approvals;
  let finalResult: TurnResult;
  const sourceUserSeq = turnUserSeq;
  const sourceAssistantEntrySeq = emittedEntries.findLast(isReply)?.seq;
  if (cancelStopped && !result.pendingApprovals?.length) {
    finalResult = { status: "silent", sessionId: session.id, stopped: true };
  } else if (isPollFire && result.silent && !stagedAttachments.length && result.pausedOnApproval !== true) {
    finalResult = { status: "silent", sessionId: session.id };
  } else if (result.pendingApprovals?.length || quarantineReleaseApprovals.length) {
    const turnApprovals: Array<
      NonNullable<HarnessTurnResult["pendingApprovals"]>[number] & {
        summary?: string;
        summaryDetail?: string;
        screenedOutput?: PendingApprovalRecord["screenedOutput"];
        grantModes?: { session: boolean; always: boolean };
      }
    > = [...(result.pendingApprovals ?? []), ...quarantineReleaseApprovals];
    const requests: ApprovalRequest[] = [];
    for (const pa of turnApprovals) {
      const command = pa.command;
      const summary = pa.summary ?? (await summarizeApproval(deps, scopeId, command, pa.reason, pa.purpose));
      requests.push({
        requestId: commandApprovalId(
          session.id,
          pa.screenedOutput
            ? `${command}:${hashId([pa.screenedOutput.tool, pa.screenedOutput.text, pa.screenedOutput.sourceScopeId ?? scopeId], 64)}`
            : command,
          pa.approvalKey,
        ),
        command,
        reason: pa.reason,
        blocksInput: approvalBlocksInput(pa.kind, outcome),
        ...(pa.grantModes ? { grantModes: pa.grantModes } : {}),
        ...(pa.matched ? { matched: pa.matched } : {}),
        ...(pa.purpose ? { purpose: pa.purpose } : {}),
        ...(summary ? { summary } : {}),
        ...(pa.summaryDetail ? { summaryDetail: pa.summaryDetail } : {}),
        ...(pa.screenedOutput ? { screenedOutput: pa.screenedOutput } : {}),
        ...(pa.approvalKey ? { approvalKey: pa.approvalKey } : {}),
        ...(pa.kind ? { kind: pa.kind } : {}),
      });
    }
    const approvals = await withManagedRosterVersion(() => parkApprovals(pending, approvalOwner(session.id), requests));
    finalResult = turnCompleted
      ? {
          status: "ok",
          sessionId: session.id,
          reply,
          pendingApprovals: approvals,
          ...(stagedAttachments.length ? { attachments: stagedAttachments } : {}),
          ...(sourceUserSeq !== undefined ? { sourceUserSeq } : {}),
          ...(sourceAssistantEntrySeq !== undefined ? { sourceAssistantEntrySeq } : {}),
        }
      : { status: "pending_approval", sessionId: session.id, pendingApprovals: approvals };
  } else if (isPollFire && !stagedAttachments.length && !reply.trim()) {
    finalResult = { status: "silent", sessionId: session.id };
  } else if (input.surfaceTools && hasSurfaceToolDeps && !strictReadOnly) {
    finalResult = { status: "silent", sessionId: session.id, ...(result.stopped ? { stopped: true } : {}) };
  } else {
    finalResult = {
      status: "ok",
      sessionId: session.id,
      reply,
      ...(result.stopped ? { stopped: true } : {}),
      ...(stagedAttachments.length ? { attachments: stagedAttachments } : {}),
      ...(sourceUserSeq !== undefined ? { sourceUserSeq } : {}),
      ...(sourceAssistantEntrySeq !== undefined ? { sourceAssistantEntrySeq } : {}),
    };
  }
  return finalResult;
}

export async function mapTurnFailure(
  ctx: TurnCtx,
  turn: { session: Session; lease: Lease; failureUserItem: NewItem<"UserMessage"> | undefined },
  err: unknown,
): Promise<TurnResult> {
  const { deps, input, withManagedRosterVersion, approvalOwner, scopeId } = ctx;
  const { session, lease, failureUserItem } = turn;
  const pending = deps.approvals;
  if (err instanceof ProjectRosterChanged) {
    return rosterChangedRefusal(session.id);
  }
  if (err instanceof NeedsApproval) {
    const summary = await summarizeApproval(deps, scopeId, err.command, err.approvalReason);
    try {
      const pendingApprovals = await withManagedRosterVersion(() =>
        parkApprovals(pending, approvalOwner(session.id), [
          {
            requestId: commandApprovalId(session.id, err.command),
            command: err.command,
            reason: err.approvalReason,
            blocksInput: true,
            grantModes: { session: err.grantModes?.session ?? true, always: err.grantModes?.always ?? true },
            ...(err.matched ? { matched: err.matched } : {}),
            ...(summary ? { summary } : {}),
            ...(err.approvalKey ? { approvalKey: err.approvalKey } : {}),
            ...(err.kind ? { kind: err.kind } : {}),
          },
        ]),
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
