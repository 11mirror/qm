import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createFinnyToolServiceFactory, finnyTurnAuthority } from "../src/finny/integration.ts";
import { canonicalFinnyExecutionDigest, finnySopVersionId } from "../src/finny/plan.ts";
import { initialFinnyPolicy } from "../src/finny/policy.ts";
import { uploadAttachments } from "../src/slack/attachments.ts";
import type { FinnyJob, FinnyEvaluatorRef } from "../src/finny/types.ts";
import type { CreateFinnyJobCommand } from "../src/finny/store.ts";
import type { SpreadsheetWorkerResult } from "../src/finny/deterministic-spreadsheet-worker.ts";
import type { OutgoingAttachment } from "../src/types.ts";
import { finnySopFixture } from "./support/finny-sop-fixture.ts";

const evaluator: FinnyEvaluatorRef = {
  id: "libreoffice-calc",
  revision: "24.2.7-r1",
  buildDigest: "a".repeat(64),
  contractVersion: "finny.spreadsheet-worker.v2",
  configurationDigest: "b".repeat(64),
};

test("Spike 1: resolver.md maps financial user query to approved domain skill and invariants", () => {
  const routerResolver = join(process.cwd(), "work/qm-finance-skill-pack/skills/finance-router/references/resolver.md");
  assert.ok(existsSync(routerResolver), "finance router resolver.md must exist in repo");

  const routerText = readFileSync(routerResolver, "utf8");
  assert.ok(routerText.includes("Accounts payable"), "Must contain AP intent classification");
  assert.ok(routerText.includes("sharechat-ar-collection"), "Must map AR collection skill");
});

test("Spike 2: Preflight harness calls finny_create_plan and enters human approval state", async () => {
  const deliveries: Array<Record<string, unknown>> = [];
  const factory = createFinnyToolServiceFactory({
    config: {
      findingPolicy: { id: "p1", maxFindings: 5, maxCodeLength: 32, maxMessageLength: 500 },
      maxReworks: 3,
      workerGrantTtlMs: 3600_000,
      spreadsheetEngine: {
        url: "https://engine.example",
        name: "test",
        version: "1",
        timeoutMs: 1000,
        maxResponseBytes: 100_000,
        maxArtifactBytes: 100_000,
        evaluator,
      },
      maxEvidenceBytes: 100_000,
    },
    jobs: {
      async createJob(input: CreateFinnyJobCommand) {
        return {
          id: input.id,
          scopeId: input.scopeId,
          sop: input.sop,
          sopBinding: {
            versionId: finnySopVersionId(input.sop),
            values: input.values,
            executionDigest: canonicalFinnyExecutionDigest(input.sop, input.values),
            revision: 1,
          },
          policy: initialFinnyPolicy(evaluator),
        } as unknown as FinnyJob;
      },
      async getJob() {
        return null;
      },
      async getApprovalRequest() {
        return null;
      },
      async recordSopAmendment() {
        return {} as never;
      },
      async recordAuditAttempt() {
        return {} as never;
      },
      async getAuditAttempt() {
        return null;
      },
      async getAuditAttemptByOperation() {
        return null;
      },
      async completeAuditJudgment() {
        return {} as never;
      },
    },
    runtime: {
      async currentBinding() {
        return null;
      },
      async claimParentTurn() {
        return null;
      },
    },
    integration: {
      async createPlanIntent() {},
      async completePlanIntent() {},
      async getParent() {
        return null;
      },
    } as unknown as Parameters<typeof createFinnyToolServiceFactory>[0]["integration"],
    deliveries: {
      async enqueue(delivery: unknown) {
        deliveries.push(delivery as Record<string, unknown>);
        return delivery as unknown as Parameters<
          Parameters<typeof createFinnyToolServiceFactory>[0]["deliveries"]["enqueue"]
        >[0];
      },
    } as unknown as Parameters<typeof createFinnyToolServiceFactory>[0]["deliveries"],
    certifyResult: async () => {},
    deliverCertifiedResults: async () => {},
    coordinator: {} as unknown as Parameters<typeof createFinnyToolServiceFactory>[0]["coordinator"],
    files: {} as unknown as Parameters<typeof createFinnyToolServiceFactory>[0]["files"],
    deterministicSpreadsheetWorker: {} as unknown as Parameters<
      typeof createFinnyToolServiceFactory
    >[0]["deterministicSpreadsheetWorker"],
  });

  const turn = {
    scopeId: "org:sharechat",
    sessionId: "sess-parent",
    runId: "run-parent",
    actor: { id: "user-kali", type: "internal" as const },
    originThreadRef: "slack:C123:1794000.123",
    destination: { type: "slack" as const, target: "C123:1794000.123", threadTs: "1794000.123" },
    parent: true,
    parentBinding: {
      schema: "finny-parent-binding.v1" as const,
      sessionId: "sess-parent",
      runId: "run-parent",
      scopeId: "org:sharechat",
      context: {
        actor: { id: "user-kali", type: "internal" as const },
        conversation: { kind: "channel" as const, threadRef: "C123", audience: [] },
        surface: "slack",
      },
    },
  };

  const service = await factory.forTurn(turn);
  assert.ok(service, "Service should be instantiated for valid parent turn");

  const sop = {
    ...finnySopFixture(),
    scopeId: "org:sharechat",
    title: "Prepare AP Closing Liability | 4 Vendors x 4 Quarter-Ends",
  };
  const planResponse = await service.createPlan(sop, { cutoff: "2026-09-30", currency: "INR" });
  assert.match(planResponse.message, /is awaiting approval/);
  assert.equal(deliveries.length, 1, "Should enqueue exactly one Slack Block Kit approval card");
  const dest = deliveries[0]?.destination;
  assert.ok(dest && typeof dest === "object" && "target" in dest);
  assert.equal(dest.target, "C123:1794000.123");
});

test("Spike 3: Auditor executes deterministic audit and passes with valid evidence envelope", async () => {
  let auditExecuted = false;
  const dummyPayload = Buffer.from("dummy-xlsx-content");
  const dummyDigest = createHash("sha256").update(dummyPayload).digest("hex");
  const dummyFileId = "file-artifact-rev1";

  const factory = createFinnyToolServiceFactory({
    config: {
      findingPolicy: { id: "p1", maxFindings: 5, maxCodeLength: 32, maxMessageLength: 500 },
      maxReworks: 3,
      workerGrantTtlMs: 3600_000,
      spreadsheetEngine: {
        url: "https://engine.example",
        name: "test",
        version: "1",
        timeoutMs: 1000,
        maxResponseBytes: 100_000,
        maxArtifactBytes: 100_000,
        evaluator,
      },
      maxEvidenceBytes: 100_000,
    },
    jobs: {
      async createJob() {
        return {} as unknown as FinnyJob;
      },
      async getJob(scopeId: string, jobId: string) {
        return {
          id: jobId,
          scopeId,
          artifactDigest: dummyDigest,
          provisionalRevision: dummyFileId,
          sop: { ...finnySopFixture(), scopeId },
          sopBinding: {
            versionId: "org%3Aexample/sop.test@1",
            values: {},
            executionDigest: "execution-digest",
            revision: 1,
          },
          policy: initialFinnyPolicy(evaluator),
          requiredGenerations: { "formula.recalculate": 1, "summary.crossfoot": 1 },
        } as unknown as FinnyJob;
      },
      async getApprovalRequest() {
        return null;
      },
      async recordSopAmendment() {
        return {} as never;
      },
      async recordAuditAttempt(input) {
        assert.equal(input.controls.length, 4);
        assert.equal(input.verdict, "pass");
        return { attempt: input, events: [], job: {} as FinnyJob, deduped: false } as never;
      },
      async getAuditAttempt() {
        return null;
      },
      async getAuditAttemptByOperation() {
        return null;
      },
      async completeAuditJudgment() {
        return {} as never;
      },
    },
    runtime: {
      async currentBinding(sessionId: string) {
        return {
          role: "auditor" as const,
          scopeId: "org:sharechat",
          jobId: "job-456",
          sessionId,
          runId: "run-auditor",
          active: true,
          principalId: "auditor-agent",
          epoch: 1,
        };
      },
      async claimParentTurn() {
        return null;
      },
    },
    integration: {} as unknown as Parameters<typeof createFinnyToolServiceFactory>[0]["integration"],
    deliveries: {} as unknown as Parameters<typeof createFinnyToolServiceFactory>[0]["deliveries"],
    certifyResult: async () => {},
    deliverCertifiedResults: async () => {},
    files: {
      async open(fileId: string) {
        if (fileId !== dummyFileId) return null;
        return {
          artifact: {
            id: dummyFileId,
            enabled: true,
            ownerScopeId: "org:sharechat",
            sha256: dummyDigest,
            sizeBytes: dummyPayload.length,
            createdBy: "producer-agent",
            mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          } as unknown as Parameters<
            NonNullable<Parameters<typeof createFinnyToolServiceFactory>[0]["files"]>["open"]
          > extends [string]
            ? never
            : unknown,
          sizeBytes: dummyPayload.length,
          stream: Readable.from(dummyPayload),
        };
      },
    } as unknown as Parameters<typeof createFinnyToolServiceFactory>[0]["files"],
    deterministicSpreadsheetWorker: {
      async run(input: { jobId: string; artifactBytes: Uint8Array }) {
        auditExecuted = true;
        assert.equal(input.jobId, "job-456");
        assert.equal(Buffer.from(input.artifactBytes).toString(), "dummy-xlsx-content");
        const results: readonly SpreadsheetWorkerResult[] = [
          {
            checkId: "formula.recalculate",
            generation: 1,
            verdict: "pass",
            reason: null,
            evidence: { kind: "formula-recalculation", cells: [] },
          },
          {
            checkId: "summary.crossfoot",
            generation: 1,
            verdict: "pass",
            reason: null,
            evidence: { kind: "cross-foot", comparisons: [] },
          },
        ];
        return {
          evidenceFileId: "evidence-file-99",
          results,
        };
      },
    },
    coordinator: {
      async auditAttemptRecorded() {},
    } as unknown as Parameters<typeof createFinnyToolServiceFactory>[0]["coordinator"],
  });

  const auditorTurn = {
    scopeId: "org:sharechat",
    sessionId: "sess-auditor",
    runId: "run-auditor",
    actor: { id: "auditor-agent", type: "internal" as const },
    originThreadRef: "slack:C123:1794000.123",
    destination: { type: "slack" as const, target: "C123:1794000.123" },
    parent: false,
    parentBinding: {
      schema: "finny-parent-binding.v1" as const,
      sessionId: "sess-parent",
      runId: "run-parent",
      scopeId: "org:sharechat",
      context: {
        actor: { id: "user-kali", type: "internal" as const },
        conversation: { kind: "channel" as const, threadRef: "C123", audience: [] },
        surface: "slack",
      },
    },
  };

  const service = await factory.forTurn(auditorTurn);
  assert.ok(service);

  const auditResult = await service.deterministicAudit({
    idempotencyKey: "spike-audit-key",
    controls: [
      { id: "source-total", verdict: "pass", evidenceRefs: ["xlsx:Summary!B1"], repairActions: [] },
      { id: "mapping-exception", verdict: "pass", evidenceRefs: ["xlsx:Exceptions!A1"], repairActions: [] },
    ],
    triggeredJudgmentControlIds: ["mapping-exception"],
    judgmentAnswers: [
      {
        controlId: "mapping-exception",
        verdict: "pass",
        evidenceRefs: ["xlsx:Exceptions!A1"],
        rationale: "No material mapping exception remains.",
      },
    ],
  });

  assert.ok(auditExecuted, "Deterministic calculation worker must be invoked");
  assert.match(auditResult, /recorded 4 PASS results/);
});
test("Spike 4: Allows .xlsx delivery with audit warning in uploadAttachments", async () => {
  const originalEnv = process.env.FINNY_ENABLED;
  process.env.FINNY_ENABLED = "true";

  let uploadedCount = 0;
  const mockClient = {
    files: {
      async uploadV2(params: { file_uploads: unknown[] }) {
        uploadedCount = params.file_uploads.length;
        return { ok: true, files: [] };
      },
    },
  };

  const mockBlobs = {
    async readBlob() {
      return Buffer.from("dummy-sheet-data");
    },
    async readFileArtifact() {
      return Buffer.from("dummy-sheet-data");
    },
  };

  const attachments: OutgoingAttachment[] = [
    {
      blobId: "b1",
      name: "AP_Closing_Liability.xlsx",
      mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: 100,
    },
  ];

  try {
    const res = await uploadAttachments(mockClient as any, "C1", undefined, attachments, mockBlobs, {});
    assert.equal(res.uploaded, true, "Must deliver .xlsx upload with audit warning");
    assert.equal(uploadedCount, 1);
  } finally {
    process.env.FINNY_ENABLED = originalEnv;
  }
});

test("Spike 5: finnyTurnAuthority and createPlan support web chat surface", async () => {
  const webAuth = finnyTurnAuthority("web", undefined, false, undefined, "sess-web-123");
  assert.ok(webAuth, "Must produce authority for web surface");
  assert.equal(webAuth.originThreadRef, "web:sess-web-123");
  assert.equal(webAuth.destination.type, "web");
  assert.equal(webAuth.destination.target, "web:sess-web-123");

  const deliveries: Array<Record<string, unknown>> = [];
  const factory = createFinnyToolServiceFactory({
    config: {
      spreadsheetEngine: {
        url: "https://engine.example",
        name: "test",
        version: "1",
        timeoutMs: 1000,
        maxResponseBytes: 100_000,
        maxArtifactBytes: 100_000,
        evaluator,
      },
      maxEvidenceBytes: 100_000,
      maxReworks: 3,
      workerGrantTtlMs: 60_000,
      findingPolicy: {} as never,
    },
    jobs: {
      async createJob(input: CreateFinnyJobCommand) {
        return {
          id: input.id,
          scopeId: input.scopeId,
          sop: input.sop,
          sopBinding: {
            versionId: finnySopVersionId(input.sop),
            values: input.values,
            executionDigest: canonicalFinnyExecutionDigest(input.sop, input.values),
            revision: 1,
          },
          policy: initialFinnyPolicy(evaluator),
        } as unknown as FinnyJob;
      },
      async getJob() {
        return null;
      },
      async getApprovalRequest() {
        return null;
      },
      async recordSopAmendment() {
        return {} as never;
      },
      async recordAuditAttempt() {
        return {} as never;
      },
      async getAuditAttempt() {
        return null;
      },
      async getAuditAttemptByOperation() {
        return null;
      },
      async completeAuditJudgment() {
        return {} as never;
      },
    },
    runtime: {
      async currentBinding() {
        return null;
      },
      async claimParentTurn() {
        return null;
      },
    },
    integration: {
      async createPlanIntent() {},
      async completePlanIntent() {},
      async getParent() {
        return null;
      },
    } as unknown as Parameters<typeof createFinnyToolServiceFactory>[0]["integration"],
    deliveries: {
      async enqueue(delivery: unknown) {
        deliveries.push(delivery as Record<string, unknown>);
        return delivery as unknown as Parameters<
          Parameters<typeof createFinnyToolServiceFactory>[0]["deliveries"]["enqueue"]
        >[0];
      },
    } as unknown as Parameters<typeof createFinnyToolServiceFactory>[0]["deliveries"],
    certifyResult: async () => {},
    deliverCertifiedResults: async () => {},
    coordinator: {} as unknown as Parameters<typeof createFinnyToolServiceFactory>[0]["coordinator"],
    files: {} as unknown as Parameters<typeof createFinnyToolServiceFactory>[0]["files"],
    deterministicSpreadsheetWorker: {} as unknown as Parameters<
      typeof createFinnyToolServiceFactory
    >[0]["deterministicSpreadsheetWorker"],
  });

  const turn = {
    scopeId: "org:sharechat",
    sessionId: "sess-web-123",
    runId: "run-web-123",
    actor: { id: "user-kali", type: "internal" as const },
    originThreadRef: webAuth.originThreadRef,
    destination: webAuth.destination,
    parent: true,
    parentBinding: {
      schema: "finny-parent-binding.v1" as const,
      sessionId: "sess-web-123",
      runId: "run-web-123",
      scopeId: "org:sharechat",
      context: {
        actor: { id: "user-kali", type: "internal" as const },
        conversation: { kind: "dm" as const, threadRef: "web:sess-web-123", audience: [] },
        surface: "web",
      },
    },
  };

  const service = await factory.forTurn(turn);
  assert.ok(service, "Service must be instantiated for web parent turn");

  const sop = { ...finnySopFixture(), scopeId: "org:sharechat", title: "Net Worth Schedule with Equity Bridge" };
  const planResponse = await service.createPlan(sop, { cutoff: "2026-09-30", currency: "INR" });
  assert.match(planResponse.message, /is awaiting approval/);
  assert.equal(deliveries.length, 1);
  const dest = deliveries[0]?.destination;
  assert.ok(dest && typeof dest === "object" && "target" in dest);
  assert.equal(dest.target, "web:sess-web-123");
});
