import type { ErrorLog } from "../admin/error-log.ts";
import type { Orchestrator, OrchestratorInput } from "../core/orchestrator.ts";
import {
  isNonRetryable,
  NonRetryableTurnError,
  ProviderTurnError,
  turnFailureItem,
  turnFailureMessage,
} from "../core/turn-error.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import { retryDelay } from "../runs/retry-delay.ts";
import {
  countedClaims,
  crashLoopReason,
  errorParks,
  isUnstarted,
  PARKED,
  runPriority,
  stopErrorCode,
  type Run,
  type RunStop,
  type RunStore,
} from "../runs/run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { isSubagentThreadRef } from "../sessions/session-syscalls.ts";
import { resolveSwarmSettings } from "../swarms/swarm-settings.ts";
import type { ScopeId, TurnResult } from "../types.ts";
import { sleep } from "../util/async.ts";
import { errMessage, errorAlreadyReported, reportFailure, swallow } from "../util/errors.ts";
import { TURN_EXTEND_INTERVAL_MS, type TurnLedger, type TurnOutcome } from "./turn-ledger.ts";

const CANCEL_GRACE_MS = 10_000;
const FINISH_RETRY_MAX_MS = 5_000;
const FINISH_RETRY_MS = 500;
const FAILURE_REPORT_CONSECUTIVE = 5;
const LEASE_LOST_CONSECUTIVE = 3;
const SWARM_CLAIM_BUDGET = 3;
const TURN_REPAIRED_REASON = "This turn stopped unexpectedly and could not be resumed.";

export interface TurnEndSteps {
  refreshLiveView(run: Run): void;
  deliverResult(run: Run): void;
  settleConversationState(run: Run): Promise<void>;
  wakeWaiters(run: Run): void;
  replayLateSteers(run: Run): Promise<void>;
  returnToParent(run: Run): Promise<void>;
  recordAnalytics(run: Run): void;
}

export interface TurnDeps {
  ledger: TurnLedger;
  orchestrator: Orchestrator;
  end: TurnEndSteps;
  errors?: ErrorLog;
  extendIntervalMs?: number;
  retryDelayMs?: (priorErrors: number) => number;
  maxClaims?: number;
}

export interface HeldTurn {
  run: Run;
  token: string;
  cancel: AbortController;
  shutdown: AbortController;
  cancelled: boolean;
  yielding: boolean;
  done: Promise<void>;
  onCancel(): void;
}

type ModelLoopEnd = { kind: "result"; result: TurnResult } | { kind: "error"; err: unknown };

export function bindTurnLedger(
  base: Pick<RunStore, "get">,
  ledger: TurnLedger,
  end: TurnEndSteps,
): Pick<RunStore, "enqueue" | "cancelTurn" | "cancelTree" | "withdraw" | "leaseHeld"> {
  const cancelTurn = async (runId: string) => {
    const cancelled = await ledger.cancel(runId);
    if (cancelled?.ended) void endTurn(cancelled.ended, end);
    return cancelled?.outcome ?? null;
  };
  return {
    async enqueue(input) {
      const delegating = input.request.delegatingRunId ? await base.get(input.request.delegatingRunId) : null;
      return ledger.admit({ ...input, priority: runPriority(input.request, delegating?.priority ?? null) });
    },
    cancelTurn,
    async cancelTree(threadRefs) {
      const { count, ended } = await ledger.cancelTree(threadRefs);
      for (const run of ended) void endTurn(run, end);
      return count;
    },
    async withdraw(runId, opts) {
      const run = await base.get(runId);
      if (!run || !isUnstarted(run)) return false;
      if (opts?.unstartedOnly && (run.attempts > 0 || run.turnUserSeq !== null)) return false;
      return (await cancelTurn(runId)) !== null;
    },
    leaseHeld: (run, token) => ledger.fenceHeld(run.id, token),
  };
}

export async function runTurn(held: HeldTurn, deps: TurnDeps): Promise<void> {
  const { run } = held;
  const heartbeat = keepClaim(held, deps);
  let workDeadline: ReturnType<typeof setTimeout> | undefined;
  let ended: ModelLoopEnd;
  try {
    if (run.priority === 2 && (await deps.ledger.mustYield(run))) {
      heartbeat.stop();
      await parkTurn(held, "person", deps);
      return;
    }
    workDeadline = swarmTurnLimits(run, held.cancel);
    if (deps.maxClaims !== undefined && countedClaims(run) > deps.maxClaims)
      throw new NonRetryableTurnError(crashLoopReason(countedClaims(run) - 1));
    ended = await runModelLoop(held, deps);
  } catch (err) {
    ended = { kind: "error", err };
  }
  try {
    if (held.shutdown.signal.aborted || heartbeat.lost()) {
      if (ended.kind === "error")
        swallow(`turns: turn ${run.id} ended after ${heartbeat.lost() ? "losing its claim" : "handback"}`, ended.err);
      return;
    }
    held.yielding = true;
    await settleTurn(held, ended, deps);
  } finally {
    heartbeat.stop();
    clearTimeout(workDeadline);
  }
}

function prepareTurnInput(held: HeldTurn, maxClaims: number | undefined): OrchestratorInput {
  const { run, token } = held;
  const { trace: _trace, ...request } = run.request;
  return {
    ...request,
    origin: resolveTurnOrigin(request),
    runId: run.id,
    attempt: run.attempts,
    ...(run.lastStop ? { resumeCause: run.lastStop } : {}),
    runLeaseToken: token,
    turnFenceToken: token,
    finalAttempt: errorParks(run, maxClaims),
    background: true,
    cancel: held.cancel.signal,
    shutdown: held.shutdown.signal,
    ...(run.startedAt !== null ? { runStartedAt: run.startedAt } : {}),
  };
}

async function runModelLoop(held: HeldTurn, deps: TurnDeps): Promise<ModelLoopEnd> {
  return { kind: "result", result: await deps.orchestrator.handleTurn(prepareTurnInput(held, deps.maxClaims)) };
}

async function settleTurn(held: HeldTurn, ended: ModelLoopEnd, deps: TurnDeps): Promise<void> {
  const { run, token } = held;
  if (ended.kind === "result") {
    await finishTurn(held, deps, {
      status: "done",
      result: held.cancelled ? { ...ended.result, stopped: true } : ended.result,
    });
    return;
  }
  if (held.cancelled) {
    await finishTurn(held, deps, {
      status: "done",
      result: { status: "ok", sessionId: run.sessionId, stopped: true },
    });
    return;
  }
  recordTurnError(deps.errors, run, ended.err);
  const stop = runStopFor(ended.err);
  if (isNonRetryable(ended.err) || errorParks(run, deps.maxClaims)) {
    await finishTurn(held, deps, {
      status: "failed",
      countsAsError: true,
      result: {
        status: "failed",
        sessionId: run.sessionId,
        reason: turnFailureMessage(ended.err),
        ...stopErrorCode(stop),
      },
    });
    return;
  }
  const requeued = await deps.ledger.handBack(run, token, {
    stop,
    delayMs: (deps.retryDelayMs ?? retryDelay)(run.errorAttempts),
    countsAsError: true,
  });
  if (!requeued)
    console.warn(`[turns] turn ${run.id} could not be requeued after an error; its claim was already gone`);
}

async function finishTurn(held: HeldTurn, deps: TurnDeps, outcome: TurnOutcome): Promise<void> {
  const { run, token, shutdown } = held;
  for (let attempt = 1; !shutdown.signal.aborted; attempt++) {
    try {
      const finished = await deps.ledger.finish(run, token, outcome);
      if (finished) await endTurn(finished, deps.end);
      else console.warn(`[turns] turn ${run.id} ended after losing its claim; its result was not recorded`);
      return;
    } catch (error) {
      if (attempt === FAILURE_REPORT_CONSECUTIVE)
        reportFailure(`turns: turn end keeps failing for turn ${run.id}`, error);
      else swallow(`turns: turn end failed for turn ${run.id} (retrying)`, error);
      await sleep(Math.min(FINISH_RETRY_MS * attempt, FINISH_RETRY_MAX_MS));
    }
  }
}

export async function endTurn(run: Run, end: TurnEndSteps): Promise<void> {
  await endStep(run, "refresh the live view", () => end.refreshLiveView(run));
  await endStep(run, "deliver the result", () => end.deliverResult(run));
  await endStep(run, "settle conversation state", () => end.settleConversationState(run));
  await endStep(run, "wake waiting callers", () => end.wakeWaiters(run));
  await endStep(run, "replay late steers", () => end.replayLateSteers(run));
  if (isSubagentThreadRef(run.sessionId)) await endStep(run, "return to the parent", () => end.returnToParent(run));
  await endStep(run, "record analytics", () => end.recordAnalytics(run));
}

async function endStep(run: Run, step: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    swallow(`turns: ${step} failed turn=${run.id}`, error);
  }
}

export async function parkTurn(held: HeldTurn, reason: "capacity" | "person", deps: TurnDeps): Promise<void> {
  if (held.yielding) return;
  held.yielding = true;
  held.shutdown.abort(PARKED);
  held.cancel.abort();
  let outcome: "yielded" | "handed_back" | "lost" | "stopped" | "failed";
  try {
    if (reason === "person") outcome = await deps.ledger.yieldTo(held.run, held.token);
    else outcome = (await deps.ledger.handBack(held.run, held.token, { stop: PARKED })) ? "handed_back" : "lost";
  } catch (error) {
    reportFailure(`turns: parking failed turn=${held.run.id} reason=${reason}; handing the turn back`, error);
    outcome = await deps.ledger
      .handBack(held.run, held.token, { stop: PARKED })
      .then((ok) => (ok ? "handed_back" : "lost"))
      .catch((fallback: unknown) => {
        reportFailure(
          `turns: handback after a failed park failed turn=${held.run.id}; the claim will expire`,
          fallback,
        );
        return "failed" as const;
      });
  }
  if (outcome === "lost") {
    const stopped = await deps.ledger
      .finish(held.run, held.token, {
        status: "done",
        result: { status: "ok", sessionId: held.run.sessionId, stopped: true },
      })
      .catch((error: unknown) => {
        reportFailure(`turns: ending a stopped turn failed turn=${held.run.id}; repair will clean it up`, error);
        return null;
      });
    if (stopped) {
      outcome = "stopped";
      await endTurn(stopped, deps.end);
    }
  }
  console.log(`[turns] parked turn=${held.run.id} reason=${reason} outcome=${outcome}`);
}

function keepClaim(held: HeldTurn, deps: TurnDeps): { stop(): void; lost(): boolean } {
  const { run, token, cancel } = held;
  let lost = false;
  let misses = 0;
  let extendFailures = 0;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  held.onCancel = () => {
    if (held.cancelled) return;
    held.cancelled = true;
    cancelTimer = setTimeout(() => cancel.abort(), CANCEL_GRACE_MS);
    cancelTimer.unref?.();
  };
  const beat = setInterval(() => {
    void deps.ledger
      .extend(run, token)
      .then((outcome) => {
        extendFailures = 0;
        if (outcome === "held") {
          misses = 0;
          if (run.priority === 2 && !held.yielding)
            void deps.ledger
              .mustYield(run)
              .then((waiting) => (waiting ? parkTurn(held, "person", deps) : undefined))
              .catch((error: unknown) => swallow(`turns: yield check failed turn=${run.id}`, error));
          return;
        }
        if (outcome === "cancelled") {
          held.onCancel();
          return;
        }
        misses += 1;
        if (misses >= LEASE_LOST_CONSECUTIVE && !lost) {
          lost = true;
          console.warn(`[turns] turn ${run.id} lost its claim; cancelling the in-process turn`);
          cancel.abort();
        }
      })
      .catch((error: unknown) => {
        extendFailures += 1;
        if (extendFailures === FAILURE_REPORT_CONSECUTIVE)
          reportFailure(`turns: claim extension keeps failing for turn ${run.id}`, error);
        else swallow(`turns: extend failed for turn ${run.id} (transient)`, error);
      });
  }, deps.extendIntervalMs ?? TURN_EXTEND_INTERVAL_MS);
  beat.unref?.();
  return {
    stop() {
      clearInterval(beat);
      clearTimeout(cancelTimer);
    },
    lost: () => lost,
  };
}

function swarmTurnLimits(
  run: Pick<Run, "request" | "attempts" | "preemptions">,
  cancel: AbortController,
): ReturnType<typeof setTimeout> | undefined {
  if (run.request.swarm && countedClaims(run) > SWARM_CLAIM_BUDGET)
    throw new NonRetryableTurnError("swarm claim budget exhausted");
  if (!run.request.swarm || run.request.swarmGoal) return undefined;
  const { turnMs } = resolveSwarmSettings({ turnMs: run.request.turnWallClockMs });
  return setTimeout(() => cancel.abort(), turnMs);
}

function recordTurnError(errors: ErrorLog | undefined, run: Run, err: unknown): void {
  console.error(`[turns] turn ${run.id} failed: ${errMessage(err)}`);
  if (!errorAlreadyReported(err))
    errors?.record(
      {
        category: "turn",
        code: "error",
        message: `run ${run.id}: ${errMessage(err)}`,
        scopeLabel: conversationScope(run.request.conversation, run.request.actor.id),
      },
      err,
    );
}

function runStopFor(err: unknown): RunStop {
  if (err instanceof ProviderTurnError)
    return { kind: "error", code: err.code, ...(err.status !== undefined ? { status: err.status } : {}) };
  return { kind: "error" };
}

export async function repairStaleTurns(deps: {
  ledger: TurnLedger;
  sessions: Pick<SessionStore, "getByThread" | "forceReleaseLease" | "acquireLease" | "append" | "releaseLease">;
  end: TurnEndSteps;
  errors?: ErrorLog;
}): Promise<void> {
  const adopted = await deps.ledger.adoptLegacy();
  if (adopted)
    deps.errors?.record({
      category: "runs",
      code: "legacy_turns_adopted",
      message: `${adopted} legacy turn(s) moved onto Absurd`,
      scopeLabel: "turns:pointer-repair" as ScopeId,
    });
  for (const candidate of await deps.ledger.repairCandidates()) {
    const repaired = await deps.ledger.repair(candidate, {
      status: "failed",
      sessionId: candidate.threadRef,
      reason: TURN_REPAIRED_REASON,
    });
    deps.errors?.record({
      category: "runs",
      code: "turn_pointer_repaired",
      message: `turn ${candidate.turnId}: ${candidate.reason}`,
      scopeLabel: "turns:pointer-repair" as ScopeId,
    });
    const session = repaired ? await deps.sessions.getByThread(candidate.threadRef) : null;
    if (session) {
      await deps.sessions.forceReleaseLease(session.id);
      const { lease } = await deps.sessions.acquireLease(session.id, "turn");
      if (lease)
        await deps.sessions
          .append(lease, turnFailureItem(TURN_REPAIRED_REASON, candidate.turnId))
          .finally(() => deps.sessions.releaseLease(lease));
    }
    await deps.ledger.release(candidate);
    if (repaired) await endTurn(repaired, deps.end);
  }
}
