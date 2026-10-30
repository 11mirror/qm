import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import type { FinnyCapabilityDescriptor } from "../src/finny/capability-pack.ts";
import { createEvidenceBackedFinanceService } from "../src/finny/evidence-backed-finance-service.ts";
import type { FinanceExecutionContext, FinanceService } from "../src/finny/finance.ts";
import {
  applyFinnyHostEvent,
  createFinnyGoldenLoop,
  digestFinnyEvidence,
  replayFinnyLedger,
  type FinnyHostEvent,
} from "../src/finny/golden-loop.ts";
import { compileFinnyOperationPlan, type FinnyOperationPlan } from "../src/finny/operation-compiler.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createFinnyRunStore, type FinnyRunV2Checkpoint } from "../src/finny/run-store.ts";

const digest = (value: string) => digestFinnyEvidence(value);
const context: FinanceExecutionContext = {
  runId: "run-evidence",
  actorId: "actor-evidence",
  scopeId: "personal:actor-evidence",
  credentialHandles: [],
};

const descriptor: FinnyCapabilityDescriptor = {
  schemaVersion: 1,
  capabilityId: "synthetic_velocity",
  revisionId: "synthetic_velocity.v1",
  semanticCapability: "synthetic_velocity",
  semanticAliases: [],
  dimensions: { required: [], supported: {}, defaults: {} },
  operations: [
    { id: "source", primitive: "suiteql_select", dependsOn: [], sql: "SELECT total FROM synthetic", parameters: [] },
    { id: "repeat", primitive: "repeat_pull", dependsOn: ["source"], operationId: "source" },
    {
      id: "reconcile",
      primitive: "reconcile",
      dependsOn: ["source", "repeat"],
      leftField: "total",
      rightField: "total",
      tolerance: "0",
    },
  ],
  resultOperationId: "source",
  parameterBindings: {},
  artifactPolicy: { allowedFormats: ["json"], defaultFormat: "json", attachment: "when_requested" },
  approvalPolicy: { mode: "none", binds: ["capability_revision", "dimensions", "operation_graph"] },
  verificationPolicy: { requiredOperationIds: ["reconcile"], releaseGate: "delivery_eligible" },
};

function plan(): FinnyOperationPlan {
  return compileFinnyOperationPlan({
    descriptor,
    manifestDigest: digest("manifest"),
    catalogDigest: digest("catalog"),
    semanticCapability: descriptor.semanticCapability,
    dimensions: {},
  });
}

async function approvedRun(operationPlan: FinnyOperationPlan) {
  const runStore = createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>());
  await runStore.initialize({
    schema: "finny.run.v2",
    runId: context.runId,
    requestDigest: digest("request"),
    sessionId: "session-evidence",
    scopeId: context.scopeId,
    plan: {
      catalogDigest: operationPlan.catalogDigest,
      capabilityId: operationPlan.capabilityId,
      revisionId: operationPlan.revisionId,
      operationGraphDigest: operationPlan.operationGraphDigest,
      planDigest: operationPlan.planDigest,
    },
  });
  const event = (value: Record<string, unknown>) =>
    ({ authority: "qm-host", occurredAt: "2026-10-30T10:00:00.000Z", ...value }) as FinnyHostEvent;
  let state = createFinnyGoldenLoop(context.runId);
  state = applyFinnyHostEvent(
    state,
    event({ eventId: "clarify", kind: "clarify_completed", evidenceDigest: digest("clarify") }),
  );
  state = applyFinnyHostEvent(
    state,
    event({
      eventId: "preflight",
      kind: "operation_plan_preflight_completed",
      preflightDigest: digest("preflight"),
      planDigest: operationPlan.planDigest,
      catalogDigest: operationPlan.catalogDigest,
      manifestDigest: operationPlan.manifestDigest,
      capabilityId: operationPlan.capabilityId,
      revisionId: operationPlan.revisionId,
      operationGraphDigest: operationPlan.operationGraphDigest,
      artifactPolicyDigest: operationPlan.artifactPolicyDigest,
      approvalPolicyDigest: operationPlan.approvalPolicyDigest,
      verificationPolicyDigest: operationPlan.verificationPolicyDigest,
      approvalRequired: false,
    }),
  );
  state = applyFinnyHostEvent(
    state,
    event({
      eventId: "exempt",
      kind: "plan_exempted",
      planDigest: operationPlan.planDigest,
      approvalPolicyDigest: operationPlan.approvalPolicyDigest,
    }),
  );
  for (const metadata of state.ledger) await runStore.checkpoint(context.runId, metadata);
  return runStore;
}

function delegate(valueForCall: (call: number) => string = () => "42"): FinanceService {
  let calls = 0;
  return {
    async clarify() {
      return { clarification: "scope", evidenceDigest: digest("clarify") };
    },
    async executeOperation() {
      calls += 1;
      return { rows: [{ total: valueForCall(calls) }] };
    },
    async sourcePlan() {
      throw new Error("evidence service owns source custody");
    },
    async recoverSource() {
      throw new Error("evidence service owns source recovery");
    },
    async artifact() {
      throw new Error("evidence service owns artifacts");
    },
    async verify() {
      throw new Error("evidence service owns verification");
    },
  };
}

test("v2 source exposes only the result operation and verifies custodied reconciliation", async () => {
  const operationPlan = plan();
  const runStore = await approvedRun(operationPlan);
  const bytes = createMemoryDurableByteStore();
  const service = createEvidenceBackedFinanceService({
    delegate: delegate(),
    files: createMemoryFileArtifactStore(bytes),
    evidenceBytes: bytes,
    runStore,
  });

  const sourced = await service.sourcePlan({ plan: operationPlan }, context);
  const artifact = await service.artifact({ sourceDigest: sourced.sourceDigest, requirement: "required" }, context);
  const verified = await service.verify(
    { sourceDigest: sourced.sourceDigest, artifactDigest: artifact.artifactDigest, requirement: "required" },
    context,
  );

  assert.deepEqual(sourced.records, [{ total: "42" }]);
  assert.match(artifact.reference ?? "", /\.json$/);
  assert.equal(verified.passed, true);
  assert.deepEqual((await service.recoverSource({ sourceDigest: sourced.sourceDigest }, context)).records, [
    { total: "42" },
  ]);
});

test("v2 verification rejects a fresh pull that does not reconcile", async () => {
  const operationPlan = plan();
  const runStore = await approvedRun(operationPlan);
  const bytes = createMemoryDurableByteStore();
  const service = createEvidenceBackedFinanceService({
    delegate: delegate((call) => (call === 1 ? "42" : "43")),
    files: createMemoryFileArtifactStore(bytes),
    evidenceBytes: bytes,
    runStore,
  });
  const sourced = await service.sourcePlan({ plan: operationPlan }, context);
  assert.equal(
    (await service.verify({ sourceDigest: sourced.sourceDigest, requirement: "optional" }, context)).passed,
    false,
  );
});

test("v2 verification fails closed when required result bytes are corrupt", async () => {
  const operationPlan = plan();
  const runStore = await approvedRun(operationPlan);
  const backing = createMemoryDurableByteStore();
  const corruption: { key?: string } = {};
  const bytes = {
    ...backing,
    async open(key: string) {
      const opened = await backing.open(key);
      if (!opened || key !== corruption.key) return opened;
      return { sizeBytes: opened.sizeBytes, stream: Readable.from(Buffer.alloc(opened.sizeBytes, 32)) };
    },
  };
  const service = createEvidenceBackedFinanceService({
    delegate: delegate(),
    files: createMemoryFileArtifactStore(bytes),
    evidenceBytes: bytes,
    runStore,
  });
  const sourced = await service.sourcePlan({ plan: operationPlan }, context);
  const checkpoint = await runStore.load(context.runId);
  const state = replayFinnyLedger(context.runId, checkpoint!.ledger);
  corruption.key = `files/${state.completedOperations.reconcile!.resultDigest.slice("sha256:".length)}`;

  await assert.rejects(
    service.verify({ sourceDigest: sourced.sourceDigest, requirement: "optional" }, context),
    /result digest/i,
  );
});
