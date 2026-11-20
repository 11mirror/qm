import { createHash } from "node:crypto";
import type { SessionSyscalls } from "../sessions/session-syscalls.ts";
import type { FinnyStore, RecordFinnyAuditAttemptInput } from "./store.ts";
import type {
  FinnyAuditAttempt,
  FinnyAuditControlResult,
  FinnyAuditAttemptVerdict,
  FinnyJob,
  FinnyWorkerGrant,
  FinnyWorkerRole,
} from "./types.ts";
import type { IssueFinnyWorkerInput } from "./worker-grants.ts";
import type { FinnyRuntimeRecovery, FinnyRuntimeStore } from "./runtime-postgres-store.ts";
import { bootTenant, tenancyBooted } from "../tenants/boot.ts";
import { withTenant } from "../tenants/context.ts";

export async function runSingleTenantFinnyRecovery(work: () => Promise<void>): Promise<void> {
  const tenant = bootTenant();
  if (!tenant) {
    if (tenancyBooted()) throw new Error("Finny recovery requires a single-tenant deployment");
    return;
  }
  await withTenant(tenant, work);
}

interface RuntimeGrants {
  issueProducer(input: IssueFinnyWorkerInput): Promise<FinnyWorkerGrant>;
  issueAuditor(input: IssueFinnyWorkerInput): Promise<FinnyWorkerGrant>;
}

interface RuntimeDispatcher {
  dispatchPrivateIdempotent(input: {
    idempotencyKey: string;
    sessionId: string;
    runId: string;
    message: string;
    role: FinnyWorkerRole;
    principalId: string;
    expiresAt: number;
    observedTerminalRunId?: string;
  }): Promise<void>;
}

interface RuntimeActorInput {
  sessionId: string;
  runId: string;
  scopeId: string;
  jobId: string;
}

interface ArtifactReadyRuntimeInput extends RuntimeActorInput {
  idempotencyKey: string;
  retryTerminalAuditorRunId?: string;
}

interface ApprovedRuntimeInput {
  scopeId: string;
  jobId: string;
  parentSessionId: string;
  parentRunId: string;
  idempotencyKey: string;
  retryTerminalProducerRunId?: string;
}

interface AuditAttemptRecordedRuntimeInput {
  scopeId: string;
  jobId: string;
  attemptId: string;
  artifactDigest: string;
  verdict: FinnyAuditAttemptVerdict;
  controls: FinnyAuditControlResult[];
}

function opened(result: Awaited<ReturnType<SessionSyscalls["open"]>>, role: string) {
  if (!result.ok) throw new Error(`Finny ${role} session open failed: ${result.message}`);
  return result;
}

function actionDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function artifactAuthority(value: unknown): { artifactDigest: string; provisionalRevision: string } {
  const authority = record(value);
  if (typeof authority?.artifactDigest !== "string" || typeof authority.provisionalRevision !== "string") {
    throw new Error("Finny artifact action authority is invalid");
  }
  return { artifactDigest: authority.artifactDigest, provisionalRevision: authority.provisionalRevision };
}

export async function reconcileFinnyRuntimeRecoveries(deps: {
  recoveries(): Promise<FinnyRuntimeRecovery[]>;
  coordinatorFor(
    scopeId: string,
    jobId: string,
  ): Promise<{
    artifactReady(input: ArtifactReadyRuntimeInput): Promise<void>;
    auditAttemptRecorded(input: AuditAttemptRecordedRuntimeInput): Promise<void>;
    verificationReopened(input: {
      scopeId: string;
      jobId: string;
      idempotencyKey: string;
      retryAuditorRunId?: string;
      retryMissingAuditor?: boolean;
    }): Promise<void>;
  }>;
  recordError(error: unknown, recovery: FinnyRuntimeRecovery): Promise<void>;
}): Promise<void> {
  for (const recovery of await deps.recoveries()) {
    try {
      const coordinator = await deps.coordinatorFor(recovery.scopeId, recovery.jobId);
      if (recovery.kind === "artifact_ready") await coordinator.artifactReady(recovery);
      else if (recovery.kind === "audit_attempt_recorded") {
        await coordinator.auditAttemptRecorded(recovery);
      } else await coordinator.verificationReopened(recovery);
    } catch (error) {
      await deps.recordError(error, recovery);
    }
  }
}

export function createFinnyRuntimeCoordinator(deps: {
  jobs: FinnyStore;
  runtime: FinnyRuntimeStore;
  grants: RuntimeGrants;
  sessions: Pick<SessionSyscalls, "open">;
  dispatcher: RuntimeDispatcher;
  artifactBinding: {
    resolve(input: ArtifactReadyRuntimeInput): Promise<{ artifactDigest: string; provisionalRevision: string }>;
  };
  workerPolicy: {
    credentials(job: FinnyJob, role: "producer" | "auditor"): { principalId: string; expiresAt: number };
    producerTask(job: FinnyJob): string;
  };
  coreAudit: {
    run(job: FinnyJob, idempotencyKey: string): Promise<RecordFinnyAuditAttemptInput>;
  };
  recoveryWake?(recovery: FinnyRuntimeRecovery): void;
}) {
  async function dispatch(input: {
    idempotencyKey: string;
    scopeId: string;
    jobId: string;
    sessionId: string;
    runId: string;
    kind: string;
    intent: string;
    message: string;
    role: FinnyWorkerRole;
    principalId: string;
    expiresAt: number;
    observedTerminalRunId?: string;
    guard?: () => Promise<boolean>;
  }): Promise<void> {
    await deps.runtime.dispatchOnce(input, async () => {
      if (input.guard && !(await input.guard())) return;
      await deps.dispatcher.dispatchPrivateIdempotent({
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        runId: input.runId,
        message: input.message,
        role: input.role,
        principalId: input.principalId,
        expiresAt: input.expiresAt,
        observedTerminalRunId: input.observedTerminalRunId,
      });
    });
  }

  function coreAuditKey(job: FinnyJob): string {
    if (!job.artifactDigest || !job.sopBinding) throw new Error("Finny core audit requires immutable authority");
    return `finny:core-audit:${actionDigest({
      jobId: job.id,
      artifactDigest: job.artifactDigest,
      executionDigest: job.sopBinding.executionDigest,
      evaluator: job.policy.evaluator,
    })}`;
  }

  async function runCoreAudit(job: FinnyJob): Promise<FinnyAuditAttempt> {
    const idempotencyKey = coreAuditKey(job);
    const replay = await deps.jobs.getAuditAttemptByOperation(job.scopeId, job.id, idempotencyKey);
    if (replay) return replay.attempt;
    const command = await deps.coreAudit.run(job, idempotencyKey);
    if (command.idempotencyKey !== idempotencyKey) throw new Error("Finny core audit authority is invalid");
    return (await deps.jobs.recordAuditAttempt(command)).attempt;
  }

  function judgmentTask(attempt: FinnyAuditAttempt): string {
    return JSON.stringify({
      schema: "finny.audit-judgment-task.v1",
      jobId: attempt.jobId,
      attemptId: attempt.id,
      artifactDigest: attempt.artifactSha256,
      executionDigest: attempt.executionDigest,
      evaluator: attempt.evaluator,
      controls: attempt.controls.map((control) => ({
        id: control.id,
        verdict: control.verdict,
        evidenceRefs: control.evidenceRefs,
        deterministicAuthority: control.deterministicAuthority,
      })),
      questions: attempt.judgmentQuestions,
    });
  }

  async function dispatchBlockedAttempt(input: AuditAttemptRecordedRuntimeInput, job: FinnyJob): Promise<void> {
    const failedControls = input.controls
      .filter((control) => control.verdict === "block")
      .map((control) => ({
        id: control.id,
        evidenceRefs: control.evidenceRefs,
        repairActions: control.repairActions,
      }));
    if (!failedControls.length) throw new Error("Finny BLOCK audit attempt has no failed controls");
    const auditor = await deps.runtime.activeRoleBinding(input.scopeId, input.jobId, "auditor");
    if (auditor) {
      await deps.runtime.retireBinding({ sessionId: auditor.sessionId, runId: auditor.runId, role: "auditor" });
    }
    const producer = await deps.runtime.activeRoleBinding(input.scopeId, input.jobId, "producer");
    if (!producer) throw new Error("Finny runtime has no current producer binding");
    const message = JSON.stringify({ task: "Rework the blocked artifact", failedControls });
    const credentials = deps.workerPolicy.credentials(job, "producer");
    await dispatch({
      idempotencyKey: `finny:${input.jobId}:audit-attempt:${input.attemptId}:producer-rework`,
      scopeId: input.scopeId,
      jobId: input.jobId,
      sessionId: producer.sessionId,
      runId: producer.runId,
      kind: "producer_audit_attempt_rework",
      intent: message,
      message,
      role: "producer",
      principalId: credentials.principalId,
      expiresAt: credentials.expiresAt,
      guard: async () => {
        const current = await deps.jobs.getJob(input.scopeId, input.jobId);
        return current?.currentAuditAttemptId === input.attemptId && current.artifactDigest === input.artifactDigest;
      },
    });
  }

  async function ensureJudgmentAuditor(input: {
    job: FinnyJob;
    attempt: FinnyAuditAttempt;
    dispatchKey?: string;
    retryRunId?: string;
    missingOnly?: boolean;
  }): Promise<void> {
    if (input.attempt.verdict !== "pending_judgment") return;
    const task = judgmentTask(input.attempt);
    const credentials = deps.workerPolicy.credentials(input.job, "auditor");
    let auditor = await deps.runtime.activeRoleBinding(input.job.scopeId, input.job.id, "auditor");
    if (input.missingOnly && auditor) return;
    if (input.retryRunId !== undefined && auditor?.runId !== input.retryRunId) return;
    if (!auditor) {
      const bindAuditor = async (identity: { sessionId: string; runId: string }) => {
        await deps.runtime.bindAuditor({
          scopeId: input.job.scopeId,
          jobId: input.job.id,
          sessionId: identity.sessionId,
          runId: identity.runId,
          principalId: credentials.principalId,
          expiresAt: credentials.expiresAt,
        });
        await deps.grants.issueAuditor({
          scopeId: input.job.scopeId,
          jobId: input.job.id,
          principalId: credentials.principalId,
          runId: identity.runId,
          expiresAt: credentials.expiresAt,
        });
      };
      const openedAuditor = opened(
        await deps.sessions.open({
          requestId: `finny:${input.job.id}:judgment:${input.attempt.id}`,
          name: "Finny Auditor",
          task,
          beforeEnqueue: bindAuditor,
        }),
        "Auditor",
      );
      auditor = await deps.runtime.currentRoleBinding(input.job.scopeId, input.job.id, "auditor");
      if (!auditor || auditor.sessionId !== openedAuditor.sessionId || auditor.runId !== openedAuditor.runId) {
        throw new Error("Finny Auditor runtime binding is unavailable");
      }
      return;
    }
    if (!input.dispatchKey) return;
    await dispatch({
      idempotencyKey: input.dispatchKey,
      scopeId: input.job.scopeId,
      jobId: input.job.id,
      sessionId: auditor.sessionId,
      runId: auditor.runId,
      kind: "auditor_judgment",
      intent: task,
      message: task,
      role: "auditor",
      principalId: credentials.principalId,
      expiresAt: credentials.expiresAt,
      observedTerminalRunId: input.retryRunId,
    });
  }

  async function applyAuditAttempt(job: FinnyJob, attempt: FinnyAuditAttempt): Promise<void> {
    if (attempt.verdict === "block") {
      await dispatchBlockedAttempt(
        {
          scopeId: job.scopeId,
          jobId: job.id,
          attemptId: attempt.id,
          artifactDigest: attempt.artifactSha256,
          verdict: attempt.verdict,
          controls: attempt.controls,
        },
        job,
      );
      return;
    }
    if (attempt.verdict === "pass") {
      const auditor = await deps.runtime.activeRoleBinding(job.scopeId, job.id, "auditor");
      if (auditor) {
        await deps.runtime.retireBinding({ sessionId: auditor.sessionId, runId: auditor.runId, role: "auditor" });
      }
      return;
    }
    await ensureJudgmentAuditor({ job, attempt });
  }

  return {
    async afterApproved(input: ApprovedRuntimeInput): Promise<void> {
      const job = await deps.jobs.getJob(input.scopeId, input.jobId);
      if (!job || job.approval?.action !== "approve" || job.approval.consumedAt !== undefined) {
        throw new Error("Finny runtime requires a current approved job");
      }
      const approval = job.approval;
      const producerTask = deps.workerPolicy.producerTask(job);
      const producerCredentials = deps.workerPolicy.credentials(job, "producer");
      const startupKey = `finny:${job.id}:${job.approval.requestId}`;
      await deps.runtime.bindParent({
        scopeId: input.scopeId,
        jobId: input.jobId,
        sessionId: input.parentSessionId,
        runId: input.parentRunId,
        principalId: approval.actorId,
      });
      const existingProducer = await deps.runtime.activeRoleBinding(input.scopeId, input.jobId, "producer");
      if (existingProducer) {
        if (input.retryTerminalProducerRunId === existingProducer.runId) {
          await dispatch({
            idempotencyKey: `${startupKey}:producer-retry:${input.retryTerminalProducerRunId}`,
            scopeId: input.scopeId,
            jobId: input.jobId,
            sessionId: existingProducer.sessionId,
            runId: existingProducer.runId,
            kind: "producer_retry",
            intent: producerTask,
            message: producerTask,
            role: "producer",
            principalId: producerCredentials.principalId,
            expiresAt: producerCredentials.expiresAt,
            observedTerminalRunId: input.retryTerminalProducerRunId,
          });
        }
        return;
      }
      const bindProducer = async (identity: { sessionId: string; runId: string }) => {
        await deps.runtime.bindWorker({
          scopeId: input.scopeId,
          jobId: input.jobId,
          sessionId: identity.sessionId,
          runId: identity.runId,
          role: "producer",
          principalId: producerCredentials.principalId,
          epoch: 0,
          expiresAt: producerCredentials.expiresAt,
        });
        await deps.grants.issueProducer({
          scopeId: input.scopeId,
          jobId: input.jobId,
          principalId: producerCredentials.principalId,
          runId: identity.runId,
          expiresAt: producerCredentials.expiresAt,
        });
      };
      const producer = opened(
        await deps.sessions.open({
          requestId: `${startupKey}:producer`,
          name: "Finny Producer",
          task: producerTask,
          beforeEnqueue: bindProducer,
        }),
        "producer",
      );
      const currentProducer = await deps.runtime.currentRoleBinding(input.scopeId, input.jobId, "producer");
      if (!currentProducer || currentProducer.sessionId !== producer.sessionId)
        throw new Error("Finny Producer runtime binding is unavailable");
    },
    async auditAttemptRecorded(input: AuditAttemptRecordedRuntimeInput): Promise<void> {
      const job = await deps.jobs.getJob(input.scopeId, input.jobId);
      if (
        !job ||
        job.currentAuditAttemptId !== input.attemptId ||
        job.artifactDigest !== input.artifactDigest ||
        job.finalizedAt !== undefined
      ) {
        throw new Error("Finny atomic audit attempt is not current");
      }
      if (input.verdict !== "block") return;
      await dispatchBlockedAttempt(input, job);
    },
    async verificationReopened(input: {
      scopeId: string;
      jobId: string;
      idempotencyKey: string;
      retryAuditorRunId?: string;
      retryMissingAuditor?: boolean;
    }): Promise<void> {
      const job = await deps.jobs.getJob(input.scopeId, input.jobId);
      if (
        !job?.artifactDigest ||
        !job.provisionalRevision ||
        job.pendingReworkSequence !== undefined ||
        job.unresolvedEscalationSequence !== undefined ||
        job.finalizedAt !== undefined
      ) {
        throw new Error("Finny reverification requires a current immutable artifact");
      }
      const attempt = await runCoreAudit(job);
      if (attempt.verdict !== "pending_judgment") {
        await applyAuditAttempt(job, attempt);
        return;
      }
      await ensureJudgmentAuditor({
        job,
        attempt,
        dispatchKey: input.retryAuditorRunId
          ? `${input.idempotencyKey}:auditor-reverify:retry:${input.retryAuditorRunId}`
          : `${input.idempotencyKey}:auditor-reverify`,
        retryRunId: input.retryAuditorRunId,
        missingOnly: input.retryMissingAuditor,
      });
    },
    async artifactReady(input: ArtifactReadyRuntimeInput): Promise<void> {
      const action = {
        idempotencyKey: input.idempotencyKey,
        kind: "artifact_ready",
        sessionId: input.sessionId,
        runId: input.runId,
        scopeId: input.scopeId,
        jobId: input.jobId,
        role: "producer" as const,
        requestDigest: actionDigest({}),
      };
      const prepared = await deps.runtime.prepareAction(action);
      let artifact: { artifactDigest: string; provisionalRevision: string };
      if (prepared.authorityPayload === undefined) {
        artifact = await deps.artifactBinding.resolve(input);
        const committed = await deps.runtime.authorizeAction({ ...action, authorityPayload: artifact });
        artifact = artifactAuthority(committed.authorityPayload);
      } else {
        artifact = artifactAuthority(prepared.authorityPayload);
      }
      const ready = await deps.jobs.recordArtifactReady({
        scopeId: input.scopeId,
        jobId: input.jobId,
        artifactDigest: artifact.artifactDigest,
        provisionalRevision: artifact.provisionalRevision,
        idempotencyKey: input.idempotencyKey,
      });
      if (
        ready.job.artifactDigest !== artifact.artifactDigest ||
        ready.job.provisionalRevision !== artifact.provisionalRevision
      )
        return;
      if (!ready.deduped) deps.recoveryWake?.({ kind: "artifact_ready", ...input });
      const attempt = await runCoreAudit(ready.job);
      if (input.retryTerminalAuditorRunId !== undefined) {
        await ensureJudgmentAuditor({
          job: ready.job,
          attempt,
          dispatchKey: `finny:${input.jobId}:judgment-retry:${input.retryTerminalAuditorRunId}`,
          retryRunId: input.retryTerminalAuditorRunId,
        });
        return;
      }
      await applyAuditAttempt(ready.job, attempt);
    },
  };
}
