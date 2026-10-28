import "../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockHarness } from "../support/mock-harness.ts";
import { type HarnessTurnInput, promptEnvelopeWithoutHistory } from "../../src/harness/harness.ts";
import { hashId } from "../../src/util/crypto.ts";
import { buildTestApp, dm } from "../support/orchestrator-app.ts";
import { testConfig } from "../support/test-config.ts";
import { sanitizeLlmPayload } from "../../src/harness/pi-payload.ts";
import { promptEnvelopeBody } from "../../src/sessions/postgres-llm-capture.ts";

test("model utilities are independent from turn control", async () => {
  const harness = createMockHarness();

  assert.equal(typeof harness.turns.runTurn, "function");
  assert.equal(await harness.models.oneShot?.("system", "hello"), "mock one-shot reply to: hello");
  assert.equal("oneShot" in harness.turns, false);
  assert.equal("runTurn" in harness.models, false);
});

test("an approved resume reuses the parked turn's system prompt and carries the approval note in its environment", async () => {
  const seen: HarnessTurnInput[] = [];
  const harness = createMockHarness();
  const run = harness.turns.runTurn;
  harness.turns.runTurn = async (turn) => {
    seen.push(turn);
    return run(turn);
  };
  const config = testConfig();
  config.sandbox.namePrefix ??= `test-${hashId([config.dataDir]).slice(0, 10)}`;
  const { app } = buildTestApp(config, { harness });
  const call = '!declared {"to":"a@example.com","body":"hi"}';
  const pending = await app.turn(dm(call));
  assert.equal(pending.status, "pending_approval");
  const parked = seen.at(-1)!;
  const approved = await app.turn(
    dm(call, { approval: { requestId: pending.pendingApprovals![0]!.requestId, approved: true } }),
  );
  assert.equal(approved.status, "ok");
  const resumed = seen.at(-1)!;
  assert.notEqual(resumed, parked);
  assert.equal(resumed.systemPrompt, parked.systemPrompt);
  assert.doesNotMatch(resumed.systemPrompt, /approved the pending operation/);
  assert.match(
    resumed.environment ?? "",
    /The requesting human has approved the pending operation for this turn\. Resume that operation instead of requesting the same approval again\./,
  );
  assert.doesNotMatch(parked.environment ?? "", /approved the pending operation/);
});

const cases: Array<{
  name: string;
  payload: (history: string[], instruction: string, tool: string) => unknown;
}> = [
  {
    name: "Anthropic messages",
    payload: (history, instruction, tool) => ({
      model: "test-model",
      system: [{ text: instruction }],
      tools: [{ name: tool }],
      messages: history.map((text) => ({ role: "user", content: [{ text }] })),
    }),
  },
  {
    name: "Chat Completions and Mistral messages",
    payload: (history, instruction, tool) => ({
      model: "test-model",
      temperature: 0.5,
      tools: [{ type: "function", function: { name: tool } }],
      messages: [
        { role: "system", content: instruction },
        ...history.map((content) => ({ role: "user" as const, content })),
        { role: "developer", content: "developer instruction" },
        { role: "assistant", content: "answer" },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ],
    }),
  },
  {
    name: "OpenAI Responses input",
    payload: (history, instruction, tool) => ({
      model: "test-model",
      tools: [{ type: "function", name: tool, parameters: {}, strict: false }],
      input: [
        { role: "system", content: instruction },
        ...history.map((text) => ({ role: "user" as const, content: [{ type: "input_text" as const, text }] })),
        { type: "message", role: "developer", content: [{ type: "input_text", text: "developer instruction" }] },
        { type: "function_call", call_id: "call_1", name: tool, arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "result" },
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "reasoning" },
      ],
    }),
  },
  {
    name: "Codex Responses instructions",
    payload: (history, instruction, tool) => ({
      model: "test-model",
      instructions: instruction,
      tools: [{ type: "function", name: tool, parameters: {}, strict: false }],
      input: history.map((content) => ({ role: "user", content })),
    }),
  },
  {
    name: "Responses string input",
    payload: (history, instruction, tool) => ({
      model: "test-model",
      instructions: instruction,
      tools: [{ type: "function", name: tool, parameters: {}, strict: false }],
      input: history.join("\n"),
    }),
  },
];

for (const { name, payload } of cases) {
  test(`${name}: capture hashes ignore history but retain instructions and tools without mutation`, () => {
    const first = payload(["hello"], "be helpful", "lookup");
    const grown = payload(["hello", "another user message", "tool result"], "be helpful", "lookup");
    const original = structuredClone(grown);
    for (const extract of [promptEnvelopeWithoutHistory, (value: unknown) => sanitizeLlmPayload(value).envelope]) {
      const envelope = extract(grown);
      assert.deepEqual(grown, original);
      const body = promptEnvelopeBody(envelope)!;
      assert.equal(body.hash, promptEnvelopeBody(extract(first))!.hash);
      assert.notEqual(body.hash, promptEnvelopeBody(extract(payload([], "new instruction", "lookup")))!.hash);
      assert.notEqual(body.hash, promptEnvelopeBody(extract(payload([], "be helpful", "other_tool")))!.hash);
      assert.match(body.body, /be helpful/);
      assert.match(body.body, /lookup/);
      assert.doesNotMatch(body.body, /hello|another user message|tool result|reasoning|call_1/);
      if (name.includes("Chat") || name.includes("OpenAI")) assert.match(body.body, /developer instruction/);
    }
    assert.equal(sanitizeLlmPayload(grown).truncated, false);
  });
}

test("empty histories and malformed payloads do not add envelope fields or throw", () => {
  for (const value of [null, undefined, "text", 12, []]) assert.equal(promptEnvelopeWithoutHistory(value), value);
  for (const value of [null, "history", [], [{ role: "user", content: "hello" }]]) {
    assert.deepEqual(promptEnvelopeWithoutHistory({ messages: value, input: value }), {});
  }
  assert.deepEqual(promptEnvelopeWithoutHistory({ input: [null, 1, {}, { role: "user" }] }), {});
});
