import assert from "node:assert/strict";
import test from "node:test";

import type { ServiceCredentialReader } from "../src/credentials/keychain.ts";
import type { AtomicFetchAdapter } from "../src/finny/credential-brokered-finance-service.ts";
import { createDefaultFinnyFinanceService } from "../src/finny/default-finance-service.ts";
import type { FinanceExecutionContext } from "../src/finny/finance.ts";
import { digestFinnyEvidence } from "../src/finny/golden-loop.ts";
import { FINNY_AP_GL_CONTROL_BALANCE_QUERY } from "../src/finny/reviewed-query.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";

const digest = (value: string) => digestFinnyEvidence(value);

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
