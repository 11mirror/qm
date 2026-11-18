import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { canonicalFinnyExecutionDigest } from "../src/finny/plan.ts";
import { initialFinnyPolicy } from "../src/finny/policy.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresFinnyStore } from "../src/finny/postgres-store.ts";
import type { FinnySopVersion } from "../src/finny/types.ts";
import { finnySopFixture } from "./support/finny-sop-fixture.ts";
import { TEST_FINNY_EVALUATOR } from "./support/finny-fixture.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

interface StoredSopVersion {
  versionId: string;
  definitionDigest: string;
  sop: FinnySopVersion;
  createdAt: number;
}

interface SopStore {
  createSopVersion?: (sop: unknown) => Promise<StoredSopVersion>;
  getSopVersion?: (scopeId: string, versionId: string) => Promise<StoredSopVersion | null>;
  searchSopVersions?: (scopeId: string, query: string) => Promise<StoredSopVersion[]>;
  recordSopAmendment?: (input: {
    scopeId: string;
    jobId: string;
    sop: unknown;
    values: Record<string, string | boolean>;
    idempotencyKey: string;
    createdAt: number;
  }) => Promise<{ job: unknown; events: Array<{ idempotencyKey: string; payload: Record<string, unknown> }> }>;
}

function sopJobInput() {
  const sop = finnySopFixture();
  return {
    id: randomUUID(),
    scopeId: sop.scopeId,
    sop,
    values: { cutoff: "2026-10-31", currency: "INR", note: "first run" },
    policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
    findingPolicy: {
      id: "finny-sop-test",
      maxFindings: 8,
      maxCodeLength: 80,
      maxMessageLength: 2_000,
    },
    originThreadRef: "slack:C1:100.1",
  };
}

test("persists immutable scope-bound SOP versions across store restarts", async () => {
  const url = testDatabaseUrl();
  const store = createPostgresFinnyStore(url) as ReturnType<typeof createPostgresFinnyStore> & SopStore;
  assert.equal(typeof store.createSopVersion, "function");
  assert.equal(typeof store.getSopVersion, "function");
  const sop = finnySopFixture();
  const created = await store.createSopVersion!(sop);
  assert.equal(created.versionId, "org%3Ainvented-media-company/ap-aging@3");
  assert.match(created.definitionDigest, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(created.sop, sop);
  assert.deepEqual(await store.createSopVersion!(structuredClone(sop)), created);
  const restarted = createPostgresFinnyStore(url) as ReturnType<typeof createPostgresFinnyStore> & SopStore;
  assert.deepEqual(await restarted.getSopVersion!(sop.scopeId, created.versionId), created);
  assert.equal(await restarted.getSopVersion!("org:other", created.versionId), null);
  await assert.rejects(
    store.createSopVersion!({ ...sop, title: "Conflicting title" }),
    /immutable|version|conflict/i,
  );
  const { q } = createPgPool(url);
  await assert.rejects(q("UPDATE finny_sop_versions SET search_text='changed' WHERE version_id=$1", [created.versionId]),
    /immutable/i,
  );
  await assert.rejects(q("DELETE FROM finny_sop_versions WHERE version_id=$1", [created.versionId]), /immutable/i);
});

test("searches SOP versions only inside the requested scope", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl()) as ReturnType<typeof createPostgresFinnyStore> & SopStore;
  assert.equal(typeof store.searchSopVersions, "function");
  const sop = finnySopFixture();
  const expected = await store.createSopVersion!(sop);
  await store.createSopVersion!({ ...sop, scopeId: "org:other" });
  assert.deepEqual(await store.searchSopVersions!(sop.scopeId, "NetSuite vendor aging"), [expected]);
  assert.deepEqual(await store.searchSopVersions!(sop.scopeId, "customer collections"), []);
  await assert.rejects(store.searchSopVersions!(sop.scopeId, " "), /query/i);
});

test("binds a job to its exact SOP version, values, digest, and revision across restarts", async () => {
  const url = testDatabaseUrl();
  const store = createPostgresFinnyStore(url);
  const input = sopJobInput();
  const { sop, values } = input;
  const created = await store.createJob(input as never);
  assert.equal("plan" in created, false);
  assert.deepEqual((created as unknown as Record<string, unknown>).sop, sop);
  assert.deepEqual((created as unknown as Record<string, unknown>).sopBinding, {
    versionId: "org%3Ainvented-media-company/ap-aging@3",
    values,
    executionDigest: canonicalFinnyExecutionDigest(sop, values),
    revision: 1,
  });
  const restarted = createPostgresFinnyStore(url);
  assert.deepEqual(await restarted.getJob(sop.scopeId, input.id), created);
  assert.equal(await restarted.getJob("org:other", input.id), null);
});

test("approval authorizes the exact current execution digest", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl());
  const input = sopJobInput();
  const job = await store.createJob(input as never);
  const binding = (job as unknown as { sopBinding: { executionDigest: string } }).sopBinding;
  const requestId = randomUUID();
  await store.createApprovalRequest({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId,
    authorizedActorId: "U1",
  });
  const request = await store.getApprovalRequest(requestId);
  assert.equal((request as unknown as { executionDigest: string }).executionDigest, binding.executionDigest);
  assert.equal("planDigest" in (request as unknown as Record<string, unknown>), false);
  const approved = await store.recordApproval({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId,
    actorId: "U1",
    action: "approve",
    originThreadRef: input.originThreadRef,
    decidedAt: Date.now(),
  });
  assert.equal(
    (approved.approval as unknown as { executionDigest: string }).executionDigest,
    binding.executionDigest,
  );
  assert.equal("planDigest" in (approved.approval as unknown as Record<string, unknown>), false);
});

test("records every SOP revision while invalidating approval only for material amendments", async () => {
  const store = createPostgresFinnyStore(testDatabaseUrl()) as ReturnType<typeof createPostgresFinnyStore> & SopStore;
  assert.equal(typeof store.recordSopAmendment, "function");
  const input = sopJobInput();
  const created = await store.createJob(input as never);
  const requestId = randomUUID();
  await store.createApprovalRequest({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId,
    authorizedActorId: "U1",
  });
  await store.recordApproval({
    scopeId: input.scopeId,
    jobId: input.id,
    requestId,
    actorId: "U1",
    action: "approve",
    originThreadRef: input.originThreadRef,
    decidedAt: Date.now(),
  });
  const originalBinding = (created as unknown as { sopBinding: { executionDigest: string } }).sopBinding;
  const nonMaterial = await store.recordSopAmendment!({
    scopeId: input.scopeId,
    jobId: input.id,
    sop: input.sop,
    values: { ...input.values, note: "second run" },
    idempotencyKey: randomUUID(),
    createdAt: Date.now(),
  });
  const nonMaterialJob = nonMaterial.job as {
    approval?: { executionDigest: string };
    sopBinding: { values: Record<string, string | boolean>; executionDigest: string; revision: number };
  };
  assert.equal(nonMaterialJob.sopBinding.revision, 2);
  assert.equal(nonMaterialJob.sopBinding.executionDigest, originalBinding.executionDigest);
  assert.equal(nonMaterialJob.sopBinding.values.note, "second run");
  assert.equal(nonMaterialJob.approval?.executionDigest, originalBinding.executionDigest);
  const material = await store.recordSopAmendment!({
    scopeId: input.scopeId,
    jobId: input.id,
    sop: input.sop,
    values: { ...input.values, cutoff: "2026-11-30", note: "second run" },
    idempotencyKey: randomUUID(),
    createdAt: Date.now() + 1,
  });
  const materialReplay = await store.recordSopAmendment!({
    scopeId: input.scopeId,
    jobId: input.id,
    sop: input.sop,
    values: { ...input.values, cutoff: "2026-11-30", note: "second run" },
    idempotencyKey: material.events[0]!.idempotencyKey,
    createdAt: Date.now() + 2,
  });
  assert.equal((materialReplay as { deduped?: boolean }).deduped, true);
  const materialJob = material.job as {
    approval?: unknown;
    sopBinding: { executionDigest: string; revision: number };
    policy: { requiredGenerations: Record<string, number> };
  };
  assert.equal(materialJob.sopBinding.revision, 3);
  assert.notEqual(materialJob.sopBinding.executionDigest, originalBinding.executionDigest);
  assert.equal(materialJob.approval, undefined);
  assert.deepEqual(
    materialJob.policy.requiredGenerations,
    Object.fromEntries(
      Object.entries(input.policy.requiredGenerations).map(([checkId, generation]) => [checkId, generation + 1]),
    ),
  );
  assert.deepEqual(material.events[0]?.payload, {
    previousSopVersionId: "org%3Ainvented-media-company/ap-aging@3",
    newSopVersionId: "org%3Ainvented-media-company/ap-aging@3",
    previousValues: { ...input.values, note: "second run" },
    newValues: { ...input.values, cutoff: "2026-11-30", note: "second run" },
    previousExecutionDigest: originalBinding.executionDigest,
    newExecutionDigest: materialJob.sopBinding.executionDigest,
    revision: 3,
  });
});

test("behavioral cutover refuses an unfinished legacy plan job", async () => {
  const url = testDatabaseUrl();
  const store = createPostgresFinnyStore(url);
  await store.searchSopVersions("personal:U1", "missing");
  const db = createPgPool(url);
  await db.q("ALTER TABLE finny_jobs DROP CONSTRAINT finny_jobs_sop_cutover_mode");
  const now = Date.now();
  await db.q(
    `INSERT INTO finny_jobs(
       id,scope_id,plan_presentation,plan_digest,policy_version,evaluator_ref,required_generations,
       finding_policy,origin_thread_ref,created_at,updated_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
    [
      randomUUID(),
      "personal:U1",
      { title: "Legacy", phases: [], certification: "Legacy", deliverable: "Legacy", destination: "Legacy", clarifications: [] },
      "legacy-digest",
      "legacy-policy",
      TEST_FINNY_EVALUATOR,
      {},
      { id: "legacy", maxFindings: 1, maxCodeLength: 1, maxMessageLength: 1 },
      "slack:C1:1.1",
      now,
    ],
  );
  await db.q("DELETE FROM qm_schema_migrations WHERE id='finny/store/0013-sop-cutover'");
  const cutover = createPostgresFinnyStore(url);
  await assert.rejects(cutover.searchSopVersions("personal:U1", "missing"), /unfinished legacy Finny jobs/i);
});

test("behavioral cutover permanently rejects new unfinished legacy jobs", async () => {
  const url = testDatabaseUrl();
  const store = createPostgresFinnyStore(url);
  await store.searchSopVersions("personal:U1", "missing");
  const db = createPgPool(url);
  const now = Date.now();
  await assert.rejects(
    db.q(
      `INSERT INTO finny_jobs(
         id,scope_id,plan_presentation,plan_digest,policy_version,evaluator_ref,required_generations,
         finding_policy,origin_thread_ref,created_at,updated_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [
        randomUUID(),
        "personal:U1",
        { title: "Legacy", phases: [], certification: "Legacy", deliverable: "Legacy", destination: "Legacy", clarifications: [] },
        "legacy-digest",
        "legacy-policy",
        TEST_FINNY_EVALUATOR,
        {},
        { id: "legacy", maxFindings: 1, maxCodeLength: 1, maxMessageLength: 1 },
        "slack:C1:1.1",
        now,
      ],
    ),
    /finny_jobs_sop_cutover_mode/i,
  );
});

test("behavioral cutover refuses a legacy plan intent awaiting job creation", async () => {
  const url = testDatabaseUrl();
  const db = createPgPool(url);
  await db.q(`CREATE TABLE finny_plan_intents(
    job_id TEXT PRIMARY KEY,
    job_input JSONB NOT NULL,
    parent_input JSONB NOT NULL,
    created_at BIGINT NOT NULL
  )`);
  await db.q(
    "INSERT INTO finny_plan_intents(job_id,job_input,parent_input,created_at) VALUES($1,$2,$3,$4)",
    [randomUUID(), { plan: { title: "Legacy" } }, {}, Date.now()],
  );
  const cutover = createPostgresFinnyStore(url);
  await assert.rejects(cutover.searchSopVersions("personal:U1", "missing"), /plan intents await job creation/i);
});

test("behavioral cutover permanently rejects new legacy plan intents", async () => {
  const url = testDatabaseUrl();
  const db = createPgPool(url);
  await db.q(`CREATE TABLE finny_plan_intents(
    job_id TEXT PRIMARY KEY,
    job_input JSONB NOT NULL,
    parent_input JSONB NOT NULL,
    created_at BIGINT NOT NULL
  )`);
  await db.q(
    "INSERT INTO finny_plan_intents(job_id,job_input,parent_input,created_at) VALUES($1,$2,$3,$4)",
    [randomUUID(), { sop: { id: "current" } }, {}, Date.now()],
  );
  const store = createPostgresFinnyStore(url);
  await store.searchSopVersions("personal:U1", "missing");
  await assert.rejects(
    db.q(
      "INSERT INTO finny_plan_intents(job_id,job_input,parent_input,created_at) VALUES($1,$2,$3,$4)",
      [randomUUID(), { plan: { title: "Legacy" } }, {}, Date.now()],
    ),
    /finny_plan_intents_sop_cutover_mode/i,
  );
});

test("behavioral cutover refuses a finalized legacy receipt awaiting delivery", async () => {
  const url = testDatabaseUrl();
  const store = createPostgresFinnyStore(url);
  await store.searchSopVersions("personal:U1", "missing");
  const db = createPgPool(url);
  const now = Date.now();
  const jobId = randomUUID();
  await db.q(
    `INSERT INTO finny_jobs(
       id,scope_id,plan_presentation,plan_digest,policy_version,evaluator_ref,required_generations,
       finding_policy,origin_thread_ref,ledger_head,final_receipt,finalized_at,created_at,updated_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12)`,
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
      7,
      {},
      now,
    ],
  );
  await db.q(`CREATE TABLE deliveries(
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    destination JSONB NOT NULL,
    text TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    delivered_at BIGINT
  )`);
  await db.q(
    `INSERT INTO deliveries(id,idempotency_key,destination,text,created_at,delivered_at)
     VALUES($1,$2,$3,$4,$5,NULL)`,
    [randomUUID(), `finny-final:${jobId}:7`, { type: "slack", target: "C1" }, "Legacy final", now],
  );
  await db.q("DELETE FROM qm_schema_migrations WHERE id='finny/store/0013-sop-cutover'");
  const cutover = createPostgresFinnyStore(url);
  await assert.rejects(cutover.searchSopVersions("personal:U1", "missing"), /final receipts await delivery/i);
});
