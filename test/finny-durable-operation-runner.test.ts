import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import type { FinnyCapabilityDescriptor } from "../src/finny/capability-pack.ts";
import { runFinnyDurableOperationPlan } from "../src/finny/durable-operation-runner.ts";
import {
  applyFinnyHostEvent,
  createFinnyGoldenLoop,
  digestFinnyEvidence,
  replayFinnyLedger,
  type FinnyHostEvent,
} from "../src/finny/golden-loop.ts";
import { compileFinnyOperationPlan, type FinnyOperationPlan } from "../src/finny/operation-compiler.ts";
import { createFinnyRunStore, type FinnyRunV2Checkpoint } from "../src/finny/run-store.ts";
import { createMemoryDurableByteStore, type DurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const descriptor: FinnyCapabilityDescriptor = {
  schemaVersion: 1,
  capabilityId: "reviewed_balance",
  revisionId: "reviewed_balance.2026-10-30",
  semanticCapability: "reviewed_balance",
  semanticAliases: ["balance"],
  dimensions: {
    required: ["entity"],
    supported: { sources: ["netsuite"] },
    defaults: { sources: ["netsuite"] },
  },
  operations: [
    {
      id: "source",
      primitive: "suiteql_select",
      dependsOn: [],
      sql: "SELECT entity, amount FROM balance WHERE entity = :entity_id",
      parameters: ["entity_id"],
    },
    {
      id: "selected",
      primitive: "project",
      dependsOn: ["source"],
      fields: ["entity", "amount"],
    },
  ],
  resultOperationId: "selected",
  parameterBindings: {
    entity_id: { source: "dimension", path: ["entity", "name"] },
  },
  artifactPolicy: {
    allowedFormats: ["json"],
    defaultFormat: "json",
    attachment: "when_requested",
  },
  approvalPolicy: {
    mode: "none",
    binds: ["capability_revision", "dimensions", "operation_graph"],
  },
  verificationPolicy: {
    requiredOperationIds: [],
    releaseGate: "delivery_eligible",
  },
};

function compiledPlan(): FinnyOperationPlan {
  return compileFinnyOperationPlan({
    descriptor,
    manifestDigest: digestFinnyEvidence("manifest"),
    catalogDigest: digestFinnyEvidence("catalog"),
    semanticCapability: "reviewed_balance",
    dimensions: {
      entity: { kind: "named", name: "MTPL" },
      sources: ["netsuite"],
    },
  });
}

function hostEvent(event: Record<string, unknown>): FinnyHostEvent {
  return {
    authority: "qm-host",
    occurredAt: "2026-10-30T10:00:00.000Z",
    ...event,
  } as FinnyHostEvent;
}

async function approvedRun(plan: FinnyOperationPlan) {
  const runId = "run-durable";
  const runStore = createFinnyRunStore<FinnyRunV2Checkpoint>(createMemoryMap<FinnyRunV2Checkpoint>());
  await runStore.initialize({
    schema: "finny.run.v2",
    runId,
    requestDigest: digestFinnyEvidence("request"),
    sessionId: "session",
    scopeId: "scope",
    plan: {
      catalogDigest: plan.catalogDigest,
      capabilityId: plan.capabilityId,
      revisionId: plan.revisionId,
      operationGraphDigest: plan.operationGraphDigest,
      planDigest: plan.planDigest,
    },
  });
  let state = createFinnyGoldenLoop(runId);
  state = applyFinnyHostEvent(
    state,
    hostEvent({
      eventId: `${runId}:clarify`,
      kind: "clarify_completed",
      evidenceDigest: digestFinnyEvidence("clarification"),
    }),
  );
  state = applyFinnyHostEvent(
    state,
    hostEvent({
      eventId: `${runId}:preflight`,
      kind: "operation_plan_preflight_completed",
      preflightDigest: digestFinnyEvidence("preflight"),
      planDigest: plan.planDigest,
      catalogDigest: plan.catalogDigest,
      manifestDigest: plan.manifestDigest,
      capabilityId: plan.capabilityId,
      revisionId: plan.revisionId,
      operationGraphDigest: plan.operationGraphDigest,
      artifactPolicyDigest: digestFinnyEvidence("artifact-policy"),
      approvalPolicyDigest: digestFinnyEvidence("approval-policy"),
      verificationPolicyDigest: digestFinnyEvidence("verification-policy"),
      approvalRequired: false,
    }),
  );
  state = applyFinnyHostEvent(
    state,
    hostEvent({
      eventId: `${runId}:exempted`,
      kind: "plan_exempted",
      planDigest: plan.planDigest,
      approvalPolicyDigest: digestFinnyEvidence("approval-policy"),
    }),
  );
  for (const metadata of state.ledger) await runStore.checkpoint(runId, metadata);
  return { runId, runStore };
}

test("persists canonical operation results before ledger completion and resumes without execution", async () => {
  const plan = compiledPlan();
  const { runId, runStore } = await approvedRun(plan);
  const bytes = createMemoryDurableByteStore();
  let calls = 0;
  const executeExternal = async () => {
    calls += 1;
    return [{ entity: "MTPL", amount: "10", ignored: true }];
  };

  const first = await runFinnyDurableOperationPlan({
    runId,
    plan,
    targetOperationIds: ["selected"],
    runStore,
    resultBytes: bytes,
    executeExternal,
  });
  const checkpoint = await runStore.load(runId);
  const state = replayFinnyLedger(runId, checkpoint!.ledger);

  assert.equal(calls, 1);
  assert.deepEqual(first.selected?.rows, [{ entity: "MTPL", amount: "10" }]);
  assert.deepEqual(Object.keys(state.completedOperations), ["source", "selected"]);
  assert.equal(checkpoint!.ledger.at(-2)?.eventId, `${runId}:operation:source`);
  assert.equal(checkpoint!.ledger.at(-1)?.eventId, `${runId}:operation:selected`);

  const resumed = await runFinnyDurableOperationPlan({
    runId,
    plan,
    targetOperationIds: ["selected"],
    runStore,
    resultBytes: bytes,
    executeExternal,
  });

  assert.equal(calls, 1);
  assert.deepEqual(resumed.selected, first.selected);
});

test("re-executes after a crash between result persistence and ledger completion", async () => {
  const plan = compiledPlan();
  const { runId, runStore: backing } = await approvedRun(plan);
  const bytes = createMemoryDurableByteStore();
  let fail = true;
  const runStore: typeof backing = {
    ...backing,
    async checkpoint(run, metadata, artifactReference) {
      if (metadata.eventKind === "operation_completed" && fail) {
        fail = false;
        throw new Error("crash-before-event");
      }
      return backing.checkpoint(run, metadata, artifactReference);
    },
  };
  let calls = 0;
  const input = {
    runId,
    plan,
    targetOperationIds: ["source"],
    runStore,
    resultBytes: bytes,
    executeExternal: async () => {
      calls += 1;
      return [{ entity: "MTPL", amount: "10" }];
    },
  };

  await assert.rejects(runFinnyDurableOperationPlan(input), /crash-before-event/);
  assert.equal(calls, 1);
  assert.deepEqual(replayFinnyLedger(runId, (await backing.load(runId))!.ledger).completedOperations, {});

  await runFinnyDurableOperationPlan(input);

  assert.equal(calls, 2);
  assert.ok(replayFinnyLedger(runId, (await backing.load(runId))!.ledger).completedOperations.source);
});

test("resumes without execution after a crash following ledger completion", async () => {
  const plan = compiledPlan();
  const { runId, runStore: backing } = await approvedRun(plan);
  const bytes = createMemoryDurableByteStore();
  let fail = true;
  const runStore: typeof backing = {
    ...backing,
    async checkpoint(run, metadata, artifactReference) {
      const checkpoint = await backing.checkpoint(run, metadata, artifactReference);
      if (metadata.eventKind === "operation_completed" && fail) {
        fail = false;
        throw new Error("crash-after-event");
      }
      return checkpoint;
    },
  };
  let calls = 0;
  const input = {
    runId,
    plan,
    targetOperationIds: ["source"],
    runStore,
    resultBytes: bytes,
    executeExternal: async () => {
      calls += 1;
      return [{ entity: "MTPL", amount: "10" }];
    },
  };

  await assert.rejects(runFinnyDurableOperationPlan(input), /crash-after-event/);
  await runFinnyDurableOperationPlan(input);

  assert.equal(calls, 1);
});

test("fails closed when a completed operation result is missing", async () => {
  const plan = compiledPlan();
  const { runId, runStore } = await approvedRun(plan);
  const bytes = createMemoryDurableByteStore();
  await runFinnyDurableOperationPlan({
    runId,
    plan,
    targetOperationIds: ["source"],
    runStore,
    resultBytes: bytes,
    executeExternal: async () => [{ entity: "MTPL", amount: "10" }],
  });
  const state = replayFinnyLedger(runId, (await runStore.load(runId))!.ledger);
  await bytes.delete(`files/${state.completedOperations.source!.resultDigest.slice("sha256:".length)}`);

  await assert.rejects(
    runFinnyDurableOperationPlan({
      runId,
      plan,
      targetOperationIds: ["source"],
      runStore,
      resultBytes: bytes,
      executeExternal: async () => {
        throw new Error("must not execute");
      },
    }),
    /result bytes.*unavailable/i,
  );
});

test("fails closed when completed operation result bytes are corrupt", async () => {
  const plan = compiledPlan();
  const { runId, runStore } = await approvedRun(plan);
  const bytes = createMemoryDurableByteStore();
  await runFinnyDurableOperationPlan({
    runId,
    plan,
    targetOperationIds: ["source"],
    runStore,
    resultBytes: bytes,
    executeExternal: async () => [{ entity: "MTPL", amount: "10" }],
  });
  const corrupt: DurableByteStore = {
    ...bytes,
    async open(blobKey) {
      const opened = await bytes.open(blobKey);
      if (!opened) return null;
      return { sizeBytes: opened.sizeBytes, stream: Readable.from(Buffer.alloc(opened.sizeBytes, 32)) };
    },
  };

  await assert.rejects(
    runFinnyDurableOperationPlan({
      runId,
      plan,
      targetOperationIds: ["source"],
      runStore,
      resultBytes: corrupt,
      executeExternal: async () => {
        throw new Error("must not execute");
      },
    }),
    /result digest/i,
  );
});

test("requires an approved checkpoint bound to the exact plan", async () => {
  const plan = compiledPlan();
  const { runId, runStore } = await approvedRun(plan);
  const bytes = createMemoryDurableByteStore();
  const changed = { ...plan, planDigest: digestFinnyEvidence("changed-plan") } as FinnyOperationPlan;

  await assert.rejects(
    runFinnyDurableOperationPlan({
      runId,
      plan: changed,
      targetOperationIds: ["source"],
      runStore,
      resultBytes: bytes,
      executeExternal: async () => [],
    }),
    /plan.*digest|plan binding/i,
  );

  const pendingStore = createFinnyRunStore<FinnyRunV2Checkpoint>(createMemoryMap<FinnyRunV2Checkpoint>());
  await pendingStore.initialize({
    schema: "finny.run.v2",
    runId: "run-pending",
    requestDigest: digestFinnyEvidence("request"),
    sessionId: "session",
    scopeId: "scope",
    plan: {
      catalogDigest: plan.catalogDigest,
      capabilityId: plan.capabilityId,
      revisionId: plan.revisionId,
      operationGraphDigest: plan.operationGraphDigest,
      planDigest: plan.planDigest,
    },
  });
  await assert.rejects(
    runFinnyDurableOperationPlan({
      runId: "run-pending",
      plan,
      targetOperationIds: ["source"],
      runStore: pendingStore,
      resultBytes: bytes,
      executeExternal: async () => [],
    }),
    /PLAN_APPROVED/i,
  );
});
