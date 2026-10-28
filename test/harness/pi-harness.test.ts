import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { loadConfig } from "../../src/config.ts";
import { createPiHarness, piHarnessConfigOptions } from "../../src/harness/pi-harness.ts";
import { codexSubscriptionModelId, getRequiredModel, modelRequestOverrides } from "../../src/model/pi-models.ts";
import type { HarnessTurnInput } from "../../src/harness/harness.ts";
import type { ToolContext } from "../../src/tools/primitives.ts";
import type { ScopeId } from "../../src/types.ts";
import { storedItem, type Item, type NewItem } from "../../src/sessions/items.ts";
import { createServer } from "node:http";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countTokens } from "../../src/util/tokens.ts";
import { stableCwd } from "../../src/harness/pi-turn-session.ts";
import { createGoalRecord, type GoalRecord } from "../../src/harness/goal.ts";
import { ProviderTurnError } from "../../src/core/turn-error.ts";
import { sse, textReplyEvents } from "../support/anthropic-sse.ts";

const subscriptionToken = `e30.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "company-account" } }),
).toString("base64url")}.test`;

function recordFetch(t: TestContext, headers: Headers[] = []): string[] {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input instanceof Request ? input.url : input));
    headers.push(new Headers(input instanceof Request ? input.headers : init?.headers));
    return new Response(JSON.stringify({ error: { message: "offline test response" } }), { status: 400 });
  });
  return urls;
}

const companyHarness = (keys: Record<string, string>) =>
  createPiHarness({
    defaultModelId: "gpt-5.6-sol",
    resolveProviderKeys: async () => keys,
    companyModelId: codexSubscriptionModelId,
  });

test("company utility calls on a plain OpenAI id are served by the ChatGPT subscription, never the metered key", async (t) => {
  const urls = recordFetch(t);
  await assert.rejects(
    async () =>
      companyHarness({ openai: "sk-metered", "openai-codex": subscriptionToken }).models.oneShot?.("system", "hi"),
    /offline test response/,
  );
  assert.ok(
    urls.some((url) => url.startsWith("https://chatgpt.com/backend-api/")),
    JSON.stringify(urls),
  );
  assert.ok(!urls.some((url) => new URL(url).hostname === "api.openai.com"), JSON.stringify(urls));
});

test("an unavailable company ChatGPT token fails closed instead of falling back to the metered key", async (t) => {
  const urls = recordFetch(t);
  assert.equal(await companyHarness({ openai: "sk-metered" }).models.oneShot?.("system", "hi"), undefined);
  assert.deepEqual(urls, []);
});

test("without a company subscription a plain OpenAI id stays metered", async (t) => {
  const urls = recordFetch(t);
  const harness = createPiHarness({
    defaultModelId: "gpt-5.6-sol",
    resolveProviderKeys: async () => ({ openai: "sk-metered" }),
  });
  await assert.rejects(async () => harness.models.oneShot?.("system", "hi"), /offline test response/);
  assert.ok(
    urls.some((url) => new URL(url).hostname === "api.openai.com"),
    JSON.stringify(urls),
  );
});

test("a subscription-only deployment's default utility model is served by the ChatGPT subscription", async (t) => {
  const urls = recordFetch(t);
  const config = { ...loadConfig({}), codexAuthCredential: "cred-1" };
  const harness = createPiHarness({
    ...piHarnessConfigOptions(config),
    resolveProviderKeys: async () => ({ "openai-codex": subscriptionToken }),
    companyModelId: codexSubscriptionModelId,
  });
  await assert.rejects(async () => harness.models.oneShot?.("system", "hi"), /offline test response/);
  assert.ok(
    urls.some((url) => url.startsWith("https://chatgpt.com/backend-api/")),
    JSON.stringify(urls),
  );
});

test("a Claude subscription token as Pi's Anthropic key is sent as OAuth bearer auth", async (t) => {
  const headers: Headers[] = [];
  const urls = recordFetch(t, headers);
  const harness = createPiHarness({
    defaultModelId: "claude-sonnet-5",
    resolveProviderKeys: async () => ({ anthropic: "sk-ant-oat01-company" }),
  });
  await assert.rejects(async () => harness.models.oneShot?.("system", "hi"), /offline test response/);
  const index = urls.findIndex((url) => new URL(url).hostname === "api.anthropic.com");
  assert.ok(index >= 0, JSON.stringify(urls));
  assert.equal(headers[index]!.get("authorization"), "Bearer sk-ant-oat01-company");
  assert.equal(headers[index]!.get("x-api-key"), null);
  assert.match(headers[index]!.get("anthropic-beta") ?? "", /oauth-2025-04-20/);
});

const scope = "personal:tester" as ScopeId;
const NOTE = "(system note: your previous attempt at the request above was paused mid-turn and has resumed.)";

test("the pi harness re-runs a retry-safe interrupted call before the model sees the resumed turn", async () => {
  const harness = createPiHarness({ resolveProviderKeys: async () => ({ anthropic: "sk-test" }) });
  const entries: Item[] = [];
  const queries: string[] = [];
  const requests: Array<Array<{ role: string; content: Array<Record<string, unknown>> | string }>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: (typeof requests)[number] };
    requests.push(body.messages ?? []);
    return sse(textReplyEvents("we kept the Q2 budget flat"));
  }) as typeof globalThis.fetch;
  const history: Item[] = [
    storedItem({ kind: "UserMessage", text: "what about the budget?" }, { sessionId: "s1", seq: 1, createdAt: 1 }),
    storedItem(
      {
        kind: "ToolCall",
        tool: "history",
        callId: "c-budget",
        body: { query: "budget", retrySafe: true, rerun: { tool: "history", input: { query: "budget" } } },
      },
      { sessionId: "s1", seq: 2, createdAt: 2 },
    ),
  ];
  let seq = 3;
  const turn: HarnessTurnInput = {
    session: { id: "s1" } as HarnessTurnInput["session"],
    input: NOTE,
    systemPrompt: "BASE",
    history,
    tools: {
      async history(q: string) {
        queries.push(q);
        return ["UserMessage#1: the budget doc is in shared/q2.md"];
      },
    } as unknown as ToolContext,
    scopeLabel: scope,
    orgScopeId: "org:test" as ScopeId,
    resumeToolCall: { callId: "c-budget", tool: "history", input: { query: "budget" } },
    emit: async (item: NewItem) => {
      const appended = storedItem(item, { sessionId: "s1", seq: seq++, createdAt: Date.now() });
      entries.push(appended);
      return appended;
    },
    recordModelCall: () => {},
  };
  try {
    const result = await harness.turns.runTurn(turn);
    assert.equal(result.reply, "we kept the Q2 budget flat");
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(queries, ["budget"], "the interrupted call ran exactly once");
  assert.deepEqual(
    entries.map((e) => e.kind),
    ["ToolResult", "UserMessage", "AgentMessage"],
    "the result closes the dangling call before this attempt's note is recorded; no second tool call",
  );
  assert.equal(entries[0]!.callId, "c-budget");

  assert.equal(requests.length, 1);
  const flattened = JSON.stringify(requests[0]);
  assert.ok(!flattened.includes("[interrupted"), "the model never sees an interrupted placeholder");
  const resultAt = flattened.indexOf("shared/q2.md");
  const noteAt = flattened.indexOf("paused mid-turn and has resumed");
  assert.ok(resultAt > 0, "the re-run result reaches the model");
  assert.ok(noteAt > resultAt, "the real tool result precedes the resume note in the model's context");
  const toolResults = requests[0]!.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((block) => block.type === "tool_result") : [],
  );
  assert.equal(toolResults.length, 1, "exactly one tool_result reaches the provider for the retried call");
});

for (const [modelId, upper, allowed, off, minimal] of [
  ["gpt-5.4", "xhigh", ["none", "low", "medium", "high", "xhigh"], "none", "low"],
  ["gpt-5", "high", ["minimal", "low", "medium", "high"], "minimal", "minimal"],
  ["gpt-6.1-sol-ultrafast", "max", ["low", "medium", "high", "xhigh", "max"], "low", "low"],
  ["gpt-6.1-sol", "max", ["low", "medium", "high", "xhigh", "max"], "low", "low"],
  ["gpt-5.6-sol", "max", ["none", "low", "medium", "high", "xhigh", "max"], "none", "low"],
  ["gpt-5.6-terra", "max", ["none", "low", "medium", "high", "xhigh", "max"], "none", "low"],
  ["gpt-5.6-luna", "max", ["none", "low", "medium", "high", "xhigh", "max"], "none", "low"],
  ["gpt-6.1-terra", "max", ["none", "low", "medium", "high", "xhigh", "max"], "none", "low"],
  ["gpt-6-sol", "max", ["none", "low", "medium", "high", "xhigh", "max"], "none", "low"],
  ["gpt-6-luna", "max", ["none", "low", "medium", "high", "xhigh", "max"], "none", "low"],
  ["gpt-6-astra", "max", ["low", "medium", "high", "xhigh", "max"], "low", "low"],
  ["gpt-6-astra-ultrafast", "max", ["low", "medium", "high", "xhigh", "max"], "low", "low"],
] as const) {
  test(`Pi sends supported reasoning through HTTP for ${modelId}`, async (t) => {
    const bodies: Array<{
      reasoning?: { effort?: string };
      include?: string[];
      input: Array<Record<string, unknown>>;
    }> = [];
    let sendTool = false;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw);
      bodies.push(body);
      if (body.reasoning && !(allowed as readonly string[]).includes(body.reasoning?.effort)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unsupported reasoning.effort", type: "invalid_request_error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (sendTool) {
        sendTool = false;
        const reasoning = {
          id: "rs_native",
          type: "reasoning",
          summary: [],
          ...(body.include?.includes("reasoning.encrypted_content")
            ? { encrypted_content: "encrypted-native-reasoning" }
            : {}),
        };
        const call = {
          id: "fc_native",
          type: "function_call",
          call_id: "call_native",
          name: "attach",
          arguments: JSON.stringify({ files: ["probe.txt"] }),
          status: "completed",
        };
        for (const event of [
          {
            type: "response.created",
            response: { id: "resp_tool", model: modelId, status: "in_progress", output: [] },
          },
          { type: "response.output_item.added", output_index: 0, item: reasoning },
          { type: "response.output_item.done", output_index: 0, item: reasoning },
          { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
          { type: "response.output_item.done", output_index: 1, item: call },
          {
            type: "response.completed",
            response: {
              id: "resp_tool",
              model: modelId,
              status: "completed",
              output: [reasoning, call],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ])
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
        return;
      }
      for (const event of okMessageEvents(modelId))
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
    const address = server.address();
    assert(address && typeof address !== "string");
    const originalMap = structuredClone(getRequiredModel(modelId).thinkingLevelMap);
    const harness = createPiHarness({
      defaultModelId: modelId,
      modelGateway: {
        url: `http://127.0.0.1:${address.port}`,
        apiKey: "test-key",
        apiKeyHeader: "api-key",
        models: { [modelId]: modelRequestOverrides(modelId)?.model ?? modelId },
      },
    });
    // Repeat turns in the same conversation with different effort selections.
    for (const [effortLevel, expected] of [
      ["max", upper],
      ["medium", "medium"],
      ["low", "low"],
      ["high", "high"],
      ["minimal", minimal],
      ["off", off],
      ["xhigh", (allowed as readonly string[]).includes("xhigh") ? "xhigh" : upper],
      ["auto", "medium"],
      ["default", undefined],
    ]) {
      await t.test(effortLevel!, async () => {
        let seq = 0;
        sendTool = effortLevel === "default";
        const result = await harness.turns.runTurn({
          session: { id: `effort-${modelId}` } as HarnessTurnInput["session"],
          input: "hello",
          systemPrompt: "Reply ok.",
          history: [],
          tools: { attach: async () => ({ ok: true, files: [], staged: 0 }) } as unknown as HarnessTurnInput["tools"],
          scopeLabel: "personal:test",
          orgScopeId: "org:test",
          runtime: { effortLevel },
          emit: async (entry) => ({ ...entry, seq: seq++, createdAt: Date.now() }) as never,
          recordModelCall: () => {},
          cancel: AbortSignal.timeout(10_000),
        });
        assert.equal(result.reply, "ok");
        assert.equal(bodies.at(-1)?.reasoning?.effort, expected);
        if (effortLevel === "default") {
          assert.ok(bodies.at(-1)?.include?.includes("reasoning.encrypted_content"));
          assert.equal(
            bodies.at(-1)?.input.find((item) => item.type === "reasoning")?.encrypted_content,
            "encrypted-native-reasoning",
          );
          assert.ok(bodies.at(-1)?.input.some((item) => item.type === "function_call_output"));
        }
      });
    }
    assert.deepEqual(
      getRequiredModel(modelId).thinkingLevelMap,
      originalMap,
      "must not widen the model's supported efforts",
    );
  });
}

function okMessageEvents(modelId: string) {
  const message = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "ok", annotations: [] }],
  };
  return [
    { type: "response.created", response: { id: "resp_test", model: modelId, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "resp_test",
        model: modelId,
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
}

function countTempDirs(prefix: string): number {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)).length;
}

function recordingTurn(
  systemPrompt: string,
  recorded: Array<{ model: string; inputTokens: number; entryCount: number }>,
  sessionId: string,
): HarnessTurnInput {
  return {
    session: { id: sessionId } as HarnessTurnInput["session"],
    input: "hi",
    systemPrompt,
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "scope" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
    emit: async (entry) => ({ ...entry, seq: 1, createdAt: 0 }) as Awaited<ReturnType<HarnessTurnInput["emit"]>>,
    recordModelCall: (rec) => recorded.push(rec),
  };
}

async function runIgnoringPromptError(
  harness: ReturnType<typeof createPiHarness>,
  turn: HarnessTurnInput,
): Promise<void> {
  try {
    await harness.turns.runTurn(turn);
  } catch {
    return;
  }
}

test("every turn composes the freshly resolved system prompt", async () => {
  const harness = createPiHarness();
  const recorded: Array<{ model: string; inputTokens: number; entryCount: number }> = [];
  const first = "BASE\n\n## What you remember\nA";
  const second = "BASE\n\n## What you remember\nBBBBBBBBBBBBBBBBBBBB";

  await runIgnoringPromptError(harness, recordingTurn(first, recorded, "fresh-prompt"));
  await runIgnoringPromptError(harness, recordingTurn(second, recorded, "fresh-prompt"));

  const prompt = "── Wednesday, December 31, 1969 ──\nhi";
  assert.equal(recorded[0]!.inputTokens, countTokens(first) + countTokens(prompt));
  assert.equal(recorded[1]!.inputTokens, countTokens(second) + countTokens(prompt));
});

test("the cwd pi appends to the system prompt is one constant path per harness", () => {
  assert.equal(stableCwd("pi"), join(tmpdir(), "pi-cwd"));
  assert.equal(stableCwd("pi"), stableCwd("pi"));
});

test("each turn removes its agent directory and reuses one constant cwd", async () => {
  const prefix = `pi-turn-${process.pid}`;
  const harness = createPiHarness({ tempDirPrefix: prefix });
  const recorded: Array<{ model: string; inputTokens: number; entryCount: number }> = [];

  await runIgnoringPromptError(harness, recordingTurn("BASE", recorded, "cleanup"));
  await runIgnoringPromptError(harness, recordingTurn("BASE", recorded, "cleanup-2"));

  assert.equal(countTempDirs(`${prefix}-agent-`), 0);
  assert.equal(countTempDirs(`${prefix}-cwd`), 1);
  rmSync(stableCwd(prefix), { recursive: true, force: true });
});

test("a squatted shared cwd falls back to a per-turn cwd that is removed afterwards", async () => {
  const prefix = `pi-squat-${process.pid}`;
  writeFileSync(stableCwd(prefix), "not a directory");
  const harness = createPiHarness({ tempDirPrefix: prefix });
  const recorded: Array<{ model: string; inputTokens: number; entryCount: number }> = [];

  await runIgnoringPromptError(harness, recordingTurn("BASE", recorded, "squat"));

  assert.equal(recorded.length, 1, "the turn still reached the model call");
  assert.equal(countTempDirs(`${prefix}-cwd-`), 0);
  assert.equal(countTempDirs(`${prefix}-agent-`), 0);
  rmSync(stableCwd(prefix), { force: true });
});

test("ack emoji keeps working on a non-Anthropic base model when an Anthropic key is present", async () => {
  const harness = createPiHarness({
    defaultModelId: "gpt-5.6-sol",
    resolveProviderKeys: async () => ({ anthropic: "sk-ant-test" }),
  });
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; model: unknown; thinking: unknown; toolChoice: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(url), model: body.model, thinking: body.thinking, toolChoice: body.tool_choice });
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_ack",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_ack", name: "answer", input: {} },
      },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"emoji":"eyes"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof globalThis.fetch;
  try {
    const picked = await harness.models.pickAckEmoji?.("ship it", ["eyes", "rocket"]);
    assert.equal(picked, "eyes", "the pick still lands even though the base model is OpenAI");
    assert.equal(calls.length, 1, "the Anthropic ack call was actually attempted");
    assert.match(calls[0]!.url, /anthropic/, "it went to the Anthropic API");
    assert.equal(calls[0]!.model, "claude-haiku-5-5", "it used the Anthropic auxiliary, not the OpenAI judge model");
    assert.deepEqual(calls[0]!.thinking, { type: "disabled" }, "the 64-token pick never spends its budget thinking");
    assert.deepEqual(calls[0]!.toolChoice, { type: "tool", name: "answer" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("ack emoji stays home when the deployment has no Anthropic key at all", async () => {
  const harness = createPiHarness({
    defaultModelId: "gpt-5.6-sol",
    resolveProviderKeys: async () => ({ openai: "sk-openai-test" }),
  });
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async () => {
    called += 1;
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    assert.equal(await harness.models.pickAckEmoji?.("ship it", ["eyes"]), undefined);
    assert.equal(called, 0, "no Anthropic call without an Anthropic key");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("model utilities resolve provider credentials for every call", async () => {
  let resolutions = 0;
  const harness = createPiHarness({
    resolveProviderKeys: async () => {
      resolutions += 1;
      return {};
    },
  });

  assert.equal(await harness.models.oneShot?.("system", "first"), undefined);
  assert.equal(await harness.models.oneShot?.("system", "second"), undefined);
  assert.equal(resolutions, 2);
});

test("prior-turn bootstrap reaches the model before the first prompt", async () => {
  const harness = createPiHarness({ resolveProviderKeys: async () => ({ anthropic: "sk-test" }) });
  const bodies: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stop" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  const turn = recordingTurn("BASE", [], "prior-bootstrap");
  turn.priorTurns = [
    { role: "assistant", text: "I opened this thread with the release result" },
    { role: "user", name: "Jordan", text: "tell me more" },
  ];
  try {
    await runIgnoringPromptError(harness, turn);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(bodies.length > 0);
  assert.match(bodies[0]!, /release result/);
  assert.match(bodies[0]!, /tell me more/);
});

const sessionGoals = new Map<string, GoalRecord>();
const savedGoal = (sessionId: string) => sessionGoals.get(sessionId) ?? null;

function goalTurn(sessionId: string, cancel: AbortSignal, entries: Item[]): HarnessTurnInput {
  let seq = 0;
  const goal = createGoalRecord({ objective: "keep researching until done" });
  return {
    session: { id: sessionId } as HarnessTurnInput["session"],
    cancel,
    input: "continue",
    systemPrompt: "BASE",
    history: [],
    goal,
    saveGoal: async (record) => {
      sessionGoals.set(sessionId, structuredClone(record));
    },
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
    emit: async (entry: NewItem) => {
      const item = storedItem(entry, { sessionId, seq: ++seq, createdAt: Date.now() });
      entries.push(item);
      return item;
    },
    recordModelCall: () => {},
  };
}

test("an active goal stops continuing once a model round fails at the provider", async () => {
  const harness = createPiHarness({ resolveProviderKeys: async () => ({ anthropic: "sk-test" }) });
  const controller = new AbortController();
  const entries: Item[] = [];
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    if (requests > 5) controller.abort();
    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "Your credit balance is too low." },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  try {
    const outcome = await harness.turns.runTurn(goalTurn("goal-provider-failure", controller.signal, entries)).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    assert.equal(requests, 1, "a failed round must not be re-prompted by the goal loop");
    assert.ok(
      "error" in outcome && outcome.error instanceof ProviderTurnError && !outcome.error.retryable,
      "the turn fails with the provider error",
    );
    assert.match((outcome as { error: Error }).error.message, /credit balance is too low/);
    assert.equal(savedGoal("goal-provider-failure")?.status, "active", "the goal itself stays active for a later turn");
  } finally {
    globalThis.fetch = realFetch;
  }
});

function textStream(text: string, stopReason = "end_turn"): Response {
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response(
    event("message_start", {
      type: "message_start",
      message: {
        id: "m",
        type: "message",
        role: "assistant",
        content: [],
        model: "x",
        stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }) +
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }) +
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
      event("content_block_stop", { type: "content_block_stop", index: 0 }) +
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason },
        usage: { output_tokens: 3 },
      }) +
      event("message_stop", { type: "message_stop" }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

test("a refused goal round falls back to another model and the goal keeps going", async () => {
  const harness = createPiHarness({
    resolveProviderKeys: async () => ({ anthropic: "sk-test" }),
    resolveFallbackRuntime: () => ({ modelId: "claude-sonnet-5" }),
  });
  const controller = new AbortController();
  const entries: Item[] = [];
  const realFetch = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const model = (JSON.parse(String(init?.body ?? "{}")) as { model: string }).model;
    models.push(model);
    if (models.length >= 5) controller.abort();
    if (models.length >= 2 && model === models[0]) return textStream("", "refusal");
    return textStream(`reply ${models.length}`);
  }) as typeof globalThis.fetch;
  try {
    await harness.turns.runTurn(goalTurn("goal-refusal-fallback", controller.signal, entries)).catch(() => undefined);
    const [primary, refused, fallback, continued] = models;
    assert.equal(refused, primary, "the second round goes to the primary model and is refused");
    assert.notEqual(fallback, primary, "the refused round is answered by a fallback model");
    assert.equal(continued, fallback, "the goal keeps going on the fallback model instead of stopping");
    assert.equal(savedGoal("goal-refusal-fallback")?.status, "active");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("each governor checkpoint sees only the work since the last checkpoint, not the whole session", async () => {
  const harness = createPiHarness({ resolveProviderKeys: async () => ({ anthropic: "sk-test" }) });
  const controller = new AbortController();
  const entries: Item[] = [];
  const realFetch = globalThis.fetch;
  const checkpoints: string[] = [];
  let rounds = 0;
  globalThis.fetch = (async () => {
    rounds++;
    if (rounds >= 8) controller.abort();
    return textStream(`reply ${rounds}`);
  }) as typeof globalThis.fetch;
  try {
    const turn = goalTurn("goal-checkpoint-window", controller.signal, entries);
    turn.governGoal = async (input) => {
      checkpoints.push(input.recentWork);
      return { verdict: "continue", reasons: "keep going" };
    };
    await harness.turns.runTurn(turn).catch(() => undefined);
    assert.ok(checkpoints.length >= 2, `at least two checkpoints ran (${checkpoints.length})`);
    const [first, second] = checkpoints;
    assert.match(first!, /reply 1/);
    assert.doesNotMatch(second!, /reply 1\b/, "the second checkpoint does not resend work the first one judged");
    assert.match(second!, /reply [4-7]/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a goal never falls back to a model that already refused in the same turn", async () => {
  const harness = createPiHarness({
    resolveProviderKeys: async () => ({ anthropic: "sk-test" }),
    resolveFallbackRuntime: () => ({ modelId: "claude-sonnet-5" }),
  });
  const controller = new AbortController();
  const entries: Item[] = [];
  const realFetch = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? "{}")) as { model: string; messages: unknown[] };
    models.push(request.model);
    if (models.length >= 8) controller.abort();
    const latest = JSON.stringify(request.messages.at(-1));
    if (models.length === 1 || latest.includes("could not answer this request"))
      return textStream(`reply ${models.length}`);
    return textStream("", "refusal");
  }) as typeof globalThis.fetch;
  try {
    const outcome = await harness.turns.runTurn(goalTurn("goal-refusal-alternation", controller.signal, entries)).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    const [primary, refused, fallback, refusedAgain] = models;
    assert.deepEqual([refused, refusedAgain], [primary, fallback]);
    assert.equal(models.length, 4, "the turn ends instead of bouncing back to the model that already refused");
    assert.ok("error" in outcome && outcome.error instanceof ProviderTurnError && !outcome.error.retryable);
    assert.equal(savedGoal("goal-refusal-alternation")?.status, "active");
  } finally {
    globalThis.fetch = realFetch;
  }
});
