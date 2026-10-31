import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createWorkflowControl } from "../src/sessions/workflow-control.ts";
import { scopeId } from "../src/types.ts";

test("workflow control derives the producer identity from the host session", async () => {
  const sessions = createMemorySessionStore();
  const scope = scopeId("personal", "workflow-control");
  const session = await sessions.getOrCreateByThread("control", "dm", scope);
  const attempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(attempt.lease);
  const control = createWorkflowControl({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    session,
    runtime: () => ({ harnessId: "pi", modelId: "gpt-5.4" }),
    resolveEvidence: async (ids) => ids.map((id) => ({ id, digest: `host:${id}` })),
    definitions: [
      {
        id: "finance",
        version: 1,
        steps: [{ id: "request-bound", role: "producer", requiredSkills: [] }],
      },
    ],
  });

  const result = await control({
    action: "advance",
    workflowId: "finance",
    step: "request-bound",
    decision: "pass",
  });

  assert.deepEqual(result, {
    accepted: true,
    workflowId: "finance",
    workflowVersion: 1,
    step: "request-bound",
    role: "producer",
    decision: "pass",
    subject: session.id,
    observedSkills: [],
    missingSkills: [],
    unexpectedSkills: [],
    blockers: [],
    inputEvidence: [],
    outputEvidence: [],
  });
  await assert.rejects(
    control({ action: "advance", workflowId: "unknown", step: "request-bound", decision: "pass" }),
    /workflow unknown is not registered/,
  );
});

test("a human approval step cannot be advanced through the ordinary producer action", async () => {
  const sessions = createMemorySessionStore();
  const scope = scopeId("personal", "workflow-approval");
  const session = await sessions.getOrCreateByThread("approval", "dm", scope);
  const attempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(attempt.lease);
  const control = createWorkflowControl({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    session,
    runtime: () => ({ harnessId: "pi", modelId: "gpt-5.4" }),
    resolveEvidence: async (ids) => ids.map((id) => ({ id, digest: `host:${id}` })),
    definitions: [
      {
        id: "approval",
        version: 1,
        steps: [{ id: "PLAN_APPROVED", role: "producer", humanApproval: true, requiredSkills: [] }],
      },
    ],
  });

  await assert.rejects(
    control({
      action: "advance",
      workflowId: "approval",
      step: "PLAN_APPROVED",
      decision: "pass",
    }),
    /requires the approval action/,
  );
});

test("workflow control replaces model evidence claims with durable artifact digests", async () => {
  const sessions = createMemorySessionStore();
  const scope = scopeId("personal", "workflow-evidence");
  const session = await sessions.getOrCreateByThread("evidence", "dm", scope);
  const attempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(attempt.lease);
  const control = createWorkflowControl({
    sessions,
    lease: attempt.lease,
    scopeLabel: scope,
    session,
    runtime: () => ({ harnessId: "pi", modelId: "gpt-5.4" }),
    resolveEvidence: async (ids) => {
      if (ids.includes("unknown")) throw new Error("workflow evidence unknown is not an accessible durable artifact");
      return ids.map((id) => ({ id, digest: `host:${id}` }));
    },
    definitions: [
      {
        id: "evidence",
        version: 1,
        steps: [{ id: "RAW_EVIDENCE_READY", role: "producer", requiredSkills: [] }],
      },
    ],
  });

  const result = await control({
    action: "advance",
    workflowId: "evidence",
    step: "RAW_EVIDENCE_READY",
    decision: "pass",
    outputEvidence: [{ id: "raw-workbook" }],
  });
  assert.deepEqual((result as { outputEvidence: unknown }).outputEvidence, [
    { id: "raw-workbook", digest: "host:raw-workbook" },
  ]);
  await assert.rejects(
    control({
      action: "advance",
      workflowId: "evidence",
      step: "RAW_EVIDENCE_READY",
      decision: "pass",
      outputEvidence: [{ id: "unknown" }],
    }),
    /not an accessible durable artifact/,
  );
});
