import { randomUUID } from "node:crypto";
import { createPostgresRunStore } from "../../src/runs/postgres-run-store.ts";
import { createRunResultPosts, type RunResultPosts } from "../../src/runs/run-results.ts";
import type { Run, RunStore } from "../../src/runs/run-store.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import type { SessionStore } from "../../src/sessions/session-store.ts";
import type { TurnResult } from "../../src/types.ts";
import { registerAbsurdSchema, TURN_QUEUES } from "../../src/turns/absurd-schema.ts";
import { bindTurnLedger, endTurn, type TurnEndSteps } from "../../src/turns/turn.ts";
import { createTurnLedger, type TurnLedger } from "../../src/turns/turn-ledger.ts";
import { freshTestDatabase } from "./test-database.ts";

export interface ClaimedTurn {
  run: Run;
  token: string;
  ledger: TurnLedger;
}

export async function claimTurn(ledger: TurnLedger, runId?: string): Promise<ClaimedTurn | null> {
  const passed: ClaimedTurn[] = [];
  try {
    for (const queue of TURN_QUEUES) {
      for (;;) {
        const token = `test:${randomUUID()}`;
        const { claimed, run } = await ledger.claim(queue, token, "test");
        if (!claimed) break;
        if (!run) continue;
        if (!runId || run.id === runId) return { run, token, ledger };
        passed.push({ run, token, ledger });
      }
    }
    return null;
  } finally {
    for (const other of passed) await ledger.handBack(other.run, other.token, { unstarted: true });
  }
}

const turnEnds = new WeakMap<TurnLedger, TurnEndSteps>();

export function appTurns(app: { turnLedger: TurnLedger; turnEnd: TurnEndSteps }): TurnLedger {
  turnEnds.set(app.turnLedger, app.turnEnd);
  return app.turnLedger;
}

export async function finishTurn(
  claimed: ClaimedTurn,
  result: TurnResult,
  status: "done" | "failed" = "done",
): Promise<boolean> {
  const ended = await claimed.ledger.finish(claimed.run, claimed.token, { status, result });
  const end = turnEnds.get(claimed.ledger);
  if (ended && end) await endTurn(ended, end);
  return ended !== null;
}

export function testTurnEnd(runs: Pick<RunStore, "wakeWaiters">, observe: (run: Run) => void = () => {}): TurnEndSteps {
  return {
    refreshLiveView: () => {},
    wakeWaiters: (run) => {
      runs.wakeWaiters(run);
      observe(run);
    },
    deliverResult: () => {},
    settleConversationState: async () => {},
    replayLateSteers: async () => {},
    returnToParent: async () => {},
    recordAnalytics: () => {},
  };
}

export interface TestRunStore {
  runs: RunStore;
  ledger: TurnLedger;
  end: TurnEndSteps;
  onEnded(observe: (run: Run) => void): void;
  sessions: SessionStore;
  databaseUrl: string;
  close(): Promise<void>;
}

export function testRunStore(databaseUrl = freshTestDatabase()): TestRunStore {
  registerAbsurdSchema(databaseUrl);
  const sessions = createPostgresSessionStore(databaseUrl);
  const store = createPostgresRunStore(databaseUrl);
  const ledger = createTurnLedger(databaseUrl);
  const observers: Array<(run: Run) => void> = [];
  const end = testTurnEnd(store.runs, (run) => {
    for (const observe of observers) observe(run);
  });
  turnEnds.set(ledger, end);
  const runs: RunStore = { ...store.runs, ...bindTurnLedger(store.runs, ledger, end) };
  return {
    runs,
    ledger,
    end,
    onEnded: (observe) => void observers.push(observe),
    sessions,
    databaseUrl,
    async close() {
      await ledger.close();
      await store.close();
    },
  };
}

export function deliverResultsOnEnd(
  store: Pick<TestRunStore, "runs" | "onEnded">,
  ...rest: Parameters<typeof createRunResultPosts> extends [unknown, ...infer R] ? R : never
): RunResultPosts {
  const posts = createRunResultPosts(store.runs, ...rest);
  store.onEnded((run) => posts.deliver(run));
  return posts;
}
