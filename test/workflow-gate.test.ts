import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { evaluateWorkflowGate } from "../src/sessions/workflow-gate.ts";
import { scopeId } from "../src/types.ts";

const scope = scopeId("personal", "finance-mvp");

test("a gate derives required skill use from the durable tape instead of producer claims", async () => {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("finance-mvp", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  assert.ok(lease);
  const definition = {
    id: "receipts-and-outstanding-ar",
    version: 1,
    steps: [
      {
        id: "auditor-1",
        role: "evidence-auditor",
        requiredSkills: [{ skillId: "netsuite-readonly-finance", contentDigest: "approved-digest" }],
      },
    ],
  } as const;

  const rejected = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: {
      step: "auditor-1",
      decision: "pass",
      subject: "reviewer-run-1",
      claimedSkills: [{ skillId: "netsuite-readonly-finance", contentDigest: "approved-digest" }],
    },
  });

  assert.equal(rejected.accepted, false);
  assert.deepEqual(rejected.missingSkills, [
    { skillId: "netsuite-readonly-finance", contentDigest: "approved-digest" },
  ]);

  await sessions.appendMany(lease, [
    {
      type: "tool_call",
      payload: {
        tool: "skills",
        callId: "skill-read-1",
        action: "read",
        name: "netsuite-readonly-finance",
      },
      scopeLabel: scope,
    },
    {
      type: "tool_result",
      payload: {
        tool: "skills",
        callId: "skill-read-1",
        action: "read",
        name: "netsuite-readonly-finance",
        found: true,
        provenance: {
          skillId: "netsuite-readonly-finance",
          skillVersion: 7,
          contentDigest: "approved-digest",
        },
      },
      scopeLabel: scope,
    },
  ]);

  const accepted = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: {
      step: "auditor-1",
      decision: "pass",
      subject: "reviewer-run-1",
      claimedSkills: [],
    },
  });

  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.observedSkills, [
    {
      skillId: "netsuite-readonly-finance",
      skillVersion: 7,
      contentDigest: "approved-digest",
    },
  ]);
  const persisted = await sessions.getEntries(session.id);
  assert.deepEqual(
    persisted
      .filter((entry) => entry.type === "tool_result")
      .map((entry) => entry.payload)
      .filter((payload) => (payload as { tool?: string }).tool === "workflow_gate")
      .map((payload) => (payload as { accepted?: boolean }).accepted),
    [false, true],
  );
});

test("a workflow rejects skipped gates and same-subject review", async () => {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("finance-ordering", "dm", scope);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  assert.ok(lease);
  const definition = {
    id: "finance-ordering",
    version: 1,
    steps: [
      { id: "raw-evidence-ready", role: "producer", requiredSkills: [] },
      {
        id: "auditor-1-pass",
        role: "evidence-auditor",
        after: "raw-evidence-ready",
        separateFrom: "raw-evidence-ready",
        evidenceFrom: "raw-evidence-ready",
        requiredSkills: [],
      },
      {
        id: "derived-result-ready",
        role: "calculator",
        after: "auditor-1-pass",
        requiredSkills: [],
      },
    ],
  } as const;

  const skipped = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: { step: "derived-result-ready", decision: "pass", subject: "calculator-1" },
  });
  assert.equal(skipped.accepted, false);
  assert.deepEqual(skipped.blockers, ["required predecessor auditor-1-pass has not passed"]);

  const produced = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: {
      step: "raw-evidence-ready",
      decision: "pass",
      subject: "worker-1",
      outputEvidence: [{ id: "raw-workbook", digest: "sha256:current" }],
    },
  });
  assert.equal(produced.accepted, true);

  const selfReviewed = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: {
      step: "auditor-1-pass",
      decision: "pass",
      subject: "worker-1",
      inputEvidence: [{ id: "raw-workbook", digest: "sha256:current" }],
    },
  });
  assert.equal(selfReviewed.accepted, false);
  assert.deepEqual(selfReviewed.blockers, ["subject must differ from raw-evidence-ready"]);

  const staleReview = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: {
      step: "auditor-1-pass",
      decision: "pass",
      subject: "auditor-1",
      inputEvidence: [{ id: "raw-workbook", digest: "sha256:stale" }],
    },
  });
  assert.equal(staleReview.accepted, false);
  assert.deepEqual(staleReview.blockers, ["evidence does not match raw-evidence-ready"]);

  const independentlyReviewed = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: {
      step: "auditor-1-pass",
      decision: "pass",
      subject: "auditor-1",
      inputEvidence: [{ id: "raw-workbook", digest: "sha256:current" }],
    },
  });
  assert.equal(independentlyReviewed.accepted, true);

  const replayed = await evaluateWorkflowGate({
    sessions,
    lease,
    scopeLabel: scope,
    definition,
    submission: {
      step: "auditor-1-pass",
      decision: "pass",
      subject: "auditor-2",
      inputEvidence: [{ id: "raw-workbook", digest: "sha256:current" }],
    },
  });
  assert.equal(replayed.accepted, false);
  assert.deepEqual(replayed.blockers, ["step auditor-1-pass has already passed"]);
});

test("a skill read from an earlier turn cannot satisfy the current gate", async () => {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("finance-current-turn", "dm", scope);
  const firstAttempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(firstAttempt.lease);
  const earlierLease = {
    ...firstAttempt.lease,
    turnId: "11111111-1111-4111-8111-111111111111",
  };
  await sessions.appendMany(earlierLease, [
    {
      type: "tool_call",
      payload: { tool: "skills", callId: "old-read", action: "read", name: "finance-audit" },
      scopeLabel: scope,
    },
    {
      type: "tool_result",
      payload: {
        tool: "skills",
        callId: "old-read",
        action: "read",
        name: "finance-audit",
        found: true,
        provenance: { skillId: "finance-audit", skillVersion: 1, contentDigest: "current" },
      },
      scopeLabel: scope,
    },
  ]);
  await sessions.releaseLease(earlierLease);
  const nextAttempt = await sessions.acquireLease(session.id, "turn");
  assert.ok(nextAttempt.lease);
  const currentLease = {
    ...nextAttempt.lease,
    turnId: "22222222-2222-4222-8222-222222222222",
  };

  const result = await evaluateWorkflowGate({
    sessions,
    lease: currentLease,
    scopeLabel: scope,
    definition: {
      id: "current-turn",
      version: 1,
      steps: [
        {
          id: "audit",
          role: "auditor",
          requiredSkills: [{ skillId: "finance-audit", contentDigest: "current" }],
        },
      ],
    },
    submission: { step: "audit", decision: "pass", subject: "auditor" },
  });

  assert.equal(result.accepted, false);
  assert.deepEqual(result.observedSkills, []);
});
