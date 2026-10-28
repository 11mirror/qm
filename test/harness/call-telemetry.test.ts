import { test } from "node:test";
import assert from "node:assert/strict";
import { gatewayAttemptHeaders } from "../../src/harness/call-telemetry.ts";
import { createPiHarness } from "../../src/harness/pi-harness.ts";
import type { HarnessLlmRequestRecord, HarnessTurnInput } from "../../src/harness/harness.ts";
import { storedItem, type NewItem } from "../../src/sessions/items.ts";

const GATEWAY_HEADERS = {
  "content-type": "text/event-stream",
  "x-litellm-attempted-retries": "1",
  "x-litellm-attempted-fallbacks": "0",
  "x-litellm-response-duration-ms": "30512.4",
  "x-litellm-overhead-duration-ms": "41.2",
  "x-litellm-model-group": "openai/gpt-6-astra",
  "x-litellm-model-api-base": "https://api.openai.com",
  "x-litellm-call-id": "call-1",
  "x-litellm-key-spend": "12.5",
  "llm_provider-openai-processing-ms": "295",
  "llm_provider-x-request-id": "req_1",
  "llm_provider-openai-organization": "org-secret",
  "set-cookie": "a=b",
};

test("gatewayAttemptHeaders keeps only attempt and timing headers", () => {
  assert.deepEqual(gatewayAttemptHeaders(GATEWAY_HEADERS), {
    "x-litellm-attempted-retries": "1",
    "x-litellm-attempted-fallbacks": "0",
    "x-litellm-response-duration-ms": "30512.4",
    "x-litellm-overhead-duration-ms": "41.2",
    "x-litellm-model-group": "openai/gpt-6-astra",
    "x-litellm-model-api-base": "https://api.openai.com",
    "x-litellm-call-id": "call-1",
    "llm_provider-openai-processing-ms": "295",
    "llm_provider-x-request-id": "req_1",
  });
  assert.equal(gatewayAttemptHeaders({ "content-type": "text/event-stream" }), undefined);
  assert.equal(gatewayAttemptHeaders(undefined), undefined);
});

function responsesReply(): Response {
  const item = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "hi", annotations: [] }],
  };
  const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, total_tokens: 11 };
  const events = [
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    {
      type: "response.content_part.added",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "hi" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage } },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: GATEWAY_HEADERS });
}

test("each recorded model call carries the gateway's attempt headers in its transport", async () => {
  const rows: HarnessLlmRequestRecord[] = [];
  const harness = createPiHarness({
    modelGateway: {
      url: "https://gateway.example/v1",
      apiKey: "sk-gateway-test",
      apiKeyHeader: "x-gateway-key",
      models: { "gpt-6-astra": "openai/gpt-6-astra" },
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => responsesReply()) as typeof globalThis.fetch;
  let seq = 0;
  try {
    await harness.turns.runTurn({
      session: { id: "gateway-attempts" } as HarnessTurnInput["session"],
      input: "hello",
      systemPrompt: "BASE",
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
      orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
      runtime: { modelId: "gpt-6-astra" },
      emit: async (item: NewItem) =>
        storedItem(item, { sessionId: "gateway-attempts", seq: seq++, createdAt: Date.now() }),
      recordModelCall: () => {},
      recordLlmRequest: (rec: HarnessLlmRequestRecord) => {
        rows.push(rec);
      },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.transport?.modelId, "gpt-6-astra");
  assert.deepEqual(rows[0]!.transport?.gateway, gatewayAttemptHeaders(GATEWAY_HEADERS));
});
