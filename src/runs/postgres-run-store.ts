import { EventEmitter } from "node:events";
import { createPgPool } from "../persistence/pg-pool.ts";
import { jsonbStringify } from "../persistence/durable-map.ts";
import { pgTextSafe } from "../util/text.ts";
import type { TurnResult } from "../types.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";
import type { Run, RunDeliveryState, RunPriority, RunStop, RunStore } from "./run-store.ts";
import { isTerminal } from "./run-store.ts";
import { errMessage } from "../util/errors.ts";
import type { LedgerBegin, ToolLedger } from "./tool-ledger.ts";

type StoredRuns = Omit<RunStore, "enqueue" | "cancelTurn" | "cancelTree" | "withdraw" | "leaseHeld">;

export interface PostgresRuntime {
  runs: StoredRuns;
  ledger: ToolLedger;
  close(): Promise<void>;
}

export function rowToRun(r: Record<string, unknown>): Run {
  const request = JSON.parse(r.request as string) as OrchestratorInput;
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    status: r.status as Run["status"],
    request: { ...request, origin: resolveTurnOrigin(request) },
    result: r.result != null ? (JSON.parse(r.result as string) as TurnResult) : null,
    deliveryState: r.delivery_state != null ? (JSON.parse(r.delivery_state as string) as RunDeliveryState) : null,
    turnUserSeq: r.turn_user_seq != null ? Number(r.turn_user_seq) : null,
    dedupKey: (r.idempotency_key as string | null) ?? null,
    attempts: Number(r.attempts),
    errorAttempts: Number(r.error_attempts),
    maxAttempts: Number(r.max_attempts),
    priority: Number(r.claim_priority) as RunPriority,
    preemptions: Number(r.preemptions),
    leaseToken: (r.lease_token as string | null) ?? null,
    leaseExpiresAt: r.lease_expires_at === null ? null : Number(r.lease_expires_at),
    workerId: (r.worker_id as string | null) ?? null,
    createdAt: Number(r.created_at),
    startedAt: r.started_at === null ? null : Number(r.started_at),
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    lastStop: r.last_stop != null ? (JSON.parse(r.last_stop as string) as RunStop) : null,
    absurdQueue: (r.absurd_queue as string | null) ?? null,
    absurdTaskId: r.absurd_task_id == null ? null : String(r.absurd_task_id),
    absurdRunId: r.absurd_run_id == null ? null : String(r.absurd_run_id),
  };
}

export function createPostgresRunStore(connectionString: string): PostgresRuntime {
  const events = new EventEmitter();
  events.setMaxListeners(0);

  const { query: q, close: closePool } = createPgPool(
    connectionString,
    [
      {
        id: "runs/store/0001",
        expectedChecksum: "07a121d0fa4e8ae4049e0574939dbf938c8615dc39ce29b74805a7e8ccb4ad0f",
        statements: [
          `CREATE TABLE IF NOT EXISTS runs(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
        request TEXT NOT NULL, result TEXT, idempotency_key TEXT UNIQUE,
        attempts INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL DEFAULT 3,
        lease_token TEXT, lease_expires_at BIGINT, worker_id TEXT,
        created_at BIGINT NOT NULL, started_at BIGINT, finished_at BIGINT
      )`,
          `ALTER TABLE runs ADD COLUMN IF NOT EXISTS delivery_state TEXT`,
          `ALTER TABLE runs ADD COLUMN IF NOT EXISTS error_attempts INT NOT NULL DEFAULT 0`,
          `CREATE INDEX IF NOT EXISTS idx_runs_status_created ON runs(status, created_at)`,
          `CREATE INDEX IF NOT EXISTS idx_runs_session_active_created
        ON runs(session_id, created_at DESC) WHERE status IN ('pending','running')`,
          `DROP INDEX IF EXISTS idx_runs_status_priority_created`,
          `UPDATE runs SET status='pending', lease_token=NULL, lease_expires_at=NULL, worker_id=NULL
      WHERE status='running' AND id IN (
        SELECT id FROM (
          SELECT id, row_number() OVER (PARTITION BY session_id ORDER BY started_at ASC NULLS LAST, id) AS rn
          FROM runs WHERE status='running'
        ) dup WHERE dup.rn > 1
      )`,
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_running_per_session ON runs(session_id) WHERE status='running'`,
          `CREATE TABLE IF NOT EXISTS tool_calls(
        run_id TEXT NOT NULL, attempt INT NOT NULL DEFAULT 1, call_index INT NOT NULL,
        output TEXT NOT NULL, created_at BIGINT NOT NULL,
        PRIMARY KEY(run_id, attempt, call_index)
      )`,
          `ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS attempt INT NOT NULL DEFAULT 1`,
          `ALTER TABLE tool_calls DROP CONSTRAINT IF EXISTS tool_calls_pkey`,
          `ALTER TABLE tool_calls ADD PRIMARY KEY (run_id, attempt, call_index)`,
        ],
      },
      {
        id: "runs/store/0002",
        expectedChecksum: "c0fc23238fbe0ace56a28278bcb6cadfb100eb2c24ee83ce873588d466930270",
        statements: [
          `ALTER TABLE runs ADD COLUMN IF NOT EXISTS seq BIGSERIAL`,
          `CREATE INDEX IF NOT EXISTS idx_runs_status_created_seq ON runs(status, created_at, seq)`,
        ],
      },
      {
        id: "runs/store/0003",
        expectedChecksum: "8594c46c02ee90d43292a4c083fedea6c72d93b5f414f75e9e20d2db51b1b595",
        statements: [`SET LOCAL lock_timeout = '3s'`, `ALTER TABLE runs ADD COLUMN IF NOT EXISTS turn_user_seq BIGINT`],
      },
      {
        id: "runs/store/0004",
        statements: [
          `SET LOCAL lock_timeout = '3s'`,
          `ALTER TABLE runs ADD COLUMN IF NOT EXISTS retry_after BIGINT NOT NULL DEFAULT 0`,
        ],
      },
      {
        id: "runs/store/0004-subagent-returns",
        statements: [
          `ALTER TABLE runs ADD COLUMN IF NOT EXISTS returned_at BIGINT`,
          `CREATE INDEX IF NOT EXISTS idx_runs_pending_child_returns ON runs(id) WHERE status IN ('done','failed') AND returned_at IS NULL AND session_id LIKE 'agent:main:subagent:%'`,
        ],
      },
      {
        id: "runs/store/0005-session-history",
        statements: [
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_session_created_seq ON runs(session_id, created_at DESC, seq DESC)`,
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_created ON runs(created_at DESC)`,
        ],
      },
      {
        id: "runs/store/0006-terminal-finished",
        statements: [
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_terminal_finished ON runs(finished_at, id) WHERE status IN ('done','failed')`,
        ],
      },
      {
        id: "runs/store/0007-last-stop",
        statements: [`SET LOCAL lock_timeout = '3s'`, `ALTER TABLE runs ADD COLUMN IF NOT EXISTS last_stop TEXT`],
      },
      {
        id: "runs/store/0008-claim-priority",
        statements: [
          `SET LOCAL lock_timeout = '3s'`,
          `ALTER TABLE runs ADD COLUMN IF NOT EXISTS claim_priority SMALLINT NOT NULL DEFAULT 2`,
          `ALTER TABLE runs ADD COLUMN IF NOT EXISTS preemptions INT NOT NULL DEFAULT 0`,
        ],
      },
      {
        id: "runs/store/0009-claim-priority-index",
        statements: [
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_pending_priority ON runs(claim_priority, created_at, seq) WHERE status='pending'`,
        ],
      },
      {
        id: "runs/store/0010-drop-turn-metrics",
        statements: [`SET LOCAL lock_timeout = '60s'`, `DROP TABLE IF EXISTS turn_metrics`],
      },
      {
        id: "runs/store/0011-turn-engine",
        statements: [
          `SET LOCAL lock_timeout = '3s'`,
          `ALTER TABLE runs ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'legacy'`,
          `ALTER TABLE runs ADD COLUMN IF NOT EXISTS absurd_queue TEXT`,
          `ALTER TABLE runs ADD COLUMN IF NOT EXISTS absurd_task_id UUID`,
          `ALTER TABLE runs ADD COLUMN IF NOT EXISTS absurd_run_id UUID`,
        ],
      },
      {
        id: "runs/store/0012-turn-engine-indexes",
        statements: [
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_session_in_flight ON runs(session_id, created_at, seq) WHERE status IN ('queued','pending','running')`,
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_session_queued ON runs(session_id, claim_priority, created_at, seq) WHERE status = 'queued'`,
        ],
      },
      {
        id: "runs/store/0013-turns-table",
        statements: [
          `SET LOCAL lock_timeout = '3s'`,
          `DO $$ BEGIN IF to_regclass('turns') IS NULL THEN ALTER TABLE runs RENAME TO turns; END IF; END $$`,
          `CREATE OR REPLACE VIEW runs AS SELECT * FROM turns`,
        ],
      },
    ],
    [
      {
        id: "runs/maintenance/tool-calls-key",
        beforeMigrations: true,
        statements: [
          `DO $$
      BEGIN
        IF to_regclass('tool_calls') IS NOT NULL THEN
          IF NOT EXISTS (SELECT 1 FROM pg_attribute
                         WHERE attrelid = 'tool_calls'::regclass AND attname = 'attempt' AND NOT attisdropped) THEN
            ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS attempt INT NOT NULL DEFAULT 1;
          END IF;
          IF EXISTS (
            SELECT 1 FROM pg_constraint c
            WHERE c.conrelid = 'tool_calls'::regclass AND c.contype = 'p'
              AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                   FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                  ) <> ARRAY['run_id','attempt','call_index']
          ) OR NOT EXISTS (
            SELECT 1 FROM pg_constraint c
            WHERE c.conrelid = 'tool_calls'::regclass AND c.contype = 'p'
          ) THEN
            DELETE FROM tool_calls t USING (
              SELECT ctid, row_number() OVER (
                PARTITION BY run_id, attempt, call_index ORDER BY created_at DESC, ctid DESC
              ) AS rn FROM tool_calls
            ) dup WHERE t.ctid = dup.ctid AND dup.rn > 1;
            ALTER TABLE tool_calls DROP CONSTRAINT IF EXISTS tool_calls_pkey;
            ALTER TABLE tool_calls ADD PRIMARY KEY (run_id, attempt, call_index);
          END IF;
        END IF;
      END $$`,
        ],
      },
    ],
  );

  async function getRun(id: string): Promise<Run | null> {
    const { rows } = await q("SELECT * FROM turns WHERE id = $1", [id]);
    return rows[0] ? rowToRun(rows[0]) : null;
  }
  const runs: StoredRuns = {
    async getByDedupKey(dedupKey) {
      const { rows } = await q(`SELECT * FROM turns WHERE idempotency_key = $1`, [dedupKey]);
      return rows[0] ? rowToRun(rows[0]) : null;
    },

    async noteTurnUserSeq(runId: string, seq: number): Promise<boolean> {
      const { rowCount } = await q("UPDATE turns SET turn_user_seq=$2 WHERE id=$1 AND turn_user_seq IS NULL", [
        runId,
        seq,
      ]);
      return rowCount > 0;
    },

    async setDeliveryState(runId: string, leaseToken: string | null, state: RunDeliveryState): Promise<boolean> {
      const { rowCount } =
        leaseToken === null
          ? await q(
              "UPDATE turns SET delivery_state=(COALESCE(delivery_state, '{}')::jsonb || $1::jsonb)::text WHERE id=$2",
              [JSON.stringify(state), runId],
            )
          : await q(
              "UPDATE turns SET delivery_state=(COALESCE(delivery_state, '{}')::jsonb || $1::jsonb)::text WHERE id=$2 AND lease_token=$3",
              [JSON.stringify(state), runId, leaseToken],
            );
      return rowCount > 0;
    },

    async latestForThreads(threadRefs, opts) {
      if (!threadRefs.length) return new Map();
      const { rows } = await q(
        `SELECT latest.* FROM unnest($1::text[]) AS threads(id)
         CROSS JOIN LATERAL (
           SELECT * FROM turns WHERE session_id = threads.id
           AND (NOT $2::boolean OR COALESCE(request::jsonb->>'privateSessionMessage', 'false') <> 'true')
           ORDER BY created_at DESC, seq DESC LIMIT 1
         ) latest`,
        [[...new Set(threadRefs)], Boolean(opts?.excludePrivateMessages)],
      );
      return new Map(
        rows.map((row) => {
          const run = rowToRun(row);
          return [run.sessionId, run];
        }),
      );
    },
    async latestForThread(threadRef, opts) {
      const { rows } = await q(
        "SELECT * FROM turns WHERE session_id = $1 AND (NOT $2::boolean OR COALESCE(request::jsonb->>'privateSessionMessage', 'false') <> 'true') ORDER BY created_at DESC, seq DESC LIMIT 1",
        [threadRef, Boolean(opts?.excludePrivateMessages)],
      );
      return rows[0] ? rowToRun(rows[0]) : null;
    },
    async pendingReturns(limit = 100, afterId = "") {
      const { rows } = await q(
        `SELECT * FROM (
           SELECT * FROM turns WHERE status IN ('done','failed') AND returned_at IS NULL
           AND session_id LIKE 'agent:main:subagent:%' AND id > $2
           UNION
           SELECT child.* FROM turns wake JOIN turns child
           ON child.id = substring(wake.idempotency_key FROM length('subagent-return:') + 1)
           WHERE wake.status IN ('pending','queued') AND wake.attempts = 0 AND wake.turn_user_seq IS NULL
           AND wake.idempotency_key LIKE 'subagent-return:%'
           AND child.status IN ('done','failed') AND child.session_id LIKE 'agent:main:subagent:%'
           AND child.id > $2
         ) pending WHERE retry_after <= $3 ORDER BY id LIMIT $1`,
        [limit, afterId, Date.now()],
      );
      return rows.map(rowToRun);
    },
    async terminalFinished(after, beforeMs, limit) {
      const { rows } = await q(
        `SELECT * FROM turns WHERE status IN ('done','failed') AND finished_at <= $1
           AND (finished_at > $2 OR (finished_at = $2 AND id > $3))
         ORDER BY finished_at, id LIMIT $4`,
        [beforeMs, after.finishedAt, after.id, limit],
      );
      return rows.map(rowToRun);
    },
    async markReturned(runId) {
      await q("UPDATE turns SET returned_at = $2 WHERE id = $1 AND status IN ('done','failed')", [runId, Date.now()]);
    },
    async deferReturn(runId, delayMs) {
      await q("UPDATE turns SET retry_after = $2 WHERE id = $1 AND status IN ('done','failed')", [
        runId,
        Date.now() + Math.max(0, delayMs),
      ]);
    },
    wakeWaiters(run): void {
      if (isTerminal(run.status)) events.emit(run.id, run);
    },
    untilEnded(runId, timeoutMs): Promise<void> {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(done, timeoutMs);
        timer.unref?.();
        function done(): void {
          clearTimeout(timer);
          events.off(runId, done);
          resolve();
        }
        events.once(runId, done);
      });
    },

    get: getRun,

    async activeForThread(sessionId: string): Promise<Run | null> {
      const { rows } = await q(
        "SELECT * FROM turns WHERE session_id = $1 AND status IN ('queued','pending','running') ORDER BY (status = 'running') DESC, (status = 'queued') ASC, created_at ASC, seq ASC LIMIT 1",
        [sessionId],
      );
      return rows[0] ? rowToRun(rows[0]) : null;
    },

    async inFlightForThread(sessionId: string): Promise<Run[]> {
      const { rows } = await q(
        "SELECT * FROM turns WHERE session_id = $1 AND status IN ('queued','pending','running') ORDER BY (status = 'running') DESC, (status = 'queued') ASC, created_at ASC, seq ASC",
        [sessionId],
      );
      return rows.map(rowToRun);
    },

    async editPendingText(runId: string, text: string, expectedText: string): Promise<boolean> {
      const { rowCount } = await q(
        `UPDATE turns SET request = (request::jsonb || jsonb_build_object('text', $2::text, 'displayText', $2::text))::text
         WHERE id = $1 AND status = 'queued' AND attempts = 0 AND turn_user_seq IS NULL
         AND COALESCE(request::jsonb ->> 'displayText', request::jsonb ->> 'text') = $3`,
        [runId, pgTextSafe(text), pgTextSafe(expectedText)],
      );
      return (rowCount ?? 0) > 0;
    },

    async steerQueued(queuedRunId, targetRunId, signal, signals) {
      await signals.hasDedupeKey(signal.dedupeKey!);
      const { rows } = await q(
        `WITH target AS (
           SELECT id FROM turns WHERE id=$2 AND status IN ('queued','pending','running') FOR UPDATE
         ), moved AS (
           DELETE FROM turns WHERE id=$1 AND id<>$2 AND status = 'queued'
           AND COALESCE(request::jsonb->>'displayText',request::jsonb->>'text') = $5::jsonb->'request'->>'text'
           AND EXISTS (SELECT 1 FROM target) RETURNING id
         ), sent AS (
           INSERT INTO run_signals(run_id,kind,text,payload,created_at,dedupe_key)
           SELECT $2,$3,$4,$5,$6,$7 FROM moved RETURNING id
         ) SELECT pg_notify('run_signals',$2) FROM sent`,
        [
          queuedRunId,
          targetRunId,
          signal.kind,
          signal.text === undefined ? null : pgTextSafe(signal.text),
          jsonbStringify(signal),
          Date.now(),
          signal.dedupeKey ?? null,
        ],
      );
      return rows.length > 0;
    },

    async activeSessionIds(): Promise<string[]> {
      const { rows } = await q("SELECT DISTINCT session_id FROM turns WHERE status IN ('queued','pending','running')");
      return rows.map((r) => r.session_id as string);
    },

    async list({ limit = 200, threadRef }: { limit?: number; threadRef?: string } = {}): Promise<Run[]> {
      const { rows } = threadRef
        ? await q(
            "SELECT * FROM turns WHERE session_id = $1 OR starts_with(session_id, $1 || ':task:') OR starts_with(session_id, $1 || ':status:') ORDER BY created_at DESC LIMIT $2",
            [threadRef, limit],
          )
        : await q("SELECT * FROM turns ORDER BY created_at DESC LIMIT $1", [limit]);
      return rows.map(rowToRun);
    },

    waitFor(runId, timeoutMs = 60_000): Promise<Run> {
      return new Promise<Run>((resolve, reject) => {
        let done = false;
        const finish = (r: Run): void => {
          if (done) return;
          done = true;
          clearInterval(poll);
          clearTimeout(timer);
          events.off(runId, onSettle);
          resolve(r);
        };
        function onSettle(r: Run): void {
          finish(r);
        }
        events.once(runId, onSettle);
        const poll = setInterval(() => {
          void getRun(runId)
            .then((r) => {
              if (r && isTerminal(r.status)) finish(r);
            })
            .catch((err: unknown) => {
              console.error(
                "%s",
                `[postgres-run-store] waitFor poll for run ${runId} failed transiently:`,
                errMessage(err),
              );
            });
        }, 250);
        poll.unref?.();
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          clearInterval(poll);
          events.off(runId, onSettle);
          reject(new Error(`run ${runId} did not finish within ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      });
    },

    async close(): Promise<void> {
      await closePool();
    },
  };

  const ledger: ToolLedger = {
    async begin(runId, attempt, callIndex): Promise<LedgerBegin> {
      const { rows } = await q("SELECT output FROM tool_calls WHERE run_id=$1 AND attempt=$2 AND call_index=$3", [
        runId,
        attempt,
        callIndex,
      ]);
      return rows[0] ? { cached: true, output: rows[0].output as string } : { cached: false };
    },
    async record(runId, attempt, callIndex, output): Promise<void> {
      await q(
        "INSERT INTO tool_calls(run_id, attempt, call_index, output, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [runId, attempt, callIndex, output, Date.now()],
      );
    },
  };

  return { runs, ledger, close: () => runs.close!() };
}
