import type { FileArtifact, FileArtifactStore } from "../../files/file-artifact-store.ts";
import { createWorkflowControl, workflowDefinitionsForSession } from "../../sessions/workflow-control.ts";
import { activeWorkflowSkillRequirements, workflowSkillSatisfies } from "../../sessions/workflow-gate.ts";
import type { ObservedWorkflowSkill, WorkflowDefinition } from "../../sessions/workflow-gate.ts";
import { activeWorkflowReviewAssignment } from "../../sessions/workflow-review.ts";
import type { Lease, SessionStore } from "../../sessions/session-store.ts";
import type { ScopeId, Session, TurnRuntime } from "../../types.ts";
import type { SkillResolution } from "../../skills/skill-store.ts";

export async function createWorkflowTurnContext(input: {
  sessions: Pick<SessionStore, "get" | "getEntries" | "appendMany">;
  session: Session;
  lease: Lease;
  configured: readonly WorkflowDefinition[];
}) {
  if (input.lease.sessionId !== input.session.id)
    throw new Error("workflow context lease does not match the turn session");
  const rootSessionId = input.session.parentSessionId ?? input.session.id;
  const rootSession = input.session.parentSessionId ? await input.sessions.get(rootSessionId) : input.session;
  if (!rootSession) throw new Error("workflow root session does not exist");
  const entries = await input.sessions.getEntries(rootSessionId, {
    tools: ["workflow_definition", "workflow_gate", "workflow_reviewer_assignment"],
  });
  const definitions = await workflowDefinitionsForSession({
    sessions: input.sessions,
    sessionId: rootSessionId,
    configured: input.configured,
    entries,
  });
  if (!definitions.length) return undefined;
  const review = input.session.parentSessionId
    ? await activeWorkflowReviewAssignment({
        sessions: input.sessions,
        parentSessionId: input.session.parentSessionId,
        reviewerSessionId: input.session.id,
        definitions,
        entries,
      })
    : undefined;
  let producerRequirements = input.session.parentSessionId
    ? []
    : await activeWorkflowSkillRequirements({
        sessions: input.sessions,
        sessionId: input.session.id,
        definitions,
        entries,
      });
  const requiredSkills = () => review?.step.requiredSkills ?? producerRequirements;
  const authorizedSkillNames = () => [...new Set(requiredSkills().map((requirement) => requirement.skillName))];
  return {
    review,
    authorizedSkillNames,
    filterSkills: (skills: readonly SkillResolution[]) => {
      const authorized = new Set(authorizedSkillNames());
      return skills.filter((entry) => entry.skill && authorized.has(entry.skill.manifest.name));
    },
    authorizeSkillRead: async (skill: ObservedWorkflowSkill) =>
      requiredSkills().some((requirement) => workflowSkillSatisfies(skill, requirement)),
    control(control: {
      lease: Lease;
      scopeLabel: ScopeId;
      strictReadOnly: boolean;
      runtime: () => TurnRuntime | undefined;
      files: Pick<FileArtifactStore, "get">;
      mayReadArtifact: (artifact: FileArtifact, fresh?: boolean) => Promise<boolean>;
    }) {
      if ((input.session.parentSessionId || control.strictReadOnly) && !review) return undefined;
      const workflow = createWorkflowControl({
        sessions: input.sessions,
        lease: control.lease,
        scopeLabel: control.scopeLabel,
        session: input.session,
        definitions,
        runtime: control.runtime,
        resolveEvidence: async (ids) =>
          Promise.all(
            ids.map(async (id) => {
              const artifact = await control.files.get(id);
              if (
                !artifact ||
                !artifact.sha256 ||
                artifact.createdAt < rootSession.createdAt ||
                !(await control.mayReadArtifact(artifact, true))
              )
                throw new Error(`workflow evidence ${id} is not an accessible durable artifact`);
              return { id: artifact.id, digest: artifact.sha256 };
            }),
          ),
      });
      return async (request: Parameters<typeof workflow>[0]) => {
        const result = await workflow(request);
        if (
          !input.session.parentSessionId &&
          result &&
          typeof result === "object" &&
          (result as { accepted?: boolean }).accepted === true
        )
          producerRequirements = await activeWorkflowSkillRequirements({
            sessions: input.sessions,
            sessionId: input.session.id,
            definitions,
          });
        return result;
      };
    },
  };
}
