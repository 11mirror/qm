import { AsyncResource } from "node:async_hooks";
import { createPgPool, type Rows, tenantCols } from "../persistence/pg-pool.ts";
import { jsonbStringify } from "../util/text.ts";
import { subscribePostgresChannel } from "../persistence/postgres-listener.ts";
import type { RunSignal, RunSignalStore } from "./run-signal-store.ts";

const CHANNEL = "run_signals";

function toSignals(rows: Rows): RunSignal[] {
  return rows.sort((a, b) => Number(a.id) - Number(b.id)).map((r) => r.payload as RunSignal);
}

export function createPostgresRunSignalStore(connectionString: string): RunSignalStore {
  const pg = createPgPool(connectionString, []);
  const q = pg.query;

  const listeners = new Map<string, Set<() => void>>();
  let stopListening: (() => Promise<void>) | null = null;
  let closed = false;
  let cleanup = Promise.resolve();

  function ring(runId: string): void {
    for (const cb of listeners.get(runId) ?? []) cb();
  }

  function dropListenClient() {
    const stop = stopListening;
    stopListening = null;
    if (stop) cleanup = Promise.all([cleanup, stop()]).then(() => {});
  }

  function ensureListening() {
    if (closed || stopListening || listeners.size === 0) return;
    stopListening = subscribePostgresChannel(connectionString, CHANNEL, ring, () => {
      for (const runId of listeners.keys()) ring(runId);
    });
  }

  return {
    async send(runId, signal) {
      const { rows } = await q(
        `WITH ins AS (
           INSERT INTO run_signals(run_id, kind, payload, created_at, dedupe_key) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (${tenantCols("dedupe_key")}) WHERE dedupe_key IS NOT NULL DO NOTHING
           RETURNING id
         )
         SELECT pg_notify('${CHANNEL}', $1) FROM ins`,
        [
          runId,
          signal.kind,
          jsonbStringify(signal),
          Date.now(),
          signal.dedupeKey ?? null,
        ],
      );
      return rows.length > 0;
    },

    async hasDedupeKey(dedupeKey) {
      const { rows } = await q(`SELECT 1 FROM run_signals WHERE dedupe_key = $1 LIMIT 1`, [dedupeKey]);
      return rows.length > 0;
    },

    async steerAuthors(runId) {
      const { rows } = await q(
        `SELECT payload FROM run_signals WHERE run_id=$1 AND kind='steer'`,
        [runId],
      );
      const ids = rows
        .map((r) => (r.payload as RunSignal).request?.actor?.externalId)
        .filter((id): id is string => typeof id === "string" && id !== "");
      return [...new Set(ids)];
    },

    async pending(runId) {
      const { rows } = await q(
        "SELECT id, payload FROM run_signals WHERE run_id=$1 AND consumed_at IS NULL ORDER BY id",
        [runId],
      );
      return rows.map((row) => ({ id: String(row.id), signal: toSignals([row])[0]! }));
    },
    async acknowledge(runId, id) {
      await q("UPDATE run_signals SET consumed_at=$3 WHERE run_id=$1 AND id=$2 AND consumed_at IS NULL", [
        runId,
        id,
        Date.now(),
      ]);
    },
    async takePending(runId) {
      const { rows } = await q(
        `UPDATE run_signals SET consumed_at=$2
         WHERE run_id=$1 AND consumed_at IS NULL
         RETURNING id, payload`,
        [runId, Date.now()],
      );
      return toSignals(rows);
    },

    async pendingRunIds() {
      const { rows } = await q(`SELECT DISTINCT run_id FROM run_signals WHERE consumed_at IS NULL`);
      return rows.map((r) => r.run_id as string);
    },

    async prune(olderThanMs) {
      await q(`DELETE FROM run_signals WHERE consumed_at IS NOT NULL AND consumed_at < $1`, [Date.now() - olderThanMs]);
    },

    onSignal(runId, listener) {
      const cb = AsyncResource.bind(listener);
      const set = listeners.get(runId) ?? new Set();
      set.add(cb);
      listeners.set(runId, set);
      ensureListening();
      return () => {
        set.delete(cb);
        if (set.size === 0) listeners.delete(runId);
        if (listeners.size === 0) dropListenClient();
      };
    },

    async close() {
      closed = true;
      dropListenClient();
      await cleanup;
      await pg.close();
    },
  };
}
