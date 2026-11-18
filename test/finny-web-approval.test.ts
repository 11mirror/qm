import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent } from "../src/agent/agent.ts";
import type { SpreadsheetCalculationEngine } from "../src/finny/deterministic-spreadsheet-worker.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { scopeId } from "../src/types.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { finnySopFixture } from "./support/finny-sop-fixture.ts";

const question = "Which cutoff date should the report use?";
const sop = { ...finnySopFixture(), scopeId: scopeId("personal", "U1"), title: "AP aging" };
const values = { cutoff: "2026-11-17", currency: "INR", note: "web run" };

const agent: Agent = {
  async runTurn(turn) {
    const created = await turn.tools.finny!.createPlan(sop, values, {
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
    approval: { requestId: clarificationApproval!.requestId, approved: true, scope: "once", optionId: "today" } as never,
  });

  assert.equal(result.status, "pending_approval", JSON.stringify(await built.errors.list()));
  assert.equal(result.pendingApprovals?.[0]?.reason, "Finny Governance Plan Approval");
  assert.equal(result.pendingApprovals?.[0]?.command, sop.title);
});

test("a failed plan projection leaves the web clarification retryable", async () => {
  const config = testConfig({
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
  });
  const built = buildApp(config, { agent, spreadsheetCalculationEngine: engine });
  const request = {
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm" as const, threadRef: "web:U1:finny-projection-retry" },
    text: "Create an AP aging workbook",
  };
  const clarification = await built.app.turn(request);
  const approval = clarification.pendingApprovals![0]!;
  const db = createPgPool(config.databaseUrl!);
  await db.q("CREATE SEQUENCE fail_finny_plan_projection_seq");
  await db.q(`CREATE OR REPLACE FUNCTION fail_finny_plan_projection() RETURNS trigger AS $$
    BEGIN
      IF NEW.json->>'approvalKey' LIKE 'finny-plan:%' AND nextval('fail_finny_plan_projection_seq') = 1 THEN
        RAISE EXCEPTION 'injected Finny plan projection failure';
      END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql`);
  await db.q(`CREATE TRIGGER fail_finny_plan_projection
    BEFORE INSERT OR UPDATE ON approvals
    FOR EACH ROW EXECUTE FUNCTION fail_finny_plan_projection()`);

  const recovered = await built.app.turn({
    ...request,
    approval: { requestId: approval.requestId, approved: true, scope: "once", optionId: "today" } as never,
  });
  await db.q("DROP TRIGGER fail_finny_plan_projection ON approvals");
  await db.q("DROP FUNCTION fail_finny_plan_projection() ");
  await db.q("DROP SEQUENCE fail_finny_plan_projection_seq");

  assert.equal(recovered.status, "pending_approval", JSON.stringify(await built.errors.list()));
  assert.equal(recovered.pendingApprovals?.[0]?.reason, "Finny Governance Plan Approval");
});

test("a nonrecommended web Finny clarification choice resumes the coordinator with a revised approval", async () => {
  let jobId = "";
  let turns = 0;
  const resumingAgent: Agent = {
    async runTurn(turn) {
      turns += 1;
      const scopedSop = { ...sop, scopeId: scopeId("personal", "approver-42") };
      if (turns === 1) {
        const created = await turn.tools.finny!.createPlan(scopedSop, values, {
          question,
          options: [
            { id: "today", label: "2026-11-17" },
            { id: "month-end", label: "2026-11-30" },
          ],
          recommendedOptionId: "today",
        });
        jobId = created.jobId;
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
      }
      if (turns === 2) {
        assert.match(turn.environment ?? "", /2026-11-30/);
        const revisedValues = { ...values, cutoff: "2026-11-30" };
        const amended = await turn.tools.finny!.amendPlan(jobId, scopedSop, revisedValues);
        return {
          reply: "",
          pausedOnApproval: true,
          pendingApprovals: [
            {
              command: scopedSop.title,
              reason: "Finny Governance Plan Approval",
              approvalKey: `finny-plan:${amended.requestId}`,
              summary: scopedSop.intent.description,
              grantModes: { session: false, always: false },
            },
          ],
        };
      }
      return { reply: "Producer started" };
    },
  };
  const config = testConfig({
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
    });
  const built = buildApp(config, { agent: resumingAgent, spreadsheetCalculationEngine: engine });
  await built.featureFlags.setEnabled("persistent_subagents", scopeId("personal", "approver-42"), true, "test");
  const request = {
    surface: "web",
    actor: { externalId: "approver-42" },
    conversation: { kind: "dm" as const, threadRef: "web:approver-42:finny-alternate-clarification" },
    text: "Create an AP aging workbook",
  };
  const clarification = await built.app.turn(request);

  const result = await built.app.turn({
    ...request,
    approval: {
      requestId: clarification.pendingApprovals![0]!.requestId,
      approved: true,
      scope: "once",
      optionId: "month-end",
    } as never,
  });

  assert.equal(result.status, "pending_approval", JSON.stringify(await built.errors.list()));
  assert.equal(result.pendingApprovals?.[0]?.reason, "Finny Governance Plan Approval");
  assert.equal(result.pendingApprovals?.[0]?.command, sop.title);
  assert.equal(turns, 2);

  const approved = await built.app.turn({
    ...request,
    approval: { requestId: result.pendingApprovals![0]!.requestId, approved: true, scope: "once" } as never,
  });
  const db = createPgPool(config.databaseUrl!);
  const bindings = await db.q(
    "SELECT session_id FROM finny_runtime_bindings WHERE job_id=$1 AND role='producer'",
    [jobId],
  );

  assert.equal(approved.status, "ok", JSON.stringify(await built.errors.list()));
  assert.equal(bindings.length, 1, JSON.stringify(await built.errors.list()));
});

test("Other resolves a web Finny clarification without treating it as a denied command", async () => {
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
    conversation: { kind: "dm" as const, threadRef: "web:U1:finny-other-clarification" },
    text: "Create an AP aging workbook",
  };
  const clarification = await built.app.turn(request);

  const result = await built.app.turn({
    ...request,
    approval: { requestId: clarification.pendingApprovals![0]!.requestId, approved: false },
  });

  assert.equal(result.status, "ok");
  assert.match(result.reply ?? "", /revised plan/i);
  assert.equal(result.refusalKind, undefined);
});
