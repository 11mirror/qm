import { surfaceHas } from "../../surfaces/surface.ts";
import type { TurnCtx } from "./turn-context.ts";
import type { Session } from "../../types.ts";
import { startLeaseKeepalive } from "./lease-keepalive.ts";
import { reconcileMessageRevisions, revisionAnchorAt } from "../message-revisions.ts";
import { swallowAs } from "../../util/errors.ts";
import type { Lease, LeaseAttempt } from "../../sessions/session-store.ts";
import { acquireLeaseWithin } from "../../sessions/session-store.ts";
import { SESSION_BUSY_FIRE_TEXT, SESSION_BUSY_USER_TEXT } from "../failure-copy.ts";
import { CONFIG_DEFAULTS } from "../../config.ts";
import { jsonbStringify } from "../../util/text.ts";
import type { ScopeId, TurnResult } from "../../types.ts";
import type { OrchestratorDeps } from "./types.ts";

const SESSION_GONE_REASON = "this conversation is no longer available — start a new one";

function recordSessionBusy(
  deps: Pick<OrchestratorDeps, "errors">,
  busy: {
    site: "turn";
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
    message: jsonbStringify({
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

async function acquireTurnLeaseOrRefuse(
  deps: Pick<OrchestratorDeps, "errors" | "sessions" | "turnLeaseWaitMs">,
  args: {
    sessionId: string;
    site: "turn";
    scopeId: ScopeId;
    automated: boolean;
    runId?: string;
    fenceToken?: string;
    surface?: string;
  },
): Promise<{ lease: Lease; waitedMs: number } | { lease: null; waitedMs: number; refusal: TurnResult }> {
  const budget = deps.turnLeaseWaitMs ?? CONFIG_DEFAULTS.turnLeaseWaitMs;
  const attempt = await acquireLeaseWithin(deps.sessions, args.sessionId, "turn", budget, {
    waitFor: (heldBy) => heldBy !== undefined && heldBy !== "turn",
  });
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
      message: jsonbStringify({ site: args.site, runId: args.runId ?? null, surface: args.surface ?? null }),
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

export async function holdTurnLease(
  ctx: TurnCtx,
  session: Session,
): Promise<
  | { refused: TurnResult }
  | {
      lease: Lease;
      turnAbort: AbortController;
      catchUpMessageRevisions: () => Promise<void>;
      stopLeaseKeepalive: () => void;
      leaseState: { released: boolean };
    }
> {
  const { deps, input, automatedTurn, scopeId, messageTs } = ctx;
  const leaseStart = Date.now();
  const acquired = await acquireTurnLeaseOrRefuse(deps, {
    sessionId: session.id,
    site: "turn",
    scopeId,
    automated: automatedTurn,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.turnFenceToken ? { fenceToken: input.turnFenceToken } : {}),
    ...(input.surface ? { surface: input.surface } : {}),
  });
  if (!acquired.lease) return { refused: acquired.refusal };
  const lease = acquired.lease;
  const trackRevisions = surfaceHas(input.surface, "revisions") && Boolean(deps.surfaceCache);
  const revisionAnchor = trackRevisions ? await revisionAnchorAt(deps.sessions, session.id) : undefined;
  const catchUpMessageRevisions = async (): Promise<void> => {
    if (!trackRevisions || !deps.surfaceCache) return;
    await reconcileMessageRevisions({
      sessions: deps.sessions,
      surfaceCache: deps.surfaceCache,
      lease,
      session,
      anchorAt: revisionAnchor,
      fallbackSince: leaseStart,
      ...(messageTs ? { triggerTs: messageTs } : {}),
    }).catch(swallowAs("orchestrator: message revision catch-up", undefined));
  };
  const leaseState = { released: false };
  const turnAbort = new AbortController();
  if (input.cancel?.aborted) turnAbort.abort();
  else input.cancel?.addEventListener("abort", () => turnAbort.abort(), { once: true });
  const stopLeaseKeepalive = startLeaseKeepalive(
    deps.sessions,
    lease,
    Math.floor(deps.sessions.leaseTtlMs / 3),
    () => leaseState.released,
    () => turnAbort.abort(),
  );
  return { lease, turnAbort, catchUpMessageRevisions, stopLeaseKeepalive, leaseState };
}
