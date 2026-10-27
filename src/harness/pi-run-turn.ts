/** Runs one Pi turn end to end: prompt, goal continuation, empty-ending re-prompt and recovery. */
import { goalWorkDigest } from "./goal.ts";
import { textFromContent } from "./pi-payload.ts";
import { finishTurn } from "./turn-finish.ts";
import { watchTurnSignals, type TurnStop } from "./turn-signals.ts";
import { createTurnRecovery } from "./turn-recovery.ts";
import { FALLBACK_CODES, piRoundFailed, piTurnError } from "./turn-recovery.ts";
import { createCallTelemetry } from "./call-telemetry.ts";
import {
  recordSteerIntake,
  imageRefs,
  resumeInterruptedToolCall,
  type BridgedTool,
  type SteerIntake,
} from "./harness-shared.ts";
import { type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { isUserMessage } from "../sessions/items.ts";
import { NonRetryableTurnError, ProviderTurnError } from "../core/turn-error.ts";
import { asError, swallow, swallowAs } from "../util/errors.ts";
import { defaultInteractiveThinkingLevel, modelHasPrices } from "../model/pi-models.ts";
import { type HarnessTurnInput, type HarnessTurnResult } from "./harness.ts";
import { dayMarkerPrefix, userPromptText } from "./replay.ts";
import { estimateHistoryTokens } from "./context-compaction.ts";
import { createStepRecorder, recordingTools, type StepRecorder } from "./pi-step-recorder.ts";
import { countTokens } from "../util/tokens.ts";
import { createGrindMeter } from "./grind.ts";
import { createFloorCapPolicy, enforceGoal, goalPausedNote, goalSteeringNote, type GovernorVerdict } from "./goal.ts";
import {
  type TurnWallClockOutcome,
  EMPTY_ENDING_MIN_BUDGET_MS,
  emptyEndingNote,
  raceTurnWallClock,
  wallClockTurnFailure,
} from "./pi-turn-clock.ts";
import { wantsFastMode, withRequestHeaders, applyTurnEffort } from "./pi-model-runtime.ts";
import {
  type TurnSession,
  type PiAgentWithPayloadHook,
  continuableContext,
  continueAssistantTurn,
  removeIsolatedDirs,
  createTurnTools,
  createTurnSession,
} from "./pi-turn-session.ts";
import type { PiHarnessContext } from "./pi-harness.ts";

/** The agent's recent pi messages as governor work lines: what it said, called and got back. */
function piGoalWork(messages: ReadonlyArray<unknown>): string {
  const lines: string[] = [];
  for (const m of messages as ReadonlyArray<{ role?: string; content?: unknown; toolName?: string }>) {
    if (m.role === "toolResult") lines.push(`tool_result ${m.toolName ?? ""}: ${textFromContent(m.content)}`);
    else if (m.role === "user" || m.role === "assistant") {
      const said = textFromContent(m.content);
      if (said) lines.push(`${m.role}: ${said}`);
      for (const c of Array.isArray(m.content) ? m.content : [])
        if ((c as { type?: string }).type === "toolCall")
          lines.push(
            `tool_call ${(c as { name?: string }).name ?? ""}: ${JSON.stringify((c as { arguments?: unknown }).arguments ?? {})}`,
          );
    }
  }
  return goalWorkDigest(lines);
}
export async function runPiTurn(ctx: PiHarnessContext, dispatched: HarnessTurnInput): Promise<HarnessTurnResult> {
  const { resolveModelId, modelGateway, companyServedId, requiredModel, defaultTurnWallClockMs, signals, opts } = ctx;
  const desiredModelId = dispatched.runtime?.modelId ?? resolveModelId();
  const baseModel = requiredModel(desiredModelId, !dispatched.providerKeys);
  const turnModelGateway = dispatched.providerKeys ? undefined : modelGateway;
  const wantFast = wantsFastMode(dispatched.runtime?.fastMode, desiredModelId);
  const ref: TurnSession["ref"] = {
    current: dispatched.tools,
    documents: dispatched.documents,
    runtimeMutationPending: false,
    runtimeInFlight: new Set(),
    runtimeActorId: dispatched.runtimeActorId,
    pendingApprovals: [],
    silentRequested: false,
    pollFire: !!dispatched.pollFire,
    observeToolResult: dispatched.observeToolResult,
    governGoal: dispatched.governGoal,
    saveGoal: dispatched.saveGoal,
    emit: dispatched.emit,
    scopeLabel: dispatched.scopeLabel,
    orgScopeId: dispatched.orgScopeId,
    toolApprovalGate: dispatched.toolApprovalGate,
    shutdown: dispatched.shutdown,
  };
  let activeSteps: StepRecorder | undefined;
  const tools = recordingTools(createTurnTools(ctx, ref, dispatched), () => activeSteps);
  const resumed = await resumeInterruptedToolCall(dispatched, ref, tools as unknown as BridgedTool[]);
  const turn = resumed ? { ...dispatched, history: resumed } : dispatched;
  const entry = await createTurnSession(
    ctx,
    withRequestHeaders(baseModel, !turnModelGateway?.models[desiredModelId], wantFast),
    turn.session.id,
    turn.systemPrompt,
    turn.history,
    turn.priorTurns,
    turn.providerKeys,
    ref,
    tools,
    turn.loadImage,
  );
  try {
    const turnWallClockMs = turn.turnWallClockMs ?? defaultTurnWallClockMs;

    const activeModel = entry.agentSession.model as { id?: string; headers?: Record<string, string> } | undefined;
    entry.ref.fast = wantFast;
    entry.ref.modelHasPrices = () => !entry.agentSession.model || modelHasPrices(entry.agentSession.model);
    const effectiveModel = activeModel?.id ?? desiredModelId;
    const defaultThinkingLevel = entry.agentSession.model
      ? defaultInteractiveThinkingLevel(entry.agentSession.model)
      : "auto";
    entry.ref.effortLevel = turn.runtime?.effortLevel ?? defaultThinkingLevel;
    applyTurnEffort(entry.agentSession, entry.ref.effortLevel);

    const telemetry = createCallTelemetry(turn, entry);
    const { collectGapWork, callStats } = telemetry;
    turn.onGapWork?.(collectGapWork);
    entry.ref.onGapWork = collectGapWork;
    const continued = turn.continueTurn ? continuableContext(entry.agentSession.agent.state.messages) : null;
    if (continued) entry.agentSession.agent.state.messages = continued;
    else if (turn.continueTurn)
      console.log(`[pi] resume has no seeded context to continue; prompting the input session=${turn.session.id}`);
    const continueTurn = !!continued;
    const grindMeter = createGrindMeter();

    entry.ref.goal = turn.goal ?? null;
    entry.ref.goalMeter = grindMeter;
    entry.ref.goalRound = turn.continueTurn ? 1 : 0;
    const activeGoalAtStart = entry.ref.goal?.status === "active" ? entry.ref.goal : null;
    const pausedGoalAtStart = entry.ref.goal?.status === "paused" ? entry.ref.goal : null;
    const goalNote = (() => {
      if (activeGoalAtStart) return goalSteeringNote(activeGoalAtStart);
      if (pausedGoalAtStart) return goalPausedNote(pausedGoalAtStart);
      return "";
    })();
    const userEntry = continueTurn
      ? turn.history.find((e) => e.seq === turn.resumeUserSeq)
      : await turn.emit({
          kind: "UserMessage",
          text: turn.input,
          externalId: turn.triggerTs ?? turn.entryTs ?? null,
          author: turn.runtimeActorId ?? null,
          body: {
            ...(turn.environment ? { environment: turn.environment } : {}),
            ...(goalNote.trim() ? { goalNote } : {}),
            ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
            ...imageRefs(turn.images),
          },
        });
    const modelPrompt =
      (userEntry
        ? dayMarkerPrefix(
            turn.history.findLast((e) => isUserMessage(e) && e.seq < userEntry.seq),
            userEntry,
          )
        : "") + userPromptText({ goalNote, text: turn.input, environment: turn.environment });
    entry.ref.llmCapture = [];
    entry.ref.modelCalls = 0;
    entry.ref.modelDispatch = [];
    entry.ref.pendingPrepareNextTurn = undefined;
    entry.ref.pendingTransformContext = undefined;
    turn.recordModelCall({
      model: effectiveModel,
      inputTokens:
        entry.composedPromptTokens +
        estimateHistoryTokens(turn.history) +
        (continueTurn ? 0 : countTokens(modelPrompt)),
      entryCount: turn.history.length,
    });

    let thinkTail: Promise<unknown> = Promise.resolve();
    let triggerSeen = continueTurn;
    const toolAbort = new AbortController();
    const pendingSteers: Array<SteerIntake & { prompt: string }> = [];
    let persistError: Error | undefined;
    const persist = (write: () => Promise<unknown>): void => {
      thinkTail = thinkTail.then(async () => {
        if (persistError) return;
        try {
          await write();
        } catch (err) {
          persistError = asError(err);
          toolAbort.abort();
          void entry.agentSession.abort().catch(swallowAs("pi: persist-failure abort", undefined));
        }
      });
    };
    const steps = createStepRecorder(turn, persist);
    activeSteps = steps;
    entry.ref.emit = steps.emit;
    const onMessageEnd = async (message: unknown): Promise<void> => {
      const role = (message as { role?: string }).role;
      if (role === "assistant") steps.assistant(message as AssistantMessage);
      else if (role === "toolResult") steps.toolResult(message as ToolResultMessage);
      else if (role === "user" && !triggerSeen) triggerSeen = true;
      else if (role === "user") {
        steps.flush();
        const text = textFromContent((message as { content?: unknown }).content);
        const steerAt = pendingSteers.findIndex((steer) => steer.prompt === text);
        const steer = steerAt >= 0 ? pendingSteers.splice(steerAt, 1)[0]! : undefined;
        persist(() =>
          steer ? recordSteerIntake(turn, steer) : turn.emit({ kind: "Wake", wakeCause: "system", body: { text } }),
        );
      }
      await thinkTail;
      if (persistError) throw persistError;
    };
    const unsubscribeMessageEnd = (
      entry.agentSession as unknown as { agent?: PiAgentWithPayloadHook }
    ).agent?.subscribe?.((event) => {
      const e = event as { type?: string; message?: unknown };
      if (e.type === "agent_start" && toolAbort.signal.aborted) entry.agentSession.agent.abort();
      if (e.type === "message_end") noteDocumentRejection(e.message);
      return e.type === "message_end" ? onMessageEnd(e.message) : undefined;
    });
    const unsubscribe = entry.agentSession.subscribe(telemetry.onSessionEvent(steps, grindMeter));
    let wallClock!: TurnWallClockOutcome;
    const messagesBefore = entry.agentSession.messages.length;
    entry.ref.goalRecentWork = () => piGoalWork(entry.agentSession.messages.slice(-80));
    const stop: TurnStop = { userAborted: false };
    let recoveryDead = false;
    entry.ref.abortSignal = toolAbort.signal;
    const { release: releaseSignals } = watchTurnSignals({
      turn,
      entry,
      signals,
      toolAbort,
      pendingSteers,
      stop,
    });
    const promptStart = Date.now();
    const floorCap = createFloorCapPolicy({
      goal: () => entry.ref.goal,
      meter: grindMeter,
      promptStart,
      turnWallClockMs,
    });
    const rawRemainingCapMs = floorCap.remainingCapMs;
    const raceCapMs = floorCap.raceCapMs;
    const extendCapMs = floorCap.extendMs;
    const race = (prompting: Promise<void>, capMs = raceCapMs()) =>
      raceTurnWallClock(prompting, { capMs, extendMs: extendCapMs, abort: () => entry.agentSession.abort() });
    const { noteDocumentRejection, retryWithoutDocuments, attemptRefusalFallback, recoverFailedRound } =
      createTurnRecovery({
        turn,
        entry,
        messagesBefore,
        turnWallClockMs,
        raceCapMs,
        race,
        stopped: () => stop.userAborted,
        directModel: (id) => !turnModelGateway?.models[id],
        servedModelId: (id) => (turn.providerKeys ? id : companyServedId(id)),
        resolveFallbackRuntime: () => opts?.resolveFallbackRuntime?.(),
      });
    try {
      const images = turn.images?.length
        ? turn.images.map((i) => ({ type: "image" as const, data: i.dataBase64, mimeType: i.mimeType }))
        : undefined;
      wallClock = await race(
        continueTurn
          ? continueAssistantTurn(entry.agentSession)
          : entry.agentSession.prompt(modelPrompt, images ? { images } : undefined),
      );
      if (wallClock === "ok") await recoverFailedRound();
      const goalAfterPrompt = entry.ref.goal;
      if (wallClock === "ok" && goalAfterPrompt && !stop.userAborted && !turn.cancel?.aborted) {
        wallClock = await enforceGoal({
          goal: goalAfterPrompt,
          meter: grindMeter,
          outcome: wallClock,
          ok: "ok" as const,
          blocked: () =>
            stop.userAborted ||
            !!turn.cancel?.aborted ||
            !!entry.ref.runtimeHandoff ||
            !!entry.ref.pausedOnApproval ||
            !!entry.ref.pendingApprovals?.length ||
            piRoundFailed(entry.agentSession, messagesBefore),
          ...(entry.ref.governGoal
            ? {
                govern: (previous: GovernorVerdict | undefined) =>
                  entry.ref.governGoal!({
                    objective: goalAfterPrompt.objective,
                    trigger: "checkpoint",
                    recentWork: entry.ref.goalRecentWork?.() ?? "",
                    ...(previous ? { previous } : {}),
                  }),
              }
            : {}),
          beforePrompt: async () => {
            console.error(`[goal] continuation session=${turn.session.id} round=${(entry.ref.goalRound ?? 0) + 1}`);
            entry.ref.goalRound = (entry.ref.goalRound ?? 0) + 1;
            entry.ref.silentRequested = false;
            await thinkTail;
          },
          prompt: async (note) => {
            if (turnWallClockMs > 0 && rawRemainingCapMs() < EMPTY_ENDING_MIN_BUDGET_MS) return "aborted";
            const outcome = await race(entry.agentSession.prompt(note));
            if (outcome === "ok") await recoverFailedRound();
            return outcome;
          },
        });
      }
      const note = emptyEndingNote({
        wallClock,
        userAborted: stop.userAborted,
        cancelled: !!turn.cancel?.aborted,
        surfaceTools: !!turn.surfaceTools,
        pollFire: !!turn.pollFire,
        ref: entry.ref,
        session: entry.agentSession,
        turnWallClockMs,
        elapsedMs: turnWallClockMs > 0 ? turnWallClockMs - rawRemainingCapMs() : Date.now() - promptStart,
      });
      if (note) {
        console.error(
          `[pi] empty final response after ${entry.ref.modelCalls} model calls — re-prompting once session=${turn.session.id}`,
        );
        await thinkTail;
        const capMs = raceCapMs();
        if (
          !stop.userAborted &&
          !turn.cancel?.aborted &&
          (turnWallClockMs <= 0 || capMs >= EMPTY_ENDING_MIN_BUDGET_MS)
        ) {
          try {
            const outcome = await race(entry.agentSession.prompt(note), capMs);
            if (outcome !== "ok" && !stop.userAborted) {
              recoveryDead = true;
            } else if (
              outcome === "ok" &&
              !stop.userAborted &&
              !(entry.agentSession.getLastAssistantText() ?? "").trim()
            ) {
              console.error(`[pi] turn still ended empty after re-prompt session=${turn.session.id}`);
            }
          } catch (e) {
            swallow("pi: empty-ending re-prompt", e);
            recoveryDead = true;
          }
        }
      }
    } catch (err) {
      if (persistError) throw persistError;
      const cancelAbortRejection =
        turn.cancel?.aborted === true && (err as { name?: string } | null)?.name === "AbortError";
      if (!stop.userAborted && !cancelAbortRejection) {
        const turnErr = piTurnError(entry.agentSession, err, messagesBefore);
        let recovered = false;
        try {
          recovered = await retryWithoutDocuments();
        } catch (e) {
          swallow("pi: document-free retry", e);
        }
        if (!recovered && turnErr instanceof ProviderTurnError && FALLBACK_CODES.has(turnErr.code)) {
          try {
            recovered = await attemptRefusalFallback(turnErr.message);
          } catch (e) {
            swallow("pi: refusal fallback", e);
          }
        }
        if (!recovered && !stop.userAborted) throw turnErr;
      }
      wallClock = "ok";
    } finally {
      await releaseSignals();
      if (pendingSteers.length) entry.agentSession.clearQueue();
      unsubscribeMessageEnd?.();
      unsubscribe?.();
      steps.settleResults();
      activeSteps = undefined;
      entry.ref.emit = turn.emit;
      await thinkTail;
      await telemetry.drainCaptured(userEntry?.seq ?? null, effectiveModel);
      entry.ref.onGapWork = undefined;
      toolAbort.abort();
      entry.ref.abortSignal = undefined;
      entry.ref.observeToolResult = undefined;
    }
    if (persistError) throw persistError;
    if (wallClockTurnFailure(wallClock, stop.userAborted, turn.cancel?.aborted === true)) {
      const capLabel =
        turnWallClockMs % 60_000 === 0
          ? `${turnWallClockMs / 60_000}-minute`
          : `${Math.round(turnWallClockMs / 1000)}-second`;
      throw new NonRetryableTurnError(
        `the turn hit its ${capLabel} wall-clock limit and was stopped` +
          (wallClock === "abandoned" ? " (a stuck operation did not respond to cancellation)" : ""),
      );
    }
    return await finishTurn({
      turn,
      entry,
      steps,
      grindMeter,
      stop,
      callStats,
      messagesBefore,
      recoveryDead,
      settled: async () => {
        await thinkTail;
        if (persistError) throw persistError;
      },
    });
  } finally {
    removeIsolatedDirs(entry);
  }
}
