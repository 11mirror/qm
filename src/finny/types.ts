export interface FinnyEvaluatorRef {
  readonly id: string;
  readonly revision: string;
  readonly buildDigest: string;
  readonly contractVersion: string;
  readonly configurationDigest: string;
}

export const FINNY_CHECK_IDS = [
  "source.completeness",
  "financial.reconcile",
  "formula.recalculate",
  "summary.crossfoot",
  "meaning.actionability",
  "artifact.integrity",
  "artifact.structure",
  "lineage.binding",
] as const;

export type FinnyCheckId = (typeof FINNY_CHECK_IDS)[number];

export const FINNY_CHANGE_KINDS = ["source_or_logic", "formula", "disclosure", "presentation", "lineage"] as const;

export type FinnyChangeKind = (typeof FINNY_CHANGE_KINDS)[number];

export interface FinnyPolicySnapshot {
  policyVersion: string;
  evaluator: FinnyEvaluatorRef;
  requiredGenerations: Record<FinnyCheckId, number>;
}

export const FINNY_APPROVAL_ACTIONS = ["approve", "reject", "request_change"] as const;
export type FinnyApprovalAction = (typeof FINNY_APPROVAL_ACTIONS)[number];

export const FINNY_VERDICTS = ["pass", "block"] as const;
export type FinnyVerdict = (typeof FINNY_VERDICTS)[number];

export interface FinnyApproval {
  requestId: string;
  actorId: string;
  action: FinnyApprovalAction;
  planDigest?: string;
  executionDigest?: string;
  originThreadRef: string;
  decidedAt: number;
  consumedAt?: number;
}

export interface FinnyJob {
  id: string;
  scopeId: string;
  plan?: FinnyPlanPresentation;
  planDigest?: string;
  sop?: FinnySopVersion;
  sopBinding?: FinnyJobSopBinding;
  artifactDigest?: string;
  policy: FinnyPolicySnapshot;
  findingPolicy?: FinnyFindingPolicy;
  originThreadRef: string;
  provisionalRevision?: string;
  approval?: FinnyApproval;
  ledgerHead: number;
  eventHead: number;
  pendingReworkSequence?: number;
  unresolvedEscalationSequence?: number;
  finalizationKey?: string;
  finalReceipt?: FinnyFinalReceipt;
  finalizedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface FinnyJobSopBinding {
  versionId: string;
  values: Record<string, string | boolean>;
  executionDigest: string;
  revision: number;
}

export interface FinnyDeterministicEvidenceAuthority {
  evaluator: FinnyEvaluatorRef;
  reasonSchemaVersion: "finny.spreadsheet-worker.v2";
  reasonCode: string;
}

export interface FinnyAttestation {
  seq: number;
  id: string;
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
  createdAt: number;
}

interface FinnyFinalReceiptPayloadBase {
  aud: "finny.final.delivery";
  jobId: string;
  scopeId: string;
  artifactDigest: string;
  policyVersion: string;
  evaluator: FinnyEvaluatorRef;
  requiredGenerations: Record<FinnyCheckId, number>;
  ledgerHead: number;
  approvalRequestId: string;
  approvalActorId: string;
  originThreadRef: string;
  provisionalRevision: string;
  issuedAt: number;
}

export interface FinnySopFinalReceiptPayload extends FinnyFinalReceiptPayloadBase {
  sopVersionId: string;
  sopRevision: number;
  executionDigest: string;
}

export interface FinnyLegacyFinalReceiptPayload extends FinnyFinalReceiptPayloadBase {
  planDigest: string;
}

export type FinnyFinalReceiptPayload = FinnySopFinalReceiptPayload | FinnyLegacyFinalReceiptPayload;

export interface FinnyFinalReceipt {
  token: string;
  payload: FinnyFinalReceiptPayload;
}

export type FinnyWorkerRole = "producer" | "auditor";

export interface FinnyWorkerGrantPayload {
  aud: "finny.worker";
  jti: string;
  scopeId: string;
  jobId: string;
  principalId: string;
  role: FinnyWorkerRole;
  runId: string;
  artifactDigest?: string;
  policyDigest: string;
  allowedChecks: FinnyCheckId[];
  issuedAt: number;
  expiresAt: number;
}

export interface FinnyWorkerGrant {
  token: string;
  payload: FinnyWorkerGrantPayload;
}

export const FINNY_JOB_EVENT_TYPES = [
  "artifact_ready",
  "audit_blocked",
  "audit_passed",
  "rework_requested",
  "escalated",
  "evaluator_revision_activated",
  "evidence_invalidated",
  "rework_cancelled",
  "verification_reopened",
  "plan_amended",
  "sop_amended",
] as const;

export type FinnyJobEventType = (typeof FINNY_JOB_EVENT_TYPES)[number];

export interface FinnyAuditFinding {
  code: string;
  message: string;
}

export interface FinnyFindingPolicy {
  id: string;
  maxFindings: number;
  maxCodeLength: number;
  maxMessageLength: number;
}

export interface FinnyJobEventPayloads {
  artifact_ready: {
    artifactDigest: string;
    provisionalRevision: string;
  };
  audit_blocked: {
    artifactDigest: string;
    checkId: FinnyCheckId;
    generation: number;
    evidenceDigest: string;
    issuerPrincipalId: string;
    issuerRunId: string;
    deterministicAuthority?: FinnyDeterministicEvidenceAuthority;
    findings: FinnyAuditFinding[];
    findingPolicy: FinnyFindingPolicy;
    changeKinds: FinnyChangeKind[];
  };
  audit_passed: {
    artifactDigest: string;
    checkId: FinnyCheckId;
    generation: number;
    evidenceDigest: string;
    issuerPrincipalId: string;
    issuerRunId: string;
    deterministicAuthority?: FinnyDeterministicEvidenceAuthority;
  };
  rework_requested: {
    blockedEventSequence: number;
    requiredGenerations: Record<FinnyCheckId, number>;
  };
  escalated: {
    blockedEventSequence: number;
    reason: string;
  };
  evaluator_revision_activated: {
    fromEvaluator: FinnyEvaluatorRef;
    toEvaluator: FinnyEvaluatorRef;
  };
  evidence_invalidated: {
    fromEvaluator: FinnyEvaluatorRef;
    toEvaluator: FinnyEvaluatorRef;
    checkIds: FinnyCheckId[];
    previousRequiredGenerations: Record<FinnyCheckId, number>;
    requiredGenerations: Record<FinnyCheckId, number>;
  };
  rework_cancelled: {
    reworkEventSequence: number;
    blockedEventSequence: number;
    checkId: FinnyCheckId;
  };
  verification_reopened: {
    evaluator: FinnyEvaluatorRef;
    previousRequiredGenerations: Record<FinnyCheckId, number>;
    requiredGenerations: Record<FinnyCheckId, number>;
  };
  plan_amended: {
    previousPlanDigest: string;
    newPlanDigest: string;
  };
  sop_amended: {
    previousSopVersionId: string;
    newSopVersionId: string;
    previousValues: Record<string, string | boolean>;
    newValues: Record<string, string | boolean>;
    previousExecutionDigest: string;
    newExecutionDigest: string;
    revision: number;
  };
}

export type FinnyJobEvent<T extends FinnyJobEventType = FinnyJobEventType> = {
  [K in T]: {
    seq: number;
    id: string;
    jobId: string;
    type: K;
    payload: FinnyJobEventPayloads[K];
    idempotencyKey: string;
    createdAt: number;
  };
}[T];

export interface FinnyPlanPhase {
  name: string;
  owner: string;
  dependencies: string[];
}

export interface FinnyPlanClarification {
  question: string;
  answer: string;
}

export interface FinnyPlanPresentation {
  title: string;
  summary?: string;
  phases: FinnyPlanPhase[];
  certification: string;
  deliverable: string;
  destination: string;
  clarifications: FinnyPlanClarification[];
}

export type FinnySopDomain = "ap" | "ar" | "gl" | "close";
export type FinnySopInputOrigin = "human" | "system";
export type FinnySopInputType = "date" | "text" | "currency" | "entity" | "boolean";
export type FinnySopOutputKind = "xlsx" | "summary" | "app";

export interface FinnySopVersion {
  schema: "finny.sop.v1";
  id: string;
  version: number;
  scopeId: string;
  title: string;
  intent: {
    domain: FinnySopDomain;
    description: string;
    searchTerms: readonly string[];
  };
  objective: string;
  inputs: ReadonlyArray<{
    id: string;
    label: string;
    from: FinnySopInputOrigin;
    type: FinnySopInputType;
    required: boolean;
    material: boolean;
  }>;
  sources: ReadonlyArray<{
    id: string;
    system: string;
    object: string;
    fields: readonly string[];
    filter: string;
    asOfInput?: string;
  }>;
  steps: ReadonlyArray<{
    id: string;
    action: string;
    reads: readonly string[];
    writes: string;
  }>;
  controls: ReadonlyArray<{
    id: string;
    assertion: string;
    tolerance?: string;
    evidenceRefs: readonly string[];
    judgment?: { question: string; onlyWhen: string };
  }>;
  outputs: ReadonlyArray<{
    id: string;
    kind: FinnySopOutputKind;
    contract: Record<string, unknown>;
    rerun?: { inputIds: readonly string[] };
  }>;
  approval: { required: true; destination: string };
}

export interface FinnyProducerTask {
  schema: "finny.producer-task.v1";
  sopVersion: Pick<FinnySopVersion, "id" | "version" | "scopeId">;
  executionDigest: string;
  objective: string;
  boundInputs: Record<string, string | boolean>;
  sources: FinnySopVersion["sources"];
  steps: FinnySopVersion["steps"];
  controls: FinnySopVersion["controls"];
  outputs: FinnySopVersion["outputs"];
}

export interface FinnyAuditEnvelope {
  schema: "finny.audit-envelope.v1";
  sopVersion: Pick<FinnySopVersion, "id" | "version" | "scopeId">;
  executionDigest: string;
  boundInputs: Record<string, string | boolean>;
  sources: FinnySopVersion["sources"];
  controls: FinnySopVersion["controls"];
  outputs: FinnySopVersion["outputs"];
}

export interface FinnyClarificationOption {
  id: string;
  label: string;
  description?: string;
}

export interface FinnyMaterialClarification {
  question: string;
  options: FinnyClarificationOption[];
  recommendedOptionId: string;
}

export type FinnyClarificationDecision = { kind: "option"; optionId: string } | { kind: "other" };

export interface FinnyClarificationRequest {
  requestId: string;
  scopeId: string;
  jobId: string;
  question: string;
  options: FinnyClarificationOption[];
  recommendedOptionId: string;
  originThreadRef: string;
  authorizedActorId: string;
  idempotencyKey: string;
  decision?: FinnyClarificationDecision;
  decidedAt?: number;
  createdAt: number;
}
