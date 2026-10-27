import test from "node:test";
import assert from "node:assert/strict";
import { replayableRequest } from "../src/core/orchestrator/turn-helpers.ts";
import type { OrchestratorInput } from "../src/core/orchestrator/types.ts";

test("a replayed request keeps every request field and drops run-only state", () => {
  const actor = { id: "U1", type: "internal" as const, displayName: "Ada" };
  const input = {
    surface: "web",
    actor,
    conversation: { kind: "dm", threadRef: "t1", audience: [actor] },
    origin: { kind: "automation" },
    text: "hi",
    clientTools: [{ name: "pick", description: "pick one", parameters: {} }],
    desktopClientId: "desk-1",
    unattendedGrants: ["admin.audit.read"],
    approval: { requestId: "r1", approved: true },
    runId: "run-1",
    runLeaseToken: "lease",
  } as unknown as OrchestratorInput;
  const replayed = replayableRequest(input);
  assert.deepEqual(replayed.clientTools, [{ name: "pick", description: "pick one", parameters: {} }]);
  assert.equal(replayed.desktopClientId, "desk-1");
  assert.deepEqual(replayed.unattendedGrants, ["admin.audit.read"]);
  assert.deepEqual(replayed.origin, { kind: "automation" });
  assert.equal(replayed.approval, undefined);
  assert.equal("runId" in replayed, false);
  assert.equal("runLeaseToken" in replayed, false);
  assert.equal(replayed.actor.externalId, "U1");
});
