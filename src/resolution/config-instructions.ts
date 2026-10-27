import { isDeepStrictEqual } from "node:util";
import type { ScopeId } from "../types.ts";
import type { createKeyedQueue } from "../util/async.ts";
import { withCleanup } from "../util/errors.ts";
import type { TypedTable } from "../persistence/typed-table.ts";
import type { PersistedInstructions, PersistedInstructionsRevision, ScopedConfigStore } from "./config-store.ts";

type Snapshot = PersistedInstructions | null;
type Queue = ReturnType<typeof createKeyedQueue<string>>;

const DEFAULT_ORG_INSTRUCTIONS = {
  content:
    "You are a helpful internal assistant for this organization. Be concise, accurate, and respect data boundaries: never reveal information to people who are not party to the current conversation.",
  version: 1,
};

const byVersionDesc = (a: PersistedInstructionsRevision, b: PersistedInstructionsRevision) => b.version - a.version;

function mergeHistory(
  embedded: readonly PersistedInstructionsRevision[] | undefined,
  separate: readonly PersistedInstructionsRevision[],
): PersistedInstructionsRevision[] {
  const byVersion = new Map<number, PersistedInstructionsRevision>();
  for (const revision of separate) byVersion.set(revision.version, revision);
  for (const revision of embedded ?? []) byVersion.set(revision.version, revision);
  return [...byVersion.values()].sort(byVersionDesc);
}

function historyIncludingCurrent(
  current: PersistedInstructions,
  separate: readonly PersistedInstructionsRevision[],
): PersistedInstructionsRevision[] {
  const history = mergeHistory(current.history, current.history === undefined ? separate : []);
  if (!history.some((revision) => revision.version === current.version)) {
    history.push({
      scopeId: current.scopeId,
      content: current.content,
      version: current.version,
      updatedAt: current.updatedAt ?? 0,
      ...(current.updatedBy ? { updatedBy: current.updatedBy } : {}),
    });
    history.sort(byVersionDesc);
  }
  return history;
}

type InstructionsApi = Pick<
  ScopedConfigStore,
  | "getInstructions"
  | "getInstructionsDurable"
  | "setInstructions"
  | "setInstructionsIfVersion"
  | "instructionsVersion"
  | "instructionsHistory"
  | "captureInstructionsSnapshot"
  | "restoreInstructionsSnapshot"
  | "restoreInstructionsCacheSnapshot"
>;

export function createInstructions(
  org: ScopeId,
  rows: TypedTable<PersistedInstructions>,
  separateRows: TypedTable<PersistedInstructionsRevision>,
  queue: Queue,
) {
  const cache = new Map<ScopeId, { content: string; version: number }>([[org, DEFAULT_ORG_INSTRUCTIONS]]);
  const history = new Map<ScopeId, PersistedInstructionsRevision[]>();
  const separate = new Map<ScopeId, PersistedInstructionsRevision[]>();
  const load = (id: ScopeId, row: Snapshot): void => {
    if (row) cache.set(id, { content: row.content, version: row.version });
    else if (id === org) cache.set(org, DEFAULT_ORG_INSTRUCTIONS);
    else cache.delete(id);
    if (row?.history) history.set(id, row.history);
    else history.delete(id);
  };
  const revisionOf = (id: ScopeId, content: string, version: number, updatedBy?: string) => ({
    scopeId: id,
    content,
    version,
    updatedAt: Date.now(),
    ...(updatedBy ? { updatedBy } : {}),
  });
  const withRevision = (id: ScopeId, current: Snapshot, revision: PersistedInstructionsRevision) => ({
    ...revision,
    history: [revision, ...(current ? historyIncludingCurrent(current, separate.get(id) ?? []) : [])],
  });
  const saved = (id: ScopeId, row: PersistedInstructions): number => {
    separate.delete(id);
    load(id, row);
    return row.version;
  };
  const baseVersion = (id: ScopeId, current: Snapshot) => current?.version ?? cache.get(id)?.version ?? 0;
  const api: InstructionsApi = {
    getInstructions: (id) => cache.get(id)?.content ?? null,
    getInstructionsDurable: (id) =>
      queue(`instructions:${id}`, async () => {
        load(id, await rows.get(id));
        return cache.get(id)?.content ?? null;
      }),
    async setInstructions(id, content, updatedBy) {
      return queue(`instructions:${id}`, async () => {
        const row = await rows.modify(id, (current) =>
          withRevision(id, current, revisionOf(id, content, baseVersion(id, current) + 1, updatedBy)),
        );
        return saved(id, row!);
      });
    },
    async setInstructionsIfVersion(id, expectedVersion, content, updatedBy) {
      return queue(`instructions:${id}`, async () => {
        let accepted = false;
        const row = await rows.modify(id, (current) => {
          if (baseVersion(id, current) !== expectedVersion) return current;
          accepted = true;
          return withRevision(id, current, revisionOf(id, content, expectedVersion + 1, updatedBy));
        });
        return accepted && row ? saved(id, row) : null;
      });
    },
    instructionsVersion: (id) => cache.get(id)?.version ?? 0,
    instructionsHistory: (id) => history.get(id) ?? [],
    captureInstructionsSnapshot: (id) => queue(`instructions:${id}`, () => rows.get(id)),
    restoreInstructionsSnapshot: (id, snapshot) =>
      queue(`instructions:${id}`, async () => {
        let restored: Snapshot = null;
        await withCleanup(
          async () => {
            if (snapshot) await rows.put(id, snapshot);
            else await rows.delete(id);
          },
          async () => {
            restored = await rows.get(id);
            load(id, restored);
          },
        );
        return isDeepStrictEqual(restored, snapshot);
      }),
    restoreInstructionsCacheSnapshot: (id, snapshot) => load(id, snapshot ? structuredClone(snapshot) : null),
  };
  return {
    api,
    async hydrate() {
      for (const r of await rows.all()) load(r.scopeId, r);
      for (const r of await separateRows.all()) {
        for (const target of [separate, history]) {
          const revisions = target.get(r.scopeId) ?? [];
          if (!revisions.some((revision) => revision.version === r.version)) revisions.push(r);
          target.set(r.scopeId, revisions.sort(byVersionDesc));
        }
      }
    },
    async refresh(id: ScopeId) {
      const pending = separate.get(id) ?? [];
      const row = pending.length
        ? await rows.modify(id, (current) =>
            current && current.history === undefined
              ? { ...current, history: mergeHistory(undefined, pending) }
              : current,
          )
        : await rows.get(id);
      if (row) separate.delete(id);
      load(id, row);
    },
    refreshSecurity: (id: ScopeId) =>
      queue(`instructions:${id}`, async () => {
        const row = await rows.get(id);
        if (row) cache.set(id, { content: row.content, version: row.version });
        else if (id !== org) cache.delete(id);
      }),
  };
}
