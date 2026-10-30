import assert from "node:assert/strict";
import test from "node:test";

import { digestFinnyEvidence } from "../src/finny/golden-loop.ts";
import type { FinnyOperationPlan } from "../src/finny/operation-compiler.ts";
import { createFinnyAtomicFetchAdapter, createFinnyNetSuiteOperationExecutor } from "../src/finny/provider-adapter.ts";

const digest = (value: string) => digestFinnyEvidence(value);
const credential = {
  accountId: "account",
  consumerKey: "consumer",
  consumerSecret: "consumer-secret",
  tokenId: "token",
  tokenSecret: "token-secret",
};

function plan(): FinnyOperationPlan {
  return {
    schema: "finny.operation_plan.v1",
    capabilityId: "multi",
    revisionId: "multi.v1",
    semanticCapability: "multi",
    manifestDigest: digest("manifest"),
    catalogDigest: digest("catalog"),
    dimensions: {},
    dimensionsDigest: digest("dimensions"),
    parameterValues: {},
    operations: [
      { id: "first", primitive: "suiteql_select", dependsOn: [], sql: "SELECT first FROM one", parameters: [] },
      { id: "second", primitive: "suiteql_select", dependsOn: [], sql: "SELECT second FROM two", parameters: [] },
      { id: "repeat", primitive: "repeat_pull", dependsOn: ["second"], operationId: "second" },
    ],
    resultOperationId: "second",
    operationGraphDigest: digest("graph"),
    artifactPolicy: { allowedFormats: ["json"], defaultFormat: "json", attachment: "never" },
    artifactPolicyDigest: digest("artifact"),
    approvalPolicy: { mode: "before_source", binds: ["capability_revision", "dimensions", "operation_graph"] },
    approvalPolicyDigest: digest("approval"),
    verificationPolicy: { requiredOperationIds: ["repeat"], releaseGate: "delivery_eligible" },
    verificationPolicyDigest: digest("verification"),
    planDigest: digest("plan"),
  };
}

test("plan preflight binds reviewed authority without a query bridge", async () => {
  const operationPlan = plan();
  const adapter = createFinnyAtomicFetchAdapter({
    hindsight: { recall: async () => ({ matched: true }) },
    netsuite: { suiteql: async () => [] },
  });
  const output = await adapter.preflightPlan(
    { request: "second", clarificationDigest: digest("clarify"), plan: operationPlan },
    { runId: "run", actorId: "actor" },
    { hindsight: JSON.stringify({ apiUrl: "https://hindsight.test", apiKey: "key", bankIds: ["bank"] }) },
  );

  assert.equal(output.approvalPolicyDigest, operationPlan.approvalPolicyDigest);
  assert.equal(output.approvalRequired, true);
  assert.equal("query" in output, false);
});

test("operation executor runs the exact requested SuiteQL node", async () => {
  const operationPlan = plan();
  const queries: string[] = [];
  const execute = createFinnyNetSuiteOperationExecutor({
    plan: operationPlan,
    credential,
    client: {
      async suiteql(query) {
        queries.push(query);
        return [{ value: 2 }];
      },
    },
  });
  const rows = await execute({
    operation: operationPlan.operations[1]!,
    dependencyResultSets: {},
    dependencyDigests: {},
  });

  assert.deepEqual(queries, ["SELECT second FROM two"]);
  assert.deepEqual(rows, [{ value: 2 }]);
});

test("repeat pulls execute their reviewed SuiteQL source fresh", async () => {
  const operationPlan = plan();
  const queries: string[] = [];
  const execute = createFinnyNetSuiteOperationExecutor({
    plan: operationPlan,
    credential,
    client: {
      async suiteql(query) {
        queries.push(query);
        return [{ value: 3 }];
      },
    },
  });
  await execute({
    operation: operationPlan.operations[2]!,
    dependencyResultSets: { second: [{ value: 2 }] },
    dependencyDigests: { second: digest("second-result") },
  });

  assert.deepEqual(queries, ["SELECT second FROM two"]);
});

test("operation executor rejects forged and derived external work", async () => {
  const operationPlan = plan();
  const execute = createFinnyNetSuiteOperationExecutor({
    plan: operationPlan,
    credential,
    client: { suiteql: async () => [] },
  });
  await assert.rejects(
    execute({
      operation: {
        id: "second",
        primitive: "suiteql_select",
        dependsOn: [],
        sql: "SELECT secret FROM forbidden",
        parameters: [],
      },
      dependencyResultSets: {},
      dependencyDigests: {},
    }),
    /does not match/i,
  );
  await assert.rejects(
    execute({
      operation: {
        id: "derived",
        primitive: "reconcile",
        dependsOn: ["second"],
        leftField: "value",
        rightField: "value",
        tolerance: "0",
      },
      dependencyResultSets: { second: [] },
      dependencyDigests: { second: digest("second-result") },
    }),
    /does not belong/i,
  );
});

test("invalid optional Hindsight configuration is omitted without touching NetSuite", async () => {
  let hindsightCalls = 0;
  let netsuiteCalls = 0;
  const operationPlan = plan();
  const adapter = createFinnyAtomicFetchAdapter({
    hindsight: {
      async recall() {
        hindsightCalls += 1;
        return {};
      },
    },
    netsuite: {
      async suiteql() {
        netsuiteCalls += 1;
        return [];
      },
    },
  });
  const output = await adapter.preflightPlan(
    { request: "second", clarificationDigest: digest("clarify"), plan: operationPlan },
    { runId: "run", actorId: "actor" },
    { hindsight: JSON.stringify({ apiUrl: "http://insecure.test", apiKey: "key", bankIds: ["bank"] }) },
  );

  assert.equal(output.enrichment?.state, "omitted");
  assert.equal(hindsightCalls, 0);
  assert.equal(netsuiteCalls, 0);
});
