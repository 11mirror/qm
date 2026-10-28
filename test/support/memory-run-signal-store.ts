import { randomUUID } from "node:crypto";
import type { RunSignal, RunSignalStore } from "../../src/runs/run-signal-store.ts";

export async function takePending(store: RunSignalStore, runId: string): Promise<RunSignal[]> {
  const rows = await store.pending(runId);
  for (const { id } of rows) await store.acknowledge(runId, id);
  return rows.map((row) => row.signal);
}

export function createMemoryRunSignalStore(): RunSignalStore {
  const pending = new Map<string, RunSignal[]>();
  const receipts = new WeakMap<RunSignal, string>();
  const authors = new Map<string, Array<{ at: number; author: string }>>();
  const listeners = new Map<string, Set<() => void>>();
  const dedupeKeys = new Set<string>();
  return {
    async send(runId, signal) {
      if (signal.dedupeKey) {
        if (dedupeKeys.has(signal.dedupeKey)) return false;
        dedupeKeys.add(signal.dedupeKey);
      }
      const list = pending.get(runId) ?? [];
      signal = { ...signal };
      receipts.set(signal, randomUUID());
      list.push(signal);
      pending.set(runId, list);
      const author = signal.kind === "steer" ? signal.request?.actor?.externalId : undefined;
      if (author) authors.set(runId, [...(authors.get(runId) ?? []), { at: Date.now(), author }]);
      for (const cb of listeners.get(runId) ?? []) cb();
      return true;
    },
    async hasDedupeKey(dedupeKey) {
      return dedupeKeys.has(dedupeKey);
    },
    async steerAuthors(runId) {
      return [...new Set((authors.get(runId) ?? []).map((a) => a.author))];
    },
    async pending(runId) {
      return (pending.get(runId) ?? []).map((signal) => ({ id: receipts.get(signal)!, signal }));
    },
    async acknowledge(runId, id) {
      const remaining = (pending.get(runId) ?? []).filter((signal) => receipts.get(signal) !== id);
      if (remaining.length) pending.set(runId, remaining);
      else pending.delete(runId);
    },
    async pendingRunIds() {
      return [...pending.keys()];
    },
    async prune(olderThanMs) {
      const cutoff = Date.now() - olderThanMs;
      for (const [runId, list] of authors) {
        const kept = list.filter((a) => a.at >= cutoff);
        if (kept.length) authors.set(runId, kept);
        else authors.delete(runId);
      }
    },
    onSignal(runId, cb) {
      const set = listeners.get(runId) ?? new Set();
      set.add(cb);
      listeners.set(runId, set);
      return () => {
        set.delete(cb);
        if (set.size === 0) listeners.delete(runId);
      };
    },
  };
}
