import assert from "node:assert/strict";
import test from "node:test";

import { toolCallApprovalKey } from "../src/core/approval-id.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import type { ToolContextRef } from "../src/harness/agent-tools.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { FinnyCapabilityCatalog, FinnyCapabilityDescriptor } from "../src/finny/capability-pack.ts";
import { compileFinnyControllerRequest } from "../src/finny/controller-compiler.ts";
import type { FinanceService } from "../src/finny/finance.ts";
import type { FinnyIntentCandidate } from "../src/finny/intent-resolver.ts";
import { applyFinnyHostEvent, digestFinnyEvidence, replayFinnyLedger } from "../src/finny/golden-loop.ts";
import { createFinnyFinanceTool } from "../src/finny/native-finance-tool.ts";
import { createFinnyRunStore, type FinnyRunV2Checkpoint } from "../src/finny/run-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const digest = (value: string) => digestFinnyEvidence(value);

function turn(history: HarnessTurnInput["history"] = []): HarnessTurnInput {
  return {
    session: { id: "session-run" } as HarnessTurnInput["session"],
    runId: "run-1",
    runtimeActorId: "actor-1",
    input: "What is the AP balance?",
    systemPrompt: "FINNY",
    history,
    tools: {} as HarnessTurnInput["tools"],
    surfaceName: "web",
    scopeLabel: "personal:actor-1",
    orgScopeId: "org:test",
    emit: async (entry) => ({ ...entry, seq: 1, createdAt: 1 }) as never,
    recordModelCall: () => {},
  };
}
const planNativeBase = {
  schemaVersion: 1 as const,
  intent: {
    dimensions: {
      entity: { type: "enum" as const, values: ["all"] },
      period: { type: "enum" as const, values: ["current"] },
      currency: { type: "enum" as const, values: ["source_base"] },
      grain: { type: "enum" as const, values: ["total"] },
      sources: { type: "string_list" as const, values: ["netsuite"] },
      artifact: { type: "enum" as const, values: ["optional", "required"] },
    },
  },
  dimensions: {
    required: ["entity", "period", "currency", "grain", "artifact"],
    supported: {
      entity: ["all"],
      period: ["current"],
      currency: ["source_base"],
      grain: ["total"],
      sources: ["netsuite"],
      artifact: ["optional", "required"],
    },
    defaults: { sources: ["netsuite"] },
  },
  parameterBindings: {},
  artifactPolicy: {
    allowedFormats: ["json" as const],
    defaultFormat: "json" as const,
    attachment: "when_requested" as const,
  },
  approvalPolicy: {
    mode: "before_source" as const,
    binds: ["capability_revision" as const, "dimensions" as const, "operation_graph" as const],
  },
  verificationPolicy: { requiredOperationIds: [], releaseGate: "delivery_eligible" as const },
};

const apCandidate = {
  capabilityId: "ap_balance",
  dimensions: {
    entity: "all",
    period: "current",
    currency: "source_base",
    grain: "total",
    artifact: "optional",
  },
} as const;

const inventoryCandidate = { ...apCandidate, capabilityId: "inventory_velocity" } as const;

function approvalRef(): ToolContextRef {
  return { pendingApprovals: [], approvedToolCalls: new Map() } as unknown as ToolContextRef;
}

async function executeApproved(
  tool: ReturnType<typeof createFinnyFinanceTool>,
  ref: ToolContextRef,
  callId: string,
  candidate: FinnyIntentCandidate,
) {
  await tool.execute(callId, candidate, undefined, undefined, {} as never);
  const approval = ref.pendingApprovals?.at(-1);
  if (!approval?.approvalKey) throw new Error("Finny approval was not requested");
  const approvedCallId = `${callId}:approved`;
  ref.approvedToolCalls?.set(approvedCallId, approval.approvalKey);
  return tool.execute(approvedCallId, candidate, undefined, undefined, {} as never);
}

const planNativeAp: FinnyCapabilityDescriptor = {
  ...planNativeBase,
  capabilityId: "ap_balance",
  revisionId: "ap_balance.2026-10-30",
  semanticCapability: "ap_balance",
  semanticAliases: ["accounts_payable"],
  operations: [
    {
      id: "ap_source",
      primitive: "suiteql_select",
      dependsOn: [],
      sql: "SELECT total FROM ap_balance",
      parameters: [],
    },
  ],
  resultOperationId: "ap_source",
};

const planNativeInventory: FinnyCapabilityDescriptor = {
  ...planNativeBase,
  capabilityId: "inventory_velocity",
  revisionId: "inventory_velocity.2026-10-30",
  semanticCapability: "inventory_velocity",
  semanticAliases: ["stock_efficiency"],
  operations: [
    {
      id: "inventory_source",
      primitive: "suiteql_select",
      dependsOn: [],
      sql: "SELECT SUM(amount) AS velocity FROM inventory_velocity",
      parameters: [],
    },
  ],
  resultOperationId: "inventory_source",
};

const planNativeCatalog: FinnyCapabilityCatalog = {
  manifestDigest: digest("plan-native-manifest"),
  catalogDigest: digest("plan-native-catalog"),
  capabilities: new Map([
    [planNativeAp.semanticCapability, planNativeAp],
    [planNativeInventory.semanticCapability, planNativeInventory],
  ]),
  aliases: new Map([
    ["accounts_payable", planNativeAp.semanticCapability],
    ["stock_efficiency", planNativeInventory.semanticCapability],
  ]),
};

function planNativeService(
  runStore: ReturnType<typeof createFinnyRunStore>,
  calls: string[],
  failArtifact = false,
): FinanceService {
  return {
    async clarify() {
      calls.push("clarify");
      return { clarification: "reviewed", evidenceDigest: digest("plan-native-clarification") };
    },
    async artifact() {
      calls.push("artifact");
      if (failArtifact) throw new Error("stop after plan source");
      return { requirement: "optional", policyDigest: digest("artifact-policy") };
    },
    async verify() {
      calls.push("verify");
      return { passed: true, verificationDigest: digest("verification") };
    },
    async recoverSource() {
      calls.push("recoverSource");
      return { records: [{ operation: "recovered_result" }] };
    },
    async executeOperation() {
      throw new Error("sourcePlan owns test operation custody");
    },
    async sourcePlan({ plan }) {
      calls.push(`sourcePlan:${plan.capabilityId}`);
      const checkpoint = await runStore.load(plan.capabilityId === "ap_balance" ? "run-ap" : "run-inventory");
      if (!checkpoint) throw new Error("plan run is unavailable");
      let state = replayFinnyLedger(checkpoint.runId, checkpoint.ledger);
      for (const operation of plan.operations.filter(
        (candidate) => candidate.id === plan.operations[0]!.id || candidate.id === plan.resultOperationId,
      )) {
        const next = applyFinnyHostEvent(state, {
          authority: "qm-host",
          eventId: `${checkpoint.runId}:operation:${operation.id}`,
          occurredAt: "2026-10-30T10:00:00.000Z",
          kind: "operation_completed",
          operationId: operation.id,
          primitive: operation.primitive,
          operationDigest: digest(`operation:${plan.planDigest}:${operation.id}`),
          resultDigest: digest(`result:${plan.planDigest}:${operation.id}`),
        });
        await runStore.checkpoint(checkpoint.runId, next.ledger.at(-1)!);
        state = next;
      }
      return {
        records: [{ operation: plan.resultOperationId }],
        sourceDigest: digest(`source:${plan.planDigest}:${plan.resultOperationId}`),
      };
    },
  };
}

test("plan-native AP and unrelated capabilities share one controller path without query authority", async () => {
  for (const scenario of [
    {
      runId: "run-ap",
      request: "AP balance",
      candidate: apCandidate,
      resultOperationId: "ap_source",
      capabilityId: "ap_balance",
    },
    {
      runId: "run-inventory",
      request: "inventory velocity",
      candidate: inventoryCandidate,
      resultOperationId: "inventory_source",
      capabilityId: "inventory_velocity",
    },
  ]) {
    const runStore = createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>());
    const calls: string[] = [];
    const harnessTurn = turn();
    harnessTurn.runId = scenario.runId;
    harnessTurn.input = scenario.request;
    const ref = approvalRef();
    const tool = createFinnyFinanceTool(harnessTurn, ref, planNativeService(runStore, calls), {
      runStore,
      evidenceBytes: createMemoryDurableByteStore(),
      capabilityCatalog: planNativeCatalog,
      now: () => "2026-10-30T10:00:00.000Z",
    });

    const result = await executeApproved(tool, ref, "plan-native", scenario.candidate);
    const checkpoint = await runStore.load(scenario.runId);
    const state = replayFinnyLedger(scenario.runId, checkpoint!.ledger);
    const operationIndex = checkpoint!.ledger.findIndex((entry) => entry.eventKind === "operation_completed");
    const sourceIndex = checkpoint!.ledger.findIndex((entry) => entry.eventKind === "source_collected");

    assert.equal((result as { isError?: boolean }).isError, undefined);
    assert.equal(checkpoint!.schema, "finny.run.v2");
    assert.equal(checkpoint!.plan.capabilityId, scenario.capabilityId);
    assert.equal("artifactRequest" in checkpoint!, false);
    assert.equal(state.queryDigest, undefined);
    assert.equal(
      checkpoint!.ledger.some((entry) => entry.evidence.some((item) => item.role === "query")),
      false,
    );
    assert.equal(state.approvalRequired, true);
    assert.ok(operationIndex >= 0 && operationIndex < sourceIndex);
    assert.match(
      result.content[0]?.type === "text" ? result.content[0].text : "",
      new RegExp(scenario.resultOperationId),
    );
    assert.deepEqual(calls, ["clarify", `sourcePlan:${scenario.capabilityId}`, "artifact", "verify"]);
  }
});

test("plan-native resume reopens its exact custodied plan and skips completed plan stages", async () => {
  const runStore = createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>());
  const evidenceBytes = createMemoryDurableByteStore();
  const firstCalls: string[] = [];
  const firstTurn = turn();
  firstTurn.runId = "run-ap";
  firstTurn.input = "AP balance";
  const firstRef = approvalRef();
  const first = createFinnyFinanceTool(firstTurn, firstRef, planNativeService(runStore, firstCalls, true), {
    runStore,
    evidenceBytes,
    capabilityCatalog: planNativeCatalog,
  });
  await executeApproved(first, firstRef, "plan-native-interrupted", apCandidate);
  assert.equal(replayFinnyLedger("run-ap", (await runStore.load("run-ap"))!.ledger).stage, "SOURCE");

  const resumedCalls: string[] = [];
  const resumedTurn = turn([
    {
      type: "tool_result",
      payload: { finnyWorkflowRunId: "run-ap" },
      scopeLabel: "personal:actor-1",
      seq: 1,
      createdAt: 1,
    },
  ] as HarnessTurnInput["history"]);
  resumedTurn.runId = "run-ap-resume";
  resumedTurn.input = "AP balance";
  const resumed = createFinnyFinanceTool(resumedTurn, {} as ToolContextRef, planNativeService(runStore, resumedCalls), {
    runStore,
    evidenceBytes,
    capabilityCatalog: planNativeCatalog,
  });

  const result = await resumed.execute("plan-native-resume", apCandidate, undefined, undefined, {} as never);

  assert.equal((result as { isError?: boolean }).isError, undefined);
  assert.deepEqual(resumedCalls, ["artifact", "verify", "recoverSource"]);
});

test("overlapping approved resumes serialize the plan source under the workflow lock", async () => {
  const runStore = createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>());
  const evidenceBytes = createMemoryDurableByteStore();
  const calls: string[] = [];
  const firstRef = approvalRef();
  const firstTurn = turn();
  firstTurn.runId = "run-ap";
  firstTurn.input = "AP balance";
  const first = createFinnyFinanceTool(firstTurn, firstRef, planNativeService(runStore, calls), {
    runStore,
    evidenceBytes,
    capabilityCatalog: planNativeCatalog,
  });
  await first.execute("prepare-approval", apCandidate, undefined, undefined, {} as never);
  const approvalKey = firstRef.pendingApprovals?.at(-1)?.approvalKey;
  if (!approvalKey) throw new Error("Finny approval was not requested");

  const createApprovedTool = (callId: string) => {
    const ref = approvalRef();
    ref.approvedToolCalls?.set(callId, approvalKey);
    return createFinnyFinanceTool(firstTurn, ref, planNativeService(runStore, calls), {
      runStore,
      evidenceBytes,
      capabilityCatalog: planNativeCatalog,
    });
  };
  const firstCallId = "approved-overlap-1";
  const secondCallId = "approved-overlap-2";
  const results = await Promise.all([
    createApprovedTool(firstCallId).execute(firstCallId, apCandidate, undefined, undefined, {} as never),
    createApprovedTool(secondCallId).execute(secondCallId, apCandidate, undefined, undefined, {} as never),
  ]);

  assert.equal(calls.filter((call) => call === "sourcePlan:ap_balance").length, 1);
  assert.equal(
    results.every((result) => !(result as { isError?: boolean }).isError),
    true,
  );
});

test("plan-native resume rejects a candidate whose current compilation differs from custody", async () => {
  const runStore = createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>());
  const evidenceBytes = createMemoryDurableByteStore();
  const firstTurn = turn();
  firstTurn.runId = "run-ap";
  firstTurn.input = "AP balance";
  const firstRef = approvalRef();
  const first = createFinnyFinanceTool(firstTurn, firstRef, planNativeService(runStore, [], true), {
    runStore,
    evidenceBytes,
    capabilityCatalog: planNativeCatalog,
  });
  await executeApproved(first, firstRef, "plan-native-original", apCandidate);

  const changedAp: FinnyCapabilityDescriptor = {
    ...planNativeAp,
    revisionId: "ap_balance.2026-10-31",
    operations: [
      {
        id: "ap_source",
        primitive: "suiteql_select",
        dependsOn: [],
        sql: "SELECT changed_total FROM ap_balance",
        parameters: [],
      },
    ],
  };
  const changedCatalog: FinnyCapabilityCatalog = {
    ...planNativeCatalog,
    catalogDigest: digest("changed-plan-native-catalog"),
    capabilities: new Map([
      [changedAp.semanticCapability, changedAp],
      [planNativeInventory.semanticCapability, planNativeInventory],
    ]),
  };
  const calls: string[] = [];
  const resumedTurn = turn([
    {
      type: "tool_result",
      payload: { finnyWorkflowRunId: "run-ap" },
      scopeLabel: "personal:actor-1",
      seq: 1,
      createdAt: 1,
    },
  ] as HarnessTurnInput["history"]);
  resumedTurn.runId = "run-ap-resume";
  resumedTurn.input = "AP balance";
  const resumed = createFinnyFinanceTool(resumedTurn, {} as ToolContextRef, planNativeService(runStore, calls), {
    runStore,
    evidenceBytes,
    capabilityCatalog: changedCatalog,
  });

  const result = await resumed.execute("plan-native-changed", apCandidate, undefined, undefined, {} as never);

  assert.equal((result as { isError?: boolean }).isError, true);
  assert.deepEqual(calls, []);
  assert.equal(replayFinnyLedger("run-ap", (await runStore.load("run-ap"))!.ledger).stage, "SOURCE");
});

test("plan-native resume fails closed when its custodied plan is unavailable", async () => {
  const runStore = createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>());
  const evidenceBytes = createMemoryDurableByteStore();
  const firstTurn = turn();
  firstTurn.runId = "run-ap";
  firstTurn.input = "AP balance";
  const firstRef = approvalRef();
  const first = createFinnyFinanceTool(firstTurn, firstRef, planNativeService(runStore, [], true), {
    runStore,
    evidenceBytes,
    capabilityCatalog: planNativeCatalog,
  });
  await executeApproved(first, firstRef, "plan-native-original", apCandidate);
  const checkpoint = await runStore.load("run-ap");
  assert.ok(checkpoint && checkpoint.schema === "finny.run.v2");
  await evidenceBytes.delete(`files/${checkpoint.plan.planDigest.slice("sha256:".length)}`);

  const calls: string[] = [];
  const resumedTurn = turn([
    {
      type: "tool_result",
      payload: { finnyWorkflowRunId: "run-ap" },
      scopeLabel: "personal:actor-1",
      seq: 1,
      createdAt: 1,
    },
  ] as HarnessTurnInput["history"]);
  resumedTurn.runId = "run-ap-resume";
  resumedTurn.input = "AP balance";
  const resumed = createFinnyFinanceTool(resumedTurn, {} as ToolContextRef, planNativeService(runStore, calls), {
    runStore,
    evidenceBytes,
    capabilityCatalog: planNativeCatalog,
  });

  const result = await resumed.execute("plan-native-corrupt", apCandidate, undefined, undefined, {} as never);

  assert.equal((result as { isError?: boolean }).isError, true);
  assert.deepEqual(calls, []);
  assert.equal(replayFinnyLedger("run-ap", checkpoint.ledger).stage, "SOURCE");
});

test("plan-native approval binds every compiled plan authority field", async () => {
  const approvalCapability: FinnyCapabilityDescriptor = {
    ...planNativeAp,
    approvalPolicy: { ...planNativeAp.approvalPolicy, mode: "before_source" },
    operations: [
      ...planNativeAp.operations,
      { id: "ap_repeat", primitive: "repeat_pull", dependsOn: ["ap_source"], operationId: "ap_source" },
      {
        id: "ap_reconcile",
        primitive: "reconcile",
        dependsOn: ["ap_source", "ap_repeat"],
        leftField: "total",
        rightField: "total",
        tolerance: "0.01",
      },
    ],
    resultOperationId: "ap_reconcile",
  };
  const catalog: FinnyCapabilityCatalog = {
    ...planNativeCatalog,
    catalogDigest: digest("approval-catalog"),
    capabilities: new Map([
      [approvalCapability.semanticCapability, approvalCapability],
      [planNativeInventory.semanticCapability, planNativeInventory],
    ]),
  };
  const compiled = compileFinnyControllerRequest(apCandidate, catalog);
  assert.equal(compiled.status, "compiled");
  if (compiled.status !== "compiled") throw new Error("plan did not compile");
  const runStore = createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>());
  const pendingApprovals: NonNullable<ToolContextRef["pendingApprovals"]> = [];
  const approvedToolCalls = new Map<string, string>();
  const ref = { pendingApprovals, approvedToolCalls } as ToolContextRef;
  const harnessTurn = turn();
  harnessTurn.runId = "run-ap";
  harnessTurn.input = "AP balance";
  const tool = createFinnyFinanceTool(harnessTurn, ref, planNativeService(runStore, []), {
    runStore,
    evidenceBytes: createMemoryDurableByteStore(),
    capabilityCatalog: catalog,
  });

  const result = await tool.execute("approval", apCandidate, undefined, undefined, {} as never);

  assert.equal((result as { terminate?: boolean }).terminate, true);
  assert.equal(pendingApprovals.length, 1);
  const expectedSummary = [
    "Capability: ap_balance @ ap_balance.2026-10-30",
    'Dimensions: {"artifact":"optional","currency":"source_base","entity":"all","grain":"total","period":"current","sources":["netsuite"]}',
    "Operations:",
    '- {"dependsOn":[],"id":"ap_source","parameters":[],"primitive":"suiteql_select","sql":"SELECT total FROM ap_balance"}',
    '- {"dependsOn":["ap_source"],"id":"ap_repeat","operationId":"ap_source","primitive":"repeat_pull"}',
    '- {"dependsOn":["ap_source","ap_repeat"],"id":"ap_reconcile","leftField":"total","primitive":"reconcile","rightField":"total","tolerance":"0.01"}',
    "Result operation: ap_reconcile",
    "Artifact: format json; allowed json; attachment when_requested",
    "Verification: required operations none; release gate delivery_eligible",
  ].join("\n");
  assert.equal(pendingApprovals[0]!.summary, expectedSummary);
  assert.equal(pendingApprovals[0]!.command, expectedSummary);
  const expectedApprovalKey = toolCallApprovalKey("finance", {
    request: "AP balance",
    schema: compiled.plan.schema,
    planDigest: compiled.plan.planDigest,
    catalogDigest: compiled.plan.catalogDigest,
    manifestDigest: compiled.plan.manifestDigest,
    capabilityId: compiled.plan.capabilityId,
    revisionId: compiled.plan.revisionId,
    semanticCapability: compiled.plan.semanticCapability,
    dimensionsDigest: compiled.plan.dimensionsDigest,
    operationGraphDigest: compiled.plan.operationGraphDigest,
    resultOperationId: compiled.plan.resultOperationId,
    artifactPolicyDigest: compiled.plan.artifactPolicyDigest,
    approvalPolicyDigest: compiled.plan.approvalPolicyDigest,
    verificationPolicyDigest: compiled.plan.verificationPolicyDigest,
    approvalSummary: expectedSummary,
  });
  assert.equal(pendingApprovals[0]!.approvalKey, expectedApprovalKey);

  approvedToolCalls.set("approved", expectedApprovalKey);
  const approved = await tool.execute("approved", apCandidate, undefined, undefined, {} as never);
  const state = replayFinnyLedger("run-ap", (await runStore.load("run-ap"))!.ledger);

  assert.equal((approved as { isError?: boolean }).isError, undefined);
  assert.equal(state.stage, "DELIVERY_ELIGIBLE");
  assert.equal(state.approvalDigest, digest(`finny-human-approval:v1:${expectedApprovalKey}`));
});

test("approval binds typed intent while keeping prose request from the trusted turn", async () => {
  const approvalCapability: FinnyCapabilityDescriptor = {
    ...planNativeAp,
    approvalPolicy: { ...planNativeAp.approvalPolicy, mode: "before_source" },
  };
  const catalog: FinnyCapabilityCatalog = {
    ...planNativeCatalog,
    capabilities: new Map([
      [approvalCapability.semanticCapability, approvalCapability],
      [planNativeInventory.semanticCapability, planNativeInventory],
    ]),
  };
  const runStore = createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>());
  const harnessTurn = turn();
  harnessTurn.input = "AP balance";
  const tool = createFinnyFinanceTool(harnessTurn, {} as ToolContextRef, planNativeService(runStore, []), {
    runStore,
    evidenceBytes: createMemoryDurableByteStore(),
    capabilityCatalog: catalog,
  });

  if (typeof tool.needsApproval !== "function") throw new Error("Finny approval callback is unavailable");
  await tool.needsApproval(inventoryCandidate);

  const binding = tool.approvalKeyParams?.(inventoryCandidate) as { capabilityId?: string; request?: string };
  assert.equal(binding.capabilityId, "inventory_velocity");
  assert.equal(binding.request, "AP balance");
});

test("resumed approval displays the same exact custodied plan summary", async () => {
  const runStore = createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>());
  const evidenceBytes = createMemoryDurableByteStore();
  const firstTurn = turn();
  firstTurn.runId = "run-ap";
  firstTurn.input = "AP balance";
  const firstRef = approvalRef();
  const first = createFinnyFinanceTool(firstTurn, firstRef, planNativeService(runStore, []), {
    runStore,
    evidenceBytes,
    capabilityCatalog: planNativeCatalog,
  });
  await first.execute("approval-first", apCandidate, undefined, undefined, {} as never);
  const firstApproval = firstRef.pendingApprovals?.at(-1);
  assert.ok(firstApproval?.summary);

  const resumedTurn = turn([
    {
      type: "tool_result",
      payload: { finnyWorkflowRunId: "run-ap" },
      scopeLabel: "personal:actor-1",
      seq: 1,
      createdAt: 1,
    },
  ] as HarnessTurnInput["history"]);
  resumedTurn.runId = "run-ap-resume";
  resumedTurn.input = "AP balance";
  const resumedRef = approvalRef();
  const resumed = createFinnyFinanceTool(resumedTurn, resumedRef, planNativeService(runStore, []), {
    runStore,
    evidenceBytes,
    capabilityCatalog: planNativeCatalog,
  });
  await resumed.execute("approval-resumed", apCandidate, undefined, undefined, {} as never);
  const resumedApproval = resumedRef.pendingApprovals?.at(-1);

  assert.equal(resumedApproval?.summary, firstApproval.summary);
  assert.equal(resumedApproval?.command, firstApproval.command);
  assert.equal(resumedApproval?.approvalKey, firstApproval.approvalKey);
});

test("plan-native approval resume ignores unrelated catalog digest changes", async () => {
  const approvalCapability: FinnyCapabilityDescriptor = {
    ...planNativeAp,
    approvalPolicy: { ...planNativeAp.approvalPolicy, mode: "before_source" },
  };
  const originalCatalog: FinnyCapabilityCatalog = {
    ...planNativeCatalog,
    catalogDigest: digest("original-approval-catalog"),
    capabilities: new Map([
      [approvalCapability.semanticCapability, approvalCapability],
      [planNativeInventory.semanticCapability, planNativeInventory],
    ]),
  };
  const original = compileFinnyControllerRequest(apCandidate, originalCatalog);
  assert.equal(original.status, "compiled");
  if (original.status !== "compiled") throw new Error("plan did not compile");
  const runStore = createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>());
  const evidenceBytes = createMemoryDurableByteStore();
  const firstTurn = turn();
  firstTurn.runId = "run-ap";
  firstTurn.input = "AP balance";
  const first = createFinnyFinanceTool(firstTurn, {} as ToolContextRef, planNativeService(runStore, []), {
    runStore,
    evidenceBytes,
    capabilityCatalog: originalCatalog,
  });
  await first.execute("approval-original", apCandidate, undefined, undefined, {} as never);

  const changedCatalog: FinnyCapabilityCatalog = {
    ...originalCatalog,
    catalogDigest: digest("changed-approval-catalog"),
  };
  const resumedTurn = turn([
    {
      type: "tool_result",
      payload: { finnyWorkflowRunId: "run-ap" },
      scopeLabel: "personal:actor-1",
      seq: 1,
      createdAt: 1,
    },
  ] as HarnessTurnInput["history"]);
  resumedTurn.runId = "run-ap-resume";
  resumedTurn.input = "AP balance";
  const resumedCalls: string[] = [];
  const resumedRef = approvalRef();
  const resumed = createFinnyFinanceTool(resumedTurn, resumedRef, planNativeService(runStore, resumedCalls), {
    runStore,
    evidenceBytes,
    capabilityCatalog: changedCatalog,
  });

  assert.equal(typeof resumed.needsApproval, "function");
  if (typeof resumed.needsApproval !== "function") throw new Error("approval callback is unavailable");
  const needsApproval = resumed.needsApproval;
  assert.equal(await needsApproval(apCandidate), true);
  const approvalKey = toolCallApprovalKey("finance", resumed.approvalKeyParams!(apCandidate));
  resumedRef.approvedToolCalls?.set("approval-resumed", approvalKey);
  const result = await resumed.execute("approval-resumed", apCandidate, undefined, undefined, {} as never);

  assert.equal((result as { isError?: boolean }).isError, undefined);
  assert.equal((await runStore.load("run-ap"))!.plan.catalogDigest, original.plan.catalogDigest);
  assert.equal(resumedCalls.includes("sourcePlan:ap_balance"), true);
});

test("plan-native approval resume rejects selected capability semantics drift", async () => {
  const runStore = createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>());
  const evidenceBytes = createMemoryDurableByteStore();
  const firstTurn = turn();
  firstTurn.runId = "run-ap";
  firstTurn.input = "AP balance";
  const first = createFinnyFinanceTool(firstTurn, {} as ToolContextRef, planNativeService(runStore, []), {
    runStore,
    evidenceBytes,
    capabilityCatalog: planNativeCatalog,
  });
  await first.execute("approval-original", apCandidate, undefined, undefined, {} as never);

  const resumedTurn = turn([
    {
      type: "tool_result",
      payload: { finnyWorkflowRunId: "run-ap" },
      scopeLabel: "personal:actor-1",
      seq: 1,
      createdAt: 1,
    },
  ] as HarnessTurnInput["history"]);
  resumedTurn.runId = "run-ap-resume";
  resumedTurn.input = "AP balance";
  const changedAp: FinnyCapabilityDescriptor = {
    ...planNativeAp,
    semanticCapability: "finance.ap.changed",
  };
  const changedCatalog: FinnyCapabilityCatalog = {
    ...planNativeCatalog,
    capabilities: new Map([
      [changedAp.semanticCapability, changedAp],
      [planNativeInventory.semanticCapability, planNativeInventory],
    ]),
  };
  const resumed = createFinnyFinanceTool(resumedTurn, {} as ToolContextRef, planNativeService(runStore, []), {
    runStore,
    evidenceBytes,
    capabilityCatalog: changedCatalog,
  });

  assert.equal(typeof resumed.needsApproval, "function");
  if (typeof resumed.needsApproval !== "function") throw new Error("approval callback is unavailable");
  const needsApproval = resumed.needsApproval;
  await assert.rejects(async () => needsApproval(apCandidate), /candidate.*custodied plan/i);
});
