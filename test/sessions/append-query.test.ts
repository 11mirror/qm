import assert from "node:assert/strict";
import test from "node:test";
import { insertItems } from "../../src/sessions/postgres-session-items.ts";
import type { PoolClient } from "../../src/persistence/pg-pool.ts";
import { DuplicateCallError } from "../../src/sessions/session-store.ts";

test("typed append sends items and counters in one statement after sequence allocation", async () => {
  const calls: Array<{ sql: string; args?: unknown[] }> = [];
  const client = {
    async query(sql: string, args?: unknown[]) {
      calls.push({ sql, args });
      return { rows: [{ n: 5 }], rowCount: 1 };
    },
  } as unknown as PoolClient;
  const full = await insertItems(
    () => 100,
    client,
    "s",
    [
      { kind: "UserMessage", text: "hello", body: {} },
      { kind: "UserMessage", text: "overheard", body: { overheard: true } },
      { kind: "AgentMessage", text: "world", body: {} },
    ],
    "00000000-0000-4000-8000-000000000001",
  );
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.sql, /WITH inserted AS \(INSERT INTO items/);
  assert.match(calls[1]!.sql, /UPDATE sessions/);
  assert.match(calls[1]!.sql, /COUNT\(\*\).*\+ \$4/);
  assert.equal(calls[1]!.args?.[2], 8);
  assert.equal(calls[1]!.args?.[3], 1);
  assert.deepEqual(
    full.map((item) => item.seq),
    [5, 6, 7],
  );
  assert.ok(full.every((item) => item.turnId === "00000000-0000-4000-8000-000000000001"));
  assert.deepEqual(JSON.parse(calls[1]!.args?.[8] as string), full);
});

test("batched inserts retain duplicate tool-call classification", async () => {
  let count = 0;
  const client = {
    async query() {
      if (++count === 1) return { rows: [{ n: 0 }] };
      throw { code: "23505", constraint: "items_one_call_per_kind" };
    },
  } as unknown as PoolClient;
  await assert.rejects(
    insertItems(() => 100, client, "s", [{ kind: "ToolCall", tool: "execute", callId: "call", body: {} }]),
    DuplicateCallError,
  );
});
