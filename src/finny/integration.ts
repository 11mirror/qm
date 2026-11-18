import { createHash, randomUUID } from "node:crypto";
import type { FinnyPlanCreation, FinnyToolService } from "../agent/agent-tools/finny.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import { parseScopeId, type Conversation, type Destination, type Principal } from "../types.ts";
import type { FinnyIntegrationConfig } from "./integration-config.ts";
import type { FinnyRuntimeStore } from "./runtime-postgres-store.ts";
import type { FinnyStore } from "./store.ts";
import { FINNY_CERTIFIED_RESULT_SCHEMA, FINNY_XLSX_MIME, type FinnyCertifiedResult } from "./certified-result.ts";
import { initialFinnyPolicy } from "./policy.ts";
import { assertFinnyMaterialClarificationMatchesSop } from "./plan.ts";
import type { FinnyArtifactProposal } from "./integration-postgres-store.ts";
import type {
  FinnyAuditControlResult,
  FinnyCheckId,
  FinnyDeterministicEvidenceAuthority,
  FinnyJob,
  FinnyMaterialClarification,
  FinnySopVersion,
  FinnyVerdict,
} from "./types.ts";
import {
  SPREADSHEET_WORKER_CHECK_IDS,
  SPREADSHEET_WORKER_PRINCIPAL_ID,
  verifySpreadsheetWorkerEnvelope,
} from "./deterministic-spreadsheet-worker.ts";

export interface FinnyParentBindingSnapshot {
  schema: "finny-parent-binding.v1";
  sessionId: string;
  runId: string;
  scopeId: string;
  context: { actor: Principal; conversation: Conversation; surface: string };
}

export interface FinnyTurnBinding {
  actor: Principal;
  scopeId: string;
  sessionId: string;
  runId: string;
  originThreadRef: string;
  destination: Destination;
  parentBinding: FinnyParentBindingSnapshot;
  parent: boolean;
}

interface FinnyIntegrationStore {
  createPlanIntent(input: {
    job: import("./store.ts").CreateFinnyJobCommand;
    parent: Parameters<FinnyIntegrationStore["createApprovalBoundParent"]>[0];
    clarification?: import("./store.ts").CreateFinnyClarificationRequestInput;
  }): Promise<void>;
  completePlanIntent(
    input: Parameters<FinnyIntegrationStore["createApprovalBoundParent"]>[0],
    clarification?: import("./store.ts").CreateFinnyClarificationRequestInput,
  ): Promise<void>;
  createApprovalBoundParent(input: {
    scopeId: string;
    jobId: string;
    requestId: string;
    actorId: string;
    originThreadRef: string;
    destination: Destination;
    binding: FinnyParentBindingSnapshot;
  }): Promise<void>;
  saveArtifactProposal(input: {
    scopeId: string;
    jobId: string;
    sessionId: string;
    runId: string;
    artifactDigest: string;
    provisionalRevision: string;
    idempotencyKey: string;
  }): Promise<void>;
}

interface FinnyCoordinatorPort {
  artifactReady(input: {
    sessionId: string;
    runId: string;
    scopeId: string;
    jobId: string;
    idempotencyKey: string;
  }): Promise<void>;
  auditAttemptRecorded(input: {
    scopeId: string;
    jobId: string;
    attemptId: string;
    artifactDigest: string;
    verdict: "pass" | "block" | "pending_judgment";
    controls: FinnyAuditControlResult[];
  }): Promise<void>;
}

function jobStatus(job: FinnyJob): string {
  if (job.finalReceipt) return "finalized";
  if (job.unresolvedEscalationSequence !== undefined) return "escalated";
  if (job.pendingReworkSequence !== undefined) return "reworking";
  if (job.artifactDigest) return "auditing";
  if (job.approval?.action === "approve") return "producing";
  return "awaiting_approval";
}

function parentDestinationMatchesOrigin(destination: Destination, originThreadRef: string): boolean {
  if (destination.type === "slack") {
    const [surface, channel, ...thread] = originThreadRef.split(":");
    const threadTs = thread.join(":");
    return (
      surface === "slack" &&
      Boolean(channel && threadTs) &&
      destination.target === `${channel}:${threadTs}` &&
      (destination.threadTs === undefined || destination.threadTs === threadTs)
    );
  }
  if (destination.type === "web" || destination.type === "desktop") {
    return originThreadRef.startsWith(`${destination.type}:`);
  }
  return false;
}

type FinnyJudgmentInput = Parameters<FinnyToolService["completeJudgment"]>[0];

function judgmentQuestionControlIds(questions: unknown[]): string[] {
  return questions.map((question) => {
    if (!question || typeof question !== "object" || !("controlId" in question)) {
      throw new Error("Finny pending judgment question is invalid");
    }
    const controlId = question.controlId;
    if (typeof controlId !== "string" || !controlId) throw new Error("Finny pending judgment question is invalid");
    return controlId;
  });
}

function exactJudgmentAnswers(questions: unknown[], input: FinnyJudgmentInput) {
  const questionIds = judgmentQuestionControlIds(questions);
  const questionIdSet = new Set(questionIds);
  const answerIds = input.judgmentAnswers.map((answer) => answer.controlId);
  const answerIdSet = new Set(answerIds);
  if (
    questionIdSet.size !== questionIds.length ||
    answerIdSet.size !== answerIds.length ||
    answerIdSet.size !== questionIdSet.size ||
    [...questionIdSet].some((controlId) => !answerIdSet.has(controlId))
  ) {
    throw new Error("Finny judgment must answer every pending judgment question exactly once");
  }
  return new Map(input.judgmentAnswers.map((answer) => [answer.controlId, answer]));
}

function auditAttemptResult(attempt: { controls: FinnyAuditControlResult[] }): string {
  const blockedControlId = attempt.controls.find((control) => control.verdict === "block")?.id;
  if (blockedControlId) return `Audit attempt recorded BLOCK for ${blockedControlId}.`;
  return `Audit attempt recorded ${attempt.controls.length} PASS results.`;
}

export function finnyTurnAuthority(
  surface: string | undefined,
  deliveryTarget: string | undefined,
  external: boolean,
  rootMessageTs?: string,
  sessionId?: string,
): { originThreadRef: string; destination: Destination } | undefined {
  if (external) return undefined;
  if (surface === "slack") {
    if (!deliveryTarget) return undefined;
    let canonicalTarget: string | undefined;
    if (deliveryTarget.includes(":")) canonicalTarget = deliveryTarget;
    else if (rootMessageTs) canonicalTarget = `${deliveryTarget}:${rootMessageTs}`;
    if (!canonicalTarget) return undefined;
    const separator = canonicalTarget.indexOf(":");
    const threadTs = canonicalTarget.slice(separator + 1);
    return {
      originThreadRef: `slack:${canonicalTarget}`,
      destination: {
        type: "slack",
        target: canonicalTarget,
        ...(threadTs ? { threadTs } : {}),
      },
    };
  }
  if (surface === "web" || surface === "desktop") {
    const target = deliveryTarget ?? sessionId;
    if (!target) return undefined;
    const originThreadRef = target.startsWith(`${surface}:`) ? target : `${surface}:${target}`;
    return {
      originThreadRef,
      destination: {
        type: surface as "web" | "desktop",
        target: originThreadRef,
      },
    };
  }
  return undefined;
}

export const finnySlackAuthority = finnyTurnAuthority;
export interface FinnyToolServiceFactory {
  forTurn(turn: FinnyTurnBinding): Promise<FinnyToolService | undefined>;
}

export function createFinnyToolServiceFactory(deps: {
  config: Omit<FinnyIntegrationConfig, "signingSecret">;
  jobs: Pick<
    FinnyStore,
    | "createJob"
    | "getApprovalRequest"
    | "getJob"
    | "recordSopAmendment"
    | "getAuditAttempt"
    | "getAuditAttemptByOperation"
    | "completeAuditJudgment"
  >;
  runtime: Pick<FinnyRuntimeStore, "currentBinding" | "claimParentTurn"> &
    Partial<Pick<FinnyRuntimeStore, "claimWorkerTurn" | "bindingForSession">>;
  integration: FinnyIntegrationStore;
  deliveries: Pick<DeliveryStore, "enqueue">;
  coordinator: FinnyCoordinatorPort;
  certifyResult(input: {
    scopeId: string;
    result: FinnyCertifiedResult;
    destination: Destination;
    idempotencyKey: string;
  }): Promise<void>;
  deliverCertifiedResults(): Promise<void>;
  ids?: () => string;
}) {
  const id = deps.ids ?? randomUUID;
  return {
    async forTurn(turn: FinnyTurnBinding): Promise<FinnyToolService | undefined> {
      if (turn.actor.type !== "internal" || !turn.runId || !turn.sessionId) return undefined;
      let current = await deps.runtime.currentBinding(turn.sessionId);
      if (
        current?.role === "parent" &&
        current.scopeId === turn.scopeId &&
        current.principalId === turn.actor.id &&
        current.runId !== turn.runId
      ) {
        current = await deps.runtime.claimParentTurn({
          sessionId: turn.sessionId,
          runId: turn.runId,
          scopeId: turn.scopeId,
          principalId: turn.actor.id,
        });
      } else if (deps.runtime.claimWorkerTurn && deps.runtime.bindingForSession) {
        const historical = current ?? (await deps.runtime.bindingForSession(turn.sessionId));
        if (
          historical &&
          historical.active &&
          historical.scopeId === turn.scopeId &&
          (historical.role === "producer" || historical.role === "auditor") &&
          (historical.runId !== turn.runId || !current)
        ) {
          const ttl = deps.config.workerGrantTtlMs ?? 3_600_000;
          current = await deps.runtime.claimWorkerTurn({
            sessionId: turn.sessionId,
            runId: turn.runId,
            scopeId: turn.scopeId,
            expiresAt: Date.now() + ttl,
          });
        }
      }
      if (
        current &&
        (current.sessionId !== turn.sessionId ||
          current.runId !== turn.runId ||
          current.scopeId !== turn.scopeId ||
          (current.role === "parent" && current.principalId !== turn.actor.id))
      )
        return undefined;
      if (!current && (!turn.parent || !parentDestinationMatchesOrigin(turn.destination, turn.originThreadRef)))
        return undefined;
      const jobForWorker = async (role: "producer" | "auditor"): Promise<FinnyJob> => {
        if (!current || current.role !== role)
          throw new Error(`Finny action requires the current ${role === "auditor" ? "Auditor" : "Producer"}`);
        const job = await deps.jobs.getJob(current.scopeId, current.jobId);
        if (!job) throw new Error("Finny job is unavailable");
        return job;
      };
      return {
        role: current?.role ?? "parent",
        async createPlan(
          sop: FinnySopVersion,
          values: Record<string, string | boolean>,
          materialClarification?: FinnyMaterialClarification,
        ): Promise<FinnyPlanCreation> {
          if (current) throw new Error("Finny workers cannot create plans");
          if (materialClarification) assertFinnyMaterialClarificationMatchesSop(sop, values, materialClarification);
          const jobId = id();
          const requestId = id();
          const jobInput = {
            id: jobId,
            scopeId: turn.scopeId,
            sop,
            values,
            policy: initialFinnyPolicy(deps.config.spreadsheetEngine.evaluator),
            findingPolicy: deps.config.findingPolicy,
            originThreadRef: turn.originThreadRef,
          };
          const parent = {
            scopeId: turn.scopeId,
            jobId,
            requestId,
            actorId: turn.actor.id,
            originThreadRef: turn.originThreadRef,
            destination: turn.destination,
            binding: turn.parentBinding,
          };
          const clarification = materialClarification
            ? {
                scopeId: turn.scopeId,
                jobId,
                requestId: id(),
                authorizedActorId: turn.actor.id,
                ...materialClarification,
                idempotencyKey: `finny-clarification:${jobId}`,
              }
            : undefined;
          await deps.integration.createPlanIntent({
            job: jobInput,
            parent,
            ...(clarification ? { clarification } : {}),
          });
          await deps.jobs.createJob(jobInput);
          await deps.integration.completePlanIntent(parent, clarification);
          await deps.deliveries.enqueue({
            destination: {
              ...turn.destination,
              finnyPlanRequestId: clarification?.requestId ?? requestId,
            },
            text: clarification?.question ?? sop.title,
            idempotencyKey: clarification
              ? `finny-clarification:${clarification.requestId}`
              : `finny-plan:${requestId}`,
          });
          return {
            message: clarification
              ? `Finny plan ${jobId} is awaiting clarification.`
              : `Finny plan ${jobId} is awaiting approval.`,
            jobId,
            requestId: clarification?.requestId ?? requestId,
            awaiting: clarification ? ("clarification" as const) : ("approval" as const),
          };
        },
        async amendPlan(
          jobId: string,
          sop: FinnySopVersion,
          values: Record<string, string | boolean>,
          materialClarification?: FinnyMaterialClarification,
          operationId?: string,
        ): Promise<FinnyPlanCreation> {
          const job = await deps.jobs.getJob(turn.scopeId, jobId);
          if (!job) throw new Error("Finny job is unavailable");
          if (!job.sopBinding) throw new Error("Finny job has no SOP binding");
          if (materialClarification) assertFinnyMaterialClarificationMatchesSop(sop, values, materialClarification);
          const amendmentId = operationId ?? id();
          const requestId = `finny-amend-${createHash("sha256")
            .update(`${turn.scopeId}\0${jobId}\0${amendmentId}`)
            .digest("base64url")}`;
          const now = Date.now();
          const amendment = await deps.jobs.recordSopAmendment({
            scopeId: turn.scopeId,
            jobId,
            sop,
            values,
            idempotencyKey: `finny-amend:${requestId}`,
            createdAt: now,
            replacementApproval: {
              requestId,
              actorId: turn.actor.id,
              originThreadRef: turn.originThreadRef,
              destination: turn.destination,
              binding: turn.parentBinding,
            },
          });
          const event = amendment.events[0];
          if (!event) throw new Error("Finny amendment did not record durable provenance");
          const material = event.payload.previousExecutionDigest !== event.payload.newExecutionDigest;
          if (!material)
            return {
              message: `Finny plan ${jobId} amendment was recorded without changing its approved execution.`,
              jobId,
              awaiting: "none",
            };
          if (amendment.deduped) {
            const replacement = await deps.jobs.getApprovalRequest(requestId);
            if (!replacement) throw new Error("Finny amendment replacement approval is unavailable");
            if (replacement.decidedAt !== undefined)
              return {
                message: `Finny plan ${jobId} amendment was already recorded and is no longer awaiting approval.`,
                jobId,
                awaiting: "none",
              };
          }
          if (amendment.job.approval) throw new Error("Finny material amendment retained its existing approval");
          await deps.deliveries.enqueue({
            destination: {
              ...turn.destination,
              finnyPlanRequestId: requestId,
            },
            text: `[Amended Scope] ${sop.title}`,
            idempotencyKey: `finny-plan-amendment:${requestId}`,
          });
          return {
            message: `Finny plan ${jobId} amendment is awaiting scope change approval.`,
            jobId,
            requestId,
            awaiting: "approval",
          };
        },
        async status(jobId: string): Promise<string> {
          const scopeId = current ? current.scopeId : turn.scopeId;
          const job = await deps.jobs.getJob(scopeId, jobId);
          if (!job) throw new Error("Finny job is unavailable in this scope");
          return JSON.stringify({
            jobId: job.id,
            eventHead: job.eventHead,
            status: jobStatus(job),
          });
        },
        async artifactReady(input): Promise<string> {
          const job = await jobForWorker("producer");
          await deps.integration.saveArtifactProposal({
            scopeId: current!.scopeId,
            jobId: job.id,
            sessionId: turn.sessionId,
            runId: turn.runId,
            ...input,
          });
          await deps.coordinator.artifactReady({
            scopeId: current!.scopeId,
            jobId: job.id,
            sessionId: turn.sessionId,
            runId: turn.runId,
            idempotencyKey: input.idempotencyKey,
          });
          return `Artifact ${input.artifactDigest} is queued for independent audit.`;
        },
        async completeJudgment(input): Promise<string> {
          const job = await jobForWorker("auditor");
          if (!job.artifactDigest) throw new Error("Finny job has no current artifact");
          if (!job.currentAuditAttemptId) throw new Error("Finny job has no current audit attempt");
          const requestDigest = createHash("sha256")
            .update(JSON.stringify({ judgmentAnswers: input.judgmentAnswers }))
            .digest("hex");
          const operation = await deps.jobs.getAuditAttemptByOperation(current!.scopeId, job.id, input.idempotencyKey);
          if (operation) {
            if (operation.requestDigest !== requestDigest) {
              throw new Error("Finny judgment idempotency key was reused with different judgment content");
            }
            const replayed = operation.attempt;
            await deps.coordinator.auditAttemptRecorded({
              scopeId: current!.scopeId,
              jobId: job.id,
              attemptId: replayed.id,
              artifactDigest: job.artifactDigest,
              verdict: replayed.verdict,
              controls: replayed.controls,
            });
            return auditAttemptResult(replayed);
          }
          const currentAttempt = await deps.jobs.getAuditAttempt(current!.scopeId, job.id, job.currentAuditAttemptId);
          if (!currentAttempt || currentAttempt.verdict !== "pending_judgment") {
            throw new Error("Finny current audit attempt is not pending judgment");
          }
          const answersById = exactJudgmentAnswers(currentAttempt.judgmentQuestions, input);
          const controls = [...answersById].map(([controlId, answer]) => {
            const stored = currentAttempt.controls.find((control) => control.id === controlId);
            if (!stored) throw new Error(`Finny pending judgment control ${controlId} is unavailable`);
            return {
              ...stored,
              verdict: answer.verdict,
              evidenceRefs: [...new Set([...stored.evidenceRefs, ...answer.evidenceRefs])],
              repairActions: answer.verdict === "pass" ? [] : stored.repairActions,
            };
          });
          const completed = await deps.jobs.completeAuditJudgment({
            scopeId: current!.scopeId,
            jobId: job.id,
            attemptId: currentAttempt.id,
            controls,
            judgmentAddendum: {
              issuerPrincipalId: current!.principalId,
              issuerRunId: turn.runId,
              answers: input.judgmentAnswers,
            },
            idempotencyKey: input.idempotencyKey,
            requestDigest,
            completedAt: Date.now(),
          });
          await deps.coordinator.auditAttemptRecorded({
            scopeId: current!.scopeId,
            jobId: job.id,
            attemptId: completed.attempt.id,
            artifactDigest: job.artifactDigest,
            verdict: completed.attempt.verdict,
            controls: completed.attempt.controls,
          });
          return auditAttemptResult(completed.attempt);
        },
        async finalize(input): Promise<string> {
          if (current?.role !== "parent" || current.jobId !== input.jobId)
            throw new Error("Finny finalization requires the bound parent session");
          const job = await deps.jobs.getJob(turn.scopeId, input.jobId);
          if (!job) throw new Error("Finny job is unavailable in this scope");
          if (!job.sopBinding || !job.artifactDigest || !job.provisionalRevision || !job.currentAuditAttemptId) {
            throw new Error("Finny certification requires the current audited artifact");
          }
          await deps.certifyResult({
            scopeId: turn.scopeId,
            result: {
              schema: FINNY_CERTIFIED_RESULT_SCHEMA,
              jobId: job.id,
              sopVersionId: job.sopBinding.versionId,
              executionDigest: job.sopBinding.executionDigest,
              artifact: {
                fileId: job.provisionalRevision,
                sha256: job.artifactDigest,
                mime: FINNY_XLSX_MIME,
              },
              summary: input.summary,
              auditAttemptId: job.currentAuditAttemptId,
            },
            destination: turn.destination,
            idempotencyKey: input.idempotencyKey,
          });
          await deps.deliverCertifiedResults();
          return `Finny job ${job.id} finalized with signed receipt.`;
        },
      };
    },
  };
}

const deterministicChecks = new Set<FinnyCheckId>(SPREADSHEET_WORKER_CHECK_IDS);

function matchesFinnyFileScope(
  artifact: { ownerScopeId: string; createdInScope?: string },
  targetScopeId: string,
): boolean {
  if (artifact.ownerScopeId === targetScopeId || artifact.createdInScope === targetScopeId) return true;
  const targetKind = parseScopeId(targetScopeId).kind;
  if (targetKind === "org") {
    const ownerKind = parseScopeId(artifact.ownerScopeId).kind;
    const createdKind = artifact.createdInScope ? parseScopeId(artifact.createdInScope).kind : null;
    if (ownerKind === "personal" || ownerKind === "org" || createdKind === "personal" || createdKind === "org") {
      return true;
    }
  }
  return false;
}

async function immutableScopedFileBytes(
  files: Pick<FileArtifactStore, "open">,
  scopeId: string,
  fileId: string,
  label: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; digest: string; createdBy: string; mime: string; sizeBytes: number }> {
  const opened = await files.open(fileId);
  if (
    !opened ||
    !opened.artifact.enabled ||
    !matchesFinnyFileScope(opened.artifact, scopeId) ||
    opened.artifact.id !== fileId
  ) {
    throw new Error(`Finny ${label} is not an enabled immutable scoped evidence file`);
  }
  if (opened.sizeBytes > maxBytes) {
    opened.stream.destroy();
    throw new Error(`Finny ${label} exceeds the configured byte limit`);
  }
  const chunks: Buffer[] = [];
  let streamedBytes = 0;
  for await (const chunk of opened.stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    streamedBytes += bytes.byteLength;
    if (streamedBytes > maxBytes) {
      opened.stream.destroy();
      throw new Error(`Finny ${label} exceeds the configured byte limit`);
    }
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength !== opened.sizeBytes) throw new Error(`Finny ${label} byte length is invalid`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (opened.artifact.sha256 !== digest) throw new Error(`Finny ${label} immutable digest is invalid`);
  return {
    bytes,
    digest,
    createdBy: opened.artifact.createdBy,
    mime: opened.artifact.mimetype,
    sizeBytes: opened.sizeBytes,
  };
}

export interface FinnyResolvedEvidenceAuthority {
  evidenceDigest: string;
  deterministicAuthority?: FinnyDeterministicEvidenceAuthority;
}

export async function resolveFinnyEvidenceFile(
  files: Pick<FileArtifactStore, "open">,
  input: {
    job: FinnyJob;
    evidenceFileId: string;
    checkId: FinnyCheckId;
    generation: number;
    verdict: FinnyVerdict;
  },
  limits: { maxArtifactBytes: number; maxEvidenceBytes: number },
): Promise<FinnyResolvedEvidenceAuthority> {
  const evidence = await immutableScopedFileBytes(
    files,
    input.job.scopeId,
    input.evidenceFileId,
    "evidence file",
    limits.maxEvidenceBytes,
  );
  if (!deterministicChecks.has(input.checkId)) return { evidenceDigest: evidence.digest };
  if (evidence.createdBy !== SPREADSHEET_WORKER_PRINCIPAL_ID) {
    throw new Error("Finny evidence file lacks deterministic worker provenance");
  }
  if (!input.job.artifactDigest || !input.job.provisionalRevision) throw new Error("Finny job has no current artifact");
  const artifact = await immutableScopedFileBytes(
    files,
    input.job.scopeId,
    input.job.provisionalRevision,
    "current artifact",
    limits.maxArtifactBytes,
  );
  if (artifact.digest !== input.job.artifactDigest) throw new Error("Finny current artifact digest is invalid");
  let candidate: unknown;
  try {
    candidate = JSON.parse(new TextDecoder().decode(evidence.bytes)) as unknown;
  } catch (error) {
    throw new Error("Finny deterministic evidence JSON is invalid", { cause: error });
  }
  const binding = {
    artifactDigest: input.job.artifactDigest,
    policyVersion: input.job.policy.policyVersion,
    evaluator: input.job.policy.evaluator,
    checks: SPREADSHEET_WORKER_CHECK_IDS.map((checkId) => ({
      checkId,
      generation: input.job.policy.requiredGenerations[checkId],
    })),
  };
  const envelope = verifySpreadsheetWorkerEnvelope(artifact.bytes, binding, candidate);
  const result = envelope.results.find((entry) => entry.checkId === input.checkId);
  if (!result || result.generation !== input.generation) {
    throw new Error("Finny deterministic evidence does not contain the requested current generation");
  }
  if (result.verdict !== input.verdict) throw new Error("Finny deterministic evidence verdict is invalid");
  return {
    evidenceDigest: envelope.envelopeDigest,
    deterministicAuthority: {
      evaluator: envelope.evaluator,
      reasonSchemaVersion: envelope.contractVersion,
      reasonCode: result.verdict === "pass" ? "PASS" : result.reason.code,
    },
  };
}

export async function resolveFinnyFileArtifactProposal(
  files: Pick<FileArtifactStore, "get">,
  proposal: FinnyArtifactProposal,
  maxArtifactBytes: number,
): Promise<{ artifactDigest: string; provisionalRevision: string }> {
  const artifact = await files.get(proposal.provisionalRevision, { includeDisabled: true });
  if (
    !artifact ||
    !artifact.enabled ||
    !matchesFinnyFileScope(artifact, proposal.scopeId) ||
    artifact.sha256 !== proposal.artifactDigest
  )
    throw new Error("Finny artifact proposal does not match an immutable file artifact");
  if (artifact.sizeBytes > maxArtifactBytes) {
    throw new Error("Finny artifact proposal exceeds the configured byte limit");
  }
  return { artifactDigest: artifact.sha256, provisionalRevision: artifact.id };
}

export function createFinnyEscalationDecision(deps: { jobs: Pick<FinnyStore, "listEvents">; maxReworks: number }) {
  return {
    async decide(input: { scopeId: string; jobId: string }) {
      const events = await deps.jobs.listEvents(input.scopeId, input.jobId);
      const reworks = events.filter((event) => event.type === "rework_requested").length;
      return reworks >= deps.maxReworks
        ? ({ kind: "escalate", reason: `Finny reached the configured ${deps.maxReworks} BLOCK limit` } as const)
        : ({ kind: "rework" } as const);
    },
  };
}
