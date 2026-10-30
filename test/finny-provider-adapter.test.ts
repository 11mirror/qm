import assert from "node:assert/strict";
import test from "node:test";

import { createFinnyAtomicFetchAdapter } from "../src/finny/provider-adapter.ts";
import { FinanceFailure } from "../src/finny/finance-failure.ts";
import { digestFinnyEvidence } from "../src/finny/golden-loop.ts";
import { FINNY_AP_GL_CONTROL_BALANCE_QUERY } from "../src/finny/reviewed-query.ts";

const hindsightSecret = JSON.stringify({
  apiUrl: "https://hindsight.example.test",
  apiKey: "hindsight-secret",
  bankIds: ["example-finance"],
});
const netsuiteSecret = JSON.stringify({
  accountId: "account-id",
  consumerKey: "consumer-key",
  consumerSecret: "consumer-secret",
  tokenId: "token-id",
  tokenSecret: "token-secret",
});

test("atomic preflight and source use structured leases without returning credential material", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const adapter = createFinnyAtomicFetchAdapter({
    hindsight: {
      async recall(query, credential) {
        calls.push({ operation: "recall", query, credential });
        return { facts: ["AP uses AcctPay"] };
      },
    },
    netsuite: {
      async suiteql(query, credential) {
        calls.push({ operation: "suiteql", query, credential });
        return [{ balance: 42, currency: "INR" }];
      },
    },
  });
  const context = { runId: "run-1", actorId: "actor-1", requestText: "What is our current AP balance?" };
  const clarified = digestFinnyEvidence("clarified");

  const preflight = await adapter.preflight(
    { request: "current AP balance", clarificationDigest: clarified, query: FINNY_AP_GL_CONTROL_BALANCE_QUERY },
    context,
    { hindsight: hindsightSecret },
  );
  const source = await adapter.source(
    { planDigest: preflight.planDigest, query: FINNY_AP_GL_CONTROL_BALANCE_QUERY },
    context,
    { hindsight: hindsightSecret, netsuite: netsuiteSecret },
  );

  assert.match(preflight.planSummary, /read-only/i);
  assert.equal(preflight.verificationPolicy, "single_numeric_total");
  assert.deepEqual(source.records, [{ balance: 42, currency: "INR" }]);
  assert.match(preflight.preflightDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(source.sourceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify({ preflight, source }).includes("secret"), false);
  assert.equal(calls.length, 3);
  assert.deepEqual((calls[0]?.credential as { bankIds?: unknown }).bankIds, ["example-finance"]);
});

test("source accepts only the exact reviewed query", async () => {
  let executions = 0;
  const adapter = createFinnyAtomicFetchAdapter({
    hindsight: { recall: async () => ({}) },
    netsuite: {
      async suiteql() {
        executions += 1;
        return [];
      },
    },
  });
  const context = { runId: "run-1", actorId: "actor-1" };
  const input = (query: string) => ({ planDigest: digestFinnyEvidence("plan"), query });
  const credentials = { hindsight: hindsightSecret, netsuite: netsuiteSecret };

  await adapter.source(input(FINNY_AP_GL_CONTROL_BALANCE_QUERY), context, credentials);
  for (const query of [
    "DELETE FROM transaction",
    "SELECT id FROM transaction; DELETE FROM transaction",
    "SELECT id FROM transaction -- trust me",
    "SELECT id FROM transaction /* hidden */",
    "SELECT id INTO copied FROM transaction",
  ]) {
    await assert.rejects(adapter.source(input(query), context, credentials), /read-only SuiteQL/i);
  }
  assert.equal(executions, 1);
});

test("malformed advisory credential bundles are omitted before either provider is called", async () => {
  let calls = 0;
  const adapter = createFinnyAtomicFetchAdapter({
    hindsight: {
      async recall() {
        calls += 1;
        return {};
      },
    },
    netsuite: {
      async suiteql() {
        calls += 1;
        return [];
      },
    },
  });

  const result = await adapter.preflight(
    { request: "AP", clarificationDigest: digestFinnyEvidence("clarified"), query: FINNY_AP_GL_CONTROL_BALANCE_QUERY },
    { runId: "run", actorId: "actor" },
    { hindsight: JSON.stringify({ apiUrl: "https://hindsight.example.test", apiKey: "missing-banks" }) },
  );
  assert.deepEqual(result.enrichment, {
    provider: "hindsight",
    state: "omitted",
    reason: "provider_unavailable",
  });
  assert.equal(calls, 0);
});

test("invalid advisory output is omitted while NetSuite must still return rows", async () => {
  const invalidHindsight = createFinnyAtomicFetchAdapter({
    hindsight: { recall: async () => undefined },
    netsuite: { suiteql: async () => [] },
  });
  const invalidNetSuite = createFinnyAtomicFetchAdapter({
    hindsight: { recall: async () => ({}) },
    netsuite: { suiteql: async () => undefined as unknown as readonly unknown[] },
  });
  const context = { runId: "run", actorId: "actor" };

  const preflight = await invalidHindsight.preflight(
    { request: "AP", clarificationDigest: digestFinnyEvidence("clarified"), query: FINNY_AP_GL_CONTROL_BALANCE_QUERY },
    context,
    { hindsight: hindsightSecret },
  );
  assert.deepEqual(preflight.enrichment, {
    provider: "hindsight",
    state: "omitted",
    reason: "provider_unavailable",
  });
  await assert.rejects(
    invalidNetSuite.source(
      { planDigest: digestFinnyEvidence("plan"), query: FINNY_AP_GL_CONTROL_BALANCE_QUERY },
      context,
      {
        hindsight: hindsightSecret,
        netsuite: netsuiteSecret,
      },
    ),
    /NetSuite result is invalid/i,
  );
});

test("insecure advisory Hindsight endpoints are omitted", async () => {
  const adapter = createFinnyAtomicFetchAdapter({
    hindsight: { recall: async () => ({}) },
    netsuite: { suiteql: async () => [] },
  });
  const insecure = JSON.stringify({ apiUrl: "http://hindsight.example.test", apiKey: "key", bankIds: ["bank"] });

  const result = await adapter.preflight(
    { request: "AP", clarificationDigest: digestFinnyEvidence("clarified"), query: FINNY_AP_GL_CONTROL_BALANCE_QUERY },
    { runId: "run", actorId: "actor" },
    { hindsight: insecure },
  );
  assert.equal(result.enrichment.state, "omitted");
});

test("direct NetSuite source work records omitted Hindsight enrichment without a recall digest", async () => {
  let recallCalls = 0;
  const adapter = createFinnyAtomicFetchAdapter({
    hindsight: {
      async recall() {
        recallCalls += 1;
        throw new Error("must not be called without an advisory credential");
      },
    },
    netsuite: { suiteql: async () => [{ total: 42 }] },
  });

  const preflight = await adapter.preflight(
    { request: "AP", clarificationDigest: digestFinnyEvidence("clarified"), query: FINNY_AP_GL_CONTROL_BALANCE_QUERY },
    { runId: "run", actorId: "actor" },
    { hindsight: undefined },
  );
  const source = await adapter.source(
    { planDigest: preflight.planDigest, query: FINNY_AP_GL_CONTROL_BALANCE_QUERY },
    { runId: "run", actorId: "actor" },
    { hindsight: undefined, netsuite: netsuiteSecret },
  );

  assert.deepEqual(preflight.enrichment, {
    provider: "hindsight",
    state: "omitted",
    reason: "credential_unavailable",
  });
  assert.equal("evidenceDigest" in preflight.enrichment, false);
  assert.deepEqual(source.enrichment, {
    provider: "hindsight",
    state: "omitted",
    reason: "credential_unavailable",
  });
  assert.equal("evidenceDigest" in source.enrichment, false);
  assert.equal(recallCalls, 0);
});

test("unavailable Hindsight enrichment does not block a reviewed NetSuite source fetch", async () => {
  let suiteqlCalls = 0;
  const adapter = createFinnyAtomicFetchAdapter({
    hindsight: {
      async recall() {
        throw new Error("Hindsight is down");
      },
    },
    netsuite: {
      async suiteql() {
        suiteqlCalls += 1;
        return [{ total: 42 }];
      },
    },
  });

  const source = await adapter.source(
    { planDigest: digestFinnyEvidence("plan"), query: FINNY_AP_GL_CONTROL_BALANCE_QUERY },
    { runId: "run", actorId: "actor" },
    { hindsight: hindsightSecret, netsuite: netsuiteSecret },
  );

  assert.deepEqual(source.enrichment, {
    provider: "hindsight",
    state: "omitted",
    reason: "provider_unavailable",
  });
  assert.equal("evidenceDigest" in source.enrichment, false);
  assert.equal(suiteqlCalls, 1);
});

test("optional Hindsight failure preserves safe typed evidence and a durable diagnostic link", async () => {
  const diagnostics: unknown[] = [];
  const adapter = createFinnyAtomicFetchAdapter({
    diagnostics: { record: (event: unknown) => diagnostics.push(event) },
    hindsight: {
      async recall() {
        throw new FinanceFailure("provider_auth", {
          retryable: false,
          dependency: "hindsight",
          diagnosticId: "diag-hindsight-auth",
        });
      },
    },
    netsuite: { suiteql: async () => [] },
  });

  const result = await adapter.preflight(
    { request: "AP", clarificationDigest: digestFinnyEvidence("clarified"), query: FINNY_AP_GL_CONTROL_BALANCE_QUERY },
    { runId: "run", actorId: "actor" },
    { hindsight: hindsightSecret },
  );

  assert.deepEqual(result.enrichment, {
    provider: "hindsight",
    state: "omitted",
    reason: "provider_unavailable",
    failure: {
      cause: "provider_auth",
      retryable: false,
      dependency: "hindsight",
      diagnosticId: "diag-hindsight-auth",
    },
  });
  assert.deepEqual(diagnostics, [
    {
      runId: "run",
      operation: "hindsight recall",
      failure: {
        cause: "provider_auth",
        retryable: false,
        dependency: "hindsight",
        diagnosticId: "diag-hindsight-auth",
      },
    },
  ]);
});
