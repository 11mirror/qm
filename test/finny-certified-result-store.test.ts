import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import {
  finnyCertifiedResultSearchText,
  validateFinnyCertifiedResult,
  validateFinnyCertifiedResultDestination,
} from "../src/finny/certified-result.ts";
import { createPostgresFinnyStore } from "../src/finny/postgres-store.ts";
import { initialFinnyPolicy } from "../src/finny/policy.ts";
import type { FinnyJob } from "../src/finny/types.ts";
import { TEST_FINNY_EVALUATOR, testDeterministicAuthority } from "./support/finny-fixture.ts";
import { finnySopFixture } from "./support/finny-sop-fixture.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

interface CertifiedResult {
  schema: "finny.result.v1";
  jobId: string;
  sopVersionId: string;
  executionDigest: string;
  artifact: { fileId: string; sha256: string; mime: string };
  summary: {
    period: string;
    currency: string;
    metrics: Array<{ id: string; label: string; value: string; detailRefs: string[] }>;
    exceptions: Array<{ text: string; material: boolean; detailRefs: string[] }>;
    caveats: Array<{ text: string; detailRefs: string[] }>;
  };
  auditAttemptId: string;
}

interface StoredCertifiedResult extends CertifiedResult {
  id: string;
  scopeId: string;
  receipt: Record<string, unknown>;
  destination: Record<string, unknown>;
  deliveryId?: string;
  createdAt: number;
}

interface CertifiedResultStore {
  certifyResult?: (
    input: {
      scopeId: string;
      result: CertifiedResult;
      destination: Record<string, unknown>;
      idempotencyKey: string;
    },
    sign: (payload: Record<string, unknown>) => Promise<string>,
  ) => Promise<StoredCertifiedResult>;
  getCertifiedResult?: (scopeId: string, resultId: string) => Promise<StoredCertifiedResult | null>;
  getCertifiedResultById?: (resultId: string) => Promise<StoredCertifiedResult | null>;
  pendingCertifiedResultDeliveries?: () => Promise<StoredCertifiedResult[]>;
  markCertifiedResultDelivery?: (resultId: string, deliveryId: string) => Promise<void>;
}

async function resultJob(verdict: "pass" | "block" | null = "pass") {
  const url = testDatabaseUrl();
  const store = createPostgresFinnyStore(url);
  const sop = finnySopFixture();
  const job = await store.createJob({
    id: randomUUID(),
    scopeId: sop.scopeId,
    sop,
    values: { cutoff: "2026-10-31", currency: "INR" },
    policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
    findingPolicy: {
      id: "finny-result-test",
      maxFindings: 8,
      maxCodeLength: 80,
      maxMessageLength: 2_000,
    },
    originThreadRef: "slack:C1:100.1",
  });
  const requestId = randomUUID();
  await store.createApprovalRequest({
    scopeId: job.scopeId,
    jobId: job.id,
    requestId,
    authorizedActorId: "U1",
  });
  const approved = await store.recordApproval({
    scopeId: job.scopeId,
    jobId: job.id,
    requestId,
    actorId: "U1",
    action: "approve",
    originThreadRef: job.originThreadRef,
    decidedAt: Date.now(),
  });
  const artifactSha256 = "8e537f9a1d4f5b37c8b2430348db6bbf27b64b44d2ef18e0d68f2aa743fca8b2";
  const artifactFileId = "file-workbook-1";
  const artifact = await store.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: artifactSha256,
    provisionalRevision: artifactFileId,
    idempotencyKey: randomUUID(),
  });
  if (verdict === null) {
    return { url, store, job: artifact.job, auditAttemptId: randomUUID() };
  }
  const attempt = await store.recordAuditAttempt({
    id: randomUUID(),
    scopeId: job.scopeId,
    jobId: job.id,
    sopVersionId: approved.sopBinding!.versionId,
    executionDigest: approved.sopBinding!.executionDigest,
    artifactFileId,
    artifactSha256,
    artifactMime: XLSX_MIME,
    artifactSizeBytes: 4096,
    evaluator: TEST_FINNY_EVALUATOR,
    controls: [
      {
        id: "source-total",
        verdict,
        evidenceRefs: ["evidence:source-total"],
        repairActions:
          verdict === "block" ? [{ message: "Repair source total", workbookRefs: ["xlsx:Summary!B7"] }] : [],
      },
      {
        id: "mapping-exception",
        verdict: "pass",
        evidenceRefs: ["xlsx:Exceptions!A1"],
        repairActions: [],
      },
    ],
    judgmentQuestions: [],
    judgmentAddendum: {
      issuerPrincipalId: "finny-deterministic-spreadsheet-worker",
      issuerRunId: "audit-run-1",
      answers: [
        {
          controlId: "mapping-exception",
          verdict: "pass",
          evidenceRefs: ["xlsx:Exceptions!A1"],
          rationale: "No material exception remains.",
        },
      ],
    },
    verdict,
    issuerPrincipalId: "finny-deterministic-spreadsheet-worker",
    issuerRunId: "audit-run-1",
    idempotencyKey: randomUUID(),
    completedAt: Date.now(),
  });
  return { url, store, job: attempt.job, auditAttemptId: attempt.attempt.id };
}

function certifiedResult(job: FinnyJob, auditAttemptId = "audit-attempt-1"): CertifiedResult {
  assert.ok(job.sopBinding);
  return {
    schema: "finny.result.v1",
    jobId: job.id,
    sopVersionId: job.sopBinding.versionId,
    executionDigest: job.sopBinding.executionDigest,
    artifact: {
      fileId: "file-workbook-1",
      sha256: "8e537f9a1d4f5b37c8b2430348db6bbf27b64b44d2ef18e0d68f2aa743fca8b2",
      mime: XLSX_MIME,
    },
    summary: {
      period: "2026-10-31",
      currency: "INR",
      metrics: [
        {
          id: "open-ap",
          label: "Open AP",
          value: "12172560.00",
          detailRefs: ["xlsx:Summary!B7", "evidence:source-total#control-total"],
        },
      ],
      exceptions: [
        {
          text: "One disputed bill remains open",
          material: true,
          detailRefs: ["xlsx:Exceptions!A2:D2"],
        },
      ],
      caveats: [
        {
          text: "Foreign currency balances use the approved cutoff rate",
          detailRefs: ["evidence:source-total#fx-rate"],
        },
      ],
    },
    auditAttemptId,
  };
}

function resultAuthority(store: ReturnType<typeof createPostgresFinnyStore>) {
  return store as ReturnType<typeof createPostgresFinnyStore> & CertifiedResultStore;
}

const signResult = async () => "signed-receipt";

test("validates the exact certified result contract", () => {
  const result = certifiedResult({
    id: "job-1",
    scopeId: "org:invented-media-company",
    sopBinding: {
      versionId: "org%3Ainvented-media-company/ap-aging@3",
      values: { cutoff: "2026-10-31", currency: "INR" },
      executionDigest: "execution-digest-1",
      revision: 1,
    },
  } as unknown as FinnyJob);
  assert.deepEqual(validateFinnyCertifiedResult(structuredClone(result)), result);
  assert.deepEqual(validateFinnyCertifiedResultDestination({ type: "slack", target: "C1:100.1" }), {
    type: "slack",
    target: "C1:100.1",
  });
});

test("rejects malformed certified result identity, summary, and detail references", () => {
  const result = certifiedResult({
    id: "job-1",
    scopeId: "org:invented-media-company",
    sopBinding: {
      versionId: "org%3Ainvented-media-company/ap-aging@3",
      values: { cutoff: "2026-10-31", currency: "INR" },
      executionDigest: "execution-digest-1",
      revision: 1,
    },
  } as unknown as FinnyJob);
  assert.throws(
    () => validateFinnyCertifiedResult({ ...result, artifact: { ...result.artifact, mime: "text/csv" } }),
    /xlsx|mime/i,
  );
  assert.throws(
    () => validateFinnyCertifiedResult({ ...result, artifact: { ...result.artifact, sha256: "not-a-sha" } }),
    /sha/i,
  );
  assert.throws(
    () => validateFinnyCertifiedResult({ ...result, summary: { ...result.summary, period: " " } }),
    /period/i,
  );
  assert.throws(
    () => validateFinnyCertifiedResult({ ...result, summary: { ...result.summary, currency: "" } }),
    /currency/i,
  );
  assert.throws(
    () =>
      validateFinnyCertifiedResult({
        ...result,
        summary: { ...result.summary, metrics: [result.summary.metrics[0], result.summary.metrics[0]] },
      }),
    /metric.*id|duplicate/i,
  );
  assert.throws(
    () =>
      validateFinnyCertifiedResult({
        ...result,
        summary: {
          ...result.summary,
          caveats: [{ text: "Unbound", detailRefs: ["https://example.com/ledger"] }],
        },
      }),
    /detail reference/i,
  );
  assert.throws(() => validateFinnyCertifiedResultDestination({}), /destination/i);
});

test("builds stable certified-result search text from business facts", () => {
  const result = certifiedResult({
    id: "job-1",
    scopeId: "org:invented-media-company",
    sopBinding: {
      versionId: "org%3Ainvented-media-company/ap-aging@3",
      values: { cutoff: "2026-10-31", currency: "INR" },
      executionDigest: "execution-digest-1",
      revision: 1,
    },
  } as unknown as FinnyJob);
  assert.equal(
    finnyCertifiedResultSearchText(result),
    [
      "2026-10-31",
      "INR",
      "open-ap",
      "Open AP",
      "12172560.00",
      "One disputed bill remains open",
      "Foreign currency balances use the approved cutoff rate",
    ].join("\n"),
  );
});

test("persists one typed certified result and exposes its reference from the job", async () => {
  const { url, store, job, auditAttemptId } = await resultJob();
  const authority = resultAuthority(store);
  assert.equal(typeof authority.certifyResult, "function");
  assert.equal(typeof authority.getCertifiedResult, "function");
  const result = certifiedResult(job, auditAttemptId);
  const stored = await authority.certifyResult!(
    {
      scopeId: job.scopeId,
      result,
      destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
      idempotencyKey: "certify-result-1",
    },
    signResult,
  );
  assert.deepEqual(
    {
      schema: stored.schema,
      jobId: stored.jobId,
      sopVersionId: stored.sopVersionId,
      executionDigest: stored.executionDigest,
      artifact: stored.artifact,
      summary: stored.summary,
      auditAttemptId: stored.auditAttemptId,
    },
    result,
  );
  const restarted = resultAuthority(createPostgresFinnyStore(url));
  assert.deepEqual(await restarted.getCertifiedResult!(job.scopeId, stored.id), stored);
  assert.deepEqual(await restarted.getCertifiedResultById!(stored.id), stored);
  assert.equal(await restarted.getCertifiedResult!("org:other", stored.id), null);
  const current = (await restarted.getJob(job.scopeId, job.id)) as FinnyJob & { resultId?: string };
  assert.equal(current.resultId, stored.id);
});

test("rejects certified summaries whose detail references escape bound result authorities", async () => {
  const { store, job, auditAttemptId } = await resultJob();
  const authority = resultAuthority(store);
  assert.equal(typeof authority.certifyResult, "function");
  const result = certifiedResult(job, auditAttemptId);
  result.summary.metrics[0]!.detailRefs = ["https://example.com/unbound-ledger"];
  await assert.rejects(
    authority.certifyResult!(
      {
        scopeId: job.scopeId,
        result,
        destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
        idempotencyKey: "certify-result-invalid-ref",
      },
      signResult,
    ),
    /detail reference|detailRefs|bound artifact|evidence/i,
  );
});

test("rejects a correctly prefixed detail reference without bound evidence authority", async () => {
  const { store, job, auditAttemptId } = await resultJob();
  const authority = resultAuthority(store);
  const result = certifiedResult(job, auditAttemptId);
  result.summary.metrics[0]!.detailRefs = ["evidence:missing#control-total"];
  await assert.rejects(
    authority.certifyResult!(
      {
        scopeId: job.scopeId,
        result,
        destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
        idempotencyKey: "certify-result-unbound-evidence",
      },
      signResult,
    ),
    /detail reference.*not bound/i,
  );
});

test("rejects an XLSX detail reference bound to another file", async () => {
  const { store, job, auditAttemptId } = await resultJob();
  const authority = resultAuthority(store);
  const result = certifiedResult(job, auditAttemptId);
  result.summary.metrics[0]!.detailRefs = ["xlsx:other-file#Summary!B7"];
  await assert.rejects(
    authority.certifyResult!(
      {
        scopeId: job.scopeId,
        result,
        destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
        idempotencyKey: "certify-result-other-workbook",
      },
      signResult,
    ),
    /detail reference.*not bound/i,
  );
});

test("rejects certification when the final artifact is not an XLSX", async () => {
  const { store, job, auditAttemptId } = await resultJob();
  const authority = resultAuthority(store);
  assert.equal(typeof authority.certifyResult, "function");
  const result = certifiedResult(job, auditAttemptId);
  result.artifact.mime = "text/csv";
  await assert.rejects(
    authority.certifyResult!(
      {
        scopeId: job.scopeId,
        result,
        destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
        idempotencyKey: "certify-result-csv",
      },
      signResult,
    ),
    /xlsx|spreadsheet|mime/i,
  );
});

test("certification rejects a missing or BLOCK atomic attempt", async () => {
  for (const verdict of [null, "block"] as const) {
    const { store, job, auditAttemptId } = await resultJob(verdict);
    const authority = resultAuthority(store);
    await assert.rejects(
      authority.certifyResult!(
        {
          scopeId: job.scopeId,
          result: certifiedResult(job, auditAttemptId),
          destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
          idempotencyKey: `certify-result-${verdict ?? "missing"}`,
        },
        signResult,
      ),
      /audit|rework|current|pass/i,
    );
  }
});

test("certification rejects a PASS attempt after the job artifact changes", async () => {
  const { store, job, auditAttemptId } = await resultJob();
  await store.recordAuditBlock({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: job.artifactDigest!,
    checkId: "summary.crossfoot",
    generation: 1,
    evidenceDigest: "evidence-before-artifact-replacement",
    issuerPrincipalId: "finny-deterministic-spreadsheet-worker",
    issuerRunId: "audit-run-2",
    ...testDeterministicAuthority("summary.crossfoot", "block"),
    findings: [{ code: "CROSSFOOT_MISMATCH", message: "Summary requires correction" }],
    changeKinds: ["formula"],
    resolution: { kind: "rework" },
    idempotencyKey: randomUUID(),
  });
  await store.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "a".repeat(64),
    provisionalRevision: "file-workbook-2",
    idempotencyKey: randomUUID(),
  });
  const authority = resultAuthority(store);
  await assert.rejects(
    authority.certifyResult!(
      {
        scopeId: job.scopeId,
        result: certifiedResult(job, auditAttemptId),
        destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
        idempotencyKey: "certify-result-stale-artifact",
      },
      signResult,
    ),
    /current|artifact|audit/i,
  );
});

test("stores delivery intent with the result before any generic delivery exists", async () => {
  const { url, store, job, auditAttemptId } = await resultJob();
  const authority = resultAuthority(store);
  assert.equal(typeof authority.certifyResult, "function");
  assert.equal(typeof authority.pendingCertifiedResultDeliveries, "function");
  assert.equal(typeof authority.markCertifiedResultDelivery, "function");
  const destination = { type: "slack", target: "C1:100.1", threadTs: "100.1" };
  const stored = await authority.certifyResult!(
    {
      scopeId: job.scopeId,
      result: certifiedResult(job, auditAttemptId),
      destination,
      idempotencyKey: "certify-result-outbox",
    },
    signResult,
  );
  const { q } = createPgPool(url);
  const rows = await q("SELECT destination,delivery_id FROM finny_results WHERE id=$1", [stored.id]);
  assert.deepEqual(rows, [{ destination, delivery_id: null }]);
  assert.deepEqual(await authority.pendingCertifiedResultDeliveries!(), [stored]);
  await authority.markCertifiedResultDelivery!(stored.id, "delivery-1");
  assert.deepEqual(await authority.pendingCertifiedResultDeliveries!(), []);
  assert.equal((await authority.getCertifiedResult!(job.scopeId, stored.id))?.deliveryId, "delivery-1");
});

test("certification idempotently converges and rejects scope substitution", async () => {
  const { url, store, job, auditAttemptId } = await resultJob();
  const authority = resultAuthority(store);
  assert.equal(typeof authority.certifyResult, "function");
  const input = {
    scopeId: job.scopeId,
    result: certifiedResult(job, auditAttemptId),
    destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
    idempotencyKey: "certify-result-replay",
  };
  const [first, second] = await Promise.all([
    authority.certifyResult!(input, signResult),
    authority.certifyResult!(structuredClone(input), signResult),
  ]);
  assert.deepEqual(second, first);
  await assert.rejects(
    authority.certifyResult!({ ...structuredClone(input), scopeId: "org:other" }, signResult),
    /scope|not found/i,
  );
  const { q } = createPgPool(url);
  const rows = await q("SELECT id FROM finny_results WHERE job_id=$1", [job.id]);
  assert.deepEqual(rows, [{ id: first.id }]);
});
