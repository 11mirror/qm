import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createFinnyCoreAuditStage, readFinnyCoreAuditArtifact } from "../src/finny/core-audit.ts";
import { canonicalFinnyExecutionDigest, finnySopVersionId } from "../src/finny/plan.ts";
import { digestSpreadsheetArtifact } from "../src/finny/deterministic-spreadsheet-worker.ts";
import { initialFinnyPolicy } from "../src/finny/policy.ts";
import type { FinnyJob } from "../src/finny/types.ts";
import { TEST_FINNY_EVALUATOR } from "./support/finny-fixture.ts";
import { finnySopFixture } from "./support/finny-sop-fixture.ts";

function job(): FinnyJob {
  const sop = {
    ...finnySopFixture(),
    controls: [
      { ...finnySopFixture().controls[0], deterministicCheckId: "summary.crossfoot" as const },
      {
        ...finnySopFixture().controls[1],
        deterministicCheckId: "artifact.structure" as const,
        judgment: { ...finnySopFixture().controls[1].judgment, triggerVerdict: "block" as const },
      },
    ],
  };
  const values = { cutoff: "2026-10-31", currency: "INR" };
  const bytes = new Uint8Array([1, 2, 3, 4]);
  return {
    id: "job-1",
    scopeId: sop.scopeId,
    sop,
    sopBinding: {
      versionId: finnySopVersionId(sop),
      values,
      executionDigest: canonicalFinnyExecutionDigest(sop, values),
      revision: 1,
    },
    policy: initialFinnyPolicy(TEST_FINNY_EVALUATOR),
    originThreadRef: "web:session-1",
    artifactDigest: digestSpreadsheetArtifact(bytes),
    provisionalRevision: "file-1",
    ledgerHead: 0,
    eventHead: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("Core resolves mapped objective controls without a judgment turn", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  let runs = 0;
  const stage = createFinnyCoreAuditStage({
    async runSpreadsheetWorker(input: { evidenceFileId: string }) {
      runs += 1;
      return {
        evidenceFileId: input.evidenceFileId,
        results: [
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
          {
            checkId: "artifact.structure",
            generation: 1,
            verdict: "pass",
            reason: null,
            evidence: { kind: "structure", sheets: [] },
          },
        ],
      };
    },
  });
  const attempt = await stage.run({
    job: job(),
    artifact: {
      fileId: "file-1",
      bytes,
      sha256: digestSpreadsheetArtifact(bytes),
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: bytes.length,
    },
    idempotencyKey: "core-audit-1",
    issuerRunId: "core-run-1",
  });
  assert.equal(runs, 1);
  assert.equal(attempt.verdict, "pass");
  assert.deepEqual(attempt.judgmentQuestions, []);
  assert.deepEqual(
    attempt.controls.map((control: { id: string; verdict: string }) => ({ id: control.id, verdict: control.verdict })),
    [
      { id: "source-total", verdict: "pass" },
      { id: "mapping-exception", verdict: "pass" },
      { id: "formula.recalculate", verdict: "pass" },
    ],
  );
});

test("Core blocks objective failures and defers judgment-triggered failures", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const run = async (blockedCheckId: "summary.crossfoot" | "artifact.structure") => {
    const stage = createFinnyCoreAuditStage({
      async runSpreadsheetWorker(input) {
        return {
          evidenceFileId: input.evidenceFileId,
          results: [
            {
              checkId: "formula.recalculate",
              generation: 1,
              verdict: "pass",
              reason: null,
              evidence: { kind: "formula-recalculation", cells: [] },
            },
            blockedCheckId === "summary.crossfoot"
              ? {
                  checkId: "summary.crossfoot",
                  generation: 1,
                  verdict: "block",
                  reason: { code: "CROSSFOOT_MISMATCH", references: ["Summary!B2"] },
                  evidence: { kind: "cross-foot", comparisons: [] },
                }
              : {
                  checkId: "summary.crossfoot",
                  generation: 1,
                  verdict: "pass",
                  reason: null,
                  evidence: { kind: "cross-foot", comparisons: [] },
                },
            blockedCheckId === "artifact.structure"
              ? {
                  checkId: "artifact.structure",
                  generation: 1,
                  verdict: "block",
                  reason: { code: "STRUCTURE_INVALID", references: ["Exceptions"] },
                  evidence: { kind: "structure", sheets: [] },
                }
              : {
                  checkId: "artifact.structure",
                  generation: 1,
                  verdict: "pass",
                  reason: null,
                  evidence: { kind: "structure", sheets: [] },
                },
          ],
        };
      },
    });
    return stage.run({
      job: job(),
      artifact: {
        fileId: "file-1",
        bytes,
        sha256: digestSpreadsheetArtifact(bytes),
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: bytes.length,
      },
      idempotencyKey: `core-audit-${blockedCheckId}`,
      issuerRunId: "core-run-1",
    });
  };
  const blocked = await run("summary.crossfoot");
  assert.equal(blocked.verdict, "block");
  assert.deepEqual(blocked.judgmentQuestions, []);
  assert.deepEqual(blocked.controls[0]?.repairActions[0]?.workbookRefs, ["Summary!B2"]);
  const pending = await run("artifact.structure");
  assert.equal(pending.verdict, "pending_judgment");
  assert.deepEqual(pending.judgmentQuestions, [
    {
      controlId: "mapping-exception",
      question: "Are remaining unmapped classifications materially misleading?",
      onlyWhen: "Exceptions.material_count > 0",
    },
  ]);
});

test("Core rejects unmapped SOPs and invalid artifact bindings before worker execution", async () => {
  let runs = 0;
  const stage = createFinnyCoreAuditStage({
    async runSpreadsheetWorker() {
      runs += 1;
      throw new Error("unexpected worker call");
    },
  });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const unmapped = job();
  const [firstControl, ...remainingControls] = unmapped.sop!.controls;
  if (!firstControl) throw new Error("missing fixture control");
  unmapped.sop = {
    ...unmapped.sop!,
    controls: [{ ...firstControl, deterministicCheckId: undefined }, ...remainingControls],
  };
  await assert.rejects(
    stage.run({
      job: unmapped,
      artifact: {
        fileId: "file-1",
        bytes,
        sha256: digestSpreadsheetArtifact(bytes),
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: bytes.length,
      },
      idempotencyKey: "core-audit-unmapped",
      issuerRunId: "core-run-1",
    }),
    /deterministic check binding/i,
  );
  const invalidArtifactJob = job();
  await assert.rejects(
    stage.run({
      job: invalidArtifactJob,
      artifact: {
        fileId: "file-1",
        bytes,
        sha256: "0".repeat(64),
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: bytes.length,
      },
      idempotencyKey: "core-audit-invalid-artifact",
      issuerRunId: "core-run-1",
    }),
    /artifact digest/i,
  );
  assert.equal(runs, 0);
});

test("reads one immutable scoped XLSX byte stream for Core audit", async () => {
  const bytes = Buffer.from([4, 3, 2, 1]);
  const sha256 = digestSpreadsheetArtifact(bytes);
  let opens = 0;
  const artifact = await readFinnyCoreAuditArtifact(
    {
      async open() {
        opens += 1;
        return {
          artifact: {
            id: "file-1",
            ownerScopeId: "org:invented-media-company",
            createdBy: "producer",
            name: "report.xlsx",
            path: "artifacts/file-1/report.xlsx",
            mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            sizeBytes: bytes.length,
            blobKey: "blob-1",
            sha256,
            direction: "out",
            source: "live",
            createdAt: 1,
            updatedAt: 1,
            enabled: true,
          },
          sizeBytes: bytes.length,
          stream: Readable.from([bytes]),
        };
      },
    },
    "org:invented-media-company",
    "file-1",
    1024,
  );
  assert.equal(opens, 1);
  assert.deepEqual(Array.from(artifact.bytes), Array.from(bytes));
  assert.equal(artifact.sha256, sha256);
});
