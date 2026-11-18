import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import { createToolContext, type ToolContext } from "../src/tools/primitives.ts";
import type { FinnyToolService } from "../src/agent/agent-tools/finny.ts";
import { scopeId } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { Check } from "typebox/value";
import { finnySopFixture } from "./support/finny-sop-fixture.ts";

const service = {
  async createPlan() {
    return { message: "plan created", jobId: "job-1", requestId: "request-1", awaiting: "approval" as const };
  },
  async amendPlan() {
    return { message: "plan amended", jobId: "job-1", requestId: "request-2", awaiting: "approval" as const };
  },
  async status() {
    return "awaiting approval";
  },
  async artifactReady() {
    return "artifact recorded";
  },
  async pass() {
    return "check passed";
  },
  async block() {
    return "check blocked";
  },
  async deterministicAudit() {
    return "deterministic audit recorded";
  },
  async finalize() {
    return "job finalized";
  },
};

function context(): ToolContext {
  return { finny: service } as unknown as ToolContext;
}

test("finny is exposed only when its bound service exists and the turn is writable", () => {
  assert.equal(
    createAgentTools({ current: {} as ToolContext }).some((tool) => tool.name === "finny"),
    false,
  );
  assert.equal(
    createAgentTools({ current: context() }).some((tool) => tool.name === "finny"),
    true,
  );
  assert.equal(
    createAgentTools({ current: context() }, { readOnly: true }).some((tool) => tool.name === "finny"),
    false,
  );
});

const plan = {
  title: "October close",
  summary: "Prepare the management pack",
  phases: [{ name: "Prepare", owner: "Producer", dependencies: [] }],
  certification: "Independent audit",
  deliverable: "Management workbook",
  destination: "Finance leadership",
  clarifications: [{ question: "Currency?", answer: "INR" }],
};
const sop = finnySopFixture();
const values = { cutoff: "2026-10-31", currency: "INR", note: "first run" };
const certifiedSummary = {
  period: "2026-10-31",
  currency: "INR",
  metrics: [{ id: "open-ap", label: "Open AP", value: "12172560.00", detailRefs: ["xlsx:Summary!B7"] }],
  exceptions: [],
  caveats: [{ text: "FX translated at the approved cutoff rate", detailRefs: ["evidence:manifest#fx"] }],
};

function finnyTool() {
  const tool = createAgentTools({ current: context() }).find((candidate) => candidate.name === "finny");
  assert.ok(tool);
  return tool;
}

function finnyToolForRole(role: "parent" | "producer" | "auditor") {
  const tool = createAgentTools({
    current: { finny: { ...service, role } } as unknown as ToolContext,
  }).find((candidate) => candidate.name === "finny");
  assert.ok(tool);
  return tool;
}

test("finny plan actions accept only strict SOP versions and bound values", () => {
  const schema = finnyTool().parameters;
  assert.equal(Check(schema, { action: "create_plan", sop, values }), true);
  assert.equal(Check(schema, { action: "create_plan", sop: { ...sop, title: "   " }, values }), false);
  assert.equal(Check(schema, { action: "amend_plan", jobId: "job-1", sop, values }), true);
  assert.equal(Check(schema, { action: "create_plan", plan }), false);
  assert.equal(Check(schema, { action: "create_plan", sop }), false);
  assert.equal(Check(schema, { action: "create_plan", sop: { ...sop, nodes: [] }, values }), false);
});

test("worker Finny tools omit the SOP authoring schema", () => {
  const worker = createAgentTools({
    current: { finny: { ...service, role: "producer" } } as unknown as ToolContext,
  }).find((candidate) => candidate.name === "finny");
  assert.ok(worker);
  const schema = worker.parameters as { properties: Record<string, unknown> };
  assert.equal("sop" in schema.properties, false);
  assert.equal("values" in schema.properties, false);
  assert.equal(Check(worker.parameters, { action: "create_plan", sop, values }), false);
  assert.equal(
    Check(worker.parameters, {
      action: "artifact_ready",
      artifactDigest: "sha256:artifact",
      provisionalRevision: "file-1",
      idempotencyKey: "ready-1",
    }),
    true,
  );
});

test("Finny tools expose only role-owned actions and parameter fields", () => {
  const parent = finnyToolForRole("parent");
  const producer = finnyToolForRole("producer");
  const auditor = finnyToolForRole("auditor");
  const fields = (tool: typeof parent) =>
    Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties).sort();

  assert.deepEqual(fields(parent), [
    "action",
    "idempotencyKey",
    "jobId",
    "materialClarification",
    "retrySafe",
    "sop",
    "summary",
    "values",
  ]);
  assert.deepEqual(fields(producer), [
    "action",
    "artifactDigest",
    "idempotencyKey",
    "jobId",
    "provisionalRevision",
    "retrySafe",
  ]);
  assert.deepEqual(fields(auditor), [
    "action",
    "controls",
    "idempotencyKey",
    "jobId",
    "judgmentAnswers",
    "retrySafe",
    "triggeredJudgmentControlIds",
  ]);

  assert.equal(
    Check(parent.parameters, {
      action: "artifact_ready",
      artifactDigest: "a",
      provisionalRevision: "f",
      idempotencyKey: "k",
    }),
    false,
  );
  assert.equal(Check(parent.parameters, { action: "deterministic_audit", idempotencyKey: "k", controls: [] }), false);
  assert.equal(
    Check(producer.parameters, { action: "finalize", jobId: "j", summary: certifiedSummary, idempotencyKey: "k" }),
    false,
  );
  assert.equal(Check(producer.parameters, { action: "deterministic_audit", idempotencyKey: "k", controls: [] }), false);
  assert.equal(
    Check(auditor.parameters, {
      action: "artifact_ready",
      artifactDigest: "a",
      provisionalRevision: "f",
      idempotencyKey: "k",
    }),
    false,
  );
  assert.equal(
    Check(auditor.parameters, { action: "finalize", jobId: "j", summary: certifiedSummary, idempotencyKey: "k" }),
    false,
  );
  assert.ok(JSON.stringify(producer.parameters).length < JSON.stringify(parent.parameters).length);
  assert.ok(JSON.stringify(auditor.parameters).length < JSON.stringify(parent.parameters).length);
});

test("parent Finny schema accepts only parent-owned actions", () => {
  const schema = finnyTool().parameters;
  const valid = [
    { action: "create_plan", sop, values },
    { action: "amend_plan", jobId: "job-1", sop, values },
    {
      action: "amend_plan",
      jobId: "job-1",
      sop,
      values,
      materialClarification: {
        question: "Basis?",
        options: [
          { id: "contracts", label: "Contracts" },
          { id: "invoices", label: "Invoices", description: "Use issued invoices" },
        ],
        recommendedOptionId: "contracts",
      },
    },
    {
      action: "create_plan",
      sop,
      values,
      materialClarification: {
        question: "Basis?",
        options: [
          { id: "contracts", label: "Contracts" },
          { id: "invoices", label: "Invoices", description: "Use issued invoices" },
        ],
        recommendedOptionId: "contracts",
      },
    },
    { action: "status", jobId: "job-1" },
    { action: "finalize", jobId: "job-1", summary: certifiedSummary, idempotencyKey: "finalize-1" },
  ];
  for (const input of valid) assert.ok(Check(schema, input), JSON.stringify(input));
  assert.equal(
    Check(schema, {
      action: "pass",
      checkId: "financial.reconcile",
      generation: 1,
      evidenceFileId: "evidence-file-1",
      idempotencyKey: "pass-1",
    }),
    false,
  );
  assert.equal(
    Check(schema, {
      action: "block",
      checkId: "formula.recalculate",
      generation: 1,
      evidenceFileId: "evidence-file-1",
      findings: [{ code: "FORMULA_ERROR", message: "Formula does not recalculate" }],
      idempotencyKey: "block-1",
    }),
    false,
  );
});

test("finny schema rejects model-supplied authority and escalation fields", () => {
  const schema = finnyTool().parameters;
  const base = { action: "status", jobId: "job-1" };
  const forbidden = [
    "grantToken",
    "scopeId",
    "actorId",
    "runId",
    "sessionId",
    "role",
    "requiredChecks",
    "artifactDigest",
    "approvalReceipt",
    "provisionalRevision",
    "deliveryRevision",
    "issuerPrincipalId",
    "issuerRunId",
    "evidenceDigest",
    "changeKinds",
    "resolution",
    "retryLimit",
    "escalationLimit",
    "requestId",
    "originThreadRef",
    "authorizedActorId",
  ];
  for (const field of forbidden) {
    assert.equal(Check(schema, { ...base, [field]: field === "requiredChecks" ? [] : "forbidden" }), false, field);
  }
  assert.equal(Check(schema, { action: "create_plan", sop: { ...sop, nodes: [] }, values }), false);
  assert.equal(Check(schema, { action: "deterministic_audit", idempotencyKey: "audit-1", verdict: "pass" }), false);
  assert.equal(
    Check(schema, {
      action: "create_plan",
      sop,
      values,
      materialClarification: {
        question: "Basis?",
        options: [{ id: "only", label: "Only" }],
        recommendedOptionId: "only",
      },
    }),
    false,
  );
});

const execute = async (tool: ReturnType<typeof finnyTool>, id: string, params: unknown) =>
  (tool.execute as unknown as (callId: string, input: unknown) => Promise<{ content: Array<{ text: string }> }>)(
    id,
    params,
  );

test("role-owned Finny actions forward narrow inputs and return concise bound-service text", async () => {
  const calls: Array<[string, unknown]> = [];
  const bound: FinnyToolService = {
    async createPlan(input, boundValues) {
      calls.push(["create_plan", { sop: input, values: boundValues }]);
      return {
        message: "created job-1",
        jobId: "job-1",
        requestId: "request-1",
        awaiting: "approval",
      };
    },
    async amendPlan(jobId, input, boundValues) {
      calls.push(["amend_plan", { jobId, sop: input, values: boundValues }]);
      return {
        message: "amended job-1",
        jobId: "job-1",
        requestId: "request-2",
        awaiting: "approval",
      };
    },
    async status(input) {
      calls.push(["status", input]);
      return "job-1 awaiting approval";
    },
    async artifactReady(input) {
      calls.push(["artifact_ready", input]);
      return "artifact accepted";
    },
    async deterministicAudit(input) {
      calls.push(["deterministic_audit", input]);
      return "deterministic audit accepted";
    },
    async finalize(input) {
      calls.push(["finalize", input]);
      return "job finalized";
    },
  };
  const tool = (role: "parent" | "producer" | "auditor") => {
    const candidate = createAgentTools({
      current: { finny: { ...bound, role } } as unknown as ToolContext,
    }).find((entry) => entry.name === "finny");
    assert.ok(candidate);
    return candidate;
  };
  const inputs: Array<[ReturnType<typeof tool>, Record<string, unknown>]> = [
    [tool("parent"), { action: "create_plan", sop, values }],
    [tool("parent"), { action: "status", jobId: "job-1", retrySafe: true }],
    [
      tool("producer"),
      {
        action: "artifact_ready",
        artifactDigest: "sha256:artifact",
        provisionalRevision: "revision-1",
        idempotencyKey: "ready-1",
        retrySafe: true,
      },
    ],
    [
      tool("auditor"),
      {
        action: "deterministic_audit",
        idempotencyKey: "deterministic-1",
        controls: [{ id: "source-total", verdict: "pass", evidenceRefs: ["xlsx:Summary!B1"], repairActions: [] }],
        retrySafe: true,
      },
    ],
    [
      tool("parent"),
      {
        action: "finalize",
        jobId: "job-1",
        summary: certifiedSummary,
        idempotencyKey: "finalize-1",
        retrySafe: true,
      },
    ],
  ];
  const replies = [];
  for (const [index, [roleTool, input]] of inputs.entries()) {
    replies.push((await execute(roleTool, `call-${index}`, input)).content[0]?.text);
  }
  assert.deepEqual(replies, [
    "created job-1",
    "job-1 awaiting approval",
    "artifact accepted",
    "deterministic audit accepted",
    "job finalized",
  ]);
  assert.deepEqual(calls, [
    ["create_plan", { sop, values }],
    ["status", "job-1"],
    [
      "artifact_ready",
      { artifactDigest: "sha256:artifact", provisionalRevision: "revision-1", idempotencyKey: "ready-1" },
    ],
    [
      "deterministic_audit",
      {
        action: "deterministic_audit",
        idempotencyKey: "deterministic-1",
        controls: [{ id: "source-total", verdict: "pass", evidenceRefs: ["xlsx:Summary!B1"], repairActions: [] }],
      },
    ],
    ["finalize", { jobId: "job-1", summary: certifiedSummary, idempotencyKey: "finalize-1" }],
  ]);
});

test("web Finny approval retains the durable plan request identity", async () => {
  const pendingApprovals: NonNullable<import("../src/agent/agent-tools.ts").ToolContextRef["pendingApprovals"]> = [];
  const bound = {
    ...service,
    async createPlan() {
      return {
        message: "Finny plan job-1 is awaiting approval.",
        jobId: "job-1",
        requestId: "plan-request-1",
        awaiting: "approval" as const,
      };
    },
  };
  const tool = createAgentTools(
    { current: { finny: bound } as unknown as ToolContext, pendingApprovals },
    { surfaceName: "web" },
  ).find((candidate) => candidate.name === "finny");
  assert.ok(tool);

  await execute(tool, "call-plan", { action: "create_plan", sop, values });

  assert.equal(pendingApprovals[0]?.approvalKey, "finny-plan:plan-request-1");
});

test("web Finny amendment presents its durable replacement approval", async () => {
  const pendingApprovals: NonNullable<import("../src/agent/agent-tools.ts").ToolContextRef["pendingApprovals"]> = [];
  let operationId: string | undefined;
  const bound = {
    ...service,
    async amendPlan(...args: Parameters<FinnyToolService["amendPlan"]>) {
      operationId = args[4];
      return {
        message: "Finny plan job-1 amendment is awaiting scope change approval.",
        jobId: "job-1",
        requestId: "amendment-request-1",
        awaiting: "approval" as const,
      };
    },
  } as unknown as FinnyToolService;
  const tool = createAgentTools(
    { current: { finny: bound } as unknown as ToolContext, pendingApprovals },
    { surfaceName: "web" },
  ).find((candidate) => candidate.name === "finny");
  assert.ok(tool);

  await execute(tool, "call-amendment", { action: "amend_plan", jobId: "job-1", sop, values });

  assert.equal(pendingApprovals[0]?.approvalKey, "finny-plan:amendment-request-1");
  assert.equal(pendingApprovals[0]?.command, sop.title);
  assert.equal(operationId, "call-amendment");
});

test("web Finny non-material amendment returns without a replacement approval", async () => {
  const pendingApprovals: NonNullable<import("../src/agent/agent-tools.ts").ToolContextRef["pendingApprovals"]> = [];
  const bound = {
    ...service,
    async amendPlan() {
      return {
        message: "Finny plan job-1 amendment was recorded without changing its approved execution.",
        jobId: "job-1",
        awaiting: "none" as const,
      };
    },
  } as unknown as FinnyToolService;
  const tool = createAgentTools(
    { current: { finny: bound } as unknown as ToolContext, pendingApprovals },
    { surfaceName: "web" },
  ).find((candidate) => candidate.name === "finny");
  assert.ok(tool);

  const result = await execute(tool, "call-non-material-amendment", {
    action: "amend_plan",
    jobId: "job-1",
    sop,
    values,
  });

  assert.equal(pendingApprovals.length, 0);
  assert.match(result.content[0]?.text ?? "", /recorded without changing/i);
});

test("web Finny clarification presents the durable question before plan approval", async () => {
  const pendingApprovals: NonNullable<import("../src/agent/agent-tools.ts").ToolContextRef["pendingApprovals"]> = [];
  const clarification = {
    question: "Which accounting basis should be used?",
    options: [
      { id: "contracts", label: "Signed contracts" },
      { id: "invoices", label: "Issued invoices" },
    ],
    recommendedOptionId: "contracts",
  };
  const bound = {
    ...service,
    async createPlan() {
      return {
        message: "Finny plan job-1 is awaiting clarification.",
        jobId: "job-1",
        requestId: "clarification-request-1",
        awaiting: "clarification" as const,
      };
    },
  };
  const tool = createAgentTools(
    { current: { finny: bound } as unknown as ToolContext, pendingApprovals },
    { surfaceName: "web" },
  ).find((candidate) => candidate.name === "finny");
  assert.ok(tool);

  await execute(tool, "call-clarification", {
    action: "create_plan",
    sop,
    values,
    materialClarification: clarification,
  });

  assert.deepEqual(
    pendingApprovals.map(({ command, reason, approvalKey, summary }) => ({ command, reason, approvalKey, summary })),
    [
      {
        command: clarification.question,
        reason: "Finny Governance Clarification",
        approvalKey: "finny-clarification:clarification-request-1",
        summary: "Recommended: Signed contracts",
      },
    ],
  );
});

test("tool context carries the injected bound Finny service", () => {
  const handle: SandboxHandle = { id: "h", rootDir: "/workspace" };
  const toolContext = createToolContext({
    finny: service,
    sandbox: {} as Sandbox,
    provision: async () => handle,
    writableScopeId: scopeId("personal", "U1"),
    readOnlyScopeIds: [],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
  });
  assert.equal(toolContext.finny, service);
});

test("finny retry annotations reject replaying non-idempotent plan creation", () => {
  const schema = finnyTool().parameters;
  assert.ok(Check(schema, { action: "create_plan", sop, values, retrySafe: false }));
  assert.equal(Check(schema, { action: "create_plan", sop, values, retrySafe: true }), false);
  assert.ok(Check(schema, { action: "status", jobId: "job-1", retrySafe: true }));
  assert.equal(Check(schema, { action: "pass", retrySafe: true }), false);
});

test("finny refuses forbidden fields before invoking its bound service", async () => {
  let calls = 0;
  const bound = {
    ...service,
    async status() {
      calls += 1;
      return "status";
    },
  };
  const tool = createAgentTools({ current: { finny: bound } as unknown as ToolContext }).find(
    (candidate) => candidate.name === "finny",
  );
  assert.ok(tool);
  const result = await execute(tool, "forbidden", {
    action: "status",
    jobId: "job-1",
    actorId: "attacker",
  });
  assert.equal(calls, 0);
  assert.match(result.content[0]?.text ?? "", /Invalid arguments/);
});
