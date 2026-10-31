import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkflowTurnContext } from "../src/core/orchestrator/workflow-turn.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { scopeId } from "../src/types.ts";

test("workflow turn context authorizes only the active stage skills", async () => {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("workflow-turn", "dm", scopeId("personal", "workflow-turn"));
  const context = await createWorkflowTurnContext({
    sessions,
    session,
    configured: [
      {
        id: "finance",
        version: 1,
        steps: [
          {
            id: "evidence",
            role: "producer",
            requiredSkills: [{ skillName: "finance-router", contentDigest: "a".repeat(64) }],
          },
        ],
      },
    ],
  });

  assert.equal(
    await context?.authorizeSkillRead({
      name: "finance-router",
      skillId: "finance-router-id",
      skillVersion: 1,
      contentDigest: "a".repeat(64),
    }),
    true,
  );
  assert.equal(
    await context?.authorizeSkillRead({
      name: "other",
      skillId: "other-id",
      skillVersion: 1,
      contentDigest: "b".repeat(64),
    }),
    false,
  );
});
