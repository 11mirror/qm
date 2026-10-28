import type { RuntimePurpose } from "../resolution/config-store.ts";
import type { TurnOrigin } from "../types.ts";

export const NON_INTERACTIVE_THINKING_LEVEL = "xhigh";
export const NON_INTERACTIVE_FAST_MODE = false;

export function turnRuntimePurpose(
  input: { surface?: string; origin: Pick<TurnOrigin, "kind"> },
  subagent = false,
): RuntimePurpose | undefined {
  if (subagent) return "subagent";
  if (input.origin.kind === "automation" && input.surface === "cron") return "cron";
  return undefined;
}

export function resolveTurnFastMode(
  requested: boolean | undefined,
  humanTurn: boolean,
  interactiveDefault: boolean,
): boolean | undefined {
  if (typeof requested === "boolean") return requested;
  return humanTurn && interactiveDefault ? true : undefined;
}

export function turnModelOptions(input: { surface?: string; thinkingLevel?: string; fastMode?: boolean }): {
  thinkingLevel?: string;
  fastMode?: boolean;
} {
  const triggerDefaults = input.surface !== "cron";
  let thinkingLevel = input.thinkingLevel;
  if (!thinkingLevel && triggerDefaults) thinkingLevel = NON_INTERACTIVE_THINKING_LEVEL;
  let fastMode = input.fastMode;
  if (typeof fastMode !== "boolean" && triggerDefaults) fastMode = NON_INTERACTIVE_FAST_MODE;
  return {
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
  };
}
