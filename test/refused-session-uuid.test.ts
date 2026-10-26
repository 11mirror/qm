import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, type AppDeps } from "../src/api/app.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { scopeId, type TurnResult } from "../src/types.ts";
import { claimTurn, finishTurn, testRunStore, type TestRunStore } from "./support/turns.ts";

function request(threadRef: string): OrchestratorInput {
  return {
    surface: "web",
    text: "hi",
    actor: { id: "U1", type: "internal" },
    conversation: { kind: "channel", threadRef },
    origin: { kind: "human" },
  } as unknown as OrchestratorInput;
}

async function settled(store: TestRunStore, threadRef: string, result: TurnResult, status: "done" | "failed") {
  const { run } = await store.runs.enqueue({ sessionId: threadRef, request: request(threadRef) });
  const claimed = await claimTurn(store.ledger, run.id);
  assert.ok(claimed, "claimed for processing");
  assert.ok(await finishTurn(claimed, result, status));
  return run;
}

function unknownFailure(threadRef: string): TurnResult {
  return { status: "failed", sessionId: threadRef, reason: "An unknown error occurred" };
}

test("getRun resolves the threadRef to the real UUID and builds the admin link from publicWebUrl", async () => {
  const store = testRunStore();
  const { sessions, runs } = store;
  const threadRef = "ch:C_UUID_FIXTURE:100.1";
  const session = await sessions.getOrCreateByThread(threadRef, "channel", scopeId("org", "default-org"));
  const run = await settled(store, threadRef, unknownFailure(threadRef), "failed");

  const app = createApp({ sessions, runs, publicWebUrl: "https://portal.example.com" } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.status, "failed");
  assert.equal(got?.result?.sessionId, session.id, "threadRef swapped for the real UUID");
  assert.notEqual(got?.result?.sessionId, threadRef);
  assert.equal(
    got?.result?.adminUrl,
    `https://portal.example.com/admin/history/s/${session.id}`,
    "admin link built from the org's portal + resolved UUID",
  );

  await store.close();
});

test("getRun omits the admin link when no portal (publicWebUrl) is configured", async () => {
  const store = testRunStore();
  const { sessions, runs } = store;
  const threadRef = "ch:C2:2.2";
  await sessions.getOrCreateByThread(threadRef, "channel", scopeId("org", "default-org"));
  const run = await settled(store, threadRef, unknownFailure(threadRef), "failed");

  const app = createApp({ sessions, runs } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.status, "failed");
  assert.equal(got?.result?.adminUrl, undefined, "no portal ⇒ no link");

  await store.close();
});

test("getRun leaves an already-UUID refused sessionId untouched (no false rewrite)", async () => {
  const store = testRunStore();
  const { sessions, runs } = store;
  const session = await sessions.getOrCreateByThread("dm:U1", "dm", scopeId("personal", "U1"));
  const run = await settled(
    store,
    "ch:C1:1.1",
    { status: "refused", sessionId: session.id, reason: "session busy" },
    "done",
  );

  const app = createApp({ sessions, runs } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.sessionId, session.id, "a real session id is left as-is");
  await store.close();
});

test("getRun drops an unresolvable threadRef sessionId (turn failed before its session existed)", async () => {
  const store = testRunStore();
  const { sessions, runs } = store;
  const run = await settled(store, "ch:C9:9.9", unknownFailure("ch:C9:9.9"), "failed");

  const app = createApp({ sessions, runs } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.status, "failed");
  assert.equal(got?.result?.sessionId, undefined, "unresolvable id is dropped, not leaked");

  await store.close();
});
