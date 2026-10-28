import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TurnGoal, TurnHalt } from "./turn-tool-state.ts";
import type { ModelCallLog } from "./model-call-log.ts";
import type { HarnessTurnInput, HarnessTurnResult } from "./harness.ts";
import type { StepRecorder } from "./pi-step-recorder.ts";
import type { GrindMeter } from "./grind.ts";
import type { TurnStop } from "./turn-signals.ts";
import { sumCacheUsage, type PerCallStat } from "./call-telemetry.ts";
import { bankGoalTurn } from "./goal.ts";
import { recordStoppedTurn } from "./harness-shared.ts";
import { textFromContent } from "./pi-payload.ts";
import { lastAssistantSince, piLastAssistantTextOrThrow } from "./turn-recovery.ts";

export async function finishTurn({
  turn,
  session,
  goal,
  halt,
  calls,
  steps,
  grindMeter,
  stop,
  callStats,
  messagesBefore,
  recoveryDead,
  settled,
}: {
  turn: HarnessTurnInput;
  session: AgentSession;
  goal: Pick<TurnGoal, "current" | "set">;
  halt: Pick<TurnHalt, "handoff" | "silent" | "approvals" | "pausedOnApproval">;
  calls: Pick<ModelCallLog, "count">;
  steps: StepRecorder;
  grindMeter: GrindMeter;
  stop: TurnStop;
  callStats: PerCallStat[];
  messagesBefore: number;
  recoveryDead: boolean;
  settled: () => Promise<void>;
}): Promise<HarnessTurnResult> {
  const settleGoal = async (pause = false): Promise<void> => {
    const g = goal.current();
    if (!g) return;
    bankGoalTurn(g, grindMeter.startedAt);
    if (pause && g.status === "active") {
      g.status = "paused";
      g.updatedAt = Date.now();
    }
    await turn.saveGoal?.(g);
    if (g.status === "complete") goal.set(null);
  };
  const cacheUsage = () => {
    const usage = sumCacheUsage(callStats);
    return usage ? { cacheUsage: usage } : {};
  };
  const handoff = halt.handoff();
  if (handoff && !stop.userAborted && !turn.cancel?.aborted) {
    steps.flush();
    await settled();
    await settleGoal();
    return {
      reply: "",
      runtimeHandoff: halt.handoff(),
      modelCalls: calls.count(),
      ...cacheUsage(),
    };
  }
  const lastFresh = lastAssistantSince(session.messages, messagesBefore);
  const freshStopReason = lastFresh?.stopReason;
  const cancelStoppedCleanly =
    turn.cancel?.aborted === true && (freshStopReason === "aborted" || freshStopReason === undefined);
  if (stop.userAborted || cancelStoppedCleanly) {
    const partial = lastFresh ? textFromContent(lastFresh.content) : "";
    const reply = partial.trim() ? partial : "(stopped)";
    await settleGoal(stop.userAborted);
    await recordStoppedTurn(
      turn,
      partial,
      stop.userAborted ? stop.abortReason : "because the run was cancelled",
      steps.closing(reply),
    );
    return { reply, stopped: true as const, modelCalls: calls.count(), ...cacheUsage() };
  }

  await settleGoal();
  const closingText = recoveryDead ? "" : (piLastAssistantTextOrThrow(session) ?? "");
  const reply = halt.silent() ? "" : closingText;
  const closing = steps.closing(reply);
  await turn.emit({
    kind: "AgentMessage",
    text: reply,
    step: closing?.step ?? null,
    body: closing?.body ?? {},
  });
  const pendingApprovals = halt.approvals();
  return {
    reply,
    ...(pendingApprovals.length ? { pendingApprovals } : {}),
    ...(pendingApprovals.length && halt.pausedOnApproval() ? { pausedOnApproval: true as const } : {}),
    modelCalls: calls.count(),
    ...(halt.silent() ? { silent: true as const } : {}),
    ...cacheUsage(),
  };
}
