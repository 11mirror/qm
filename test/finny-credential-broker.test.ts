import assert from "node:assert/strict";
import test from "node:test";

import type { ServiceCredentialReader } from "../src/credentials/keychain.ts";
import { createBrokeredFinanceService } from "../src/finny/credential-brokered-finance-service.ts";
import type { FinanceService } from "../src/finny/finance.ts";
import { digestFinnyEvidence } from "../src/finny/golden-loop.ts";
import type { FinnyOperationPlan } from "../src/finny/operation-compiler.ts";
import { createFinnyAtomicFetchAdapter } from "../src/finny/provider-adapter.ts";

const digest = (value: string) => digestFinnyEvidence(value);
const context = { runId: "run-1", actorId: "actor-1", scopeId: "personal:actor-1", credentialHandles: [] };

function plan(): FinnyOperationPlan {
  return {
    schema: "finny.operation_plan.v1",
    capabilityId: "multi-source",
    revisionId: "multi-source.2026-10-30",
    semanticCapability: "multi_source",
    manifestDigest: digest("manifest"),
    catalogDigest: digest("catalog"),
    dimensions: {},
    dimensionsDigest: digest("dimensions"),
    parameterValues: {},
    operations: [
      { id: "source", primitive: "suiteql_select", dependsOn: [], sql: "SELECT value FROM source", parameters: [] },
      { id: "repeat", primitive: "repeat_pull", dependsOn: ["source"], operationId: "source" },
    ],
    resultOperationId: "source",
    operationGraphDigest: digest("graph"),
    artifactPolicy: { allowedFormats: ["json"], defaultFormat: "json", attachment: "never" },
    artifactPolicyDigest: digest("artifact"),
    approvalPolicy: { mode: "none", binds: ["capability_revision", "dimensions", "operation_graph"] },
    approvalPolicyDigest: digest("approval"),
    verificationPolicy: { requiredOperationIds: ["repeat"], releaseGate: "delivery_eligible" },
    verificationPolicyDigest: digest("verification"),
    planDigest: digest("plan"),
  };
}

function delegate(sourcePlan?: FinanceService["sourcePlan"]): FinanceService {
  return {
    async clarify() {
      return { clarification: "scope", evidenceDigest: digest("clarify") };
    },
    async preflightPlan() {
      throw new Error("broker owns preflight");
    },
    async executeOperation() {
      throw new Error("broker owns execution");
    },
    sourcePlan: sourcePlan ?? (async () => ({ records: [], sourceDigest: digest("source") })),
    async recoverSource() {
      return { records: [] };
    },
    async artifact() {
      return { requirement: "optional", policyDigest: digest("artifact") };
    },
    async verify() {
      return { passed: true, verificationDigest: digest("verified") };
    },
  };
}

function reader(values: Record<string, string>): ServiceCredentialReader {
  return {
    async getServiceCredentialSecret(_scope, slug) {
      const secret = values[slug];
      return secret
        ? { slug, name: slug, secret, delivery: "broker", host: `${slug}.internal`, deployments: false, enabled: true }
        : null;
    },
  };
}

function broker(options: {
  reader: ServiceCredentialReader;
  delegate?: FinanceService;
  rows?: readonly Readonly<Record<string, unknown>>[];
}) {
  return createBrokeredFinanceService({
    delegate: options.delegate ?? delegate(),
    credentialReader: options.reader,
    orgScopeId: "org:test",
    credentialSlugs: { netsuite: "finny-netsuite" },
    atomicFetch: {
      async executeOperation() {
        return { rows: options.rows ?? [{ value: 42 }] };
      },
    },
  });
}

test("broker preflight stays local and reads credentials only for exact plan nodes", async () => {
  const operationPlan = plan();
  const queries: string[] = [];
  const reads: string[] = [];
  const stored = reader({
    "finny-hindsight": "hs-secret",
    "finny-netsuite": JSON.stringify({
      accountId: "account-id",
      consumerKey: "consumer-key",
      consumerSecret: "consumer-secret",
      tokenId: "token-id",
      tokenSecret: "token-secret",
    }),
  });
  const service = createBrokeredFinanceService({
    delegate: delegate(),
    credentialReader: {
      async getServiceCredentialSecret(scope, slug) {
        reads.push(slug);
        return stored.getServiceCredentialSecret(scope, slug);
      },
    },
    orgScopeId: "org:test",
    credentialSlugs: { netsuite: "finny-netsuite" },
    atomicFetch: createFinnyAtomicFetchAdapter({
      netsuite: {
        async suiteql(query, credential) {
          queries.push(query);
          assert.equal(credential.consumerSecret, "consumer-secret");
          return [{ pull: queries.length }];
        },
      },
    }),
  });
  const source = operationPlan.operations[0]!;
  const repeat = operationPlan.operations[1]!;
  const preflight = await service.preflightPlan(
    { request: "source", clarificationDigest: digest("clarify"), plan: operationPlan },
    context,
  );
  const first = await service.executeOperation(
    { plan: operationPlan, execution: { operation: source, dependencyResultSets: {}, dependencyDigests: {} } },
    context,
  );
  const repeated = await service.executeOperation(
    {
      plan: operationPlan,
      execution: {
        operation: repeat,
        dependencyResultSets: { source: first.rows },
        dependencyDigests: { source: digest("result") },
      },
    },
    context,
  );

  assert.deepEqual(reads, ["finny-netsuite", "finny-netsuite"]);
  assert.deepEqual(queries, ["SELECT value FROM source", "SELECT value FROM source"]);
  assert.equal(JSON.stringify({ preflight, first, repeated }).includes("secret"), false);
});

test("NetSuite is required only at external execution", async () => {
  const operationPlan = plan();
  const service = broker({ reader: reader({}) });
  await service.preflightPlan(
    { request: "balance", clarificationDigest: digest("clarify"), plan: operationPlan },
    context,
  );
  await assert.rejects(
    service.executeOperation(
      {
        plan: operationPlan,
        execution: { operation: operationPlan.operations[0]!, dependencyResultSets: {}, dependencyDigests: {} },
      },
      context,
    ),
    /credential.*finny-netsuite/i,
  );
});

test("v2 source custody delegates without reading credentials", async () => {
  const operationPlan = plan();
  const service = broker({
    reader: {
      async getServiceCredentialSecret() {
        throw new Error("unexpected credential read");
      },
    },
    delegate: delegate(async (input) => {
      assert.equal(input.plan, operationPlan);
      return { records: [{ total: 42 }], sourceDigest: digest("source") };
    }),
  });
  assert.deepEqual(await service.sourcePlan({ plan: operationPlan }, context), {
    records: [{ total: 42 }],
    sourceDigest: digest("source"),
  });
});

test("credential fragments cannot escape plan outputs", async () => {
  const operationPlan = plan();
  const credentials = reader({ "finny-hindsight": "hs-secret", "finny-netsuite": "ns-secret" });
  await assert.rejects(
    broker({ reader: credentials, rows: [{ leaked: "ns-secret" }] }).executeOperation(
      {
        plan: operationPlan,
        execution: { operation: operationPlan.operations[0]!, dependencyResultSets: {}, dependencyDigests: {} },
      },
      context,
    ),
    /credential boundary/i,
  );
});
