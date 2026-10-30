import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { toolCallApprovalKey } from "../core/approval-id.ts";
import type { NativeToolDefinition, ToolContextRef } from "../harness/agent-tools.ts";
import type { HarnessTurnInput } from "../harness/harness.ts";
import { reportFailure } from "../util/errors.ts";
import { compileFinnyFinanceIntent } from "./capability-registry.ts";
import type { FinanceAction, FinanceExecutionContext, FinanceService } from "./finance.ts";
import { FINANCE_RESOURCE_NAME } from "./finance.ts";
import {
  FinanceFailure,
  financeFailureBlockerCode,
  financeFailureFromUnknown,
  financeFailureWithDiagnostic,
  type FinanceDiagnosticSink,
} from "./finance-failure.ts";
import { normalizeFinnyFinanceIntent } from "./finance-ir.ts";
import {
  applyFinnyHostEvent,
  createFinnyGoldenLoop,
  digestFinnyEvidence,
  replayFinnyLedger,
  type FinnyDigest,
  type FinnyGoldenLoopState,
  type FinnyHostEvent,
} from "./golden-loop.ts";
import { finnyWorkflowRunIdFromEntries, type FinnyRunStore } from "./run-store.ts";
import { createFinnyTraceSnapshot, type FinnyTraceBlocker, type FinnyTraceSnapshot } from "./trace.ts";

export interface FinnyFinanceToolOptions {
  runStore: FinnyRunStore;
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

const parameters = Type.Object({ request: Type.String({ minLength: 1 }) }, { additionalProperties: false });

interface FinnyRunRequest {
  request: string;
}

function isFinnyRunRequest(value: unknown): value is FinnyRunRequest {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { request?: unknown }).request === "string" &&
    (value as { request: string }).request.trim().length > 0 &&
    !("action" in value)
  );
}

function detailsOf(result: { details?: unknown }): FinnyToolDetails | undefined {
  if (!result.details || typeof result.details !== "object") return undefined;
  const details = result.details as Partial<FinnyToolDetails>;
  return typeof details.stage === "string" ? (details as FinnyToolDetails) : undefined;
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
  const resolveWorkflow = async (request: FinnyRunRequest): Promise<void> => {
    const normalizedRequest = request.request.trim();
    const requestDigest = digestFinnyEvidence(`finny-request:v1:${normalizedRequest}`);
    const checkpoint = priorWorkflowRunId ? await options.runStore.load(priorWorkflowRunId) : null;
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
  const approvalBinding = () => ({
    request: resolvedRequest,
    planDigest: state.planDigest,
    queryDigest: state.queryDigest,
    verificationPolicyDigest: state.verificationPolicyDigest,
  });

  const executeRunUnlocked = async (callId: string) => {
    const startedAt = nowMs();
    let activeAction: FinanceAction = "clarify";
    let records: readonly unknown[] | undefined;
    let artifactReference: string | undefined;
    const applyRun = async (events: FinnyHostEvent[], reference?: string) => {
      for (const event of events) {
        const candidate = applyFinnyHostEvent(state, event);
        const metadata = candidate.ledger.at(-1);
        if (!metadata) throw new Error("Finny event produced no ledger metadata");
        const checkpoint = await options.runStore.checkpoint(workflowRunId, metadata, reference);
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
      const normalizedIntent = normalizeFinnyFinanceIntent(normalizedRequest);
      const requireCompilation = () => {
        const value = compileFinnyFinanceIntent(normalizedIntent);
        if (value.status === "unsupported_template") throw new FinanceFailure("unsupported_template");
        if (value.status === "schema_mapping_required") throw new FinanceFailure("schema_mapping_required");
        return value;
      };
      const existing = await options.runStore.load(workflowRunId);
      if (existing && existing.requestDigest !== activeRequestDigest) {
        throw new FinanceFailure("policy_block", {
          dependency: "qm-host",
          diagnosticId: digestFinnyEvidence(`finny-diagnostic:v1:${callId}:request_mismatch`),
        });
      }
      let compilation = existing ? undefined : requireCompilation();
      let artifactRequest = existing ? existing.artifactRequest : normalizedIntent.artifact;
      await options.runStore.initialize({
        runId: workflowRunId,
        requestDigest: activeRequestDigest,
        sessionId: turn.session.id,
        scopeId: turn.scopeLabel,
        artifactRequest,
      });
      const checkpoint = await options.runStore.load(workflowRunId);
      if (!checkpoint) throw new Error("Finny run checkpoint initialization failed");
      state = replayFinnyLedger(checkpoint.runId, checkpoint.ledger);
      artifactRequest = checkpoint.artifactRequest;
      artifactReference = checkpoint.artifactReference;

      if (state.stage === "CLARIFY") {
        compilation ??= requireCompilation();
        activeAction = "clarify";
        const output = await service.clarify({ request: normalizedRequest }, context);
        await applyRun([
          { ...runEventBase("clarify"), kind: "clarify_completed", evidenceDigest: output.evidenceDigest },
        ]);
      }

      if (state.stage === "PREFLIGHT" && !state.planDigest) {
        compilation ??= requireCompilation();
        activeAction = "preflight";
        if (!state.clarificationDigest) throw new Error("Host clarification evidence is missing");
        const output = await service.preflight(
          {
            request: normalizedRequest,
            clarificationDigest: state.clarificationDigest,
            query: compilation.query,
          },
          context,
        );
        const queryDigest = output.queryDigest ?? digestFinnyEvidence(`finny-query:v1:${compilation.query}`);
        const verificationPolicy = compilation.ir.verification;
        const verificationPolicyDigest = digestFinnyEvidence(`finny-verification-policy:v1:${verificationPolicy}`);
        const planDigest = digestFinnyEvidence(
          `finny-plan-binding:v2:${output.planDigest}:${queryDigest}:${verificationPolicyDigest}`,
        );
        await applyRun([
          {
            ...runEventBase("preflight"),
            kind: "preflight_completed",
            preflightDigest: output.preflightDigest,
            planDigest,
            queryDigest,
            verificationPolicy,
            verificationPolicyDigest,
            ...(output.approvalRequired !== undefined ? { approvalRequired: output.approvalRequired } : {}),
            ...(output.approvalPolicyDigest ? { approvalPolicyDigest: output.approvalPolicyDigest } : {}),
          },
        ]);

        if (state.approvalRequired !== false) {
          const approvalKey = toolCallApprovalKey(FINANCE_RESOURCE_NAME, approvalBinding());
          ref.pendingApprovals?.push({
            command: "finance run",
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
        const approvalKey = toolCallApprovalKey(FINANCE_RESOURCE_NAME, approvalBinding());
        const exactCallApproved = ref.approvedToolCalls?.get(callId) === approvalKey;
        if (state.approvalRequired !== false && !exactCallApproved) {
          ref.pendingApprovals?.push({
            command: "finance run",
            reason: "approve the exact Finny finance plan before source execution",
            kind: "approval",
            approvalKey,
            summary: "Finny reviewed finance plan",
            grantModes: { session: false, always: false },
          });
          ref.pausedOnApproval = true;
          return {
            content: [{ type: "text" as const, text: "[blocked: needs human approval] exact finance plan" }],
            terminate: true,
            details: details(),
          };
        }
        const output = await service.plan({ planDigest: state.planDigest }, context);
        if (output.decision === "approved") {
          await applyRun([
            {
              ...runEventBase("plan"),
              kind: "plan_approved",
              planDigest: state.planDigest,
              approvalDigest:
                output.approvalDigest ?? digestFinnyEvidence(`approved:${context.runId}:${state.planDigest}`),
            },
          ]);
        } else if (output.decision === "exempt") {
          if (!output.approvalPolicyDigest) throw new Error("Approval exemption is missing host policy evidence");
          await applyRun([
            {
              ...runEventBase("plan-exemption"),
              kind: "plan_exempted",
              planDigest: state.planDigest,
              approvalPolicyDigest: output.approvalPolicyDigest,
            },
          ]);
        } else throw new FinanceFailure("policy_block", { dependency: "qm-host" });
      }

      if (state.stage === "PLAN_APPROVED") {
        activeAction = "source";
        if (!state.planDigest || !state.queryDigest || !state.verificationPolicy)
          throw new Error("Approved finance plan evidence is incomplete");
        const output = await service.source(
          { planDigest: state.planDigest },
          { ...context, verificationPolicy: state.verificationPolicy, approvedQueryDigest: state.queryDigest },
        );
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
          if (!state.sourceDigest || !service.recoverSource)
            throw new Error("Durable finance source recovery is unavailable");
          records = (await service.recoverSource({ sourceDigest: state.sourceDigest }, context)).records;
        }
        await applyRun([
          {
            ...runEventBase("release"),
            kind: "delivery_authorized",
            deliveryDigest: digestFinnyEvidence(
              `release:${turn.surfaceName ?? "unknown"}:${context.runId}:${state.verificationDigest}`,
            ),
          },
        ]);
      }

      if (state.stage !== "DELIVERY_ELIGIBLE") throw new Error(`Finance run stopped at ${state.stage}`);
      if (!records && state.sourceDigest) {
        if (!service.recoverSource) throw new Error("Durable finance source recovery is unavailable");
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

  const executeRun = async (callId: string, request: FinnyRunRequest) => {
    await resolveWorkflow(request);
    return options.runStore.withRunLock(workflowRunId, () => executeRunUnlocked(callId));
  };

  const raw = defineTool({
    name: FINANCE_RESOURCE_NAME,
    label: "finance",
    description:
      "Run Finny's host-enforced finance workflow once. The host drives every Golden Loop stage, approval checkpoint, source read, artifact, verification, and release decision.",
    promptSnippet: "Call finance once with the user's complete finance request.",
    promptGuidelines: [
      "Use finance for every finance data request; only the host-owned stage and evidence determine whether a result may be released.",
      "Pass the complete user request once. Never supply SQL, stage transitions, evidence digests, approval, verification, or delivery proof.",
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
      await resolveWorkflow(candidate);
      const checkpoint = await options.runStore.load(workflowRunId);
      if (checkpoint) state = replayFinnyLedger(checkpoint.runId, checkpoint.ledger);
      return state.stage === "PREFLIGHT" && !!state.planDigest && state.approvalRequired !== false;
    },
    approvalReason: "approve the exact Finny finance plan before source execution",
    approvalKeyParams: (candidate: unknown) => (isFinnyRunRequest(candidate) ? approvalBinding() : candidate),
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
