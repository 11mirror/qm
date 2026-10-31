import type { FileArtifact, FileArtifactStore } from "../../files/file-artifact-store.ts";
import { createWorkflowControl, workflowDefinitionsForSession } from "../../sessions/workflow-control.ts";
import { activeWorkflowSkillRequirements, workflowSkillSatisfies } from "../../sessions/workflow-gate.ts";
import type { ObservedWorkflowSkill, WorkflowDefinition } from "../../sessions/workflow-gate.ts";
import { activeWorkflowReviewAssignment } from "../../sessions/workflow-review.ts";
import type { Lease, SessionStore } from "../../sessions/session-store.ts";
import type { ScopeId, Session, TurnRuntime } from "../../types.ts";

export async function createWorkflowTurnContext(input: {
  sessions: Pick<SessionStore, "get" | "getEntries" | "appendMany">;
  session: Session;
  configured: readonly WorkflowDefinition[];
}) {
  const definitions = await workflowDefinitionsForSession({
    sessions: input.sessions,
    sessionId: input.session.parentSessionId ?? input.session.id,
    configured: input.configured,
  });
  if (!definitions.length) return undefined;
  const review = input.session.parentSessionId
    ? await activeWorkflowReviewAssignment({
        sessions: input.sessions,
        parentSessionId: input.session.parentSessionId,
        reviewerSessionId: input.session.id,
        definitions,
      })
    : undefined;
  let producerRequirements = input.session.parentSessionId
    ? []
    : await activeWorkflowSkillRequirements({
        sessions: input.sessions,
        sessionId: input.session.id,
        definitions,
      });
  return {
    review,
    authorizeSkillRead: async (skill: ObservedWorkflowSkill) =>
      (review?.step.requiredSkills ?? producerRequirements).some((requirement) =>
        workflowSkillSatisfies(skill, requirement),
      ),
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
              if (!artifact || !artifact.sha256 || !(await control.mayReadArtifact(artifact, true)))
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
