import type { Head } from "./late.ts";
import type { SessionStateBus } from "../runs/session-state-bus.ts";
import { createPostgresSessionStateBus } from "../runs/postgres-session-state-bus.ts";
import { type LedgerEventBus, createPostgresLedgerEventBus } from "../inbox/events.ts";
import { createPostgresRunStore } from "../runs/postgres-run-store.ts";
import { createTurnLedger } from "../turns/turn-ledger.ts";
import { bindTurnLedger } from "../turns/turn-engine.ts";
import { actorAssertionActive } from "../identity/identity-service.ts";
import type { Session } from "../types.ts";
import { stoppableAncestors, sessionTreeRunCount, sessionTreeRoot, SUBAGENT_TREE_RUN_CAP } from "../subagents/tree.ts";
import type { RunStore } from "../runs/run-store.ts";
import { createProductAnalytics } from "../util/product-analytics.ts";
import type { HarnessModule } from "./harness.ts";
import type { StoresModule } from "./stores.ts";

export function buildRuns(w: Head & HarnessModule & StoresModule) {
  const { config, databaseUrl, late, identity, sessions, advisoryLock } = w;

  const sessionStateBus: SessionStateBus = createPostgresSessionStateBus(databaseUrl);
  const ledgerEventBus: LedgerEventBus = createPostgresLedgerEventBus(databaseUrl);
  const maxAttempts = config.maxAttempts;
  const runStore = createPostgresRunStore(databaseUrl);
  const turnLedger = createTurnLedger(databaseUrl, { onTerminal: (run) => runStore.runs.emitTerminal(run) });
  const turnBinding = bindTurnLedger(runStore.runs, turnLedger);
  const blockingApprovalSessions = async (sessionIds: readonly string[]): Promise<Set<string>> =>
    new Set(
      (await late.approvals.forSessions(sessionIds))
        .filter(([, r]) => r.blocksInput !== false && actorAssertionActive(identity, r.request?.actor))
        .map(([, r]) => r.sessionId),
    );
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
    ...turnBinding,
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
        const result = await turnBinding.enqueue(input);
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
    blockingApprovalSessions,
    turnLedger,
  };
}

export type RunsModule = ReturnType<typeof buildRuns>;
