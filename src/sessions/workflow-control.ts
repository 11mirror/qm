import type { WorkflowToolInput } from "../tools/primitives.ts";
import { randomUUID } from "node:crypto";
import type { ScopeId, Session, SessionEntry, TurnRuntime } from "../types.ts";
import type { Lease, SessionStore } from "./session-store.ts";
import type { WorkflowDefinition } from "./workflow-gate.ts";
import {
  assignedWorkflowReview,
  assignWorkflowReviewer,
  importWorkflowReview,
  recordWorkflowReview,
} from "./workflow-review.ts";

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function durableWorkflowDefinition(entry: SessionEntry): WorkflowDefinition | undefined {
  if (entry.type !== "tool_result" || !entry.payload || typeof entry.payload !== "object") return undefined;
  const payload = entry.payload as Record<string, unknown>;
  if (payload.tool !== "workflow_definition" || !payload.definition || typeof payload.definition !== "object")
    return undefined;
  return payload.definition as WorkflowDefinition;
}

export async function workflowDefinitionsForSession(input: {
  sessions: Pick<SessionStore, "getEntries">;
  sessionId: string;
  configured: readonly WorkflowDefinition[];
  entries?: readonly SessionEntry[];
}): Promise<readonly WorkflowDefinition[]> {
  const durable = (
    input.entries ?? (await input.sessions.getEntries(input.sessionId, { tools: ["workflow_definition"] }))
  )
    .map(durableWorkflowDefinition)
    .find(Boolean);
  return durable ? [durable] : input.configured;
}

export async function ensureWorkflowDefinition(input: {
  sessions: Pick<SessionStore, "getEntries" | "appendMany">;
  lease: Lease;
  scopeLabel: ScopeId;
  definition: WorkflowDefinition;
  entries?: readonly SessionEntry[];
}): Promise<void> {
  if (
    (input.entries ?? (await input.sessions.getEntries(input.lease.sessionId, { tools: ["workflow_definition"] }))).some(
      durableWorkflowDefinition,
    )
  )
    return;
  const callId = `workflow-definition-${randomUUID()}`;
  await input.sessions.appendMany(input.lease, [
    {
      type: "tool_call",
      payload: { tool: "workflow_definition", callId, action: "start", workflowId: input.definition.id },
      scopeLabel: input.scopeLabel,
    },
    {
      type: "tool_result",
      payload: {
        tool: "workflow_definition",
        callId,
        workflowId: input.definition.id,
        workflowVersion: input.definition.version,
        definition: input.definition,
        result: JSON.stringify(input.definition),
      },
      scopeLabel: input.scopeLabel,
    },
  ]);
}

export function createWorkflowControl(input: {
  sessions: Pick<SessionStore, "get" | "getEntries" | "appendMany">;
  lease: Lease;
  scopeLabel: ScopeId;
  session: Session;
  definitions: readonly WorkflowDefinition[];
  runtime: () => TurnRuntime | undefined;
  resolveEvidence: (ids: readonly string[]) => Promise<import("./workflow-gate.ts").WorkflowEvidence[]>;
}): (request: WorkflowToolInput) => Promise<unknown> {
  return async (request) => {
    const definition = input.definitions.find((candidate) => candidate.id === request.workflowId);
    if (!definition) throw new Error(`workflow ${request.workflowId} is not registered`);
    const rootSessionId = input.session.parentSessionId ?? input.session.id;
    if (request.action === "status") {
      const entries = await input.sessions.getEntries(rootSessionId, {
        tools: ["workflow_gate", "workflow_reviewer_assignment"],
      });
      const payloads = entries
        .filter((entry) => entry.type === "tool_result" && entry.payload && typeof entry.payload === "object")
        .map((entry) => entry.payload as Record<string, unknown>);
      return {
        workflowId: definition.id,
        workflowVersion: definition.version,
        steps: definition.steps.map((step) => {
          const gates = payloads.filter(
            (payload) =>
              payload.tool === "workflow_gate" &&
              payload.workflowId === definition.id &&
              payload.workflowVersion === definition.version &&
              payload.step === step.id,
          );
          const passed = gates.findLast((payload) => payload.accepted === true);
          const gate = passed ?? gates.at(-1);
          const assignment = payloads.findLast(
            (payload) =>
              payload.tool === "workflow_reviewer_assignment" &&
              payload.workflowId === definition.id &&
              payload.workflowVersion === definition.version &&
              payload.step === step.id,
          );
          let state = assignment ? "assigned" : "pending";
          if (passed) state = "passed";
          else if (
            gate?.decision === "reject" &&
            Array.isArray(gate.blockers) &&
            gate.blockers.length === 0 &&
            Array.isArray(gate.missingSkills) &&
            gate.missingSkills.length === 0 &&
            Array.isArray(gate.unexpectedSkills) &&
            gate.unexpectedSkills.length === 0
          )
            state = "rejected";
          return {
            step: step.id,
            role: step.role,
            state,
            ...(gate?.decision === "pass" || gate?.decision === "reject" ? { decision: gate.decision } : {}),
            ...(typeof gate?.subject === "string" ? { subject: gate.subject } : {}),
            ...(typeof assignment?.reviewerSessionId === "string"
              ? { reviewerSessionId: assignment.reviewerSessionId }
              : {}),
          };
        }),
      };
    }
    const step = required(request.step, "step");
    const configuredStep = definition.steps.find((candidate) => candidate.id === step);
    if (!configuredStep) throw new Error(`workflow ${definition.id} has no step ${step}`);
    if (request.action === "review_submit") {
      if (!input.session.parentSessionId) throw new Error("review submission requires an isolated child session");
      if (!request.decision) throw new Error("decision is required");
      const assignment = await assignedWorkflowReview({
        sessions: input.sessions,
        parentSessionId: input.session.parentSessionId,
        reviewerSessionId: input.session.id,
        definition,
        step,
      });
      if (!assignment) throw new Error("reviewer is not assigned to this workflow step");
      const inputEvidence = await input.resolveEvidence((request.inputEvidence ?? []).map((evidence) => evidence.id));
      const outputEvidence = await input.resolveEvidence((request.outputEvidence ?? []).map((evidence) => evidence.id));
      return recordWorkflowReview({
        sessions: input.sessions,
        lease: input.lease,
        scopeLabel: input.scopeLabel,
        definition,
        runtime: input.runtime(),
        assignment,
        submission: {
          step,
          decision: request.decision,
          inputEvidence,
          outputEvidence,
          findings: request.findings,
        },
      });
    }
    if (input.session.parentSessionId) throw new Error("only the producer session can mutate workflow state");
    await ensureWorkflowDefinition({
      sessions: input.sessions,
      lease: input.lease,
      scopeLabel: input.scopeLabel,
      definition,
    });
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
    if (configuredStep.separateFrom && !request.reviewerSessionId)
      throw new Error(`workflow step ${step} requires a reviewer receipt`);
    if (configuredStep.humanApproval && request.action !== "approve")
      throw new Error(`workflow step ${step} requires the approval action`);
    if (!configuredStep.humanApproval && request.action === "approve")
      throw new Error(`workflow step ${step} does not accept the approval action`);
    if (!request.reviewerSessionId && !request.decision) throw new Error("decision is required");
    const inputEvidence = await input.resolveEvidence((request.inputEvidence ?? []).map((evidence) => evidence.id));
    const outputEvidence = await input.resolveEvidence((request.outputEvidence ?? []).map((evidence) => evidence.id));
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
              inputEvidence,
              outputEvidence,
            },
          }),
    });
  };
}
