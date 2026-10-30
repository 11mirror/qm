import assert from "node:assert/strict";
import test from "node:test";

import type { ServiceCredentialReader } from "../src/credentials/keychain.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import type { FinnyCapabilityDescriptor } from "../src/finny/capability-pack.ts";
import { createDefaultFinnyFinanceService } from "../src/finny/default-finance-service.ts";
import type { FinanceExecutionContext } from "../src/finny/finance.ts";
import {
  applyFinnyHostEvent,
  createFinnyGoldenLoop,
  digestFinnyEvidence,
  type FinnyHostEvent,
} from "../src/finny/golden-loop.ts";
import { compileFinnyOperationPlan } from "../src/finny/operation-compiler.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createFinnyRunStore, type FinnyRunV2Checkpoint } from "../src/finny/run-store.ts";

const digest = (value: string) => digestFinnyEvidence(value);

test("default Finny service brokers exact operation execution into durable v2 custody", async () => {
  const descriptor: FinnyCapabilityDescriptor = {
    schemaVersion: 1,
    capabilityId: "synthetic_default",
    revisionId: "synthetic_default.v1",
    semanticCapability: "synthetic_default",
    semanticAliases: [],
    dimensions: { required: [], supported: {}, defaults: {} },
    operations: [
      {
        id: "source",
        primitive: "suiteql_select",
        dependsOn: [],
        sql: "SELECT value FROM synthetic_default",
        parameters: [],
      },
      { id: "repeat", primitive: "repeat_pull", dependsOn: ["source"], operationId: "source" },
      {
        id: "reconcile",
        primitive: "reconcile",
        dependsOn: ["source", "repeat"],
        leftField: "value",
        rightField: "value",
        tolerance: "0",
      },
    ],
    resultOperationId: "source",
    parameterBindings: {},
    artifactPolicy: { allowedFormats: ["json"], defaultFormat: "json", attachment: "never" },
    approvalPolicy: { mode: "none", binds: ["capability_revision", "dimensions", "operation_graph"] },
    verificationPolicy: { requiredOperationIds: ["reconcile"], releaseGate: "delivery_eligible" },
  };
  const plan = compileFinnyOperationPlan({
    descriptor,
    manifestDigest: digest("manifest"),
    catalogDigest: digest("catalog"),
    semanticCapability: descriptor.semanticCapability,
    dimensions: {},
  });
  const context: FinanceExecutionContext = {
    runId: "run-default-plan",
    actorId: "actor-default",
    scopeId: "personal:actor-default",
    credentialHandles: [],
  };
  const runStore = createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>());
  await runStore.initialize({
    schema: "finny.run.v2",
    runId: context.runId,
    requestDigest: digest("request"),
    sessionId: "session-default",
    scopeId: context.scopeId,
    plan: {
      catalogDigest: plan.catalogDigest,
      capabilityId: plan.capabilityId,
      revisionId: plan.revisionId,
      operationGraphDigest: plan.operationGraphDigest,
      planDigest: plan.planDigest,
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
    event({
      eventId: "exempt",
      kind: "plan_exempted",
      planDigest: plan.planDigest,
      approvalPolicyDigest: plan.approvalPolicyDigest,
    }),
  );
  for (const metadata of state.ledger) await runStore.checkpoint(context.runId, metadata);
  const credentials: ServiceCredentialReader = {
    async getServiceCredentialSecret(_scope, slug) {
      return {
        slug,
        name: slug,
        secret: `${slug}-secret`,
        delivery: "broker",
        host: `${slug}.internal`,
        deployments: false,
        enabled: true,
      };
    },
  };
  const bytes = createMemoryDurableByteStore();
  let operationCalls = 0;
  const service = createDefaultFinnyFinanceService({
    credentialReader: credentials,
    orgScopeId: "org:test",
    files: createMemoryFileArtifactStore(bytes),
    evidenceBytes: bytes,
    runStore,
    atomicFetch: {
      async executeOperation() {
        operationCalls += 1;
        return { rows: [{ value: "42" }] };
      },
    },
  });

  const sourced = await service.sourcePlan({ plan }, context);
  const verified = await service.verify({ sourceDigest: sourced.sourceDigest, requirement: "optional" }, context);

  assert.deepEqual(sourced.records, [{ value: "42" }]);
  assert.equal(operationCalls, 2);
  assert.equal(verified.passed, true);
});
