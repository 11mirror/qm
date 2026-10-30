import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as mockHarness from "./support/mock-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

let seen: HarnessTurnInput | undefined;
mock.module("./support/mock-harness.ts", {
  namedExports: {
    ...mockHarness,
    createMockHarness: () => {
      const harness = mockHarness.createMockHarness();
      harness.turns.runTurn = async (turn) => {
        seen = turn;
        return { reply: "ok" };
      };
      return harness;
    },
  },
});
const { buildApp } = await import("./support/build-app.ts");

test("the orchestrator gives connector calls trusted Slack session and source context", async () => {
  const built = buildApp(testConfig());
  const request: TurnRequest = {
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:host-context" },
    text: "check the books",
    slackSource: {
      accountId: "workspace",
      teamId: "T1",
      userId: "U1",
      externalPolicyNamespace: "finance",
      replyThreadTs: "1700.10",
    },
  };

  const result = await built.app.turn(request);

  assert.equal(result.status, "ok");
  assert.match(seen?.mcpHostContext?.runId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(seen?.mcpHostContext?.attempt, 1);
  const { runId: _runId, attempt: _attempt, ...context } = seen!.mcpHostContext!;
  assert.deepEqual(context, {
    actorId: "U1",
    scopeId: "personal:U1",
    session: { id: result.sessionId, threadRef: "dm:U1:host-context" },
    surface: "slack",
    slackSource: request.slackSource,
    runtime: { harnessId: "pi", modelId: "claude-opus-5" },
  });
});
