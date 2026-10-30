import assert from "node:assert/strict";
import test from "node:test";

import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createKeychain, type KeychainCredential, type ServiceCredentialReader } from "../src/credentials/keychain.ts";
import {
  createBrokeredFinanceService,
  type AtomicFetchAdapter,
} from "../src/finny/credential-brokered-finance-service.ts";
import { createFinnyAtomicFetchAdapter } from "../src/finny/provider-adapter.ts";
import type { FinanceService } from "../src/finny/finance.ts";
import { FinanceFailure } from "../src/finny/finance-failure.ts";
import { digestFinnyEvidence } from "../src/finny/golden-loop.ts";
import { createFinnyNetSuiteClient } from "../src/finny/provider-clients.ts";
import { FINNY_AP_GL_CONTROL_BALANCE_QUERY } from "../src/finny/reviewed-query.ts";
import type { FinnyOperationPlan } from "../src/finny/operation-compiler.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";

const digest = (value: string) => digestFinnyEvidence(value);
const context = {
  runId: "run-1",
  actorId: "actor-1",
  scopeId: "personal:actor-1",
  credentialHandles: ["unrelated-personal-handle"],
};

function operationPlan(): FinnyOperationPlan {
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
      {
        id: "first_source",
        primitive: "suiteql_select",
        dependsOn: [],
        sql: "SELECT first_value FROM first_table",
        parameters: [],
      },
      {
        id: "second_source",
        primitive: "suiteql_select",
        dependsOn: [],
        sql: "SELECT second_value FROM second_table",
        parameters: [],
      },
      {
        id: "second_repeat",
        primitive: "repeat_pull",
        dependsOn: ["second_source"],
        operationId: "second_source",
      },
    ],
    resultOperationId: "second_source",
    operationGraphDigest: digest("operation-graph"),
    artifactPolicy: { allowedFormats: ["json"], defaultFormat: "json", attachment: "when_requested" },
    artifactPolicyDigest: digest("artifact-policy"),
    approvalPolicy: { mode: "none", binds: ["capability_revision", "dimensions", "operation_graph"] },
    approvalPolicyDigest: digest("approval-policy"),
    verificationPolicy: { requiredOperationIds: ["second_repeat"], releaseGate: "delivery_eligible" },
    verificationPolicyDigest: digest("verification-policy"),
    planDigest: digest("operation-plan"),
  };
}

function delegate(): FinanceService {
  return {
    async clarify() {
      return { clarification: "scope", evidenceDigest: digest("clarify") };
    },
    async preflight() {
      throw new Error("broker must own atomic preflight");
    },
    async plan() {
      return { decision: "exempt", approvalPolicyDigest: digest("policy") };
    },
    async source() {
      throw new Error("broker must own source fetch");
    },
    async artifact() {
      return { requirement: "optional", policyDigest: digest("artifact-policy") };
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
        ? {
            slug,
            name: slug,
            secret,
            delivery: "broker",
            host: `${slug}.internal`,
            deployments: false,
            enabled: true,
          }
        : null;
    },
  };
}

test("plan-native broker keeps credentials opaque and routes exact SuiteQL and repeat pulls", async () => {
  const plan = operationPlan();
  const queries: string[] = [];
  const credentialReads: string[] = [];
  const netsuiteBundle = JSON.stringify({
    accountId: "account-id",
    consumerKey: "consumer-key",
    consumerSecret: "consumer-secret",
    tokenId: "token-id",
    tokenSecret: "token-secret",
  });
  const stored = reader({ "finny-hindsight": "hs-secret", "finny-netsuite": netsuiteBundle });
  const service = createBrokeredFinanceService({
    delegate: delegate(),
    credentialReader: {
      async getServiceCredentialSecret(scope, slug) {
        credentialReads.push(slug);
        return stored.getServiceCredentialSecret(scope, slug);
      },
    },
    orgScopeId: "org:test",
    credentialSlugs: { hindsight: "finny-hindsight", netsuite: "finny-netsuite" },
    atomicFetch: createFinnyAtomicFetchAdapter({
      hindsight: { recall: async () => ({ reviewed: true }) },
      netsuite: {
        async suiteql(query, credential) {
          queries.push(query);
          assert.equal(credential.consumerSecret, "consumer-secret");
          return [{ pull: queries.length }];
        },
      },
    }),
  });
  const second = plan.operations[1]!;
  const repeat = plan.operations[2]!;

  const preflight = await service.preflightPlan!(
    { request: "second source", clarificationDigest: digest("clarify"), plan },
    context,
  );
  const source = await service.executeOperation!(
    { plan, execution: { operation: second, dependencyResultSets: {}, dependencyDigests: {} } },
    context,
  );
  const repeated = await service.executeOperation!(
    {
      plan,
      execution: {
        operation: repeat,
        dependencyResultSets: { second_source: source.rows },
        dependencyDigests: { second_source: digest("source-result") },
      },
    },
    context,
  );

  assert.deepEqual(credentialReads, ["finny-hindsight", "finny-netsuite", "finny-netsuite"]);
  assert.deepEqual(queries, ["SELECT second_value FROM second_table", "SELECT second_value FROM second_table"]);
  assert.deepEqual(source.rows, [{ pull: 1 }]);
  assert.deepEqual(repeated.rows, [{ pull: 2 }]);
  assert.equal(JSON.stringify({ preflight, source, repeated }).includes("secret"), false);
});

test("plan-native broker fails closed without adapter methods and never invents a query bridge", async () => {
  const plan = operationPlan();
  const input = { request: "second source", clarificationDigest: digest("clarify"), plan };
  const service = createBrokeredFinanceService({
    delegate: delegate(),
    credentialReader: reader({}),
    orgScopeId: "org:test",
    credentialSlugs: { hindsight: "finny-hindsight", netsuite: "finny-netsuite" },
    atomicFetch: {
      async preflight() {
        throw new Error("legacy preflight must not run");
      },
      async source() {
        throw new Error("legacy source must not run");
      },
    },
  });
  await assert.rejects(service.preflightPlan!(input, context), /blocked_external.*plan preflight/i);
  await assert.rejects(
    service.executeOperation!(
      {
        plan,
        execution: { operation: plan.operations[1]!, dependencyResultSets: {}, dependencyDigests: {} },
      },
      context,
    ),
    /blocked_external.*operation execution/i,
  );
  await assert.rejects(service.sourcePlan!({ plan }, context), /blocked_external.*source custody/i);
  assert.equal("query" in input, false);
});

test("plan-native broker rejects credential fragments in adapter outputs", async () => {
  const plan = operationPlan();
  const service = createBrokeredFinanceService({
    delegate: delegate(),
    credentialReader: reader({ "finny-hindsight": "hs-secret", "finny-netsuite": "ns-secret" }),
    orgScopeId: "org:test",
    credentialSlugs: { hindsight: "finny-hindsight", netsuite: "finny-netsuite" },
    atomicFetch: {
      async preflight() {
        throw new Error("unused");
      },
      async source() {
        throw new Error("unused");
      },
      async preflightPlan() {
        return {
          planSummary: "hs-secret",
          preflightDigest: digest("preflight"),
          approvalRequired: false,
          approvalPolicyDigest: digest("policy"),
        };
      },
      async executeOperation() {
        return { rows: [{ leaked: "ns-secret" }] };
      },
    },
  });

  await assert.rejects(
    service.preflightPlan!({ request: "balance", clarificationDigest: digest("clarify"), plan }, context),
    /credential boundary/i,
  );
  await assert.rejects(
    service.executeOperation!(
      {
        plan,
        execution: { operation: plan.operations[1]!, dependencyResultSets: {}, dependencyDigests: {} },
      },
      context,
    ),
    /credential boundary/i,
  );
});

test("plan-native broker delegates source custody without reading credentials", async () => {
  const plan = operationPlan();
  const service = createBrokeredFinanceService({
    delegate: {
      ...delegate(),
      async sourcePlan(input) {
        assert.equal(input.plan, plan);
        return { records: [{ total: 42 }], sourceDigest: digest("source-plan") };
      },
    },
    credentialReader: {
      async getServiceCredentialSecret() {
        throw new Error("source custody must not read credentials");
      },
    },
    orgScopeId: "org:test",
    credentialSlugs: { hindsight: "finny-hindsight", netsuite: "finny-netsuite" },
    atomicFetch: {
      async preflight() {
        throw new Error("unused");
      },
      async source() {
        throw new Error("unused");
      },
    },
  });

  assert.deepEqual(await service.sourcePlan!({ plan }, context), {
    records: [{ total: 42 }],
    sourceDigest: digest("source-plan"),
  });
});

test("atomic fetch treats Hindsight as advisory while keeping NetSuite required", async () => {
  const calls: string[] = [];
  const adapter: AtomicFetchAdapter = {
    async preflight(input, safeContext, secrets) {
      calls.push(`preflight:${secrets.hindsight}:${safeContext.runId}`);
      assert.equal("netsuite" in secrets, false);
      return {
        planSummary: `read-only ${input.request}`,
        preflightDigest: digest("preflight"),
        planDigest: digest("plan"),
        approvalRequired: false,
        approvalPolicyDigest: digest("policy"),
      };
    },
    async source(_input, safeContext, secrets) {
      calls.push(`source:${secrets.hindsight}:${secrets.netsuite}:${safeContext.actorId}`);
      return { records: [{ total: 42 }], sourceDigest: digest("source") };
    },
  };
  const service = createBrokeredFinanceService({
    delegate: delegate(),
    credentialReader: reader({ "finny-hindsight": "hs-secret", "finny-netsuite": "ns-secret" }),
    orgScopeId: "org:test",
    credentialSlugs: { hindsight: "finny-hindsight", netsuite: "finny-netsuite" },
    atomicFetch: adapter,
  });

  await service.preflight(
    { request: "AP balance", clarificationDigest: digest("clarify"), query: "SELECT id FROM invoice" },
    context,
  );
  await service.source({ planDigest: digest("plan"), query: "SELECT" }, context);

  assert.deepEqual(calls, ["preflight:hs-secret:run-1", "source:hs-secret:ns-secret:actor-1"]);
});

test("missing Hindsight continues direct-source work without inventing a credential", async () => {
  const calls: Array<{ operation: string; hindsight: string | undefined; netsuite?: string }> = [];
  const service = createBrokeredFinanceService({
    delegate: delegate(),
    credentialReader: reader({ "finny-netsuite": "ns-secret" }),
    orgScopeId: "org:test",
    credentialSlugs: { hindsight: "finny-hindsight", netsuite: "finny-netsuite" },
    atomicFetch: {
      async preflight(_input, _context, credentials) {
        calls.push({ operation: "preflight", hindsight: credentials.hindsight });
        return {
          planSummary: "direct source; enrichment omitted",
          preflightDigest: digest("preflight"),
          planDigest: digest("plan"),
        };
      },
      async source(_input, _context, credentials) {
        calls.push({
          operation: "source",
          hindsight: credentials.hindsight,
          netsuite: credentials.netsuite,
        });
        return { records: [], sourceDigest: digest("source") };
      },
    },
  });

  await service.preflight(
    { request: "AP", clarificationDigest: digest("clarify"), query: "SELECT id FROM invoice" },
    context,
  );
  await service.source({ planDigest: digest("plan"), query: "SELECT id FROM invoice" }, context);

  assert.deepEqual(calls, [
    { operation: "preflight", hindsight: undefined },
    { operation: "source", hindsight: undefined, netsuite: "ns-secret" },
  ]);
});

test("missing NetSuite fails closed before the source adapter call", async () => {
  let called = false;
  const service = createBrokeredFinanceService({
    delegate: delegate(),
    credentialReader: reader({ "finny-hindsight": "hs-secret" }),
    orgScopeId: "org:test",
    credentialSlugs: { hindsight: "finny-hindsight", netsuite: "finny-netsuite" },
    atomicFetch: {
      async preflight() {
        throw new Error("unused");
      },
      async source() {
        called = true;
        throw new Error("unreachable");
      },
    },
  });

  await assert.rejects(
    service.source({ planDigest: digest("plan"), query: "SELECT id FROM invoice" }, context),
    /blocked_external.*finny-netsuite/,
  );
  assert.equal(called, false);
});

test("a stable connector key keeps the NetSuite credential usable after restart", async () => {
  const credentials = createMemoryMap<KeychainCredential>();
  const key = deriveConnectorKey("stable-finny-connector-key-0123456789");
  const createStore = () =>
    createKeychain({
      creds: credentials,
      grants: createMemoryMap(),
      asks: createMemoryMap(),
      key,
      lock: createMemoryAdvisoryLock(),
    });
  await createStore().setServiceCredential(scopeId("org", "test"), {
    slug: "finny-netsuite",
    name: "Finny NetSuite",
    secret: "restart-safe-netsuite-secret",
    host: "example.suitetalk.api.netsuite.com",
  });
  let observedSecret: string | undefined;
  const service = createBrokeredFinanceService({
    delegate: delegate(),
    credentialReader: createStore(),
    orgScopeId: scopeId("org", "test"),
    credentialSlugs: { hindsight: "finny-hindsight", netsuite: "finny-netsuite" },
    atomicFetch: {
      async preflight() {
        throw new Error("unused");
      },
      async source(_input, _context, secrets) {
        observedSecret = secrets.netsuite;
        return { records: [], sourceDigest: digest("source") };
      },
    },
  });

  await service.source({ planDigest: digest("plan") }, context);

  assert.equal(observedSecret, "restart-safe-netsuite-secret");
});

test("credential values cannot escape through adapter results or errors", async () => {
  const secret = "do-not-leak-this-value";
  const create = (adapter: AtomicFetchAdapter) =>
    createBrokeredFinanceService({
      delegate: delegate(),
      credentialReader: reader({ "finny-hindsight": secret, "finny-netsuite": "ns-secret" }),
      orgScopeId: "org:test",
      credentialSlugs: { hindsight: "finny-hindsight", netsuite: "finny-netsuite" },
      atomicFetch: adapter,
    });

  const leakedResult = create({
    async preflight() {
      return {
        planSummary: secret,
        preflightDigest: digest("preflight"),
        planDigest: digest("plan"),
      };
    },
    async source() {
      throw new Error("unused");
    },
  });
  await assert.rejects(
    leakedResult.preflight(
      { request: "AP", clarificationDigest: digest("clarify"), query: "SELECT id FROM invoice" },
      context,
    ),
    /blocked_external: credential boundary rejected adapter output/,
  );

  const leakedError = create({
    async preflight() {
      throw new Error(`upstream included ${secret}`);
    },
    async source() {
      throw new Error("unused");
    },
  });
  await assert.rejects(
    leakedError.preflight(
      { request: "AP", clarificationDigest: digest("clarify"), query: "SELECT id FROM invoice" },
      context,
    ),
    (error: Error) =>
      !error.message.includes(secret) && /blocked_external: atomic preflight failed/.test(error.message),
  );
});

test("sensitive fields inside JSON credential bundles cannot escape through adapter results", async () => {
  const apiKey = "hindsight-api-key-value";
  const bundle = JSON.stringify({
    apiUrl: "https://hindsight.internal",
    apiKey,
    bankIds: ["bank-1"],
  });
  const service = createBrokeredFinanceService({
    delegate: delegate(),
    credentialReader: reader({ "finny-hindsight": bundle }),
    orgScopeId: "org:test",
    credentialSlugs: { hindsight: "finny-hindsight", netsuite: "finny-netsuite" },
    atomicFetch: {
      async preflight() {
        return {
          planSummary: `upstream echoed ${apiKey}`,
          preflightDigest: digest("preflight"),
          planDigest: digest("plan"),
        };
      },
      async source() {
        throw new Error("unused");
      },
    },
  });

  await assert.rejects(
    service.preflight(
      { request: "AP", clarificationDigest: digest("clarify"), query: "SELECT id FROM invoice" },
      context,
    ),
    /blocked_external: credential boundary rejected adapter output/,
  );
});

test("brokered finance preserves typed provider failures and records safe diagnostics", async () => {
  const diagnostics: unknown[] = [];
  const service = createBrokeredFinanceService({
    delegate: delegate(),
    credentialReader: reader({ "finny-hindsight": "hs-secret" }),
    orgScopeId: "org:test",
    credentialSlugs: { hindsight: "finny-hindsight", netsuite: "finny-netsuite" },
    diagnostics: { record: (event: unknown) => diagnostics.push(event) },
    atomicFetch: {
      async preflight() {
        throw new FinanceFailure("provider_auth", {
          retryable: false,
          dependency: "hindsight",
          diagnosticId: "diag-provider-auth",
        });
      },
      async source() {
        throw new Error("unused");
      },
    },
  });

  await assert.rejects(
    service.preflight(
      { request: "AP", clarificationDigest: digest("clarify"), query: "SELECT id FROM invoice" },
      context,
    ),
    (error: unknown) =>
      error instanceof FinanceFailure &&
      assert.deepEqual(error.toSafeMetadata(), {
        cause: "provider_auth",
        retryable: false,
        dependency: "hindsight",
        diagnosticId: "diag-provider-auth",
      }) === undefined,
  );
  assert.deepEqual(diagnostics, [
    {
      runId: "run-1",
      operation: "atomic preflight",
      failure: {
        cause: "provider_auth",
        retryable: false,
        dependency: "hindsight",
        diagnosticId: "diag-provider-auth",
      },
    },
  ]);
});

test("credential-reader failures retain a safe diagnostic without exposing the reader error", async () => {
  const diagnostics: unknown[] = [];
  const service = createBrokeredFinanceService({
    delegate: delegate(),
    credentialReader: {
      async getServiceCredentialSecret(_scope, slug) {
        if (slug === "finny-netsuite") throw new Error("token=reader-secret");
        return null;
      },
    },
    orgScopeId: "org:test",
    credentialSlugs: { hindsight: "finny-hindsight", netsuite: "finny-netsuite" },
    diagnostics: { record: (event: unknown) => diagnostics.push(event) },
    atomicFetch: {
      async preflight() {
        throw new Error("unused");
      },
      async source() {
        throw new Error("unreachable");
      },
    },
  });

  await assert.rejects(
    service.source({ planDigest: digest("plan") }, context),
    (error: unknown) =>
      error instanceof FinanceFailure &&
      error.causeCode === "credential_missing" &&
      typeof error.diagnosticId === "string",
  );
  assert.equal(diagnostics.length, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics), /reader-secret|token=/);
});

test("real NetSuite authentication failures retain status and cause through the broker", async () => {
  const diagnostics: unknown[] = [];
  const diagnosticSink = { record: (event: unknown) => diagnostics.push(event) };
  const service = createBrokeredFinanceService({
    delegate: delegate(),
    credentialReader: reader({
      "finny-netsuite": JSON.stringify({
        accountId: "123456",
        consumerKey: "consumer-key",
        consumerSecret: "consumer-secret",
        tokenId: "token-id",
        tokenSecret: "token-secret",
      }),
    }),
    orgScopeId: "org:test",
    credentialSlugs: { hindsight: "finny-hindsight", netsuite: "finny-netsuite" },
    diagnostics: diagnosticSink,
    atomicFetch: createFinnyAtomicFetchAdapter({
      diagnostics: diagnosticSink,
      hindsight: { recall: async () => ({}) },
      netsuite: createFinnyNetSuiteClient({ fetch: async () => new Response("private body", { status: 401 }) }),
    }),
  });

  await assert.rejects(
    service.source({ planDigest: digest("plan"), query: FINNY_AP_GL_CONTROL_BALANCE_QUERY }, context),
    (error: unknown) =>
      error instanceof FinanceFailure &&
      assert.deepEqual(error.toSafeMetadata(), {
        cause: "provider_auth",
        retryable: false,
        dependency: "netsuite",
        providerStatus: 401,
        diagnosticId: error.diagnosticId,
      }) === undefined,
  );
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0], {
    runId: "run-1",
    operation: "atomic source fetch",
    failure: {
      cause: "provider_auth",
      retryable: false,
      dependency: "netsuite",
      providerStatus: 401,
      diagnosticId: (diagnostics[0] as { failure: { diagnosticId: string } }).failure.diagnosticId,
    },
  });
  assert.doesNotMatch(JSON.stringify(diagnostics), /private body|consumer-secret|token-secret/);
});
