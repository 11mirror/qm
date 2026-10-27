import assert from "node:assert/strict";
import { test } from "node:test";
import { createSlackSender } from "../src/slack/sender.ts";
import { createOutbound, type QueuedPost } from "../src/surfaces/outbound.ts";

const platformError = (code: string) =>
  Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });

function harness(client: Record<string, unknown>) {
  const queued = new Map<string, QueuedPost>();
  const outbound = createOutbound({
    retries: {
      get: async (k: string) => queued.get(k),
      put: async (k: string, v: QueuedPost) => void queued.set(k, v),
      delete: async (k: string) => void queued.delete(k),
      entries: async () => [...queued.entries()],
    } as never,
  });
  outbound.register(
    ["slack"],
    createSlackSender({
      core: {} as never,
      flow: { inFlightRuns: new Set<string>() } as never,
      threads: { mark: () => undefined } as never,
      defaultClient: client,
    }),
  );
  const send = (destination: Record<string, unknown>) =>
    outbound.send({
      destination: { type: "slack", target: "C1", ...destination } as never,
      text: "",
      idempotencyKey: `k:${JSON.stringify(destination)}`,
    });
  return { send, queued };
}

test("a refused native pin reaches the caller instead of reporting success", async () => {
  const { send, queued } = harness({
    pins: {
      add: async () => {
        throw platformError("missing_scope");
      },
    },
  });
  await assert.rejects(send({ pin: { messageTs: "1.2" } }), /native pin failed: missing_scope/);
  assert.equal(queued.size, 0);
});

test("an already-settled pin or delete counts as done", async () => {
  const { send } = harness({
    pins: {
      add: async () => {
        throw platformError("already_pinned");
      },
    },
    chat: {
      delete: async () => {
        throw platformError("message_not_found");
      },
    },
  });
  assert.deepEqual(await send({ pin: { messageTs: "1.2" } }), {});
  assert.deepEqual(await send({ delete: { messageTs: "1.2" } }), {});
});

test("a refused delete reaches the caller", async () => {
  const { send } = harness({
    chat: {
      delete: async () => {
        throw platformError("cant_delete_message");
      },
    },
  });
  await assert.rejects(
    send({ delete: { messageTs: "1.2" } }),
    /delete failed: cant_delete_message \(own messages only\)/,
  );
});

test("a native action that fails without a Slack answer is queued for retry", async () => {
  const { send, queued } = harness({
    pins: {
      remove: async () => {
        throw new Error("socket hang up");
      },
    },
  });
  assert.deepEqual(await send({ pin: { messageTs: "1.2", remove: true } }), { queued: true });
  assert.equal(queued.size, 1);
});

test("a reaction Slack refuses reaches the caller", async () => {
  const { send } = harness({
    reactions: {
      add: async () => {
        throw platformError("not_in_channel");
      },
    },
  });
  await assert.rejects(send({ react: { messageTs: "1.2", emoji: "eyes" } }), /reaction\(s\) failed: eyes/);
});
