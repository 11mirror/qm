import { AsyncLocalStorage } from "node:async_hooks";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createMemoryAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { isDeepStrictEqual } from "node:util";
import { replayFinnyLedger, type FinnyDigest, type FinnyLedgerMetadata } from "./golden-loop.ts";

export interface FinnyRunBinding {
  runId: string;
  requestDigest: FinnyDigest;
  sessionId: string;
  scopeId: string;
  artifactRequest: "required" | "optional";
}

export interface FinnyRunPlanBinding {
  catalogDigest: FinnyDigest;
  capabilityId: string;
  revisionId: string;
  operationGraphDigest: FinnyDigest;
  planDigest: FinnyDigest;
}

export interface FinnyRunV2Binding {
  schema: "finny.run.v2";
  runId: string;
  requestDigest: FinnyDigest;
  sessionId: string;
  scopeId: string;
  plan: FinnyRunPlanBinding;
}

export interface FinnyRunCheckpoint extends FinnyRunBinding {
  ledger: readonly FinnyLedgerMetadata[];
  artifactReference?: string;
  updatedAt: string;
}

export interface FinnyRunV2Checkpoint extends FinnyRunV2Binding {
  ledger: readonly FinnyLedgerMetadata[];
  artifactReference?: string;
  updatedAt: string;
}

export type FinnyStoredRunCheckpoint = FinnyRunCheckpoint | FinnyRunV2Checkpoint;
type AnyFinnyRunBinding = FinnyRunBinding | FinnyRunV2Binding;
type BindingFor<Checkpoint extends FinnyStoredRunCheckpoint> = Checkpoint extends FinnyRunV2Checkpoint
  ? FinnyRunV2Binding
  : FinnyRunBinding;

export interface FinnyRunStoreFor<Checkpoint extends FinnyStoredRunCheckpoint> {
  withRunLock<T>(runId: string, work: () => Promise<T>): Promise<T>;
  initialize(binding: BindingFor<Checkpoint>): Promise<Checkpoint>;
  checkpoint(runId: string, metadata: FinnyLedgerMetadata, artifactReference?: string): Promise<Checkpoint>;
  load(runId: string): Promise<Checkpoint | null>;
}

export function finnyWorkflowRunIdFromEntries(
  entries: readonly { type: string; payload?: unknown }[],
): string | undefined {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "tool_result" || !entry.payload || typeof entry.payload !== "object") continue;
    const runId = (entry.payload as Record<string, unknown>).finnyWorkflowRunId;
    if (typeof runId === "string") return runId;
  }
  return undefined;
}

function assertArtifactRequest(runId: string, value: unknown): asserts value is "required" | "optional" {
  if (value !== "required" && value !== "optional")
    throw new Error(`Finny run ${runId} has an invalid artifact request`);
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PLAN_KEYS = ["capabilityId", "catalogDigest", "operationGraphDigest", "planDigest", "revisionId"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isV2(value: AnyFinnyRunBinding | FinnyStoredRunCheckpoint): value is FinnyRunV2Binding {
  return "schema" in value;
}

function assertPlanIdentity(runId: string, value: unknown): asserts value is FinnyRunPlanBinding {
  if (!isRecord(value) || !isDeepStrictEqual(Object.keys(value).sort(), PLAN_KEYS))
    throw new Error(`Finny run ${runId} has an invalid plan identity`);
  if (
    !DIGEST.test(String(value.catalogDigest)) ||
    !DIGEST.test(String(value.operationGraphDigest)) ||
    !DIGEST.test(String(value.planDigest)) ||
    typeof value.capabilityId !== "string" ||
    !value.capabilityId ||
    value.capabilityId !== value.capabilityId.trim() ||
    typeof value.revisionId !== "string" ||
    !value.revisionId ||
    value.revisionId !== value.revisionId.trim()
  )
    throw new Error(`Finny run ${runId} has an invalid plan identity`);
}

function assertSchema(checkpoint: FinnyStoredRunCheckpoint): void {
  const record = checkpoint as unknown as Record<string, unknown>;
  if (Object.hasOwn(record, "schema") && record.schema !== "finny.run.v2")
    throw new Error(`Finny run ${checkpoint.runId} has an invalid schema`);
  if (!Object.hasOwn(record, "schema") && Object.hasOwn(record, "plan"))
    throw new Error(`Finny run ${checkpoint.runId} has an invalid schema`);
  if (record.schema === "finny.run.v2") {
    if (Object.hasOwn(record, "artifactRequest"))
      throw new Error(`Finny run ${checkpoint.runId} has a duplicated artifact request`);
    assertPlanIdentity(checkpoint.runId, record.plan);
  }
}

function assertBinding(checkpoint: FinnyStoredRunCheckpoint, binding: AnyFinnyRunBinding): void {
  assertSchema(checkpoint);
  if (
    checkpoint.runId !== binding.runId ||
    checkpoint.requestDigest !== binding.requestDigest ||
    checkpoint.sessionId !== binding.sessionId ||
    checkpoint.scopeId !== binding.scopeId
  ) {
    throw new Error(`Finny run ${binding.runId} has a conflicting binding`);
  }
  if (isV2(binding)) {
    if (!isV2(checkpoint)) throw new Error(`Finny run ${binding.runId} has a conflicting schema`);
    assertPlanIdentity(binding.runId, binding.plan);
    if (!isDeepStrictEqual(checkpoint.plan, binding.plan))
      throw new Error(`Finny run ${binding.runId} has a conflicting plan binding`);
  } else {
    if (isV2(checkpoint)) throw new Error(`Finny run ${binding.runId} has a conflicting schema`);
    assertArtifactRequest(checkpoint.runId, checkpoint.artifactRequest);
    assertArtifactRequest(binding.runId, binding.artifactRequest);
    if (checkpoint.artifactRequest !== binding.artifactRequest)
      throw new Error(`Finny run ${binding.runId} has a conflicting artifact request`);
  }
}

function replay(checkpoint: FinnyStoredRunCheckpoint): void {
  assertSchema(checkpoint);
  if (!isV2(checkpoint)) assertArtifactRequest(checkpoint.runId, checkpoint.artifactRequest);
  replayFinnyLedger(checkpoint.runId, checkpoint.ledger);
}

export function createFinnyRunStore(
  backing: DurableMap<FinnyRunCheckpoint>,
  now?: () => string,
  lock?: AdvisoryLock,
): FinnyRunStore;
export function createFinnyRunStore<Stored extends FinnyStoredRunCheckpoint>(
  backing: DurableMap<Stored>,
  now?: () => string,
  lock?: AdvisoryLock,
): FinnyRunStoreFor<Stored>;
export function createFinnyRunStore<Stored extends FinnyStoredRunCheckpoint>(
  backing: DurableMap<Stored>,
  now: () => string = () => new Date().toISOString(),
  lock: AdvisoryLock = createMemoryAdvisoryLock(),
): FinnyRunStoreFor<Stored> {
  if (!backing.update) throw new Error("Finny run checkpoints require atomic updates");
  const heldRuns = new AsyncLocalStorage<{
    active: boolean;
    runIds: ReadonlySet<string>;
    pending: Set<Promise<unknown>>;
  }>();

  return {
    withRunLock<T>(runId: string, work: () => Promise<T>): Promise<T> {
      const held = heldRuns.getStore();
      if (held?.active && held.runIds.has(runId)) {
        const nested = Promise.resolve().then(work);
        held.pending.add(nested);
        void nested.then(
          () => held.pending.delete(nested),
          () => held.pending.delete(nested),
        );
        return nested;
      }
      return lock.withLock(`finny-run:${runId}`, () => {
        const scope = {
          active: true,
          runIds: new Set([...(held?.runIds ?? []), runId]),
          pending: new Set<Promise<unknown>>(),
        };
        return heldRuns.run(scope, async () => {
          try {
            return await work();
          } finally {
            while (scope.pending.size) await Promise.allSettled(scope.pending);
            scope.active = false;
          }
        });
      });
    },

    async initialize(binding: BindingFor<Stored>): Promise<Stored> {
      if (isV2(binding)) assertPlanIdentity(binding.runId, binding.plan);
      const initial = {
        ...binding,
        ledger: [],
        updatedAt: now(),
      } as unknown as Stored;
      const checkpoint = await backing.putIfAbsent(binding.runId, initial);
      assertBinding(checkpoint, binding);
      replay(checkpoint);
      return checkpoint;
    },

    async checkpoint(runId: string, metadata: FinnyLedgerMetadata, artifactReference?: string): Promise<Stored> {
      const checkpoint = await backing.update!(runId, (current) => {
        replay(current);
        const existing = current.ledger.find((entry) => entry.eventId === metadata.eventId);
        if (existing) {
          if (!isDeepStrictEqual(existing, metadata))
            throw new Error(`Finny run ${runId} has a conflicting event ${metadata.eventId}`);
          return current;
        }
        const ledger = [...current.ledger, metadata];
        replayFinnyLedger(runId, ledger);
        return {
          ...current,
          ledger,
          ...(artifactReference || current.artifactReference
            ? { artifactReference: artifactReference ?? current.artifactReference }
            : {}),
          updatedAt: now(),
        };
      });
      if (!checkpoint) throw new Error(`Finny run ${runId} is not initialized`);
      return checkpoint;
    },

    async load(runId: string): Promise<Stored | null> {
      const checkpoint = await backing.get(runId);
      if (checkpoint) replay(checkpoint);
      return checkpoint;
    },
  };
}

export type FinnyRunStore = FinnyRunStoreFor<FinnyRunCheckpoint>;
export type FinnyRunV2Store = FinnyRunStoreFor<FinnyRunV2Checkpoint>;
export type FinnyMixedRunStore = FinnyRunStoreFor<FinnyStoredRunCheckpoint>;
