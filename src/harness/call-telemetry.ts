import type { AgentSession, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import type { HarnessTurnInput } from "./harness.ts";
import type { ModelCallLog } from "./model-call-log.ts";
import type { GoalRecord } from "./goal.ts";
import type { StepRecorder } from "./pi-step-recorder.ts";
import { meterGrindCall, type GrindMeter } from "./grind.ts";
import { meterGoalCall } from "./goal.ts";
import { swallow } from "../util/errors.ts";
import type { LlmCallUsage } from "../sessions/session-store.ts";
import { calculateCost, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import { FAST_COST_MULTIPLIER, scaleCost } from "./pi-model-runtime.ts";

export interface PerCallStat {
  usage: LlmCallUsage | null;
}

const GATEWAY_ATTEMPT_HEADERS = [
  "x-litellm-attempted-retries",
  "x-litellm-attempted-fallbacks",
  "x-litellm-response-duration-ms",
  "x-litellm-overhead-duration-ms",
  "x-litellm-model-group",
  "x-litellm-model-api-base",
  "x-litellm-call-id",
  "llm_provider-openai-processing-ms",
  "llm_provider-x-request-id",
  "llm_provider-request-id",
  "openai-processing-ms",
  "x-request-id",
  "request-id",
];

export function gatewayAttemptHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const out: Record<string, string> = {};
  for (const name of GATEWAY_ATTEMPT_HEADERS) {
    const value = lower.get(name);
    if (typeof value === "string" && value) out[name] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function piUsageToCallUsage(
  u: Partial<Usage> | undefined,
  model: Model<Api> | undefined,
  fast: boolean | undefined,
): LlmCallUsage | null {
  if (!u) return null;
  const row: LlmCallUsage = {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    totalTokens: u.totalTokens ?? 0,
    costUsd: u.cost?.total ?? 0,
  };
  if (!fast || !model?.cost) return row;
  const priced: Usage = {
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    ...(typeof u.cacheWrite1h === "number" ? { cacheWrite1h: Math.min(u.cacheWrite1h, row.cacheWrite) } : {}),
    totalTokens: row.totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const card = fast ? ({ ...model, cost: scaleCost(model.cost, FAST_COST_MULTIPLIER) } as Model<Api>) : model;
  row.costUsd = calculateCost(card, priced).total;
  return row;
}

export function sumCacheUsage(
  stats: ReadonlyArray<{ usage: LlmCallUsage | null }>,
): { cacheRead: number; cacheWrite: number; uncachedInput: number } | null {
  let saw = false;
  let cacheRead = 0;
  let cacheWrite = 0;
  let uncachedInput = 0;
  for (const s of stats) {
    if (!s.usage) continue;
    saw = true;
    cacheRead += s.usage.cacheRead;
    cacheWrite += s.usage.cacheWrite;
    uncachedInput += s.usage.input;
  }
  return saw ? { cacheRead, cacheWrite, uncachedInput } : null;
}

export function createCallTelemetry(
  turn: HarnessTurnInput,
  session: AgentSession,
  calls: Pick<ModelCallLog, "takeCaptured" | "takeDispatches">,
  fast: () => boolean | undefined,
  goal: () => GoalRecord | null | undefined,
) {
  const callStats: Array<PerCallStat> = [];

  const onSessionEvent =
    (steps: StepRecorder, grindMeter: GrindMeter): AgentSessionEventListener =>
    (event) => {
      if (event.type === "message_start" && (event.message as { role?: string }).role === "assistant") {
        steps.startStreaming();
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_start") {
        turn.onTextBlockStart?.();
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_start") {
        const block = event.assistantMessageEvent.partial.content[event.assistantMessageEvent.contentIndex];
        if (block?.type === "toolCall") turn.onToolCallStart?.(block.name);
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        turn.onDelta?.(event.assistantMessageEvent.delta);
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
        const { contentIndex, delta, partial } = event.assistantMessageEvent;
        const block = partial.content[contentIndex];
        if (block?.type === "thinking" && !block.redacted)
          turn.onReasoningDelta?.(steps.streamingStepId(), contentIndex, delta);
      } else if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
        const u = (event.message as { usage?: Partial<Usage> }).usage;
        const stepModel = session.model;
        const usage = piUsageToCallUsage(u, stepModel, fast());
        meterGrindCall(grindMeter, usage);
        const meteredGoal = goal();
        if (meteredGoal?.status === "active") meterGoalCall(meteredGoal, usage);
        callStats.push({
          usage,
        });
      }
    };
  const drainCaptured = async (turnSeq: number | null, effectiveModel: string): Promise<void> => {
    const captured = calls.takeCaptured();
    if (!turn.recordLlmRequest) return;
    const statsAligned = callStats.length === captured.length;
    const dispatch = calls.takeDispatches();
    const dispatchAligned = dispatch.length === captured.length;
    for (let step = 0; step < captured.length; step++) {
      const stat = statsAligned ? callStats[step] : undefined;
      const d = dispatchAligned ? dispatch[step] : undefined;
      try {
        await turn.recordLlmRequest({
          turnSeq,
          step,
          model: captured[step]!.transport?.modelId ?? effectiveModel,
          transport: d?.gateway
            ? { ...captured[step]!.transport, gateway: d.gateway }
            : (captured[step]!.transport ?? null),
          usage: stat?.usage ?? null,
        });
      } catch (e) {
        swallow("pi: llm request record", e);
      }
    }
  };
  return { callStats, onSessionEvent, drainCaptured };
}
