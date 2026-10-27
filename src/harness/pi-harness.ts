import { type Api, type Model } from "@earendil-works/pi-ai";
import { baseModelProviders, configuredModel, CONFIG_DEFAULTS, type Config } from "../config.ts";
import { auxiliaryModelFor, defaultModel, getRequiredModel } from "../model/pi-models.ts";
import { modelGatewayRequest, type ModelGatewayTransportConfig } from "../model/provider-endpoints.ts";
import { defineHarness, type Harness } from "./harness.ts";
import { coreToolOptions, type CoreToolOptions } from "./agent-tools.ts";
import { type RunSignalStore } from "../runs/run-signal-store.ts";
import { type ProviderKeys, resolveConfiguredModelId } from "./pi-model-runtime.ts";
import { runPiTurn } from "./pi-run-turn.ts";
import {
  piShouldRespond,
  piCompactHistory,
  piContextTokenBudget,
  piOneShot,
  piJudge,
  piScreenSecurity,
  piPickAckEmoji,
  piGenerateTitle,
  piSummarizeApproval,
} from "./pi-side-calls.ts";

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
    ...coreToolOptions(config),
    turnWallClockMs: config.turnWallClockMs,
  };
}

export { modelSupportsFastMode } from "../model/pi-models.ts";

export type PiHarnessContext = ReturnType<typeof piHarnessContext>;

function piHarnessContext(opts?: PiHarnessOptions) {
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
  const defaultTurnWallClockMs = opts?.turnWallClockMs ?? CONFIG_DEFAULTS.turnWallClockSec * 1000;
  const signals = opts?.signals;
  return {
    resolveModelId,
    detectModelId,
    titleModelId,
    judgeModelId,
    tempDirPrefix,
    resolveProviderKeys,
    modelGateway,
    companyServedId,
    requiredModel,
    keyForModel,
    captureRequests,
    defaultTurnWallClockMs,
    signals,
    opts,
  };
}

export function createPiHarness(opts?: PiHarnessOptions): Harness {
  const ctx = piHarnessContext(opts);
  return defineHarness({
    runTurn: (turn) => runPiTurn(ctx, turn),
    shouldRespond: (detect) => piShouldRespond(ctx, detect),
    compactHistory: (input) => piCompactHistory(ctx, input),
    contextTokenBudget: (scopeLabel, model) => piContextTokenBudget(ctx, scopeLabel, model),
    oneShot: (systemPrompt, prompt) => piOneShot(ctx, systemPrompt, prompt),
    judge: (systemPrompt, prompt, signal) => piJudge(ctx, systemPrompt, prompt, signal),
    screenSecurity: (input) => piScreenSecurity(ctx, input),
    pickAckEmoji: (text, candidates) => piPickAckEmoji(ctx, text, candidates),
    generateTitle: (transcript) => piGenerateTitle(ctx, transcript),
    summarizeApproval: (command, reason, purpose) => piSummarizeApproval(ctx, command, reason, purpose),
  });
}
