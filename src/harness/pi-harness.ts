import { finishTurn } from "./turn-finish.ts";
import { watchTurnSignals, type TurnStop } from "./turn-signals.ts";
import { createTurnRecovery } from "./turn-recovery.ts";
import {
  FALLBACK_CODES,
  documentsDroppedNote,
  piRoundFailed,
  piTurnError,
  refusalFallbackModelId,
} from "./turn-recovery.ts";
import { createCallTelemetry } from "./call-telemetry.ts";
import {
  recordSteerIntake,
  imageRefs,
  resumeInterruptedToolCall,
  type BridgedTool,
  type SteerIntake,
} from "./harness-shared.ts";
import { withDocumentInputs, type DocumentModel } from "./document-inputs.ts";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  type Api,
  type AssistantMessage,
  type Model,
  type ModelThinkingLevel,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { baseModelProviders, configuredModel, CONFIG_DEFAULTS, type Config } from "../config.ts";
import type { ConversationTurn } from "../types.ts";
import { isUserMessage, type Item } from "../sessions/items.ts";
import { NonRetryableTurnError, ProviderTurnError } from "../core/turn-error.ts";
import { asError, swallow, swallowAs } from "../util/errors.ts";
import {
  auxiliaryModelFor,
  auxiliaryModelForProvider,
  defaultModel,
  defaultInteractiveThinkingLevel,
  resolveModel,
  getRequiredModel,
  contextTokenBudgetForModel,
  modelHasPrices,
} from "../model/pi-models.ts";
import { modelGatewayRequest, type ModelGatewayTransportConfig } from "../model/provider-endpoints.ts";
import {
  defineHarness,
  type Harness,
  type HarnessCompactInput,
  type HarnessDetectInput,
  type HarnessDetectResult,
  type HarnessTurnInput,
  type HarnessTurnResult,
} from "./harness.ts";
import {
  coreToolOptions,
  createAgentTools,
  pauseStampAfterToolCall,
  type CoreToolOptions,
  type ToolContextRef,
} from "./agent-tools.ts";
import { type RunSignalStore } from "../runs/run-signal-store.ts";
import {
  planColdStartSeed,
  reconstructMessagesFromHistory,
  dayMarkerPrefix,
  replayPreamble,
  userPromptText,
  seedPriorTurns,
  legacyAssistant,
  type PiReplayMessage,
  type SeededMessage,
} from "./replay.ts";
import { estimateHistoryTokens } from "./context-compaction.ts";
import { createStepRecorder, recordingTools, type StepRecorder } from "./pi-step-recorder.ts";
import { restoreReplayImages, type ReplayImageLoader } from "./replay-images.ts";
import { summarizeHistory } from "./history-summary.ts";
import { countTokens } from "../util/tokens.ts";
import {
  parseSecurityScreenVerdict,
  SECURITY_SCREEN_STEP,
  SECURITY_SCREEN_SYSTEM_PROMPT,
} from "../security/security-screen.ts";
import { errMessage } from "../util/errors.ts";
import { createGrindMeter } from "./grind.ts";
import {
  createFloorCapPolicy,
  enforceGoal,
  goalPausedNote,
  goalSteeringNote,
  goalWorkDigest,
  type GovernorVerdict,
} from "./goal.ts";
import {
  type ProviderKeys,
  buildModelRuntime,
  complete,
  wantsFastMode,
  applyFastSpeed,
  resolveConfiguredModelId,
  withRequestHeaders,
  applyTurnEffort,
  applyReasoningMode,
} from "./pi-model-runtime.ts";
import {
  buildDetectionPrompt,
  parseDetectVerdict,
  renderDetectPrompt,
  TITLE_GENERATION_PROMPT,
  titleUserPrompt,
  ACK_EMOJI_PROMPT,
  APPROVAL_SUMMARY_PROMPT,
  sanitizeTitle,
} from "./pi-aux-prompts.ts";
import {
  GATEWAY_REQUEST_MAX_BYTES,
  trimPayloadToByteBudget,
  sanitizeLlmPayload,
  textFromContent,
  guardOutputBudget,
} from "./pi-payload.ts";
import {
  type TurnWallClockOutcome,
  EMPTY_ENDING_MIN_BUDGET_MS,
  emptyEndingNote,
  raceTurnWallClock,
  wallClockTurnFailure,
} from "./pi-turn-clock.ts";

export interface PiHarnessOptions extends CoreToolOptions {
  defaultModelId?: string;
  resolveBaseModelId?: () => string | undefined;
  resolveFallbackRuntime?: () => { modelId: string; effortLevel?: string; fastMode?: boolean } | undefined;
  companyModelId?: (id: string) => string;
  detectModelId?: string;
  titleModelId?: string;
  judgeModelId?: string;
  apiKey?: string;
  openaiApiKey?: string;
  openrouterApiKey?: string;
  modelGateway?: ModelGatewayTransportConfig;
  resolveProviderKeys?: () => Promise<ProviderKeys>;
  tempDirPrefix?: string;
  captureRequests?: boolean;
  systemCacheSplit?: boolean;
  turnWallClockMs?: number;
  signals?: RunSignalStore;
}

export function piHarnessConfigOptions(config: Config): PiHarnessOptions {
  const defaultModelId =
    configuredModel(config) ?? (config.modelProvider ? defaultModel(undefined, baseModelProviders(config)) : undefined);
  return {
    ...(defaultModelId ? { defaultModelId } : {}),
    ...(config.detectModelId ? { detectModelId: config.detectModelId } : {}),
    ...(config.titleModelId ? { titleModelId: config.titleModelId } : {}),
    ...(config.judgeModelId ? { judgeModelId: config.judgeModelId } : {}),
    ...(config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {}),
    ...(config.openaiApiKey ? { openaiApiKey: config.openaiApiKey } : {}),
    ...(config.openrouterApiKey ? { openrouterApiKey: config.openrouterApiKey } : {}),
    ...(config.modelGateway ? { modelGateway: config.modelGateway } : {}),
    systemCacheSplit: config.piSystemCacheSplit,
    ...coreToolOptions(config),
    turnWallClockMs: config.turnWallClockMs,
  };
}

interface TurnSession {
  agentSession: AgentSession;
  ref: ToolContextRef & { effortLevel?: string };
  composedPromptTokens: number;
  cwd: string;
  agentDir: string;
  ephemeralCwd?: string;
}

interface IsolatedResources {
  resourceLoader: DefaultResourceLoader;
  settingsManager: SettingsManager;
  cwd: string;
  agentDir: string;
  ephemeralCwd?: string;
}

type PiPayloadHook = (payload: unknown, model: unknown) => unknown | Promise<unknown>;
type PiResponseHook = (
  response: { status: number; headers: Record<string, string> },
  model: unknown,
) => void | Promise<void>;
type PiTransformContextHook = (messages: unknown, signal?: unknown) => unknown | Promise<unknown>;
type PiPrepareNextTurnHook = (signal?: unknown) => unknown | Promise<unknown>;
interface PiAgentWithPayloadHook {
  onPayload?: PiPayloadHook;
  onResponse?: PiResponseHook;
  transformContext?: PiTransformContextHook;
  prepareNextTurn?: PiPrepareNextTurnHook;
  afterToolCall?: (
    info: unknown,
    signal?: unknown,
  ) => Promise<{ terminate?: boolean } | undefined> | { terminate?: boolean } | undefined;
  subscribe?(listener: (event: unknown) => Promise<void> | void): () => void;
}

export function continuableContext<M extends { role?: unknown }>(messages: readonly M[]): M[] | null {
  let end = messages.length;
  while (messages[end - 1]?.role === "assistant") end--;
  const role = messages[end - 1]?.role;
  return role === "user" || role === "toolResult" ? messages.slice(0, end) : null;
}

function continueAssistantTurn(session: AgentSession): Promise<void> {
  return (session as unknown as { _runAgentPrompt(messages: readonly unknown[]): Promise<void> })._runAgentPrompt([]);
}

interface PiSeedTarget {
  agent?: { state?: { messages?: unknown[] } };
  sessionManager?: { appendMessage?: (message: unknown) => unknown };
}

export function toPiMessage(m: SeededMessage): PiReplayMessage {
  return m.role === "assistant"
    ? legacyAssistant([{ type: "text", text: m.text }], Date.now())
    : { role: "user", content: [{ type: "text", text: m.text }], timestamp: Date.now() };
}

export function seedRawMessagesIntoSession(session: unknown, messages: readonly PiReplayMessage[]): void {
  if (!messages.length) return;
  const target = session as PiSeedTarget;
  const liveMessages = target.agent?.state?.messages;
  const appendMessage = target.sessionManager?.appendMessage?.bind(target.sessionManager);
  for (const message of messages) {
    if (Array.isArray(liveMessages)) liveMessages.push(message);
    if (appendMessage) {
      try {
        appendMessage(message);
      } catch (e) {
        swallow("pi: replay message append", e);
      }
    }
  }
}

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

export function stableCwd(prefix: string): string {
  return join(tmpdir(), `${prefix}-cwd`);
}

async function createIsolatedResources(prefix: string, systemPrompt: string): Promise<IsolatedResources> {
  let cwd = stableCwd(prefix);
  let ephemeralCwd: string | undefined;
  try {
    mkdirSync(cwd, { recursive: true });
    if (!statSync(cwd).isDirectory()) throw new Error(`${cwd} is not a directory`);
  } catch (e) {
    swallow("pi: shared cwd unavailable; using a per-turn cwd (prompt cache prefix changes)", e);
    cwd = mkdtempSync(join(tmpdir(), `${prefix}-cwd-`));
    ephemeralCwd = cwd;
  }
  const agentDir = mkdtempSync(join(tmpdir(), `${prefix}-agent-`));
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    systemPrompt,
    appendSystemPrompt: [],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  return { resourceLoader, settingsManager, cwd, agentDir, ...(ephemeralCwd ? { ephemeralCwd } : {}) };
}

function removeIsolatedDirs(dirs: { agentDir: string; ephemeralCwd?: string }): void {
  for (const dir of [dirs.agentDir, dirs.ephemeralCwd]) {
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      swallow("pi: temp dir cleanup", e);
    }
  }
}

async function openAgentSession(
  prefix: string,
  systemPrompt: string,
  options: Pick<
    Parameters<typeof createAgentSession>[0] & object,
    "model" | "modelRuntime" | "customTools" | "sessionManager" | "thinkingLevel"
  >,
): Promise<{ session: AgentSession; dirs: IsolatedResources }> {
  const dirs = await createIsolatedResources(prefix, systemPrompt);
  try {
    const { resourceLoader, settingsManager, cwd, agentDir } = dirs;
    const { session } = await createAgentSession({
      ...options,
      resourceLoader,
      settingsManager,
      noTools: "builtin",
      cwd,
      agentDir,
    });
    return { session, dirs };
  } catch (err) {
    removeIsolatedDirs(dirs);
    throw err;
  }
}

export { modelSupportsFastMode } from "../model/pi-models.ts";

export function createPiHarness(opts?: PiHarnessOptions): Harness {
  const resolveModelId = (): string => resolveConfiguredModelId(undefined, opts?.defaultModelId);
  const auxiliaryModelId = (): string =>
    auxiliaryModelFor(resolveConfiguredModelId(opts?.resolveBaseModelId?.(), opts?.defaultModelId));
  const detectModelId = (): string => opts?.detectModelId ?? auxiliaryModelId();
  const titleModelId = (): string => opts?.titleModelId ?? auxiliaryModelId();
  const judgeModelId = (): string => opts?.judgeModelId ?? auxiliaryModelId();
  const tempDirPrefix = opts?.tempDirPrefix ?? "pi";
  const configuredProviderKeys: ProviderKeys = opts?.resolveProviderKeys
    ? {}
    : {
        ...(opts?.apiKey ? { anthropic: opts.apiKey } : {}),
        ...(opts?.openaiApiKey ? { openai: opts.openaiApiKey } : {}),
        ...(opts?.openrouterApiKey ? { openrouter: opts.openrouterApiKey } : {}),
      };
  const resolveProviderKeys = async (): Promise<ProviderKeys> => ({
    ...configuredProviderKeys,
    ...(await opts?.resolveProviderKeys?.()),
  });
  const modelGateway = opts?.modelGateway;
  const companyServedId = (id: string) => (opts?.companyModelId ? opts.companyModelId(id) : id);
  const requiredModel = (id: string, company = true) => getRequiredModel(company ? companyServedId(id) : id);
  const keyForModel = (keys: ProviderKeys, model: Model<Api>): string | undefined =>
    modelGatewayRequest(modelGateway, model)?.apiKey ?? keys[String(model.provider)];
  const captureRequests = opts?.captureRequests ?? true;
  const systemCacheSplit = opts?.systemCacheSplit ?? false;
  const defaultTurnWallClockMs = opts?.turnWallClockMs ?? CONFIG_DEFAULTS.turnWallClockSec * 1000;
  const signals = opts?.signals;
  function createTurnTools(ref: ToolContextRef, turn: HarnessTurnInput): ToolDefinition[] {
    return createAgentTools(ref, {
      scratchExec: opts?.scratchExec,
      reachExec: opts?.reachExec,
      controlTools: opts?.controlTools,
      execTimeoutMs: opts?.execTimeoutMs,
      execTimeoutCeilingMs: opts?.execTimeoutCeilingMs,
      backgroundJobTtlMs: opts?.backgroundJobTtlMs,
      backgroundJobTtlMaxMs: opts?.backgroundJobTtlMaxMs,
      sessionTools: Boolean(turn.tools.sessionSyscalls),
      delegateWork: turn.delegateWork === true,
      mcpTools: turn.mcpTools,
      surfaceTools: turn.surfaceTools,
      surfaceName: turn.surfaceName || undefined,
      clientTools: turn.clientTools,
      readOnly: turn.readOnly,
    });
  }
  async function createTurnSession(
    model: Model<Api>,
    sessionId: string,
    systemPrompt: string,
    history: Item[],
    priorTurns: ConversationTurn[] | undefined,
    turnProviderKeys: ProviderKeys | undefined,
    ref: TurnSession["ref"],
    tools: ToolDefinition[],
    loadImage: ReplayImageLoader | undefined,
  ): Promise<TurnSession> {
    let reconstructed: PiReplayMessage[] | null;
    try {
      reconstructed = await restoreReplayImages(reconstructMessagesFromHistory(history), loadImage);
    } catch (err) {
      console.error("[pi-harness] history reconstruction failed; will fall back:", errMessage(err));
      reconstructed = null;
    }
    const seedPlan = planColdStartSeed(reconstructed, !!priorTurns?.length);
    const composedPrompt = systemPrompt + (seedPlan === "preamble" ? replayPreamble(history) : "");

    const modelRuntime = await buildModelRuntime(
      turnProviderKeys ?? (await resolveProviderKeys()),
      turnProviderKeys ? undefined : modelGateway,
      systemCacheSplit ? "long" : undefined,
    );
    const { session, dirs } = await openAgentSession(tempDirPrefix, composedPrompt, {
      model,
      modelRuntime,
      customTools: tools,
      sessionManager: SessionManager.inMemory(undefined, { id: sessionId }),
    });

    if (seedPlan === "structured" || seedPlan === "priorTurns") {
      const structured = seedPlan === "structured";
      try {
        seedRawMessagesIntoSession(
          session,
          structured ? reconstructed! : seedPriorTurns(priorTurns!, []).map(toPiMessage),
        );
      } catch (err) {
        console.error(
          `[pi-harness] failed to seed ${structured ? "reconstructed history (continuing without it)" : "prior turns (continuing without them)"}:`,
          errMessage(err),
        );
      }
    }

    const agent = (session as unknown as { agent?: PiAgentWithPayloadHook }).agent;
    if (agent) {
      const prior = agent.onPayload;
      agent.onPayload = async (payload, model) => {
        ref.modelCalls = (ref.modelCalls ?? 0) + 1;
        (ref.modelDispatch ??= []).push({
          start: Date.now(),
          ...(ref.pendingPrepareNextTurn !== undefined ? { prepareNextTurn: ref.pendingPrepareNextTurn } : {}),
          ...(ref.pendingTransformContext !== undefined ? { transformContext: ref.pendingTransformContext } : {}),
        });
        ref.pendingPrepareNextTurn = undefined;
        ref.pendingTransformContext = undefined;
        applyFastSpeed(payload, ref.fast, (model as { api?: string } | undefined)?.api);
        applyReasoningMode(payload, model as Model<Api>, ref.effortLevel);
        const result = prior ? await prior(payload, model) : payload;
        const capturedPayload = captureRequests ? sanitizeLlmPayload(result ?? payload, model) : undefined;
        let finalPayload = await withDocumentInputs(
          result ?? payload,
          model as DocumentModel,
          ref.documents ?? [],
          ref.abortSignal,
          ref.documentsStubbed ? documentsDroppedNote(ref.documents ?? []) : undefined,
        );
        const guarded = guardOutputBudget(finalPayload, model);
        if (guarded.kind === "raised") {
          console.error(
            `[pi] output-budget guard raised output cap ${guarded.from} -> ${guarded.to} (estimated prompt ${guarded.estimatedPromptTokens} tokens) session=${sessionId}`,
          );
        }
        try {
          const gateway = modelGatewayRequest(turnProviderKeys ? undefined : modelGateway, model as Model<Api>);
          finalPayload = trimPayloadToByteBudget(finalPayload, gateway ? GATEWAY_REQUEST_MAX_BYTES : undefined);
        } catch (e) {
          swallow("pi: request byte budget", e);
        }
        if (captureRequests) ref.llmCapture?.push(capturedPayload!);
        return finalPayload;
      };
      const priorResponse = agent.onResponse;
      agent.onResponse = async (response, model) => {
        const last = ref.modelDispatch?.at(-1);
        if (last && last.first === undefined) last.first = Date.now();
        if (priorResponse) await priorResponse(response, model);
      };
      const priorTransform = agent.transformContext;
      agent.transformContext = async (messages, signal) => {
        ref.pendingTransformContext = Date.now();
        return priorTransform ? await priorTransform(messages, signal) : messages;
      };
      agent.afterToolCall = pauseStampAfterToolCall(ref, agent.afterToolCall);
      const priorPrepare = agent.prepareNextTurn;
      agent.prepareNextTurn = async (signal) => {
        ref.pendingPrepareNextTurn = Date.now();
        return priorPrepare ? await priorPrepare(signal) : undefined;
      };
    }

    return {
      agentSession: session,
      ref,
      composedPromptTokens: countTokens(composedPrompt),
      cwd: dirs.cwd,
      agentDir: dirs.agentDir,
      ...(dirs.ephemeralCwd ? { ephemeralCwd: dirs.ephemeralCwd } : {}),
    };
  }

  /** One isolated completion on `modelId`; null when no provider key serves that model. */
  async function keyedOneShot(
    modelId: string,
    systemPrompt: string,
    prompt: string,
    extra?: { signal?: AbortSignal; thinkingLevel?: ModelThinkingLevel },
  ): Promise<string | undefined | null> {
    const model = requiredModel(modelId);
    const providerKeys = await resolveProviderKeys();
    if (!keyForModel(providerKeys, model)) return null;
    return complete(model, providerKeys, systemPrompt, prompt, { modelGateway, ...extra });
  }

  return defineHarness({
    async runTurn(dispatched: HarnessTurnInput): Promise<HarnessTurnResult> {
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
      const tools = recordingTools(createTurnTools(ref, dispatched), () => activeSteps);
      const resumed = await resumeInterruptedToolCall(dispatched, ref, tools as unknown as BridgedTool[]);
      const turn = resumed ? { ...dispatched, history: resumed } : dispatched;
      const entry = await createTurnSession(
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
    },

    async shouldRespond(detect: HarnessDetectInput): Promise<HarnessDetectResult> {
      const modelId = detectModelId();
      const model = requiredModel(modelId);
      const providerKeys = await resolveProviderKeys();
      if (!keyForModel(providerKeys, model)) return { respond: true };
      const detectSystemPrompt = buildDetectionPrompt(detect.reactionGuidance);
      const prompt = renderDetectPrompt(detect);
      detect.recordModelCall({
        model: modelId,
        inputTokens: countTokens(detectSystemPrompt) + countTokens(prompt),
        entryCount: detect.history.length,
      });
      const out = ((await complete(model, providerKeys, detectSystemPrompt, prompt, { modelGateway })) ?? "").trim();
      return parseDetectVerdict(out, Boolean(detect.reactionGuidance?.trim()));
    },

    async compactHistory(input: HarnessCompactInput): Promise<string> {
      const primaryId = resolveModelId();
      const providerKeys = await resolveProviderKeys();
      const runtime = await buildModelRuntime(providerKeys, modelGateway);
      const summarize = (compactModelId: string) =>
        summarizeHistory(input.history, requiredModel(compactModelId), (summaryModel, context, options) => {
          input.recordModelCall({
            model: compactModelId,
            inputTokens: countTokens(context.systemPrompt ?? "") + countTokens(JSON.stringify(context.messages)),
            entryCount: input.history.length,
          });
          return runtime.streamSimple(summaryModel, context, options);
        });
      try {
        return await summarize(primaryId);
      } catch (error) {
        const fallbackId = refusalFallbackModelId(
          primaryId,
          opts?.resolveFallbackRuntime?.()?.modelId,
          (id) => !!resolveModel(companyServedId(id)),
        );
        if (
          !(error instanceof ProviderTurnError) ||
          error.code !== "refusal" ||
          !fallbackId ||
          !resolveModel(companyServedId(fallbackId)) ||
          companyServedId(fallbackId) === companyServedId(primaryId)
        )
          throw error;
        console.error(
          `[pi] compaction failed on ${primaryId}; retrying on fallback model ${fallbackId}: ${error.message}`,
        );
        return summarize(fallbackId);
      }
    },

    contextTokenBudget(_scopeLabel?: string, model?: string): number | undefined {
      const id = model && resolveModel(model) ? model : resolveModelId();
      return contextTokenBudgetForModel(id);
    },

    async oneShot(systemPrompt: string, prompt: string): Promise<string | undefined> {
      return (await keyedOneShot(resolveModelId(), systemPrompt, prompt)) ?? undefined;
    },

    async judge(systemPrompt: string, prompt: string, signal?: AbortSignal): Promise<string | undefined> {
      const out = await keyedOneShot(judgeModelId(), systemPrompt, prompt, {
        signal,
        thinkingLevel: "low",
      });
      return out ?? undefined;
    },

    async screenSecurity({
      payload,
      modelId: configuredScreenModel,
      systemPrompt = SECURITY_SCREEN_SYSTEM_PROMPT,
      signal,
      recordModelCall,
      recordLlmRequest,
    }) {
      try {
        const modelId = configuredScreenModel ?? detectModelId();
        const model = requiredModel(modelId);
        const providerKeys = await resolveProviderKeys();
        if (!keyForModel(providerKeys, model)) return undefined;
        recordModelCall({
          model: modelId,
          inputTokens: countTokens(systemPrompt) + countTokens(payload),
          entryCount: 1,
        });
        await recordLlmRequest?.({
          turnSeq: null,
          step: SECURITY_SCREEN_STEP,
          model: modelId,
          promptEnvelope: { system: systemPrompt, messages: [{ role: "user", content: payload }] },
          truncated: false,
        });
        return parseSecurityScreenVerdict(
          await complete(model, providerKeys, systemPrompt, payload, {
            signal,
            modelGateway,
          }),
        );
      } catch (e) {
        swallow("pi: security screen", e);
        return undefined;
      }
    },

    async pickAckEmoji(text: string, candidates: readonly string[]): Promise<string | undefined> {
      if (!text.trim() || candidates.length === 0) return undefined;
      const ackModelId = auxiliaryModelForProvider("anthropic");
      if (!ackModelId) return undefined;
      try {
        const model = requiredModel(ackModelId);
        const providerKeys = await resolveProviderKeys();
        if (!keyForModel(providerKeys, model)) return undefined;
        const prompt = `Candidates: ${candidates.join(", ")}\n\nMessage: ${text.slice(0, 2000)}`;
        // Haiku thinks by default; a 64-token budget would go entirely to thinking.
        const raw = await complete(model, providerKeys, ACK_EMOJI_PROMPT, prompt, {
          modelGateway,
          thinkingLevel: "off",
          maxTokens: 64,
          retry: false,
          signal: AbortSignal.timeout(2_000),
        });
        if (!raw) return undefined;
        const emoji = (JSON.parse(raw.replace(/```json|```/g, "").trim()) as { emoji?: unknown }).emoji;
        return typeof emoji === "string" && candidates.includes(emoji) ? emoji : undefined;
      } catch (e) {
        swallow("pi: ack emoji", e);
        return undefined;
      }
    },

    async generateTitle(transcript: string): Promise<string | undefined> {
      if (!transcript.trim()) return undefined;
      const out = await keyedOneShot(titleModelId(), TITLE_GENERATION_PROMPT, titleUserPrompt(transcript));
      return out === null ? undefined : sanitizeTitle(out);
    },

    async summarizeApproval(command: string, reason: string, purpose?: string): Promise<string | undefined> {
      if (!command.trim()) return undefined;
      const prompt = [
        `Policy flagged this as: ${reason}`,
        purpose ? `Agent's stated purpose: ${purpose}` : "",
        "",
        "Command:",
        command.slice(0, 4000),
      ].join("\n");
      const out = (await keyedOneShot(titleModelId(), APPROVAL_SUMMARY_PROMPT, prompt))?.trim();
      if (!out || out === "NONE") return undefined;
      return out.replace(/^["']|["']$/g, "").slice(0, 300);
    },
  });
}
