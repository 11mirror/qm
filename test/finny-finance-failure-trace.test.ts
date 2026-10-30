import assert from "node:assert/strict";
import test from "node:test";

import { FinanceFailure, financeFailureFromUnknown } from "../src/finny/finance-failure.ts";
import { createFinnyGoldenLoop, digestFinnyEvidence } from "../src/finny/golden-loop.ts";
import { createFinnyTraceSnapshot, safeFinnyTraceSnapshot } from "../src/finny/trace.ts";
import { scopeId } from "../src/types.ts";

test("finance failures accept only allowlisted typed causes and safe metadata", () => {
  const causes = [
    "unsupported_template",
    "schema_mapping_required",
    "credential_missing",
    "invalid_config",
    "provider_auth",
    "provider_timeout",
    "provider_rate_limited",
    "provider_unavailable",
    "invalid_response",
    "verification_failed",
    "policy_block",
    "internal_error",
  ] as const;
  for (const cause of causes) assert.equal(new FinanceFailure(cause).causeCode, cause);

  const unknown = financeFailureFromUnknown(new Error("password=hunter2"));
  assert.equal(unknown.causeCode, "internal_error");
  assert.equal(unknown.retryable, false);
  assert.doesNotMatch(JSON.stringify(unknown.toSafeMetadata()), /hunter2|password/);
  assert.deepEqual(
    new FinanceFailure("provider_timeout", {
      dependency: "netsuite token=secret",
      diagnosticId: "unsafe/id",
      providerStatus: 99,
    }).toSafeMetadata(),
    { cause: "provider_timeout", retryable: true },
  );
  assert.deepEqual(
    new FinanceFailure("provider_auth", {
      dependency: "netsuite",
      diagnosticId: "diag-401",
      providerStatus: 401,
    }).toSafeMetadata(),
    {
      cause: "provider_auth",
      retryable: false,
      dependency: "netsuite",
      diagnosticId: "diag-401",
      providerStatus: 401,
    },
  );
});

test("trace v2 allowlists typed blocker and action timing fields without copying payloads", () => {
  const safe = safeFinnyTraceSnapshot({
    schema: "finny.trace.v2",
    workflowRunId: "workflow-1",
    currentRunId: "run-1",
    sessionId: "session-1",
    profile: "finny",
    harness: "pi",
    modelId: "gpt-5.6-sol",
    surface: "web",
    stage: "PREFLIGHT",
    outcome: "blocked",
    transitionCount: 1,
    latestAction: { action: "preflight", durationMs: 42, attempt: 2, payload: "secret" },
    blocker: {
      action: "preflight",
      code: "blocked_external",
      cause: "provider_timeout",
      retryable: true,
      dependency: "netsuite",
      diagnosticId: "diag-123",
      providerStatus: 504,
      rawError: "token=secret",
    },
    credentials: "must-not-leak",
  });

  assert.deepEqual(safe, {
    schema: "finny.trace.v2",
    workflowRunId: "workflow-1",
    currentRunId: "run-1",
    sessionId: "session-1",
    profile: "finny",
    harness: "pi",
    modelId: "gpt-5.6-sol",
    surface: "web",
    stage: "PREFLIGHT",
    outcome: "blocked",
    transitionCount: 1,
    latestAction: { action: "preflight", durationMs: 42, attempt: 2 },
    blocker: {
      action: "preflight",
      code: "blocked_external",
      cause: "provider_timeout",
      retryable: true,
      dependency: "netsuite",
      diagnosticId: "diag-123",
      providerStatus: 504,
    },
  });
  assert.doesNotMatch(JSON.stringify(safe), /secret|credentials|rawError|payload/);
});

test("trace v2 rejects untyped or malformed diagnostic metadata", () => {
  const base = {
    schema: "finny.trace.v2",
    workflowRunId: "workflow-1",
    currentRunId: "run-1",
    sessionId: "session-1",
    profile: "finny",
    harness: "pi",
    modelId: "gpt-5.6-sol",
    surface: "web",
    stage: "PREFLIGHT",
    outcome: "blocked",
    transitionCount: 0,
  };
  assert.equal(
    safeFinnyTraceSnapshot({
      ...base,
      blocker: {
        action: "preflight",
        code: "blocked_external",
        cause: "database_password_leaked",
        retryable: true,
        diagnosticId: "diag",
      },
    }),
    null,
  );
  assert.equal(
    safeFinnyTraceSnapshot({ ...base, latestAction: { action: "source", durationMs: -1, attempt: 1 } }),
    null,
  );
  assert.equal(
    safeFinnyTraceSnapshot({
      ...base,
      blocker: {
        action: "source",
        code: "blocked_external",
        cause: "provider_auth",
        retryable: false,
        providerStatus: 999,
      },
    }),
    null,
  );
});

test("plan-native trace v3 exposes only plan authority and attestation state", () => {
  const digest = (value: string) => digestFinnyEvidence(value);
  const state = {
    ...createFinnyGoldenLoop("workflow-1"),
    stage: "VERIFIED" as const,
    planDigest: digest("plan"),
    catalogDigest: digest("catalog"),
    capabilityId: "inventory_position",
    revisionId: "inventory_position.v1",
    operationGraphDigest: digest("graph"),
    approvalRequired: false,
    approvalPolicyDigest: digest("approval-policy"),
    verificationPolicyDigest: digest("verification-policy"),
    verificationDigest: digest("verification"),
    completedOperations: {
      inventory: {
        primitive: "suiteql_select" as const,
        operationDigest: digest("operation"),
        resultDigest: digest("result"),
      },
    },
  };

  const trace = createFinnyTraceSnapshot(state, {
    runId: "run-1",
    session: {
      id: "session-1",
      type: "dm",
      scopeId: scopeId("personal", "person-1"),
      threadRef: "web:person-1:session-1",
      createdAt: 1,
    },
    runtime: { modelId: "pi-model" },
    surfaceName: "web",
  });

  assert.deepEqual(trace, {
    schema: "finny.trace.v3",
    workflowRunId: "workflow-1",
    currentRunId: "run-1",
    sessionId: "session-1",
    profile: "finny",
    harness: "pi",
    modelId: "pi-model",
    surface: "web",
    stage: "VERIFIED",
    outcome: "blocked",
    transitionCount: 0,
    plan: {
      catalogDigest: digest("catalog"),
      capabilityId: "inventory_position",
      revisionId: "inventory_position.v1",
      operationGraphDigest: digest("graph"),
      planDigest: digest("plan"),
    },
    operations: [
      {
        operationId: "inventory",
        primitive: "suiteql_select",
        operationDigest: digest("operation"),
        resultDigest: digest("result"),
      },
    ],
    approval: { required: false, policyDigest: digest("approval-policy") },
    verification: {
      status: "passed",
      policyDigest: digest("verification-policy"),
      digest: digest("verification"),
    },
  });
  assert.deepEqual(safeFinnyTraceSnapshot({ ...trace, query: "SELECT secret", credentials: "secret" }), trace);
  assert.doesNotMatch(JSON.stringify(trace), /SELECT|credentials|secret/);
});
