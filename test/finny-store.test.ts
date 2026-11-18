import { TEST_FINNY_EVALUATOR } from "./support/finny-fixture.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { initialFinnyPolicy } from "../src/finny/policy.ts";
import { createPostgresFinnyStore } from "../src/finny/postgres-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { finnySopJobFields } from "./support/finny-sop-fixture.ts";

const createInput = () => ({
  id: randomUUID(),
  scopeId: "personal:U1",
  ...finnySopJobFields("personal:U1"),
  policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
  findingPolicy: {
    id: "finny-r5-test",
    maxFindings: 8,
    maxCodeLength: 80,
    maxMessageLength: 2_000,
  },
  originThreadRef: "slack:C1:100.1",
});

async function approve(store: ReturnType<typeof createPostgresFinnyStore>, input: ReturnType<typeof createInput>) {
  const requestId = randomUUID();
  await store.createApprovalRequest({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId,
    authorizedActorId: "U1",
  });
  return store.recordApproval({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId,
    actorId: "U1",
    action: "approve",
    originThreadRef: input.originThreadRef,
    decidedAt: Date.now(),
  });
}

test("creates a job from a validated SOP binding with no artifact", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  const created = await store.createJob(input);
  assert.deepEqual(created.sop, input.sop);
  assert.deepEqual(created.sopBinding?.values, input.values);
  assert.equal(created.artifactDigest, undefined);
  assert.equal(created.provisionalRevision, undefined);
  assert.equal(created.approval, undefined);
  assert.deepEqual(await store.getJob(input.scopeId, input.id), created);
});

test("approval decision derives exact bindings from an opaque pre-bound request", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  const requestId = randomUUID();
  await store.createApprovalRequest({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId,
    authorizedActorId: "U1",
  });
  const approved = await store.recordApproval({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId,
    actorId: "U1",
    action: "approve",
    originThreadRef: input.originThreadRef,
    decidedAt: Date.now(),
  });
  assert.equal(approved.approval?.executionDigest, approved.sopBinding?.executionDigest);
  assert.equal(approved.approval?.originThreadRef, input.originThreadRef);
  await assert.rejects(
    store.recordApproval({
      scopeId: input.scopeId,
      jobId: input.id,
      requestId,
      actorId: "U2",
      action: "reject",
      originThreadRef: input.originThreadRef,
      decidedAt: Date.now(),
    }),
    /actor|decided/i,
  );

  const other = createInput();
  await store.createJob(other);
  await assert.rejects(
    store.recordApproval({
      scopeId: other.scopeId,
      jobId: other.id,
      requestId,
      actorId: "U1",
      action: "approve",
      originThreadRef: other.originThreadRef,
      decidedAt: Date.now(),
    }),
    /binding|request/i,
  );
});

test("artifact_ready sets the first artifact only after approval", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  const readiness = {
    scopeId: input.scopeId,
    jobId: input.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "delivery-revision-1",
    idempotencyKey: randomUUID(),
  };
  await assert.rejects(store.recordArtifactReady(readiness), /approved/i);
  await approve(store, input);
  const ready = await store.recordArtifactReady(readiness);
  assert.equal(ready.job.artifactDigest, readiness.artifactDigest);
  assert.equal(ready.job.provisionalRevision, readiness.provisionalRevision);
  await assert.rejects(
    store.recordArtifactReady({ ...readiness, artifactDigest: "replacement", idempotencyKey: randomUUID() }),
    /rework/i,
  );
});

test("records one complete immutable audit attempt for the current artifact", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  const approved = await approve(store, input);
  await store.recordArtifactReady({
    scopeId: input.scopeId,
    jobId: input.id,
    artifactDigest: "a".repeat(64),
    provisionalRevision: "artifact-file-1",
    idempotencyKey: randomUUID(),
  });
  const submission = {
    id: randomUUID(),
    scopeId: input.scopeId,
    jobId: input.id,
    sopVersionId: approved.sopBinding!.versionId,
    executionDigest: approved.sopBinding!.executionDigest,
    artifactFileId: "artifact-file-1",
    artifactSha256: "a".repeat(64),
    artifactMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const,
    artifactSizeBytes: 4096,
    evaluator: TEST_FINNY_EVALUATOR,
    controls: [
      {
        id: "source-total",
        verdict: "pass" as const,
        evidenceRefs: ["evidence:source-total"],
        repairActions: [],
      },
      {
        id: "mapping-exception",
        verdict: "pass" as const,
        evidenceRefs: ["xlsx:Exceptions!A1"],
        repairActions: [],
      },
      {
        id: "formula.recalculate",
        verdict: "pass" as const,
        evidenceRefs: ["evidence:formula"],
        repairActions: [],
      },
      {
        id: "summary.crossfoot",
        verdict: "block" as const,
        evidenceRefs: ["xlsx:Summary!B7"],
        repairActions: [{ message: "Correct the summary total", workbookRefs: ["xlsx:Summary!B7"] }],
      },
    ],
    judgmentQuestions: [],
    judgmentAddendum: {
      issuerPrincipalId: "finny-deterministic-spreadsheet-worker",
      issuerRunId: "run-auditor-1",
      answers: [
        {
          controlId: "mapping-exception",
          verdict: "pass" as const,
          evidenceRefs: ["xlsx:Exceptions!A1"],
          rationale: "No material exception remains.",
        },
      ],
    },
    verdict: "block" as const,
    issuerPrincipalId: "finny-deterministic-spreadsheet-worker",
    issuerRunId: "run-auditor-1",
    idempotencyKey: randomUUID(),
    completedAt: Date.now(),
  };

  const first = await store.recordAuditAttempt(submission);
  const duplicate = await store.recordAuditAttempt({ ...submission, completedAt: submission.completedAt + 1 });
  const resolved = await store.getAuditAttemptByOperation(input.scopeId, input.id, submission.idempotencyKey);

  assert.equal(first.deduped, false);
  assert.equal(duplicate.deduped, true);
  assert.deepEqual(duplicate.attempt, first.attempt);
  assert.deepEqual(resolved?.attempt, first.attempt);
  assert.deepEqual(first.attempt.controls, submission.controls);
  assert.equal(first.attempt.verdict, "block");
  assert.equal(first.job.currentAuditAttemptId, submission.id);
  assert.deepEqual(
    first.events.map((event) => event.type),
    ["audit_attempt_recorded", "rework_requested"],
  );
  assert.deepEqual(first.events[0]?.payload, {
    attemptId: submission.id,
    artifactDigest: submission.artifactSha256,
    verdict: "block",
    failedControlIds: ["summary.crossfoot"],
    requestDigest: (first.events[0]?.payload as { requestDigest: string }).requestDigest,
  });
  assert.match((first.events[0]?.payload as { requestDigest: string }).requestDigest, /^[a-f0-9]{64}$/);
});

test("completes one pending judgment attempt as BLOCK and requests rework", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  const approved = await approve(store, input);
  await store.recordArtifactReady({
    scopeId: input.scopeId,
    jobId: input.id,
    artifactDigest: "d".repeat(64),
    provisionalRevision: "artifact-file-judgment",
    idempotencyKey: randomUUID(),
  });
  const controls = [
    { id: "source-total", verdict: "pass" as const, evidenceRefs: ["evidence:source-total"], repairActions: [] },
    { id: "mapping-exception", verdict: "pass" as const, evidenceRefs: ["xlsx:Exceptions!A1"], repairActions: [] },
  ];
  const pending = await store.recordAuditAttempt({
    id: randomUUID(),
    scopeId: input.scopeId,
    jobId: input.id,
    sopVersionId: approved.sopBinding!.versionId,
    executionDigest: approved.sopBinding!.executionDigest,
    artifactFileId: "artifact-file-judgment",
    artifactSha256: "d".repeat(64),
    artifactMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    artifactSizeBytes: 4096,
    evaluator: TEST_FINNY_EVALUATOR,
    controls,
    judgmentQuestions: [
      { controlId: "mapping-exception", question: "Is the exception material?", onlyWhen: "material_count > 0" },
    ],
    verdict: "pending_judgment",
    issuerPrincipalId: "auditor",
    issuerRunId: "audit-run",
    idempotencyKey: randomUUID(),
  });
  const blockedControls = controls.map((control) =>
    control.id === "mapping-exception"
      ? {
          ...control,
          verdict: "block" as const,
          repairActions: [{ message: "Repair the mapping", workbookRefs: ["xlsx:Exceptions!A2"] }],
        }
      : control,
  );
  const completion = {
    scopeId: input.scopeId,
    jobId: input.id,
    attemptId: pending.attempt.id,
    controls: blockedControls.filter((control) => control.id === "mapping-exception"),
    judgmentAddendum: {
      issuerPrincipalId: "auditor",
      issuerRunId: "audit-run-judgment",
      answers: [
        {
          controlId: "mapping-exception",
          verdict: "block" as const,
          evidenceRefs: ["xlsx:Exceptions!A2"],
          rationale: "The remaining exception is material.",
        },
      ],
    },
    idempotencyKey: randomUUID(),
    completedAt: Date.now(),
  };
  const completed = await store.completeAuditJudgment(completion);
  const replayed = await store.completeAuditJudgment({ ...completion, completedAt: completion.completedAt + 1 });
  const resolved = await store.getAuditAttemptByOperation(input.scopeId, input.id, completion.idempotencyKey);
  assert.equal(completed.attempt.id, pending.attempt.id);
  assert.equal(replayed.deduped, true);
  assert.deepEqual(replayed.attempt, completed.attempt);
  assert.deepEqual(resolved?.attempt, completed.attempt);
  assert.equal(completed.attempt.verdict, "block");
  assert.deepEqual(completed.attempt.controls[0], controls[0]);
  assert.deepEqual(
    completed.events.map((event) => event.type),
    ["audit_judgment_recorded", "rework_requested"],
  );
  assert.ok(completed.job.pendingReworkSequence);
});

test("a corrected artifact clears the BLOCK attempt before a new coherent audit", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = createInput();
  await store.createJob(input);
  const approved = await approve(store, input);
  await store.recordArtifactReady({
    scopeId: input.scopeId,
    jobId: input.id,
    artifactDigest: "c".repeat(64),
    provisionalRevision: "artifact-file-blocked",
    idempotencyKey: randomUUID(),
  });
  const blocked = await store.recordAuditAttempt({
    id: randomUUID(),
    scopeId: input.scopeId,
    jobId: input.id,
    sopVersionId: approved.sopBinding!.versionId,
    executionDigest: approved.sopBinding!.executionDigest,
    artifactFileId: "artifact-file-blocked",
    artifactSha256: "c".repeat(64),
    artifactMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    artifactSizeBytes: 4096,
    evaluator: TEST_FINNY_EVALUATOR,
    controls: [
      { id: "source-total", verdict: "pass", evidenceRefs: ["evidence:source-total"], repairActions: [] },
      { id: "mapping-exception", verdict: "pass", evidenceRefs: ["xlsx:Exceptions!A1"], repairActions: [] },
      {
        id: "summary.crossfoot",
        verdict: "block",
        evidenceRefs: ["xlsx:Summary!B7"],
        repairActions: [{ message: "Correct the total", workbookRefs: ["xlsx:Summary!B7"] }],
      },
    ],
    judgmentQuestions: [],
    judgmentAddendum: {
      issuerPrincipalId: "finny-deterministic-spreadsheet-worker",
      issuerRunId: "core-audit-run",
      answers: [
        {
          controlId: "mapping-exception",
          verdict: "pass",
          evidenceRefs: ["xlsx:Exceptions!A1"],
          rationale: "No material exception remains.",
        },
      ],
    },
    verdict: "block",
    issuerPrincipalId: "finny-deterministic-spreadsheet-worker",
    issuerRunId: "core-audit-run",
    idempotencyKey: randomUUID(),
    completedAt: Date.now(),
  });

  assert.ok(blocked.job.pendingReworkSequence);
  const blockedEvents = await store.listEvents(input.scopeId, input.id);
  assert.deepEqual(
    blockedEvents.slice(-2).map((event) => event.type),
    ["audit_attempt_recorded", "rework_requested"],
  );

  const corrected = await store.recordArtifactReady({
    scopeId: input.scopeId,
    jobId: input.id,
    artifactDigest: "d".repeat(64),
    provisionalRevision: "artifact-file-corrected",
    idempotencyKey: randomUUID(),
  });

  assert.equal(corrected.job.currentAuditAttemptId, undefined);
  assert.equal(corrected.job.artifactDigest, "d".repeat(64));
});
