import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgentTools, type ToolContextRef } from "../src/harness/agent-tools.ts";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { modelRequestOverrides } from "../src/model/pi-models.ts";

const nativeProbe = (name = "finance_probe") =>
  defineTool({
    name,
    label: name,
    description: "Read a finance probe.",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_callId, params) {
      return { content: [{ type: "text" as const, text: `result:${params.query}` }], details: {} };
    },
  });

test("Pi resolves native tools from the current turn before starting the model", async () => {
  const seen: Array<{ surfaceName?: string; scopeLabel?: string }> = [];
  const harness = createPiHarness({
    nativeTools(turn, ref) {
      seen.push({ surfaceName: turn.surfaceName, scopeLabel: ref.scopeLabel });
      return [nativeProbe()];
    },
  });
  const turn: HarnessTurnInput = {
    session: { id: "native-factory" } as HarnessTurnInput["session"],
    input: "check finance",
    systemPrompt: "BASE",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    surfaceName: "web",
    scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
    emit: async (entry) => ({ ...entry, seq: 1, createdAt: 0 }) as Awaited<ReturnType<HarnessTurnInput["emit"]>>,
    recordModelCall: () => {},
  };

  await harness.turns.runTurn(turn).catch(() => undefined);

  assert.deepEqual(seen, [{ surfaceName: "web", scopeLabel: "personal:tester" }]);
});

test("Pi exposes only explicitly allowed native tools and rejects a model's generic fallback", async (t) => {
  const modelId = "gpt-5.4";
  const requests: Array<{
    tools?: Array<{ name?: string }>;
    input?: Array<{ type?: string; output?: string }>;
  }> = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as (typeof requests)[number];
    requests.push(body);

    const attemptedGenericFallback = requests.length === 1;
    const item = attemptedGenericFallback
      ? {
          id: "fc_generic",
          type: "function_call",
          call_id: "call_generic",
          name: "execute",
          arguments: JSON.stringify({ command: "cat /tmp/ledger" }),
          status: "completed",
        }
      : {
          id: "msg_done",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "generic fallback unavailable", annotations: [] }],
        };
    const send = (type: string, data: object) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    response.writeHead(200, { "content-type": "text/event-stream" });
    send("response.created", {
      response: { id: `resp_${requests.length}`, model: modelId, status: "in_progress", output: [] },
    });
    send("response.output_item.added", { output_index: 0, item });
    send("response.output_item.done", { output_index: 0, item });
    send("response.completed", {
      response: {
        id: `resp_${requests.length}`,
        model: modelId,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const address = server.address();
  assert(address && typeof address !== "string");

  const modelGateway = {
    url: `http://127.0.0.1:${address.port}`,
    apiKey: "test-key",
    apiKeyHeader: "api-key",
    models: { [modelId]: modelRequestOverrides(modelId)?.model ?? modelId },
  };
  const harness = createPiHarness({
    defaultModelId: modelId,
    allowedToolNames: ["finance_probe"],
    nativeTools: [nativeProbe()],
    modelGateway,
  });
  t.after(() => harness.turns.close?.());
  let seq = 0;
  const result = await harness.turns.runTurn({
    session: { id: "native-only-tools" } as HarnessTurnInput["session"],
    input: "fetch finance data",
    systemPrompt: "Use finance_probe. Generic fallback tools are forbidden.",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    clientTools: [
      { name: "browser_probe", description: "generic client probe", inputSchema: { type: "object", properties: {} } },
    ],
    mcpTools: [
      {
        name: "remote_probe",
        serverId: "remote",
        serverName: "Remote",
        remoteName: "probe",
        description: "generic MCP probe",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
        needsApproval: false,
      },
    ],
    surfaceTools: true,
    surfaceName: "web",
    scopeLabel: "personal:test",
    orgScopeId: "org:test",
    emit: async (entry) => ({ ...entry, seq: seq++, createdAt: Date.now() }) as never,
    recordModelCall: () => {},
    cancel: AbortSignal.timeout(10_000),
  });

  assert.equal(result.reply, "generic fallback unavailable");
  assert.deepEqual(
    requests[0]?.tools?.map((tool) => tool.name),
    ["finance_probe"],
  );
  const fallbackResult = requests[1]?.input?.find((item) => item.type === "function_call_output")?.output ?? "";
  assert.match(fallbackResult, /not found|unknown|unavailable/i);

  const defaultHarness = createPiHarness({ defaultModelId: modelId, nativeTools: [nativeProbe()], modelGateway });
  t.after(() => defaultHarness.turns.close?.());
  await defaultHarness.turns.runTurn({
    session: { id: "default-tool-surface" } as HarnessTurnInput["session"],
    input: "fetch finance data",
    systemPrompt: "Reply briefly.",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "personal:test",
    orgScopeId: "org:test",
    emit: async (entry) => ({ ...entry, seq: seq++, createdAt: Date.now() }) as never,
    recordModelCall: () => {},
    cancel: AbortSignal.timeout(10_000),
  });
  const defaultNames = requests[2]?.tools?.map((tool) => tool.name) ?? [];
  assert.ok(defaultNames.includes("execute"));
  assert.ok(defaultNames.includes("skills"));
  assert.ok(defaultNames.includes("finance_probe"));
});

test("native tools use Pi approval, retry-safety, and durable call/result recording wrappers", async () => {
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let executions = 0;
  const raw = {
    ...nativeProbe(),
    needsApproval: true,
    async execute(_callId: string, params: { query: string }) {
      executions += 1;
      return { content: [{ type: "text" as const, text: `result:${params.query}` }], details: {} };
    },
  };
  const ref: ToolContextRef = {
    current: {} as ToolContextRef["current"],
    scopeLabel: "personal:tester",
    toolApprovalGate: () => true,
    emit: (entry) => {
      emitted.push(entry as (typeof emitted)[number]);
    },
  };
  const tool = createAgentTools(ref, { nativeTools: [raw] }).find((candidate) => candidate.name === raw.name);
  assert.ok(tool);
  assert.ok("retrySafe" in (tool.parameters as { properties: Record<string, unknown> }).properties);

  const result = await tool.execute(
    "native-call",
    { query: "cash", retrySafe: true },
    undefined,
    undefined,
    {} as never,
  );

  assert.equal(executions, 1);
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.text, "result:cash");
  assert.deepEqual(
    emitted.map((entry) => [entry.type, entry.payload.tool, entry.payload.callId]),
    [
      ["tool_call", "finance_probe", "native-call"],
      ["tool_result", "finance_probe", "native-call"],
    ],
  );
  assert.equal(emitted[0]?.payload.retrySafe, true);
});

test("native tool approval blocks execution before the native implementation runs", async () => {
  let executions = 0;
  const raw = {
    ...nativeProbe(),
    needsApproval: true,
    async execute() {
      executions += 1;
      return { content: [{ type: "text" as const, text: "should not run" }], details: {} };
    },
  };
  const ref: ToolContextRef = {
    current: {} as ToolContextRef["current"],
    scopeLabel: "personal:tester",
    toolApprovalGate: () => false,
    pendingApprovals: [],
  };
  const tool = createAgentTools(ref, { nativeTools: [raw] }).find((candidate) => candidate.name === raw.name)!;

  const result = await tool.execute("native-blocked", { query: "cash" }, undefined, undefined, {} as never);

  assert.equal(executions, 0);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /needs human approval/);
  assert.equal(ref.pausedOnApproval, true);
});

test("native tools can replace raw arguments and results with redacted durable summaries", async () => {
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const secret = "sensitive-finance-query";
  const raw = Object.assign(nativeProbe(), {
    async execute() {
      return { content: [{ type: "text" as const, text: "redacted result" }], details: {} };
    },
    recordCallSummary: (params: unknown) => ({
      tool: "finance_probe",
      action: typeof params === "object" && params !== null && "action" in params ? params.action : "probe",
    }),
    recordResultSummary: () => ({ tool: "finance_probe", evidenceDigest: "sha256:redacted" }),
  });
  const ref: ToolContextRef = {
    current: {} as ToolContextRef["current"],
    scopeLabel: "personal:tester",
    emit: (entry) => {
      emitted.push(entry as (typeof emitted)[number]);
    },
  };
  const tool = createAgentTools(ref, { nativeTools: [raw] }).find((candidate) => candidate.name === raw.name)!;

  await tool.execute("redacted-call", { query: secret, action: "probe" }, undefined, undefined, {} as never);

  const persisted = JSON.stringify(emitted);
  assert.equal(persisted.includes(secret), false);
  assert.equal(emitted[0]?.payload.action, "probe");
  assert.equal(emitted[1]?.payload.evidenceDigest, "sha256:redacted");
});

test("native tool error results remain errors in durable evidence", async () => {
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const raw = {
    ...nativeProbe(),
    async execute() {
      return { content: [{ type: "text" as const, text: "[error] unavailable" }], details: {}, isError: true };
    },
  };
  const ref: ToolContextRef = {
    current: {} as ToolContextRef["current"],
    scopeLabel: "personal:tester",
    emit: (entry) => {
      emitted.push(entry as (typeof emitted)[number]);
    },
  };
  const tool = createAgentTools(ref, { nativeTools: [raw] }).find((candidate) => candidate.name === raw.name)!;

  const result = await tool.execute("native-error", { query: "cash" }, undefined, undefined, {} as never);

  assert.equal((result as { isError?: boolean }).isError, true);
  assert.equal(emitted[1]?.payload.isError, true);
});

test("native tool names cannot collide with any existing tool source", () => {
  const clientTool = { name: "page_probe", description: "Page probe", inputSchema: { type: "object", properties: {} } };
  const mcpTool = {
    name: "ledger_probe",
    serverId: "ledger",
    serverName: "Ledger",
    remoteName: "probe",
    description: "Ledger probe",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    needsApproval: false,
  };
  const cases = [
    { label: "built-in", options: { nativeTools: [nativeProbe("memory")] } },
    { label: "client", options: { clientTools: [clientTool], nativeTools: [nativeProbe("page_probe")] } },
    { label: "MCP", options: { mcpTools: [mcpTool], nativeTools: [nativeProbe("ledger_probe")] } },
    { label: "another native", options: { nativeTools: [nativeProbe("duplicate"), nativeProbe("duplicate")] } },
  ];

  for (const { label, options } of cases) {
    assert.throws(
      () => createAgentTools({ current: {} as ToolContextRef["current"] }, options),
      new RegExp(`native tool name collision: .*${label}`, "i"),
      label,
    );
  }
});
