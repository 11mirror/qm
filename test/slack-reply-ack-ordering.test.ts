import { test } from "node:test";
import assert from "node:assert";
import { createTurnFlow } from "../src/slack/turn-flow.ts";

function fakeCore(pending: Map<string, { text: string }>, events: string[]) {
  return {
    async submitTurn() {
      pending.set("run:r1", { text: "the finished reply" });
      return { status: "queued", runId: "r1" };
    },
    async waitRun() {
      return { status: "ok", reply: "the finished reply", runId: "r1" };
    },
    async ackRunDelivery(runId: string) {
      events.push("ack");
      pending.delete(`run:${runId}`);
    },
    async stageBlob() {
      return { blobId: "b", sizeBytes: 0 };
    },
    async readBlob() {
      return Buffer.alloc(0);
    },
    async readFileArtifact() {
      return Buffer.alloc(0);
    },
    async reportRunEditRef() {},
  } as any;
}

test("deferDeliveryAck: recovery delivery stays pending until the caller settles it", async () => {
  const events: string[] = [];
  const pending = new Map<string, { text: string }>();
  const bridge = createTurnFlow(fakeCore(pending, events));

  const result = await bridge.callCore({ text: "hi" } as any, { deferDeliveryAck: true });
  assert.equal(result.status, "ok");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events, [], "no ack before the reply is posted");
  assert.ok(pending.has("run:r1"), "recovery copy still pending — a failed post is recoverable");
  assert.ok(bridge.inFlightRuns.has("r1"), "run stays pinned so the poller waits for the handler");

  bridge.ackRunDelivery("r1");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events, ["ack"]);
  assert.equal(pending.size, 0);
  assert.equal(bridge.inFlightRuns.has("r1"), false, "pin released after settle");
});

test("without deferDeliveryAck an ok run still acks its recovery delivery", async () => {
  const events: string[] = [];
  const pending = new Map<string, { text: string }>();
  const bridge = createTurnFlow(fakeCore(pending, events));
  await bridge.callCore({ text: "hi" } as any);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events, ["ack"]);
  assert.equal(pending.size, 0);
});

test("failed and refused turns keep recovery pending until their notice is delivered", async () => {
  for (const status of ["failed", "refused"]) {
    const events: string[] = [];
    const pending = new Map<string, { text: string }>();
    const core = fakeCore(pending, events);
    core.waitRun = async () => ({ status, reason: "test failure" });
    const flow = createTurnFlow(core);
    await flow.callCore({ text: "hi" } as any, { deferDeliveryAck: true });
    assert.deepEqual(events, []);
    assert.ok(pending.has("run:r1"));
    assert.ok(flow.inFlightRuns.has("r1"));
    flow.ackRunDelivery("r1");
  }
});
