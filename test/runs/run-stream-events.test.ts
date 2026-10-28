import assert from "node:assert/strict";
import { test } from "node:test";
import { createTurnStream } from "../../src/runs/turn-stream.ts";
import { emitRunText, type RunStreamEvent } from "../../src/runs/run-stream-events.ts";
import { createMemoryEventBus } from "../../src/util/event-bus.ts";
import { MAX_NOTIFY_PAYLOAD_BYTES, createPostgresNotifyBus } from "../../src/persistence/postgres-notify-bus.ts";
import { randomUUID } from "node:crypto";

const runs = { setDeliveryState: async () => true };

test("text publications push exact offsets immediately, including block boundaries", async () => {
  const changes: string[] = [];
  const deltas: Array<{ runId: string; text: string; offset: number }> = [];
  const stream = createTurnStream({
    runs,
    onDelta: (runId, text, offset) => deltas.push({ runId, text, offset }),
    onChange: (id) => changes.push(id),
  });
  stream.begin("run");
  stream.publish("run", "hello");
  assert.deepEqual(deltas, [{ runId: "run", text: "hello", offset: 0 }]);
  stream.publishBlockStart("run");
  stream.publish("run", "world");
  stream.publish("run", "ignored");
  stream.markReplyDone("run");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    deltas.map(({ text, offset }) => [text, offset]),
    [
      ["hello", 0],
      ["\n\n", 5],
      ["world", 7],
      ["ignored", 12],
    ],
  );
  assert.deepEqual(changes, ["run", "run"]);
});

test("cross-process text frames stay under Postgres' payload limit and preserve Unicode and offsets", () => {
  const bus = createMemoryEventBus<RunStreamEvent>("test");
  const parts: Array<Extract<RunStreamEvent, { kind: "delta" }>> = [];
  bus.subscribe((event) => {
    if (event.kind === "delta") parts.push(event);
  });
  const text = '\u0000"\\🌍'.repeat(3_000);
  emitRunText(bus, "r".repeat(36), text, 37, 0);
  let offset = 37;
  for (const part of parts) {
    assert.equal(part.offset, offset);
    assert.ok(Buffer.byteLength(JSON.stringify(part)) < MAX_NOTIFY_PAYLOAD_BYTES);
    offset += part.text.length;
  }
  assert.equal(parts.map((part) => part.text).join(""), text);
});

test("a boundary near the cap remains complete and later deltas keep absolute offsets", () => {
  const frames: Array<[number, number, number]> = [];
  const stream = createTurnStream({
    runs,
    onDelta: (_id, text, offset, start) => frames.push([text.length, offset, start]),
  });
  stream.publish("r", "a".repeat(199_996));
  stream.publishBlockStart("r");
  stream.publishBlockStart("r");
  stream.publish("r", "next");
  assert.deepEqual(frames, [
    [199_996, 0, 0],
    [2, 199_996, 0],
    [4, 199_998, 100_002],
  ]);
  assert.equal(stream.snapshot("r")?.length, 100_000);
  assert.ok(stream.snapshot("r")?.endsWith("a\n\nnext"));
  assert.equal(stream.startOffset("r"), 100_002);
});

const database = process.env.DATABASE_URL;

test(
  "independent worker and API connections replay and push Unicode text over Postgres",
  { skip: !database, timeout: 15_000 },
  async () => {
    const channel = `stream_${randomUUID().replaceAll("-", "")}`;
    const worker = createPostgresNotifyBus<RunStreamEvent>(database!, channel, "test-worker");
    const api = createPostgresNotifyBus<RunStreamEvent>(database!, channel, "test-api");
    const stream = createTurnStream({
      runs,
      onDelta: (runId, text, offset, startOffset) => emitRunText(worker, runId, text, offset, startOffset),
    });
    const runId = randomUUID();
    stream.begin(runId);
    stream.publish(runId, "preexisting 🌍 ");
    let text = "";
    let complete!: () => void;
    const received = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const expected = "preexisting 🌍 " + '\u0000\\"🌍'.repeat(900) + " final";
    const offWorker = await new Promise<() => void>((resolve) => {
      const off = worker.subscribe(
        (event) => {
          if (event.kind === "sync") {
            const startOffset = stream.startOffset(runId);
            const offset = Math.max(startOffset, event.offset);
            emitRunText(worker, runId, (stream.snapshot(runId) ?? "").slice(offset - startOffset), offset, startOffset);
          }
        },
        { onResync: () => resolve(off) },
      );
    });
    const offApi = await new Promise<() => void>((resolve) => {
      const off = api.subscribe(
        (event) => {
          if (event.kind !== "delta") return;
          if (event.offset > text.length) {
            api.emit({ runId, kind: "sync", offset: text.length });
            return;
          }
          text += event.text.slice(text.length - event.offset);
          if (text === expected) complete();
        },
        { onResync: () => resolve(off) },
      );
    });
    try {
      api.emit({ runId, kind: "sync", offset: 0 });
      stream.publish(runId, '\u0000\\"🌍'.repeat(900));
      stream.publish(runId, " final");
      await received;
      assert.equal(text, expected);
    } finally {
      offWorker();
      offApi();
      await worker.close?.();
      await api.close?.();
    }
  },
);
