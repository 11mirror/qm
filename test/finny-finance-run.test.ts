import assert from "node:assert/strict";
import test from "node:test";

import { toolCallApprovalKey } from "../src/core/approval-id.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createAgentTools, type ToolContextRef } from "../src/harness/agent-tools.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { FinnyCapabilityCatalog, FinnyCapabilityDescriptor } from "../src/finny/capability-pack.ts";
import { compileFinnyControllerRequest } from "../src/finny/controller-compiler.ts";
import type { FinanceService } from "../src/finny/finance.ts";
import { applyFinnyHostEvent, digestFinnyEvidence, replayFinnyLedger } from "../src/finny/golden-loop.ts";
import {
  createFinnyFinanceTool as createDurableFinnyFinanceTool,
  type FinnyFinanceToolOptions,
} from "../src/finny/native-finance-tool.ts";
import { FINNY_AP_GL_CONTROL_BALANCE_QUERY } from "../src/finny/reviewed-query.ts";
import {
  createFinnyRunStore,
  type FinnyRunCheckpoint,
  type FinnyRunStore,
  type FinnyRunV2Checkpoint,
} from "../src/finny/run-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const digest = (value: string) => digestFinnyEvidence(value);

function createFinnyFinanceTool(
  harnessTurn: HarnessTurnInput,
  ref: ToolContextRef,
  service: FinanceService,
  options: Partial<FinnyFinanceToolOptions> = {},
) {
  return createDurableFinnyFinanceTool(harnessTurn, ref, service, {
    runStore: options.runStore ?? createFinnyRunStore(createMemoryMap<FinnyRunCheckpoint>()),
    reportUnexpectedError: options.reportUnexpectedError ?? (() => {}),
    ...options,
  });
}

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

function successfulService(calls: string[], approvalRequired = false): FinanceService {
  return {
    async clarify() {
      calls.push("clarify");
      return { clarification: "AP control balance", evidenceDigest: digest("clarified") };
    },
    async preflight() {
      calls.push("preflight");
      return {
        planSummary: "Read-only AP control balance",
        preflightDigest: digest("preflight"),
        planDigest: digest("service-plan"),
        approvalRequired,
        ...(approvalRequired ? {} : { approvalPolicyDigest: digest("read-policy") }),
      };
    },
    async plan() {
      calls.push("plan");
      return approvalRequired
        ? { decision: "approved", approvalDigest: digest("approval") }
        : { decision: "exempt", approvalPolicyDigest: digest("read-policy") };
    },
    async source() {
      calls.push("source");
      return { records: [{ total: "42" }], sourceDigest: digest("source") };
    },
    async artifact() {
      calls.push("artifact");
      return { requirement: "optional", policyDigest: digest("artifact-policy") };
    },
    async verify() {
      calls.push("verify");
      return { passed: true, verificationDigest: digest("verification") };
    },
  };
}

test("one finance.run call drives every host-owned Golden Loop stage for an exempt read", async () => {
  const calls: string[] = [];
  const service = successfulService(calls);
  const basePreflight = service.preflight.bind(service);
  let preflightQuery: string | undefined;
  service.preflight = async (input, context) => {
    preflightQuery = input.query;
    return basePreflight(input, context);
  };
  const raw = createFinnyFinanceTool(turn(), {} as ToolContextRef, service, {
    now: () => "2026-10-30T10:00:00.000Z",
  });

  const result = await raw.execute(
    "run-call",
    { request: "What is the AP balance?" },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(calls, ["clarify", "preflight", "plan", "source", "artifact", "verify"]);
  assert.equal(preflightQuery, FINNY_AP_GL_CONTROL_BALANCE_QUERY);
  assert.equal((result.details as { stage?: unknown }).stage, "DELIVERY_ELIGIBLE");
  assert.equal((result as { terminate?: boolean }).terminate, undefined);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /delivery_eligible/i);
  assert.doesNotMatch(JSON.stringify(result), /sensitive|credential/i);
});

test("the compiled capability owns verification policy when service preflight disagrees", async () => {
  const service = successfulService([]);
  const basePreflight = service.preflight.bind(service);
  service.preflight = async (input, context) => ({
    ...(await basePreflight(input, context)),
    verificationPolicy: "repeatable_read",
  });
  let sourcePolicy: unknown;
  const baseSource = service.source.bind(service);
  service.source = async (input, context) => {
    sourcePolicy = context.verificationPolicy;
    return baseSource(input, context);
  };
  const tool = createFinnyFinanceTool(turn(), {} as ToolContextRef, service);

  await tool.execute("policy-authority", { request: "What is the AP balance?" }, undefined, undefined, {} as never);

  assert.equal(sourcePolicy, "single_numeric_total");
});

test("finance.run checkpoints exact approval and resumes without repeating preflight", async () => {
  const calls: string[] = [];
  const service = successfulService(calls, true);
  const checkpointStore = createFinnyRunStore(createMemoryMap<FinnyRunCheckpoint>());
  const firstEmitted: Array<{ type: string; payload: Record<string, unknown>; scopeLabel: string }> = [];
  const pendingApprovals: NonNullable<ToolContextRef["pendingApprovals"]> = [];
  const firstRef: ToolContextRef = {
    current: {} as ToolContextRef["current"],
    scopeLabel: "personal:actor-1",
    runtimeActorId: "actor-1",
    pendingApprovals,
    emit: (entry) => {
      firstEmitted.push(entry as (typeof firstEmitted)[number]);
    },
  };
  const firstRaw = createFinnyFinanceTool(turn(), firstRef, service, {
    now: () => "2026-10-30T10:00:00.000Z",
    runStore: checkpointStore,
  });
  const first = createAgentTools(firstRef, { nativeTools: [firstRaw] }).find((tool) => tool.name === "finance")!;

  const blocked = await first.execute(
    "run-before-approval",
    { request: "What is the AP balance?" },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(calls, ["clarify", "preflight"]);
  assert.equal(pendingApprovals.length, 1);
  assert.match(pendingApprovals[0]?.summary ?? "", /AP control balance/i);
  assert.equal((blocked as { terminate?: boolean }).terminate, true);
  assert.equal((blocked.details as { stage?: unknown }).stage, "PREFLIGHT");

  const history = firstEmitted.map((entry, index) => ({
    ...entry,
    scopeLabel: entry.scopeLabel as HarnessTurnInput["scopeLabel"],
    seq: index + 1,
    createdAt: index + 1,
  })) as HarnessTurnInput["history"];
  const approvedKey = pendingApprovals[0]!.approvalKey;
  const approvalCheckpoint = await checkpointStore.load("run-1");
  const evidence = approvalCheckpoint!.ledger.flatMap((entry) => entry.evidence);
  const evidenceDigest = (role: string) => evidence.find((item) => item.role === role)?.digest;
  assert.equal(
    approvedKey,
    toolCallApprovalKey("finance", {
      request: "What is the AP balance?",
      planDigest: evidenceDigest("plan"),
      queryDigest: evidenceDigest("query"),
      verificationPolicyDigest: evidenceDigest("verification_policy"),
    }),
  );
  const secondRef: ToolContextRef = {
    current: {} as ToolContextRef["current"],
    scopeLabel: "personal:actor-1",
    runtimeActorId: "actor-1",
    toolApprovalGate: (_tool, callKey) => callKey === approvedKey,
  };
  const secondRaw = createFinnyFinanceTool(turn(history), secondRef, service, {
    now: () => "2026-10-30T10:01:00.000Z",
    runStore: checkpointStore,
  });
  const second = createAgentTools(secondRef, { nativeTools: [secondRaw] }).find((tool) => tool.name === "finance")!;
  const released = await second.execute(
    "run-after-approval",
    { request: "What is the AP balance?" },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(calls, ["clarify", "preflight", "plan", "source", "artifact", "verify"]);
  assert.equal((released.details as { stage?: unknown }).stage, "DELIVERY_ELIGIBLE");
});

test("finance.run resumes from a durable source checkpoint without repeating the provider read", async () => {
  const checkpointStore = createFinnyRunStore(createMemoryMap<FinnyRunCheckpoint>());
  const firstCalls: string[] = [];
  const interrupted = successfulService(firstCalls);
  interrupted.artifact = async () => {
    firstCalls.push("artifact");
    throw new Error("simulated interruption after source custody");
  };
  const first = createFinnyFinanceTool(turn(), {} as ToolContextRef, interrupted, {
    now: () => "2026-10-30T10:00:00.000Z",
    runStore: checkpointStore,
  });

  const interruptedResult = await first.execute(
    "run-interrupted",
    { request: "What is the AP balance?" },
    undefined,
    undefined,
    {} as never,
  );

  assert.equal((interruptedResult as { isError?: boolean }).isError, true);
  assert.deepEqual(firstCalls, ["clarify", "preflight", "plan", "source", "artifact"]);
  const sourceCheckpoint = await checkpointStore.load("run-1");
  assert.equal(replayFinnyLedger("run-1", sourceCheckpoint!.ledger).stage, "SOURCE");

  const resumedCalls: string[] = [];
  const mustNotRepeat = async (name: string): Promise<never> => {
    resumedCalls.push(name);
    throw new Error(`${name} repeated`);
  };
  const resumed: FinanceService = {
    clarify: () => mustNotRepeat("clarify"),
    preflight: () => mustNotRepeat("preflight"),
    plan: () => mustNotRepeat("plan"),
    source: () => mustNotRepeat("source"),
    async artifact() {
      resumedCalls.push("artifact");
      return { requirement: "optional", policyDigest: digest("artifact-policy") };
    },
    async verify() {
      resumedCalls.push("verify");
      return { passed: true, verificationDigest: digest("verification") };
    },
    async recoverSource() {
      resumedCalls.push("recoverSource");
      return { records: [{ total: "42" }] };
    },
  };
  const second = createFinnyFinanceTool(
    { ...turn(), input: "", trustedInput: "What is the AP balance?", continueTurn: true, resumeUserSeq: 1 },
    {} as ToolContextRef,
    resumed,
    {
      now: () => "2026-10-30T10:01:00.000Z",
      runStore: checkpointStore,
    },
  );

  const released = await second.execute(
    "run-resumed",
    { request: "What is the AP balance?" },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(resumedCalls, ["artifact", "verify", "recoverSource"]);
  assert.equal((released.details as { stage?: unknown }).stage, "DELIVERY_ELIGIBLE");
  assert.match(released.content[0]?.type === "text" ? released.content[0].text : "", /"total":"42"/);
});

test("finance.run resumes a required artifact after its policy checkpoint", async () => {
  const checkpointStore = createFinnyRunStore(createMemoryMap<FinnyRunCheckpoint>());
  let interrupted = false;
  const interruptingStore: FinnyRunStore = {
    ...checkpointStore,
    async checkpoint(runId, metadata, artifactReference) {
      const saved = await checkpointStore.checkpoint(runId, metadata, artifactReference);
      if (!interrupted && metadata.eventKind === "artifact_classified") {
        interrupted = true;
        throw new Error("simulated interruption after artifact policy");
      }
      return saved;
    },
  };
  const artifactDigest = digest("required-artifact");
  const firstCalls: string[] = [];
  const firstService = successfulService(firstCalls);
  firstService.artifact = async (input) => {
    firstCalls.push("artifact");
    return {
      requirement: "required",
      policyDigest: digest(`artifact-policy:${input.requirement ?? "optional"}`),
      artifactDigest,
      reference: "artifacts/report.csv",
    };
  };
  const first = createFinnyFinanceTool(turn(), {} as ToolContextRef, firstService, {
    runStore: interruptingStore,
  });

  await first.execute(
    "run-artifact-interrupted",
    { request: "What is the AP balance?" },
    undefined,
    undefined,
    {} as never,
  );

  const partial = await checkpointStore.load("run-1");
  assert.equal(replayFinnyLedger("run-1", partial!.ledger).stage, "ARTIFACT_REQUIRED");
  assert.equal(replayFinnyLedger("run-1", partial!.ledger).artifactDigest, undefined);
  assert.equal(partial?.artifactReference, "artifacts/report.csv");

  const resumedCalls: string[] = [];
  const mustNotRepeat = async (name: string): Promise<never> => {
    resumedCalls.push(name);
    throw new Error(`${name} repeated`);
  };
  const resumed: FinanceService = {
    clarify: () => mustNotRepeat("clarify"),
    preflight: () => mustNotRepeat("preflight"),
    plan: () => mustNotRepeat("plan"),
    source: () => mustNotRepeat("source"),
    async artifact(input) {
      resumedCalls.push("artifact");
      return {
        requirement: "required",
        policyDigest: digest(`artifact-policy:new-deploy:${input.requirement ?? "optional"}`),
        artifactDigest,
        reference: "artifacts/report.csv",
      };
    },
    async verify() {
      resumedCalls.push("verify");
      return { passed: true, verificationDigest: digest("verification") };
    },
    async recoverSource() {
      resumedCalls.push("recoverSource");
      return { records: [{ total: "42" }] };
    },
  };
  const second = createFinnyFinanceTool(turn(), {} as ToolContextRef, resumed, { runStore: checkpointStore });

  const released = await second.execute(
    "run-artifact-resumed",
    { request: "What is the AP balance?" },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(resumedCalls, ["artifact", "verify", "recoverSource"]);
  assert.equal((released.details as { stage?: unknown }).stage, "DELIVERY_ELIGIBLE");
});

test("finance.run resumes a verified checkpoint by authorizing delivery without repeating verification", async () => {
  const checkpointStore = createFinnyRunStore(createMemoryMap<FinnyRunCheckpoint>());
  let interrupted = false;
  const interruptingStore: FinnyRunStore = {
    ...checkpointStore,
    async checkpoint(runId, metadata, artifactReference) {
      const saved = await checkpointStore.checkpoint(runId, metadata, artifactReference);
      if (!interrupted && metadata.eventKind === "verification_passed") {
        interrupted = true;
        throw new Error("simulated interruption after verification");
      }
      return saved;
    },
  };
  const firstCalls: string[] = [];
  const first = createFinnyFinanceTool(turn(), {} as ToolContextRef, successfulService(firstCalls), {
    runStore: interruptingStore,
  });

  await first.execute(
    "run-verification-interrupted",
    { request: "What is the AP balance?" },
    undefined,
    undefined,
    {} as never,
  );

  const verifiedCheckpoint = await checkpointStore.load("run-1");
  assert.equal(replayFinnyLedger("run-1", verifiedCheckpoint!.ledger).stage, "VERIFIED");

  const resumedCalls: string[] = [];
  const mustNotRepeat = async (name: string): Promise<never> => {
    resumedCalls.push(name);
    throw new Error(`${name} repeated`);
  };
  const resumed: FinanceService = {
    clarify: () => mustNotRepeat("clarify"),
    preflight: () => mustNotRepeat("preflight"),
    plan: () => mustNotRepeat("plan"),
    source: () => mustNotRepeat("source"),
    artifact: () => mustNotRepeat("artifact"),
    verify: () => mustNotRepeat("verify"),
    async recoverSource() {
      resumedCalls.push("recoverSource");
      return { records: [{ total: "42" }] };
    },
  };
  const second = createFinnyFinanceTool(turn(), {} as ToolContextRef, resumed, { runStore: checkpointStore });

  const released = await second.execute(
    "run-verification-resumed",
    { request: "What is the AP balance?" },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(resumedCalls, ["recoverSource"]);
  assert.equal((released.details as { stage?: unknown }).stage, "DELIVERY_ELIGIBLE");
});

test("a verified checkpoint survives removal of its compiler capability", async () => {
  const sourceStore = createFinnyRunStore(createMemoryMap<FinnyRunCheckpoint>());
  const interruptingStore: FinnyRunStore = {
    ...sourceStore,
    async checkpoint(runId, metadata, artifactReference) {
      const saved = await sourceStore.checkpoint(runId, metadata, artifactReference);
      if (metadata.eventKind === "verification_passed") throw new Error("stop after verification");
      return saved;
    },
  };
  const first = createFinnyFinanceTool(turn(), {} as ToolContextRef, successfulService([]), {
    runStore: interruptingStore,
  });
  await first.execute(
    "build-legacy-checkpoint",
    { request: "What is the AP balance?" },
    undefined,
    undefined,
    {} as never,
  );
  const sourceCheckpoint = await sourceStore.load("run-1");
  assert.equal(replayFinnyLedger("run-1", sourceCheckpoint!.ledger).stage, "VERIFIED");

  const request = "open AR by synthetic legacy-ERP migrated invoice";
  const checkpointStore = createFinnyRunStore(createMemoryMap<FinnyRunCheckpoint>());
  await checkpointStore.initialize({
    runId: "legacy-run",
    requestDigest: digest(`finny-request:v1:${request}`),
    sessionId: "session-run",
    scopeId: "personal:actor-1",
    artifactRequest: "optional",
  });
  for (const metadata of sourceCheckpoint!.ledger) {
    await checkpointStore.checkpoint("legacy-run", {
      ...metadata,
      runId: "legacy-run",
      eventId: metadata.eventId.replace(/^run-1:/, "legacy-run:"),
    });
  }
  const resumedCalls: string[] = [];
  const mustNotRepeat = async (name: string): Promise<never> => {
    resumedCalls.push(name);
    throw new Error(`${name} repeated`);
  };
  const service: FinanceService = {
    clarify: () => mustNotRepeat("clarify"),
    preflight: () => mustNotRepeat("preflight"),
    plan: () => mustNotRepeat("plan"),
    source: () => mustNotRepeat("source"),
    artifact: () => mustNotRepeat("artifact"),
    verify: () => mustNotRepeat("verify"),
    async recoverSource() {
      resumedCalls.push("recoverSource");
      return { records: [{ total: "42" }] };
    },
  };
  const resumedTurn = turn([
    {
      type: "tool_result",
      payload: { finnyWorkflowRunId: "legacy-run" },
      scopeLabel: "personal:actor-1",
      seq: 1,
      createdAt: 1,
    },
  ] as HarnessTurnInput["history"]);
  resumedTurn.runId = "current-run";
  resumedTurn.input = request;
  const resumed = createFinnyFinanceTool(resumedTurn, {} as ToolContextRef, service, { runStore: checkpointStore });

  const released = await resumed.execute("resume-legacy", { request }, undefined, undefined, {} as never);

  assert.deepEqual(resumedCalls, ["recoverSource"]);
  assert.equal((released.details as { stage?: unknown }).stage, "DELIVERY_ELIGIBLE");
});

test("finance.run fails closed when a resumed delivery cannot recover source records", async () => {
  const checkpointStore = createFinnyRunStore(createMemoryMap<FinnyRunCheckpoint>());
  const firstService = successfulService([]);
  firstService.verify = async () => {
    throw new Error("simulated interruption before verification");
  };
  const first = createFinnyFinanceTool(turn(), {} as ToolContextRef, firstService, { runStore: checkpointStore });
  await first.execute("run-interrupted", { request: "What is the AP balance?" }, undefined, undefined, {} as never);

  const mustNotRepeat = async (): Promise<never> => {
    throw new Error("completed stage repeated");
  };
  const resumed: FinanceService = {
    clarify: mustNotRepeat,
    preflight: mustNotRepeat,
    plan: mustNotRepeat,
    source: mustNotRepeat,
    artifact: mustNotRepeat,
    async verify() {
      return { passed: true, verificationDigest: digest("verification") };
    },
  };
  const second = createFinnyFinanceTool(turn(), {} as ToolContextRef, resumed, { runStore: checkpointStore });

  const result = await second.execute(
    "run-resumed",
    { request: "What is the AP balance?" },
    undefined,
    undefined,
    {} as never,
  );

  assert.equal((result as { isError?: boolean }).isError, true);
  assert.equal((result.details as { stage?: unknown }).stage, "VERIFIED");
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /finance_error/i);
});

test("finance.run does not expose delivery eligibility when its release checkpoint fails", async () => {
  const checkpointStore = createFinnyRunStore(createMemoryMap<FinnyRunCheckpoint>());
  const failingStore: FinnyRunStore = {
    ...checkpointStore,
    async checkpoint(runId, metadata, artifactReference) {
      if (metadata.eventKind === "delivery_authorized") throw new Error("simulated release checkpoint failure");
      return checkpointStore.checkpoint(runId, metadata, artifactReference);
    },
  };
  const raw = createFinnyFinanceTool(turn(), {} as ToolContextRef, successfulService([]), {
    runStore: failingStore,
  });

  const result = await raw.execute(
    "run-release-checkpoint-failure",
    { request: "What is the AP balance?" },
    undefined,
    undefined,
    {} as never,
  );

  assert.equal((result as { isError?: boolean }).isError, true);
  assert.equal((result.details as { stage?: unknown }).stage, "VERIFIED");
  const checkpoint = await checkpointStore.load("run-1");
  assert.equal(replayFinnyLedger("run-1", checkpoint!.ledger).stage, "VERIFIED");
});

test("finance.run serializes overlapping resumes before provider work", async () => {
  const backing = createMemoryMap<FinnyRunCheckpoint>();
  const lock = (await import("../src/persistence/advisory-lock.ts")).createMemoryAdvisoryLock();
  const checkpointStore = createFinnyRunStore(backing, undefined, lock);
  const calls: string[] = [];
  const service = successfulService(calls);
  service.recoverSource = async () => {
    calls.push("recoverSource");
    return { records: [{ total: "42" }] };
  };
  const first = createFinnyFinanceTool(turn(), {} as ToolContextRef, service, { runStore: checkpointStore });
  const second = createFinnyFinanceTool(turn(), {} as ToolContextRef, service, { runStore: checkpointStore });

  const results = await Promise.all([
    first.execute("run-overlap-1", { request: "What is the AP balance?" }, undefined, undefined, {} as never),
    second.execute("run-overlap-2", { request: "What is the AP balance?" }, undefined, undefined, {} as never),
  ]);

  assert.equal(calls.filter((call) => call === "source").length, 1);
  assert.equal(
    results.every((result) => !(result as { isError?: boolean }).isError),
    true,
  );
});

test("a failed workflow does not bind a later supported request to its digest", async () => {
  const checkpointStore = createFinnyRunStore(createMemoryMap<FinnyRunCheckpoint>());
  const firstService = successfulService([]);
  firstService.source = async () => {
    throw new Error("provider failed");
  };
  const first = createFinnyFinanceTool(turn(), {} as ToolContextRef, firstService, { runStore: checkpointStore });
  const failed = await first.execute(
    "failed-call",
    { request: "What is the AP balance?" },
    undefined,
    undefined,
    {} as never,
  );
  assert.equal((failed as { isError?: boolean }).isError, true);

  const nextTurn = turn([
    {
      type: "tool_result",
      payload: { finnyWorkflowRunId: "run-1" },
      scopeLabel: "personal:actor-1",
      seq: 1,
      createdAt: 1,
    },
  ] as HarnessTurnInput["history"]);
  nextTurn.runId = "run-2";
  nextTurn.input = "Show the current accounts payable balance";
  const second = createFinnyFinanceTool(nextTurn, {} as ToolContextRef, successfulService([]), {
    runStore: checkpointStore,
  });

  const released = await second.execute(
    "new-call",
    { request: "Show the current accounts payable balance" },
    undefined,
    undefined,
    {} as never,
  );

  assert.equal((released as { isError?: boolean }).isError, undefined);
  assert.equal((released.details as { stage?: unknown }).stage, "DELIVERY_ELIGIBLE");
  assert.ok(await checkpointStore.load("run-2"));
});

test("an unrelated turn cannot resume an unfinished workflow with its old request", async () => {
  const checkpointStore = createFinnyRunStore(createMemoryMap<FinnyRunCheckpoint>());
  const interrupted = successfulService([]);
  interrupted.source = async () => {
    throw new Error("provider interruption");
  };
  const first = createFinnyFinanceTool(turn(), {} as ToolContextRef, interrupted, { runStore: checkpointStore });
  await first.execute("old-call", { request: "What is the AP balance?" }, undefined, undefined, {} as never);

  const nextTurn = turn([
    {
      type: "tool_result",
      payload: { finnyWorkflowRunId: "run-1" },
      scopeLabel: "personal:actor-1",
      seq: 1,
      createdAt: 1,
    },
  ] as HarnessTurnInput["history"]);
  nextTurn.runId = "run-2";
  nextTurn.input = "open AR for Example Manufacturing as at 15-Sep-2025";
  const calls: string[] = [];
  const second = createFinnyFinanceTool(nextTurn, {} as ToolContextRef, successfulService(calls), {
    runStore: checkpointStore,
  });

  const result = await second.execute(
    "new-call-old-candidate",
    { request: "What is the AP balance?" },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(calls, []);
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.equal(await checkpointStore.load("run-2"), null);
});

test("finance.run rejects an unsupported Finance IR before any finance service call", async () => {
  const calls: string[] = [];
  const service = successfulService(calls);
  const harnessTurn = turn();
  harnessTurn.input = "open AR for Example Manufacturing as at 15-Sep-2025";
  const raw = createFinnyFinanceTool(harnessTurn, {} as ToolContextRef, service);

  const result = await raw.execute(
    "run-unsupported",
    { request: "What is the AP balance?" },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(calls, []);
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.equal((result as { terminate?: boolean }).terminate, true);
  assert.deepEqual((result.details as { blocker?: unknown }).blocker, {
    action: "preflight",
    code: "finance_error",
    cause: "unsupported_template",
    retryable: false,
  });
});

test("unexpected checkpoint failures are durably correlated without entering the safe trace", async () => {
  const secret = new Error("database password=hunter2");
  const backing = createFinnyRunStore(createMemoryMap<FinnyRunCheckpoint>());
  const runStore: FinnyRunStore = {
    ...backing,
    async initialize() {
      throw secret;
    },
  };
  const diagnostics: Array<{ runId: string; operation: string; failure: { diagnosticId?: string } }> = [];
  const reported: unknown[] = [];
  const raw = createFinnyFinanceTool(turn(), {} as ToolContextRef, successfulService([]), {
    runStore,
    diagnostics: { record: (event) => diagnostics.push(event) },
    reportUnexpectedError: (error) => reported.push(error),
  });

  const result = await raw.execute(
    "unexpected-checkpoint",
    { request: "What is the AP balance?" },
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(reported, [secret]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.runId, "run-1");
  assert.equal(diagnostics[0]?.operation, "finance preflight");
  assert.match(diagnostics[0]?.failure.diagnosticId ?? "", /^finny-[A-Za-z0-9-]+$/);
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.equal(
    (result.details as { blocker?: { diagnosticId?: string } }).blocker?.diagnosticId,
    diagnostics[0]?.failure.diagnosticId,
  );
  assert.doesNotMatch(JSON.stringify(result), /hunter2|password|database/);
});

const planNativeBase = {
  schemaVersion: 1 as const,
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
    mode: "none" as const,
    binds: ["capability_revision" as const, "dimensions" as const, "operation_graph" as const],
  },
  verificationPolicy: { requiredOperationIds: [], releaseGate: "delivery_eligible" as const },
};

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
      sql: "SELECT amount FROM inventory_velocity",
      parameters: [],
    },
    {
      id: "inventory_total",
      primitive: "aggregate",
      dependsOn: ["inventory_source"],
      groupBy: [],
      metrics: [{ id: "velocity", operator: "sum", field: "amount" }],
    },
  ],
  resultOperationId: "inventory_total",
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
  runStore: ReturnType<typeof createFinnyRunStore<FinnyRunV2Checkpoint>>,
  calls: string[],
  failArtifact = false,
): FinanceService {
  const legacy = async (): Promise<never> => {
    calls.push("legacy");
    throw new Error("legacy finance path must not run");
  };
  return {
    async clarify() {
      calls.push("clarify");
      return { clarification: "reviewed", evidenceDigest: digest("plan-native-clarification") };
    },
    preflight: legacy,
    plan: legacy,
    source: legacy,
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
    async preflightPlan({ plan }) {
      calls.push(`preflightPlan:${plan.capabilityId}`);
      return {
        planSummary: plan.semanticCapability,
        preflightDigest: digest(`preflight:${plan.planDigest}`),
        approvalRequired: true,
        approvalPolicyDigest: digest("untrusted-service-policy"),
      };
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
    { runId: "run-ap", request: "AP balance", resultOperationId: "ap_source", capabilityId: "ap_balance" },
    {
      runId: "run-inventory",
      request: "inventory velocity",
      resultOperationId: "inventory_total",
      capabilityId: "inventory_velocity",
    },
  ]) {
    const runStore = createFinnyRunStore<FinnyRunV2Checkpoint>(createMemoryMap<FinnyRunV2Checkpoint>());
    const calls: string[] = [];
    const harnessTurn = turn();
    harnessTurn.runId = scenario.runId;
    harnessTurn.input = scenario.request;
    const tool = createFinnyFinanceTool(harnessTurn, {} as ToolContextRef, planNativeService(runStore, calls), {
      runStore,
      evidenceBytes: createMemoryDurableByteStore(),
      capabilityCatalog: planNativeCatalog,
      now: () => "2026-10-30T10:00:00.000Z",
    });

    const result = await tool.execute("plan-native", { request: scenario.request }, undefined, undefined, {} as never);
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
    assert.equal(state.approvalRequired, false);
    assert.ok(operationIndex >= 0 && operationIndex < sourceIndex);
    assert.match(
      result.content[0]?.type === "text" ? result.content[0].text : "",
      new RegExp(scenario.resultOperationId),
    );
    assert.deepEqual(calls, [
      "clarify",
      `preflightPlan:${scenario.capabilityId}`,
      `sourcePlan:${scenario.capabilityId}`,
      "artifact",
      "verify",
    ]);
  }
});

test("plan-native resume recompiles the exact catalog binding and skips completed plan stages", async () => {
  const runStore = createFinnyRunStore<FinnyRunV2Checkpoint>(createMemoryMap<FinnyRunV2Checkpoint>());
  const evidenceBytes = createMemoryDurableByteStore();
  const firstCalls: string[] = [];
  const firstTurn = turn();
  firstTurn.runId = "run-ap";
  firstTurn.input = "AP balance";
  const first = createFinnyFinanceTool(firstTurn, {} as ToolContextRef, planNativeService(runStore, firstCalls, true), {
    runStore,
    evidenceBytes,
    capabilityCatalog: planNativeCatalog,
  });
  await first.execute("plan-native-interrupted", { request: "AP balance" }, undefined, undefined, {} as never);
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

  const result = await resumed.execute(
    "plan-native-resume",
    { request: "AP balance" },
    undefined,
    undefined,
    {} as never,
  );

  assert.equal((result as { isError?: boolean }).isError, undefined);
  assert.deepEqual(resumedCalls, ["artifact", "verify", "recoverSource"]);
});

test("plan-native resume rejects a changed catalog binding before source or delivery", async () => {
  const runStore = createFinnyRunStore<FinnyRunV2Checkpoint>(createMemoryMap<FinnyRunV2Checkpoint>());
  const evidenceBytes = createMemoryDurableByteStore();
  const firstTurn = turn();
  firstTurn.runId = "run-ap";
  firstTurn.input = "AP balance";
  const first = createFinnyFinanceTool(firstTurn, {} as ToolContextRef, planNativeService(runStore, [], true), {
    runStore,
    evidenceBytes,
    capabilityCatalog: planNativeCatalog,
  });
  await first.execute("plan-native-original", { request: "AP balance" }, undefined, undefined, {} as never);

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

  const result = await resumed.execute(
    "plan-native-changed",
    { request: "AP balance" },
    undefined,
    undefined,
    {} as never,
  );

  assert.equal((result as { isError?: boolean }).isError, true);
  assert.deepEqual(calls, []);
  assert.equal(replayFinnyLedger("run-ap", (await runStore.load("run-ap"))!.ledger).stage, "SOURCE");
});

test("plan-native approval binds every compiled plan authority field", async () => {
  const approvalCapability: FinnyCapabilityDescriptor = {
    ...planNativeAp,
    approvalPolicy: { ...planNativeAp.approvalPolicy, mode: "before_source" },
  };
  const catalog: FinnyCapabilityCatalog = {
    ...planNativeCatalog,
    catalogDigest: digest("approval-catalog"),
    capabilities: new Map([
      [approvalCapability.semanticCapability, approvalCapability],
      [planNativeInventory.semanticCapability, planNativeInventory],
    ]),
  };
  const compiled = compileFinnyControllerRequest("AP balance", catalog);
  assert.equal(compiled.status, "compiled");
  if (compiled.status !== "compiled") throw new Error("plan did not compile");
  const runStore = createFinnyRunStore<FinnyRunV2Checkpoint>(createMemoryMap<FinnyRunV2Checkpoint>());
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

  const result = await tool.execute("approval", { request: "AP balance" }, undefined, undefined, {} as never);

  assert.equal((result as { terminate?: boolean }).terminate, true);
  assert.equal(pendingApprovals.length, 1);
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
  });
  assert.equal(pendingApprovals[0]!.approvalKey, expectedApprovalKey);

  approvedToolCalls.set("approved", expectedApprovalKey);
  const approved = await tool.execute("approved", { request: "AP balance" }, undefined, undefined, {} as never);
  const state = replayFinnyLedger("run-ap", (await runStore.load("run-ap"))!.ledger);

  assert.equal((approved as { isError?: boolean }).isError, undefined);
  assert.equal(state.stage, "DELIVERY_ELIGIBLE");
  assert.equal(state.approvalDigest, digest(`finny-human-approval:v1:${expectedApprovalKey}`));
});
