import assert from "node:assert/strict";
import test from "node:test";
import { queueSessionPatch, resetSessionPatches } from "../src/session-patches.ts";
import type { CoreSession } from "../src/core-bridge.ts";

function row(id: string, patch: Record<string, unknown>): CoreSession {
  return { id, threadRef: `web:t:${id}`, scopeId: "personal:t", type: "dm", createdAt: 1, ...patch } as CoreSession;
}

test("patches to one session go out in order and only the latest result is applied", async (t) => {
  const sent: string[] = [];
  const releases: Array<() => void> = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    sent.push(String(init?.body));
    await new Promise<void>((resolve) => releases.push(resolve));
    return Response.json({ session: row("a", JSON.parse(String(init?.body))) });
  });
  const applied: CoreSession[] = [];
  const first = queueSessionPatch("a", { pinned: true }, (s) => applied.push(s));
  const second = queueSessionPatch("a", { pinned: false }, (s) => applied.push(s));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent, ['{"pinned":true}']);
  releases.shift()!();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent, ['{"pinned":true}', '{"pinned":false}']);
  releases.shift()!();
  await second;
  assert.deepEqual(
    applied.map((s) => s.pinned),
    [false],
  );
});

test("a reset drops results from patches queued before it", async (t) => {
  let release = (): void => {};
  t.mock.method(globalThis, "fetch", async () => {
    await new Promise<void>((resolve) => (release = resolve));
    return Response.json({ session: row("b", { archived: true }) });
  });
  const applied: CoreSession[] = [];
  const pending = queueSessionPatch("b", { archived: true }, (s) => applied.push(s));
  await new Promise((resolve) => setTimeout(resolve, 0));
  resetSessionPatches();
  release();
  await pending;
  assert.deepEqual(applied, []);
});
