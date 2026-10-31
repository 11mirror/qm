import type { WorkflowToolInput } from "../tools/primitives.ts";
import type { ScopeId, Session } from "../types.ts";
import type { Lease, SessionStore } from "./session-store.ts";
import type { WorkflowDefinition } from "./workflow-gate.ts";
import { assignWorkflowReviewer, importWorkflowReview, recordWorkflowReview } from "./workflow-review.ts";

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

export function createWorkflowControl(input: {
  sessions: Pick<SessionStore, "get" | "getEntries" | "appendMany">;
  lease: Lease;
  scopeLabel: ScopeId;
  session: Session;
  definitions: readonly WorkflowDefinition[];
}): (request: WorkflowToolInput) => Promise<unknown> {
  return async (request) => {
    const definition = input.definitions.find((candidate) => candidate.id === request.workflowId);
    if (!definition) throw new Error(`workflow ${request.workflowId} is not registered`);
    const rootSessionId = input.session.parentSessionId ?? input.session.id;
    if (request.action === "status") {
      const entries = await input.sessions.getEntries(rootSessionId);
      return {
        workflowId: definition.id,
        workflowVersion: definition.version,
        entries: entries
          .filter(
            (entry) =>
              entry.type === "tool_result" &&
              entry.payload &&
              typeof entry.payload === "object" &&
              ["workflow_gate", "workflow_reviewer_assignment"].includes(
                String((entry.payload as Record<string, unknown>).tool),
              ),
          )
          .map((entry) => entry.payload),
      };
    }
    const step = required(request.step, "step");
    const configuredStep = definition.steps.find((candidate) => candidate.id === step);
    if (!configuredStep) throw new Error(`workflow ${definition.id} has no step ${step}`);
    if (request.action === "review_submit") {
      if (!input.session.parentSessionId) throw new Error("review submission requires an isolated child session");
      if (!request.decision) throw new Error("decision is required");
      return recordWorkflowReview({
        sessions: input.sessions,
        lease: input.lease,
        scopeLabel: input.scopeLabel,
        definition,
        submission: {
          step,
          decision: request.decision,
          inputEvidence: request.inputEvidence,
          outputEvidence: request.outputEvidence,
          findings: request.findings,
        },
      });
    }
    if (input.session.parentSessionId) throw new Error("only the producer session can mutate workflow state");
    if (request.action === "assign_reviewer") {
      return assignWorkflowReviewer({
        sessions: input.sessions,
        lease: input.lease,
        scopeLabel: input.scopeLabel,
        parentSessionId: input.session.id,
        reviewerSessionId: required(request.reviewerSessionId, "reviewerSessionId"),
        definition,
        step,
      });
    }
    if (configuredStep.humanApproval && request.action !== "approve")
      throw new Error(`workflow step ${step} requires the approval action`);
    if (!configuredStep.humanApproval && request.action === "approve")
      throw new Error(`workflow step ${step} does not accept the approval action`);
    if (!request.reviewerSessionId && !request.decision) throw new Error("decision is required");
    return importWorkflowReview({
      sessions: input.sessions,
      lease: input.lease,
      scopeLabel: input.scopeLabel,
      parentSessionId: input.session.id,
      definition,
      ...(request.reviewerSessionId
        ? { reviewerSessionId: request.reviewerSessionId, reviewStep: step }
        : {
            producerSubmission: {
              step,
              decision: request.decision!,
              inputEvidence: request.inputEvidence,
              outputEvidence: request.outputEvidence,
            },
          }),
    });
  };
}
