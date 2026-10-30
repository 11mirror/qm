import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { toolCallApprovalKey } from "../core/approval-id.ts";
import type { NativeToolDefinition, ToolContextRef } from "../harness/agent-tools.ts";
import type { HarnessTurnInput } from "../harness/harness.ts";
import { reportFailure } from "../util/errors.ts";
import type { DurableByteStore } from "../files/durable-byte-store.ts";
import type { FinnyCapabilityCatalog } from "./capability-pack.ts";
import { compileFinnyControllerRequest } from "./controller-compiler.ts";
import type { FinnyIntentCandidate } from "./intent-resolver.ts";
import {
  finnyApprovalPolicyDigest,
  createFinnyPlanPreflight,
  type FinanceAction,
  type FinanceExecutionContext,
  type FinanceService,
} from "./finance.ts";
import { FINANCE_RESOURCE_NAME } from "./finance.ts";
import {
  FinanceFailure,
  financeFailureBlockerCode,
  financeFailureFromUnknown,
  financeFailureWithDiagnostic,
  type FinanceDiagnosticSink,
} from "./finance-failure.ts";
import type { FinnyOperationPlan } from "./operation-compiler.ts";
import { loadFinnyOperationPlan, storeFinnyOperationPlan } from "./operation-custody.ts";
import {
  applyFinnyHostEvent,
  createFinnyGoldenLoop,
  digestFinnyEvidence,
  replayFinnyLedger,
  type FinnyDigest,
  type FinnyGoldenLoopState,
  type FinnyHostEvent,
} from "./golden-loop.ts";
import { finnyWorkflowRunIdFromEntries, type FinnyRunStore, type FinnyRunV2Checkpoint } from "./run-store.ts";
import { createFinnyTraceSnapshot, type FinnyTraceBlocker, type FinnyTraceSnapshot } from "./trace.ts";

export interface FinnyFinanceToolOptions {
  runStore: FinnyRunStore;
  evidenceBytes: DurableByteStore;
  capabilityCatalog: FinnyCapabilityCatalog | Promise<FinnyCapabilityCatalog>;
  diagnostics?: FinanceDiagnosticSink;
  reportUnexpectedError?: (error: unknown, context: string) => void;
  now?: () => string;
  nowMs?: () => number;
}

interface FinnyToolDetails {
  stage: FinnyGoldenLoopState["stage"];
  trace: FinnyTraceSnapshot;
  blocker?: FinnyTraceBlocker;
}

const parameters = Type.Object(
  {
    capabilityId: Type.String({ minLength: 1 }),
    dimensions: Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())])),
    artifactFormat: Type.Optional(Type.Union([Type.Literal("json"), Type.Literal("csv")])),
  },
  { additionalProperties: false },
);

function isFinnyRunRequest(value: unknown): value is FinnyIntentCandidate {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { capabilityId?: unknown }).capabilityId === "string" &&
    !!(value as { dimensions?: unknown }).dimensions &&
    typeof (value as { dimensions: unknown }).dimensions === "object"
  );
}

function detailsOf(result: { details?: unknown }): FinnyToolDetails | undefined {
  if (!result.details || typeof result.details !== "object") return undefined;
  const details = result.details as Partial<FinnyToolDetails>;
  return typeof details.stage === "string" ? (details as FinnyToolDetails) : undefined;
}

function planArtifactRequest(plan: FinnyOperationPlan): "required" | "optional" {
  const artifact = plan.dimensions.artifact;
  if (artifact !== "required" && artifact !== "optional")
    throw new Error(`Finny plan ${plan.planDigest} has an invalid artifact request`);
  return artifact;
}

function assertCustodiedPlanBinding(checkpoint: FinnyRunV2Checkpoint, plan: FinnyOperationPlan): void {
  if (
    checkpoint.plan.planDigest !== plan.planDigest ||
    checkpoint.plan.catalogDigest !== plan.catalogDigest ||
    checkpoint.plan.capabilityId !== plan.capabilityId ||
    checkpoint.plan.revisionId !== plan.revisionId ||
    checkpoint.plan.operationGraphDigest !== plan.operationGraphDigest
  )
    throw new Error(`Finny run ${checkpoint.runId} has a conflicting custodied plan`);
}

function assertCandidatePlanSemantics(candidate: FinnyOperationPlan, custodied: FinnyOperationPlan): void {
  if (
    candidate.capabilityId !== custodied.capabilityId ||
    candidate.revisionId !== custodied.revisionId ||
    candidate.semanticCapability !== custodied.semanticCapability ||
    candidate.dimensionsDigest !== custodied.dimensionsDigest ||
    candidate.operationGraphDigest !== custodied.operationGraphDigest ||
    candidate.resultOperationId !== custodied.resultOperationId ||
    candidate.artifactPolicyDigest !== custodied.artifactPolicyDigest ||
    candidate.approvalPolicyDigest !== custodied.approvalPolicyDigest ||
    candidate.verificationPolicyDigest !== custodied.verificationPolicyDigest
  )
    throw new Error("Finny candidate does not match the custodied plan");
}

async function loadCustodiedPlan(
  evidenceBytes: DurableByteStore,
  checkpoint: FinnyRunV2Checkpoint,
): Promise<FinnyOperationPlan> {
  const plan = await loadFinnyOperationPlan(evidenceBytes, {
    blobKey: `files/${checkpoint.plan.planDigest.slice("sha256:".length)}`,
    planDigest: checkpoint.plan.planDigest,
  });
  assertCustodiedPlanBinding(checkpoint, plan);
  return plan;
}

export function createFinnyFinanceTool(
  turn: HarnessTurnInput,
  ref: ToolContextRef,
  service: FinanceService,
  options: FinnyFinanceToolOptions,
): NativeToolDefinition {
  if (!turn.runId) throw new Error("Finny finance requires a trusted runId");
  const actorId = turn.runtimeActorId ?? ref.runtimeActorId;
  if (!actorId) throw new Error("Finny finance requires a trusted actor identity");
  const runStore = options.runStore;

  const priorWorkflowRunId = finnyWorkflowRunIdFromEntries(turn.history);
  const currentTurnRequest = (turn.trustedInput ?? turn.input).trim();
  const currentTurnRequestDigest = digestFinnyEvidence(`finny-request:v1:${currentTurnRequest}`);
  let workflowRunId = turn.runId;
  let resolvedRequest = currentTurnRequest;
  let state = createFinnyGoldenLoop(workflowRunId);
  let context: FinanceExecutionContext = {
    runId: workflowRunId,
    actorId,
    scopeId: turn.scopeLabel,
    credentialHandles: [...(turn.commandCredentialHandles ?? [])],
    requestText: currentTurnRequest,
  };
  const now = options.now ?? (() => new Date().toISOString());
  const nowMs = options.nowMs ?? Date.now;
  let activeRequestDigest: FinnyDigest | undefined;
  let approvalOperationPlan: FinnyOperationPlan | undefined;
  const resolveWorkflow = async (): Promise<void> => {
    const requestDigest = currentTurnRequestDigest;
    const checkpoint = priorWorkflowRunId ? await runStore.load(priorWorkflowRunId) : null;
    if (
      checkpoint &&
      checkpoint.requestDigest === requestDigest &&
      checkpoint.requestDigest === currentTurnRequestDigest &&
      replayFinnyLedger(checkpoint.runId, checkpoint.ledger).stage !== "DELIVERY_ELIGIBLE"
    ) {
      workflowRunId = checkpoint.runId;
      state = replayFinnyLedger(checkpoint.runId, checkpoint.ledger);
      resolvedRequest = currentTurnRequest;
    } else {
      workflowRunId = turn.runId!;
      state = createFinnyGoldenLoop(workflowRunId);
      resolvedRequest = currentTurnRequest;
    }
    context = { ...context, runId: workflowRunId, requestText: resolvedRequest };
  };
  const runEventBase = (suffix: string) => ({
    authority: "qm-host" as const,
    eventId: `${workflowRunId}:${suffix}`,
    occurredAt: now(),
  });
  const planApprovalSummary = (plan: FinnyOperationPlan) =>
    createFinnyPlanPreflight({
      request: resolvedRequest,
      clarificationDigest: state.clarificationDigest ?? digestFinnyEvidence("finny-clarification:pending"),
      plan,
    }).planSummary;
  const planApprovalBinding = (plan: FinnyOperationPlan, approvalSummary = planApprovalSummary(plan)) => ({
    request: resolvedRequest,
    schema: plan.schema,
    planDigest: plan.planDigest,
    catalogDigest: plan.catalogDigest,
    manifestDigest: plan.manifestDigest,
    capabilityId: plan.capabilityId,
    revisionId: plan.revisionId,
    semanticCapability: plan.semanticCapability,
    dimensionsDigest: plan.dimensionsDigest,
    operationGraphDigest: plan.operationGraphDigest,
    resultOperationId: plan.resultOperationId,
    artifactPolicyDigest: plan.artifactPolicyDigest,
    approvalPolicyDigest: plan.approvalPolicyDigest,
    verificationPolicyDigest: plan.verificationPolicyDigest,
    approvalSummary,
  });

  const executeRunUnlocked = async (callId: string, candidate: FinnyIntentCandidate) => {
    const startedAt = nowMs();
    let activeAction: FinanceAction = "clarify";
    let records: readonly unknown[] | undefined;
    let artifactReference: string | undefined;
    const applyRun = async (events: FinnyHostEvent[], reference?: string) => {
      for (const event of events) {
        const candidate = applyFinnyHostEvent(state, event);
        const metadata = candidate.ledger.at(-1);
        if (!metadata) throw new Error("Finny event produced no ledger metadata");
        const checkpoint = await runStore.checkpoint(workflowRunId, metadata, reference);
        state = replayFinnyLedger(checkpoint.runId, checkpoint.ledger);
      }
    };
    const details = (blocker?: FinnyTraceBlocker): FinnyToolDetails => ({
      stage: state.stage,
      trace: createFinnyTraceSnapshot(state, turn, blocker, {
        action: activeAction,
        durationMs: Math.max(0, nowMs() - startedAt),
        attempt: 1,
      }),
      ...(blocker ? { blocker } : {}),
    });

    try {
      const normalizedRequest = resolvedRequest;
      activeRequestDigest = digestFinnyEvidence(`finny-request:v1:${normalizedRequest}`);
      context = { ...context, requestText: normalizedRequest };
      activeAction = "preflight";
      const existing = await runStore.load(workflowRunId);
      if (existing && existing.requestDigest !== activeRequestDigest) {
        throw new FinanceFailure("policy_block", {
          dependency: "qm-host",
          diagnosticId: digestFinnyEvidence(`finny-diagnostic:v1:${callId}:request_mismatch`),
        });
      }
      const controller = compileFinnyControllerRequest(candidate, await Promise.resolve(options.capabilityCatalog));
      if (controller.status !== "compiled") throw new FinanceFailure("schema_mapping_required");
      const candidatePlan = controller.plan;
      let operationPlan: FinnyOperationPlan;
      if (existing) {
        operationPlan = await loadCustodiedPlan(options.evidenceBytes, existing);
        assertCandidatePlanSemantics(candidatePlan, operationPlan);
      } else {
        operationPlan = candidatePlan;
        await storeFinnyOperationPlan(options.evidenceBytes, operationPlan);
      }
      approvalOperationPlan = operationPlan;
      const artifactRequest = planArtifactRequest(operationPlan);
      await runStore.initialize({
        schema: "finny.run.v2",
        runId: workflowRunId,
        requestDigest: activeRequestDigest,
        sessionId: turn.session.id,
        scopeId: turn.scopeLabel,
        plan: {
          catalogDigest: operationPlan.catalogDigest,
          capabilityId: operationPlan.capabilityId,
          revisionId: operationPlan.revisionId,
          operationGraphDigest: operationPlan.operationGraphDigest,
          planDigest: operationPlan.planDigest,
        },
      });
      const checkpoint = await runStore.load(workflowRunId);
      if (!checkpoint) throw new Error("Finny run checkpoint initialization failed");
      state = replayFinnyLedger(checkpoint.runId, checkpoint.ledger);
      artifactReference = checkpoint.artifactReference;

      if (state.stage === "CLARIFY") {
        activeAction = "clarify";
        const output = await service.clarify({ request: normalizedRequest }, context);
        await applyRun([
          { ...runEventBase("clarify"), kind: "clarify_completed", evidenceDigest: output.evidenceDigest },
        ]);
      }

      if (state.stage === "PREFLIGHT" && !state.planDigest) {
        activeAction = "preflight";
        if (!state.clarificationDigest) throw new Error("Host clarification evidence is missing");
        const output = createFinnyPlanPreflight({
          request: normalizedRequest,
          clarificationDigest: state.clarificationDigest,
          plan: operationPlan,
        });
        const approvalRequired = operationPlan.approvalPolicy.mode === "before_source";
        await applyRun([
          {
            ...runEventBase("preflight"),
            kind: "operation_plan_preflight_completed",
            preflightDigest: output.preflightDigest,
            planDigest: operationPlan.planDigest,
            catalogDigest: operationPlan.catalogDigest,
            manifestDigest: operationPlan.manifestDigest,
            capabilityId: operationPlan.capabilityId,
            revisionId: operationPlan.revisionId,
            operationGraphDigest: operationPlan.operationGraphDigest,
            artifactPolicyDigest: operationPlan.artifactPolicyDigest,
            approvalPolicyDigest: operationPlan.approvalPolicyDigest,
            verificationPolicyDigest: operationPlan.verificationPolicyDigest,
            approvalRequired,
          },
        ]);
        if (approvalRequired) {
          const approvalKey = toolCallApprovalKey(
            FINANCE_RESOURCE_NAME,
            planApprovalBinding(operationPlan, output.planSummary),
          );
          ref.pendingApprovals?.push({
            command: output.planSummary,
            reason: "approve the exact Finny finance plan before source execution",
            kind: "approval",
            approvalKey,
            summary: output.planSummary,
            grantModes: { session: false, always: false },
          });
          ref.pausedOnApproval = true;
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  profile: "finny",
                  harness: "pi",
                  action: "run",
                  outcome: "approval_required",
                  stage: state.stage,
                  planSummary: output.planSummary,
                }),
              },
            ],
            terminate: true,
            details: details(),
          };
        }
      }

      if (state.stage === "PREFLIGHT" && state.planDigest) {
        activeAction = "plan";
        const planSummary = planApprovalSummary(operationPlan);
        const approvalKey = toolCallApprovalKey(FINANCE_RESOURCE_NAME, planApprovalBinding(operationPlan, planSummary));
        const exactCallApproved = ref.approvedToolCalls?.get(callId) === approvalKey;
        if (state.approvalRequired !== false && !exactCallApproved) {
          ref.pendingApprovals?.push({
            command: planSummary,
            reason: "approve the exact Finny finance plan before source execution",
            kind: "approval",
            approvalKey,
            summary: planSummary,
            grantModes: { session: false, always: false },
          });
          ref.pausedOnApproval = true;
          return {
            content: [{ type: "text" as const, text: "[blocked: needs human approval] exact finance plan" }],
            terminate: true,
            details: details(),
          };
        }
        if (operationPlan.planDigest !== state.planDigest)
          throw new Error("Finny approved plan does not match the compiled plan");
        if (state.approvalRequired === false) {
          await applyRun([
            {
              ...runEventBase("plan-exemption"),
              kind: "plan_exempted",
              planDigest: operationPlan.planDigest,
              approvalPolicyDigest: finnyApprovalPolicyDigest(operationPlan),
            },
          ]);
        } else {
          await applyRun([
            {
              ...runEventBase("plan"),
              kind: "plan_approved",
              planDigest: operationPlan.planDigest,
              approvalDigest: digestFinnyEvidence(`finny-human-approval:v1:${approvalKey}`),
            },
          ]);
        }
      }

      if (state.stage === "PLAN_APPROVED") {
        activeAction = "source";
        const output = await service.sourcePlan({ plan: operationPlan }, context);
        const sourcedCheckpoint = await runStore.load(workflowRunId);
        if (!sourcedCheckpoint) throw new Error("Finny operation checkpoint is unavailable");
        state = replayFinnyLedger(workflowRunId, sourcedCheckpoint.ledger);
        if (state.stage !== "PLAN_APPROVED" || state.planDigest !== operationPlan.planDigest)
          throw new Error("Finny operation checkpoint does not match the approved plan");
        for (const operationId of [
          operationPlan.resultOperationId,
          ...operationPlan.verificationPolicy.requiredOperationIds,
        ])
          if (!state.completedOperations[operationId])
            throw new Error(`Finny operation ${operationId} did not complete before source custody`);
        records = output.records;
        await applyRun([{ ...runEventBase("source"), kind: "source_collected", sourceDigest: output.sourceDigest }]);
      }

      if (state.stage === "SOURCE") {
        activeAction = "artifact";
        if (!state.sourceDigest) throw new Error("Source evidence digest is missing");
        const output = await service.artifact(
          { sourceDigest: state.sourceDigest, requirement: artifactRequest },
          context,
        );
        artifactReference = output.reference;
        await applyRun(
          [
            {
              ...runEventBase("artifact-policy"),
              kind: "artifact_classified",
              requirement: output.requirement,
              policyDigest: output.policyDigest,
            },
          ],
          artifactReference,
        );
        if (output.requirement === "required") {
          if (!output.artifactDigest) throw new Error("Required artifact was not produced");
          await applyRun(
            [
              {
                ...runEventBase("artifact"),
                kind: "artifact_produced",
                artifactDigest: output.artifactDigest,
              },
            ],
            artifactReference,
          );
        }
      }

      if (state.stage === "ARTIFACT_REQUIRED" && state.artifactDigest === undefined) {
        activeAction = "artifact";
        if (!state.sourceDigest || !state.artifactPolicyDigest) throw new Error("Artifact checkpoint is incomplete");
        const output = await service.artifact({ sourceDigest: state.sourceDigest, requirement: "required" }, context);
        if (output.requirement !== "required" || !output.artifactDigest) {
          throw new FinanceFailure("verification_failed");
        }
        artifactReference = output.reference ?? artifactReference;
        await applyRun(
          [
            {
              ...runEventBase("artifact"),
              kind: "artifact_produced",
              artifactDigest: output.artifactDigest,
            },
          ],
          artifactReference,
        );
      }

      if (
        state.stage === "ARTIFACT_OPTIONAL" ||
        (state.stage === "ARTIFACT_REQUIRED" && state.artifactDigest !== undefined)
      ) {
        activeAction = "verify";
        if (!state.sourceDigest || !state.artifactRequirement) throw new Error("Verification checkpoint is incomplete");
        const output = await service.verify(
          {
            sourceDigest: state.sourceDigest,
            ...(state.artifactDigest ? { artifactDigest: state.artifactDigest } : {}),
            requirement: state.artifactRequirement,
          },
          context,
        );
        if (!output.passed) throw new FinanceFailure("verification_failed");
        await applyRun([
          {
            ...runEventBase("verification"),
            kind: "verification_passed",
            verificationDigest: output.verificationDigest,
          },
        ]);
      }

      if (state.stage === "VERIFIED") {
        if (!state.verificationDigest) throw new Error("Verification checkpoint is incomplete");
        if (!records) {
          if (!state.sourceDigest) throw new Error("Durable finance source recovery is unavailable");
          records = (await service.recoverSource({ sourceDigest: state.sourceDigest }, context)).records;
        }
        await applyRun([
          {
            ...runEventBase("release"),
            kind: "delivery_authorized",
            deliveryDigest: digestFinnyEvidence(
              `finny-delivery:v2:${state.planDigest}:${state.sourceDigest}:${state.verificationDigest}:${turn.surfaceName ?? "unknown"}:${context.runId}`,
            ),
          },
        ]);
      }

      if (state.stage !== "DELIVERY_ELIGIBLE") throw new Error(`Finance run stopped at ${state.stage}`);
      if (!records && state.sourceDigest) {
        records = (await service.recoverSource({ sourceDigest: state.sourceDigest }, context)).records;
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              profile: "finny",
              harness: "pi",
              action: "run",
              outcome: "delivery_eligible",
              stage: state.stage,
              evidence: {
                ...(records ? { records } : {}),
                ...(artifactReference ? { artifactReference } : {}),
                sourceDigest: state.sourceDigest,
                artifactDigest: state.artifactDigest,
                verificationDigest: state.verificationDigest,
              },
            }),
          },
        ],
        details: details(),
      };
    } catch (error) {
      const failure =
        error instanceof FinanceFailure
          ? financeFailureFromUnknown(error)
          : (() => {
              const errorContext = `${activeAction} run ${workflowRunId}`;
              (
                options.reportUnexpectedError ??
                ((cause, context) => reportFailure("finny finance action", cause, context))
              )(error, errorContext);
              return financeFailureWithDiagnostic(error, {
                runId: workflowRunId,
                operation: `finance ${activeAction}`,
                cause: "internal_error",
                dependency: "qm-host",
                diagnostics: options.diagnostics,
              });
            })();
      const blocker: FinnyTraceBlocker = {
        action: activeAction,
        code: financeFailureBlockerCode(failure.causeCode),
        ...failure.toSafeMetadata(),
      };
      return {
        content: [
          {
            type: "text" as const,
            text:
              blocker.code === "blocked_external"
                ? `[error] blocked_external: ${activeAction} dependency is unavailable`
                : `[error] finance_error: host ${activeAction} action failed`,
          },
        ],
        isError: true,
        terminate: true,
        details: details(blocker),
      };
    }
  };

  const executeRun = async (callId: string, candidate: FinnyIntentCandidate) => {
    await resolveWorkflow();
    return runStore.withRunLock(workflowRunId, () => executeRunUnlocked(callId, candidate));
  };

  const raw = defineTool({
    name: FINANCE_RESOURCE_NAME,
    label: "finance",
    description:
      "Run Finny's host-enforced finance workflow once. The host drives every Golden Loop stage, approval checkpoint, source read, artifact, verification, and release decision.",
    promptSnippet: "Call finance once with a reviewed capability ID and its declared dimensions.",
    promptGuidelines: [
      "Use finance for every finance data request; only the host-owned stage and evidence determine whether a result may be released.",
      "Select only a reviewed capability ID and declared dimensions. Never supply SQL, prose requests, stage transitions, evidence digests, approval, verification, or delivery proof.",
    ],
    executionMode: "sequential",
    parameters,
    async execute(callId, candidate) {
      if (!isFinnyRunRequest(candidate)) throw new Error("Invalid Finny finance request");
      return executeRun(callId, candidate);
    },
  });

  return Object.assign(raw, {
    needsApproval: async (candidate: unknown) => {
      if (!isFinnyRunRequest(candidate)) return false;
      await resolveWorkflow();
      const checkpoint = await runStore.load(workflowRunId);
      const controller = compileFinnyControllerRequest(candidate, await Promise.resolve(options.capabilityCatalog));
      if (controller.status !== "compiled") return false;
      if (checkpoint) {
        approvalOperationPlan = await loadCustodiedPlan(options.evidenceBytes, checkpoint);
        assertCandidatePlanSemantics(controller.plan, approvalOperationPlan);
      } else approvalOperationPlan = controller.plan;
      if (checkpoint) state = replayFinnyLedger(checkpoint.runId, checkpoint.ledger);
      return state.stage === "PREFLIGHT" && !!state.planDigest && state.approvalRequired !== false;
    },
    approvalReason: "approve the exact Finny finance plan before source execution",
    approvalKeyParams: (candidate: unknown) => {
      if (!isFinnyRunRequest(candidate)) return candidate;
      if (!approvalOperationPlan) throw new Error("Finny approval requires a compiled operation plan");
      return planApprovalBinding(approvalOperationPlan);
    },
    approvalCommand: () => {
      if (!approvalOperationPlan) throw new Error("Finny approval requires a compiled operation plan");
      return planApprovalSummary(approvalOperationPlan);
    },
    recordCallSummary: () => ({
      action: "run",
      profile: "finny",
      harness: "pi",
    }),
    recordResultSummary: (result: { details?: unknown }, candidate: unknown) => {
      const details = detailsOf(result);
      return {
        action: "run",
        profile: "finny",
        harness: "pi",
        ...(isFinnyRunRequest(candidate)
          ? {
              finnyWorkflowRunId: workflowRunId,
            }
          : {}),
        ...(details
          ? {
              finnyTrace: details.trace,
              ...(details.blocker ? { finnyBlocker: details.blocker } : {}),
            }
          : {}),
      };
    },
  });
}
