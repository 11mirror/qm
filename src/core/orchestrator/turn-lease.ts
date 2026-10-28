import { surfaceHas } from "../../surfaces/surface.ts";
import type { TurnCtx } from "./turn-context.ts";
import type { Session } from "../../types.ts";
import { reconcileMessageRevisions, revisionAnchorAt } from "../../slack/message-revisions.ts";
import { swallowAs } from "../../util/errors.ts";
import type { Lease, SessionStore } from "../../sessions/session-store.ts";
import { acquireLeaseWithin } from "../../sessions/session-store.ts";
import { SESSION_BUSY_FIRE_TEXT, SESSION_BUSY_USER_TEXT } from "../failure-copy.ts";
import { CONFIG_DEFAULTS } from "../../config.ts";
import { jsonbSafeStringify } from "../../util/text.ts";
import type { TurnResult } from "../../types.ts";

const SESSION_GONE_REASON = "this conversation is no longer available — start a new one";

export function startLeaseKeepalive(
  sessions: Pick<SessionStore, "renewLease">,
  lease: Lease,
  intervalMs: number,
  releaseExpected: () => boolean,
  onLeaseLost: () => void,
): () => void {
  const timer = setInterval(() => {
    void sessions
      .renewLease(lease)
      .then((renewed) => {
        if (renewed) return;
        clearInterval(timer);
        if (releaseExpected()) return;
        console.error(`[orchestrator] lease keepalive stopped: lease lost mid-turn session=${lease.sessionId}`);
        onLeaseLost();
      })
      .catch(swallowAs("orchestrator: lease keepalive", undefined));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

async function acquireTurnLease(
  { deps, input, automatedTurn, scopeId }: TurnCtx,
  sessionId: string,
): Promise<{ lease: Lease } | { refused: TurnResult }> {
  const budget = deps.turnLeaseWaitMs ?? CONFIG_DEFAULTS.turnLeaseWaitMs;
  const attempt = await acquireLeaseWithin(deps.sessions, sessionId, "turn", budget, {
    waitFor: (heldBy) => heldBy !== undefined && heldBy !== "turn",
  });
  const { runId, runLeaseToken: fenceToken, surface } = input;
  if (attempt.lease)
    return {
      lease: runId ? { ...attempt.lease, turnId: runId, ...(fenceToken ? { fenceToken } : {}) } : attempt.lease,
    };
  const at = Date.now();
  const missing = attempt.heldUntil === undefined;
  deps.errors?.record({
    category: "sessions",
    code: missing ? "session_missing" : "session_busy",
    message: jsonbSafeStringify({
      site: "turn",
      ...(missing
        ? {}
        : {
            heldBy: attempt.heldBy ?? null,
            ...(attempt.heldSince !== undefined ? { heldForMs: at - attempt.heldSince } : {}),
            ...(attempt.heldUntil !== undefined ? { expiresInMs: attempt.heldUntil - at } : {}),
            waitedMs: attempt.waitedMs ?? 0,
          }),
      runId: runId ?? null,
      surface: surface ?? null,
    }),
    scopeLabel: scopeId,
    sessionId,
  });
  if (missing) return { refused: { status: "refused", sessionId, reason: SESSION_GONE_REASON } };
  return {
    refused: {
      status: "refused",
      sessionId,
      refusalKind: "session_busy",
      reason: automatedTurn ? SESSION_BUSY_FIRE_TEXT : SESSION_BUSY_USER_TEXT,
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
  const { deps, input, messageTs } = ctx;
  const leaseStart = Date.now();
  const acquired = await acquireTurnLease(ctx, session.id);
  if ("refused" in acquired) return acquired;
  const { lease } = acquired;
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
