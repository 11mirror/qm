import { REASONING_SYNC_BLOCKS, reasoningKey } from "../../runs/run-stream-events.ts";
import type { Item } from "../../sessions/items.ts";
import { type ApiCtx, reply, type Route, type RouteResult } from "./route.ts";
import { SSE_HEADERS } from "./session-state.ts";

const HEARTBEAT_MS = 15_000;
const MAX_BUFFER_BYTES = 1_048_576;

function toolEvent(item: Item): { id: string; data: Record<string, unknown> } | null {
  const callId = item.callId;
  if (!callId) return null;
  if (item.kind === "ToolCall") {
    const { wire: _wire, ...args } = item.body;
    return {
      id: `tool:${callId}:start`,
      data: { type: "TOOL_CALL_START", toolCallId: callId, toolCallName: item.tool ?? "tool", args },
    };
  }
  return {
    id: `tool:${callId}:result`,
    data: {
      type: "TOOL_CALL_RESULT",
      toolCallId: callId,
      content: item.text ?? "",
      isError: item.isError === true,
    },
  };
}

function drained(res: ApiCtx["res"]): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

function markReasoning(sent: Map<string, number>, key: string, length: number): void {
  sent.delete(key);
  sent.set(key, length);
}

async function streamRun(ctx: ApiCtx): Promise<RouteResult> {
  const { app, req, res, actor } = ctx;
  const runId = ctx.params.id!;
  const initial = await app.getRun(runId, actor?.p);
  if (!initial) return reply(404, { error: "not_found" });
  if (res.destroyed) return;
  let closed = false;
  let offset = 0;
  let syncing = false;
  let refreshing = false;
  let refreshAgain = false;
  const sentToolEvents = new Set<string>();
  const sentReasoning = new Map<string, number>();
  let toolCursor: number | undefined;
  const cleanup = (): void => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  const send = (data: unknown, id?: string): void => {
    if (closed) return;
    if (res.writableLength > MAX_BUFFER_BYTES) {
      res.destroy();
      return;
    }
    res.write(`${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`);
  };
  const sync = (): void => {
    if (syncing || closed) return;
    syncing = true;
    queueMicrotask(() => {
      if (!closed)
        app.syncRunStream(runId, offset, Object.fromEntries([...sentReasoning].slice(-REASONING_SYNC_BLOCKS)));
    });
  };
  const sendDrained = async (data: unknown, id?: string): Promise<void> => {
    if (res.writableNeedDrain) await drained(res);
    send(data, id);
  };
  const snapshot = async (run: NonNullable<typeof initial>): Promise<void> => {
    const toolItems = await app.getRunToolItems(runId, actor?.p, toolCursor);
    if (closed) return;
    offset = Math.max(offset, (run.partialStartOffset ?? 0) + (run.partial?.length ?? 0));
    for (const block of run.reasoning ?? []) {
      const key = reasoningKey(block);
      markReasoning(sentReasoning, key, Math.max(sentReasoning.get(key) ?? 0, block.text.length));
    }
    for (const entry of toolItems) {
      const event = toolEvent(entry);
      if (event && !sentToolEvents.has(event.id)) {
        await sendDrained(event.data, event.id);
        if (closed) return;
        sentToolEvents.add(event.id);
      }
      toolCursor = entry.seq;
    }
    await sendDrained({ type: "CUSTOM", name: "run", value: run });
    if (closed) return;
    if (run.status === "done" || run.status === "failed" || run.result !== null) {
      await sendDrained({ type: "RUN_FINISHED", threadId: runId, runId }, "done");
      if (closed) return;
      res.end();
      cleanup();
    }
  };
  const refresh = async (hydrated?: typeof initial): Promise<void> => {
    if (closed) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      do {
        refreshAgain = false;
        const run = hydrated ?? (await app.getRun(runId, actor?.p));
        hydrated = undefined;
        if (closed) return;
        if (!run) {
          res.destroy();
          return;
        }
        await snapshot(run);
      } while (refreshAgain && !closed);
    } catch {
      res.destroy();
    } finally {
      refreshing = false;
      syncing = false;
      sync();
    }
  };
  const resync = (): void => {
    syncing = false;
    sync();
    void refresh();
  };
  const unsubscribe = app.subscribeRun(
    runId,
    (event) => {
      if (closed) return;
      if (event.kind === "refresh") {
        void refresh();
        return;
      }
      if (event.kind === "reasoning") {
        if (refreshing) return;
        const key = reasoningKey(event);
        const sent = sentReasoning.get(key) ?? 0;
        if (event.offset > sent) {
          sync();
          return;
        }
        const delta = event.text.slice(sent - event.offset);
        if (!delta) return;
        syncing = false;
        send({
          type: "CUSTOM",
          name: "reasoning",
          value: { step: event.step, index: event.index, offset: sent, delta },
        });
        markReasoning(sentReasoning, key, sent + delta.length);
        return;
      }
      if (event.kind !== "delta" || refreshing) return;
      const startOffset = event.startOffset ?? 0;
      offset = Math.max(offset, startOffset);
      if (event.offset > offset) {
        sync();
        return;
      }
      const delta = event.text.slice(offset - event.offset);
      if (!delta) return;
      syncing = false;
      send({ type: "CUSTOM", name: "delta", value: { offset, delta, startOffset } }, `text:${offset + delta.length}`);
      offset += delta.length;
    },
    resync,
  );
  const heartbeat = setInterval(resync, HEARTBEAT_MS);
  heartbeat.unref?.();
  res.on("close", cleanup);
  req.on("error", () => res.destroy());
  res.writeHead(200, SSE_HEADERS);
  send({ type: "RUN_STARTED", threadId: runId, runId });
  await refresh(initial);
  if (!closed) await refresh();
}

export const runEventRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/runs/:id/events", actor: "person", auth: "source", handle: streamRun },
];
