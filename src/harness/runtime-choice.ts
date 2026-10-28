import type { ScopedConfigStore, RuntimePurpose } from "../resolution/config-store.ts";
import {
  defaultModel,
  fastModeModelIds,
  modelSupported,
  resolveModel,
  safeModelMetadata,
  thinkingLevelsFor,
  modelUnavailableReason,
} from "../model/pi-models.ts";
import type { ScopeId } from "../types.ts";
import type { Harness, HarnessTurnInput, RuntimeChoice } from "./harness.ts";
import { NON_INTERACTIVE_THINKING_LEVEL, NON_INTERACTIVE_FAST_MODE } from "../core/turn-options.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import { governGoal, type GoalGovernorInput } from "./goal.ts";

function normalizeRuntimeChoice(choice: RuntimeChoice): RuntimeChoice {
  if (
    (choice.effortLevel === "adaptive" || choice.effortLevel === "default") &&
    !thinkingLevelsFor(choice.modelId).includes(choice.effortLevel)
  )
    throw new NonRetryableTurnError(`${choice.effortLevel} reasoning is not supported by ${choice.modelId}`);
  return {
    modelId: choice.modelId,
    ...(choice.effortLevel && thinkingLevelsFor(choice.modelId).includes(choice.effortLevel)
      ? { effortLevel: choice.effortLevel }
      : {}),
    ...(typeof choice.fastMode === "boolean"
      ? { fastMode: choice.fastMode && fastModeModelIds().includes(choice.modelId) }
      : {}),
  };
}

function storedChoice(stored: RuntimeChoice): RuntimeChoice {
  return {
    modelId: stored.modelId,
    ...(stored.effortLevel ? { effortLevel: stored.effortLevel } : {}),
    ...(typeof stored.fastMode === "boolean" ? { fastMode: stored.fastMode } : {}),
  };
}

export async function resolveRuntimeChoiceDurable(
  config: ScopedConfigStore,
  orgScopeId: ScopeId,
  scope: ScopeId,
  fallback: RuntimeChoice,
  requested?: Partial<RuntimeChoice>,
  hydrateModelCatalog?: () => Promise<unknown>,
  purpose?: RuntimePurpose,
): Promise<RuntimeChoice> {
  const [orgStored, scopedStored, purposeRuntime] = await Promise.all([
    config.getRuntimeSelectionDurable(orgScopeId),
    scope === orgScopeId ? null : config.getRuntimeSelectionDurable(scope),
    purpose ? config.getPurposeRuntimeDurable(purpose) : undefined,
  ]);
  if (hydrateModelCatalog) {
    const candidates = [requested?.modelId, purposeRuntime?.modelId, scopedStored?.modelId, orgStored?.modelId];
    if (candidates.some((modelId) => modelId && !resolveModel(modelId))) await hydrateModelCatalog();
  }
  if (purposeRuntime) {
    const explicit = Object.fromEntries(Object.entries(requested ?? {}).filter(([, value]) => value !== undefined));
    const choice: RuntimeChoice = { ...purposeRuntime, ...explicit };
    if (!modelSupported(choice.modelId)) throw new NonRetryableTurnError(`runtime ${choice.modelId} is not approved`);
    const unavailable = modelUnavailableReason(choice.modelId);
    if (unavailable) throw new NonRetryableTurnError(`${choice.modelId}: ${unavailable}`);
    if (choice.effortLevel !== undefined && !thinkingLevelsFor(choice.modelId).includes(choice.effortLevel))
      throw new NonRetryableTurnError(`${choice.effortLevel} reasoning is not supported by ${choice.modelId}`);
    if (choice.fastMode && !fastModeModelIds().includes(choice.modelId))
      throw new NonRetryableTurnError(`fast mode is not supported by ${choice.modelId}`);
    return choice;
  }
  if (purpose === "cron")
    requested = { effortLevel: NON_INTERACTIVE_THINKING_LEVEL, fastMode: NON_INTERACTIVE_FAST_MODE, ...requested };
  const configuredOrg: RuntimeChoice = orgStored ? storedChoice(orgStored) : { modelId: fallback.modelId };
  const configuredId = requested?.modelId ?? scopedStored?.modelId ?? configuredOrg.modelId;
  const unavailableReason = modelUnavailableReason(configuredId);
  if (unavailableReason) throw new NonRetryableTurnError(`${configuredId}: ${unavailableReason}`);
  const safeFallback = modelSupported(fallback.modelId) ? fallback : { modelId: defaultModel(fallback.modelId) };
  const org = modelSupported(configuredOrg.modelId) ? configuredOrg : safeFallback;
  const choice = { ...(scopedStored ? storedChoice(scopedStored) : org), ...requested };
  if (!modelSupported(choice.modelId)) {
    if (requested?.modelId) throw new NonRetryableTurnError(`runtime ${choice.modelId} is not approved`);
    return normalizeRuntimeChoice({ ...org, ...requested });
  }
  return normalizeRuntimeChoice(choice);
}

export function withResolvedRuntime(
  pi: Harness,
  resolve: (input: HarnessTurnInput, routedBy: (ruleId: string) => void) => RuntimeChoice | Promise<RuntimeChoice>,
): Harness {
  return {
    ...pi,
    models: { ...pi.models },
    turns: {
      ...pi.turns,
      async runTurn(input) {
        let routedBy: string | undefined;
        const choice = await resolve(input, (ruleId) => {
          routedBy = ruleId;
        });
        const label = safeModelMetadata(choice.modelId)?.label;
        input.onRuntime?.({
          modelId: choice.modelId,
          ...(label ? { label } : {}),
          ...(routedBy ? { change: { rule: routedBy } } : {}),
        });
        const judge = pi.models?.judge;
        return pi.turns.runTurn({
          ...input,
          runtime: choice,
          tools: input.runtimeControl
            ? { ...input.tools, runtime: (request, signal) => input.runtimeControl!(choice, request, signal) }
            : input.tools,
          ...(judge
            ? {
                governGoal: (goalInput: GoalGovernorInput) =>
                  governGoal(judge, goalInput, input.cancel, pi.models?.judgeTokenBudget?.()),
              }
            : {}),
        });
      },
    },
  };
}
