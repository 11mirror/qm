import { type SessionStateBus, createMemorySessionStateBus } from "../runs/session-state-bus.ts";
import { createPostgresSessionStateBus } from "../runs/postgres-session-state-bus.ts";
import { type LedgerEventBus, createPostgresLedgerEventBus } from "../inbox/events.ts";
import { createPostgresRunStore } from "../runs/postgres-run-store.ts";
import { RUN_MAX_CLAIMS } from "../runs/worker.ts";
import { createMemoryRunStore } from "../runs/memory-run-store.ts";
import { createTurnLedger } from "../turns/turn-ledger.ts";
import { routeTurns } from "../turns/turn-engine.ts";
import { actorAssertionActive } from "../identity/identity-service.ts";
import type { Session } from "../types.ts";
import { stoppableAncestors, sessionTreeRunCount, sessionTreeRoot, SUBAGENT_TREE_RUN_CAP } from "../subagents/tree.ts";
import type { RunStore } from "../runs/run-store.ts";
import { createProductAnalytics } from "../util/product-analytics.ts";
import type { Config } from "../config.ts";
import type { HarnessModule } from "./harness.ts";
import type { StoresModule } from "./stores.ts";
import type { Late } from "./late.ts";

export function buildRuns(
  w: Pick<HarnessModule, "runStoreKind"> &
    Pick<StoresModule, "featureFlags" | "identity" | "sessions" | "advisoryLock"> & {
      config: Config;
      databaseUrl: string;
      late: Late;
    },
) {
  const { config, databaseUrl, runStoreKind, featureFlags, late, identity, sessions, advisoryLock } = w;

  const sessionStateBus: SessionStateBus = config.databaseUrl
    ? createPostgresSessionStateBus(config.databaseUrl)
    : createMemorySessionStateBus();
  const ledgerEventBus: LedgerEventBus = createPostgresLedgerEventBus(databaseUrl);
  const leaseTtlMs = config.leaseTtlMs;
  const maxAttempts = config.maxAttempts;
  const runStore =
    runStoreKind === "postgres"
      ? createPostgresRunStore(databaseUrl, { maxClaims: RUN_MAX_CLAIMS })
      : createMemoryRunStore({ maxClaims: RUN_MAX_CLAIMS });
  const turnLedger =
    runStoreKind === "postgres"
      ? createTurnLedger(databaseUrl, { onTerminal: (run) => runStore.runs.emitTerminal?.(run) })
      : undefined;
  const turnRouting = routeTurns(runStore.runs, turnLedger, featureFlags);
  const blockingApprovalSessions = async (sessionIds: readonly string[]): Promise<Set<string>> => {
    if (!sessionIds.length) return new Set();
    const wanted = new Set(sessionIds);
    return new Set(
      (await late.approvals.select({ where: { field: "sessionId", anyOfFold: sessionIds } }))
        .filter(
          (r) => wanted.has(r.sessionId) && r.blocksInput !== false && actorAssertionActive(identity, r.request?.actor),
        )
        .map((r) => r.sessionId),
    );
  };
  const workingAncestors = async (session: Session) => {
    const candidates = await stoppableAncestors(sessions, session);
    const awaiting = await blockingApprovalSessions(candidates.map((ancestor) => ancestor.id));
    const ancestors = candidates.filter((ancestor) => !awaiting.has(ancestor.id));
    return Promise.all(
      ancestors.map(async (ancestor) => ({
        session: ancestor,
        participants: await sessions.participantsOf(ancestor.id),
      })),
    );
  };
  const runs: RunStore = {
    ...runStore.runs,
    cancelTurn: turnRouting.cancelTurn,
    cancelTree: turnRouting.cancelTree,
    withdraw: turnRouting.withdraw,
    leaseHeld: turnRouting.leaseHeld,
    async enqueue(input) {
      const enqueue = async () => {
        const known = await sessions.getByThread(input.sessionId);
        if (
          known &&
          (known.parentSessionId || (await sessions.childrenOf(known.id)).length > 0) &&
          !(input.dedupKey && (await runStore.runs.getByDedupKey(input.dedupKey))) &&
          (await sessionTreeRunCount(sessions, runStore.runs, await sessionTreeRoot(sessions, known))) >=
            SUBAGENT_TREE_RUN_CAP
        )
          throw new Error(`all ${SUBAGENT_TREE_RUN_CAP} session run slots are in use`);
        const participants = known ? await sessions.participantsOf(known.id) : [];
        const ancestors = known?.parentSessionId ? await workingAncestors(known) : [];
        const result = (await turnRouting.admit(input)) ?? (await runStore.runs.enqueue(input));
        if (result.deduped) return result;
        sessionStateBus.emit({
          threadRef: input.sessionId,
          ...(known ? { sessionId: known.id } : {}),
          state: "working",
          at: result.run.createdAt,
          participants: participants.length ? participants : [input.request.actor.id],
        });
        for (const ancestor of ancestors)
          sessionStateBus.emit({
            threadRef: ancestor.session.threadRef,
            sessionId: ancestor.session.id,
            state: "working",
            at: result.run.createdAt,
            participants: ancestor.participants,
          });
        return result;
      };
      return advisoryLock.withLock("session-run-admission", enqueue);
    },
  };
  const productAnalytics = createProductAnalytics(config.orgId, config.productAnalytics);
  runs.onTerminal((run) => void productAnalytics.responseFinished(run));
  const ledger = runStore.ledger;
  return {
    runs,
    sessionStateBus,
    productAnalytics,
    ledgerEventBus,
    maxAttempts,
    ledger,
    leaseTtlMs,
    blockingApprovalSessions,
    turnLedger,
  };
}

export type RunsModule = ReturnType<typeof buildRuns>;
