import { createHash } from "node:crypto";
import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import { parseScopeId } from "../types.ts";
import { finnyAuditAttemptFromSpreadsheetResults } from "./audit-attempt.ts";
import {
  SPREADSHEET_WORKER_CHECK_IDS,
  SPREADSHEET_WORKER_PRINCIPAL_ID,
  digestSpreadsheetArtifact,
  type SpreadsheetWorkerBinding,
  type SpreadsheetWorkerResult,
} from "./deterministic-spreadsheet-worker.ts";
import {
  assertFinnyCoreAuditableSop,
  canonicalFinnyExecutionDigest,
  finnySopVersionId,
} from "./plan.ts";
import { assertFinnyApprovedEvaluatorRef, assertFinnyPolicy } from "./policy.ts";
import type { RecordFinnyAuditAttemptInput } from "./store.ts";
import type { FinnyAuditControlResult, FinnyJob } from "./types.ts";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const;

export interface FinnyCoreAuditArtifact {
  readonly fileId: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly mime: typeof XLSX_MIME;
  readonly sizeBytes: number;
}

export interface FinnyCoreAuditInput {
  readonly job: FinnyJob;
  readonly artifact: FinnyCoreAuditArtifact;
  readonly idempotencyKey: string;
  readonly issuerRunId: string;
}

export interface FinnyCoreAuditSpreadsheetWorkerInput {
  readonly scopeId: string;
  readonly jobId: string;
  readonly artifactBytes: Uint8Array;
  readonly evidenceFileId: string;
  readonly binding: SpreadsheetWorkerBinding;
}

export interface FinnyCoreAuditSpreadsheetWorkerResult {
  readonly evidenceFileId: string;
  readonly results: readonly SpreadsheetWorkerResult[];
}

export type FinnyCoreAuditSpreadsheetWorker = (
  input: FinnyCoreAuditSpreadsheetWorkerInput,
) => Promise<FinnyCoreAuditSpreadsheetWorkerResult>;

export interface FinnyCoreAuditStage {
  run(input: FinnyCoreAuditInput): Promise<RecordFinnyAuditAttemptInput>;
}

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function nonempty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is invalid`);
}

function validateArtifact(job: FinnyJob, artifact: FinnyCoreAuditArtifact): void {
  if (!job.artifactDigest || !job.provisionalRevision) throw new Error("Finny job has no current artifact");
  nonempty(artifact.fileId, "Finny artifact file ID");
  if (artifact.fileId !== job.provisionalRevision) throw new Error("Finny artifact file binding is invalid");
  if (artifact.mime !== XLSX_MIME) throw new Error("Finny artifact MIME is invalid");
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1 || artifact.sizeBytes !== artifact.bytes.length) {
    throw new Error("Finny artifact size is invalid");
  }
  const actualDigest = digestSpreadsheetArtifact(artifact.bytes);
  if (artifact.sha256 !== actualDigest || artifact.sha256 !== job.artifactDigest) {
    throw new Error("Finny artifact digest is invalid");
  }
}

function matchesScope(artifact: { ownerScopeId: string; createdInScope?: string }, scopeId: string): boolean {
  if (artifact.ownerScopeId === scopeId || artifact.createdInScope === scopeId) return true;
  if (parseScopeId(scopeId).kind !== "org") return false;
  const ownerKind = parseScopeId(artifact.ownerScopeId).kind;
  const createdKind = artifact.createdInScope ? parseScopeId(artifact.createdInScope).kind : null;
  return ownerKind === "personal" || ownerKind === "org" || createdKind === "personal" || createdKind === "org";
}

export async function readFinnyCoreAuditArtifact(
  files: Pick<FileArtifactStore, "open">,
  scopeId: string,
  fileId: string,
  maxBytes: number,
): Promise<FinnyCoreAuditArtifact> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Finny artifact byte limit is invalid");
  const opened = await files.open(fileId);
  if (
    !opened ||
    !opened.artifact.enabled ||
    opened.artifact.id !== fileId ||
    !matchesScope(opened.artifact, scopeId) ||
    opened.artifact.mimetype !== XLSX_MIME
  ) {
    throw new Error("Finny core audit artifact is not an enabled scoped XLSX file");
  }
  if (opened.sizeBytes < 1 || opened.sizeBytes !== opened.artifact.sizeBytes || opened.sizeBytes > maxBytes) {
    opened.stream.destroy();
    throw new Error("Finny core audit artifact size is invalid");
  }
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  for await (const chunk of opened.stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sizeBytes += bytes.byteLength;
    if (sizeBytes > maxBytes) {
      opened.stream.destroy();
      throw new Error("Finny core audit artifact exceeds the configured byte limit");
    }
    chunks.push(bytes);
  }
  if (sizeBytes !== opened.sizeBytes) throw new Error("Finny core audit artifact byte length is invalid");
  const bytes = Buffer.concat(chunks);
  const sha256 = digestSpreadsheetArtifact(bytes);
  if (opened.artifact.sha256 !== sha256) throw new Error("Finny core audit artifact immutable digest is invalid");
  return { fileId, bytes, sha256, mime: XLSX_MIME, sizeBytes };
}

function assertWorkerResults(results: readonly SpreadsheetWorkerResult[], binding: SpreadsheetWorkerBinding): void {
  if (results.length !== SPREADSHEET_WORKER_CHECK_IDS.length) {
    throw new Error("Finny spreadsheet worker result set is incomplete");
  }
  const ids = new Set(results.map((result) => result.checkId));
  for (const checkId of SPREADSHEET_WORKER_CHECK_IDS) {
    if (!ids.has(checkId)) throw new Error("Finny spreadsheet worker result set is incomplete");
  }
  const generations = new Map(binding.checks.map((check) => [check.checkId, check.generation]));
  if (results.some((result) => generations.get(result.checkId) !== result.generation)) {
    throw new Error("Finny spreadsheet worker result generation is invalid");
  }
}

export function createFinnyCoreAuditStage(dependencies: {
  readonly runSpreadsheetWorker: FinnyCoreAuditSpreadsheetWorker;
}): FinnyCoreAuditStage {
  return {
    async run(input) {
      const { job, artifact } = input;
      nonempty(input.idempotencyKey, "Finny core audit idempotency key");
      nonempty(input.issuerRunId, "Finny core audit issuer run ID");
      if (!job.sop || !job.sopBinding) throw new Error("Finny job has no bound SOP");
      assertFinnyCoreAuditableSop(job.sop);
      assertFinnyPolicy(job.policy);
      assertFinnyApprovedEvaluatorRef(job.policy.evaluator);
      if (
        job.sop.scopeId !== job.scopeId ||
        finnySopVersionId(job.sop) !== job.sopBinding.versionId ||
        canonicalFinnyExecutionDigest(job.sop, job.sopBinding.values) !== job.sopBinding.executionDigest
      ) {
        throw new Error("Finny job SOP binding is invalid");
      }
      validateArtifact(job, artifact);
      const binding: SpreadsheetWorkerBinding = {
        artifactDigest: artifact.sha256,
        policyVersion: job.policy.policyVersion,
        evaluator: job.policy.evaluator,
        checks: SPREADSHEET_WORKER_CHECK_IDS.map((checkId) => ({
          checkId,
          generation: job.policy.requiredGenerations[checkId],
        })),
      };
      const authority = [
        job.id,
        artifact.sha256,
        job.sopBinding.executionDigest,
        job.policy.evaluator.id,
        job.policy.evaluator.revision,
        job.policy.evaluator.buildDigest,
        job.policy.evaluator.configurationDigest,
      ];
      const expectedEvidenceFileId = `finny-core-evidence-${digest(["evidence", ...authority])}`;
      const worker = await dependencies.runSpreadsheetWorker({
        scopeId: job.scopeId,
        jobId: job.id,
        artifactBytes: artifact.bytes,
        evidenceFileId: expectedEvidenceFileId,
        binding,
      });
      if (worker.evidenceFileId !== expectedEvidenceFileId) {
        throw new Error("Finny spreadsheet worker evidence binding is invalid");
      }
      assertWorkerResults(worker.results, binding);
      const evaluated = finnyAuditAttemptFromSpreadsheetResults(
        worker.results,
        worker.evidenceFileId,
        job.policy.evaluator,
      );
      const byCheckId = new Map(evaluated.controls.map((control) => [control.id, control]));
      const mappedCheckIds = new Set<string>(job.sop.controls.map((control) => control.deterministicCheckId!));
      const controls: FinnyAuditControlResult[] = job.sop.controls.map((control) => {
        const result = byCheckId.get(control.deterministicCheckId!);
        if (!result) throw new Error(`Finny SOP control ${control.id} has no spreadsheet worker result`);
        return { ...result, id: control.id };
      });
      controls.push(...evaluated.controls.filter((control) => !mappedCheckIds.has(control.id)));
      const judgmentQuestions = job.sop.controls.flatMap((control) => {
        const result = controls.find((candidate) => candidate.id === control.id);
        if (control.judgment?.triggerVerdict !== "block" || result?.verdict !== "block") return [];
        return [{ controlId: control.id, question: control.judgment.question, onlyWhen: control.judgment.onlyWhen }];
      });
      const judgmentIds = new Set(judgmentQuestions.map((question) => question.controlId));
      const objectiveBlock = controls.some((control) => control.verdict === "block" && !judgmentIds.has(control.id));
      let verdict: RecordFinnyAuditAttemptInput["verdict"] = "pass";
      if (judgmentQuestions.length > 0) verdict = "pending_judgment";
      if (objectiveBlock) verdict = "block";
      return {
        id: `finny-core-attempt-${digest(["attempt", ...authority])}`,
        scopeId: job.scopeId,
        jobId: job.id,
        sopVersionId: job.sopBinding.versionId,
        executionDigest: job.sopBinding.executionDigest,
        artifactFileId: artifact.fileId,
        artifactSha256: artifact.sha256,
        artifactMime: artifact.mime,
        artifactSizeBytes: artifact.sizeBytes,
        evaluator: job.policy.evaluator,
        controls,
        judgmentQuestions,
        verdict,
        issuerPrincipalId: SPREADSHEET_WORKER_PRINCIPAL_ID,
        issuerRunId: input.issuerRunId,
        idempotencyKey: input.idempotencyKey,
      };
    },
  };
}
