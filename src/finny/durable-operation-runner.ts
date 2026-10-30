import { createHash } from "node:crypto";

import type { DurableByteStore } from "../files/durable-byte-store.ts";
import { canonicalFinnyJson } from "./canonical-json.ts";
import { applyFinnyHostEvent, replayFinnyLedger, type FinnyDigest, type FinnyGoldenLoopState } from "./golden-loop.ts";
import type { FinnyCompiledOperation, FinnyOperationPlan } from "./operation-compiler.ts";
import { loadFinnyOperationResult, storeFinnyOperationResult } from "./operation-custody.ts";
import {
  digestFinnyOperationRows,
  runFinnyOperationPlan,
  type FinnyOperationRunnerInput,
  type FinnyVerifiedOperationResultSets,
} from "./operation-runner.ts";
import type { FinnyRunV2Checkpoint } from "./run-store.ts";

interface FinnyDurableOperationRunStore {
  checkpoint(runId: string, metadata: FinnyGoldenLoopState["ledger"][number]): Promise<FinnyRunV2Checkpoint>;
  load(runId: string): Promise<FinnyRunV2Checkpoint | null>;
}

export interface FinnyDurableOperationRunnerInput {
  readonly runId: string;
  readonly plan: FinnyOperationPlan;
  readonly targetOperationIds: readonly string[];
  readonly runStore: FinnyDurableOperationRunStore;
  readonly resultBytes: DurableByteStore;
  readonly executeExternal: FinnyOperationRunnerInput["executeExternal"];
}

export function digestFinnyCompiledOperation(
  planDigest: FinnyDigest,
  ordinal: number,
  operation: FinnyCompiledOperation,
): FinnyDigest {
  const binding = canonicalFinnyJson({ operation, ordinal, planDigest });
  return `sha256:${createHash("sha256").update(binding).digest("hex")}`;
}

function assertPlanBinding(
  checkpoint: FinnyRunV2Checkpoint,
  state: FinnyGoldenLoopState,
  plan: FinnyOperationPlan,
): void {
  if (state.stage !== "PLAN_APPROVED")
    throw new Error(`Finny run ${checkpoint.runId} must be at PLAN_APPROVED before operation execution`);
  if (state.planDigest !== plan.planDigest)
    throw new Error(`Finny run ${checkpoint.runId} plan digest does not match the compiled plan`);
  const expected = checkpoint.plan;
  if (
    expected.planDigest !== plan.planDigest ||
    expected.catalogDigest !== plan.catalogDigest ||
    expected.capabilityId !== plan.capabilityId ||
    expected.revisionId !== plan.revisionId ||
    expected.operationGraphDigest !== plan.operationGraphDigest
  )
    throw new Error(`Finny run ${checkpoint.runId} plan binding does not match the compiled plan`);
  if (
    (state.catalogDigest && state.catalogDigest !== plan.catalogDigest) ||
    (state.manifestDigest && state.manifestDigest !== plan.manifestDigest) ||
    (state.capabilityId && state.capabilityId !== plan.capabilityId) ||
    (state.revisionId && state.revisionId !== plan.revisionId) ||
    (state.operationGraphDigest && state.operationGraphDigest !== plan.operationGraphDigest)
  )
    throw new Error(`Finny run ${checkpoint.runId} operation plan authority does not match the compiled plan`);
}

async function restoredResults(
  runId: string,
  plan: FinnyOperationPlan,
  state: FinnyGoldenLoopState,
  resultBytes: DurableByteStore,
): Promise<{
  restored: FinnyVerifiedOperationResultSets;
  custodyDigests: Readonly<Record<string, FinnyDigest>>;
}> {
  const known = new Set(plan.operations.map((operation) => operation.id));
  for (const operationId of Object.keys(state.completedOperations))
    if (!known.has(operationId))
      throw new Error(`Finny completed operation ${operationId} does not belong to the compiled plan`);

  const restored: Record<string, FinnyVerifiedOperationResultSets[string]> = {};
  const custodyDigests: Record<string, FinnyDigest> = {};
  for (const [ordinal, operation] of plan.operations.entries()) {
    const completed = state.completedOperations[operation.id];
    if (!completed) continue;
    const operationDigest = digestFinnyCompiledOperation(plan.planDigest, ordinal, operation);
    if (completed.primitive !== operation.primitive || completed.operationDigest !== operationDigest)
      throw new Error(`Finny completed operation ${operation.id} does not match the compiled plan`);
    const dependencyResults = operation.dependsOn.map((operationId) => {
      const resultDigest = custodyDigests[operationId];
      if (!resultDigest)
        throw new Error(`Finny completed operation ${operation.id} dependency ${operationId} is unavailable`);
      return { operationId, resultDigest };
    });
    const envelope = await loadFinnyOperationResult(resultBytes, {
      runId,
      planDigest: plan.planDigest,
      operationId: operation.id,
      operationDigest,
      dependencyResults,
      resultDigest: completed.resultDigest,
    });
    restored[operation.id] = Object.freeze({
      rows: envelope.output,
      digest: digestFinnyOperationRows(envelope.output),
    });
    custodyDigests[operation.id] = completed.resultDigest;
  }
  return { restored: Object.freeze(restored), custodyDigests };
}

export async function runFinnyDurableOperationPlan(
  input: FinnyDurableOperationRunnerInput,
): Promise<FinnyVerifiedOperationResultSets> {
  const checkpoint = await input.runStore.load(input.runId);
  if (!checkpoint) throw new Error(`Finny run ${input.runId} is not initialized`);
  let state = replayFinnyLedger(input.runId, checkpoint.ledger);
  assertPlanBinding(checkpoint, state, input.plan);
  const restored = await restoredResults(input.runId, input.plan, state, input.resultBytes);
  const custodyDigests: Record<string, FinnyDigest> = { ...restored.custodyDigests };
  const ordinals = new Map(input.plan.operations.map((operation, ordinal) => [operation.id, ordinal]));

  return runFinnyOperationPlan({
    plan: input.plan,
    targetOperationIds: input.targetOperationIds,
    restoredResultSets: restored.restored,
    executeExternal: input.executeExternal,
    onCompleted: async ({ operation, rows }) => {
      const ordinal = ordinals.get(operation.id);
      if (ordinal === undefined) throw new Error(`Finny operation ${operation.id} has no plan ordinal`);
      const operationDigest = digestFinnyCompiledOperation(input.plan.planDigest, ordinal, operation);
      const dependencyResults = operation.dependsOn.map((operationId) => {
        const resultDigest = custodyDigests[operationId];
        if (!resultDigest)
          throw new Error(`Finny operation ${operation.id} dependency ${operationId} has no durable result`);
        return { operationId, resultDigest };
      });
      const stored = await storeFinnyOperationResult(input.resultBytes, {
        runId: input.runId,
        planDigest: input.plan.planDigest,
        operationId: operation.id,
        operationDigest,
        dependencyResults,
        output: rows,
      });
      const next = applyFinnyHostEvent(state, {
        authority: "qm-host",
        eventId: `${input.runId}:operation:${operation.id}`,
        occurredAt: new Date().toISOString(),
        kind: "operation_completed",
        operationId: operation.id,
        primitive: operation.primitive,
        operationDigest,
        resultDigest: stored.resultDigest,
      });
      await input.runStore.checkpoint(input.runId, next.ledger.at(-1)!);
      state = next;
      custodyDigests[operation.id] = stored.resultDigest;
    },
  });
}
