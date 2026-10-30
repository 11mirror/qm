import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createEvidenceBackedFinanceService } from "../src/finny/evidence-backed-finance-service.ts";
import type { FinanceExecutionContext, FinanceService } from "../src/finny/finance.ts";
import {
  applyFinnyHostEvent,
  createFinnyGoldenLoop,
  digestFinnyEvidence,
  replayFinnyLedger,
  type FinnyHostEvent,
} from "../src/finny/golden-loop.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import type { FinnyCapabilityDescriptor } from "../src/finny/capability-pack.ts";
import { compileFinnyOperationPlan, type FinnyOperationPlan } from "../src/finny/operation-compiler.ts";
import { createFinnyRunStore, type FinnyRunV2Checkpoint } from "../src/finny/run-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const digest = (value: string) => digestFinnyEvidence(value);
const context = {
  runId: "run-evidence",
  actorId: "actor-evidence",
  scopeId: "personal:actor-evidence",
  credentialHandles: [],
} as FinanceExecutionContext;

function delegate(rowsForCall: (call: number) => readonly unknown[]): {
  service: FinanceService;
  sourceCalls: () => number;
} {
  let calls = 0;
  return {
    sourceCalls: () => calls,
    service: {
      async clarify() {
        return { clarification: "scope", evidenceDigest: digest("clarify") };
      },
      async preflight() {
        return { planSummary: "read", preflightDigest: digest("preflight"), planDigest: digest("plan") };
      },
      async plan() {
        return { decision: "approved", approvalDigest: digest("approval") };
      },
      async source() {
        calls += 1;
        return { records: rowsForCall(calls), sourceDigest: digest(`upstream-${calls}`) };
      },
      async artifact() {
        throw new Error("evidence service owns artifacts");
      },
      async verify() {
        throw new Error("evidence service owns verification");
      },
    },
  };
}

async function withCustodiedQuery(
  service: FinanceService,
  query: string,
  sourceContext: FinanceExecutionContext = context,
): Promise<FinanceExecutionContext> {
  await service.preflight({ request: "finance request", clarificationDigest: digest("clarify"), query }, sourceContext);
  return { ...sourceContext, approvedQueryDigest: digest(`finny-query:v1:${query}`) };
}

const syntheticDescriptor: FinnyCapabilityDescriptor = {
  schemaVersion: 1,
  capabilityId: "synthetic_velocity",
  revisionId: "synthetic_velocity.v1",
  semanticCapability: "synthetic_velocity",
  semanticAliases: [],
  dimensions: { required: [], supported: {}, defaults: {} },
  operations: [
    {
      id: "synthetic_source",
      primitive: "suiteql_select",
      dependsOn: [],
      sql: "SELECT total FROM synthetic_velocity",
      parameters: [],
    },
    { id: "delivered", primitive: "project", dependsOn: ["synthetic_source"], fields: ["total"] },
    {
      id: "repeated_source",
      primitive: "repeat_pull",
      dependsOn: ["synthetic_source"],
      operationId: "synthetic_source",
    },
    { id: "repeated", primitive: "project", dependsOn: ["repeated_source"], fields: ["total"] },
    {
      id: "reconciled",
      primitive: "reconcile",
      dependsOn: ["delivered", "repeated"],
      leftField: "total",
      rightField: "total",
      tolerance: "0",
    },
  ],
  resultOperationId: "delivered",
  parameterBindings: {},
  artifactPolicy: { allowedFormats: ["json"], defaultFormat: "json", attachment: "when_requested" },
  approvalPolicy: { mode: "none", binds: ["capability_revision", "dimensions", "operation_graph"] },
  verificationPolicy: { requiredOperationIds: ["reconciled"], releaseGate: "delivery_eligible" },
};

function syntheticPlan(): FinnyOperationPlan {
  return compileFinnyOperationPlan({
    descriptor: syntheticDescriptor,
    manifestDigest: digest("synthetic-manifest"),
    catalogDigest: digest("synthetic-catalog"),
    semanticCapability: "synthetic_velocity",
    dimensions: {},
  });
}

function hostEvent(event: Record<string, unknown>): FinnyHostEvent {
  return { authority: "qm-host", occurredAt: "2026-10-30T10:00:00.000Z", ...event } as FinnyHostEvent;
}

async function approvedPlanRun(plan: FinnyOperationPlan) {
  const runStore = createFinnyRunStore<FinnyRunV2Checkpoint>(createMemoryMap<FinnyRunV2Checkpoint>());
  await runStore.initialize({
    schema: "finny.run.v2",
    runId: context.runId,
    requestDigest: digest("synthetic-request"),
    sessionId: "session-evidence",
    scopeId: context.scopeId,
    plan: {
      catalogDigest: plan.catalogDigest,
      capabilityId: plan.capabilityId,
      revisionId: plan.revisionId,
      operationGraphDigest: plan.operationGraphDigest,
      planDigest: plan.planDigest,
    },
  });
  let state = createFinnyGoldenLoop(context.runId);
  state = applyFinnyHostEvent(
    state,
    hostEvent({ eventId: "synthetic:clarify", kind: "clarify_completed", evidenceDigest: digest("clarification") }),
  );
  state = applyFinnyHostEvent(
    state,
    hostEvent({
      eventId: "synthetic:preflight",
      kind: "operation_plan_preflight_completed",
      preflightDigest: digest("preflight"),
      planDigest: plan.planDigest,
      catalogDigest: plan.catalogDigest,
      manifestDigest: plan.manifestDigest,
      capabilityId: plan.capabilityId,
      revisionId: plan.revisionId,
      operationGraphDigest: plan.operationGraphDigest,
      artifactPolicyDigest: plan.artifactPolicyDigest,
      approvalPolicyDigest: plan.approvalPolicyDigest,
      verificationPolicyDigest: plan.verificationPolicyDigest,
      approvalRequired: false,
    }),
  );
  state = applyFinnyHostEvent(
    state,
    hostEvent({
      eventId: "synthetic:exempted",
      kind: "plan_exempted",
      planDigest: plan.planDigest,
      approvalPolicyDigest: plan.approvalPolicyDigest,
    }),
  );
  for (const event of state.ledger) await runStore.checkpoint(context.runId, event);
  return runStore;
}

function planDelegate(totalForCall: (call: number) => string = () => "42"): {
  service: FinanceService;
  operationCalls: () => number;
  legacySourceCalls: () => number;
} {
  let operations = 0;
  let legacy = 0;
  return {
    operationCalls: () => operations,
    legacySourceCalls: () => legacy,
    service: {
      ...delegate(() => []).service,
      async source() {
        legacy += 1;
        return { records: [], sourceDigest: digest("legacy") };
      },
      async executeOperation() {
        operations += 1;
        return { rows: [{ total: totalForCall(operations), hidden: operations }] };
      },
    },
  };
}

test("plan-native source delivers only the declared result and verifies custodied required operations", async () => {
  const plan = syntheticPlan();
  const runStore = await approvedPlanRun(plan);
  const bytes = createMemoryDurableByteStore();
  const delegated = planDelegate();
  const service = createEvidenceBackedFinanceService({
    delegate: delegated.service,
    files: createMemoryFileArtifactStore(bytes),
    evidenceBytes: bytes,
    runStore,
  });

  const sourced = await service.sourcePlan!({ plan }, context);
  const artifact = await service.artifact({ sourceDigest: sourced.sourceDigest, requirement: "required" }, context);
  const verified = await service.verify(
    {
      sourceDigest: sourced.sourceDigest,
      artifactDigest: artifact.artifactDigest,
      requirement: artifact.requirement,
    },
    context,
  );

  assert.deepEqual(sourced.records, [{ total: "42" }]);
  assert.equal(artifact.requirement, "required");
  assert.match(artifact.reference ?? "", /\.json$/);
  assert.equal((await service.artifact({ sourceDigest: sourced.sourceDigest }, context)).requirement, "optional");
  assert.equal(verified.passed, true);
  assert.equal(delegated.operationCalls(), 2);
  assert.equal(delegated.legacySourceCalls(), 0);
  assert.deepEqual((await service.recoverSource!({ sourceDigest: sourced.sourceDigest }, context)).records, [
    { total: "42" },
  ]);
});

test("plan-native verification rejects a required reconciliation that did not reconcile", async () => {
  const plan = syntheticPlan();
  const runStore = await approvedPlanRun(plan);
  const bytes = createMemoryDurableByteStore();
  const delegated = planDelegate((call) => (call === 1 ? "42" : "43"));
  const service = createEvidenceBackedFinanceService({
    delegate: delegated.service,
    files: createMemoryFileArtifactStore(bytes),
    evidenceBytes: bytes,
    runStore,
  });

  const sourced = await service.sourcePlan!({ plan }, context);
  const verified = await service.verify({ sourceDigest: sourced.sourceDigest, requirement: "optional" }, context);

  assert.equal(verified.passed, false);
  assert.equal(delegated.legacySourceCalls(), 0);
});

test("plan-native verification fails closed when a required custodied result is missing", async () => {
  const plan = syntheticPlan();
  const runStore = await approvedPlanRun(plan);
  const bytes = createMemoryDurableByteStore();
  const service = createEvidenceBackedFinanceService({
    delegate: planDelegate().service,
    files: createMemoryFileArtifactStore(bytes),
    evidenceBytes: bytes,
    runStore,
  });
  const sourced = await service.sourcePlan!({ plan }, context);
  const checkpoint = await runStore.load(context.runId);
  const state = replayFinnyLedger(context.runId, checkpoint!.ledger);
  await bytes.delete(`files/${state.completedOperations.reconciled!.resultDigest.slice("sha256:".length)}`);

  await assert.rejects(
    service.verify({ sourceDigest: sourced.sourceDigest, requirement: "optional" }, context),
    /result bytes.*unavailable/i,
  );
});

test("plan-native verification fails closed when a required custodied result is corrupt", async () => {
  const plan = syntheticPlan();
  const runStore = await approvedPlanRun(plan);
  const backing = createMemoryDurableByteStore();
  const corruption: { blobKey?: string } = {};
  const bytes = {
    ...backing,
    async open(blobKey: string) {
      const opened = await backing.open(blobKey);
      if (!opened || blobKey !== corruption.blobKey) return opened;
      return { sizeBytes: opened.sizeBytes, stream: Readable.from(Buffer.alloc(opened.sizeBytes, 32)) };
    },
  };
  const service = createEvidenceBackedFinanceService({
    delegate: planDelegate().service,
    files: createMemoryFileArtifactStore(bytes),
    evidenceBytes: bytes,
    runStore,
  });
  const sourced = await service.sourcePlan!({ plan }, context);
  const checkpoint = await runStore.load(context.runId);
  const state = replayFinnyLedger(context.runId, checkpoint!.ledger);
  corruption.blobKey = `files/${state.completedOperations.reconciled!.resultDigest.slice("sha256:".length)}`;

  await assert.rejects(
    service.verify({ sourceDigest: sourced.sourceDigest, requirement: "optional" }, context),
    /result digest/i,
  );
});

test("host persists source evidence and requires an artifact above ten rows", async () => {
  const evidenceBytes = createMemoryDurableByteStore();
  const artifactBytes = createMemoryDurableByteStore();
  const files = createMemoryFileArtifactStore(artifactBytes);
  const rows = Array.from({ length: 11 }, (_, index) => ({ id: index + 1, amount: String(index + 10) }));
  const source = delegate(() => rows);
  const service = createEvidenceBackedFinanceService({ delegate: source.service, files, evidenceBytes });
  const query = "SELECT id, amount FROM invoice";
  const sourceContext = await withCustodiedQuery(service, query);

  const sourced = await service.source({ planDigest: digest("plan") }, sourceContext);
  const artifact = await service.artifact({ sourceDigest: sourced.sourceDigest }, context);
  const verified = await service.verify(
    {
      sourceDigest: sourced.sourceDigest,
      artifactDigest: artifact.artifactDigest,
      requirement: artifact.requirement,
    },
    context,
  );

  assert.equal(artifact.requirement, "required");
  assert.match(artifact.reference ?? "", /^artifacts\/[a-f0-9]{32}\/finny-report-[a-f0-9]{12}\.csv$/);
  assert.notEqual(artifact.artifactDigest, sourced.sourceDigest);
  assert.equal(verified.passed, true);
  assert.equal(source.sourceCalls(), 2);
  const stored = await files.listOwnedByScopes([context.scopeId]);
  assert.equal(stored.files.length, 1);
  assert.equal(stored.files[0]?.mimetype, "text/csv");
  assert.equal(stored.files[0]?.sha256, artifact.artifactDigest?.slice("sha256:".length));
  const opened = await files.open(stored.files[0]!.id);
  assert.ok(opened);
  let csv = "";
  for await (const chunk of opened.stream) csv += String(chunk);
  assert.equal(csv.split("\n").slice(0, 3).join("\n"), "amount,id\n10,1\n11,2");
  await artifactBytes.delete(stored.files[0]!.blobKey!);
  assert.equal(
    (
      await service.verify(
        {
          sourceDigest: sourced.sourceDigest,
          artifactDigest: artifact.artifactDigest,
          requirement: artifact.requirement,
        },
        context,
      )
    ).passed,
    false,
  );
});

test("host keeps a small result artifact-optional", async () => {
  const bytes = createMemoryDurableByteStore();
  const files = createMemoryFileArtifactStore(bytes);
  const source = delegate(() => [{ total: "42" }]);
  const service = createEvidenceBackedFinanceService({ delegate: source.service, files, evidenceBytes: bytes });
  const sourceContext = await withCustodiedQuery(service, "SELECT total FROM invoice");

  const sourced = await service.source({ planDigest: digest("plan") }, sourceContext);
  const artifact = await service.artifact({ sourceDigest: sourced.sourceDigest }, context);

  assert.deepEqual(artifact, {
    requirement: "optional",
    policyDigest: digest("finny-artifact-policy:v2:requested:optional:rows>10:optional:1"),
  });
  assert.equal((await files.listOwnedByScopes([context.scopeId])).files.length, 0);
});

test("verification consumes the checkpointed artifact classification across policy changes", async () => {
  const bytes = createMemoryDurableByteStore();
  const files = createMemoryFileArtifactStore(bytes);
  const source = delegate(() => [{ total: "42" }]);
  const initial = createEvidenceBackedFinanceService({
    delegate: source.service,
    files,
    evidenceBytes: bytes,
    artifactThresholdRows: 10,
  });
  const sourceContext = await withCustodiedQuery(initial, "SELECT total FROM invoice");
  const sourced = await initial.source({ planDigest: digest("plan") }, sourceContext);
  const artifact = await initial.artifact({ sourceDigest: sourced.sourceDigest }, context);
  const changed = createEvidenceBackedFinanceService({
    delegate: source.service,
    files,
    evidenceBytes: bytes,
    artifactThresholdRows: 0,
  });

  assert.equal(artifact.requirement, "optional");
  assert.equal(
    (await changed.verify({ sourceDigest: sourced.sourceDigest, requirement: artifact.requirement }, context)).passed,
    true,
  );
});

test("host produces a requested artifact below the row threshold", async () => {
  const evidenceBytes = createMemoryDurableByteStore();
  const artifactBytes = createMemoryDurableByteStore();
  const files = createMemoryFileArtifactStore(artifactBytes);
  const source = delegate(() => [{ total: "42" }]);
  const service = createEvidenceBackedFinanceService({ delegate: source.service, files, evidenceBytes });
  const sourceContext = await withCustodiedQuery(service, "SELECT total FROM invoice");

  const sourced = await service.source({ planDigest: digest("plan") }, sourceContext);
  const artifact = await service.artifact({ sourceDigest: sourced.sourceDigest, requirement: "required" }, context);

  assert.equal(artifact.requirement, "required");
  assert.ok(artifact.artifactDigest);
  const stored = await files.listOwnedByScopes([context.scopeId]);
  assert.equal(stored.files.length, 1);
  assert.equal(
    (
      await service.verify(
        {
          sourceDigest: sourced.sourceDigest,
          artifactDigest: artifact.artifactDigest,
          requirement: artifact.requirement,
        },
        context,
      )
    ).passed,
    true,
  );
  await artifactBytes.delete(stored.files[0]!.blobKey!);
  assert.equal(
    (
      await service.verify(
        {
          sourceDigest: sourced.sourceDigest,
          artifactDigest: artifact.artifactDigest,
          requirement: artifact.requirement,
        },
        context,
      )
    ).passed,
    false,
  );
});

test("independent repeat pull rejects changed finance rows", async () => {
  const bytes = createMemoryDurableByteStore();
  const files = createMemoryFileArtifactStore(bytes);
  const source = delegate((call) => [{ total: call === 1 ? "42" : "43" }]);
  const service = createEvidenceBackedFinanceService({ delegate: source.service, files, evidenceBytes: bytes });
  const sourceContext = await withCustodiedQuery(service, "SELECT total FROM invoice");

  const sourced = await service.source({ planDigest: digest("plan") }, sourceContext);
  const artifact = await service.artifact({ sourceDigest: sourced.sourceDigest }, context);
  const verified = await service.verify(
    { sourceDigest: sourced.sourceDigest, requirement: artifact.requirement },
    context,
  );

  assert.equal(artifact.requirement, "optional");
  assert.equal(verified.passed, false);
  assert.equal(source.sourceCalls(), 2);
});

test("host-selected numeric policy rejects repeatable but non-numeric finance evidence", async () => {
  const bytes = createMemoryDurableByteStore();
  const files = createMemoryFileArtifactStore(bytes);
  const source = delegate(() => [{ total: "not-a-number" }]);
  const service = createEvidenceBackedFinanceService({ delegate: source.service, files, evidenceBytes: bytes });
  const policyContext = { ...context, verificationPolicy: "single_numeric_total" } as FinanceExecutionContext;
  const sourceContext = await withCustodiedQuery(service, "SELECT total FROM invoice", policyContext);

  const sourced = await service.source({ planDigest: digest("plan") }, sourceContext);
  const artifact = await service.artifact({ sourceDigest: sourced.sourceDigest }, policyContext);
  const verified = await service.verify(
    { sourceDigest: sourced.sourceDigest, requirement: artifact.requirement },
    context,
  );

  assert.equal(verified.passed, false);
  assert.equal(source.sourceCalls(), 2);
});

test("host-selected debit-credit policy passes an exact journal tie-out", async () => {
  const bytes = createMemoryDurableByteStore();
  const files = createMemoryFileArtifactStore(bytes);
  const rows = [
    { debit: "0.10", credit: "0" },
    { debit: "0.20", credit: "0.30" },
  ];
  const source = delegate(() => rows);
  const service = createEvidenceBackedFinanceService({ delegate: source.service, files, evidenceBytes: bytes });
  const policyContext = { ...context, verificationPolicy: "balanced_debits_credits" } as FinanceExecutionContext;
  const sourceContext = await withCustodiedQuery(service, "SELECT debit, credit FROM transaction", policyContext);

  const sourced = await service.source({ planDigest: digest("plan") }, sourceContext);
  const artifact = await service.artifact({ sourceDigest: sourced.sourceDigest }, policyContext);
  const verified = await service.verify(
    { sourceDigest: sourced.sourceDigest, requirement: artifact.requirement },
    context,
  );

  assert.equal(verified.passed, true);
});

test("source execution loads the exact preflight query from private host custody", async () => {
  const bytes = createMemoryDurableByteStore();
  const files = createMemoryFileArtifactStore(bytes);
  const observedQueries: unknown[] = [];
  const base = delegate(() => [{ total: "42" }]).service;
  const capturing = {
    ...base,
    async source(input, sourceContext) {
      observedQueries.push(input.query);
      return base.source(input, sourceContext);
    },
  } as FinanceService;
  const service = createEvidenceBackedFinanceService({ delegate: capturing, files, evidenceBytes: bytes });
  const query = "SELECT total FROM invoice";
  const queryDigest = digest(`finny-query:v1:${query}`);

  await service.preflight({ request: "AP", clarificationDigest: digest("clarify"), query }, context);
  await service.source({ planDigest: digest("plan") }, {
    ...context,
    approvedQueryDigest: queryDigest,
  } as FinanceExecutionContext);

  assert.deepEqual(observedQueries, [query]);
});
