import assert from "node:assert/strict";
import test from "node:test";

import type { Harness, HarnessTurnInput } from "../src/harness/harness.ts";
import {
  applyFinnyHostEvent,
  createFinnyGoldenLoop,
  digestFinnyEvidence,
  type FinnyHostEvent,
  type FinnyLedgerMetadata,
} from "../src/finny/golden-loop.ts";
import { createFinnyPiHarness, withFinnyPiProfile } from "../src/finny/pi-profile.ts";
import { createFinnyRunStore, type FinnyRunStore, type FinnyRunV2Checkpoint } from "../src/finny/run-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createUnavailableFinanceService } from "../src/finny/unavailable-finance-service.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";

const d = (value: string) => digestFinnyEvidence(value);

function completedLedger() {
  const base = { authority: "qm-host" as const, occurredAt: "2026-10-30T10:00:00.000Z" };
  const events: FinnyHostEvent[] = [
    { ...base, eventId: "1", kind: "clarify_completed", evidenceDigest: d("clarify") },
    {
      ...base,
      eventId: "2",
      kind: "preflight_completed",
      preflightDigest: d("preflight"),
      planDigest: d("plan"),
      queryDigest: d("query"),
      verificationPolicy: "repeatable_read",
      verificationPolicyDigest: d("finny-verification-policy:v1:repeatable_read"),
    },
    { ...base, eventId: "3", kind: "plan_approved", planDigest: d("plan"), approvalDigest: d("approval") },
    { ...base, eventId: "4", kind: "source_collected", sourceDigest: d("source") },
    { ...base, eventId: "5", kind: "artifact_classified", requirement: "optional", policyDigest: d("policy") },
    { ...base, eventId: "6", kind: "verification_passed", verificationDigest: d("verify") },
    { ...base, eventId: "7", kind: "delivery_authorized", deliveryDigest: d("release") },
  ];
  return events.reduce(applyFinnyHostEvent, createFinnyGoldenLoop("run-1")).ledger;
}

function testRunStore(): FinnyRunStore {
  return createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>());
}

async function persistLedger(runStore: FinnyRunStore, ledger: readonly FinnyLedgerMetadata[]): Promise<void> {
  await runStore.initialize({
    schema: "finny.run.v2",
    runId: "run-1",
    requestDigest: d("request"),
    sessionId: "session-1",
    scopeId: "personal:actor-1",
    plan: {
      catalogDigest: d("catalog"),
      capabilityId: "test-capability",
      revisionId: "test-revision",
      operationGraphDigest: d("operation-graph"),
      planDigest: d("plan"),
    },
  });
  for (const metadata of ledger) await runStore.checkpoint("run-1", metadata);
}

function baseHarness(complete: boolean, runStore: FinnyRunStore, sourceDigest = d("source")): Harness {
  return {
    profile: {
      id: "pi",
      controlTransport: "in-process",
      toolTransport: "in-process",
      transcriptFormat: "pi",
      capabilities: new Set(),
    },
    tools: { name: (name) => name },
    models: {},
    turns: {
      async runTurn(input) {
        input.onTextBlockStart?.("final_answer");
        input.onDelta?.("UNVERIFIED MODEL CLAIM");
        if (complete) {
          await persistLedger(runStore, completedLedger());
          await input.emit({
            type: "tool_result",
            payload: {
              tool: "finance",
              callId: "verify",
              result: JSON.stringify({
                profile: "finny",
                harness: "pi",
                action: "run",
                outcome: "delivery_eligible",
                stage: "DELIVERY_ELIGIBLE",
                evidence: {
                  records: [{ total: "42" }],
                  sourceDigest,
                  verificationDigest: d("verify"),
                },
              }),
              finnyWorkflowRunId: "run-1",
            },
            scopeLabel: input.scopeLabel,
          });
        }
        await input.emit({
          type: "assistant",
          payload: { text: "UNVERIFIED MODEL CLAIM" },
          scopeLabel: input.scopeLabel,
        });
        return { reply: "UNVERIFIED MODEL CLAIM" };
      },
    },
  };
}

function turn(events: Array<{ type: string; payload: unknown }>, deltas: string[]): HarnessTurnInput {
  let seq = 0;
  return {
    session: { id: "session-1" } as HarnessTurnInput["session"],
    runId: "run-1",
    runtimeActorId: "actor-1",
    runtime: { harnessId: "pi", modelId: "gpt-5.6-sol" },
    input: "AP balance",
    systemPrompt: "BASE",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "personal:actor-1" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
    emit: async (entry) => {
      events.push(entry);
      return { ...entry, seq: ++seq, createdAt: seq } as Awaited<ReturnType<HarnessTurnInput["emit"]>>;
    },
    recordModelCall: () => {},
    onDelta: (chunk) => deltas.push(chunk),
  };
}

test("Finny suppresses model claims and emits a host-authored block before verification", async () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  const deltas: string[] = [];
  const runStore = testRunStore();
  const harness = withFinnyPiProfile(baseHarness(false, runStore), { modelId: "gpt-5.6-sol", runStore });

  const result = await harness.turns.runTurn(turn(events, deltas));

  assert.equal(JSON.stringify(events).includes("UNVERIFIED MODEL CLAIM"), false);
  assert.equal(deltas.join("").includes("UNVERIFIED MODEL CLAIM"), false);
  assert.match(result.reply, /blocked.*CLARIFY/i);
  assert.equal(harness.profile.id, "pi");
});

test("Finny reports the safe host blocker that stopped an approved finance plan", async () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  const deltas: string[] = [];
  const approved = completedLedger().slice(0, 3);
  const runStore = testRunStore();
  const base = baseHarness(false, runStore);
  base.turns.runTurn = async (input) => {
    await persistLedger(runStore, approved);
    await input.emit({
      type: "tool_result",
      payload: {
        tool: "finance",
        callId: "source",
        result: "[error] blocked_external",
        finnyWorkflowRunId: "run-1",
        finnyBlocker: {
          action: "source",
          code: "blocked_external",
          cause: "provider_timeout",
          retryable: true,
          dependency: "netsuite",
          diagnosticId: "diag-source-timeout",
        },
      },
      scopeLabel: input.scopeLabel,
    });
    return { reply: "MODEL SHOULD NOT ESCAPE" };
  };
  const harness = withFinnyPiProfile(base, { modelId: "gpt-5.6-sol", runStore });

  const result = await harness.turns.runTurn(turn(events, deltas));

  assert.match(result.reply, /timed out.*source/i);
  assert.doesNotMatch(result.reply, /blocked_external/i);
  assert.doesNotMatch(result.reply, /MODEL SHOULD NOT ESCAPE/);
  assert.match(result.reply, /NetSuite/i);
  assert.match(result.reply, /retry/i);
});

test("Finny does not misreport an unsupported request as an external outage", async () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  const deltas: string[] = [];
  const runStore = testRunStore();
  const unsupported = completedLedger().slice(0, 1);
  const base = baseHarness(false, runStore);
  base.turns.runTurn = async (input) => {
    await persistLedger(runStore, unsupported);
    await input.emit({
      type: "tool_result",
      payload: {
        tool: "finance",
        callId: "preflight",
        result: "[error] finance_error",
        finnyWorkflowRunId: "run-1",
        finnyBlocker: {
          action: "preflight",
          code: "finance_error",
          cause: "unsupported_template",
          retryable: false,
          diagnosticId: "diag-unsupported",
        },
      },
      scopeLabel: input.scopeLabel,
    });
    return { reply: "MODEL SHOULD NOT ESCAPE" };
  };
  const harness = withFinnyPiProfile(base, { modelId: "gpt-5.6-sol", runStore });

  const result = await harness.turns.runTurn(turn(events, deltas));

  assert.match(result.reply, /not yet supported/i);
  assert.match(result.reply, /no finance source was called/i);
  assert.doesNotMatch(result.reply, /blocked_external/i);
});

test("Finny releases only host-rendered verified records after delivery eligibility", async () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  const deltas: string[] = [];
  const runStore = testRunStore();
  const harness = withFinnyPiProfile(baseHarness(true, runStore), { modelId: "gpt-5.6-sol", runStore });

  const result = await harness.turns.runTurn(turn(events, deltas));

  assert.equal(
    result.reply,
    `Finny verified this finance result:\n\n[\n  {\n    "total": "42"\n  }\n]\n\nSource evidence: ${d("source")}\nVerification evidence: ${d("verify")}`,
  );
  assert.equal(JSON.stringify(events).includes("UNVERIFIED MODEL CLAIM"), false);
  assert.equal(deltas.join("").includes("UNVERIFIED MODEL CLAIM"), false);
  assert.equal(deltas.join(""), result.reply);
});

test("Finny blocks delivery when persisted result evidence does not match the durable ledger", async () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  const deltas: string[] = [];
  const runStore = testRunStore();
  const harness = withFinnyPiProfile(baseHarness(true, runStore, d("different source")), {
    modelId: "gpt-5.6-sol",
    runStore,
  });

  const result = await harness.turns.runTurn(turn(events, deltas));

  assert.match(result.reply, /verified result evidence is unavailable/i);
  assert.equal(JSON.stringify(events).includes("UNVERIFIED MODEL CLAIM"), false);
  assert.equal(deltas.join("").includes("UNVERIFIED MODEL CLAIM"), false);
});

test("Finny suppresses model output when an errored tool result carries a completed ledger", async () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  const deltas: string[] = [];
  const runStore = testRunStore();
  const base = baseHarness(false, runStore);
  base.turns.runTurn = async (input) => {
    input.onDelta?.("MODEL CLAIM");
    await persistLedger(runStore, completedLedger());
    await input.emit({
      type: "tool_result",
      payload: {
        tool: "finance",
        callId: "release",
        result: "[error] finance_error",
        finnyWorkflowRunId: "run-1",
        finnyBlocker: {
          action: "source",
          code: "finance_error",
          cause: "internal_error",
          retryable: false,
          diagnosticId: "diag-recovery-failed",
        },
      },
      scopeLabel: input.scopeLabel,
    });
    return { reply: "MODEL CLAIM" };
  };
  const harness = withFinnyPiProfile(base, { modelId: "gpt-5.6-sol", runStore });

  const result = await harness.turns.runTurn(turn(events, deltas));

  assert.doesNotMatch(result.reply, /MODEL CLAIM/);
  assert.doesNotMatch(JSON.stringify(events), /MODEL CLAIM/);
  assert.match(result.reply, /internal error/i);
});

test("Finny refuses any runtime that is not the pinned Pi model", async () => {
  const runStore = testRunStore();
  const harness = withFinnyPiProfile(baseHarness(false, runStore), { modelId: "gpt-5.6-sol", runStore });
  const wrongHarness = turn([], []);
  wrongHarness.runtime = { harnessId: "claude", modelId: "gpt-5.6-sol" };
  const wrongModel = turn([], []);
  wrongModel.runtime = { harnessId: "pi", modelId: "other-model" };

  await assert.rejects(harness.turns.runTurn(wrongHarness), /harness=pi/i);
  await assert.rejects(harness.turns.runTurn(wrongModel), /pinned model/i);
});

test("Finny injects bounded reviewed finance knowledge with provenance before Pi runs", async () => {
  let dispatchedPrompt = "";
  const runStore = testRunStore();
  const base = baseHarness(false, runStore);
  base.turns.runTurn = async (input) => {
    dispatchedPrompt = input.systemPrompt;
    return { reply: "unused" };
  };
  const harness = withFinnyPiProfile(base, {
    modelId: "gpt-5.6-sol",
    runStore,
    knowledgeIndex: Promise.resolve({
      bundleDigest: `sha256:${"a".repeat(64)}`,
      fileCount: 1,
      select: () => [
        {
          path: "synthetic-receivables-policy/SKILL.md",
          content: "Receipts retain unapplied customer payments.",
          sha256: "b".repeat(64),
        },
      ],
    }),
  });
  const request = turn([], []);
  request.input = "customer receipts";

  await harness.turns.runTurn(request);

  assert.match(dispatchedPrompt, /reviewed_finance_knowledge/i);
  assert.match(dispatchedPrompt, /synthetic-receivables-policy\/SKILL\.md/);
  assert.match(dispatchedPrompt, /Receipts retain unapplied customer payments/);
  assert.match(dispatchedPrompt, /sha256:[a-f0-9]{64}/);
});

test("a completed prior task never authorizes an unverified task on a later run", async () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  const deltas: string[] = [];
  const next = turn(events, deltas);
  next.runId = "run-2";
  next.history = [
    {
      type: "tool_result",
      payload: {
        tool: "finance",
        callId: "old",
        result: "old",
        finnyWorkflowRunId: "run-1",
      },
      scopeLabel: next.scopeLabel,
      seq: 1,
      createdAt: 1,
    },
  ] as HarnessTurnInput["history"];
  const runStore = testRunStore();
  const harness = withFinnyPiProfile(baseHarness(false, runStore), { modelId: "gpt-5.6-sol", runStore });

  const result = await harness.turns.runTurn(next);

  assert.match(result.reply, /blocked.*CLARIFY/i);
  assert.equal(JSON.stringify(events).includes("UNVERIFIED MODEL CLAIM"), false);
});

test("the Finny factory remains the standard Pi harness and pins its model", () => {
  const harness = createFinnyPiHarness({
    modelId: "gpt-5.6-sol",
    financeService: createUnavailableFinanceService(),
    runStore: createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>()),
    evidenceBytes: createMemoryDurableByteStore(),
    capabilityCatalog: {
      manifestDigest: `sha256:${"a".repeat(64)}`,
      catalogDigest: `sha256:${"b".repeat(64)}`,
      capabilities: new Map(),
      aliases: new Map(),
    },
  });
  assert.equal(harness.profile.id, "pi");
  assert.equal(harness.profile.toolTransport, "in-process");
});

test("the Finny factory uses its pinned model for every available Pi model operation", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const models: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    models.push(String((JSON.parse(String(init?.body)) as { model?: unknown }).model));
    return new Response(JSON.stringify({ error: { message: "offline Finny model test" } }), { status: 401 });
  }) as typeof fetch;
  const harness = createFinnyPiHarness({
    modelId: "claude-opus-5",
    detectModelId: "claude-sonnet-5",
    titleModelId: "claude-sonnet-5",
    judgeModelId: "claude-sonnet-5",
    resolveFallbackRuntime: () => ({ modelId: "claude-sonnet-5" }),
    financeService: createUnavailableFinanceService(),
    runStore: createFinnyRunStore(createMemoryMap<FinnyRunV2Checkpoint>()),
    evidenceBytes: createMemoryDurableByteStore(),
    capabilityCatalog: {
      manifestDigest: `sha256:${"a".repeat(64)}`,
      catalogDigest: `sha256:${"b".repeat(64)}`,
      capabilities: new Map(),
      aliases: new Map(),
    },
    modelGateway: {
      url: "https://gateway.invalid",
      apiKey: "gateway-key",
      apiKeyHeader: "api-key",
      models: {
        "claude-opus-5": "finny-pinned",
        "claude-sonnet-5": "forbidden-override",
      },
    },
  });
  const attempts = [
    harness.models.shouldRespond!({
      session: { id: "finny-model-test" } as HarnessTurnInput["session"],
      message: "hello",
      recentContext: "",
      systemPrompt: "system",
      history: [],
      recordModelCall: () => {},
    }),
    harness.models.compactHistory!({
      session: { id: "finny-model-test" } as HarnessTurnInput["session"],
      history: [],
      recordModelCall: () => {},
    }),
    harness.models.oneShot!("system", "prompt"),
    harness.models.judge!("system", "prompt"),
    harness.models.screenSecurity!({
      payload: "payload",
      modelId: "claude-sonnet-5",
      signal: new AbortController().signal,
      recordModelCall: () => {},
    }),
    harness.models.generateTitle!("User: title this"),
    harness.models.summarizeApproval!("command", "reason"),
  ];

  await Promise.allSettled(attempts);

  assert.equal(harness.models.pickAckEmoji, undefined);
  assert.equal(models.length, attempts.length);
  assert.deepEqual(new Set(models), new Set(["finny-pinned"]));
});
