import type { Lease, LeaseAttempt } from "../../sessions/session-store.ts";
import { acquireLeaseWithin } from "../../sessions/session-store.ts";
import { SESSION_BUSY_FIRE_TEXT, SESSION_BUSY_USER_TEXT } from "../failure-copy.ts";
import { CONFIG_DEFAULTS } from "../../config.ts";
import { jsonbSafeStringify } from "../../util/text.ts";
import type { ScopeId, TurnResult } from "../../types.ts";
import type { OrchestratorDeps } from "./types.ts";

const AUTOMATED_TURN_LEASE_WAIT_MS = 1_000;

const SESSION_GONE_REASON = "this conversation is no longer available — start a new one";

function recordSessionBusy(
  deps: Pick<OrchestratorDeps, "errors">,
  busy: {
    site: "turn" | "quarantined_input" | "flagged_input";
    attempt: LeaseAttempt;
    waitedMs?: number;
    sessionId: string;
    scopeId: ScopeId;
    runId?: string;
    surface?: string;
  },
): void {
  const at = Date.now();
  deps.errors?.record({
    category: "sessions",
    code: "session_busy",
    message: jsonbSafeStringify({
      site: busy.site,
      heldBy: busy.attempt.heldBy ?? null,
      ...(busy.attempt.heldSince !== undefined ? { heldForMs: at - busy.attempt.heldSince } : {}),
      ...(busy.attempt.heldUntil !== undefined ? { expiresInMs: busy.attempt.heldUntil - at } : {}),
      ...(busy.waitedMs !== undefined ? { waitedMs: busy.waitedMs } : {}),
      runId: busy.runId ?? null,
      surface: busy.surface ?? null,
    }),
    scopeLabel: busy.scopeId,
    sessionId: busy.sessionId,
  });
}

export async function acquireTurnLeaseOrRefuse(
  deps: Pick<OrchestratorDeps, "errors" | "sessions" | "turnLeaseWaitMs">,
  args: {
    sessionId: string;
    site: "turn" | "flagged_input";
    scopeId: ScopeId;
    automated: boolean;
    runId?: string;
    fenceToken?: string;
    surface?: string;
  },
): Promise<{ lease: Lease; waitedMs: number } | { lease: null; waitedMs: number; refusal: TurnResult }> {
  const budget = deps.turnLeaseWaitMs ?? CONFIG_DEFAULTS.turnLeaseWaitMs;
  const attempt = await acquireLeaseWithin(
    deps.sessions,
    args.sessionId,
    "turn",
    args.automated ? Math.min(AUTOMATED_TURN_LEASE_WAIT_MS, budget) : budget,
    { waitFor: (heldBy) => heldBy !== undefined && heldBy !== "turn" },
  );
  const waitedMs = attempt.waitedMs ?? 0;
  if (attempt.lease)
    return {
      lease: args.runId
        ? { ...attempt.lease, turnId: args.runId, ...(args.fenceToken ? { fenceToken: args.fenceToken } : {}) }
        : attempt.lease,
      waitedMs,
    };
  if (attempt.heldUntil === undefined) {
    deps.errors?.record({
      category: "sessions",
      code: "session_missing",
      message: jsonbSafeStringify({ site: args.site, runId: args.runId ?? null, surface: args.surface ?? null }),
      scopeLabel: args.scopeId,
      sessionId: args.sessionId,
    });
    return {
      lease: null,
      waitedMs,
      refusal: { status: "refused", sessionId: args.sessionId, reason: SESSION_GONE_REASON },
    };
  }
  recordSessionBusy(deps, {
    site: args.site,
    attempt,
    waitedMs,
    sessionId: args.sessionId,
    scopeId: args.scopeId,
    ...(args.runId ? { runId: args.runId } : {}),
    ...(args.surface ? { surface: args.surface } : {}),
  });
  return {
    lease: null,
    waitedMs,
    refusal: {
      status: "refused",
      sessionId: args.sessionId,
      refusalKind: "session_busy",
      reason: args.automated ? SESSION_BUSY_FIRE_TEXT : SESSION_BUSY_USER_TEXT,
    },
  };
}
