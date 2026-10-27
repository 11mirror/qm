import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ToolContextRef } from "./agent-tools.ts";
import type { HarnessTurnInput, HarnessTurnResult } from "./harness.ts";
import type { StepRecorder } from "./pi-step-recorder.ts";
import type { GrindMeter } from "./grind.ts";
import type { TurnStop } from "./turn-signals.ts";
import { sumCacheUsage, type PerCallStat } from "./call-telemetry.ts";
import { bankGoalTurn } from "./goal.ts";
import { recordStoppedTurn } from "./harness-shared.ts";
import { textFromContent } from "./pi-payload.ts";
import { piLastAssistantTextOrThrow } from "./turn-recovery.ts";

export async function finishTurn(o: {
  turn: HarnessTurnInput;
  entry: { agentSession: AgentSession; ref: ToolContextRef };
  steps: StepRecorder;
  grindMeter: GrindMeter;
  stop: TurnStop;
  callStats: PerCallStat[];
  messagesBefore: number;
  recoveryDead: boolean;
  settled: () => Promise<void>;
}): Promise<HarnessTurnResult> {
  const { turn, entry, steps, grindMeter, stop, callStats, messagesBefore, recoveryDead, settled } = o;
  const freshAssistantStopReason = (): string | undefined => {
    const fresh = entry.agentSession.messages.slice(messagesBefore);
    const last = [...fresh].reverse().find((m) => (m as { role?: string }).role === "assistant") as
      { stopReason?: string } | undefined;
    return last?.stopReason;
  };
  const settleGoal = async (pause = false): Promise<void> => {
    const g = entry.ref.goal;
    if (!g) return;
    bankGoalTurn(g, grindMeter.startedAt);
    if (pause && g.status === "active") {
      g.status = "paused";
      g.updatedAt = Date.now();
    }
    await turn.saveGoal?.(g);
    if (g.status === "complete") entry.ref.goal = null;
  };
  if (entry.ref.runtimeHandoff && !stop.userAborted && !turn.cancel?.aborted) {
    steps.flush();
    await settled();
    await settleGoal();
    return {
      reply: "",
      runtimeHandoff: entry.ref.runtimeHandoff,
      modelCalls: entry.ref.modelCalls ?? 0,
      cacheUsage: sumCacheUsage(callStats) ?? undefined,
    };
  }
  const freshStopReason = freshAssistantStopReason();
  const cancelStoppedCleanly =
    turn.cancel?.aborted === true && (freshStopReason === "aborted" || freshStopReason === undefined);
  if (stop.userAborted || cancelStoppedCleanly) {
    const freshMessages = entry.agentSession.messages.slice(messagesBefore);
    const lastFreshAssistant = [...freshMessages].reverse().find((m) => (m as { role?: string }).role === "assistant");
    const partial = lastFreshAssistant ? textFromContent((lastFreshAssistant as { content?: unknown }).content) : "";
    const reply = partial.trim() ? partial : "(stopped)";
    await settleGoal(stop.userAborted);
    await recordStoppedTurn(
      turn,
      partial,
      stop.userAborted ? stop.abortReason : "because the run was cancelled",
      steps.closing(reply),
    );
    const cacheUsage = sumCacheUsage(callStats);
    const base = {
      reply,
      stopped: true as const,
      modelCalls: entry.ref.modelCalls ?? 0,
    };
    return cacheUsage ? { ...base, cacheUsage } : base;
  }

  await settleGoal();
  const closingText = recoveryDead ? "" : (piLastAssistantTextOrThrow(entry.agentSession) ?? "");
  const reply = entry.ref.silentRequested ? "" : closingText;
  const closing = steps.closing(reply);
  await turn.emit({
    kind: "AgentMessage",
    text: reply,
    step: closing?.step ?? null,
    body: closing?.body ?? {},
  });
  const pendingApprovals = entry.ref.pendingApprovals ?? [];
  const modelCalls = entry.ref.modelCalls ?? 0;
  const cacheUsage = sumCacheUsage(callStats);
  const silent = entry.ref.silentRequested ? { silent: true as const } : {};
  const base = pendingApprovals.length
    ? {
        reply,
        pendingApprovals,
        ...(entry.ref.pausedOnApproval ? { pausedOnApproval: true as const } : {}),
        modelCalls,
        ...silent,
      }
    : { reply, modelCalls, ...silent };
  return cacheUsage ? { ...base, cacheUsage } : base;
}
