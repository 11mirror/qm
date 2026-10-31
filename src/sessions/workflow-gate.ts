import { randomUUID } from "node:crypto";
import type { ScopeId, SessionEntry } from "../types.ts";
import type { Lease, SessionStore } from "./session-store.ts";

export interface WorkflowSkillRequirement {
  skillId: string;
  contentDigest?: string;
  minimumVersion?: number;
}

export interface WorkflowGateStep {
  id: string;
  role: string;
  after?: string;
  separateFrom?: string;
  evidenceFrom?: string;
  requiredSkills: readonly WorkflowSkillRequirement[];
}

export interface WorkflowDefinition {
  id: string;
  version: number;
  steps: readonly WorkflowGateStep[];
}

export interface WorkflowGateSubmission {
  step: string;
  decision: "pass" | "reject";
  subject: string;
  claimedSkills?: readonly WorkflowSkillRequirement[];
  inputEvidence?: readonly WorkflowEvidence[];
  outputEvidence?: readonly WorkflowEvidence[];
}

export interface WorkflowEvidence {
  id: string;
  digest: string;
}

export interface ObservedWorkflowSkill {
  skillId: string;
  skillVersion: number;
  contentDigest: string;
}

export interface WorkflowGateResult {
  accepted: boolean;
  workflowId: string;
  workflowVersion: number;
  step: string;
  role: string;
  decision: "pass" | "reject";
  subject: string;
  observedSkills: ObservedWorkflowSkill[];
  missingSkills: WorkflowSkillRequirement[];
  blockers: string[];
  inputEvidence: WorkflowEvidence[];
  outputEvidence: WorkflowEvidence[];
}

function observedSkill(entry: SessionEntry): ObservedWorkflowSkill | null {
  if (entry.type !== "tool_result" || !entry.payload || typeof entry.payload !== "object") return null;
  const payload = entry.payload as Record<string, unknown>;
  if (payload.tool !== "skills" || payload.action !== "read" || payload.found !== true) return null;
  if (!payload.provenance || typeof payload.provenance !== "object") return null;
  const provenance = payload.provenance as Record<string, unknown>;
  if (
    typeof provenance.skillId !== "string" ||
    typeof provenance.skillVersion !== "number" ||
    typeof provenance.contentDigest !== "string"
  )
    return null;
  return {
    skillId: provenance.skillId,
    skillVersion: provenance.skillVersion,
    contentDigest: provenance.contentDigest,
  };
}

export function observedWorkflowSkills(entries: readonly SessionEntry[]): ObservedWorkflowSkill[] {
  return entries
    .map(observedSkill)
    .filter((skill): skill is ObservedWorkflowSkill => skill !== null)
    .filter(
      (skill, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.skillId === skill.skillId &&
            candidate.skillVersion === skill.skillVersion &&
            candidate.contentDigest === skill.contentDigest,
        ) === index,
    );
}

export function missingWorkflowSkills(
  observed: readonly ObservedWorkflowSkill[],
  required: readonly WorkflowSkillRequirement[],
): WorkflowSkillRequirement[] {
  return required.filter((requirement) => !observed.some((skill) => satisfies(skill, requirement)));
}

function satisfies(observed: ObservedWorkflowSkill, required: WorkflowSkillRequirement): boolean {
  return (
    observed.skillId === required.skillId &&
    (required.contentDigest === undefined || observed.contentDigest === required.contentDigest) &&
    (required.minimumVersion === undefined || observed.skillVersion >= required.minimumVersion)
  );
}

function acceptedGate(entry: SessionEntry): WorkflowGateResult | null {
  if (entry.type !== "tool_result" || !entry.payload || typeof entry.payload !== "object") return null;
  const payload = entry.payload as Record<string, unknown>;
  if (payload.tool !== "workflow_gate" || payload.accepted !== true) return null;
  if (
    typeof payload.workflowId !== "string" ||
    typeof payload.workflowVersion !== "number" ||
    typeof payload.step !== "string" ||
    typeof payload.subject !== "string"
  )
    return null;
  return payload as unknown as WorkflowGateResult;
}

function sameEvidence(left: readonly WorkflowEvidence[], right: readonly WorkflowEvidence[]): boolean {
  return (
    left.length === right.length &&
    left.every((evidence) =>
      right.some((candidate) => candidate.id === evidence.id && candidate.digest === evidence.digest),
    )
  );
}

export async function evaluateWorkflowGate(input: {
  sessions: Pick<SessionStore, "getEntries" | "appendMany">;
  lease: Lease;
  scopeLabel: ScopeId;
  definition: WorkflowDefinition;
  submission: WorkflowGateSubmission;
  observedSkills?: readonly ObservedWorkflowSkill[];
}): Promise<WorkflowGateResult> {
  const step = input.definition.steps.find((candidate) => candidate.id === input.submission.step);
  if (!step) throw new Error(`workflow ${input.definition.id} has no step ${input.submission.step}`);
  const entries = await input.sessions.getEntries(input.lease.sessionId);
  const skillEntries = input.lease.turnId
    ? await input.sessions.getEntries(input.lease.sessionId, { turnId: input.lease.turnId })
    : entries;
  const observedSkills = [...(input.observedSkills ?? observedWorkflowSkills(skillEntries))];
  const missingSkills = missingWorkflowSkills(observedSkills, step.requiredSkills);
  const passed = entries
    .map(acceptedGate)
    .filter((gate): gate is WorkflowGateResult => gate !== null)
    .filter((gate) => gate.workflowId === input.definition.id && gate.workflowVersion === input.definition.version);
  const predecessor = step.after ? passed.findLast((gate) => gate.step === step.after) : undefined;
  const separated = step.separateFrom ? passed.findLast((gate) => gate.step === step.separateFrom) : undefined;
  const evidenceSource = step.evidenceFrom ? passed.findLast((gate) => gate.step === step.evidenceFrom) : undefined;
  const alreadyPassed = passed.some((gate) => gate.step === step.id);
  const inputEvidence = [...(input.submission.inputEvidence ?? [])];
  const outputEvidence = [...(input.submission.outputEvidence ?? [])];
  const blockers = [
    ...(alreadyPassed ? [`step ${step.id} has already passed`] : []),
    ...(step.after && !predecessor ? [`required predecessor ${step.after} has not passed`] : []),
    ...(step.separateFrom && separated?.subject === input.submission.subject
      ? [`subject must differ from ${step.separateFrom}`]
      : []),
    ...(step.evidenceFrom && evidenceSource && !sameEvidence(evidenceSource.outputEvidence, inputEvidence)
      ? [`evidence does not match ${step.evidenceFrom}`]
      : []),
  ];
  const result: WorkflowGateResult = {
    accepted: input.submission.decision === "pass" && missingSkills.length === 0 && blockers.length === 0,
    workflowId: input.definition.id,
    workflowVersion: input.definition.version,
    step: step.id,
    role: step.role,
    decision: input.submission.decision,
    subject: input.submission.subject,
    observedSkills,
    missingSkills: [...missingSkills],
    blockers,
    inputEvidence,
    outputEvidence,
  };
  const callId = `workflow-gate-${randomUUID()}`;
  await input.sessions.appendMany(input.lease, [
    {
      type: "tool_call",
      payload: {
        tool: "workflow_gate",
        callId,
        workflowId: input.definition.id,
        workflowVersion: input.definition.version,
        step: step.id,
        decision: input.submission.decision,
        subject: input.submission.subject,
      },
      scopeLabel: input.scopeLabel,
    },
    {
      type: "tool_result",
      payload: { tool: "workflow_gate", callId, result: JSON.stringify(result), ...result },
      scopeLabel: input.scopeLabel,
    },
  ]);
  return result;
}
