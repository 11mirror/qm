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

test("workflow turn context reuses stage state across skill reads", async () => {
  const store = createMemorySessionStore();
  const session = await store.getOrCreateByThread("workflow-turn-cache", "dm", scopeId("personal", "workflow-turn"));
  let historyReads = 0;
  const sessions = {
    ...store,
    getEntries: async (...args: Parameters<typeof store.getEntries>) => {
      historyReads += 1;
      return store.getEntries(...args);
    },
  };
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
  const readsAtTurnStart = historyReads;
  assert.equal(readsAtTurnStart, 1);
  const skill = {
    name: "finance-router",
    skillId: "finance-router-id",
    skillVersion: 1,
    contentDigest: "a".repeat(64),
  };

  assert.equal(await context?.authorizeSkillRead(skill), true);
  assert.equal(await context?.authorizeSkillRead(skill), true);
  assert.equal(historyReads, readsAtTurnStart);
});

test("workflow turn context refreshes stage skills after an accepted transition", async () => {
  const sessions = createMemorySessionStore();
  const scope = scopeId("personal", "workflow-turn-refresh");
  const session = await sessions.getOrCreateByThread("workflow-turn-refresh", "dm", scope);
  const context = await createWorkflowTurnContext({
    sessions,
    session,
    configured: [
      {
        id: "finance",
        version: 1,
        steps: [
          { id: "evidence", role: "producer", requiredSkills: [] },
          {
            id: "calculate",
            role: "producer",
            after: "evidence",
            requiredSkills: [{ skillName: "finance-calculator", contentDigest: "c".repeat(64) }],
          },
        ],
      },
    ],
  });
  assert.ok(context);
  const skill = {
    name: "finance-calculator",
    skillId: "finance-calculator-id",
    skillVersion: 1,
    contentDigest: "c".repeat(64),
  };
  assert.equal(await context.authorizeSkillRead(skill), false);
  const attempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(attempt.lease);
  const workflow = context.control({
    lease: attempt.lease,
    scopeLabel: scope,
    strictReadOnly: false,
    runtime: () => ({ harnessId: "pi", modelId: "gpt-5.4" }),
    files: { get: async () => null },
    mayReadArtifact: async () => true,
  });
  assert.ok(workflow);
  await workflow({ action: "advance", workflowId: "finance", step: "evidence", decision: "pass" });

  assert.equal(await context.authorizeSkillRead(skill), true);
});
