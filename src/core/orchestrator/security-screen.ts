import { randomUUID } from "node:crypto";
import type { ScopeId } from "../../types.ts";
import type { TurnOrigin } from "../turn-origin.ts";
import {
  SECURITY_SCREEN_CHUNK_CHARS,
  type SecurityScreenClassification,
  type SecurityScreenHook,
} from "../../security/security-screener.ts";
import { securityScreenSystemPrompt } from "../../security/security-screen.ts";
import { errMessage, swallowAs } from "../../util/errors.ts";
import { CONFIG_DEFAULTS } from "../../config.ts";
import { headSlice } from "../../util/text.ts";
import type { OrchestratorDeps } from "./types.ts";

type ScreenStatus = "allow" | "would_block" | "error";
type Screened = Pick<SecurityScreenClassification, "verdict"> & Partial<SecurityScreenClassification>;

interface SecurityScreenContext {
  hook?: SecurityScreenHook;
  surface?: string;
  origin?: TurnOrigin["kind"];
  requestId?: string;
  request?: string;
  sessionId?: string;
  runId?: string;
  thread?: string;
}

export type SecurityObserver = (
  payload: string,
  actorId: string,
  scopeLabel: ScopeId,
  context: SecurityScreenContext,
) => Promise<void>;

function screenSources(payload: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const sources = parsed.flatMap((item: { source?: unknown } | null) =>
    typeof item?.source === "string" ? [item.source] : [],
  );
  return [...new Set(sources)];
}

export function createSecurityObserver(deps: OrchestratorDeps): SecurityObserver {
  const observe: SecurityObserver = async (payload, actorId, scopeLabel, context) => {
    const screener = deps.securityScreener;
    const model = deps.harness.models.screenSecurity;
    if (!screener && !model) return;
    const timeoutMs = deps.securityScreenTimeoutMs ?? CONFIG_DEFAULTS.securityScreenTimeoutMs;
    const hook = context.hook ?? "user_input";
    let request: { origin: string; text: string; truncated: boolean } | undefined;
    if (hook === "tool_response" && context.request?.trim()) {
      request = {
        origin: context.origin ?? "unknown",
        text: headSlice(context.request, SECURITY_SCREEN_CHUNK_CHARS).toWellFormed(),
        truncated: context.request.length > SECURITY_SCREEN_CHUNK_CHARS,
      };
    }

    const audit = (status: ScreenStatus, requestId: string, result?: Screened, error?: string): void => {
      deps.auditLog.record({
        at: Date.now(),
        principalId: actorId,
        action: "security_screen.classify",
        resource: screener?.provider ?? "model",
        scopeLabel,
        status,
        detail: JSON.stringify({
          hook,
          mode: "observe",
          sources: screenSources(payload),
          ...(context.surface ? { surface: context.surface } : {}),
          ...(context.origin ? { origin: context.origin } : {}),
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          ...(context.runId ? { runId: context.runId } : {}),
          ...(context.thread ? { thread: context.thread } : {}),
          requestId,
          attempts: 1,
          ...(error ? { error } : {}),
          ...(result?.score !== undefined ? { score: result.score, threshold: result.threshold } : {}),
          ...(result?.outcome ? { outcome: result.outcome } : {}),
        }),
      });
    };

    const screenOnce = async (requestId: string, signal: AbortSignal): Promise<Screened | undefined> => {
      if (screener) {
        return screener.classify({
          payload,
          hook,
          metadata: {
            ...(context.surface ? { surface: context.surface } : {}),
            ...(context.origin ? { origin: context.origin } : {}),
            ...(request ? { request } : {}),
          },
          requestId,
          signal,
        });
      }
      const flagger = deps.config?.setting("autoFlagger");
      const verdict = await model!({
        payload: request ? JSON.stringify({ request, payload }) : payload,
        ...(flagger
          ? {
              modelId: flagger.modelId,
              systemPrompt: securityScreenSystemPrompt(flagger.rubric),
            }
          : {}),
        signal,
      });
      return verdict ? { verdict } : undefined;
    };

    const attempt = async (): Promise<{ requestId: string; result: Screened | undefined; error?: string }> => {
      const requestId = context.requestId ?? randomUUID();
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      timer.unref();
      const timedOut = new Promise<undefined>((resolve) =>
        abort.signal.addEventListener("abort", () => resolve(undefined), { once: true }),
      );
      try {
        const result = await Promise.race([screenOnce(requestId, abort.signal), timedOut]);
        return { requestId, result, ...(result ? {} : { error: abort.signal.aborted ? "timeout" : "no verdict" }) };
      } catch (error) {
        return { requestId, result: undefined, error: errMessage(error) };
      } finally {
        clearTimeout(timer);
        abort.abort();
      }
    };
    const { requestId, result, error } = await attempt();
    let status: ScreenStatus = "error";
    if (result && !result.verdict.unscreened) status = result.verdict.decision === "strict" ? "would_block" : "allow";
    audit(status, requestId, result, error);
  };
  return (payload, actorId, scopeLabel, context) =>
    observe(payload, actorId, scopeLabel, context).catch(
      swallowAs("orchestrator: observed security screen", undefined),
    );
}
