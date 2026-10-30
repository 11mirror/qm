import type { HarnessTurnInput } from "../harness/harness.ts";
import { isFinanceAction, type FinanceAction } from "./finance.ts";
import {
  isFinanceFailureCause,
  isSafeFinanceLabel,
  isSafeFinanceProviderStatus,
  type FinanceFailureCause,
} from "./finance-failure.ts";
import {
  isFinnyEventKind,
  isFinnyEvidenceRole,
  isFinnyStage,
  type FinnyGoldenLoopState,
  type FinnyLedgerMetadata,
} from "./golden-loop.ts";

export type FinnyTraceTransition = Pick<
  FinnyLedgerMetadata,
  "eventId" | "eventKind" | "occurredAt" | "fromStage" | "toStage" | "evidence"
>;

export interface FinnyTraceSnapshot {
  schema: "finny.trace.v2";
  workflowRunId: string;
  currentRunId: string;
  sessionId: string;
  profile: "finny";
  harness: "pi";
  modelId: string;
  surface: string;
  stage: FinnyGoldenLoopState["stage"];
  outcome: "blocked" | "web_only_unattested" | "delivery_pending_attestation";
  transitionCount: number;
  latestTransition?: FinnyTraceTransition;
  latestAction?: FinnyTraceAction;
  blocker?: FinnyTraceBlocker;
}

export interface FinnyTraceAction {
  action: FinanceAction;
  durationMs: number;
  attempt: number;
}

export interface FinnyTraceBlocker {
  action: FinanceAction;
  code: "blocked_external" | "finance_error";
  cause: FinanceFailureCause;
  retryable: boolean;
  dependency?: string;
  diagnosticId?: string;
  providerStatus?: number;
}

const OUTCOMES = new Set(["blocked", "web_only_unattested", "delivery_pending_attestation"]);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const BLOCKER_CODES = new Set(["blocked_external", "finance_error"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeTransition(value: unknown): FinnyTraceTransition | null {
  const input = record(value);
  if (!input) return null;
  const eventId = text(input.eventId);
  const eventKind = text(input.eventKind);
  const occurredAt = text(input.occurredAt);
  const fromStage = text(input.fromStage);
  const toStage = text(input.toStage);
  if (
    !eventId ||
    !eventKind ||
    !isFinnyEventKind(eventKind) ||
    !occurredAt ||
    !fromStage ||
    !isFinnyStage(fromStage) ||
    !toStage ||
    !isFinnyStage(toStage) ||
    !Array.isArray(input.evidence)
  )
    return null;
  const evidence = input.evidence.map((item) => {
    const row = record(item);
    const role = row && text(row.role);
    const digest = row && text(row.digest);
    return role && isFinnyEvidenceRole(role) && digest && DIGEST.test(digest) ? { role, digest } : null;
  });
  if (evidence.some((item) => item === null)) return null;
  return {
    eventId,
    eventKind,
    occurredAt,
    fromStage,
    toStage,
    evidence: evidence as FinnyTraceTransition["evidence"],
  };
}

export function safeFinnyTraceSnapshot(value: unknown): FinnyTraceSnapshot | null {
  const input = record(value);
  if (!input || input.schema !== "finny.trace.v2" || input.profile !== "finny" || input.harness !== "pi") return null;
  const workflowRunId = text(input.workflowRunId);
  const currentRunId = text(input.currentRunId);
  const sessionId = text(input.sessionId);
  const modelId = text(input.modelId);
  const surface = text(input.surface);
  const stage = text(input.stage);
  const outcome = text(input.outcome);
  const transitionCount = input.transitionCount;
  if (
    !workflowRunId ||
    !currentRunId ||
    !sessionId ||
    !modelId ||
    !surface ||
    !stage ||
    !isFinnyStage(stage) ||
    !outcome ||
    !OUTCOMES.has(outcome) ||
    !Number.isSafeInteger(transitionCount) ||
    (transitionCount as number) < 0
  )
    return null;
  const latestTransition = input.latestTransition === undefined ? undefined : safeTransition(input.latestTransition);
  if (input.latestTransition !== undefined && !latestTransition) return null;
  const actionInput = input.latestAction === undefined ? undefined : record(input.latestAction);
  const actionName = actionInput && text(actionInput.action);
  const action = actionName && isFinanceAction(actionName) ? actionName : undefined;
  const actionDuration = actionInput?.durationMs;
  const actionAttempt = actionInput?.attempt;
  if (
    input.latestAction !== undefined &&
    (!action ||
      typeof actionDuration !== "number" ||
      !Number.isFinite(actionDuration) ||
      actionDuration < 0 ||
      !Number.isSafeInteger(actionAttempt) ||
      (actionAttempt as number) < 1)
  )
    return null;
  const blockerInput = input.blocker === undefined ? undefined : record(input.blocker);
  const blockerAction = blockerInput && text(blockerInput.action);
  const blockerFinanceAction = blockerAction && isFinanceAction(blockerAction) ? blockerAction : undefined;
  const blockerCode = blockerInput && text(blockerInput.code);
  const blockerCause = blockerInput && text(blockerInput.cause);
  const blockerFailureCause = blockerCause && isFinanceFailureCause(blockerCause) ? blockerCause : undefined;
  const blockerRetryable = blockerInput?.retryable;
  const blockerDependency = blockerInput?.dependency === undefined ? undefined : text(blockerInput.dependency);
  const blockerDiagnosticId = blockerInput?.diagnosticId === undefined ? undefined : text(blockerInput.diagnosticId);
  const blockerProviderStatusValue = blockerInput?.providerStatus;
  const blockerProviderStatus = typeof blockerProviderStatusValue === "number" ? blockerProviderStatusValue : undefined;
  if (
    input.blocker !== undefined &&
    (!blockerFinanceAction ||
      !blockerCode ||
      !BLOCKER_CODES.has(blockerCode) ||
      !blockerFailureCause ||
      typeof blockerRetryable !== "boolean" ||
      (blockerInput?.dependency !== undefined && (!blockerDependency || !isSafeFinanceLabel(blockerDependency))) ||
      (blockerInput?.diagnosticId !== undefined &&
        (!blockerDiagnosticId || !isSafeFinanceLabel(blockerDiagnosticId))) ||
      (blockerProviderStatusValue !== undefined &&
        (blockerProviderStatus === undefined || !isSafeFinanceProviderStatus(blockerProviderStatus))))
  )
    return null;
  return {
    schema: "finny.trace.v2",
    workflowRunId,
    currentRunId,
    sessionId,
    profile: "finny",
    harness: "pi",
    modelId,
    surface,
    stage,
    outcome: outcome as FinnyTraceSnapshot["outcome"],
    transitionCount: transitionCount as number,
    ...(latestTransition ? { latestTransition } : {}),
    ...(action
      ? {
          latestAction: {
            action,
            durationMs: actionDuration as number,
            attempt: actionAttempt as number,
          },
        }
      : {}),
    ...(blockerFinanceAction && blockerCode && blockerFailureCause && typeof blockerRetryable === "boolean"
      ? {
          blocker: {
            action: blockerFinanceAction,
            code: blockerCode as FinnyTraceBlocker["code"],
            cause: blockerFailureCause,
            retryable: blockerRetryable,
            ...(blockerDependency ? { dependency: blockerDependency } : {}),
            ...(blockerDiagnosticId ? { diagnosticId: blockerDiagnosticId } : {}),
            ...(typeof blockerProviderStatus === "number" ? { providerStatus: blockerProviderStatus } : {}),
          },
        }
      : {}),
  };
}

export function createFinnyTraceSnapshot(
  state: FinnyGoldenLoopState,
  turn: Pick<HarnessTurnInput, "runId" | "runtime" | "session" | "surfaceName">,
  blocker?: FinnyTraceBlocker,
  latestAction?: FinnyTraceAction,
): FinnyTraceSnapshot {
  const currentRunId = turn.runId;
  if (!currentRunId) throw new Error("Finny trace requires a trusted runId");
  const eligible = state.stage === "DELIVERY_ELIGIBLE";
  let outcome: FinnyTraceSnapshot["outcome"] = "blocked";
  if (eligible) outcome = turn.surfaceName === "web" ? "web_only_unattested" : "delivery_pending_attestation";
  const latest = state.ledger.at(-1);
  return {
    schema: "finny.trace.v2",
    workflowRunId: state.runId,
    currentRunId,
    sessionId: turn.session.id,
    profile: "finny",
    harness: "pi",
    modelId: turn.runtime?.modelId ?? "unresolved",
    surface: turn.surfaceName ?? "unknown",
    stage: state.stage,
    outcome,
    transitionCount: state.ledger.length,
    ...(latest
      ? {
          latestTransition: {
            eventId: latest.eventId,
            eventKind: latest.eventKind,
            occurredAt: latest.occurredAt,
            fromStage: latest.fromStage,
            toStage: latest.toStage,
            evidence: latest.evidence,
          },
        }
      : {}),
    ...(latestAction ? { latestAction } : {}),
    ...(blocker ? { blocker } : {}),
  };
}
