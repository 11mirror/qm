import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { canonicalJson } from "../../cli/src/canonical-json.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { assertFinnyFindingPolicy } from "./coordinator.ts";
import {
  assertFinnyCertifiedResultReferences,
  finnyCertifiedResultSearchText,
  validateFinnyCertifiedResult,
  validateFinnyCertifiedResultDestination,
  type FinnyCertifiedResultReceipt,
  type FinnyCertifiedResultRecord,
} from "./certified-result.ts";
import {
  assertFinnyMaterialClarificationMatchesSop,
  canonicalFinnySopDefinitionDigest,
  canonicalFinnyExecutionDigest,
  finnySopSearchText,
  finnySopVersionId,
  validateFinnySopVersion,
  validateFinnySopValues,
  validateFinnyMaterialClarification,
} from "./plan.ts";
import {
  FINNY_DETERMINISTIC_CHECK_IDS,
  activateFinnyEvaluator,
  assertFinnyApprovedEvaluatorRef,
  assertFinnyEvaluatorRef,
  assertFinnyPolicy,
  reviseFinnyPolicy,
} from "./policy.ts";
import type {
  ClaimFinnyWorkerRunInput,
  CompleteFinnyAuditJudgmentInput,
  CreateFinnyApprovalRequestInput,
  CreateFinnyClarificationRequestInput,
  CreateFinnyJobCommand,
  FinnyApprovalRequest,
  FinnyStore,
  FinnyStoredSopVersion,
  RecordFinnyApprovalInput,
  RecordFinnyAuditAttemptInput,
  RecordFinnySopAmendmentInput,
  RecordFinnyClarificationDecisionInput,
  RecordFinnyArtifactReadyInput,
  RecordFinnyEvaluatorCorrectionInput,
} from "./store.ts";
import type {
  FinnyAuditAttempt,
  FinnyCheckId,
  FinnyClarificationRequest,
  FinnyEvaluatorRef,
  FinnyJob,
  FinnyJobEvent,
  FinnyJobEventPayloads,
  FinnyJobEventType,
  FinnyFindingPolicy,
  FinnyPlanPresentation,
  FinnyPolicySnapshot,
  FinnySopVersion,
} from "./types.ts";
import { validateFinnyAuditAttemptInput } from "./audit-attempt.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS finny_jobs(
    id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL CHECK (scope_id <> ''),
    plan_presentation JSONB NOT NULL CHECK (jsonb_typeof(plan_presentation) = 'object'),
    plan_digest TEXT NOT NULL CHECK (plan_digest <> ''),
    artifact_digest TEXT CHECK (artifact_digest IS NULL OR artifact_digest <> ''),
    policy_version TEXT NOT NULL CHECK (policy_version <> ''),
    required_generations JSONB NOT NULL CHECK (jsonb_typeof(required_generations) = 'object'),
    origin_thread_ref TEXT NOT NULL CHECK (origin_thread_ref <> ''),
    provisional_revision TEXT CHECK (provisional_revision IS NULL OR provisional_revision <> ''),
    approval_request_id TEXT,
    approval_actor_id TEXT,
    approval_action TEXT CHECK (approval_action IN ('approve', 'reject', 'request_change')),
    approval_plan_digest TEXT,
    approval_origin_thread_ref TEXT,
    approval_decided_at BIGINT,
    approval_consumed_at BIGINT,
    ledger_head BIGINT NOT NULL DEFAULT 0 CHECK (ledger_head >= 0),
    finalization_key TEXT,
    final_receipt JSONB,
    finalized_at BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS finny_jobs_finalization_key
    ON finny_jobs(finalization_key) WHERE finalization_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS finny_jobs_scope_created ON finny_jobs(scope_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS finny_attestations(
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL REFERENCES finny_jobs(id) ON DELETE CASCADE,
    check_id TEXT NOT NULL CHECK (check_id <> ''),
    generation BIGINT NOT NULL CHECK (generation > 0),
    verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'block')),
    evidence_digest TEXT NOT NULL CHECK (evidence_digest <> ''),
    artifact_digest TEXT NOT NULL CHECK (artifact_digest <> ''),
    issuer_principal_id TEXT NOT NULL CHECK (issuer_principal_id <> ''),
    issuer_run_id TEXT NOT NULL CHECK (issuer_run_id <> ''),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS finny_attestations_check_sequence
    ON finny_attestations(job_id, check_id, generation, seq DESC)`,
  `CREATE INDEX IF NOT EXISTS finny_attestations_job_sequence ON finny_attestations(job_id, seq)`,
];

const EVENT_SCHEMA = [
  `ALTER TABLE finny_jobs ALTER COLUMN artifact_digest DROP NOT NULL`,
  `ALTER TABLE finny_jobs ALTER COLUMN provisional_revision DROP NOT NULL`,
  `ALTER TABLE finny_jobs ADD CONSTRAINT finny_jobs_artifact_binding_pair
     CHECK ((artifact_digest IS NULL) = (provisional_revision IS NULL))`,
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS event_head BIGINT NOT NULL DEFAULT 0 CHECK (event_head >= 0)`,
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS pending_rework_seq BIGINT CHECK (pending_rework_seq > 0)`,
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS unresolved_escalation_seq BIGINT CHECK (unresolved_escalation_seq > 0)`,
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS finding_policy JSONB CHECK (finding_policy IS NULL OR jsonb_typeof(finding_policy) = 'object')`,
  `CREATE TABLE IF NOT EXISTS finny_job_events(
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL REFERENCES finny_jobs(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN ('artifact_ready','audit_blocked','audit_passed','rework_requested','escalated')),
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    idempotency_key TEXT NOT NULL,
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    created_at BIGINT NOT NULL,
    UNIQUE(idempotency_key, event_index)
  )`,
  `CREATE INDEX IF NOT EXISTS finny_job_events_job_sequence ON finny_job_events(job_id, seq)`,
];

const PLAN_FIRST_SCHEMA = [
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS plan_presentation JSONB`,
  `ALTER TABLE finny_jobs ALTER COLUMN plan_presentation SET NOT NULL`,
  `ALTER TABLE finny_jobs ADD CONSTRAINT finny_jobs_plan_presentation_object
     CHECK (jsonb_typeof(plan_presentation) = 'object')`,
  `ALTER TABLE finny_jobs ALTER COLUMN artifact_digest DROP NOT NULL`,
  `ALTER TABLE finny_jobs ALTER COLUMN provisional_revision DROP NOT NULL`,
  `CREATE TABLE IF NOT EXISTS finny_approval_requests(
    request_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL CHECK (scope_id <> ''),
    job_id TEXT NOT NULL REFERENCES finny_jobs(id) ON DELETE CASCADE,
    plan_digest TEXT NOT NULL CHECK (plan_digest <> ''),
    origin_thread_ref TEXT NOT NULL CHECK (origin_thread_ref <> ''),
    authorized_actor_id TEXT NOT NULL CHECK (authorized_actor_id <> ''),
    decided_at BIGINT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS finny_approval_requests_job ON finny_approval_requests(job_id)`,
  `CREATE TABLE IF NOT EXISTS finny_worker_runs(
    job_id TEXT NOT NULL REFERENCES finny_jobs(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('producer','auditor')),
    created_at BIGINT NOT NULL,
    PRIMARY KEY(job_id, run_id)
  )`,
];

const FINNY_REQUEST_ID_MAX = 2_000;

const CLARIFICATION_SCHEMA = [
  `CREATE UNIQUE INDEX IF NOT EXISTS finny_approval_requests_one_pending_job
     ON finny_approval_requests(job_id) WHERE decided_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS finny_clarification_requests(
    request_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL CHECK (scope_id <> ''),
    job_id TEXT NOT NULL REFERENCES finny_jobs(id) ON DELETE CASCADE,
    question TEXT NOT NULL CHECK (question <> ''),
    options JSONB NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) > 0),
    recommended_option_id TEXT NOT NULL CHECK (recommended_option_id <> ''),
    origin_thread_ref TEXT NOT NULL CHECK (origin_thread_ref <> ''),
    authorized_actor_id TEXT NOT NULL CHECK (authorized_actor_id <> ''),
    idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key <> ''),
    decision JSONB CHECK (
      decision IS NULL OR
      (jsonb_typeof(decision) = 'object' AND (
        decision->>'kind' = 'other' OR
        (decision->>'kind' = 'option' AND COALESCE(decision->>'optionId', '') <> '')
      ))
    ),
    decided_at BIGINT,
    created_at BIGINT NOT NULL,
    CHECK ((decision IS NULL) = (decided_at IS NULL))
  )`,
  `CREATE INDEX IF NOT EXISTS finny_clarification_requests_job ON finny_clarification_requests(job_id)`,
];

const APPROVAL_READINESS_SCHEMA = [
  `ALTER TABLE finny_approval_requests ADD COLUMN IF NOT EXISTS ready_at BIGINT`,
  `UPDATE finny_approval_requests SET ready_at=created_at WHERE ready_at IS NULL`,
];

const APPROVAL_READINESS_REPAIR_SCHEMA = [
  `UPDATE finny_approval_requests AS approvals
      SET ready_at=CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM finny_clarification_requests AS clarifications
           WHERE clarifications.job_id=approvals.job_id
             AND (
               clarifications.decision IS NULL OR
               clarifications.decision->>'kind' <> 'option' OR
               clarifications.decision->>'optionId' <> clarifications.recommended_option_id
             )
        ) THEN COALESCE(approvals.ready_at, approvals.created_at)
        ELSE NULL
      END`,
];

const EVALUATOR_AUTHORITY_SCHEMA = [
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS evaluator_ref JSONB`,
  `UPDATE finny_jobs SET evaluator_ref=jsonb_build_object(
     'id','legacy-unpinned','revision','legacy-unpinned','buildDigest','legacy-unpinned',
     'contractVersion','legacy-unpinned','configurationDigest','legacy-unpinned'
   ) WHERE evaluator_ref IS NULL`,
  `ALTER TABLE finny_jobs ALTER COLUMN evaluator_ref SET NOT NULL`,
  `ALTER TABLE finny_jobs ADD CONSTRAINT finny_jobs_evaluator_ref_object
     CHECK (jsonb_typeof(evaluator_ref) = 'object')`,
  `ALTER TABLE finny_job_events DROP CONSTRAINT IF EXISTS finny_job_events_event_type_check`,
  `ALTER TABLE finny_job_events ADD CONSTRAINT finny_job_events_event_type_check CHECK (event_type IN (
     'artifact_ready','audit_blocked','audit_passed','rework_requested','escalated',
     'evaluator_revision_activated','evidence_invalidated','rework_cancelled','verification_reopened'
   ))`,
];

const PLAN_AMENDMENT_SCHEMA = [
  `ALTER TABLE finny_job_events DROP CONSTRAINT IF EXISTS finny_job_events_event_type_check`,
  `ALTER TABLE finny_job_events ADD CONSTRAINT finny_job_events_event_type_check CHECK (event_type IN (
     'artifact_ready','audit_blocked','audit_passed','rework_requested','escalated',
     'evaluator_revision_activated','evidence_invalidated','rework_cancelled','verification_reopened',
     'plan_amended'
   ))`,
];

const DETERMINISTIC_ATTESTATION_SCHEMA = [
  `ALTER TABLE finny_attestations ADD COLUMN IF NOT EXISTS deterministic_authority JSONB`,
  `ALTER TABLE finny_attestations ADD CONSTRAINT finny_attestations_deterministic_authority_object
     CHECK (deterministic_authority IS NULL OR jsonb_typeof(deterministic_authority) = 'object')`,
];

const SOP_VERSION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS finny_sop_versions(
    version_id TEXT PRIMARY KEY CHECK (version_id <> ''),
    scope_id TEXT NOT NULL CHECK (scope_id <> ''),
    sop_id TEXT NOT NULL CHECK (sop_id <> ''),
    version BIGINT NOT NULL CHECK (version > 0),
    definition JSONB NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
    definition_digest TEXT NOT NULL CHECK (definition_digest <> ''),
    search_text TEXT NOT NULL CHECK (search_text <> ''),
    created_at BIGINT NOT NULL,
    UNIQUE(scope_id, version_id),
    UNIQUE(scope_id, sop_id, version)
  )`,
  `CREATE INDEX IF NOT EXISTS finny_sop_versions_scope_created
    ON finny_sop_versions(scope_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS finny_sop_versions_search
    ON finny_sop_versions USING GIN(to_tsvector('simple', search_text))`,
  `CREATE OR REPLACE FUNCTION reject_finny_sop_version_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'Finny SOP versions are immutable';
    END;
    $$`,
  `CREATE TRIGGER finny_sop_versions_immutable
    BEFORE UPDATE OR DELETE ON finny_sop_versions
    FOR EACH ROW EXECUTE FUNCTION reject_finny_sop_version_mutation()`,
];

const SOP_JOB_BINDING_SCHEMA = [
  `ALTER TABLE finny_jobs ALTER COLUMN plan_presentation DROP NOT NULL`,
  `ALTER TABLE finny_jobs ALTER COLUMN plan_digest DROP NOT NULL`,
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS sop_version_id TEXT`,
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS bound_inputs JSONB`,
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS execution_digest TEXT`,
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS sop_revision BIGINT`,
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS approval_execution_digest TEXT`,
  `ALTER TABLE finny_jobs ADD CONSTRAINT finny_jobs_sop_scope_fk
    FOREIGN KEY(scope_id, sop_version_id)
    REFERENCES finny_sop_versions(scope_id, version_id)`,
  `ALTER TABLE finny_jobs ADD CONSTRAINT finny_jobs_binding_mode CHECK (
    (
      plan_presentation IS NOT NULL AND plan_digest IS NOT NULL AND
      sop_version_id IS NULL AND bound_inputs IS NULL AND
      execution_digest IS NULL AND sop_revision IS NULL
    ) OR (
      plan_presentation IS NULL AND plan_digest IS NULL AND
      sop_version_id IS NOT NULL AND bound_inputs IS NOT NULL AND
      jsonb_typeof(bound_inputs) = 'object' AND
      execution_digest IS NOT NULL AND execution_digest <> '' AND
      sop_revision IS NOT NULL AND sop_revision > 0
    )
  )`,
  `ALTER TABLE finny_jobs ADD CONSTRAINT finny_jobs_approval_binding_mode CHECK (
    NOT (approval_plan_digest IS NOT NULL AND approval_execution_digest IS NOT NULL) AND
    (approval_execution_digest IS NULL OR approval_execution_digest <> '')
  )`,
  `CREATE INDEX IF NOT EXISTS finny_jobs_sop_version
    ON finny_jobs(scope_id, sop_version_id) WHERE sop_version_id IS NOT NULL`,
  `ALTER TABLE finny_approval_requests ALTER COLUMN plan_digest DROP NOT NULL`,
  `ALTER TABLE finny_approval_requests ADD COLUMN IF NOT EXISTS execution_digest TEXT`,
  `ALTER TABLE finny_approval_requests ADD CONSTRAINT finny_approval_requests_binding_mode CHECK (
    (plan_digest IS NOT NULL AND execution_digest IS NULL) OR
    (plan_digest IS NULL AND execution_digest IS NOT NULL AND execution_digest <> '')
  )`,
];

const SOP_AMENDMENT_SCHEMA = [
  `ALTER TABLE finny_job_events DROP CONSTRAINT IF EXISTS finny_job_events_event_type_check`,
  `ALTER TABLE finny_job_events ADD CONSTRAINT finny_job_events_event_type_check CHECK (event_type IN (
    'artifact_ready','audit_blocked','audit_passed','rework_requested','escalated',
    'evaluator_revision_activated','evidence_invalidated','rework_cancelled','verification_reopened',
    'plan_amended','sop_amended'
  ))`,
];

const SOP_CUTOVER_SCHEMA = [
  `DO $qm$
   DECLARE
     blocked BOOLEAN;
   BEGIN
     IF EXISTS (
       SELECT 1 FROM finny_jobs
       WHERE sop_version_id IS NULL AND finalized_at IS NULL
     ) THEN
       RAISE EXCEPTION 'Finny SOP cutover refused: unfinished legacy Finny jobs exist';
     END IF;

     IF to_regclass('finny_plan_intents') IS NOT NULL THEN
       EXECUTE 'SELECT EXISTS (
         SELECT 1 FROM finny_plan_intents WHERE NOT (job_input ? ''sop'')
       )' INTO blocked;
       IF blocked THEN
         RAISE EXCEPTION 'Finny SOP cutover refused: legacy Finny plan intents await job creation';
       END IF;
     END IF;

     SELECT EXISTS (
       SELECT 1 FROM finny_jobs
       WHERE sop_version_id IS NULL AND final_receipt IS NOT NULL
     ) INTO blocked;
     IF blocked AND to_regclass('deliveries') IS NULL THEN
       RAISE EXCEPTION 'Finny SOP cutover refused: legacy Finny final receipts await delivery';
     END IF;
     IF blocked THEN
       EXECUTE 'SELECT EXISTS (
         SELECT 1
           FROM finny_jobs j
           LEFT JOIN deliveries d
             ON d.idempotency_key = ''finny-final:'' || j.id || '':'' || j.ledger_head::text
          WHERE j.sop_version_id IS NULL
            AND j.final_receipt IS NOT NULL
            AND d.delivered_at IS NULL
       )' INTO blocked;
       IF blocked THEN
         RAISE EXCEPTION 'Finny SOP cutover refused: legacy Finny final receipts await delivery';
       END IF;
     END IF;

     ALTER TABLE finny_jobs DROP CONSTRAINT IF EXISTS finny_jobs_sop_cutover_mode;
     ALTER TABLE finny_jobs ADD CONSTRAINT finny_jobs_sop_cutover_mode
       CHECK (sop_version_id IS NOT NULL OR finalized_at IS NOT NULL);
     IF to_regclass('finny_plan_intents') IS NOT NULL THEN
       EXECUTE 'ALTER TABLE finny_plan_intents
         DROP CONSTRAINT IF EXISTS finny_plan_intents_sop_cutover_mode';
       EXECUTE 'ALTER TABLE finny_plan_intents
         ADD CONSTRAINT finny_plan_intents_sop_cutover_mode CHECK (job_input ? ''sop'')';
     END IF;
   END
   $qm$`,
];

const AUDIT_ATTEMPT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS finny_audit_attempts(
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES finny_jobs(id) ON DELETE CASCADE,
    scope_id TEXT NOT NULL CHECK (scope_id <> ''),
    sop_version_id TEXT NOT NULL REFERENCES finny_sop_versions(version_id),
    execution_digest TEXT NOT NULL CHECK (execution_digest <> ''),
    artifact_file_id TEXT NOT NULL CHECK (artifact_file_id <> ''),
    artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
    artifact_mime TEXT NOT NULL CHECK (artifact_mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    artifact_size_bytes BIGINT NOT NULL CHECK (artifact_size_bytes > 0),
    evaluator_ref JSONB NOT NULL CHECK (jsonb_typeof(evaluator_ref) = 'object'),
    controls JSONB NOT NULL CHECK (jsonb_typeof(controls) = 'array' AND jsonb_array_length(controls) > 0),
    judgment_questions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(judgment_questions) = 'array'),
    judgment_addendum JSONB CHECK (judgment_addendum IS NULL OR jsonb_typeof(judgment_addendum) = 'object'),
    verdict TEXT NOT NULL CHECK (verdict IN ('pass','block','pending_judgment')),
    issuer_principal_id TEXT NOT NULL CHECK (issuer_principal_id <> ''),
    issuer_run_id TEXT NOT NULL CHECK (issuer_run_id <> ''),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL,
    completed_at BIGINT,
    UNIQUE(job_id, artifact_sha256),
    CHECK ((verdict = 'pending_judgment') = (
      judgment_addendum IS NULL AND jsonb_array_length(judgment_questions) > 0 AND completed_at IS NULL
    )),
    CHECK (verdict = 'pending_judgment' OR completed_at IS NOT NULL)
  )`,
  `CREATE INDEX IF NOT EXISTS finny_audit_attempts_job_created
    ON finny_audit_attempts(job_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS finny_audit_attempts_scope_created
    ON finny_audit_attempts(scope_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS finny_audit_attempts_pending_judgment
    ON finny_audit_attempts(job_id, created_at DESC, id DESC) WHERE verdict='pending_judgment'`,
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS current_audit_attempt_id TEXT UNIQUE`,
  `ALTER TABLE finny_jobs ADD CONSTRAINT finny_jobs_current_audit_attempt_fk
    FOREIGN KEY(current_audit_attempt_id) REFERENCES finny_audit_attempts(id)
    DEFERRABLE INITIALLY DEFERRED`,
  `ALTER TABLE finny_job_events DROP CONSTRAINT IF EXISTS finny_job_events_event_type_check`,
  `ALTER TABLE finny_job_events ADD CONSTRAINT finny_job_events_event_type_check CHECK (event_type IN (
    'artifact_ready','audit_blocked','audit_passed','rework_requested','escalated',
    'evaluator_revision_activated','evidence_invalidated','rework_cancelled','verification_reopened',
    'plan_amended','sop_amended','audit_attempt_recorded','audit_judgment_recorded'
  ))`,
];

const CERTIFIED_RESULT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS finny_results(
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE REFERENCES finny_jobs(id) ON DELETE CASCADE,
    scope_id TEXT NOT NULL CHECK (scope_id <> ''),
    schema TEXT NOT NULL CHECK (schema = 'finny.result.v1'),
    sop_version_id TEXT NOT NULL REFERENCES finny_sop_versions(version_id),
    execution_digest TEXT NOT NULL CHECK (execution_digest <> ''),
    artifact_file_id TEXT NOT NULL CHECK (artifact_file_id <> ''),
    artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
    artifact_mime TEXT NOT NULL CHECK (artifact_mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    summary JSONB NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
    audit_attempt_id TEXT NOT NULL UNIQUE REFERENCES finny_audit_attempts(id),
    receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
    destination JSONB NOT NULL CHECK (jsonb_typeof(destination) = 'object' AND destination <> '{}'::jsonb),
    delivery_id TEXT UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key <> ''),
    search_text TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS finny_results_scope_created
    ON finny_results(scope_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS finny_results_search
    ON finny_results USING GIN(to_tsvector('simple', search_text))`,
  `CREATE INDEX IF NOT EXISTS finny_results_pending_delivery
    ON finny_results(created_at, id) WHERE delivery_id IS NULL`,
  `ALTER TABLE finny_jobs ADD COLUMN IF NOT EXISTS result_id TEXT UNIQUE`,
  `ALTER TABLE finny_jobs ADD CONSTRAINT finny_jobs_result_fk
    FOREIGN KEY(result_id) REFERENCES finny_results(id)
    DEFERRABLE INITIALLY DEFERRED`,
  `DO $qm$
   BEGIN
     IF to_regclass('deliveries') IS NOT NULL THEN
       ALTER TABLE finny_results DROP CONSTRAINT IF EXISTS finny_results_delivery_fk;
       ALTER TABLE finny_results ADD CONSTRAINT finny_results_delivery_fk
         FOREIGN KEY(delivery_id) REFERENCES deliveries(id);
     END IF;
   END
   $qm$`,
];

const AUDIT_RESULT_CUTOVER_SCHEMA = [
  `DO $qm$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM finny_jobs
        WHERE finalized_at IS NULL
          AND current_audit_attempt_id IS NULL
          AND (
            artifact_digest IS NOT NULL OR
            pending_rework_seq IS NOT NULL OR
            unresolved_escalation_seq IS NOT NULL OR
            ledger_head > 0
          )
     ) THEN
       RAISE EXCEPTION 'Finny audit cutover refused: unfinished legacy audit work exists';
     END IF;
   END
   $qm$`,
];

const AUDIT_RESULT_RECOVERY_CUTOVER_SCHEMA = [
  `DO $qm$
   DECLARE
     blocked BOOLEAN;
   BEGIN
     IF to_regclass('finny_runtime_actions') IS NOT NULL THEN
       EXECUTE 'SELECT EXISTS (
         SELECT 1
           FROM finny_runtime_actions actions
      LEFT JOIN finny_job_events events
             ON events.job_id=actions.job_id
            AND events.idempotency_key=actions.idempotency_key
            AND events.event_index=0
      LEFT JOIN finny_runtime_dispatches dispatches
             ON dispatches.idempotency_key=actions.idempotency_key || '':producer-rework''
          WHERE actions.kind IN (''audit_passed'',''audit_blocked'')
            AND (
              events.seq IS NULL OR (
                actions.kind=''audit_blocked''
                AND actions.authority_payload->''resolution''->>''kind''=''rework''
                AND dispatches.delivered_at IS NULL
                AND EXISTS (
                  SELECT 1 FROM finny_job_events rework
                   WHERE rework.job_id=actions.job_id
                     AND rework.idempotency_key=actions.idempotency_key
                     AND rework.event_index=1
                     AND rework.event_type=''rework_requested''
                     AND NOT EXISTS (
                       SELECT 1 FROM finny_job_events later
                        WHERE later.job_id=actions.job_id
                          AND later.seq>rework.seq
                          AND later.event_type IN (''rework_cancelled'',''artifact_ready'')
                     )
                )
              )
            )
       )' INTO blocked;
       IF blocked THEN
         RAISE EXCEPTION 'Finny audit cutover refused: pending legacy runtime audit actions exist';
       END IF;
     END IF;

     SELECT EXISTS (
       SELECT 1 FROM finny_jobs WHERE final_receipt IS NOT NULL AND result_id IS NULL
     ) INTO blocked;
     IF blocked AND to_regclass('deliveries') IS NULL THEN
       RAISE EXCEPTION 'Finny result cutover refused: legacy final receipts await delivery';
     END IF;
     IF blocked THEN
       EXECUTE 'SELECT EXISTS (
         SELECT 1
           FROM finny_jobs jobs
      LEFT JOIN deliveries delivery
             ON delivery.idempotency_key=''finny-final:'' || jobs.id || '':'' || jobs.ledger_head::text
          WHERE jobs.final_receipt IS NOT NULL
            AND jobs.result_id IS NULL
            AND delivery.delivered_at IS NULL
       )' INTO blocked;
       IF blocked THEN
         RAISE EXCEPTION 'Finny result cutover refused: legacy final receipts await delivery';
       END IF;
     END IF;
   END
   $qm$`,
];

const AUDIT_ATTEMPT_EVALUATOR_IDENTITY_SCHEMA = [
  `ALTER TABLE finny_audit_attempts
     DROP CONSTRAINT IF EXISTS finny_audit_attempts_job_id_artifact_sha256_key`,
  `CREATE UNIQUE INDEX IF NOT EXISTS finny_audit_attempts_job_artifact_evaluator
     ON finny_audit_attempts(job_id,artifact_sha256,evaluator_ref)`,
];

function rowToSopVersion(row: Record<string, unknown>): FinnyStoredSopVersion {
  return {
    versionId: row.version_id as string,
    definitionDigest: row.definition_digest as string,
    sop: validateFinnySopVersion(row.definition),
    createdAt: Number(row.created_at),
  };
}

function rowToClarification(row: Record<string, unknown>): FinnyClarificationRequest {
  return {
    requestId: row.request_id as string,
    scopeId: row.scope_id as string,
    jobId: row.job_id as string,
    question: row.question as string,
    options: row.options as FinnyClarificationRequest["options"],
    recommendedOptionId: row.recommended_option_id as string,
    originThreadRef: row.origin_thread_ref as string,
    authorizedActorId: row.authorized_actor_id as string,
    idempotencyKey: row.idempotency_key as string,
    ...(row.decision !== null ? { decision: row.decision as FinnyClarificationRequest["decision"] } : {}),
    ...(row.decided_at !== null ? { decidedAt: Number(row.decided_at) } : {}),
    createdAt: Number(row.created_at),
  };
}

function validateClarification(input: CreateFinnyClarificationRequestInput): void {
  assertNonEmpty(input.requestId, "clarification request ID");
  assertNonEmpty(input.authorizedActorId, "clarification actor ID");
  if (input.requestId.length > FINNY_REQUEST_ID_MAX)
    throw new Error("Finny clarification request ID exceeds Slack limits");
  assertNonEmpty(input.idempotencyKey, "clarification idempotency key");
  validateFinnyMaterialClarification(input);
}

function rowToJob(row: Record<string, unknown>): FinnyJob {
  const policy: FinnyPolicySnapshot = {
    policyVersion: row.policy_version as string,
    evaluator: row.evaluator_ref as FinnyEvaluatorRef,
    requiredGenerations: row.required_generations as Record<FinnyCheckId, number>,
  };
  const decidedAt = row.approval_decided_at;
  const common = {
    id: row.id as string,
    scopeId: row.scope_id as string,
    ...(row.artifact_digest !== null ? { artifactDigest: row.artifact_digest as string } : {}),
    policy,
    ...(row.finding_policy !== null ? { findingPolicy: row.finding_policy as FinnyFindingPolicy } : {}),
    originThreadRef: row.origin_thread_ref as string,
    ...(row.provisional_revision !== null ? { provisionalRevision: row.provisional_revision as string } : {}),
    ...(decidedAt !== null
      ? {
          approval: {
            requestId: row.approval_request_id as string,
            actorId: row.approval_actor_id as string,
            action: row.approval_action as NonNullable<FinnyJob["approval"]>["action"],
            ...(row.approval_plan_digest !== null ? { planDigest: row.approval_plan_digest as string } : {}),
            ...(row.approval_execution_digest !== null
              ? { executionDigest: row.approval_execution_digest as string }
              : {}),
            originThreadRef: row.approval_origin_thread_ref as string,
            decidedAt: Number(decidedAt),
            ...(row.approval_consumed_at !== null ? { consumedAt: Number(row.approval_consumed_at) } : {}),
          },
        }
      : {}),
    ledgerHead: Number(row.ledger_head),
    eventHead: Number(row.event_head),
    ...(row.pending_rework_seq !== null ? { pendingReworkSequence: Number(row.pending_rework_seq) } : {}),
    ...(row.unresolved_escalation_seq !== null
      ? { unresolvedEscalationSequence: Number(row.unresolved_escalation_seq) }
      : {}),
    ...(row.current_audit_attempt_id !== null ? { currentAuditAttemptId: row.current_audit_attempt_id as string } : {}),
    ...(row.result_id !== null ? { resultId: row.result_id as string } : {}),
    ...(row.finalization_key !== null ? { finalizationKey: row.finalization_key as string } : {}),
    ...(row.final_receipt !== null ? { finalReceipt: row.final_receipt as FinnyJob["finalReceipt"] } : {}),
    ...(row.finalized_at !== null ? { finalizedAt: Number(row.finalized_at) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  if (row.sop_version_id !== null && row.sop_version_id !== undefined) {
    return {
      ...common,
      sop: validateFinnySopVersion(row.sop_definition),
      sopBinding: {
        versionId: row.sop_version_id as string,
        values: row.bound_inputs as Record<string, string | boolean>,
        executionDigest: row.execution_digest as string,
        revision: Number(row.sop_revision),
      },
    } as FinnyJob;
  }
  return {
    ...common,
    plan: row.plan_presentation as FinnyPlanPresentation,
    planDigest: row.plan_digest as string,
  };
}

function updatedRowToJob(updated: Record<string, unknown>, locked: Record<string, unknown>): FinnyJob {
  return rowToJob({ ...updated, sop_definition: locked.sop_definition });
}

function rowToApprovalRequest(row: Record<string, unknown>): FinnyApprovalRequest {
  return {
    requestId: row.request_id as string,
    scopeId: row.scope_id as string,
    jobId: row.job_id as string,
    ...(row.plan_digest !== null ? { planDigest: row.plan_digest as string } : {}),
    ...(row.execution_digest !== null ? { executionDigest: row.execution_digest as string } : {}),
    originThreadRef: row.origin_thread_ref as string,
    authorizedActorId: row.authorized_actor_id as string,
    ...(row.ready_at !== null ? { readyAt: Number(row.ready_at) } : {}),
    ...(row.decided_at !== null ? { decidedAt: Number(row.decided_at) } : {}),
    job: rowToJob(row.job_row as Record<string, unknown>),
  };
}

function rowToAuditAttempt(row: Record<string, unknown>): FinnyAuditAttempt {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    scopeId: row.scope_id as string,
    sopVersionId: row.sop_version_id as string,
    executionDigest: row.execution_digest as string,
    artifactFileId: row.artifact_file_id as string,
    artifactSha256: row.artifact_sha256 as string,
    artifactMime: row.artifact_mime as FinnyAuditAttempt["artifactMime"],
    artifactSizeBytes: Number(row.artifact_size_bytes),
    evaluator: row.evaluator_ref as FinnyEvaluatorRef,
    controls: row.controls as FinnyAuditAttempt["controls"],
    judgmentQuestions: row.judgment_questions as unknown[],
    ...(row.judgment_addendum !== null
      ? { judgmentAddendum: row.judgment_addendum as NonNullable<FinnyAuditAttempt["judgmentAddendum"]> }
      : {}),
    verdict: row.verdict as FinnyAuditAttempt["verdict"],
    issuerPrincipalId: row.issuer_principal_id as string,
    issuerRunId: row.issuer_run_id as string,
    idempotencyKey: row.idempotency_key as string,
    createdAt: Number(row.created_at),
    ...(row.completed_at !== null ? { completedAt: Number(row.completed_at) } : {}),
  };
}

function rowToCertifiedResult(row: Record<string, unknown>): FinnyCertifiedResultRecord {
  const result = validateFinnyCertifiedResult({
    schema: row.schema,
    jobId: row.job_id,
    sopVersionId: row.sop_version_id,
    executionDigest: row.execution_digest,
    artifact: {
      fileId: row.artifact_file_id,
      sha256: row.artifact_sha256,
      mime: row.artifact_mime,
    },
    summary: row.summary,
    auditAttemptId: row.audit_attempt_id,
  });
  return {
    id: row.id as string,
    scopeId: row.scope_id as string,
    ...result,
    receipt: row.receipt as FinnyCertifiedResultReceipt,
    destination: row.destination as Record<string, unknown>,
    ...(row.delivery_id !== null ? { deliveryId: row.delivery_id as string } : {}),
    idempotencyKey: row.idempotency_key as string,
    createdAt: Number(row.created_at),
  };
}

function rowToEvent(row: Record<string, unknown>): FinnyJobEvent {
  return {
    seq: Number(row.seq),
    id: row.id as string,
    jobId: row.job_id as string,
    type: row.event_type as FinnyJobEventType,
    payload: row.payload as FinnyJobEventPayloads[FinnyJobEventType],
    idempotencyKey: row.idempotency_key as string,
    createdAt: Number(row.created_at),
  } as FinnyJobEvent;
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function insertEvent<T extends FinnyJobEventType>(
  db: PoolClient,
  jobId: string,
  type: T,
  payload: FinnyJobEventPayloads[T],
  idempotencyKey: string,
  eventIndex: number,
  createdAt: number,
): Promise<FinnyJobEvent<T>> {
  const inserted = await db.query(
    `INSERT INTO finny_job_events(id, job_id, event_type, payload, idempotency_key, event_index, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [randomUUID(), jobId, type, JSON.stringify(payload), idempotencyKey, eventIndex, createdAt],
  );
  return rowToEvent(inserted.rows[0]) as FinnyJobEvent<T>;
}

async function eventsForIdempotency(db: PoolClient, idempotencyKey: string): Promise<FinnyJobEvent[]> {
  const result = await db.query("SELECT * FROM finny_job_events WHERE idempotency_key=$1 ORDER BY event_index", [
    idempotencyKey,
  ]);
  return result.rows.map(rowToEvent);
}

function assertEventReplayJob(events: readonly FinnyJobEvent[], jobId: string): void {
  if (events.some((event) => event.jobId !== jobId)) throw new Error("Finny event idempotency key was reused");
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Finny ${label} is invalid`);
}

function sameAuditAttempt(row: FinnyAuditAttempt, input: RecordFinnyAuditAttemptInput): boolean {
  return (
    row.id === input.id &&
    row.jobId === input.jobId &&
    row.scopeId === input.scopeId &&
    row.sopVersionId === input.sopVersionId &&
    row.executionDigest === input.executionDigest &&
    row.artifactFileId === input.artifactFileId &&
    row.artifactSha256 === input.artifactSha256 &&
    row.artifactMime === input.artifactMime &&
    row.artifactSizeBytes === input.artifactSizeBytes &&
    sameValue(row.evaluator, input.evaluator) &&
    sameValue(row.controls, input.controls) &&
    sameValue(row.judgmentQuestions, input.judgmentQuestions) &&
    sameValue(row.judgmentAddendum, input.judgmentAddendum) &&
    row.verdict === input.verdict &&
    row.issuerPrincipalId === input.issuerPrincipalId &&
    row.issuerRunId === input.issuerRunId &&
    row.idempotencyKey === input.idempotencyKey &&
    (input.verdict === "pending_judgment" ? row.completedAt === undefined : row.completedAt !== undefined)
  );
}

function assertAuditAttemptInput(input: RecordFinnyAuditAttemptInput): void {
  validateFinnyAuditAttemptInput(input);
}

function assertApprovedSopControls(row: Record<string, unknown>, input: RecordFinnyAuditAttemptInput): void {
  const sop = validateFinnySopVersion(row.sop_definition);
  const controlsById = new Map(input.controls.map((control) => [control.id, control]));
  if (sop.controls.some((control) => !controlsById.has(control.id))) {
    throw new Error("Finny audit attempt is missing an approved SOP control");
  }
  const judgmentControlIds = new Set(sop.controls.filter((control) => control.judgment).map((control) => control.id));
  const answers = input.judgmentAddendum?.answers ?? [];
  if (input.verdict !== "pending_judgment") {
    if (answers.some((answer) => !judgmentControlIds.has(answer.controlId))) {
      throw new Error("Finny completed audit attempt has an unapproved judgment answer");
    }
    for (const answer of answers) {
      if (controlsById.get(answer.controlId)?.verdict !== answer.verdict) {
        throw new Error("Finny judgment answer disagrees with its SOP control");
      }
    }
  }
}

async function lockedJob(db: PoolClient, scopeId: string, jobId: string): Promise<Record<string, unknown>> {
  const { rows } = await db.query(
    `SELECT jobs.*, versions.definition AS sop_definition
       FROM finny_jobs AS jobs
       LEFT JOIN finny_sop_versions AS versions
         ON versions.scope_id=jobs.scope_id AND versions.version_id=jobs.sop_version_id
      WHERE jobs.id=$1 AND jobs.scope_id=$2
      FOR UPDATE OF jobs`,
    [jobId, scopeId],
  );
  if (!rows[0]) throw new Error("Finny job was not found in this scope");
  return rows[0] as Record<string, unknown>;
}

export function createPostgresFinnyStore(connectionString: string): FinnyStore {
  const { q, pool } = createPgPool(connectionString, [
    { id: "finny/store/0001", statements: SCHEMA },
    { id: "finny/store/0002-events", statements: EVENT_SCHEMA },
    { id: "finny/store/0003-plan-first", statements: PLAN_FIRST_SCHEMA },
    { id: "finny/store/0004-clarifications", statements: CLARIFICATION_SCHEMA },
    { id: "finny/store/0005-approval-readiness", statements: APPROVAL_READINESS_SCHEMA },
    { id: "finny/store/0006-approval-readiness-repair", statements: APPROVAL_READINESS_REPAIR_SCHEMA },
    { id: "finny/store/0007-evaluator-authority", statements: EVALUATOR_AUTHORITY_SCHEMA },
    { id: "finny/store/0008-deterministic-attestation", statements: DETERMINISTIC_ATTESTATION_SCHEMA },
    { id: "finny/store/0009-plan-amendment-events", statements: PLAN_AMENDMENT_SCHEMA },
    { id: "finny/store/0010-sop-versions", statements: SOP_VERSION_SCHEMA },
    { id: "finny/store/0011-sop-job-bindings", statements: SOP_JOB_BINDING_SCHEMA },
    { id: "finny/store/0012-sop-amendment-events", statements: SOP_AMENDMENT_SCHEMA },
    { id: "finny/store/0013-sop-cutover", statements: SOP_CUTOVER_SCHEMA },
    { id: "finny/store/0014-audit-attempts", statements: AUDIT_ATTEMPT_SCHEMA },
    { id: "finny/store/0015-certified-results", statements: CERTIFIED_RESULT_SCHEMA },
    { id: "finny/store/0016-audit-result-cutover", statements: AUDIT_RESULT_CUTOVER_SCHEMA },
    { id: "finny/store/0017-audit-result-recovery-cutover", statements: AUDIT_RESULT_RECOVERY_CUTOVER_SCHEMA },
    { id: "finny/store/0018-audit-attempt-evaluator-identity", statements: AUDIT_ATTEMPT_EVALUATOR_IDENTITY_SCHEMA },
  ]);
  const createSopVersion = async (sopValue: FinnySopVersion): Promise<FinnyStoredSopVersion> => {
    const sop = validateFinnySopVersion(sopValue);
    const versionId = finnySopVersionId(sop);
    const definitionDigest = canonicalFinnySopDefinitionDigest(sop);
    const createdAt = Date.now();
    await q(
      `INSERT INTO finny_sop_versions(
         version_id, scope_id, sop_id, version, definition, definition_digest, search_text, created_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(version_id) DO NOTHING`,
      [
        versionId,
        sop.scopeId,
        sop.id,
        sop.version,
        JSON.stringify(sop),
        definitionDigest,
        finnySopSearchText(sop),
        createdAt,
      ],
    );
    const rows = await q("SELECT * FROM finny_sop_versions WHERE version_id=$1", [versionId]);
    const stored = rows[0] ? rowToSopVersion(rows[0]) : undefined;
    if (!stored || stored.definitionDigest !== definitionDigest || stored.sop.scopeId !== sop.scopeId)
      throw new Error("Finny SOP version immutability conflict");
    return stored;
  };
  const jobRows = (scopeId: string, jobId: string) =>
    q(
      `SELECT jobs.*, versions.definition AS sop_definition
         FROM finny_jobs AS jobs
         LEFT JOIN finny_sop_versions AS versions
           ON versions.scope_id=jobs.scope_id AND versions.version_id=jobs.sop_version_id
        WHERE jobs.id=$1 AND jobs.scope_id=$2`,
      [jobId, scopeId],
    );
  return {
    createSopVersion,
    async getSopVersion(scopeId: string, versionId: string) {
      const rows = await q("SELECT * FROM finny_sop_versions WHERE scope_id=$1 AND version_id=$2", [
        scopeId,
        versionId,
      ]);
      return rows[0] ? rowToSopVersion(rows[0]) : null;
    },
    async searchSopVersions(scopeId: string, query: string, page = {}) {
      assertNonEmpty(scopeId, "SOP search scope");
      assertNonEmpty(query, "SOP search query");
      const offset = page.offset ?? 0;
      const limit = page.limit ?? 20;
      if (!Number.isInteger(offset) || offset < 0) throw new Error("Finny SOP search offset must be non-negative");
      if (!Number.isInteger(limit) || limit < 1) throw new Error("Finny SOP search limit must be positive");
      const ranked = await q(
        `SELECT version_id FROM finny_sop_versions
          WHERE scope_id=$1
            AND to_tsvector('simple', search_text) @@ plainto_tsquery('simple', $2)
          ORDER BY ts_rank(to_tsvector('simple', search_text), plainto_tsquery('simple', $2)) DESC,
                   created_at DESC, version_id
          OFFSET $3 LIMIT $4`,
        [scopeId, query, offset, limit],
      );
      const ids = ranked.map((row) => row.version_id as string);
      if (!ids.length) return [];
      const rows = await q("SELECT * FROM finny_sop_versions WHERE scope_id=$1 AND version_id=ANY($2)", [scopeId, ids]);
      const byId = new Map(rows.map((row) => [row.version_id as string, rowToSopVersion(row)]));
      return ids.map((id) => byId.get(id)).filter((stored): stored is FinnyStoredSopVersion => stored !== undefined);
    },
    async createJob(input: CreateFinnyJobCommand) {
      assertFinnyPolicy(input.policy);
      assertFinnyApprovedEvaluatorRef(input.policy.evaluator);
      assertFinnyFindingPolicy(input.findingPolicy);
      const sop = validateFinnySopVersion(input.sop);
      if (sop.scopeId !== input.scopeId) throw new Error("Finny SOP scope does not match the job");
      const stored = await createSopVersion(sop);
      const values = validateFinnySopValues(sop, input.values);
      const executionDigest = canonicalFinnyExecutionDigest(sop, values);
      const now = Date.now();
      await q(
        `INSERT INTO finny_jobs(
           id, scope_id, sop_version_id, bound_inputs, execution_digest, sop_revision,
           policy_version, evaluator_ref, required_generations, finding_policy,
           origin_thread_ref, created_at, updated_at
         ) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$11)`,
        [
          input.id,
          input.scopeId,
          stored.versionId,
          JSON.stringify(values),
          executionDigest,
          input.policy.policyVersion,
          JSON.stringify(input.policy.evaluator),
          JSON.stringify(input.policy.requiredGenerations),
          JSON.stringify(input.findingPolicy),
          input.originThreadRef,
          now,
        ],
      );
      const rows = await jobRows(input.scopeId, input.id);
      if (!rows[0]) throw new Error("Finny SOP job insert returned no row");
      return rowToJob(rows[0]);
    },
    async getJob(scopeId, jobId) {
      const rows = await jobRows(scopeId, jobId);
      return rows[0] ? rowToJob(rows[0]) : null;
    },
    async getApprovalRequest(requestId) {
      const rows = await q(
        `SELECT r.*, to_jsonb(j) || jsonb_build_object('sop_definition', versions.definition) AS job_row
           FROM finny_approval_requests r
           JOIN finny_jobs j ON j.id = r.job_id
           LEFT JOIN finny_sop_versions AS versions
             ON versions.scope_id=j.scope_id AND versions.version_id=j.sop_version_id
          WHERE r.request_id = $1`,
        [requestId],
      );
      const row = rows[0];
      return row ? rowToApprovalRequest(row) : null;
    },
    async getPendingApprovalRequestForJob(scopeId, jobId) {
      const rows = await q(
        `SELECT r.*, to_jsonb(j) || jsonb_build_object('sop_definition', versions.definition) AS job_row
           FROM finny_approval_requests r
           JOIN finny_jobs j ON j.id = r.job_id AND j.scope_id = r.scope_id
           LEFT JOIN finny_sop_versions AS versions
             ON versions.scope_id=j.scope_id AND versions.version_id=j.sop_version_id
          WHERE r.scope_id = $1 AND r.job_id = $2 AND r.decided_at IS NULL`,
        [scopeId, jobId],
      );
      return rows[0] ? rowToApprovalRequest(rows[0]) : null;
    },
    async getPendingApprovalRequestByThread(originThreadRef) {
      const rows = await q(
        `SELECT r.*, to_jsonb(j) || jsonb_build_object('sop_definition', versions.definition) AS job_row
           FROM finny_approval_requests r
           JOIN finny_jobs j ON j.id = r.job_id
           LEFT JOIN finny_sop_versions AS versions
             ON versions.scope_id=j.scope_id AND versions.version_id=j.sop_version_id
          WHERE r.origin_thread_ref = $1 AND r.decided_at IS NULL AND r.ready_at IS NOT NULL
          ORDER BY r.created_at DESC
          LIMIT 1`,
        [originThreadRef],
      );
      const row = rows[0];
      return row ? rowToApprovalRequest(row) : null;
    },
    async getClarificationRequest(requestId) {
      const rows = await q("SELECT * FROM finny_clarification_requests WHERE request_id=$1", [requestId]);
      return rows[0] ? rowToClarification(rows[0]) : null;
    },
    async claimWorkerRun(input: ClaimFinnyWorkerRunInput) {
      assertNonEmpty(input.runId, "worker run ID");
      await withPgTransaction(await pool(), async (db) => {
        await lockedJob(db, input.scopeId, input.jobId);
        const existing = await db.query("SELECT role FROM finny_worker_runs WHERE job_id=$1 AND run_id=$2", [
          input.jobId,
          input.runId,
        ]);
        if (existing.rows[0]) {
          if (existing.rows[0].role !== input.role) throw new Error("Finny producer and Auditor runs must be distinct");
          return;
        }
        await db.query("INSERT INTO finny_worker_runs(job_id, run_id, role, created_at) VALUES ($1,$2,$3,$4)", [
          input.jobId,
          input.runId,
          input.role,
          Date.now(),
        ]);
      });
    },
    async createApprovalRequest(input: CreateFinnyApprovalRequestInput) {
      assertNonEmpty(input.requestId, "approval request ID");
      assertNonEmpty(input.authorizedActorId, "approval actor ID");
      await withPgTransaction(await pool(), async (db) => {
        const job = await lockedJob(db, input.scopeId, input.jobId);
        if (job.sop_version_id === null) throw new Error("Finny active job has no SOP binding");
        if (job.approval_decided_at !== null) throw new Error("Finny approval was already decided");
        const pending = await db.query("SELECT 1 FROM finny_approval_requests WHERE job_id=$1 AND decided_at IS NULL", [
          input.jobId,
        ]);
        if (pending.rows[0]) throw new Error("Finny approval request is already pending");
        await db.query(
          `INSERT INTO finny_approval_requests(
             request_id, scope_id, job_id, execution_digest,
             origin_thread_ref, authorized_actor_id, ready_at, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
          [
            input.requestId,
            input.scopeId,
            input.jobId,
            job.execution_digest,
            job.origin_thread_ref,
            input.authorizedActorId,
            Date.now(),
          ],
        );
      });
    },
    async createClarificationRequest(input: CreateFinnyClarificationRequestInput) {
      validateClarification(input);
      return withPgTransaction(await pool(), async (db) => {
        const job = await lockedJob(db, input.scopeId, input.jobId);
        const lockApproval = async (): Promise<void> => {
          const approval = await db.query(
            `SELECT * FROM finny_approval_requests
              WHERE scope_id=$1 AND job_id=$2 AND authorized_actor_id=$3
                AND origin_thread_ref=$4 AND decided_at IS NULL FOR UPDATE`,
            [input.scopeId, input.jobId, input.authorizedActorId, job.origin_thread_ref],
          );
          if (approval.rowCount !== 1) throw new Error("Finny clarification approval request is unavailable");
          await db.query("UPDATE finny_approval_requests SET ready_at=NULL WHERE request_id=$1", [
            approval.rows[0].request_id,
          ]);
        };
        const replay = await db.query("SELECT * FROM finny_clarification_requests WHERE idempotency_key=$1", [
          input.idempotencyKey,
        ]);
        if (replay.rows[0]) {
          const existing = rowToClarification(replay.rows[0]);
          if (
            existing.requestId !== input.requestId ||
            existing.scopeId !== input.scopeId ||
            existing.jobId !== input.jobId ||
            existing.authorizedActorId !== input.authorizedActorId ||
            existing.question !== input.question ||
            !sameValue(existing.options, input.options) ||
            existing.recommendedOptionId !== input.recommendedOptionId ||
            existing.originThreadRef !== job.origin_thread_ref
          )
            throw new Error("Finny clarification idempotency key was reused");
          if (existing.decidedAt === undefined) await lockApproval();
          return existing;
        }
        const prior = await db.query("SELECT 1 FROM finny_clarification_requests WHERE job_id=$1", [input.jobId]);
        if (prior.rowCount) throw new Error("Finny job already has a material clarification");
        if (job.sop_version_id === null) throw new Error("Finny active job has no SOP binding");
        assertFinnyMaterialClarificationMatchesSop(job.sop_definition, job.bound_inputs, input);
        await lockApproval();
        const now = Date.now();
        const inserted = await db.query(
          `INSERT INTO finny_clarification_requests(
             request_id, scope_id, job_id, question, options, recommended_option_id,
             origin_thread_ref, authorized_actor_id, idempotency_key, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            input.requestId,
            input.scopeId,
            input.jobId,
            input.question,
            JSON.stringify(input.options),
            input.recommendedOptionId,
            job.origin_thread_ref,
            input.authorizedActorId,
            input.idempotencyKey,
            now,
          ],
        );
        return rowToClarification(inserted.rows[0]);
      });
    },
    async recordClarificationDecision(input: RecordFinnyClarificationDecisionInput) {
      return withPgTransaction(await pool(), async (db) => {
        const selected = await db.query("SELECT * FROM finny_clarification_requests WHERE request_id=$1 FOR UPDATE", [
          input.requestId,
        ]);
        const row = selected.rows[0];
        if (!row) throw new Error("Finny clarification request was not found");
        if (row.decided_at !== null) throw new Error("Finny clarification request was already decided");
        if (row.authorized_actor_id !== input.actorId) throw new Error("Finny clarification actor is not authorized");
        if (row.origin_thread_ref !== input.originThreadRef)
          throw new Error("Finny clarification must be decided in its origin thread");
        if (input.decision.kind === "option") {
          const optionId = input.decision.optionId;
          if (!(row.options as FinnyClarificationRequest["options"]).some((option) => option.id === optionId))
            throw new Error("Finny clarification option is not available");
        }
        const updated = await db.query(
          `UPDATE finny_clarification_requests SET decision=$2, decided_at=$3
            WHERE request_id=$1 RETURNING *`,
          [input.requestId, JSON.stringify(input.decision), input.decidedAt],
        );
        const approval = await db.query(
          `SELECT request_id FROM finny_approval_requests
            WHERE job_id=$1 AND decided_at IS NULL
              AND authorized_actor_id=$2 AND origin_thread_ref=$3 FOR UPDATE`,
          [row.job_id, row.authorized_actor_id, row.origin_thread_ref],
        );
        if (approval.rowCount !== 1) throw new Error("Finny clarification approval request is unavailable");
        const clarificationState = await db.query(
          `SELECT
             COALESCE(bool_and(
               decided_at IS NOT NULL AND decision->>'kind'='option'
               AND decision->>'optionId'=recommended_option_id
             ), FALSE) AS all_recommended,
             COALESCE(bool_or(
               decided_at IS NOT NULL AND (
                 decision->>'kind'<>'option' OR decision->>'optionId'<>recommended_option_id
               )
             ), FALSE) AS revision_required
             FROM finny_clarification_requests WHERE job_id=$1`,
          [row.job_id],
        );
        const approvalReady = clarificationState.rows[0]?.all_recommended === true;
        const revisionRequired = clarificationState.rows[0]?.revision_required === true;
        await db.query("UPDATE finny_approval_requests SET ready_at=$2 WHERE request_id=$1", [
          approval.rows[0].request_id,
          approvalReady ? input.decidedAt : null,
        ]);
        return { request: rowToClarification(updated.rows[0]), approvalReady, revisionRequired };
      });
    },
    async recordApproval(input: RecordFinnyApprovalInput) {
      return withPgTransaction(await pool(), async (db) => {
        const job = await lockedJob(db, input.scopeId, input.jobId);
        if (job.approval_decided_at !== null) throw new Error("Finny approval was already decided");
        const request = await db.query(
          `SELECT * FROM finny_approval_requests
           WHERE request_id=$1 AND scope_id=$2 AND job_id=$3 FOR UPDATE`,
          [input.requestId, input.scopeId, input.jobId],
        );
        const binding = request.rows[0];
        if (!binding) throw new Error("Finny approval request binding does not match the job");
        if (binding.decided_at !== null) throw new Error("Finny approval request was already decided");
        if (binding.ready_at === null) throw new Error("Finny approval request is not ready");
        if (binding.authorized_actor_id !== input.actorId) throw new Error("Finny approval actor is not authorized");
        if (binding.origin_thread_ref !== input.originThreadRef)
          throw new Error("Finny approval must be decided in its origin thread");
        if (job.sop_version_id === null) throw new Error("Finny active job has no SOP binding");
        const digestMatches = binding.execution_digest === job.execution_digest;
        if (!digestMatches || binding.origin_thread_ref !== job.origin_thread_ref) {
          throw new Error("Finny approval request binding does not match the job");
        }
        await db.query(
          `UPDATE finny_jobs SET
             approval_request_id=$2, approval_actor_id=$3, approval_action=$4,
             approval_execution_digest=$5,
             approval_origin_thread_ref=$6, approval_decided_at=$7, updated_at=$7
           WHERE id=$1 RETURNING *`,
          [
            input.jobId,
            input.requestId,
            input.actorId,
            input.action,
            binding.execution_digest,
            binding.origin_thread_ref,
            input.decidedAt,
          ],
        );
        await db.query("UPDATE finny_approval_requests SET decided_at=$2 WHERE request_id=$1", [
          input.requestId,
          input.decidedAt,
        ]);
        return rowToJob(await lockedJob(db, input.scopeId, input.jobId));
      });
    },
    async recordSopAmendment(input: RecordFinnySopAmendmentInput) {
      const sop = validateFinnySopVersion(input.sop);
      if (sop.scopeId !== input.scopeId) throw new Error("Finny SOP scope does not match the job");
      const stored = await createSopVersion(sop);
      const values = validateFinnySopValues(sop, input.values);
      const newExecutionDigest = canonicalFinnyExecutionDigest(sop, values);
      return withPgTransaction(await pool(), async (db) => {
        const job = await lockedJob(db, input.scopeId, input.jobId);
        if (job.sop_version_id === null) throw new Error("Finny job does not use SOP authority");
        const replay = await eventsForIdempotency(db, input.idempotencyKey);
        if (replay.length) {
          assertEventReplayJob(replay, input.jobId);
          const first = replay[0];
          if (
            !first ||
            first.type !== "sop_amended" ||
            first.payload.newSopVersionId !== stored.versionId ||
            first.payload.newExecutionDigest !== newExecutionDigest ||
            !sameValue(first.payload.newValues, values)
          )
            throw new Error("Finny SOP amendment idempotency key was reused");
          return {
            events: [first as FinnyJobEvent<"sop_amended">],
            job: rowToJob(job),
            deduped: true,
          };
        }
        if (job.finalized_at !== null) throw new Error("Finny job is already finalized");
        const previousSopVersionId = job.sop_version_id as string;
        const previousValues = job.bound_inputs as Record<string, string | boolean>;
        const previousExecutionDigest = job.execution_digest as string;
        const revision = Number(job.sop_revision) + 1;
        const material = newExecutionDigest !== previousExecutionDigest;
        const currentPolicy: FinnyPolicySnapshot = {
          policyVersion: job.policy_version as string,
          evaluator: job.evaluator_ref as FinnyEvaluatorRef,
          requiredGenerations: job.required_generations as Record<FinnyCheckId, number>,
        };
        const amendedPolicy = material ? reviseFinnyPolicy(currentPolicy, ["source_or_logic"]) : currentPolicy;
        const payload: FinnyJobEventPayloads["sop_amended"] = {
          previousSopVersionId,
          newSopVersionId: stored.versionId,
          previousValues,
          newValues: values,
          previousExecutionDigest,
          newExecutionDigest,
          revision,
        };
        const event = await insertEvent(
          db,
          input.jobId,
          "sop_amended",
          payload,
          input.idempotencyKey,
          0,
          input.createdAt,
        );
        const nextHead = Number(job.event_head) + 1;
        await db.query(
          `UPDATE finny_jobs SET
             sop_version_id=$2, bound_inputs=$3, execution_digest=$4, sop_revision=$5,
             artifact_digest=CASE WHEN $6 THEN NULL ELSE artifact_digest END,
             provisional_revision=CASE WHEN $6 THEN NULL ELSE provisional_revision END,
             approval_request_id=CASE WHEN $6 THEN NULL ELSE approval_request_id END,
             approval_actor_id=CASE WHEN $6 THEN NULL ELSE approval_actor_id END,
             approval_action=CASE WHEN $6 THEN NULL ELSE approval_action END,
             approval_execution_digest=CASE WHEN $6 THEN NULL ELSE approval_execution_digest END,
             approval_origin_thread_ref=CASE WHEN $6 THEN NULL ELSE approval_origin_thread_ref END,
             approval_decided_at=CASE WHEN $6 THEN NULL ELSE approval_decided_at END,
             approval_consumed_at=CASE WHEN $6 THEN NULL ELSE approval_consumed_at END,
             pending_rework_seq=CASE WHEN $6 THEN NULL ELSE pending_rework_seq END,
             unresolved_escalation_seq=CASE WHEN $6 THEN NULL ELSE unresolved_escalation_seq END,
             finalization_key=CASE WHEN $6 THEN NULL ELSE finalization_key END,
             final_receipt=CASE WHEN $6 THEN NULL ELSE final_receipt END,
             finalized_at=CASE WHEN $6 THEN NULL ELSE finalized_at END,
             required_generations=$7, event_head=$8, updated_at=$9
           WHERE id=$1`,
          [
            input.jobId,
            stored.versionId,
            JSON.stringify(values),
            newExecutionDigest,
            revision,
            material,
            JSON.stringify(amendedPolicy.requiredGenerations),
            nextHead,
            input.createdAt,
          ],
        );
        if (material)
          await db.query(
            `UPDATE finny_approval_requests SET decided_at=$3
              WHERE scope_id=$1 AND job_id=$2 AND decided_at IS NULL`,
            [input.scopeId, input.jobId, input.createdAt],
          );
        if (material && input.replacementApproval) {
          const replacement = input.replacementApproval;
          if (replacement.originThreadRef !== job.origin_thread_ref)
            throw new Error("Finny amendment approval origin does not match the job");
          const updated = await db.query(
            `UPDATE finny_integration_jobs SET
               request_id=$3, destination=$4, parent_binding=$5
              WHERE scope_id=$1 AND job_id=$2 AND actor_id=$6 AND origin_thread_ref=$7
              RETURNING job_id`,
            [
              input.scopeId,
              input.jobId,
              replacement.requestId,
              replacement.destination,
              replacement.binding,
              replacement.actorId,
              replacement.originThreadRef,
            ],
          );
          if (updated.rowCount !== 1) throw new Error("Finny amendment has no matching approval parent");
          await db.query(
            `INSERT INTO finny_approval_requests(
               request_id,scope_id,job_id,execution_digest,
               origin_thread_ref,authorized_actor_id,ready_at,created_at
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
            [
              replacement.requestId,
              input.scopeId,
              input.jobId,
              newExecutionDigest,
              replacement.originThreadRef,
              replacement.actorId,
              input.createdAt,
            ],
          );
        }
        return {
          events: [event as FinnyJobEvent<"sop_amended">],
          job: rowToJob(await lockedJob(db, input.scopeId, input.jobId)),
          deduped: false,
        };
      });
    },
    async recordAuditAttempt(input: RecordFinnyAuditAttemptInput) {
      assertAuditAttemptInput(input);
      return withPgTransaction(await pool(), async (db) => {
        const row = await lockedJob(db, input.scopeId, input.jobId);
        assertApprovedSopControls(row, input);
        const replay = await db.query("SELECT * FROM finny_audit_attempts WHERE idempotency_key=$1", [
          input.idempotencyKey,
        ]);
        if (replay.rows[0]) {
          const attempt = rowToAuditAttempt(replay.rows[0]);
          const events = await eventsForIdempotency(db, input.idempotencyKey);
          const expectedEvents = attempt.verdict === "block" ? 2 : 1;
          if (
            !sameAuditAttempt(attempt, input) ||
            events.length !== expectedEvents ||
            events[0]?.type !== "audit_attempt_recorded" ||
            (attempt.verdict === "block" && events[1]?.type !== "rework_requested")
          ) {
            throw new Error("Finny audit attempt idempotency key was reused");
          }
          return {
            attempt,
            events,
            job: rowToJob(row),
            deduped: true,
          };
        }
        if (row.finalized_at !== null) throw new Error("Finny job is already finalized");
        if (row.sop_version_id !== input.sopVersionId || row.execution_digest !== input.executionDigest) {
          throw new Error("Finny audit attempt SOP binding is not current");
        }
        if (row.artifact_digest !== input.artifactSha256 || row.provisional_revision !== input.artifactFileId) {
          throw new Error("Finny audit attempt artifact is not current");
        }
        if (!sameValue(row.evaluator_ref, input.evaluator)) throw new Error("Finny audit evaluator is not current");
        const createdAt = Date.now();
        const inserted = await db.query(
          `INSERT INTO finny_audit_attempts(
             id,job_id,scope_id,sop_version_id,execution_digest,artifact_file_id,artifact_sha256,
             artifact_mime,artifact_size_bytes,evaluator_ref,controls,judgment_questions,judgment_addendum,
             verdict,issuer_principal_id,issuer_run_id,idempotency_key,created_at,completed_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           RETURNING *`,
          [
            input.id,
            input.jobId,
            input.scopeId,
            input.sopVersionId,
            input.executionDigest,
            input.artifactFileId,
            input.artifactSha256,
            input.artifactMime,
            input.artifactSizeBytes,
            JSON.stringify(input.evaluator),
            JSON.stringify(input.controls),
            JSON.stringify(input.judgmentQuestions),
            input.judgmentAddendum ? JSON.stringify(input.judgmentAddendum) : null,
            input.verdict,
            input.issuerPrincipalId,
            input.issuerRunId,
            input.idempotencyKey,
            createdAt,
            input.verdict === "pending_judgment" ? null : createdAt,
          ],
        );
        const attempt = rowToAuditAttempt(inserted.rows[0]);
        const payload: FinnyJobEventPayloads["audit_attempt_recorded"] = {
          attemptId: attempt.id,
          artifactDigest: attempt.artifactSha256,
          verdict: attempt.verdict,
          failedControlIds: attempt.controls
            .filter((control) => control.verdict === "block")
            .map((control) => control.id),
          requestDigest: input.requestDigest ?? createHash("sha256").update(canonicalJson(input)).digest("hex"),
        };
        const event = await insertEvent(
          db,
          input.jobId,
          "audit_attempt_recorded",
          payload,
          input.idempotencyKey,
          0,
          createdAt,
        );
        const rework =
          attempt.verdict === "block"
            ? await insertEvent(
                db,
                input.jobId,
                "rework_requested",
                {
                  blockedEventSequence: event.seq,
                  requiredGenerations: row.required_generations as Record<FinnyCheckId, number>,
                },
                input.idempotencyKey,
                1,
                createdAt,
              )
            : undefined;
        const eventHead = rework?.seq ?? event.seq;
        const updated = await db.query(
          `UPDATE finny_jobs SET current_audit_attempt_id=$2,event_head=$3,
             pending_rework_seq=$4,updated_at=$5
            WHERE id=$1 RETURNING *`,
          [input.jobId, attempt.id, eventHead, rework?.seq ?? null, createdAt],
        );
        return {
          attempt,
          events: rework ? [event, rework] : [event],
          job: updatedRowToJob(updated.rows[0], row),
          deduped: false,
        };
      });
    },
    async getAuditAttempt(scopeId: string, jobId: string, attemptId: string) {
      const rows = await q("SELECT * FROM finny_audit_attempts WHERE scope_id=$1 AND job_id=$2 AND id=$3", [
        scopeId,
        jobId,
        attemptId,
      ]);
      return rows[0] ? rowToAuditAttempt(rows[0]) : null;
    },
    async getAuditAttemptByOperation(scopeId: string, jobId: string, idempotencyKey: string) {
      const rows = await q(
        `SELECT attempts.*,events.payload->>'requestDigest' AS operation_request_digest
           FROM finny_job_events events
           JOIN finny_audit_attempts attempts ON attempts.id=events.payload->>'attemptId'
          WHERE attempts.scope_id=$1 AND attempts.job_id=$2
            AND events.idempotency_key=$3
            AND events.event_type IN ('audit_attempt_recorded','audit_judgment_recorded')`,
        [scopeId, jobId, idempotencyKey],
      );
      return rows[0]
        ? { attempt: rowToAuditAttempt(rows[0]), requestDigest: rows[0].operation_request_digest as string }
        : null;
    },
    async completeAuditJudgment(input: CompleteFinnyAuditJudgmentInput) {
      return withPgTransaction(await pool(), async (db) => {
        const row = await lockedJob(db, input.scopeId, input.jobId);
        const replay = await eventsForIdempotency(db, input.idempotencyKey);
        if (replay.length) {
          const attemptResult = await db.query("SELECT * FROM finny_audit_attempts WHERE id=$1", [input.attemptId]);
          const attempt = rowToAuditAttempt(attemptResult.rows[0]);
          if (
            replay.length < 1 ||
            replay[0]?.type !== "audit_judgment_recorded" ||
            attempt.verdict === "pending_judgment" ||
            !sameValue(attempt.judgmentAddendum, input.judgmentAddendum)
          ) {
            throw new Error("Finny audit judgment idempotency key was reused");
          }
          return { attempt, events: replay, job: rowToJob(row), deduped: true };
        }
        if (row.current_audit_attempt_id !== input.attemptId) {
          throw new Error("Finny audit judgment is not for the current attempt");
        }
        const attemptResult = await db.query("SELECT * FROM finny_audit_attempts WHERE id=$1 FOR UPDATE", [
          input.attemptId,
        ]);
        const pending = rowToAuditAttempt(attemptResult.rows[0]);
        if (pending.verdict !== "pending_judgment" || pending.completedAt !== undefined) {
          throw new Error("Finny audit attempt is not awaiting judgment");
        }
        const questionIds = new Set(
          pending.judgmentQuestions.map((question) => (question as { controlId?: unknown }).controlId),
        );
        const answers = input.judgmentAddendum.answers;
        if (questionIds.size !== answers.length || answers.some((answer) => !questionIds.has(answer.controlId))) {
          throw new Error("Finny audit judgment does not answer every pending control");
        }
        const controlsById = new Map(input.controls.map((control) => [control.id, control]));
        if (
          controlsById.size !== questionIds.size ||
          [...questionIds].some((controlId) => !controlsById.has(controlId as string)) ||
          answers.some((answer) => controlsById.get(answer.controlId)?.verdict !== answer.verdict)
        ) {
          throw new Error("Finny audit judgment controls do not match the pending attempt");
        }
        const controls = pending.controls.map((control) => controlsById.get(control.id) ?? control);
        const verdict = controls.some((control) => control.verdict === "block") ? "block" : "pass";
        const updatedAttempt = await db.query(
          `UPDATE finny_audit_attempts
              SET controls=$2,judgment_questions='[]'::jsonb,judgment_addendum=$3,verdict=$4,completed_at=$5
            WHERE id=$1 RETURNING *`,
          [
            input.attemptId,
            JSON.stringify(controls),
            JSON.stringify(input.judgmentAddendum),
            verdict,
            input.completedAt,
          ],
        );
        const attempt = rowToAuditAttempt(updatedAttempt.rows[0]);
        const event = await insertEvent(
          db,
          input.jobId,
          "audit_judgment_recorded",
          {
            attemptId: input.attemptId,
            verdict,
            requestDigest: input.requestDigest ?? createHash("sha256").update(canonicalJson(input)).digest("hex"),
          },
          input.idempotencyKey,
          0,
          input.completedAt,
        );
        const rework =
          verdict === "block"
            ? await insertEvent(
                db,
                input.jobId,
                "rework_requested",
                {
                  blockedEventSequence: event.seq,
                  requiredGenerations: row.required_generations as Record<FinnyCheckId, number>,
                },
                input.idempotencyKey,
                1,
                input.completedAt,
              )
            : undefined;
        const updatedJob = await db.query(
          `UPDATE finny_jobs SET event_head=$2,pending_rework_seq=$3,updated_at=$4 WHERE id=$1 RETURNING *`,
          [input.jobId, rework?.seq ?? event.seq, rework?.seq ?? null, input.completedAt],
        );
        return {
          attempt,
          events: rework ? [event, rework] : [event],
          job: updatedRowToJob(updatedJob.rows[0], row),
          deduped: false,
        };
      });
    },
    async recordArtifactReady(input: RecordFinnyArtifactReadyInput) {
      return withPgTransaction(await pool(), async (db) => {
        const row = await lockedJob(db, input.scopeId, input.jobId);
        assertNonEmpty(input.idempotencyKey, "event idempotency key");
        assertNonEmpty(input.artifactDigest, "artifact digest");
        assertNonEmpty(input.provisionalRevision, "provisional revision");
        const payload: FinnyJobEventPayloads["artifact_ready"] = {
          artifactDigest: input.artifactDigest,
          provisionalRevision: input.provisionalRevision,
        };
        const existing = await eventsForIdempotency(db, input.idempotencyKey);
        assertEventReplayJob(existing, input.jobId);
        if (existing.length) {
          if (
            existing.length !== 1 ||
            existing[0]?.type !== "artifact_ready" ||
            !sameValue(existing[0].payload, payload)
          ) {
            throw new Error("Finny event idempotency key was reused");
          }
          return { events: existing as FinnyJobEvent<"artifact_ready">[], job: rowToJob(row), deduped: true };
        }
        if (row.finalized_at !== null) throw new Error("Finny job is already finalized");
        if (row.approval_action !== "approve" || row.approval_decided_at === null) {
          throw new Error("Finny job must be approved before artifact readiness");
        }
        if (row.unresolved_escalation_seq !== null) throw new Error("Finny job has an unresolved escalation");
        const artifactWasBound = row.artifact_digest !== null || row.provisional_revision !== null;
        if ((row.artifact_digest === null) !== (row.provisional_revision === null)) {
          throw new Error("Finny artifact binding is inconsistent");
        }
        const changesArtifact =
          row.artifact_digest !== input.artifactDigest || row.provisional_revision !== input.provisionalRevision;
        if (artifactWasBound && changesArtifact) {
          if (row.pending_rework_seq === null) {
            throw new Error("Finny artifact replacement requires a rework request");
          }
          const latest = await db.query(
            "SELECT event_type FROM finny_job_events WHERE job_id=$1 ORDER BY seq DESC LIMIT 1",
            [input.jobId],
          );
          if (latest.rows[0]?.event_type !== "rework_requested") {
            throw new Error("Finny artifact replacement requires a rework request");
          }
        } else if (artifactWasBound && Number(row.event_head) !== 0) {
          throw new Error("Finny artifact readiness was already recorded");
        }
        const currentPolicy: FinnyPolicySnapshot = {
          policyVersion: row.policy_version as string,
          evaluator: row.evaluator_ref as FinnyEvaluatorRef,
          requiredGenerations: row.required_generations as Record<FinnyCheckId, number>,
        };
        const nextPolicy =
          artifactWasBound && row.artifact_digest !== input.artifactDigest
            ? reviseFinnyPolicy(currentPolicy, ["source_or_logic"])
            : currentPolicy;
        const now = Date.now();
        const event = await insertEvent(db, input.jobId, "artifact_ready", payload, input.idempotencyKey, 0, now);
        const updated = await db.query(
          `UPDATE finny_jobs SET artifact_digest=$2, provisional_revision=$3, event_head=$4,
             required_generations=$5, pending_rework_seq=NULL,
             current_audit_attempt_id=CASE WHEN artifact_digest<>$2 OR provisional_revision<>$3 THEN NULL
                                           ELSE current_audit_attempt_id END,
             updated_at=$6 WHERE id=$1 RETURNING *`,
          [
            input.jobId,
            input.artifactDigest,
            input.provisionalRevision,
            event.seq,
            JSON.stringify(nextPolicy.requiredGenerations),
            now,
          ],
        );
        return { events: [event], job: updatedRowToJob(updated.rows[0], row), deduped: false };
      });
    },
    async evaluatorCorrectionCandidates(approvedEvaluator: FinnyEvaluatorRef) {
      assertFinnyApprovedEvaluatorRef(approvedEvaluator);
      const rows = await q(
        `SELECT jobs.*, versions.definition AS sop_definition FROM finny_jobs AS jobs
          LEFT JOIN finny_sop_versions AS versions
            ON versions.scope_id=jobs.scope_id AND versions.version_id=jobs.sop_version_id
          WHERE jobs.finalized_at IS NULL
            AND jobs.artifact_digest IS NOT NULL
            AND jobs.provisional_revision IS NOT NULL
            AND jobs.unresolved_escalation_seq IS NULL
            AND jobs.evaluator_ref <> $1::jsonb
            AND (
              jobs.pending_rework_seq IS NULL
              OR EXISTS (
                SELECT 1
                  FROM finny_job_events AS rework
                  JOIN finny_job_events AS blocked
                    ON blocked.job_id=rework.job_id
                   AND blocked.seq=(rework.payload->>'blockedEventSequence')::bigint
                   AND blocked.event_type='audit_attempt_recorded'
                  JOIN finny_audit_attempts AS attempt
                    ON attempt.id=jobs.current_audit_attempt_id
                   AND attempt.id=blocked.payload->>'attemptId'
                 WHERE rework.job_id=jobs.id
                   AND rework.seq=jobs.pending_rework_seq
                   AND rework.event_type='rework_requested'
                   AND attempt.verdict='block'
                   AND EXISTS (
                     SELECT 1 FROM jsonb_array_elements(attempt.controls) AS control
                      WHERE control->>'verdict'='block'
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM jsonb_array_elements(attempt.controls) AS control
                      WHERE control->>'verdict'='block'
                        AND control->>'id' NOT IN ('formula.recalculate','summary.crossfoot','artifact.structure')
                   )
              )
            )
          ORDER BY jobs.created_at,jobs.id`,
        [JSON.stringify(approvedEvaluator)],
      );
      return rows.map(rowToJob);
    },
    async recordEvaluatorCorrection(input: RecordFinnyEvaluatorCorrectionInput) {
      return withPgTransaction(await pool(), async (db) => {
        const row = await lockedJob(db, input.scopeId, input.jobId);
        assertNonEmpty(input.idempotencyKey, "event idempotency key");
        assertFinnyEvaluatorRef(input.fromEvaluator);
        assertFinnyApprovedEvaluatorRef(input.toEvaluator);
        if (sameValue(input.fromEvaluator, input.toEvaluator)) {
          throw new Error("Finny evaluator correction must activate a new evaluator");
        }

        const existing = await eventsForIdempotency(db, input.idempotencyKey);
        assertEventReplayJob(existing, input.jobId);
        if (existing.length) {
          const activated = existing[0];
          const reopened = existing.at(-1);
          if (
            (existing.length !== 3 && existing.length !== 4) ||
            activated?.type !== "evaluator_revision_activated" ||
            !sameValue(activated.payload, { fromEvaluator: input.fromEvaluator, toEvaluator: input.toEvaluator }) ||
            existing[1]?.type !== "evidence_invalidated" ||
            (existing.length === 4 && existing[2]?.type !== "rework_cancelled") ||
            reopened?.type !== "verification_reopened" ||
            !sameValue(reopened.payload.evaluator, input.toEvaluator)
          ) {
            throw new Error("Finny event idempotency key was reused");
          }
          return { events: existing, job: rowToJob(row), deduped: true };
        }

        if (row.finalized_at !== null) throw new Error("Finny job is already finalized");
        if (row.unresolved_escalation_seq !== null) throw new Error("Finny job has an unresolved escalation");
        if (!row.artifact_digest || !row.provisional_revision) {
          throw new Error("Finny evaluator correction requires a bound artifact");
        }
        if (!sameValue(row.evaluator_ref, input.fromEvaluator)) {
          throw new Error("Finny evaluator correction does not match the current evaluator");
        }

        const policy: FinnyPolicySnapshot = {
          policyVersion: row.policy_version as string,
          evaluator: row.evaluator_ref as FinnyEvaluatorRef,
          requiredGenerations: row.required_generations as Record<FinnyCheckId, number>,
        };
        assertFinnyPolicy(policy);
        const revised = activateFinnyEvaluator(policy, input.toEvaluator);

        let cancelled: { reworkEventSequence: number; blockedEventSequence: number; checkId: FinnyCheckId } | undefined;
        if (row.pending_rework_seq !== null) {
          const transitionResult = await db.query("SELECT * FROM finny_job_events WHERE job_id=$1 AND seq=$2", [
            input.jobId,
            row.pending_rework_seq,
          ]);
          const transition = transitionResult.rows[0] ? rowToEvent(transitionResult.rows[0]) : undefined;
          if (transition?.type !== "rework_requested") {
            throw new Error("Finny pending rework is unrelated to evaluator correction");
          }
          const blockedResult = await db.query("SELECT * FROM finny_job_events WHERE job_id=$1 AND seq=$2", [
            input.jobId,
            transition.payload.blockedEventSequence,
          ]);
          const blocked = blockedResult.rows[0] ? rowToEvent(blockedResult.rows[0]) : undefined;
          let checkId: FinnyCheckId | undefined;
          if (blocked?.type === "audit_attempt_recorded" && row.current_audit_attempt_id !== null) {
            const attemptResult = await db.query("SELECT * FROM finny_audit_attempts WHERE id=$1", [
              row.current_audit_attempt_id,
            ]);
            const attempt = attemptResult.rows[0] ? rowToAuditAttempt(attemptResult.rows[0]) : undefined;
            const failed = attempt?.controls.filter((control) => control.verdict === "block") ?? [];
            if (
              attempt?.artifactSha256 === row.artifact_digest &&
              failed.length > 0 &&
              failed.every((control) =>
                FINNY_DETERMINISTIC_CHECK_IDS.includes(control.id as (typeof FINNY_DETERMINISTIC_CHECK_IDS)[number]),
              )
            ) {
              checkId = failed[0]!.id as FinnyCheckId;
            }
          } else if (
            blocked?.type === "audit_blocked" &&
            blocked.payload.artifactDigest === row.artifact_digest &&
            FINNY_DETERMINISTIC_CHECK_IDS.includes(
              blocked.payload.checkId as (typeof FINNY_DETERMINISTIC_CHECK_IDS)[number],
            )
          ) {
            checkId = blocked.payload.checkId;
          }
          if (!checkId)
            throw new Error("Finny pending rework is non-deterministic or unrelated to evaluator correction");
          cancelled = {
            reworkEventSequence: transition.seq,
            blockedEventSequence: blocked!.seq,
            checkId,
          };
        }

        const now = Date.now();
        const events: FinnyJobEvent[] = [];
        events.push(
          await insertEvent(
            db,
            input.jobId,
            "evaluator_revision_activated",
            { fromEvaluator: input.fromEvaluator, toEvaluator: input.toEvaluator },
            input.idempotencyKey,
            events.length,
            now,
          ),
        );
        events.push(
          await insertEvent(
            db,
            input.jobId,
            "evidence_invalidated",
            {
              fromEvaluator: input.fromEvaluator,
              toEvaluator: input.toEvaluator,
              checkIds: [...FINNY_DETERMINISTIC_CHECK_IDS],
              previousRequiredGenerations: policy.requiredGenerations,
              requiredGenerations: revised.requiredGenerations,
            },
            input.idempotencyKey,
            events.length,
            now,
          ),
        );
        if (cancelled) {
          events.push(
            await insertEvent(db, input.jobId, "rework_cancelled", cancelled, input.idempotencyKey, events.length, now),
          );
        }
        events.push(
          await insertEvent(
            db,
            input.jobId,
            "verification_reopened",
            {
              evaluator: input.toEvaluator,
              previousRequiredGenerations: policy.requiredGenerations,
              requiredGenerations: revised.requiredGenerations,
            },
            input.idempotencyKey,
            events.length,
            now,
          ),
        );
        const eventHead = events.at(-1)!.seq;
        const updated = await db.query(
          `UPDATE finny_jobs SET evaluator_ref=$2, required_generations=$3,
             pending_rework_seq=NULL,current_audit_attempt_id=NULL,event_head=$4,updated_at=$5 WHERE id=$1 RETURNING *`,
          [input.jobId, JSON.stringify(revised.evaluator), JSON.stringify(revised.requiredGenerations), eventHead, now],
        );
        return { events, job: updatedRowToJob(updated.rows[0], row), deduped: false };
      });
    },
    async listEvents(scopeId, jobId, afterSequence = 0) {
      const jobs = await q("SELECT id FROM finny_jobs WHERE id=$1 AND scope_id=$2", [jobId, scopeId]);
      if (!jobs[0]) throw new Error("Finny job was not found in this scope");
      const rows = await q("SELECT * FROM finny_job_events WHERE job_id=$1 AND seq>$2 ORDER BY seq", [
        jobId,
        afterSequence,
      ]);
      return rows.map(rowToEvent);
    },
    async certifyResult(input, sign) {
      const result = validateFinnyCertifiedResult(input.result);
      const destination = validateFinnyCertifiedResultDestination(input.destination);
      assertNonEmpty(input.idempotencyKey, "certified result idempotency key");
      return withPgTransaction(await pool(), async (db) => {
        const row = await lockedJob(db, input.scopeId, result.jobId);
        const replay = await db.query("SELECT * FROM finny_results WHERE idempotency_key=$1", [input.idempotencyKey]);
        if (replay.rows[0]) {
          const stored = rowToCertifiedResult(replay.rows[0]);
          if (
            stored.jobId !== result.jobId ||
            stored.scopeId !== input.scopeId ||
            !sameValue(
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
            ) ||
            !sameValue(stored.destination, destination)
          ) {
            throw new Error("Finny certified result idempotency key was reused");
          }
          return stored;
        }
        if (row.result_id !== null) throw new Error("Finny job already has a certified result");
        if (row.finalized_at !== null) throw new Error("Finny job is already finalized");
        if (row.pending_rework_seq !== null) throw new Error("Finny job is awaiting a reworked artifact");
        if (row.unresolved_escalation_seq !== null) throw new Error("Finny job has an unresolved escalation");
        if (
          row.approval_action !== "approve" ||
          row.approval_decided_at === null ||
          row.approval_consumed_at !== null ||
          row.approval_execution_digest !== row.execution_digest ||
          row.approval_origin_thread_ref !== row.origin_thread_ref
        ) {
          throw new Error("Finny certified result requires an unconsumed bound approved decision");
        }
        if (
          result.sopVersionId !== row.sop_version_id ||
          result.executionDigest !== row.execution_digest ||
          result.artifact.fileId !== row.provisional_revision ||
          result.artifact.sha256 !== row.artifact_digest ||
          result.auditAttemptId !== row.current_audit_attempt_id
        ) {
          throw new Error("Finny certified result authority is not current");
        }
        const attempts = await db.query("SELECT * FROM finny_audit_attempts WHERE id=$1 FOR SHARE", [
          result.auditAttemptId,
        ]);
        const attemptRow = attempts.rows[0];
        if (!attemptRow) throw new Error("Finny certified result audit attempt was not found");
        const attempt = rowToAuditAttempt(attemptRow);
        if (
          attempt.verdict !== "pass" ||
          attempt.completedAt === undefined ||
          attempt.controls.some((control) => control.verdict !== "pass") ||
          attempt.jobId !== result.jobId ||
          attempt.scopeId !== input.scopeId ||
          attempt.sopVersionId !== result.sopVersionId ||
          attempt.executionDigest !== result.executionDigest ||
          attempt.artifactFileId !== result.artifact.fileId ||
          attempt.artifactSha256 !== result.artifact.sha256 ||
          attempt.artifactMime !== result.artifact.mime
        ) {
          throw new Error("Finny certified result requires a matching current PASS audit attempt");
        }
        assertFinnyCertifiedResultReferences(result, attempt);
        const createdAt = Date.now();
        const resultId = createHash("sha256")
          .update(`finny-result:${result.jobId}:${input.idempotencyKey}`)
          .digest("hex");
        const payload = {
          aud: "finny.final.delivery" as const,
          resultId,
          jobId: result.jobId,
          scopeId: input.scopeId,
          sopVersionId: result.sopVersionId,
          executionDigest: result.executionDigest,
          artifactFileId: result.artifact.fileId,
          artifactSha256: result.artifact.sha256,
          auditAttemptId: result.auditAttemptId,
          approvalRequestId: row.approval_request_id as string,
          approvalActorId: row.approval_actor_id as string,
          originThreadRef: row.origin_thread_ref as string,
          issuedAt: createdAt,
        };
        const receipt: FinnyCertifiedResultReceipt = { payload, token: await sign(payload) };
        const inserted = await db.query(
          `INSERT INTO finny_results(
             id,job_id,scope_id,schema,sop_version_id,execution_digest,artifact_file_id,artifact_sha256,
             artifact_mime,summary,audit_attempt_id,receipt,destination,idempotency_key,search_text,created_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           RETURNING *`,
          [
            resultId,
            result.jobId,
            input.scopeId,
            result.schema,
            result.sopVersionId,
            result.executionDigest,
            result.artifact.fileId,
            result.artifact.sha256,
            result.artifact.mime,
            JSON.stringify(result.summary),
            result.auditAttemptId,
            JSON.stringify(receipt),
            JSON.stringify(destination),
            input.idempotencyKey,
            finnyCertifiedResultSearchText(result),
            createdAt,
          ],
        );
        await db.query(
          `UPDATE finny_jobs SET result_id=$2,finalization_key=$3,finalized_at=$4,
             approval_consumed_at=$4,updated_at=$4 WHERE id=$1`,
          [result.jobId, resultId, input.idempotencyKey, createdAt],
        );
        return rowToCertifiedResult(inserted.rows[0]);
      });
    },
    async getCertifiedResult(scopeId, resultId) {
      const rows = await q("SELECT * FROM finny_results WHERE id=$1 AND scope_id=$2", [resultId, scopeId]);
      return rows[0] ? rowToCertifiedResult(rows[0]) : null;
    },
    async getCertifiedResultById(resultId) {
      assertNonEmpty(resultId, "certified result ID");
      const rows = await q("SELECT * FROM finny_results WHERE id=$1", [resultId]);
      return rows[0] ? rowToCertifiedResult(rows[0]) : null;
    },
    async pendingCertifiedResultDeliveries(limit) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
        throw new Error("Finny certified result delivery limit is invalid");
      }
      const rows =
        limit === undefined
          ? await q("SELECT * FROM finny_results WHERE delivery_id IS NULL ORDER BY created_at,id")
          : await q("SELECT * FROM finny_results WHERE delivery_id IS NULL ORDER BY created_at,id LIMIT $1", [limit]);
      return rows.map(rowToCertifiedResult);
    },
    async markCertifiedResultDelivery(resultId, deliveryId) {
      assertNonEmpty(resultId, "certified result ID");
      assertNonEmpty(deliveryId, "certified result delivery ID");
      await withPgTransaction(await pool(), async (db) => {
        const updated = await db.query(
          `UPDATE finny_results SET delivery_id=$2 WHERE id=$1 AND (delivery_id IS NULL OR delivery_id=$2)
           RETURNING delivery_id`,
          [resultId, deliveryId],
        );
        if (updated.rows[0]) return;
        const existing = await db.query("SELECT delivery_id FROM finny_results WHERE id=$1", [resultId]);
        if (!existing.rows[0]) throw new Error("Finny certified result was not found");
        throw new Error("Finny certified result is bound to a different delivery");
      });
    },
  };
}
