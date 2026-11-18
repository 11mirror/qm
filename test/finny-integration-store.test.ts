import { TEST_FINNY_EVALUATOR } from "./support/finny-fixture.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createPostgresFinnyIntegrationStore } from "../src/finny/integration-postgres-store.ts";
import { createFinnyApprovalService } from "../src/finny/approval-service.ts";
import { createPostgresFinnyStore } from "../src/finny/postgres-store.ts";
import { createPostgresFinnyRuntimeStore } from "../src/finny/runtime-postgres-store.ts";
import { initialFinnyPolicy } from "../src/finny/policy.ts";
import { finnySopPlanPresentation } from "../src/finny/plan.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { finnySopJobFields } from "./support/finny-sop-fixture.ts";

test("startup delivery recovery ignores finalized legacy jobs after SOP cutover", async () => {
  const url = testDatabaseUrl();
  const jobs = createPostgresFinnyStore(url);
  const integration = createPostgresFinnyIntegrationStore(url);
  await jobs.searchSopVersions("personal:U1", "missing");
  await integration.pendingPlanIntents();
  const { q } = createPgPool(url);
  const now = Date.now();
  const jobId = randomUUID();
  await q(
    `INSERT INTO finny_jobs(
       id,scope_id,plan_presentation,plan_digest,policy_version,evaluator_ref,required_generations,
       finding_policy,origin_thread_ref,final_receipt,finalized_at,created_at,updated_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$11)`,
    [
      jobId,
      "personal:U1",
      { title: "Legacy", phases: [], certification: "Legacy", deliverable: "Legacy", destination: "Legacy", clarifications: [] },
      "legacy-digest",
      "legacy-policy",
      TEST_FINNY_EVALUATOR,
      {},
      { id: "legacy", maxFindings: 1, maxCodeLength: 1, maxMessageLength: 1 },
      "slack:C1:1.1",
      {},
      now,
    ],
  );
  await q(
    `INSERT INTO finny_integration_jobs(
       job_id,scope_id,request_id,actor_id,origin_thread_ref,destination,parent_binding,created_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      jobId,
      "personal:U1",
      randomUUID(),
      "U1",
      "slack:C1:1.1",
      { type: "slack", target: "C1" },
      { schema: "finny-parent-binding.v1" },
      now,
    ],
  );
  assert.deepEqual(await integration.finalizedParents(), []);
});

test("durably preserves exact parent binding, destination, and artifact proposal idempotency", async () => {
  const url = testDatabaseUrl();
  const jobs = createPostgresFinnyStore(url);
  const integration = createPostgresFinnyIntegrationStore(url);
  const job = await jobs.createJob({
    id: randomUUID(),
    scopeId: "personal:U1",
    ...finnySopJobFields("personal:U1"),
    policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
    findingPolicy: { id: "v1", maxFindings: 2, maxCodeLength: 20, maxMessageLength: 100 },
    originThreadRef: "slack:C1:100.1",
  });
  const parent = {
    scopeId: job.scopeId,
    jobId: job.id,
    requestId: randomUUID(),
    actorId: "U1",
    originThreadRef: job.originThreadRef,
    destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
    binding: {
      schema: "finny-parent-binding.v1" as const,
      sessionId: randomUUID(),
      runId: randomUUID(),
      scopeId: job.scopeId,
      context: {
        actor: { id: "U1", type: "internal" as const },
        conversation: {
          kind: "dm" as const,
          threadRef: job.originThreadRef,
          audience: [{ id: "U1", type: "internal" as const }],
        },
        surface: "slack",
      },
    },
  };
  await integration.createApprovalBoundParent(parent);
  assert.deepEqual(await integration.getParent(job.scopeId, job.id), parent);
  assert.ok(job.sop);
  assert.ok(job.sopBinding);
  await jobs.recordSopAmendment({
    scopeId: job.scopeId,
    jobId: job.id,
    sop: job.sop,
    values: { ...job.sopBinding.values, note: "presentation-only revision" },
    idempotencyKey: randomUUID(),
    createdAt: Date.now(),
    replacementApproval: {
      requestId: randomUUID(),
      actorId: parent.actorId,
      originThreadRef: parent.originThreadRef,
      destination: parent.destination,
      binding: parent.binding,
    },
  });
  assert.deepEqual(await integration.getParent(job.scopeId, job.id), parent);
  const replacementRequestId = randomUUID();
  const amendment = await jobs.recordSopAmendment({
    scopeId: job.scopeId,
    jobId: job.id,
    sop: job.sop,
    values: { ...job.sopBinding.values, cutoff: "2026-11-30" },
    idempotencyKey: randomUUID(),
    createdAt: Date.now(),
    replacementApproval: {
      requestId: replacementRequestId,
      actorId: parent.actorId,
      originThreadRef: parent.originThreadRef,
      destination: parent.destination,
      binding: parent.binding,
    },
  });
  assert.equal(amendment.job.approval, undefined);
  assert.deepEqual(await integration.getParent(job.scopeId, job.id), {
    ...parent,
    requestId: replacementRequestId,
  });
  assert.equal((await jobs.getPendingApprovalRequestForJob(job.scopeId, job.id))?.requestId, replacementRequestId);
  assert.deepEqual(
    (await integration.pendingApprovalCards()).map((record) => record.jobId),
    [job.id],
  );
  const proposal = {
    scopeId: job.scopeId,
    jobId: job.id,
    sessionId: randomUUID(),
    runId: randomUUID(),
    artifactDigest: "digest-1",
    provisionalRevision: "r1",
    idempotencyKey: randomUUID(),
  };
  await integration.saveArtifactProposal(proposal);
  assert.deepEqual(await integration.getArtifactProposal(proposal.idempotencyKey), proposal);
  await integration.saveArtifactProposal(proposal);
  await assert.rejects(
    () => integration.saveArtifactProposal({ ...proposal, artifactDigest: "other" }),
    /idempotency conflict/,
  );
  const intentJob = {
    id: randomUUID(),
    scopeId: "personal:U1",
    ...finnySopJobFields("personal:U1"),
    policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
    findingPolicy: { id: "v1", maxFindings: 2, maxCodeLength: 20, maxMessageLength: 100 },
    originThreadRef: "slack:C1:100.1",
  };
  const intentParent = { ...parent, jobId: intentJob.id, requestId: randomUUID() };
  await integration.createPlanIntent({ job: intentJob, parent: intentParent });
  const migrationDb = createPgPool(url);
  await migrationDb.q("UPDATE finny_plan_intents SET parent_input=parent_input->'parent' WHERE job_id=$1", [
    intentJob.id,
  ]);
  await migrationDb.q("DELETE FROM qm_schema_migrations WHERE id='finny/integration/0002-plan-clarification'");
  const upgradedIntegration = createPostgresFinnyIntegrationStore(url);
  assert.deepEqual(await upgradedIntegration.pendingPlanIntents(), [{ job: intentJob, parent: intentParent }]);
  await jobs.createJob(intentJob);
  await upgradedIntegration.completePlanIntent(intentParent);
  assert.deepEqual(await upgradedIntegration.pendingPlanIntents(), []);
});

test("startup recovery finds approved jobs whose producer dispatch is incomplete", async () => {
  const url = testDatabaseUrl();
  const jobs = createPostgresFinnyStore(url);
  const runtime = createPostgresFinnyRuntimeStore(url);
  const integration = createPostgresFinnyIntegrationStore(url);
  const job = await jobs.createJob({
    id: randomUUID(),
    scopeId: "personal:U1",
    ...finnySopJobFields("personal:U1"),
    policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
    findingPolicy: { id: "v1", maxFindings: 2, maxCodeLength: 20, maxMessageLength: 100 },
    originThreadRef: "slack:C1:100.1",
  });
  const requestId = randomUUID();
  await jobs.createApprovalRequest({ scopeId: job.scopeId, jobId: job.id, requestId, authorizedActorId: "U1" });
  await integration.createApprovalBoundParent({
    scopeId: job.scopeId,
    jobId: job.id,
    requestId,
    actorId: "U1",
    originThreadRef: job.originThreadRef,
    destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
    binding: {
      schema: "finny-parent-binding.v1",
      sessionId: randomUUID(),
      runId: randomUUID(),
      scopeId: job.scopeId,
      context: {
        actor: { id: "U1", type: "internal" as const },
        conversation: {
          kind: "dm" as const,
          threadRef: job.originThreadRef,
          audience: [{ id: "U1", type: "internal" as const }],
        },
        surface: "slack",
      },
    },
  });
  await jobs.recordApproval({
    scopeId: job.scopeId,
    jobId: job.id,
    requestId,
    actorId: "U1",
    action: "approve",
    originThreadRef: job.originThreadRef,
    decidedAt: Date.now(),
  });
  await runtime.currentBinding(randomUUID());
  const producerRunId = randomUUID();
  const { q } = createPgPool(url);
  await q(`CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,last_stop TEXT,result TEXT)`);
  await q("INSERT INTO runs(id,status,last_stop,result) VALUES($1,'running',NULL,NULL)", [producerRunId]);
  const parentSessionId = randomUUID();
  const producerSessionId = randomUUID();
  const auditorSessionId = randomUUID();
  await runtime.bindInitial({
    scopeId: job.scopeId,
    jobId: job.id,
    parentSessionId,
    parentRunId: randomUUID(),
    parentPrincipalId: "U1",
    producerExpiresAt: Date.now() + 60_000,
    auditorExpiresAt: Date.now() + 60_000,
    producerSessionId,
    producerRunId,
    auditorSessionId,
    auditorRunId: randomUUID(),
    producerPrincipalId: "producer",
    auditorPrincipalId: "auditor",
  });
  assert.deepEqual(await integration.approvedIncomplete(), []);
  await q("UPDATE runs SET status='done',result=$2 WHERE id=$1", [
    producerRunId,
    JSON.stringify({ status: "pending_approval", pendingApprovals: [] }),
  ]);
  assert.deepEqual(await integration.approvedIncomplete(), []);
  await q("UPDATE runs SET result=$2 WHERE id=$1", [
    producerRunId,
    JSON.stringify({ status: "refused", reason: "human decision required" }),
  ]);
  assert.deepEqual(await integration.approvedIncomplete(), []);
  await q("UPDATE runs SET status='done',result=$2 WHERE id=$1", [
    producerRunId,
    JSON.stringify({ status: "ok", reply: "Finished without an artifact" }),
  ]);
  assert.deepEqual(await integration.approvedIncomplete(), [
    {
      ...(await integration.getParent(job.scopeId, job.id))!,
      retryTerminalProducerRunId: producerRunId,
    },
  ]);
  await q("UPDATE runs SET status='running',result=NULL WHERE id=$1", [producerRunId]);
  const originalProducer = await runtime.currentBinding(producerSessionId);
  assert.equal(
    await runtime.claimParentTurn({
      sessionId: producerSessionId,
      runId: randomUUID(),
      scopeId: job.scopeId,
      principalId: "producer",
    }),
    null,
  );
  assert.deepEqual(await runtime.currentBinding(producerSessionId), originalProducer);
  const currentRunId = randomUUID();
  assert.equal(
    (
      await runtime.advanceWorkerRun({
        sessionId: producerSessionId,
        expectedRunId: originalProducer!.runId,
        runId: currentRunId,
        scopeId: job.scopeId,
        expiresAt: Date.now() + 60_000,
      })
    )?.runId,
    currentRunId,
  );
  await runtime.bindWorker({
    scopeId: job.scopeId,
    jobId: job.id,
    sessionId: producerSessionId,
    runId: originalProducer!.runId,
    role: "producer",
    principalId: "producer",
    epoch: 0,
    expiresAt: Date.now() + 60_000,
  });
  assert.equal((await runtime.currentBinding(producerSessionId))?.runId, currentRunId);
  await runtime.retireJob(job.scopeId, job.id);
  const secondJob = await jobs.createJob({
    id: randomUUID(),
    scopeId: job.scopeId,
    ...finnySopJobFields(job.scopeId),
    policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
    findingPolicy: { id: "v1", maxFindings: 2, maxCodeLength: 20, maxMessageLength: 100 },
    originThreadRef: job.originThreadRef,
  });
  await runtime.bindParent({
    scopeId: secondJob.scopeId,
    jobId: secondJob.id,
    sessionId: parentSessionId,
    runId: randomUUID(),
    principalId: "U1",
  });
  assert.equal((await runtime.currentBinding(parentSessionId))?.jobId, secondJob.id);
  assert.deepEqual(
    (await integration.approvedIncomplete()).map((record) => record.jobId),
    [job.id],
  );
});

test("material clarification keeps approval fail closed and restart recovery releases only the recommendation", async () => {
  const url = testDatabaseUrl();
  const jobs = createPostgresFinnyStore(url);
  const integration = createPostgresFinnyIntegrationStore(url);
  const jobInput = {
    id: randomUUID(),
    scopeId: "personal:U1",
    ...finnySopJobFields("personal:U1"),
    values: { cutoff: "2026-10-31", currency: "Signed contracts" },
    policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
    findingPolicy: { id: "v1", maxFindings: 2, maxCodeLength: 20, maxMessageLength: 100 },
    originThreadRef: "slack:C1:100.1",
  };
  const parent = {
    scopeId: jobInput.scopeId,
    jobId: jobInput.id,
    requestId: randomUUID(),
    actorId: "U1",
    originThreadRef: jobInput.originThreadRef,
    destination: { type: "slack" as const, target: "C1:100.1", threadTs: "100.1" },
    binding: {
      schema: "finny-parent-binding.v1" as const,
      sessionId: randomUUID(),
      runId: randomUUID(),
      scopeId: jobInput.scopeId,
      context: {
        actor: { id: "U1", type: "internal" as const },
        conversation: {
          kind: "dm" as const,
          threadRef: jobInput.originThreadRef,
          audience: [{ id: "U1", type: "internal" as const }],
        },
        surface: "slack",
      },
    },
  };
  const clarification = {
    scopeId: jobInput.scopeId,
    jobId: jobInput.id,
    requestId: randomUUID(),
    authorizedActorId: "U1",
    question: "Which basis?",
    options: [
      { id: "contracts", label: "Signed contracts" },
      { id: "invoices", label: "Issued invoices" },
    ],
    recommendedOptionId: "contracts",
    idempotencyKey: `clarification:${jobInput.id}`,
  };
  await jobs.getJob(jobInput.scopeId, jobInput.id);
  await integration.createPlanIntent({ job: jobInput, parent, clarification });
  await jobs.createJob(jobInput);
  const restarted = createPostgresFinnyIntegrationStore(url);
  assert.deepEqual(await restarted.pendingPlanIntents(), [{ job: jobInput, parent, clarification }]);
  await restarted.completePlanIntent(parent, clarification);
  assert.deepEqual(
    (await restarted.pendingClarificationCards()).map((record) => ({
      jobId: record.jobId,
      requestId: record.clarificationRequestId,
      question: record.question,
    })),
    [{ jobId: jobInput.id, requestId: clarification.requestId, question: clarification.question }],
  );
  assert.deepEqual(await restarted.pendingApprovalCards(), []);
  assert.equal((await jobs.getApprovalRequest(parent.requestId))?.readyAt, undefined);
  await assert.rejects(
    jobs.recordApproval({
      scopeId: parent.scopeId,
      jobId: parent.jobId,
      requestId: parent.requestId,
      actorId: parent.actorId,
      action: "approve",
      originThreadRef: parent.originThreadRef,
      decidedAt: Date.now(),
    }),
    /not ready/i,
  );
  let readyCallbacks = 0;
  const approvals = createFinnyApprovalService({
    store: jobs,
    identity: {
      resolve: (actor) => ({ id: actor.externalId, type: "internal" as const }),
      isInternal: (principal) => principal.type === "internal",
    },
    onApproved: async () => undefined,
    onClarificationReady: async () => {
      readyCallbacks += 1;
    },
  });
  assert.equal(await approvals.pending(parent.requestId), null);
  const presentation = finnySopPlanPresentation(jobInput.sop, jobInput.values);
  assert.deepEqual(
    await approvals.decide({
      requestId: clarification.requestId,
      actor: { externalId: "U1" },
      slack: { channel: "C1", messageTs: "100.2", threadTs: "100.1" },
      decision: { kind: "clarification", action: "select", optionId: "contracts" },
    }),
    {
      kind: "result",
      card: {
        title: "Clarification recorded",
        status: "passed",
        summary: "Signed contracts. The plan is ready for approval.",
      },
      next: {
        kind: "plan",
        requestId: parent.requestId,
        card: {
          title: presentation.title,
          summary: presentation.summary,
          phases: presentation.phases,
          certification: presentation.certification,
          deliverable: presentation.deliverable,
          destination: presentation.destination,
        },
      },
    },
  );
  assert.equal(readyCallbacks, 1);
  assert.equal((await approvals.pending(parent.requestId))?.kind, "plan");
  assert.ok((await jobs.getApprovalRequest(parent.requestId))?.readyAt);
  assert.deepEqual(
    (await createPostgresFinnyIntegrationStore(url).pendingApprovalCards()).map((record) => record.jobId),
    [jobInput.id],
  );
});

test("nonrecommended and Other clarification decisions permanently withhold the stale plan", async () => {
  const url = testDatabaseUrl();
  const jobs = createPostgresFinnyStore(url);
  const integration = createPostgresFinnyIntegrationStore(url);
  for (const decision of [{ kind: "option" as const, optionId: "invoices" }, { kind: "other" as const }]) {
    const job = await jobs.createJob({
      id: randomUUID(),
      scopeId: "personal:U1",
      ...finnySopJobFields("personal:U1"),
      values: { cutoff: "2026-10-31", currency: "Signed contracts" },
      policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
      findingPolicy: { id: "v1", maxFindings: 2, maxCodeLength: 20, maxMessageLength: 100 },
      originThreadRef: "slack:C1:100.1",
    });
    const requestId = randomUUID();
    const clarificationId = randomUUID();
    await integration.createApprovalBoundParent(
      {
        scopeId: job.scopeId,
        jobId: job.id,
        requestId,
        actorId: "U1",
        originThreadRef: job.originThreadRef,
        destination: { type: "slack", target: "C1:100.1", threadTs: "100.1" },
        binding: {
          schema: "finny-parent-binding.v1",
          sessionId: randomUUID(),
          runId: randomUUID(),
          scopeId: job.scopeId,
          context: {
            actor: { id: "U1", type: "internal" },
            conversation: {
              kind: "dm",
              threadRef: job.originThreadRef,
              audience: [{ id: "U1", type: "internal" }],
            },
            surface: "slack",
          },
        },
      },
      {
        scopeId: job.scopeId,
        jobId: job.id,
        requestId: clarificationId,
        authorizedActorId: "U1",
        question: "Which basis?",
        options: [
          { id: "contracts", label: "Signed contracts" },
          { id: "invoices", label: "Issued invoices" },
        ],
        recommendedOptionId: "contracts",
        idempotencyKey: `clarification:${job.id}`,
      },
    );
    await jobs.recordClarificationDecision({
      requestId: clarificationId,
      actorId: "U1",
      originThreadRef: job.originThreadRef,
      decision,
      decidedAt: Date.now(),
    });
    assert.equal((await jobs.getApprovalRequest(requestId))?.readyAt, undefined);
    assert.equal(
      (await integration.pendingApprovalCards()).some((record) => record.jobId === job.id),
      false,
    );
  }
});
