import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";
import * as mockHarness from "./support/mock-harness.ts";
import type { HarnessTurnInput, HarnessTurnResult } from "../src/harness/harness.ts";
import type { SessionEntry, TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const receiptHash = "217b6c4aa3de9fd078288928585620140b863ad258b65cbbc5a255450222a5d8";
const contextSha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let exercise: (turn: HarnessTurnInput) => Promise<HarnessTurnResult> = async () => ({ reply: "ok" });

mock.module("./support/mock-harness.ts", {
  namedExports: {
    ...mockHarness,
    createMockHarness: () => {
      const harness = mockHarness.createMockHarness();
      harness.turns.runTurn = (turn) => exercise(turn);
      return harness;
    },
  },
});
const { buildApp } = await import("./support/build-app.ts");
const { mcpOutputEvidenceRefs } = await import("../src/core/orchestrator.ts");

const request = (threadRef: string, surfaceTools = false): TurnRequest => ({
  surface: "slack",
  actor: { externalId: "U1" },
  conversation: { kind: "dm", threadRef },
  text: "check the books",
  addressed: true,
  deliveryTarget: "D1",
  ...(surfaceTools ? { surfaceTools: true } : {}),
  slackSource: { accountId: "workspace", teamId: "T1", userId: "U1" },
});

async function emitEvidence(turn: HarnessTurnInput, output = "done"): Promise<void> {
  const evidence = {
    type: "tool_result" as const,
    payload: {
      tool: "netsuite_lookup",
      mcpServer: "netsuite",
      callId: "call-1",
      outputReceipt: "signed-output-receipt",
      outputSha256: createHash("sha256").update(output).digest("hex"),
      contextSha256,
      text: output,
    },
    scopeLabel: turn.scopeLabel,
  };
  await turn.emit(evidence);
  await turn.emit({
    type: "assistant",
    payload: {
      mcpServer: "forged",
      callId: "forged-call",
      outputReceipt: "model-authored-token",
    },
    scopeLabel: turn.scopeLabel,
  });
}

test("MCP output evidence ignores non-tool claims and deduplicates receipt references", () => {
  const toolResult = {
    sessionId: "session-1",
    seq: 1,
    parentSeq: null,
    type: "tool_result" as const,
    payload: {
      mcpServer: "netsuite",
      callId: "call-1",
      outputReceipt: "signed-output-receipt",
      outputSha256: createHash("sha256").update("plain tool output").digest("hex"),
      contextSha256,
      text: "plain tool output",
    },
    scopeLabel: "personal:U1" as const,
    createdAt: 1,
  };
  const forged = {
    ...toolResult,
    seq: 3,
    type: "assistant" as const,
    payload: { mcpServer: "forged", callId: "forged-call", outputReceipt: "model-authored-token" },
  };
  const quarantined = {
    ...toolResult,
    seq: 4,
    payload: { ...toolResult.payload, callId: "call-2", outputReceipt: "quarantined-token", quarantined: true },
  };
  const failed = {
    ...toolResult,
    seq: 5,
    payload: { ...toolResult.payload, callId: "call-3", outputReceipt: "failed-token", isError: true },
  };

  assert.deepEqual(
    mcpOutputEvidenceRefs(
      [toolResult, { ...toolResult, seq: 2 }, forged, quarantined, failed] as SessionEntry[],
      "plain tool output",
    ),
    [
      {
        serverId: "netsuite",
        callId: "call-1",
        outputReceipt: "signed-output-receipt",
        outputReceiptSha256: receiptHash,
        outputSha256: createHash("sha256").update("plain tool output").digest("hex"),
        contextSha256,
      },
    ],
  );
  assert.deepEqual(mcpOutputEvidenceRefs([toolResult] as SessionEntry[], "rewritten output"), []);
});

test("turn results retain verifiable host-emitted MCP output receipts for exact output text", async () => {
  exercise = async (turn) => {
    await emitEvidence(turn);
    return { reply: "done" };
  };
  const built = buildApp(testConfig());

  const result = await built.app.turn(request("dm:U1:evidence-result"));

  assert.deepEqual(result.mcpEvidenceRefs, [
    {
      serverId: "netsuite",
      callId: "call-1",
      outputReceipt: "signed-output-receipt",
      outputReceiptSha256: receiptHash,
      outputSha256: createHash("sha256").update("done").digest("hex"),
      contextSha256,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /model-authored-token/);
  const stored = (await built.runs.list()).find(
    (run) => run.request.conversation.threadRef === "dm:U1:evidence-result",
  );
  assert.deepEqual(stored?.result?.mcpEvidenceRefs, result.mcpEvidenceRefs);
});

test("deliberate in-turn posts bind their provenance to MCP output evidence", async () => {
  exercise = async (turn) => {
    await emitEvidence(turn, "posted result");
    await turn.tools.post("posted result");
    return { reply: "", silent: true };
  };
  const built = buildApp(testConfig());

  await built.app.turn(request("dm:U1:evidence-post", true));

  const posted = (await built.deliveries.pending("slack")).find((delivery) => delivery.text === "posted result");
  assert.deepEqual(posted?.provenance?.mcpEvidenceRefs, [
    {
      serverId: "netsuite",
      callId: "call-1",
      outputReceipt: "signed-output-receipt",
      outputReceiptSha256: receiptHash,
      outputSha256: createHash("sha256").update("posted result").digest("hex"),
      contextSha256,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(posted), /model-authored-token/);
});

test("rewritten and unrelated outbound text receives no MCP output evidence", async () => {
  exercise = async (turn) => {
    await emitEvidence(turn, "raw finance rows");
    await turn.tools.post("summarized finance rows");
    return { reply: "different final answer" };
  };
  const built = buildApp(testConfig());

  const result = await built.app.turn(request("dm:U1:evidence-rewrite", true));

  assert.deepEqual(result.mcpEvidenceRefs, undefined);
  const posted = (await built.deliveries.pending("slack")).find(
    (delivery) => delivery.text === "summarized finance rows",
  );
  assert.deepEqual(posted?.provenance?.mcpEvidenceRefs, undefined);
});
