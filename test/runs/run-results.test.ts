import { test } from "node:test";
import assert from "node:assert/strict";
import { recordingOutbound } from "../support/recording-outbound.ts";
import { createOutbound } from "../../src/surfaces/outbound.ts";
import { runResultPost, wireRunResultPosts, type TurnFailureSessions } from "../../src/runs/run-results.ts";
import type { Run } from "../../src/runs/run-store.ts";
import type { OrchestratorInput } from "../../src/core/orchestrator.ts";
import type { Principal, TurnResult } from "../../src/types.ts";
import { SECURITY_QUARANTINE_REFUSAL_TEXT } from "../../plugins/chassis/src/security-quarantine.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl, testQuery } from "../support/test-database.ts";
import { claimTurn, completeTurn, finishTurn, testRunStore } from "../support/turns.ts";

const actor: Principal = { id: "internal:U1", type: "internal" };
const noSessions = { getByThread: async () => null } as unknown as TurnFailureSessions;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const turn = (text: string, deliveryTarget?: string): OrchestratorInput => ({
  surface: "slack",
  ...(deliveryTarget ? { deliveryTarget } : {}),
  actor,
  conversation: { kind: "dm", threadRef: "t", audience: [actor] },
  origin: { kind: "direct" },
  text,
});

function run(over: Partial<Run>): Run {
  return {
    id: "r-1",
    sessionId: "s-1",
    status: "done",
    request: turn("hi", "C9:171.001"),
    result: { status: "ok", reply: "the reply" },
    deliveryState: null,
    turnUserSeq: null,
    dedupKey: null,
    attempts: 1,
    errorAttempts: 0,
    maxAttempts: 3,
    priority: 2,
    preemptions: 0,
    leaseToken: null,
    workerId: null,
    createdAt: 1,
    startedAt: 1,
    finishedAt: 2,
    absurdQueue: null,
    absurdTaskId: null,
    absurdRunId: null,
    ...over,
  };
}

test("runResultPost maps ok-with-reply to a recovery delivery keyed by run", () => {
  const d = runResultPost(run({}));
  assert.deepEqual(d, {
    destination: { type: "slack", target: "C9:171.001" },
    text: "the reply",
    provenance: {
      trigger: "conversation",
      surface: "slack",
      fireKey: "run:r-1",
      sourceScopeId: "personal:internal:U1",
      sourceThreadRef: "t",
    },
    idempotencyKey: "run:r-1",
    createdAt: 2,
  });
});

test("runResultPost carries the reply's attachments so recovery can replay the files", () => {
  const atts = [{ name: "report.csv", mimetype: "text/csv", sizeBytes: 42, blobId: "blob-1" }];
  const d = runResultPost(run({ result: { status: "ok", reply: "here's the file", attachments: atts } }));
  assert.deepEqual(d?.attachments, atts);
  assert.equal(d?.text, "here's the file");
});

test("runResultPost retains the Slack policy a legacy-shaped request used for private admission", () => {
  const request = {
    ...turn("hi", "DPRIVATE"),
    slackSource: {
      accountId: "partner",
      teamId: "TPARTNER",
      userId: "U1",
      externalPolicyNamespace: "external-slack:TPARTNER:policy",
    },
  };
  assert.deepEqual(runResultPost(run({ request }))?.destination, {
    type: "slack",
    target: "DPRIVATE",
    account: "partner",
    workspaceId: "TPARTNER",
    policyNamespace: request.slackSource.externalPolicyNamespace,
  });
});

test("runResultPost carries the turn source's account, workspace and policy onto its destination", () => {
  const request = {
    ...turn("hi", "DPRIVATE"),
    source: { account: "partner", workspaceId: "TPARTNER", userId: "U1", policyNamespace: "external-slack:TPARTNER:p" },
  };
  assert.deepEqual(runResultPost(run({ request }))?.destination, {
    type: "slack",
    target: "DPRIVATE",
    account: "partner",
    workspaceId: "TPARTNER",
    policyNamespace: "external-slack:TPARTNER:p",
  });
});

test("runResultPost recovers an attachments-only reply (empty text, files still land)", () => {
  const atts = [{ name: "report.csv", mimetype: "text/csv", sizeBytes: 42, blobId: "blob-1" }];
  const d = runResultPost(run({ result: { status: "ok", attachments: atts } }));
  assert.equal(d?.text, "");
  assert.deepEqual(d?.attachments, atts);
  assert.equal(d?.idempotencyKey, "run:r-1");
});

test("runResultPost does not recover a turn whose only output was file problems", () => {
  const d = runResultPost(run({ result: { status: "ok", reply: "" } }));
  assert.equal(d, null);
});

test("runResultPost sheds a surface-spine turn's text reply (the agent posted it via `post` — no double-post)", () => {
  const spine = run({ result: { status: "silent" } });
  spine.request = { ...spine.request, surfaceTools: true };
  assert.equal(runResultPost(spine), null, "no recovery copy — post already delivered the text");
  const okReply = run({ result: { status: "ok", reply: "leaked reply" } });
  okReply.request = { ...okReply.request, surfaceTools: true };
  assert.equal(runResultPost(okReply), null, "post owns the text — the turn reply is never re-posted");
});

test("runResultPost STILL recovers a surface-spine turn's file attachments (post is text-only)", () => {
  const atts = [{ name: "report.csv", mimetype: "text/csv", sizeBytes: 42, blobId: "blob-1" }];
  const spine = run({ result: { status: "ok", reply: "", attachments: atts } });
  spine.request = { ...spine.request, surfaceTools: true };
  const d = runResultPost(spine);
  assert.deepEqual(d?.attachments, atts, "files ride the turn result, so they must not be shed");
  assert.equal(d?.text, "");
});

test("runResultPost still posts a surface-spine turn's FAILURE note", () => {
  const spine = run({ status: "failed", result: { status: "failed", reason: "boom" } });
  spine.request = { ...spine.request, surfaceTools: true };
  assert.equal(runResultPost(spine)?.text, "⚠️ I couldn't finish that turn: something went wrong on my end");
});

test("runResultPost recovers an addressed model-budget refusal with its explanation", () => {
  const reason = "This workspace has used up its model budget, so I can't run until it resets.";
  const spine = run({ result: { status: "refused", refusalKind: "model_budget", reason } });
  spine.request = { ...spine.request, surfaceTools: true, addressed: true };
  assert.equal(runResultPost(spine)?.text, reason);
  spine.request = { ...spine.request, addressed: false, origin: { kind: "ambient" } };
  assert.equal(runResultPost(spine), null);
});

test("runResultPost recovers a security quarantine without exposing its internal reason", () => {
  const d = runResultPost(
    run({
      request: { ...turn("hi", "C9:171.001"), addressed: true },
      result: {
        status: "refused",
        refusalKind: "security_quarantine",
        reason: "internal screening details",
      },
    }),
  );
  assert.equal(d?.text, SECURITY_QUARANTINE_REFUSAL_TEXT);
  assert.doesNotMatch(d?.text ?? "", /internal screening details/);
});

test("runResultPost keeps an unprompted quarantine silent — a replay has no live handler to suppress it", () => {
  const spine = run({ result: { status: "refused", refusalKind: "security_quarantine" } });
  spine.request = { ...spine.request, surfaceTools: true, origin: { kind: "ambient" } };
  assert.equal(runResultPost(spine), null);
});

test("runResultPost recovers security quarantine for an addressed surface-spine turn", () => {
  const spine = run({ result: { status: "refused", refusalKind: "security_quarantine" } });
  spine.request = { ...spine.request, surfaceTools: true, addressed: true };
  assert.equal(runResultPost(spine)?.text, SECURITY_QUARANTINE_REFUSAL_TEXT);
});

test("runResultPost keeps proactive ambient quarantine silent", () => {
  const ambient = run({ result: { status: "refused", refusalKind: "security_quarantine" } });
  ambient.request = { ...ambient.request, origin: { kind: "automation" }, surfaceTools: true };
  assert.equal(runResultPost(ambient), null);
});

test("runResultPost carries the surface's edit checkpoint into the destination", () => {
  const d = runResultPost(run({ deliveryState: { editRef: "171.002" } }));
  assert.equal(d?.destination.editRef, "171.002");
});

test("runResultPost links the admin error page when a resolver is wired", () => {
  const failed = run({
    status: "failed",
    result: { status: "failed", sessionId: "b6f3f9e2-0000-4000-8000-000000000001", reason: "boom" },
  });
  const d = runResultPost(failed, (sessionId) => `https://portal.example.com/admin/?session=${sessionId}`);
  assert.equal(
    d?.text,
    "⚠️ I couldn't finish that turn: something went wrong on my end — full error: https://portal.example.com/admin/?session=b6f3f9e2-0000-4000-8000-000000000001",
  );
});

test("runResultPost turns a parked run into a visible failure note", () => {
  const d = runResultPost(run({ status: "failed", result: { status: "failed", reason: "lease expired (reaped)" } }));
  assert.equal(d?.text, "⚠️ I couldn't finish that turn: something went wrong on my end");
  assert.doesNotMatch(d?.text ?? "", /lease expired/, "the internal failure reason never reaches the user");
  assert.equal(d?.idempotencyKey, "run:r-1");
});

test("runResultPost keeps unprompted failures quiet, like the live path", () => {
  const failed = run({ status: "failed", result: { status: "failed", reason: "boom" } });
  failed.request = { ...failed.request, origin: { kind: "ambient" } };
  assert.equal(runResultPost(failed), null, "no failure note where nobody addressed the agent");
  assert.ok(runResultPost({ ...failed, request: { ...failed.request, sessionSenderId: "child" } }));
  const ok = run({});
  ok.request = { ...ok.request, origin: { kind: "ambient" } };
  assert.equal(runResultPost(ok)?.text, "the reply", "an unprompted reply the agent chose to send still recovers");
});

test("runResultPost skips terminal results that cannot be safely replayed", () => {
  assert.equal(runResultPost(run({ request: turn("hi") })), null);
  assert.equal(runResultPost(run({ result: { status: "refused", reason: "not allowed" } })), null);
  for (const result of [
    { status: "pending_approval" } as TurnResult,
    { status: "react", reactions: ["thumbsup"] } as TurnResult,
    { status: "silent" } as TurnResult,
    { status: "ok" } as TurnResult,
  ]) {
    assert.equal(runResultPost(run({ result })), null, `skips ${result.status}`);
  }
});

test("wired stores: a completed turn is posted unless the live path already posted it", async (t) => {
  const { runs, ledger, close } = testRunStore();
  t.after(close);
  const outbound = recordingOutbound();
  wireRunResultPosts(runs, outbound, { sessions: noSessions, postsImmediately: () => true });

  const crashed = (await runs.enqueue({ sessionId: "sA", request: turn("a", "C9:171.001") })).run;
  const c1 = (await claimTurn(ledger, crashed.id))!;
  await runs.setDeliveryState(crashed.id, null, { editRef: "171.002" });
  await finishTurn(c1, { status: "ok", reply: "recovered reply" });
  await settle();
  const pending = await outbound.pending("slack");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.text, "recovered reply");
  assert.equal(pending[0]!.destination.editRef, "171.002");
  assert.equal(pending[0]!.idempotencyKey, `run:${crashed.id}`);
  assert.equal(typeof (await runs.get(crashed.id))?.deliveryState?.postedAt, "number", "the run remembers the post");

  const live = (await runs.enqueue({ sessionId: "sB", request: turn("b", "C9") })).run;
  const c2 = (await claimTurn(ledger, live.id))!;
  await runs.setDeliveryState(live.id, null, { postedAt: 99 });
  await finishTurn(c2, { status: "ok", reply: "delivered live" });
  await settle();
  assert.deepEqual(
    (await outbound.pending("slack")).map((d) => d.idempotencyKey),
    [`run:${crashed.id}`],
    "the live post is not repeated",
  );
});

test("a live turn handler that still owns the run defers the post, and the sweep posts it later", async (t) => {
  const { runs, ledger, close } = testRunStore();
  t.after(close);
  const outbound = createOutbound({});
  const posted: string[] = [];
  let live = true;
  outbound.register(["slack"], async (post) => {
    if (live) return { deferred: true };
    posted.push(post.idempotencyKey);
  });
  const recovery = wireRunResultPosts(runs, outbound, { sessions: noSessions, postsImmediately: () => true });
  const r = (await runs.enqueue({ sessionId: "sA", request: turn("a", "C9:171.001") })).run;
  await completeTurn(ledger, r.id, { status: "ok", reply: "x" });
  await settle();
  assert.deepEqual(posted, []);
  assert.equal((await runs.get(r.id))?.deliveryState?.postedAt, undefined, "a deferred post is not marked posted");
  live = false;
  assert.equal(await recovery.sweep(Date.now() + 120_000), 1);
  assert.deepEqual(posted, [`run:${r.id}`]);
});

test("sweep posts the reply of a terminal run nobody posted", async (t) => {
  const { runs, ledger, close } = testRunStore();
  t.after(close);
  const outbound = recordingOutbound();
  const bypassed = (await runs.enqueue({ sessionId: "sA", request: turn("a", "C9:171.001") })).run;
  await completeTurn(ledger, bypassed.id, { status: "ok", reply: "lost on the way out" });
  const recovery = wireRunResultPosts(runs, outbound, { sessions: noSessions, postsImmediately: () => true });
  assert.deepEqual(await outbound.pending("slack"), [], "wired after the fact: nothing posted");

  assert.equal(await recovery.sweep(Date.now()), 0, "runs finished inside the grace window are not swept yet");
  assert.equal(await recovery.sweep(Date.now() + 120_000), 1);
  assert.deepEqual(
    (await outbound.pending("slack")).map((d) => [d.idempotencyKey, d.text]),
    [[`run:${bypassed.id}`, "lost on the way out"]],
  );
  assert.equal(await recovery.sweep(Date.now() + 120_000), 0, "a second sweep sees the run was posted");
});

test("sweep marks a permanently undeliverable reply done instead of retrying it every minute", async (t) => {
  const { runs, ledger, close } = testRunStore();
  t.after(close);
  const outbound = createOutbound({});
  let attempts = 0;
  outbound.register(["slack"], async () => {
    attempts += 1;
    throw Object.assign(new Error("channel_not_found"), { permanent: true });
  });
  const r = (await runs.enqueue({ sessionId: "sA", request: turn("a", "C9:171.001") })).run;
  await completeTurn(ledger, r.id, { status: "ok", reply: "x" });
  const recovery = wireRunResultPosts(runs, outbound, { sessions: noSessions, postsImmediately: () => true });
  assert.equal(await recovery.sweep(Date.now() + 120_000), 0);
  assert.equal(await recovery.sweep(Date.now() + 120_000), 0);
  assert.equal(attempts, 1);
});

test("sweep recovers a reply owed by a run that finished long ago", async (t) => {
  const { runs, ledger, databaseUrl, close } = testRunStore();
  t.after(close);
  const outbound = recordingOutbound();
  const stale = (await runs.enqueue({ sessionId: "sA", request: turn("a", "C9:171.001") })).run;
  await completeTurn(ledger, stale.id, { status: "ok", reply: "from last week" });
  const weekAgo = Date.now() - 7 * 24 * 60 * 60_000;
  await testQuery(databaseUrl, `UPDATE runs SET finished_at = ${weekAgo} WHERE id = '${stale.id}'`);
  const quiet = (await runs.enqueue({ sessionId: "sB", request: turn("b") })).run;
  await completeTurn(ledger, quiet.id, { status: "ok", reply: "nowhere to post" });
  const recovery = wireRunResultPosts(runs, outbound, { sessions: noSessions, postsImmediately: () => true });
  assert.equal(await recovery.sweep(Date.now() + 120_000), 1);
  assert.deepEqual(
    (await outbound.pending("slack")).map((d) => [d.idempotencyKey, d.text]),
    [[`run:${stale.id}`, "from last week"]],
  );
  assert.equal(typeof (await runs.get(quiet.id))?.deliveryState?.settledAt, "number", "a run owing nothing is settled");
  assert.equal((await runs.get(quiet.id))?.deliveryState?.postedAt, undefined);
  assert.deepEqual(await runs.unsettledTerminal({ finishedAt: 0, id: "" }, Date.now() + 120_000, 10), []);
  assert.equal(await recovery.sweep(Date.now() + 120_000), 0);
});

test("sweep pages through terminal runs by (finishedAt, id) without skipping ties", async (t) => {
  const { runs, ledger, close } = testRunStore();
  t.after(close);
  const finished = new Set<string>();
  for (let i = 0; i < 205; i++) {
    const run = (await runs.enqueue({ sessionId: `s${i}`, request: turn(`r${i}`, "C9:171.001") })).run;
    await completeTurn(ledger, run.id, { status: "ok", reply: `r${i}` });
    finished.add(`run:${run.id}`);
  }
  const swept = recordingOutbound();
  const sweptRecovery = wireRunResultPosts(runs, swept, { sessions: noSessions, postsImmediately: () => true });
  assert.equal(await sweptRecovery.sweep(Date.now() + 120_000), 205);
  assert.deepEqual(new Set((await swept.pending("slack")).map((d) => d.idempotencyKey)), finished);
  assert.equal(await sweptRecovery.sweep(Date.now() + 120_000), 0);
});

test("wired stores: a parked run posts a failure note", async (t) => {
  const { runs, ledger, close } = testRunStore();
  t.after(close);
  const outbound = recordingOutbound();
  wireRunResultPosts(runs, outbound, { sessions: noSessions, postsImmediately: () => true });

  const parked = (await runs.enqueue({ sessionId: "sP", request: turn("p", "C9:171.001"), maxAttempts: 1 })).run;
  await finishTurn(
    (await claimTurn(ledger, parked.id))!,
    { status: "failed", sessionId: "sP", reason: "boom" },
    "failed",
  );
  await settle();

  const stored = await runs.get(parked.id);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.result?.status, "failed", "park stores a distinct terminal status, not refused");

  const pending = await outbound.pending("slack");
  assert.equal(pending.length, 1, "the park posts a failure note");
  assert.equal(pending[0]!.text, "⚠️ I couldn't finish that turn: something went wrong on my end");
  assert.equal(pending[0]!.idempotencyKey, `run:${parked.id}`);
});

const failureSessions = async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const scope = "personal:u1@example.test" as import("../../src/types.ts").ScopeId;
  const session = await sessions.getOrCreateByThread("slack:D1", "dm", scope, undefined, "slack");
  return { sessions, session };
};

const FAILED_RUN_ID = "7d1f3c2e-5b7a-4e0b-9c3d-2a1b4c5d6e7f";

const failedRun = (over: Partial<Run> = {}): Run =>
  run({
    id: FAILED_RUN_ID,
    sessionId: "slack:D1",
    status: "failed",
    result: { status: "failed", sessionId: "slack:D1", reason: "lease expired (reaped)" },
    ...over,
  });

test("a parked run's failure lands as a turn_failure entry in the run's own session, once", async () => {
  const { recordRunFailureEntry } = await import("../../src/runs/run-results.ts");
  const { sessions, session } = await failureSessions();

  assert.equal(await recordRunFailureEntry(sessions, failedRun()), "recorded");
  const entries = await sessions.getItems(session.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.kind, "Error");
  assert.equal(entries[0]!.errorCode, "turn_failure");
  assert.equal(entries[0]!.text, "I couldn't finish that turn: something went wrong on my end");

  assert.equal(await recordRunFailureEntry(sessions, failedRun()), "present", "recording is idempotent");
  assert.equal((await sessions.getItems(session.id)).length, 1);
});

test("an orchestrator-recorded in-turn failure suppresses the onTerminal entry", async () => {
  const { recordRunFailureEntry } = await import("../../src/runs/run-results.ts");
  const { sessions, session } = await failureSessions();
  const { lease } = await sessions.acquireLease(session.id);
  await sessions.append(lease!, {
    kind: "Error",
    errorCode: "turn_failure",
    text: "already recorded by the turn",
    turnId: FAILED_RUN_ID,
  });
  await sessions.releaseLease(lease!);

  assert.equal(await recordRunFailureEntry(sessions, failedRun()), "present");
  assert.equal((await sessions.getItems(session.id)).length, 1, "no duplicate entry");
});

test("a failure entry recorded for another run does not suppress this run's entry", async () => {
  const { recordRunFailureEntry } = await import("../../src/runs/run-results.ts");
  const { sessions, session } = await failureSessions();
  const { lease } = await sessions.acquireLease(session.id);
  await sessions.append(lease!, {
    kind: "Error",
    errorCode: "turn_failure",
    text: "an earlier run's failure",
    turnId: "0b9e8d7c-6a5b-4c3d-8e2f-1a0b9c8d7e6f",
  });
  await sessions.releaseLease(lease!);

  assert.equal(await recordRunFailureEntry(sessions, failedRun()), "recorded");
  assert.equal((await sessions.getItems(session.id)).length, 2);
});

test("a done run records nothing", async () => {
  const { recordRunFailureEntry } = await import("../../src/runs/run-results.ts");
  const { sessions, session } = await failureSessions();
  assert.equal(await recordRunFailureEntry(sessions, run({ sessionId: "slack:D1" })), "unneeded");
  assert.equal((await sessions.getItems(session.id)).length, 0);
});

test("wired stores: a parked Slack run gets both the durable session entry and the recovery note", async (t) => {
  const { sessions, session } = await failureSessions();
  const { runs, ledger, close } = testRunStore();
  t.after(close);
  const outbound = recordingOutbound();
  wireRunResultPosts(runs, outbound, { sessions, postsImmediately: () => true });

  const parked = (await runs.enqueue({ sessionId: "slack:D1", request: turn("p", "D1:171.001"), maxAttempts: 1 })).run;
  await finishTurn(
    (await claimTurn(ledger, parked.id))!,
    { status: "failed", sessionId: "slack:D1", reason: "lease expired (reaped)" },
    "failed",
  );

  for (let i = 0; i < 50 && (await sessions.getItems(session.id)).length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const entries = await sessions.getItems(session.id);
  assert.equal(entries.length, 1, "the run's own session carries the failure durably");
  assert.equal(entries[0]!.kind, "Error");
  assert.equal(entries[0]!.text, "I couldn't finish that turn: something went wrong on my end");
  assert.equal(entries[0]!.turnId, parked.id);

  await settle();
  const pending = await outbound.pending("slack");
  assert.equal(pending.length, 1, "the Slack note still goes out alongside the entry");
  assert.match(pending[0]!.text, /couldn't finish/);
});

test("onTerminal: a failed run is not settled while its session is busy, so the sweep still owes its entry", async (t) => {
  const { sessions, session } = await failureSessions();
  const { runs, ledger, close } = testRunStore();
  t.after(close);
  const outbound = recordingOutbound();
  const recovery = wireRunResultPosts(runs, outbound, { sessions, postsImmediately: () => true });
  const { lease } = await sessions.acquireLease(session.id, "turn");
  const parked = (await runs.enqueue({ sessionId: "slack:D1", request: turn("p", "D1:171.001"), maxAttempts: 1 })).run;
  await finishTurn(
    (await claimTurn(ledger, parked.id))!,
    { status: "failed", sessionId: "slack:D1", reason: "lease expired (reaped)" },
    "failed",
  );
  await settle();
  assert.deepEqual(await outbound.pending("slack"), [], "the Slack note waits on the durable entry");
  assert.equal(
    (await runs.get(parked.id))?.deliveryState?.settledAt,
    undefined,
    "the run is not settled ahead of its entry",
  );

  await sessions.releaseLease(lease!);
  assert.equal(await recovery.sweep(Date.now() + 120_000), 2);
  assert.equal((await sessions.getItems(session.id)).length, 1);
  assert.equal((await outbound.pending("slack")).length, 1);
});

test("sweep: a failed run whose process died before recording its failure gets the entry from the sweep", async (t) => {
  const { sessions, session } = await failureSessions();
  const { runs, ledger, close } = testRunStore();
  t.after(close);
  const parked = (await runs.enqueue({ sessionId: "slack:D1", request: turn("p", "D1:171.001"), maxAttempts: 1 })).run;
  await finishTurn(
    (await claimTurn(ledger, parked.id))!,
    { status: "failed", sessionId: "slack:D1", reason: "lease expired (reaped)" },
    "failed",
  );
  const outbound = recordingOutbound();
  const recovery = wireRunResultPosts(runs, outbound, { sessions, postsImmediately: () => true });
  assert.equal((await sessions.getItems(session.id)).length, 0, "wired after the fact: nothing recorded");

  assert.equal(await recovery.sweep(Date.now() + 120_000), 2, "the entry and the Slack note were both recovered");
  const entries = await sessions.getItems(session.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.errorCode, "turn_failure");
  assert.equal(entries[0]!.turnId, parked.id);
  assert.equal((await outbound.pending("slack")).length, 1);
  assert.equal(await recovery.sweep(Date.now() + 120_000), 0, "settled: nothing left to recover");
  assert.equal((await sessions.getItems(session.id)).length, 1, "no duplicate entry");
});

test("sweep: a busy session leaves the failed run unsettled so a later sweep records the entry", async (t) => {
  const { sessions, session } = await failureSessions();
  const { runs, ledger, close } = testRunStore();
  t.after(close);
  const parked = (await runs.enqueue({ sessionId: "slack:D1", request: turn("p", "D1:171.001"), maxAttempts: 1 })).run;
  await finishTurn(
    (await claimTurn(ledger, parked.id))!,
    { status: "failed", sessionId: "slack:D1", reason: "lease expired (reaped)" },
    "failed",
  );
  const outbound = recordingOutbound();
  const recovery = wireRunResultPosts(runs, outbound, { sessions, postsImmediately: () => true });
  const { lease } = await sessions.acquireLease(session.id, "turn");

  assert.equal(await recovery.sweep(Date.now() + 120_000), 0);
  assert.equal((await sessions.getItems(session.id)).length, 0);
  assert.deepEqual(await outbound.pending("slack"), [], "nothing is posted while the entry is still owed");
  assert.equal((await runs.get(parked.id))?.deliveryState?.settledAt, undefined, "the run stays unsettled");

  await sessions.releaseLease(lease!);
  assert.equal(await recovery.sweep(Date.now() + 120_000), 2);
  assert.equal((await sessions.getItems(session.id)).length, 1);
  assert.equal((await runs.get(parked.id))?.deliveryState?.settledAt !== undefined, true);
});

test("a run result post identifies its source session and assistant entry", () => {
  const delivery = runResultPost(
    run({ result: { status: "ok", sessionId: "source-session", reply: "File ready", sourceAssistantEntrySeq: 7 } }),
  );
  assert.equal(delivery?.provenance?.sourceSessionId, "source-session");
  assert.equal(delivery?.provenance?.sourceAssistantEntrySeq, 7);
});

test("private session turns cannot deliver even with a stale destination", () => {
  assert.equal(
    runResultPost(run({ request: { ...turn("private", "C9:171.001"), privateSessionMessage: true } })),
    null,
  );
});

for (const surface of ["slack", "web"] as const) {
  for (const result of [
    { status: "ok", reply: "INTERNAL_CHILD_REPORT" },
    { status: "failed", reason: "internal child failure" },
    { status: "refused", refusalKind: "security_quarantine", reason: "internal screening" },
    { status: "pending_approval", pendingApprovals: [{ requestId: "a", command: "cmd", reason: "approval" }] },
  ] satisfies TurnResult[]) {
    test(`${surface}: child ${result.status} never becomes an automatic public delivery`, () => {
      const threadRef = "agent:main:subagent:child";
      assert.equal(
        runResultPost(
          run({
            sessionId: threadRef,
            status: result.status === "failed" ? "failed" : "done",
            request: {
              ...turn("child", "D1"),
              surface,
              addressed: true,
              conversation: { kind: "dm", threadRef, audience: [actor] },
            },
            result,
          }),
        ),
        null,
      );
    });
  }
}
