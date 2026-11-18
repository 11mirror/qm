import type {
  FinnyApprovalAction,
  FinnyAttestation,
  FinnyAuditFinding,
  FinnyChangeKind,
  FinnyCheckId,
  FinnyClarificationDecision,
  FinnyClarificationOption,
  FinnyClarificationRequest,
  FinnyDeterministicEvidenceAuthority,
  FinnyJob,
  FinnyJobEvent,
  FinnyFindingPolicy,
  FinnyEvaluatorRef,
  FinnyFinalReceipt,
  FinnyFinalReceiptPayload,
  FinnyPolicySnapshot,
  FinnySopVersion,
  FinnyVerdict,
  FinnyWorkerRole,
} from "./types.ts";
import type { Destination } from "../types.ts";

export interface FinnyStoredSopVersion {
  versionId: string;
  definitionDigest: string;
  sop: FinnySopVersion;
  createdAt: number;
}

export interface CreateFinnySopJobInput {
  id: string;
  scopeId: string;
  sop: FinnySopVersion;
  values: Record<string, string | boolean>;
  policy: FinnyPolicySnapshot;
  findingPolicy: FinnyFindingPolicy;
  originThreadRef: string;
}

export type CreateFinnyJobCommand = CreateFinnySopJobInput;

export interface CreateFinnyApprovalRequestInput {
  scopeId: string;
  jobId: string;
  requestId: string;
  authorizedActorId: string;
}

export interface FinnyApprovalRequest {
  requestId: string;
  scopeId: string;
  jobId: string;
  planDigest?: string;
  executionDigest?: string;
  originThreadRef: string;
  authorizedActorId: string;
  readyAt?: number;
  decidedAt?: number;
  job: FinnyJob;
}

export interface CreateFinnyClarificationRequestInput {
  scopeId: string;
  jobId: string;
  requestId: string;
  authorizedActorId: string;
  question: string;
  options: FinnyClarificationOption[];
  recommendedOptionId: string;
  idempotencyKey: string;
}

export interface FinnyClarificationDecisionResult {
  request: FinnyClarificationRequest;
  approvalReady: boolean;
  revisionRequired: boolean;
}

export interface RecordFinnyClarificationDecisionInput {
  requestId: string;
  actorId: string;
  originThreadRef: string;
  decision: FinnyClarificationDecision;
  decidedAt: number;
}

export interface RecordFinnyApprovalInput {
  scopeId: string;
  jobId: string;
  requestId: string;
  actorId: string;
  action: FinnyApprovalAction;
  originThreadRef: string;
  decidedAt: number;
}

export interface RecordFinnySopAmendmentInput {
  scopeId: string;
  jobId: string;
  sop: FinnySopVersion;
  values: Record<string, string | boolean>;
  idempotencyKey: string;
  createdAt: number;
  replacementApproval?: {
    requestId: string;
    actorId: string;
    originThreadRef: string;
    destination: Destination;
    binding: unknown;
  };
}

export interface RecordFinnyAttestationInput {
  id: string;
  scopeId: string;
  jobId: string;
  checkId: FinnyCheckId;
  generation: number;
  verdict: FinnyVerdict;
  evidenceDigest: string;
  artifactDigest: string;
  issuerPrincipalId: string;
  issuerRunId: string;
  deterministicAuthority?: FinnyDeterministicEvidenceAuthority;
  idempotencyKey: string;
}

export interface RecordFinnyAuditBlockInput {
  scopeId: string;
  jobId: string;
  checkId: FinnyCheckId;
  generation: number;
  artifactDigest: string;
  evidenceDigest: string;
  issuerPrincipalId: string;
  issuerRunId: string;
  deterministicAuthority?: FinnyDeterministicEvidenceAuthority;
  findings: FinnyAuditFinding[];
  changeKinds: FinnyChangeKind[];
  resolution: { kind: "rework" } | { kind: "escalate"; reason: string };
  idempotencyKey: string;
}

export interface RecordFinnyArtifactReadyInput {
  scopeId: string;
  jobId: string;
  artifactDigest: string;
  provisionalRevision: string;
  idempotencyKey: string;
}

export interface RecordFinnyAuditPassedInput {
  scopeId: string;
  jobId: string;
  checkId: FinnyCheckId;
  generation: number;
  artifactDigest: string;
  evidenceDigest: string;
  issuerPrincipalId: string;
  issuerRunId: string;
  deterministicAuthority?: FinnyDeterministicEvidenceAuthority;
  idempotencyKey: string;
}

export interface FinnyEventResult<T extends FinnyJobEvent = FinnyJobEvent> {
  events: T[];
  job: FinnyJob;
  deduped: boolean;
}

export interface RecordFinnyEvaluatorCorrectionInput {
  scopeId: string;
  jobId: string;
  fromEvaluator: FinnyEvaluatorRef;
  toEvaluator: FinnyEvaluatorRef;
  idempotencyKey: string;
}

export interface FinalizeFinnyInput {
  scopeId: string;
  jobId: string;
  idempotencyKey: string;
}

export type FinnyReceiptSigner = (payload: FinnyFinalReceiptPayload) => Promise<string>;

export interface ClaimFinnyWorkerRunInput {
  scopeId: string;
  jobId: string;
  runId: string;
  role: FinnyWorkerRole;
}

export interface FinnyStore {
  createSopVersion(sop: FinnySopVersion): Promise<FinnyStoredSopVersion>;
  getSopVersion(scopeId: string, versionId: string): Promise<FinnyStoredSopVersion | null>;
  searchSopVersions(
    scopeId: string,
    query: string,
    page?: { offset?: number; limit?: number },
  ): Promise<FinnyStoredSopVersion[]>;
  createJob(input: CreateFinnyJobCommand): Promise<FinnyJob>;
  createApprovalRequest(input: CreateFinnyApprovalRequestInput): Promise<void>;
  createClarificationRequest(input: CreateFinnyClarificationRequestInput): Promise<FinnyClarificationRequest>;
  recordSopAmendment(input: RecordFinnySopAmendmentInput): Promise<FinnyEventResult<FinnyJobEvent<"sop_amended">>>;
  getJob(scopeId: string, jobId: string): Promise<FinnyJob | null>;
  getApprovalRequest(requestId: string): Promise<FinnyApprovalRequest | null>;
  getPendingApprovalRequestForJob(scopeId: string, jobId: string): Promise<FinnyApprovalRequest | null>;
  getPendingApprovalRequestByThread(originThreadRef: string): Promise<FinnyApprovalRequest | null>;
  getClarificationRequest(requestId: string): Promise<FinnyClarificationRequest | null>;
  claimWorkerRun(input: ClaimFinnyWorkerRunInput): Promise<void>;
  recordApproval(input: RecordFinnyApprovalInput): Promise<FinnyJob>;
  recordClarificationDecision(input: RecordFinnyClarificationDecisionInput): Promise<FinnyClarificationDecisionResult>;
  recordAttestation(input: RecordFinnyAttestationInput): Promise<{ attestation: FinnyAttestation; deduped: boolean }>;
  recordArtifactReady(input: RecordFinnyArtifactReadyInput): Promise<FinnyEventResult<FinnyJobEvent<"artifact_ready">>>;
  recordAuditPassed(input: RecordFinnyAuditPassedInput): Promise<FinnyEventResult<FinnyJobEvent<"audit_passed">>>;
  recordAuditBlock(input: RecordFinnyAuditBlockInput): Promise<FinnyEventResult>;
  evaluatorCorrectionCandidates(approvedEvaluator: FinnyEvaluatorRef): Promise<FinnyJob[]>;
  recordEvaluatorCorrection(input: RecordFinnyEvaluatorCorrectionInput): Promise<FinnyEventResult>;
  listEvents(scopeId: string, jobId: string, afterSequence?: number): Promise<FinnyJobEvent[]>;
  finalize(input: FinalizeFinnyInput, sign: FinnyReceiptSigner): Promise<FinnyFinalReceipt>;
}
