import { TEST_FINNY_EVALUATOR } from "./support/finny-fixture.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createFinnyRuntimeCoordinator, reconcileFinnyRuntimeRecoveries } from "../src/finny/runtime-coordinator.ts";
import { createPostgresFinnyRuntimeStore, type FinnyRuntimeRecovery } from "../src/finny/runtime-postgres-store.ts";
import { initialFinnyPolicy } from "../src/finny/policy.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresFinnyStore } from "../src/finny/postgres-store.ts";
import { createFinnyWorkerGrants } from "../src/finny/worker-grants.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import type { SessionOpenInput } from "../src/sessions/session-syscalls.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { finnySopFixture } from "./support/finny-sop-fixture.ts";

async function approvedJob() {
  const connectionString = testDatabaseUrl();
  await createPostgresRunStore(connectionString).runs.list({ limit: 1 });
  const jobs = createPostgresFinnyStore(connectionString);
  const scopeId = "personal:U1";
  const job = await jobs.createJob({
    id: randomUUID(),
    scopeId,
    sop: { ...finnySopFixture(), scopeId },
    values: { cutoff: "2026-10-31", currency: "INR" },
    policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
    findingPolicy: { id: "runtime-test", maxFindings: 4, maxCodeLength: 40, maxMessageLength: 200 },
    originThreadRef: `slack:C1:${randomUUID()}`,
  });
  const requestId = randomUUID();
  await jobs.createApprovalRequest({ scopeId: job.scopeId, jobId: job.id, requestId, authorizedActorId: "U1" });
  await jobs.recordApproval({
    scopeId: job.scopeId,
    jobId: job.id,
    requestId,
    actorId: "U1",
    action: "approve",
    originThreadRef: job.originThreadRef,
    decidedAt: Date.now(),
  });
  return { jobs, job, connectionString };
}

async function insertRun(
  q: ReturnType<typeof createPgPool>["q"],
  id: string,
  status: string,
  result: unknown = null,
  lastStop: unknown = null,
): Promise<void> {
  await q(
    `INSERT INTO runs(id,session_id,status,request,result,created_at,last_stop)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id, `session:${id}`, status, "{}", result === null ? null : JSON.stringify(result), Date.now(), lastStop],
  );
}

function runtimeDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function coreRuntimeAuthority() {
  return {
    artifactBinding: {
      async resolve(input: { idempotencyKey: string }) {
        if (input.idempotencyKey === "artifact-2") {
          return { artifactDigest: "artifact-v2", provisionalRevision: "revision-2" };
        }
        return { artifactDigest: "artifact-sha256", provisionalRevision: "revision-1" };
      },
    },
    workerPolicy: {
      credentials() {
        return { principalId: "U1", expiresAt: Date.now() + 60_000 };
      },
      task(_job: unknown, role: "producer" | "auditor") {
        return role === "producer" ? "Create the approved workbook" : "Audit the current artifact independently";
      },
    },
  };
}

test("approval starts one actionable Producer run without creating an Auditor", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  const grants = createFinnyWorkerGrants(jobs, "runtime-test-secret");
  const opened: string[] = [];
  const openTasks: string[] = [];
  const sessions = {
    async open(input: SessionOpenInput) {
      opened.push(input.name ?? "");
      openTasks.push(input.task);
      const role = input.name === "Finny Auditor" ? "auditor" : "producer";
      const identity = { sessionId: `${role}-session`, runId: `${role}-run` };
      await input.beforeEnqueue?.(identity);
      return { ok: true as const, ...identity, title: input.name ?? role };
    },
  };
  const dispatched: Array<{
    idempotencyKey: string;
    sessionId: string;
    runId: string;
    message: string;
    role: "producer" | "auditor";
    principalId: string;
    expiresAt: number;
  }> = [];
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants,
    sessions,
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        dispatched.push(message);
      },
    },
    ...coreRuntimeAuthority(),
  });

  const result = await coordinator.afterApproved({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    idempotencyKey: "approved-1",
  });

  assert.equal(result, undefined);
  assert.deepEqual(opened, ["Finny Producer"]);
  assert.deepEqual(openTasks, ["Create the approved workbook"]);
  assert.equal(dispatched.length, 0);
  assert.equal((await runtime.currentBinding("parent-session"))?.role, "parent");
  assert.equal((await runtime.currentBinding("producer-session"))?.runId, "producer-run");
  assert.equal(await runtime.currentRoleBinding(job.scopeId, job.id, "auditor"), null);
});

test("atomic BLOCK dispatches only failed controls and repair context to the current Producer", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "a".repeat(64),
    provisionalRevision: "artifact-file-1",
    idempotencyKey: "artifact-ready-atomic-block",
  });
  const current = await jobs.getJob(job.scopeId, job.id);
  assert.ok(current?.sopBinding);
  const attemptId = randomUUID();
  const controls = [
    { id: "source-total", verdict: "pass" as const, evidenceRefs: ["evidence:source-total"], repairActions: [] },
    { id: "mapping-exception", verdict: "pass" as const, evidenceRefs: ["xlsx:Exceptions!A1"], repairActions: [] },
    { id: "formula.recalculate", verdict: "pass" as const, evidenceRefs: ["evidence:formula"], repairActions: [] },
    {
      id: "summary.crossfoot",
      verdict: "block" as const,
      evidenceRefs: ["xlsx:Summary!B7"],
      repairActions: [{ message: "Correct the summary total", workbookRefs: ["xlsx:Summary!B7"] }],
    },
  ];
  await jobs.recordAuditAttempt({
    id: attemptId,
    scopeId: job.scopeId,
    jobId: job.id,
    sopVersionId: current.sopBinding.versionId,
    executionDigest: current.sopBinding.executionDigest,
    artifactFileId: "artifact-file-1",
    artifactSha256: "a".repeat(64),
    artifactMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    artifactSizeBytes: 4096,
    evaluator: TEST_FINNY_EVALUATOR,
    controls,
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
    idempotencyKey: "atomic-block-1",
    completedAt: Date.now(),
  });
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const dispatched: Array<{ role: string; message: string }> = [];
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected Auditor open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(input) {
        dispatched.push(input);
      },
    },
    ...coreRuntimeAuthority(),
  });

  await coordinator.auditAttemptRecorded({
    scopeId: job.scopeId,
    jobId: job.id,
    attemptId,
    artifactDigest: "a".repeat(64),
    verdict: "block",
    controls,
  });

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.role, "producer");
  assert.deepEqual(JSON.parse(dispatched[0]!.message), {
    task: "Rework the blocked artifact",
    failedControls: [
      {
        id: "summary.crossfoot",
        evidenceRefs: ["xlsx:Summary!B7"],
        repairActions: [{ message: "Correct the summary total", workbookRefs: ["xlsx:Summary!B7"] }],
      },
    ],
  });
});

test("completed atomic PASS removes the current artifact from Auditor recovery", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "b".repeat(64),
    provisionalRevision: "artifact-file-pass",
    idempotencyKey: "artifact-ready-atomic-pass",
  });
  const current = await jobs.getJob(job.scopeId, job.id);
  assert.ok(current?.sopBinding);
  await jobs.recordAuditAttempt({
    id: randomUUID(),
    scopeId: job.scopeId,
    jobId: job.id,
    sopVersionId: current.sopBinding.versionId,
    executionDigest: current.sopBinding.executionDigest,
    artifactFileId: "artifact-file-pass",
    artifactSha256: "b".repeat(64),
    artifactMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    artifactSizeBytes: 1024,
    evaluator: TEST_FINNY_EVALUATOR,
    controls: [
      { id: "source-total", verdict: "pass", evidenceRefs: ["evidence:source-total"], repairActions: [] },
      { id: "mapping-exception", verdict: "pass", evidenceRefs: ["xlsx:Exceptions!A1"], repairActions: [] },
      { id: "formula.recalculate", verdict: "pass", evidenceRefs: ["evidence:formula"], repairActions: [] },
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
    verdict: "pass",
    issuerPrincipalId: "finny-deterministic-spreadsheet-worker",
    issuerRunId: "core-audit-run",
    idempotencyKey: "atomic-pass-1",
    completedAt: Date.now(),
  });

  assert.equal(await runtime.currentArtifactNeedsAudit(job.scopeId, job.id), false);
});

test("restart recovery returns an undispatched atomic BLOCK with its exact repair context", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "e".repeat(64),
    provisionalRevision: "artifact-file-recovery",
    idempotencyKey: "artifact-ready-atomic-recovery",
  });
  const current = await jobs.getJob(job.scopeId, job.id);
  assert.ok(current?.sopBinding);
  const attemptId = randomUUID();
  const controls = [
    { id: "source-total", verdict: "pass" as const, evidenceRefs: ["evidence:source-total"], repairActions: [] },
    { id: "mapping-exception", verdict: "pass" as const, evidenceRefs: ["xlsx:Exceptions!A1"], repairActions: [] },
    {
      id: "artifact.structure",
      verdict: "block" as const,
      evidenceRefs: ["xlsx:Workbook"],
      repairActions: [{ message: "Restore the Summary sheet", workbookRefs: ["xlsx:Summary"] }],
    },
  ];
  await jobs.recordAuditAttempt({
    id: attemptId,
    scopeId: job.scopeId,
    jobId: job.id,
    sopVersionId: current.sopBinding.versionId,
    executionDigest: current.sopBinding.executionDigest,
    artifactFileId: "artifact-file-recovery",
    artifactSha256: "e".repeat(64),
    artifactMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    artifactSizeBytes: 1024,
    evaluator: TEST_FINNY_EVALUATOR,
    controls,
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
    idempotencyKey: "atomic-block-recovery",
    completedAt: Date.now(),
  });

  assert.deepEqual(await runtime.pendingRecoveries(), [
    {
      kind: "audit_attempt_recorded",
      scopeId: job.scopeId,
      jobId: job.id,
      attemptId,
      artifactDigest: "e".repeat(64),
      verdict: "block",
      controls,
      idempotencyKey: "atomic-block-recovery",
    },
  ]);
});

test("parent binding refreshes its run only for the same job and principal", async () => {
  const { job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  const sessionId = randomUUID();
  const firstRunId = randomUUID();
  const nextRunId = randomUUID();
  await runtime.bindParent({
    scopeId: job.scopeId,
    jobId: job.id,
    sessionId,
    runId: firstRunId,
    principalId: "U1",
  });
  await runtime.bindParent({
    scopeId: job.scopeId,
    jobId: job.id,
    sessionId,
    runId: nextRunId,
    principalId: "U1",
  });
  assert.equal((await runtime.currentBinding(sessionId))?.runId, nextRunId);
  await assert.rejects(
    runtime.bindParent({
      scopeId: job.scopeId,
      jobId: job.id,
      sessionId,
      runId: randomUUID(),
      principalId: "U2",
    }),
    /parent runtime binding idempotency conflict/,
  );
  assert.equal((await runtime.currentBinding(sessionId))?.runId, nextRunId);
});

test("rejects artifact readiness from a stale producer run", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("unexpected open");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent() {
        throw new Error("unexpected dispatch");
      },
    },
    ...coreRuntimeAuthority(),
  });

  await assert.rejects(
    coordinator.artifactReady({
      sessionId: "producer-session",
      runId: "stale-run",
      scopeId: job.scopeId,
      jobId: job.id,
      idempotencyKey: "artifact-1",
    }),
    /current producer/i,
  );
  assert.equal((await jobs.getJob(job.scopeId, job.id))?.artifactDigest, undefined);
});

test("artifact readiness starts one actionable Auditor run after committing the artifact", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindParent({
    scopeId: job.scopeId,
    jobId: job.id,
    sessionId: "parent-session",
    runId: "parent-run",
    principalId: "U1",
  });
  await runtime.bindWorker({
    scopeId: job.scopeId,
    jobId: job.id,
    sessionId: "producer-session",
    runId: "producer-run",
    role: "producer",
    principalId: "U1",
    epoch: 0,
    expiresAt: Date.now() + 60_000,
  });
  const openTasks: string[] = [];
  let dispatches = 0;
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open(input) {
        openTasks.push(input.task);
        const identity = { sessionId: "auditor-session", runId: "auditor-run" };
        await input.beforeEnqueue?.(identity);
        return { ok: true as const, ...identity, title: input.name ?? "Finny Auditor" };
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent() {
        dispatches += 1;
      },
    },
    ...coreRuntimeAuthority(),
  });

  await coordinator.artifactReady({
    sessionId: "producer-session",
    runId: "producer-run",
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "artifact-1",
  });

  assert.deepEqual(openTasks, ["Audit the current artifact independently"]);
  assert.equal(dispatches, 0);
  assert.equal((await runtime.currentBinding("auditor-session"))?.runId, "auditor-run");
  assert.equal((await jobs.getJob(job.scopeId, job.id))?.artifactDigest, "artifact-sha256");
});

test("replaying approval reuses the active Producer admission", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  let opens = 0;
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open(input) {
        opens += 1;
        const identity = { sessionId: "producer-session", runId: "producer-run" };
        await input.beforeEnqueue?.(identity);
        return { ok: true as const, ...identity, title: input.name ?? "producer" };
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent() {
        throw new Error("approval replay must not enqueue a follow-up turn");
      },
    },
    ...coreRuntimeAuthority(),
  });
  const input = {
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    idempotencyKey: "approved-replay",
  };

  await coordinator.afterApproved(input);
  await coordinator.afterApproved(input);

  assert.equal(opens, 1);
  assert.equal((await runtime.currentRoleBinding(job.scopeId, job.id, "producer"))?.runId, "producer-run");
  assert.equal(await runtime.currentRoleBinding(job.scopeId, job.id, "auditor"), null);
});

test("a terminal Producer run receives a new idempotent grant generation", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  const { q } = createPgPool(connectionString);
  const dispatched: string[] = [];
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open(input) {
        const identity = { sessionId: "producer-session", runId: "producer-run" };
        await input.beforeEnqueue?.(identity);
        return { ok: true as const, ...identity, title: input.name ?? "producer" };
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        dispatched.push(message.idempotencyKey);
        await runtime.advanceWorkerRun({
          sessionId: message.sessionId,
          expectedRunId: message.runId,
          runId: "replacement-producer-run",
          scopeId: job.scopeId,
          expiresAt: Date.now() + 60_000,
          observedTerminalRunId: message.observedTerminalRunId,
        });
      },
    },
    ...coreRuntimeAuthority(),
  });
  const input = {
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    idempotencyKey: "approved-retry",
  };

  await coordinator.afterApproved(input);
  await runtime.advanceWorkerRun({
    sessionId: "producer-session",
    expectedRunId: "producer-run",
    runId: "terminal-producer-run",
    scopeId: job.scopeId,
    expiresAt: Date.now() + 60_000,
  });
  await insertRun(q, "terminal-producer-run", "pending");
  const prematureAdvance = await runtime.advanceWorkerRun({
    sessionId: "producer-session",
    expectedRunId: "terminal-producer-run",
    runId: "replacement-producer-run",
    scopeId: job.scopeId,
    expiresAt: Date.now() + 60_000,
    observedTerminalRunId: "terminal-producer-run",
  });
  assert.equal(prematureAdvance, null);
  await q("UPDATE runs SET status='done',result=$2 WHERE id=$1", [
    "terminal-producer-run",
    JSON.stringify({ status: "ok", reply: "Finished without publishing an artifact" }),
  ]);
  const recovery = { ...input, retryTerminalProducerRunId: "terminal-producer-run" };
  await coordinator.afterApproved(recovery);
  await coordinator.afterApproved(recovery);

  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0] ?? "", /:producer-retry:terminal-producer-run$/);
  assert.equal((await runtime.currentRoleBinding(job.scopeId, job.id, "producer"))?.runId, "replacement-producer-run");
});

test("authenticated Pi reader returns the current active worker binding and job authority", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const { createFinnyCurrentJobReader } = await import("../src/finny/runtime-reader.ts");
  const reader = createFinnyCurrentJobReader({
    jobs,
    runtime,
    authenticateSession: async (sessionId) => sessionId === "producer-session",
  });

  const current = await reader.readCurrentJob({ sessionId: "producer-session" });

  assert.deepEqual(current, {
    schema: "finny-authoritative-job.v1",
    scopeId: job.scopeId,
    jobId: job.id,
    runId: "producer-run",
    role: "producer",
    eventSeq: 0,
    status: "producing",
    policyVersion: job.policy.policyVersion,
    sopVersionId: job.sopBinding?.versionId,
    sopRevision: job.sopBinding?.revision,
    executionDigest: job.sopBinding?.executionDigest,
    artifactDigest: null,
    requiredGenerations: job.policy.requiredGenerations,
  });
  await assert.rejects(reader.readCurrentJob({ sessionId: "auditor-session" }), /authenticate/i);
});

test("concurrent approved callbacks converge on one Producer admission", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  let opens = 0;
  const requests: string[] = [];
  const admissions = new Map<string, Promise<{ ok: true; sessionId: string; runId: string; title: string }>>();
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open(input) {
        assert.ok(input.requestId);
        const requestId = input.requestId;
        requests.push(requestId);
        let admission = admissions.get(requestId);
        if (!admission) {
          admission = (async () => {
            opens += 1;
            const identity = { sessionId: "producer-session", runId: "producer-run" };
            await input.beforeEnqueue?.(identity);
            return { ok: true as const, ...identity, title: input.name ?? "producer" };
          })();
          admissions.set(requestId, admission);
        }
        return admission;
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent() {
        throw new Error("concurrent approval must not enqueue a follow-up turn");
      },
    },
    ...coreRuntimeAuthority(),
  });
  const input = {
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    idempotencyKey: "approved-concurrent",
  };

  await Promise.all([coordinator.afterApproved(input), coordinator.afterApproved(input)]);

  assert.equal(opens, 1);
  assert.ok(requests.length >= 1);
  assert.equal(new Set(requests).size, 1);
  assert.equal((await runtime.currentRoleBinding(job.scopeId, job.id, "producer"))?.runId, "producer-run");
  assert.equal(await runtime.currentRoleBinding(job.scopeId, job.id, "auditor"), null);
});

test("artifact readiness derives artifact and Auditor grant authority from Core dependencies", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  await runtime.retireBinding({ sessionId: "auditor-session", runId: "auditor-run", role: "auditor" });
  const realGrants = createFinnyWorkerGrants(jobs, "runtime-test-secret");
  let issuedPrincipal = "";
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: {
      issueProducer: realGrants.issueProducer,
      async issueAuditor(input) {
        issuedPrincipal = input.principalId;
        return realGrants.issueAuditor(input);
      },
    },
    sessions: {
      async open(input) {
        const identity = { sessionId: "core-auditor-session", runId: "core-auditor-run" };
        await input.beforeEnqueue?.(identity);
        return { ok: true as const, ...identity, title: input.name ?? "Finny Auditor" };
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent() {
        throw new Error("initial Auditor work must not use a follow-up dispatch");
      },
    },
    artifactBinding: {
      async resolve() {
        return { artifactDigest: "core-artifact", provisionalRevision: "core-revision" };
      },
    },
    workerPolicy: {
      credentials() {
        return { principalId: "core-principal", expiresAt: Date.now() + 60_000 };
      },
      task(_job, role) {
        return role === "producer" ? "Core producer task" : "Core Auditor task";
      },
    },
  });

  await coordinator.artifactReady({
    sessionId: "producer-session",
    runId: "producer-run",
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "artifact-core",
  });

  const current = await jobs.getJob(job.scopeId, job.id);
  assert.equal(current?.artifactDigest, "core-artifact");
  assert.equal(current?.provisionalRevision, "core-revision");
  assert.equal(issuedPrincipal, "core-principal");
});

test("artifact action replay retains committed authority and recovers an unfinished audit", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const delivered = new Set<string>();
  let openedAuditors = 0;
  let resolvedArtifact = { artifactDigest: "artifact-sha256", provisionalRevision: "revision-1" };
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open(openInput) {
        openedAuditors += 1;
        const identity = { sessionId: "replay-auditor-session", runId: "replay-auditor-run" };
        await openInput.beforeEnqueue?.(identity);
        return { ok: true as const, ...identity, title: openInput.name ?? "Finny Auditor" };
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        delivered.add(message.idempotencyKey);
      },
    },
    workerPolicy: coreRuntimeAuthority().workerPolicy,
    artifactBinding: {
      async resolve() {
        return resolvedArtifact;
      },
    },
  });
  const input = {
    sessionId: "producer-session",
    runId: "producer-run",
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "artifact-replay-retired",
  };

  await coordinator.artifactReady(input);
  await runtime.retireWorkers(job.scopeId, job.id);
  resolvedArtifact = { artifactDigest: "newer-artifact", provisionalRevision: "newer-revision" };
  await coordinator.artifactReady(input);

  assert.deepEqual([...delivered], []);
  assert.equal(openedAuditors, 1);
  assert.equal((await jobs.getJob(job.scopeId, job.id))?.artifactDigest, "artifact-sha256");
});

test("Auditor admission recovers from committed artifact authority without resolving the proposal again", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindParent({
    scopeId: job.scopeId,
    jobId: job.id,
    sessionId: "parent-session",
    runId: "parent-run",
    principalId: "U1",
  });
  await runtime.bindWorker({
    scopeId: job.scopeId,
    jobId: job.id,
    sessionId: "producer-session",
    runId: "producer-run",
    role: "producer",
    principalId: "U1",
    epoch: 0,
    expiresAt: Date.now() + 60_000,
  });
  const wakes: string[] = [];
  const first = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("Auditor admission interrupted");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent() {
        throw new Error("initial Auditor work must not use a follow-up dispatch");
      },
    },
    recoveryWake(recovery) {
      wakes.push(recovery.idempotencyKey);
    },
    ...coreRuntimeAuthority(),
  });
  const input = {
    sessionId: "producer-session",
    runId: "producer-run",
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "artifact-crash-window",
  };
  await assert.rejects(first.artifactReady(input), /Auditor admission interrupted/);
  assert.deepEqual(wakes, ["artifact-crash-window"]);
  const pending = await runtime.pendingRecoveries();
  assert.deepEqual(pending, [{ kind: "artifact_ready", ...input }]);
  let openedAuditors = 0;
  const restarted = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open(openInput) {
        openedAuditors += 1;
        const identity = { sessionId: "recovered-auditor-session", runId: "recovered-auditor-run" };
        await openInput.beforeEnqueue?.(identity);
        return { ok: true as const, ...identity, title: openInput.name ?? "Finny Auditor" };
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent() {
        throw new Error("initial Auditor work must not use a follow-up dispatch");
      },
    },
    artifactBinding: {
      async resolve() {
        throw new Error("proposal must not be retried");
      },
    },
    workerPolicy: coreRuntimeAuthority().workerPolicy,
  });
  await restarted.artifactReady(pending[0]!);
  assert.equal(openedAuditors, 1);
  assert.equal((await runtime.currentRoleBinding(job.scopeId, job.id, "auditor"))?.runId, "recovered-auditor-run");
  assert.deepEqual(await runtime.pendingRecoveries(), [
    {
      kind: "artifact_ready",
      ...input,
      retryTerminalAuditorRunId: "recovered-auditor-run",
    },
  ]);
  const { q } = createPgPool(connectionString);
  await insertRun(q, "recovered-auditor-run", "done", { status: "pending_approval", pendingApprovals: [] });
  assert.deepEqual(await runtime.pendingRecoveries(), []);
  await q("UPDATE runs SET result=$2 WHERE id=$1", [
    "recovered-auditor-run",
    JSON.stringify({ status: "refused", reason: "human decision required" }),
  ]);
  assert.deepEqual(await runtime.pendingRecoveries(), []);
  await q("UPDATE runs SET result=$2 WHERE id=$1", [
    "recovered-auditor-run",
    JSON.stringify({ status: "ok", reply: "Finished without completing every audit check" }),
  ]);
  const [terminalRecovery] = await runtime.pendingRecoveries();
  assert.deepEqual(terminalRecovery, {
    kind: "artifact_ready",
    ...input,
    retryTerminalAuditorRunId: "recovered-auditor-run",
  });
  const retryDispatches: string[] = [];
  const retry = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("terminal Auditor recovery must reuse its session");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        retryDispatches.push(message.idempotencyKey);
        const nextRunId = "recovered-auditor-retry-run";
        await runtime.advanceWorkerRun({
          sessionId: message.sessionId,
          expectedRunId: message.runId,
          runId: nextRunId,
          scopeId: job.scopeId,
          expiresAt: Date.now() + 60_000,
        });
        await createFinnyWorkerGrants(jobs, "runtime-test-secret").issueAuditor({
          scopeId: job.scopeId,
          jobId: job.id,
          principalId: message.principalId,
          runId: nextRunId,
          expiresAt: Date.now() + 60_000,
        });
        await insertRun(q, nextRunId, "pending");
      },
    },
    artifactBinding: {
      async resolve() {
        throw new Error("proposal must not be retried");
      },
    },
    workerPolicy: coreRuntimeAuthority().workerPolicy,
  });
  await retry.artifactReady(terminalRecovery!);
  await retry.artifactReady(terminalRecovery!);
  assert.equal(retryDispatches.length, 1);
  assert.equal(
    (await runtime.currentRoleBinding(job.scopeId, job.id, "auditor"))?.runId,
    "recovered-auditor-retry-run",
  );
  assert.deepEqual(await runtime.pendingRecoveries(), []);
});

test("runtime reconciliation records a poison recovery and continues with later jobs", async () => {
  const recoveries = [
    {
      kind: "artifact_ready" as const,
      sessionId: "poison-session",
      runId: "poison-run",
      scopeId: "personal:U1",
      jobId: "poison-job",
      idempotencyKey: "poison-artifact",
    },
    {
      kind: "artifact_ready" as const,
      sessionId: "healthy-session",
      runId: "healthy-run",
      scopeId: "personal:U1",
      jobId: "healthy-job",
      idempotencyKey: "healthy-artifact",
    },
  ];
  const attempted: string[] = [];
  const errors: Array<{ error: unknown; recovery: FinnyRuntimeRecovery }> = [];
  await reconcileFinnyRuntimeRecoveries({
    recoveries: async () => recoveries,
    coordinatorFor: async (_scopeId, jobId) => ({
      async artifactReady() {
        attempted.push(jobId);
        if (jobId === "poison-job") throw new Error("poison recovery");
      },
      async auditAttemptRecorded() {
        throw new Error("unexpected atomic audit recovery");
      },
      async verificationReopened() {
        throw new Error("unexpected reverification recovery");
      },
    }),
    recordError: async (error, recovery) => {
      errors.push({ error, recovery });
    },
  });
  assert.deepEqual(attempted, ["poison-job", "healthy-job"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]?.error), /poison recovery/);
  assert.equal(errors[0]?.recovery.idempotencyKey, "poison-artifact");
});

test("restart replays artifact authority committed before the job event", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  await createPgPool(connectionString).q(
    "UPDATE finny_runtime_bindings SET expires_at=$2 WHERE session_id=$1 AND role='auditor'",
    ["auditor-session", Date.now() - 1],
  );
  const input = {
    sessionId: "producer-session",
    runId: "producer-run",
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "artifact-authorized-only",
  };
  await runtime.authorizeAction({
    ...input,
    kind: "artifact_ready",
    role: "producer",
    requestDigest: runtimeDigest({}),
    authorityPayload: { artifactDigest: "artifact-sha256", provisionalRevision: "revision-1" },
  });
  assert.deepEqual(await runtime.pendingRecoveries(), [
    { kind: "artifact_ready", ...input, retryTerminalAuditorRunId: "auditor-run" },
  ]);
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("expired Auditor recovery must reuse its session");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        const expiresAt = Date.now() + 60_000;
        await runtime.advanceWorkerRun({
          sessionId: message.sessionId,
          expectedRunId: message.runId,
          runId: "authority-retry-run",
          scopeId: job.scopeId,
          expiresAt,
        });
        await createFinnyWorkerGrants(jobs, "runtime-test-secret").issueAuditor({
          scopeId: job.scopeId,
          jobId: job.id,
          principalId: message.principalId,
          runId: "authority-retry-run",
          expiresAt,
        });
      },
    },
    artifactBinding: {
      async resolve() {
        throw new Error("proposal must not be retried");
      },
    },
    workerPolicy: coreRuntimeAuthority().workerPolicy,
  });
  const [recovery] = await runtime.pendingRecoveries();
  assert.equal(recovery?.kind, "artifact_ready");
  if (!recovery || recovery.kind !== "artifact_ready") throw new Error("artifact recovery is unavailable");
  await coordinator.artifactReady(recovery);
  assert.equal((await runtime.currentRoleBinding(job.scopeId, job.id, "auditor"))?.runId, "authority-retry-run");
});

test("expired delivered reverification grants return to recovery", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-before-expired-reverify",
  });
  const evaluator = {
    ...TEST_FINNY_EVALUATOR,
    revision: "test-r4",
    buildDigest: "6".repeat(64),
    configurationDigest: "7".repeat(64),
  };
  await jobs.recordEvaluatorCorrection({
    scopeId: job.scopeId,
    jobId: job.id,
    fromEvaluator: TEST_FINNY_EVALUATOR,
    toEvaluator: evaluator,
    idempotencyKey: "expired-reverify-r4",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  const dispatched: string[] = [];
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "auditor-session",
    auditorRunId: "auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("existing Auditor binding should be used");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        dispatched.push(message.idempotencyKey);
        if (!message.idempotencyKey.includes(":retry:")) return;
        await runtime.advanceWorkerRun({
          sessionId: message.sessionId,
          expectedRunId: message.runId,
          runId: "expired-auditor-retry-run",
          scopeId: job.scopeId,
          expiresAt: Date.now() + 60_000,
        });
      },
    },
    ...coreRuntimeAuthority(),
  });
  await coordinator.verificationReopened({
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "expired-reverify-r4",
  });
  const { q } = createPgPool(connectionString);
  await q("UPDATE finny_runtime_bindings SET expires_at=$2 WHERE run_id=$1", ["auditor-run", Date.now() - 1]);
  const recovery = (await runtime.pendingRecoveries()).find(
    (item) => item.kind === "verification_reopened" && item.idempotencyKey === "expired-reverify-r4",
  );
  assert.equal(recovery?.kind === "verification_reopened" && recovery.retryAuditorRunId, "auditor-run");
  await coordinator.verificationReopened(recovery!);
  await coordinator.verificationReopened(recovery!);
  assert.equal(dispatched.filter((key) => key.includes(":retry:")).length, 1);
  assert.equal((await runtime.activeRoleBinding(job.scopeId, job.id, "auditor"))?.runId, "expired-auditor-retry-run");
});

test("fresh reverification admission preserves Auditor human-wait outcomes", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const { q } = createPgPool(connectionString);
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-before-fresh-reverify",
  });
  const evaluator = {
    ...TEST_FINNY_EVALUATOR,
    revision: "test-r4-fresh",
    buildDigest: "c".repeat(64),
    configurationDigest: "d".repeat(64),
  };
  await jobs.recordEvaluatorCorrection({
    scopeId: job.scopeId,
    jobId: job.id,
    fromEvaluator: TEST_FINNY_EVALUATOR,
    toEvaluator: evaluator,
    idempotencyKey: "fresh-reverify-r4",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  const recovery = (await runtime.pendingRecoveries()).find(
    (item) => item.kind === "verification_reopened" && item.idempotencyKey === "fresh-reverify-r4",
  );
  assert.deepEqual(recovery, {
    kind: "verification_reopened",
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "fresh-reverify-r4",
    retryMissingAuditor: true,
  });
  let openedAuditors = 0;
  const coordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open(input) {
        openedAuditors += 1;
        const identity = {
          ok: true as const,
          sessionId: "fresh-reverify-auditor-session",
          runId: "fresh-reverify-auditor-run",
          title: "Finny Auditor",
        };
        await input.beforeEnqueue?.(identity);
        return identity;
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent() {
        throw new Error("fresh Auditor must start with its actionable task");
      },
    },
    ...coreRuntimeAuthority(),
  });
  await coordinator.verificationReopened(recovery!);
  await coordinator.verificationReopened(recovery!);
  assert.equal(openedAuditors, 1);
  await insertRun(q, "fresh-reverify-auditor-run", "done", {
    status: "pending_approval",
    pendingApprovals: [],
  });
  await q("UPDATE finny_runtime_bindings SET expires_at=$2 WHERE run_id=$1", [
    "fresh-reverify-auditor-run",
    Date.now() - 1,
  ]);
  assert.deepEqual(await runtime.pendingRecoveries(), []);
  await q("UPDATE runs SET result=$2 WHERE id=$1", [
    "fresh-reverify-auditor-run",
    JSON.stringify({ status: "refused", reason: "human decision required" }),
  ]);
  assert.deepEqual(await runtime.pendingRecoveries(), []);
  await q("UPDATE runs SET result=$2 WHERE id=$1", [
    "fresh-reverify-auditor-run",
    JSON.stringify({ status: "ok", reply: "Finished without completing every audit check" }),
  ]);
  assert.equal(
    (await runtime.pendingRecoveries()).some(
      (item) => item.kind === "verification_reopened" && item.idempotencyKey === "fresh-reverify-r4",
    ),
    true,
  );
});

test("orphaned delivered reverification retries its observed Auditor once", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-before-orphaned-reverify",
  });
  const evaluator = {
    ...TEST_FINNY_EVALUATOR,
    revision: "test-r5",
    buildDigest: "8".repeat(64),
    configurationDigest: "9".repeat(64),
  };
  await jobs.recordEvaluatorCorrection({
    scopeId: job.scopeId,
    jobId: job.id,
    fromEvaluator: TEST_FINNY_EVALUATOR,
    toEvaluator: evaluator,
    idempotencyKey: "orphaned-reverify-r5",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "orphaned-auditor-session",
    auditorRunId: "orphaned-auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const initialCoordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("existing binding should be used initially");
      },
    },
    dispatcher: { async dispatchPrivateIdempotent() {} },
    ...coreRuntimeAuthority(),
  });
  await initialCoordinator.verificationReopened({
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "orphaned-reverify-r5",
  });
  const recovery = (await runtime.pendingRecoveries()).find(
    (item) => item.kind === "verification_reopened" && item.idempotencyKey === "orphaned-reverify-r5",
  );
  assert.deepEqual(recovery, {
    kind: "verification_reopened",
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "orphaned-reverify-r5",
    retryAuditorRunId: "orphaned-auditor-run",
  });
  let retryDispatches = 0;
  const replacementCoordinator = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("orphaned Auditor retry must reuse its session");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        retryDispatches += 1;
        await runtime.advanceWorkerRun({
          sessionId: message.sessionId,
          expectedRunId: message.runId,
          runId: "replacement-auditor-run",
          scopeId: job.scopeId,
          expiresAt: Date.now() + 60_000,
        });
      },
    },
    ...coreRuntimeAuthority(),
  });
  await replacementCoordinator.verificationReopened(recovery!);
  await replacementCoordinator.verificationReopened(recovery!);
  assert.equal(retryDispatches, 1);
  assert.equal((await runtime.currentRoleBinding(job.scopeId, job.id, "auditor"))?.runId, "replacement-auditor-run");
});

test("terminal delivered reverification retries its observed Auditor", async () => {
  const { jobs, job, connectionString } = await approvedJob();
  const { q } = createPgPool(connectionString);
  await insertRun(q, "terminal-auditor-run", "done", null, "terminal");
  await jobs.recordArtifactReady({
    scopeId: job.scopeId,
    jobId: job.id,
    artifactDigest: "artifact-sha256",
    provisionalRevision: "revision-1",
    idempotencyKey: "artifact-before-terminal-reverify",
  });
  const evaluator = {
    ...TEST_FINNY_EVALUATOR,
    revision: "test-r6",
    buildDigest: "a".repeat(64),
    configurationDigest: "b".repeat(64),
  };
  await jobs.recordEvaluatorCorrection({
    scopeId: job.scopeId,
    jobId: job.id,
    fromEvaluator: TEST_FINNY_EVALUATOR,
    toEvaluator: evaluator,
    idempotencyKey: "terminal-reverify-r6",
  });
  const runtime = createPostgresFinnyRuntimeStore(connectionString);
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId: "parent-session",
    parentRunId: "parent-run",
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId: "producer-session",
    producerRunId: "producer-run",
    auditorSessionId: "terminal-auditor-session",
    auditorRunId: "terminal-auditor-run",
    producerPrincipalId: "U1",
    auditorPrincipalId: "U1",
  });
  const initial = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("initial binding should be reused");
      },
    },
    dispatcher: { async dispatchPrivateIdempotent() {} },
    ...coreRuntimeAuthority(),
  });
  await initial.verificationReopened({
    scopeId: job.scopeId,
    jobId: job.id,
    idempotencyKey: "terminal-reverify-r6",
  });
  const recovery = (await runtime.pendingRecoveries()).find(
    (item) => item.kind === "verification_reopened" && item.idempotencyKey === "terminal-reverify-r6",
  );
  assert.equal(recovery?.kind === "verification_reopened" && recovery.retryAuditorRunId, "terminal-auditor-run");
  const replacement = createFinnyRuntimeCoordinator({
    jobs,
    runtime,
    grants: createFinnyWorkerGrants(jobs, "runtime-test-secret"),
    sessions: {
      async open() {
        throw new Error("terminal Auditor retry must reuse its session");
      },
    },
    dispatcher: {
      async dispatchPrivateIdempotent(message) {
        await runtime.advanceWorkerRun({
          sessionId: message.sessionId,
          expectedRunId: message.runId,
          runId: "terminal-replacement-run",
          scopeId: job.scopeId,
          expiresAt: Date.now() + 60_000,
        });
      },
    },
    ...coreRuntimeAuthority(),
  });
  await replacement.verificationReopened(recovery!);
  assert.equal((await runtime.currentRoleBinding(job.scopeId, job.id, "auditor"))?.runId, "terminal-replacement-run");
});
