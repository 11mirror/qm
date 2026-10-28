import { contextTokenBudgetForModel } from "../../src/model/pi-models.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { createPiHarness, piHarnessConfigOptions } from "../../src/harness/pi-harness.ts";
import { complete, resolveConfiguredModelId } from "../../src/harness/pi-model-runtime.ts";
import { transportFromModel } from "../../src/harness/pi-payload.ts";
import { DEFAULT_AGENT_MODEL_ID, auxiliaryModelFor, getRequiredModel } from "../../src/model/pi-models.ts";
import { modelGatewayRequest } from "../../src/model/provider-endpoints.ts";
import { storedItem } from "../../src/sessions/items.ts";
import { testConfig } from "../support/test-config.ts";

test("piHarnessConfigOptions maps every Config knob the harness consumes, field by field", () => {
  const opts = piHarnessConfigOptions(
    testConfig({
      modelId: "model-base",
      detectModelId: "model-detect",
      titleModelId: "model-title",
      anthropicApiKey: "sk-test",
      modelGateway: {
        url: "http://gateway.internal:8080",
        apiKey: "gateway-key",
        apiKeyHeader: "api-key",
        models: { "claude-opus-5": "router/opus" },
      },

      reachExecEnabled: true,
      signingSecret: "sek",
      apiBaseUrl: "https://core.test",
      turnWallClockMs: 111_000,
    }),
  );
  assert.deepEqual(opts, {
    defaultModelId: "model-base",
    detectModelId: "model-detect",
    titleModelId: "model-title",
    reachExec: true,
    controlTools: true,
    turnWallClockMs: 111_000,
  });
});

test("piHarnessConfigOptions leaves controlTools off unless a self-API (signing secret + api base) is configured", () => {
  assert.equal(piHarnessConfigOptions(testConfig()).controlTools, false);
  assert.equal(
    piHarnessConfigOptions(testConfig({ signingSecret: "sek" })).controlTools,
    false,
    "secret alone isn't enough",
  );
  assert.equal(
    piHarnessConfigOptions(testConfig({ apiBaseUrl: "https://core.test" })).controlTools,
    false,
    "api base alone isn't enough",
  );
  assert.equal(
    piHarnessConfigOptions(testConfig({ signingSecret: "sek", apiBaseUrl: "https://core.test" })).controlTools,
    true,
  );
});

test("piHarnessConfigOptions carries the deployment provider into Pi auxiliary model selection", () => {
  const opts = piHarnessConfigOptions(testConfig({ modelProvider: "openai", openaiApiKey: "sk-openai-test" }));
  assert.equal(opts.defaultModelId, "gpt-5.6-sol");
  assert.equal(auxiliaryModelFor(opts.defaultModelId!), "gpt-5.6-luna");
});

test("Pi title generation returns no title without an auxiliary-model credential", async () => {
  const harness = createPiHarness({
    defaultModelId: "gpt-5.6-sol",
    resolveProviderKeys: async () => ({}),
  });
  assert.equal(await harness.models.generateTitle!("User:\nPrioritize the public qm issues"), undefined);
});

test("Pi title generation surfaces provider failures to its caller", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "title model rejected request" } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert(address && typeof address !== "string");
  const harness = createPiHarness({
    defaultModelId: "claude-opus-4-8",
    titleModelId: "claude-haiku-4-5",
    modelGateway: {
      url: `http://127.0.0.1:${address.port}`,
      apiKey: "gateway-key",
      apiKeyHeader: "api-key",
      models: { "claude-haiku-4-5": "title-model" },
    },
  });

  await assert.rejects(harness.models.generateTitle!("User:\nInvestigate the deploy"));
});

test("Pi title generation rejects a plain-text answer with the rule that fired and the rejected text", async (t) => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        {
          type: "message_start",
          message: {
            id: "msg_title",
            type: "message",
            role: "assistant",
            model: "title-model",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Sorry, I can't summarize that" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ]) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert(address && typeof address !== "string");
  const harness = createPiHarness({
    defaultModelId: "claude-opus-4-8",
    titleModelId: "claude-haiku-4-5",
    modelGateway: {
      url: `http://127.0.0.1:${address.port}`,
      apiKey: "gateway-key",
      apiKeyHeader: "api-key",
      models: { "claude-haiku-4-5": "title-model" },
    },
  });

  await assert.rejects(harness.models.generateTitle!("User:\nInvestigate the deploy"), {
    name: "TitleRejected",
    rule: "no_title",
    message: 'no_title: "Sorry, I can\'t summarize that"',
  });
});

test("Pi title generation accepts a JSON text answer when the model does not call the answer tool", async (t) => {
  let requestBody: Record<string, unknown> = {};
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += String(chunk);
    });
    request.on("end", () => {
      requestBody = JSON.parse(raw) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        {
          type: "message_start",
          message: {
            id: "msg_title",
            type: "message",
            role: "assistant",
            model: "title-model",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: '```json\n{"title": "Deploy investigation"}\n```' },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ]) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert(address && typeof address !== "string");
  const harness = createPiHarness({
    defaultModelId: "claude-opus-4-8",
    titleModelId: "claude-haiku-4-5",
    modelGateway: {
      url: `http://127.0.0.1:${address.port}`,
      apiKey: "gateway-key",
      apiKeyHeader: "api-key",
      models: { "claude-haiku-4-5": "title-model" },
    },
  });

  assert.equal(await harness.models.generateTitle!("User:\nInvestigate the deploy"), "Deploy investigation");
  assert.equal((requestBody.thinking as { type?: string }).type, "enabled");
  assert.equal(requestBody.tool_choice, undefined);
});

test("Pi title generation accepts an answer that leaves the title out without reporting a failure", async (t) => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        {
          type: "message_start",
          message: {
            id: "msg_title",
            type: "message",
            role: "assistant",
            model: "title-model",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_title", name: "answer", input: {} },
        },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ]) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert(address && typeof address !== "string");
  const harness = createPiHarness({
    defaultModelId: "claude-opus-4-8",
    titleModelId: "claude-haiku-4-5",
    modelGateway: {
      url: `http://127.0.0.1:${address.port}`,
      apiKey: "gateway-key",
      apiKeyHeader: "api-key",
      models: { "claude-haiku-4-5": "title-model" },
    },
  });

  assert.equal(await harness.models.generateTitle!("User:\nHello"), undefined);
});

test("piHarnessConfigOptions omits the optional fields when the config leaves them unset", () => {
  const opts = piHarnessConfigOptions(testConfig());
  for (const key of ["defaultModelId", "detectModelId", "titleModelId", "apiKey"] as const) {
    assert.equal(key in opts, false, `${key} must be omitted, not undefined`);
  }
});

test("complete completes an authenticated Pi 0.82 turn", async (t) => {
  let apiKey: string | undefined;
  let requestBody = "";
  const server = createServer((request, response) => {
    apiKey = request.headers["x-api-key"] as string | undefined;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      requestBody += String(chunk);
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "working" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ];
      for (const event of events) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const address = server.address();
  assert(address && typeof address !== "string");
  const baseModel = getBuiltinModel("anthropic", "claude-haiku-4-5");
  assert(baseModel);
  const model = { ...baseModel, baseUrl: `http://127.0.0.1:${address.port}` };

  assert.equal(await complete(model, { anthropic: "test-key" }, "system", "hello"), "working");
  assert.equal(apiKey, "test-key");
  assert.match(requestBody, /system/);
  assert.match(requestBody, /hello/);
});

test("complete routes configured models through the model gateway without mutating transport metadata", async (t) => {
  let lastBody = "";
  let stopReason = "end_turn";
  const requests: Array<{ gatewayKey?: string; providerKey?: string; model?: string; marker?: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      lastBody = body;
      const requestModel = (JSON.parse(body) as { model?: string }).model;
      requests.push({
        ...(request.headers["api-key"] ? { gatewayKey: String(request.headers["api-key"]) } : {}),
        ...(request.headers["x-api-key"] ? { providerKey: String(request.headers["x-api-key"]) } : {}),
        ...(requestModel ? { model: requestModel } : {}),
        ...(request.headers["x-model-marker"] ? { marker: String(request.headers["x-model-marker"]) } : {}),
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        {
          type: "message_start",
          message: {
            id: "msg_gateway",
            type: "message",
            role: "assistant",
            model: requestModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "gateway" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ]) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const modelGateway = {
    url: `http://127.0.0.1:${address.port}`,
    apiKey: "gateway-secret",
    apiKeyHeader: "api-key",
    models: { "claude-haiku-4-5": "router/haiku", "retired-model-name": "router/retired" },
  };
  const model = { ...getRequiredModel("claude-haiku-4-5"), headers: { "x-model-marker": "preserved" } };
  assert.equal(await complete(model, {}, "system", "hello", { modelGateway }), "gateway");
  const directModel = { ...getRequiredModel("claude-opus-4-8"), baseUrl: modelGateway.url };
  await assert.rejects(
    complete(directModel, {}, "system", "hello", { modelGateway }),
    /No API key found|Provider is not configured/,
  );

  assert.equal(
    await complete(directModel, { anthropic: "direct-provider-key" }, "system", "hello", { modelGateway }),
    "gateway",
  );
  assert.deepEqual(requests, [
    { gatewayKey: "gateway-secret", providerKey: "gateway-secret", model: "router/haiku", marker: "preserved" },
    { providerKey: "direct-provider-key", model: "claude-opus-4-8" },
  ]);
  const routed = modelGatewayRequest(modelGateway, model);
  assert.equal(routed?.model.id, "claude-haiku-4-5");
  assert.equal(routed?.target, "router/haiku");
  assert.deepEqual(transportFromModel(model), {
    modelId: "claude-haiku-4-5",
    headers: { "x-model-marker": "preserved" },
  });
  const harness = createPiHarness({ defaultModelId: "claude-haiku-4-5", modelGateway });
  const compact = harness.models.compactHistory!;
  const input: Parameters<typeof compact>[0] = {
    session: { id: "summary-session" } as Parameters<typeof compact>[0]["session"],
    summaryTokenBudget: 4_000,
    history: [
      storedItem(
        { kind: "UserMessage", text: "what? local recovery what?" },
        { sessionId: "summary-session", seq: 136, createdAt: 0 },
      ),
    ],
    recordModelCall: () => {},
  };
  assert.equal(await compact(input), "gateway");
  assert.deepEqual(requests.at(-1), {
    gatewayKey: "gateway-secret",
    providerKey: "gateway-secret",
    model: "router/haiku",
  });
  const body = JSON.parse(lastBody) as { messages: Array<{ content: Array<{ text?: string }> }> };
  const prompt = body.messages
    .flatMap((message) => message.content)
    .map((block) => block.text ?? "")
    .join("\n");
  assert.ok(prompt.indexOf("</conversation>") > prompt.indexOf("UserMessage#136"));
  assert.match(prompt.slice(prompt.indexOf("</conversation>")), /Create a structured context checkpoint summary/);
  stopReason = "max_tokens";
  await assert.rejects(compact(input), /did not complete \(length\)/);
});

test("resolveConfiguredModelId: known ids pass through, unknown ids fall back to the default", () => {
  assert.equal(resolveConfiguredModelId("claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(resolveConfiguredModelId(undefined), DEFAULT_AGENT_MODEL_ID);
  assert.equal(resolveConfiguredModelId("claude-dropped-by-pi-ai"), DEFAULT_AGENT_MODEL_ID);
  assert.equal(resolveConfiguredModelId("claude-dropped-by-pi-ai", "claude-opus-4-8"), "claude-opus-4-8");
});

test("resolveConfiguredModelId: an unresolvable default is rejected too, so auxiliaries never chase a dead id", () => {
  assert.equal(resolveConfiguredModelId(undefined, "anthropic/claude-sonnet-4-5"), DEFAULT_AGENT_MODEL_ID);
  assert.equal(resolveConfiguredModelId("also-not-real", "anthropic/claude-sonnet-4-5"), DEFAULT_AGENT_MODEL_ID);
  assert.doesNotThrow(() =>
    getRequiredModel(auxiliaryModelFor(resolveConfiguredModelId(undefined, "anthropic/claude-sonnet-4-5"))),
  );
});

test("Pi judge uses supported reasoning effort when configured with Astra", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let request: { model?: string; reasoning?: { effort?: string } } | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const encoded = new Headers(init?.headers).get("content-encoding") === "zstd";
    const text = encoded ? zstdDecompressSync(init?.body as Uint8Array).toString() : String(init?.body);
    request = JSON.parse(text);
    return new Response(JSON.stringify({ error: { message: "offline judge test" } }), { status: 400 });
  }) as typeof fetch;
  const harness = createPiHarness({
    judgeModelId: "gpt-6-astra",
    resolveProviderKeys: async () => ({ openai: "sk-offline-test-key" }),
  });
  await assert.rejects(harness.models.judge!("Judge the answer.", "answer"), /offline judge test/);
  assert.ok(request);
  assert.equal(request.model, "gpt-6-astra");
  assert.equal(request.reasoning?.effort, "low");
  assert.equal(
    harness.models.judgeTokenBudget!(),
    contextTokenBudgetForModel("gpt-6-astra"),
    "the governor's budget is the judge model's, not the turn model's auxiliary",
  );
  assert.notEqual(harness.models.judgeTokenBudget!(), undefined);
});

test("complete stops a request whose abort lands before Pi starts its run", { timeout: 10_000 }, async (t) => {
  let requests = 0;
  const server = createServer((request) => {
    requests += 1;
    request.resume();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseModel = getBuiltinModel("anthropic", "claude-haiku-4-5");
  assert(baseModel);
  const model = { ...baseModel, baseUrl: `http://127.0.0.1:${address.port}` };
  const controller = new AbortController();
  const signal = controller.signal;
  const subscribe = signal.addEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    subscribe(...args);
    controller.abort();
  }) as AbortSignal["addEventListener"];

  const outcome = await complete(model, { anthropic: "test-key" }, "system", "hello", { signal }).then(
    (text) => ({ text }),
    (error: unknown) => ({ error }),
  );

  assert.deepEqual(outcome, { text: undefined });
  assert.equal(requests, 0);
});
