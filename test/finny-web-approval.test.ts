import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent } from "../src/agent/agent.ts";
import type { SpreadsheetCalculationEngine } from "../src/finny/deterministic-spreadsheet-worker.ts";
import type { FinnyPlanPresentation } from "../src/finny/types.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

const question = "Which cutoff date should the report use?";
const plan: FinnyPlanPresentation = {
  title: "AP aging",
  phases: [{ name: "Prepare", owner: "Producer", dependencies: [] }],
  certification: "Deterministic checks, then judgment where required",
  deliverable: "Verified XLSX workbook",
  destination: "Origin thread",
  clarifications: [{ question, answer: "2026-11-17" }],
};

const agent: Agent = {
  async runTurn(turn) {
    const created = await turn.tools.finny!.createPlan(plan, {
      question,
      options: [
        { id: "today", label: "2026-11-17" },
        { id: "month-end", label: "2026-11-30" },
      ],
      recommendedOptionId: "today",
    });
    return {
      reply: "",
      pausedOnApproval: true,
      pendingApprovals: [
        {
          command: question,
          reason: "Finny Governance Clarification",
          approvalKey: `finny-clarification:${created.requestId}`,
          summary: "Recommended: 2026-11-17",
          grantModes: { session: false, always: false },
        },
      ],
    };
  },
};

const engine: SpreadsheetCalculationEngine = {
  name: "approved-test-engine",
  version: "1",
  evaluator: {
    id: "test",
    revision: "1",
    buildDigest: "a".repeat(64),
    contractVersion: "finny.spreadsheet-worker.v2",
    configurationDigest: "b".repeat(64),
  },
  async evaluate() {
    return [];
  },
};

test("approving a web Finny clarification immediately presents the durable plan approval", async () => {
  const built = buildApp(
    testConfig({
      finny: {
        signingSecret: "finny-test-secret",
        findingPolicy: { id: "test", maxFindings: 4, maxCodeLength: 40, maxMessageLength: 200 },
        maxReworks: 2,
        workerGrantTtlMs: 60_000,
        spreadsheetEngine: {
          url: "https://spreadsheet-engine.example/evaluate",
          name: engine.name,
          version: engine.version,
          timeoutMs: 30_000,
          maxResponseBytes: 1_048_576,
          maxArtifactBytes: 52_428_800,
          evaluator: engine.evaluator,
        },
        maxEvidenceBytes: 4_194_304,
      } as never,
    }),
    { agent, spreadsheetCalculationEngine: engine },
  );
  const request = {
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm" as const, threadRef: "web:U1:finny-clarification" },
    text: "Create an AP aging workbook",
  };

  const clarification = await built.app.turn(request);
  assert.equal(clarification.status, "pending_approval", JSON.stringify(clarification));
  const clarificationApproval = clarification.pendingApprovals?.[0];
  assert.equal(clarificationApproval?.reason, "Finny Governance Clarification");

  const result = await built.app.turn({
    ...request,
    approval: { requestId: clarificationApproval!.requestId, approved: true, scope: "once" },
  });

  assert.equal(result.status, "pending_approval", JSON.stringify(await built.errors.list()));
  assert.equal(result.pendingApprovals?.[0]?.reason, "Finny Governance Plan Approval");
  assert.equal(result.pendingApprovals?.[0]?.command, plan.title);
});
