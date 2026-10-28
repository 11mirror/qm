import type { AuditLog } from "../audit/audit-log.ts";
import {
  classifierKey,
  runHook,
  type DecisionBackend,
  type DecisionHook,
  type DecisionResult,
  type DecisionRule,
} from "./decisions.ts";
import type { DecisionStore } from "./store.ts";
import { swallowAs } from "../util/errors.ts";

const HOOK_TIMEOUT_MS = 5_000;

export function turnStartState(turn: {
  input: string;
  surfaceName?: string;
  runtimePurpose?: string;
  runtime?: { harnessId?: string; modelId?: string };
  runtimePinned?: boolean;
  continueTurn?: boolean;
  scopeLabel: string;
}): string {
  const requested = turn.runtime?.modelId
    ? [turn.runtime.harnessId, turn.runtime.modelId].filter(Boolean).join("/")
    : "none (org default applies)";
  return [
    "Turn context:",
    `- surface: ${turn.surfaceName ?? "unknown"}`,
    `- purpose: ${turn.runtimePurpose ?? "interactive"}`,
    `- scope: ${turn.scopeLabel.split(":")[0]}`,
    `- requested runtime: ${requested}`,
    `- model account: ${turn.runtimePinned ? "the user's own provider account, which serves only the requested runtime" : "company"}`,
    `- continued turn: ${turn.continueTurn ? "yes, resuming an interrupted turn" : "no"}`,
    "",
    "Latest message:",
    turn.input,
  ].join("\n");
}

export function turnEndState(turn: {
  surfaceName?: string;
  scopeLabel: string;
  guidance?: string;
  input: string;
  reply: string;
  attempt: number;
  attempts: number;
}): string {
  const guidance = turn.guidance?.trim();
  return [
    "Turn context:",
    `- surface: ${turn.surfaceName ?? "unknown"}`,
    `- scope: ${turn.scopeLabel.split(":")[0]}`,
    `- revision attempt: ${turn.attempt} of ${turn.attempts}`,
    "",
    "Draft reply, written but not yet delivered:",
    turn.reply.trim(),
    "",
    "Latest message:",
    turn.input.trim(),
    "",
    guidance
      ? `Standing instructions this conversation's replies must follow:\n${guidance}`
      : "This conversation has no standing instructions of its own.",
  ].join("\n");
}

export interface DecisionTurn {
  actorId?: string;
  scopeLabel: string;
  sessionId: string;
  runId?: string;
  cancel?: AbortSignal;
}

export interface DecisionHooks {
  active(hook: DecisionHook): Promise<boolean>;
  run(hook: DecisionHook, state: string, turn: DecisionTurn): Promise<DecisionResult | undefined>;
}

export function createDecisionHooks(
  store: DecisionStore | undefined,
  backend: DecisionBackend,
  audit: AuditLog,
): DecisionHooks {
  const classify = async (rules: readonly DecisionRule[], hook: DecisionHook, state: string, turn: DecisionTurn) => {
    if (!rules.length) return undefined;
    const signal = AbortSignal.any([AbortSignal.timeout(HOOK_TIMEOUT_MS), ...(turn.cancel ? [turn.cancel] : [])]);
    const { decisive, results } = await runHook(rules, hook, state, backend, signal);
    for (const result of results)
      audit.record({
        at: Date.now(),
        principalId: turn.actorId ?? "system",
        action: "decision.classify",
        resource: result.ruleId,
        scopeLabel: turn.scopeLabel,
        status: result.error ? "error" : result.action,
        detail: JSON.stringify({
          hook,
          sessionId: turn.sessionId,
          ...(turn.runId ? { runId: turn.runId } : {}),
          ...result,
        }),
      });
    return decisive;
  };
  const rulesFor = async (hook: DecisionHook) => (await store?.rules(hook)) ?? [];
  return {
    active: async (hook) => (await rulesFor(hook)).length > 0,
    run: async (hook, state, turn) => {
      const rules = await rulesFor(hook);
      const enforced = new Set(rules.filter((rule) => rule.mode === "enforce").map(classifierKey));
      const awaited = (rule: DecisionRule) => enforced.has(classifierKey(rule));
      void classify(
        rules.filter((rule) => !awaited(rule)),
        hook,
        state,
        { ...turn, cancel: undefined },
      ).catch(swallowAs("decisions: observe-only rules", undefined));
      return classify(rules.filter(awaited), hook, state, turn);
    },
  };
}

export async function routeTurnRuntime<C extends { harnessId: string; modelId: string }>(
  decision: DecisionResult | undefined,
  route: (runtime: NonNullable<DecisionResult["runtime"]>) => Promise<C>,
  requested: () => Promise<C>,
): Promise<{ choice: C; routedBy?: string }> {
  if (!decision?.runtime) return { choice: await requested() };
  const [choice, otherwise] = await Promise.all([
    route(decision.runtime),
    requested().catch(swallowAs("decisions: requested runtime", undefined)),
  ]);
  const changed = !!otherwise && (otherwise.harnessId !== choice.harnessId || otherwise.modelId !== choice.modelId);
  return changed ? { choice, routedBy: decision.ruleId } : { choice };
}
