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

export interface FinnyRunCheckpoint extends FinnyRunBinding {
  ledger: readonly FinnyLedgerMetadata[];
  artifactReference?: string;
  updatedAt: string;
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

function assertBinding(checkpoint: FinnyRunCheckpoint, binding: FinnyRunBinding): void {
  if (
    checkpoint.runId !== binding.runId ||
    checkpoint.requestDigest !== binding.requestDigest ||
    checkpoint.sessionId !== binding.sessionId ||
    checkpoint.scopeId !== binding.scopeId
  ) {
    throw new Error(`Finny run ${binding.runId} has a conflicting binding`);
  }
  assertArtifactRequest(checkpoint.runId, checkpoint.artifactRequest);
  assertArtifactRequest(binding.runId, binding.artifactRequest);
  if (checkpoint.artifactRequest !== binding.artifactRequest)
    throw new Error(`Finny run ${binding.runId} has a conflicting artifact request`);
}

function replay(checkpoint: FinnyRunCheckpoint): void {
  assertArtifactRequest(checkpoint.runId, checkpoint.artifactRequest);
  replayFinnyLedger(checkpoint.runId, checkpoint.ledger);
}

export function createFinnyRunStore(
  backing: DurableMap<FinnyRunCheckpoint>,
  now: () => string = () => new Date().toISOString(),
  lock: AdvisoryLock = createMemoryAdvisoryLock(),
) {
  if (!backing.update) throw new Error("Finny run checkpoints require atomic updates");

  return {
    withRunLock<T>(runId: string, work: () => Promise<T>): Promise<T> {
      return lock.withLock(`finny-run:${runId}`, work);
    },

    async initialize(binding: FinnyRunBinding): Promise<FinnyRunCheckpoint> {
      const initial: FinnyRunCheckpoint = {
        ...binding,
        ledger: [],
        updatedAt: now(),
      };
      const checkpoint = await backing.putIfAbsent(binding.runId, initial);
      assertBinding(checkpoint, binding);
      replay(checkpoint);
      return checkpoint;
    },

    async checkpoint(
      runId: string,
      metadata: FinnyLedgerMetadata,
      artifactReference?: string,
    ): Promise<FinnyRunCheckpoint> {
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
          runId: current.runId,
          requestDigest: current.requestDigest,
          sessionId: current.sessionId,
          scopeId: current.scopeId,
          artifactRequest: current.artifactRequest,
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

    async load(runId: string): Promise<FinnyRunCheckpoint | null> {
      const checkpoint = await backing.get(runId);
      if (checkpoint) replay(checkpoint);
      return checkpoint;
    },
  };
}

export type FinnyRunStore = ReturnType<typeof createFinnyRunStore>;
