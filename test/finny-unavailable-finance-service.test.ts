import assert from "node:assert/strict";
import test from "node:test";

import { digestFinnyEvidence } from "../src/finny/golden-loop.ts";
import type { FinnyOperationPlan } from "../src/finny/operation-compiler.ts";
import { createUnavailableFinanceService } from "../src/finny/unavailable-finance-service.ts";

const digest = (value: string) => digestFinnyEvidence(value);
const plan: FinnyOperationPlan = {
  schema: "finny.operation_plan.v1",
  capabilityId: "reviewed-balance",
  revisionId: "reviewed-balance.2026-10-30",
  semanticCapability: "reviewed_balance",
  manifestDigest: digest("manifest"),
  catalogDigest: digest("catalog"),
  dimensions: {},
  dimensionsDigest: digest("dimensions"),
  parameterValues: {},
  operations: [
    {
      id: "source",
      primitive: "suiteql_select",
      dependsOn: [],
      sql: "SELECT balance FROM reviewed_source",
      parameters: [],
    },
  ],
  resultOperationId: "source",
  operationGraphDigest: digest("operation-graph"),
  artifactPolicy: { allowedFormats: ["json"], defaultFormat: "json", attachment: "when_requested" },
  artifactPolicyDigest: digest("artifact-policy"),
  approvalPolicy: { mode: "none", binds: ["capability_revision", "dimensions", "operation_graph"] },
  approvalPolicyDigest: digest("approval-policy"),
  verificationPolicy: { requiredOperationIds: [], releaseGate: "delivery_eligible" },
  verificationPolicyDigest: digest("verification-policy"),
  planDigest: digest("plan"),
};
const context = {
  runId: "run-unavailable",
  actorId: "actor-unavailable",
  scopeId: "personal:actor-unavailable",
  credentialHandles: [],
};

test("unavailable service blocks plan execution and source custody", async () => {
  const service = createUnavailableFinanceService();

  await assert.rejects(
    service.executeOperation(
      {
        plan,
        execution: { operation: plan.operations[0]!, dependencyResultSets: {}, dependencyDigests: {} },
      },
      context,
    ),
    /blocked_external.*operation/i,
  );
  await assert.rejects(service.sourcePlan({ plan }, context), /blocked_external.*source/i);
});
