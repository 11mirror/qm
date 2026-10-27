import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, type AppDeps } from "../src/api/app.ts";
import { scopeId } from "../src/types.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

/** Ends the turn the way the runner ends a turn whose error parks it: a failed result stamped with the threadRef. */
async function failedTurn(store: TestRunStore, runId: string): Promise<void> {
  const claimed = await claimTurn(store.ledger, runId);
  assert.ok(claimed, "claimed for processing");
  const result = { status: "failed" as const, sessionId: claimed.run.sessionId, reason: "An unknown error occurred" };
  await finishTurn(claimed, result, "failed");
}
import { claimTurn, completeTurn, finishTurn, testRunStore, type TestRunStore } from "./support/turns.ts";

test("getRun resolves the threadRef to the real UUID and builds the admin link from publicWebUrl", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const store = testRunStore();
  const { runs } = store;
  const threadRef = "ch:C_UUID_FIXTURE:100.1";
  const session = await sessions.getOrCreateByThread(threadRef, "channel", scopeId("org", "default-org"));

  const { run } = await runs.enqueue({ sessionId: threadRef, request: {} as never });
  await failedTurn(store, run.id);

  const app = createApp({ sessions, runs, publicWebUrl: "https://portal.example.com" } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.status, "failed");
  assert.equal(got?.result?.sessionId, session.id, "threadRef swapped for the real UUID");
  assert.notEqual(got?.result?.sessionId, threadRef);
  assert.equal(
    got?.result?.adminUrl,
    `https://portal.example.com/settings/history/s/${session.id}`,
    "admin link built from the org's portal + resolved UUID",
  );
});

test("getRun omits the admin link when no portal (publicWebUrl) is configured", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const store = testRunStore();
  const { runs } = store;
  const threadRef = "ch:C2:2.2";
  await sessions.getOrCreateByThread(threadRef, "channel", scopeId("org", "default-org"));
  const { run } = await runs.enqueue({ sessionId: threadRef, request: {} as never });
  await failedTurn(store, run.id);

  const app = createApp({ sessions, runs } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.status, "failed");
  assert.equal(got?.result?.adminUrl, undefined, "no portal ⇒ no link");
});

test("getRun leaves an already-UUID refused sessionId untouched (no false rewrite)", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const { runs, ledger } = testRunStore();
  const session = await sessions.getOrCreateByThread("dm:U1", "dm", scopeId("personal", "U1"));
  const { run } = await runs.enqueue({ sessionId: "ch:C1:1.1", request: {} as never });
  await completeTurn(ledger, run.id, { status: "refused", sessionId: session.id, reason: "session busy" });

  const app = createApp({ sessions, runs } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.sessionId, session.id, "a real session id is left as-is");
});

test("getRun drops an unresolvable threadRef sessionId (turn failed before its session existed)", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const store = testRunStore();
  const { runs } = store;
  const { run } = await runs.enqueue({ sessionId: "ch:C9:9.9", request: {} as never });
  await failedTurn(store, run.id);

  const app = createApp({ sessions, runs } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.status, "failed");
  assert.equal(got?.result?.sessionId, undefined, "unresolvable id is dropped, not leaked");
});
