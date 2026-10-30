import type { DurableMap } from "../persistence/durable-map.ts";
import { createMemoryAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { isDeepStrictEqual } from "node:util";
import { replayFinnyLedger, type FinnyDigest, type FinnyLedgerMetadata } from "./golden-loop.ts";

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

export interface FinnyRunV2Checkpoint extends FinnyRunV2Binding {
  ledger: readonly FinnyLedgerMetadata[];
  artifactReference?: string;
  updatedAt: string;
}

export interface FinnyRunStore {
  withRunLock<T>(runId: string, work: () => Promise<T>): Promise<T>;
  initialize(binding: FinnyRunV2Binding): Promise<FinnyRunV2Checkpoint>;
  checkpoint(runId: string, metadata: FinnyLedgerMetadata, artifactReference?: string): Promise<FinnyRunV2Checkpoint>;
  load(runId: string): Promise<FinnyRunV2Checkpoint | null>;
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

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PLAN_KEYS = ["capabilityId", "catalogDigest", "operationGraphDigest", "planDigest", "revisionId"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function assertSchema(checkpoint: FinnyRunV2Checkpoint): void {
  const record = checkpoint as unknown as Record<string, unknown>;
  if (record.schema !== "finny.run.v2") throw new Error(`Finny run ${checkpoint.runId} has an invalid schema`);
  if (Object.hasOwn(record, "artifactRequest"))
    throw new Error(`Finny run ${checkpoint.runId} has a duplicated artifact request`);
  assertPlanIdentity(checkpoint.runId, record.plan);
}

function assertBinding(checkpoint: FinnyRunV2Checkpoint, binding: FinnyRunV2Binding): void {
  assertSchema(checkpoint);
  if (
    checkpoint.runId !== binding.runId ||
    checkpoint.requestDigest !== binding.requestDigest ||
    checkpoint.sessionId !== binding.sessionId ||
    checkpoint.scopeId !== binding.scopeId
  ) {
    throw new Error(`Finny run ${binding.runId} has a conflicting binding`);
  }
  if (binding.schema !== "finny.run.v2") throw new Error(`Finny run ${binding.runId} has a conflicting schema`);
  assertPlanIdentity(binding.runId, binding.plan);
  if (!isDeepStrictEqual(checkpoint.plan, binding.plan))
    throw new Error(`Finny run ${binding.runId} has a conflicting plan binding`);
}

function replay(checkpoint: FinnyRunV2Checkpoint): void {
  assertSchema(checkpoint);
  replayFinnyLedger(checkpoint.runId, checkpoint.ledger);
}

export function createFinnyRunStore(
  backing: DurableMap<FinnyRunV2Checkpoint>,
  now: () => string = () => new Date().toISOString(),
  lock: AdvisoryLock = createMemoryAdvisoryLock(),
): FinnyRunStore {
  if (!backing.update) throw new Error("Finny run checkpoints require atomic updates");
  return {
    withRunLock<T>(runId: string, work: () => Promise<T>): Promise<T> {
      return lock.withLock(`finny-run:${runId}`, work);
    },

    async initialize(binding: FinnyRunV2Binding): Promise<FinnyRunV2Checkpoint> {
      assertPlanIdentity(binding.runId, binding.plan);
      const initial = {
        ...binding,
        ledger: [],
        updatedAt: now(),
      } satisfies FinnyRunV2Checkpoint;
      assertSchema(initial);
      const checkpoint = await backing.putIfAbsent(binding.runId, initial);
      assertBinding(checkpoint, binding);
      replay(checkpoint);
      return checkpoint;
    },

    async checkpoint(
      runId: string,
      metadata: FinnyLedgerMetadata,
      artifactReference?: string,
    ): Promise<FinnyRunV2Checkpoint> {
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

    async load(runId: string): Promise<FinnyRunV2Checkpoint | null> {
      const checkpoint = await backing.get(runId);
      if (checkpoint) replay(checkpoint);
      return checkpoint;
    },
  };
}
