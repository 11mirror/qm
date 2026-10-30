import assert from "node:assert/strict";
import test from "node:test";

import type { ServiceCredentialReader } from "../src/credentials/keychain.ts";
import type { AtomicFetchAdapter } from "../src/finny/credential-brokered-finance-service.ts";
import { createDefaultFinnyFinanceService } from "../src/finny/default-finance-service.ts";
import type { FinanceExecutionContext } from "../src/finny/finance.ts";
import {
  applyFinnyHostEvent,
  createFinnyGoldenLoop,
  digestFinnyEvidence,
  type FinnyHostEvent,
} from "../src/finny/golden-loop.ts";
import { FINNY_AP_GL_CONTROL_BALANCE_QUERY } from "../src/finny/reviewed-query.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import type { FinnyCapabilityDescriptor } from "../src/finny/capability-pack.ts";
import { compileFinnyOperationPlan } from "../src/finny/operation-compiler.ts";
import { createFinnyRunStore, type FinnyRunV2Checkpoint } from "../src/finny/run-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const digest = (value: string) => digestFinnyEvidence(value);

test("default Finny service passes durable v2 custody through plan-native source execution", async () => {
  const descriptor: FinnyCapabilityDescriptor = {
    schemaVersion: 1,
    capabilityId: "synthetic_default",
    revisionId: "synthetic_default.v1",
    semanticCapability: "synthetic_default",
    semanticAliases: [],
    dimensions: { required: [], supported: {}, defaults: {} },
    operations: [
      {
        id: "synthetic_source",
        primitive: "suiteql_select",
        dependsOn: [],
        sql: "SELECT value FROM synthetic_default",
        parameters: [],
      },
    ],
    resultOperationId: "synthetic_source",
    parameterBindings: {},
    artifactPolicy: { allowedFormats: ["json"], defaultFormat: "json", attachment: "never" },
    approvalPolicy: { mode: "none", binds: ["capability_revision", "dimensions", "operation_graph"] },
    verificationPolicy: { requiredOperationIds: [], releaseGate: "delivery_eligible" },
  };
  const plan = compileFinnyOperationPlan({
    descriptor,
    manifestDigest: digest("default-manifest"),
    catalogDigest: digest("default-catalog"),
    semanticCapability: "synthetic_default",
    dimensions: {},
  });
  const context: FinanceExecutionContext = {
    runId: "run-default-plan",
    actorId: "actor-default",
    scopeId: "personal:actor-default",
    credentialHandles: [],
  };
  const runStore = createFinnyRunStore<FinnyRunV2Checkpoint>(createMemoryMap<FinnyRunV2Checkpoint>());
  await runStore.initialize({
    schema: "finny.run.v2",
    runId: context.runId,
    requestDigest: digest("default-request"),
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
    event({ eventId: "default:clarify", kind: "clarify_completed", evidenceDigest: digest("clarify") }),
  );
  state = applyFinnyHostEvent(
    state,
    event({
      eventId: "default:preflight",
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
      eventId: "default:exempted",
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
  let operationCalls = 0;
  let legacyCalls = 0;
  const bytes = createMemoryDurableByteStore();
  const service = createDefaultFinnyFinanceService({
    credentialReader: credentials,
    orgScopeId: "org:test",
    files: createMemoryFileArtifactStore(bytes),
    evidenceBytes: bytes,
    runStore,
    atomicFetch: {
      async preflight() {
        throw new Error("legacy preflight must not run");
      },
      async source() {
        legacyCalls += 1;
        throw new Error("legacy source must not run");
      },
      async executeOperation() {
        operationCalls += 1;
        return { rows: [{ value: "reviewed" }] };
      },
    },
  });

  const sourced = await service.sourcePlan!({ plan }, context);

  assert.deepEqual(sourced.records, [{ value: "reviewed" }]);
  assert.equal(operationCalls, 1);
  assert.equal(legacyCalls, 0);
});

test("default Finny service composes credential brokering with durable host evidence", async () => {
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
  let sourceCalls = 0;
  const sourceQueries: string[] = [];
  const atomicFetch: AtomicFetchAdapter = {
    async preflight(input) {
      assert.equal(input.query, FINNY_AP_GL_CONTROL_BALANCE_QUERY);
      return {
        planSummary: "read-only",
        preflightDigest: digest("preflight"),
        planDigest: digest("plan"),
      };
    },
    async source(input) {
      sourceCalls += 1;
      sourceQueries.push(input.query ?? "");
      return {
        records: Array.from({ length: 11 }, (_, index) => ({ id: index + 1 })),
        sourceDigest: digest(`upstream-${sourceCalls}`),
      };
    },
  };
  const bytes = createMemoryDurableByteStore();
  const service = createDefaultFinnyFinanceService({
    credentialReader: credentials,
    orgScopeId: "org:test",
    files: createMemoryFileArtifactStore(bytes),
    evidenceBytes: bytes,
    atomicFetch,
  });
  const context: FinanceExecutionContext = {
    runId: "run-default",
    actorId: "actor-default",
    scopeId: "personal:actor-default",
    credentialHandles: [],
  };

  const clarified = await service.clarify({ request: "AP balance" }, context);
  const preflight = await service.preflight(
    {
      request: "AP balance",
      clarificationDigest: clarified.evidenceDigest,
      query: FINNY_AP_GL_CONTROL_BALANCE_QUERY,
    },
    context,
  );
  const planned = await service.plan({ planDigest: preflight.planDigest }, context);
  const sourced = await service.source(
    { planDigest: preflight.planDigest },
    { ...context, approvedQueryDigest: preflight.queryDigest },
  );
  const artifact = await service.artifact({ sourceDigest: sourced.sourceDigest }, context);
  const verified = await service.verify(
    {
      sourceDigest: sourced.sourceDigest,
      artifactDigest: artifact.artifactDigest,
      requirement: artifact.requirement,
    },
    context,
  );

  assert.equal(planned.decision, "approved");
  assert.equal(artifact.requirement, "required");
  assert.equal(verified.passed, true);
  assert.equal(sourceCalls, 2);
  assert.deepEqual(sourceQueries, [FINNY_AP_GL_CONTROL_BALANCE_QUERY, FINNY_AP_GL_CONTROL_BALANCE_QUERY]);
});

test("default Finny service preserves the exact host-compiled query for non-AP capabilities", async () => {
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
  const reviewedQuery =
    "SELECT total FROM reviewed_open_ar WHERE subsidiary_id = 7 AND cutoff_date = DATE '2025-09-15'";
  const observedQueries: string[] = [];
  const bytes = createMemoryDurableByteStore();
  const service = createDefaultFinnyFinanceService({
    credentialReader: credentials,
    orgScopeId: "org:test",
    files: createMemoryFileArtifactStore(bytes),
    evidenceBytes: bytes,
    atomicFetch: {
      async preflight(input) {
        observedQueries.push(input.query);
        return {
          planSummary: "read-only open AR",
          preflightDigest: digest("ar-preflight"),
          planDigest: digest("ar-plan"),
        };
      },
      async source() {
        throw new Error("source is outside this preflight test");
      },
    },
  });

  await service.preflight(
    {
      request: "open AR for Example Manufacturing as at 15-Sep-2025",
      clarificationDigest: digest("clarify"),
      query: reviewedQuery,
    },
    {
      runId: "run-ar-preflight",
      actorId: "actor-default",
      scopeId: "personal:actor-default",
      credentialHandles: [],
    },
  );

  assert.deepEqual(observedQueries, [reviewedQuery]);
});
