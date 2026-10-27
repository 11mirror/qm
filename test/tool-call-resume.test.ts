import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator, type OrchestratorInput } from "../src/core/orchestrator.ts";
import type { ResumableToolCall } from "../src/core/turn-resume.ts";
import { INTERRUPTED_TOOL_RESULT } from "../src/harness/context-compaction.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createModelGateway } from "../src/model/model-gateway.ts";
import { defineHarness, type HarnessTurnInput } from "../src/harness/harness.ts";
import { resumeInterruptedToolCall, type BridgedTool } from "../src/harness/harness-shared.ts";
import { createAgentTools, type ToolContextRef } from "../src/harness/agent-tools.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { recordingOutbound } from "./support/recording-outbound.ts";
import type { ToolContext } from "../src/tools/primitives.ts";
import { scopeId, type Conversation, type Principal } from "../src/types.ts";
import { storedItem, type Item, type NewItem } from "../src/sessions/items.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresRateLimiter } from "../src/ratelimit/postgres-rate-limiter.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testConfigStore, testDatabaseUrl, testDeployBackings } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";

const ORG = "default-org";
const actor: Principal = { id: "U1", type: "internal" };
const conversation: Conversation = { kind: "dm", threadRef: "web:U1:resume", audience: [actor] };
const personal = scopeId("personal", "U1");
const ASK = "what did we decide about the budget?";

function historyToolContext(calls: string[]): ToolContext {
  return {
    async history(q: string) {
      calls.push(q);
      return [`UserMessage#3: the budget doc is in shared/q2.md (${q})`];
    },
  } as unknown as ToolContext;
}

function turnFor(
  history: Item[],
  call: ResumableToolCall | undefined,
  sink: NewItem[],
  tools: ToolContext,
): HarnessTurnInput {
  let seq = history.length + 10;
  return {
    session: { id: "s1" } as HarnessTurnInput["session"],
    input: "(system note: resumed)",
    systemPrompt: "BASE",
    history,
    tools,
    scopeLabel: personal,
    orgScopeId: scopeId("org", ORG),
    emit: async (item) => {
      sink.push(item);
      const at = seq++;
      return storedItem(item, { sessionId: "s1", seq: at, createdAt: 1000 + at });
    },
    recordModelCall: () => {},
    ...(call ? { resumeToolCall: call } : {}),
  };
}

const danglingCall: Item = storedItem(
  {
    kind: "ToolCall",
    tool: "history",
    callId: "c-budget",
    body: { query: "budget", retrySafe: true, rerun: { tool: "history", input: { query: "budget" } } },
  },
  { sessionId: "s1", seq: 2, createdAt: 2 },
);

test("resumeInterruptedToolCall re-runs the recorded input exactly once and records only the result", async () => {
  const queries: string[] = [];
  const sink: NewItem[] = [];
  const tools = historyToolContext(queries);
  const turn = turnFor(
    [danglingCall],
    { callId: "c-budget", tool: "history", input: { query: "budget" } },
    sink,
    tools,
  );
  const ref: ToolContextRef = { current: tools, emit: turn.emit, scopeLabel: personal, orgScopeId: turn.orgScopeId };

  const resumed = await resumeInterruptedToolCall(turn, ref, createAgentTools(ref, {}) as unknown as BridgedTool[]);

  assert.deepEqual(queries, ["budget"], "the tool body ran exactly once with the stripped input");
  assert.deepEqual(
    sink.map((e) => e.kind),
    ["ToolResult"],
    "the dangling ToolCall item is not re-recorded; only its result lands",
  );
  const result = sink[0]!;
  assert.equal(result.callId, "c-budget");
  assert.equal(result.isError, false);
  assert.match(result.text ?? "", /shared\/q2\.md/);
  assert.ok(resumed);
  assert.equal(resumed.length, 2, "the harness continues from history that now carries the result");
  assert.equal(resumed[1]!.kind, "ToolResult");
  assert.equal(resumed[1]!.callId, "c-budget");
  assert.equal(resumed[1]!.isError, false);
  assert.match(resumed[1]!.text ?? "", /shared\/q2\.md/);
  assert.equal(ref.emit, turn.emit, "the emit hook is restored after the re-run");
});

test("resumeInterruptedToolCall does nothing without a call to resume", async () => {
  const queries: string[] = [];
  const sink: NewItem[] = [];
  const tools = historyToolContext(queries);
  const idle = turnFor([danglingCall], undefined, sink, tools);
  const ref: ToolContextRef = { current: tools, emit: idle.emit, scopeLabel: personal };
  assert.equal(await resumeInterruptedToolCall(idle, ref, createAgentTools(ref, {}) as unknown as BridgedTool[]), null);
  assert.deepEqual(queries, []);
  assert.deepEqual(sink, []);
});

test("when the tool is unavailable on the retried turn the call is closed as interrupted instead of left dangling", async () => {
  const queries: string[] = [];
  const sink: NewItem[] = [];
  const tools = historyToolContext(queries);
  const missing = turnFor([danglingCall], { callId: "c-x", tool: "no_such_tool", input: {} }, sink, tools);
  const ref: ToolContextRef = { current: tools, emit: missing.emit, scopeLabel: personal };
  const resumed = await resumeInterruptedToolCall(missing, ref, createAgentTools(ref, {}) as unknown as BridgedTool[]);
  assert.ok(resumed);
  assert.equal(resumed.at(-1)!.isError, true);
  assert.equal(resumed.at(-1)!.text, INTERRUPTED_TOOL_RESULT);
  assert.deepEqual(
    sink.map((e) => [e.kind, e.text]),
    [["ToolResult", INTERRUPTED_TOOL_RESULT]],
  );
  assert.equal(sink[0]!.body?.interrupted, true, "the ledger carries the meaning");
  assert.deepEqual(queries, []);
});

test("a cancelled turn does not re-run anything and closes the call as interrupted", async () => {
  const queries: string[] = [];
  const sink: NewItem[] = [];
  const tools = historyToolContext(queries);
  const turn = turnFor(
    [danglingCall],
    { callId: "c-budget", tool: "history", input: { query: "budget" } },
    sink,
    tools,
  );
  turn.cancel = AbortSignal.abort();
  const ref: ToolContextRef = { current: tools, emit: turn.emit, scopeLabel: personal };
  const resumed = await resumeInterruptedToolCall(turn, ref, createAgentTools(ref, {}) as unknown as BridgedTool[]);
  assert.equal(resumed?.at(-1)?.isError, true);
  assert.deepEqual(queries, []);
  assert.equal(sink.length, 1);
  assert.equal(ref.abortSignal, undefined, "the cancel signal is only borrowed for the re-run");
});

test("a tool that throws during the re-run still records an error result so the model sees a closed call", async () => {
  const sink: NewItem[] = [];
  const tools = {
    async history() {
      throw new Error("transcript index offline");
    },
  } as unknown as ToolContext;
  const turn = turnFor(
    [danglingCall],
    { callId: "c-budget", tool: "history", input: { query: "budget" } },
    sink,
    tools,
  );
  const ref: ToolContextRef = { current: tools, emit: turn.emit, scopeLabel: personal };
  const resumed = await resumeInterruptedToolCall(turn, ref, createAgentTools(ref, {}) as unknown as BridgedTool[]);
  assert.ok(resumed);
  assert.equal(resumed.at(-1)!.isError, true);
  assert.match(resumed.at(-1)!.text ?? "", /transcript index offline/);
  assert.deepEqual(
    sink.map((e) => [e.kind, e.isError]),
    [["ToolResult", true]],
  );
});

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("the resume tests must not provision a sandbox");
  };
  return {
    profile: { backend: "fake", writablePersistence: "resident_disk", processSessions: false },
    provision: unreached as never,
    run: unreached as never,
    readFile: unreached as never,
    writeFile: unreached as never,
    writeFileBytes: unreached as never,
    readFileBytes: unreached as never,
    listDir: unreached as never,
    removeDir: unreached as never,
    teardown: unreached as never,
  };
}

function buildScenario() {
  const databaseUrl = testDatabaseUrl();
  const received: Array<{ input: string; resumeToolCall?: ResumableToolCall; historyTypes: string[] }> = [];
  const harness = defineHarness({
    async runTurn(turn) {
      received.push({
        input: turn.input,
        ...(turn.resumeToolCall ? { resumeToolCall: turn.resumeToolCall } : {}),
        historyTypes: turn.history.map((e) => e.kind),
      });
      if (turn.resumeToolCall) {
        await turn.emit({
          kind: "ToolResult",
          tool: "history",
          callId: turn.resumeToolCall.callId,
          isError: false,
          text: "- found it",
        });
      }
      await turn.emit({ kind: "UserMessage", text: turn.input });
      const reply = "we kept the Q2 budget flat";
      await turn.emit({ kind: "AgentMessage", text: reply });
      return { reply, modelCalls: 1 };
    },
    async screenSecurity() {
      return { decision: "auto" as const };
    },
  });
  const sessions = createPostgresSessionStore(databaseUrl);
  const { runs } = createMemoryRunStore();
  const acl = createAclStore(createPostgresGrantStore(databaseUrl));
  const auditLog = createPostgresAuditLog(databaseUrl);
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "tool-call-resume-")));
  const orchestrator = createOrchestrator({
    ...singleProcessDeps(),
    identity: createIdentityService(databaseUrl),
    resolution: createResolutionService(ORG, testConfigStore(ORG), acl),
    sessions,
    runs,
    workspace,
    files: createPostgresFileArtifactStore(databaseUrl, createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createPostgresRateLimiter(databaseUrl, { maxPerWindow: 100, windowMs: 60_000 }),
    harness,
    memory: createPostgresMemoryService(databaseUrl),
    deploy: createDeployService({
      ...singleProcessDeps(),
      deployStore: createDeployStore(testDeployBackings()),
      provider: createDockerDeployProvider(),
      deployDir: join(tmpdir(), "tool-call-resume-deploy"),
      auditLog,
      acl,
    }),
    acl,
    outbound: recordingOutbound(),
  });
  const input = (text: string, extra: Partial<OrchestratorInput> = {}): OrchestratorInput => ({
    surface: "web",
    actor,
    conversation,
    origin: { kind: "human" },
    text,
    ...extra,
  });
  return { orchestrator, sessions, runs, received, input };
}

async function seedDeadAttempt(
  sessions: ReturnType<typeof buildScenario>["sessions"],
  call: NewItem,
): Promise<{ sessionId: string; userSeq: number }> {
  const session = await sessions.getOrCreateByThread(conversation.threadRef, "dm", personal);
  const { lease } = await sessions.acquireLease(session.id);
  try {
    const user = await sessions.append(lease!, { kind: "UserMessage", text: ASK });
    await sessions.append(lease!, call);
    return { sessionId: session.id, userSeq: user.seq };
  } finally {
    await sessions.releaseLease(lease!);
  }
}

test("a retry whose dangling call was marked retry-safe re-runs it silently instead of warning about an unknown outcome", async () => {
  const { orchestrator, sessions, runs, received, input } = buildScenario();
  const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
  const { sessionId, userSeq } = await seedDeadAttempt(sessions, {
    kind: "ToolCall",
    tool: "history",
    callId: "c-budget",
    body: { query: "budget", retrySafe: true, rerun: { tool: "history", input: { query: "budget" } } },
  });
  await runs.noteTurnUserSeq(run.id, userSeq);

  const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
  assert.equal(retry.status, "ok");
  assert.equal(received.length, 1);
  const turn = received[0]!;
  assert.deepEqual(turn.resumeToolCall, { callId: "c-budget", tool: "history", input: { query: "budget" } });
  assert.equal(turn.input, "", "the request is not re-sent");

  const items = await sessions.getItems(sessionId);
  const kinds = items.map((e) => e.kind);
  assert.deepEqual(kinds, ["UserMessage", "ToolCall", "ToolResult", "UserMessage", "AgentMessage"]);
});

for (const [label, payload] of [
  ["unsafe", { kind: "ToolCall", tool: "history", callId: "c-budget", body: { query: "budget", retrySafe: false } }],
  ["unmarked", { kind: "ToolCall", tool: "history", callId: "c-budget", body: { query: "budget" } }],
] as const) {
  test(`a retry whose dangling call is ${label} records what happened as its result and does not re-run it`, async () => {
    const { orchestrator, sessions, runs, received, input } = buildScenario();
    const run = (await runs.enqueue({ sessionId: conversation.threadRef, request: input(ASK) })).run;
    const { sessionId, userSeq } = await seedDeadAttempt(sessions, payload);
    await runs.noteTurnUserSeq(run.id, userSeq);

    const retry = await orchestrator.handleTurn(input(ASK, { runId: run.id, attempt: 2 }));
    assert.equal(retry.status, "ok");
    assert.equal(received.length, 1);
    const turn = received[0]!;
    assert.equal(turn.resumeToolCall, undefined);
    assert.equal(turn.input, "", "the request is not re-sent");
    const items = await sessions.getItems(sessionId);
    assert.deepEqual(
      items.map((e) => e.kind),
      ["UserMessage", "ToolCall", "ToolResult", "UserMessage", "AgentMessage"],
      "nothing is re-run; the call gets a recorded result",
    );
    const result = items[2]!;
    assert.equal(result.callId, "c-budget");
    assert.equal(result.isError, true);
    assert.match(result.text ?? "", /^\[system\] This call was interrupted; its outcome wasn't recorded\./);
    assert.ok(turn.historyTypes.includes("ToolResult"), "the model sees the recorded result");
  });
}
