import "../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonbStringify } from "../../src/util/text.ts";
import { eventually, settle } from "../support/settle.ts";
import { claimTurn, finishTurn, completeTurn } from "../support/turns.ts";
import { freshApp, actor, mention, dm, web, spawnedWorker } from "../support/turn-requests.ts";
import type { TurnRequest } from "../../src/types.ts";
import { takePending } from "../support/memory-run-signal-store.ts";

test("web is excluded from core-side steering: a mid-turn message forks a SECOND run, never a signal", async () => {
  const built = freshApp();
  const threadRef = "web:U1:default";
  const first = await built.app.turn(web("summarize the incident", threadRef));
  const second = await built.app.turn(web("actually, just the timeline", threadRef));

  assert.notEqual(second.runId, first.runId!, "web must fork its own run, not attach to the live one");
  assert.equal(
    (await takePending(built.signals, first.runId!)).length,
    0,
    "core must send no steer signal for web — its composer owns that decision",
  );
  const runs = (await built.runs.list()).filter((r) => r.sessionId === threadRef);
  assert.equal(runs.length, 2, "both web messages are real, separately-visible runs");
});

test("web's queued second run waits for the lock: not claimable until the live run finishes", async () => {
  const built = freshApp();
  const threadRef = "web:U1:queued";
  const first = await built.app.turn(web("summarize the incident", threadRef));
  const second = await built.app.turn(web("actually, just the timeline", threadRef));
  const queued = [first.runId!, second.runId!];
  assert.equal(
    (await built.runs.list()).filter((r) => r.sessionId === threadRef).length,
    2,
    "both runs are on the queue before any is claimed",
  );

  const live = await claimTurn(built.turnLedger);
  assert.ok(live && queued.includes(live.run.id), "one of the two queued runs is claimed");
  assert.equal(await claimTurn(built.turnLedger), null, "the other must NOT be claimable while it runs");

  await finishTurn(live, { status: "ok", reply: "done" });
  const next = await claimTurn(built.turnLedger);
  assert.equal(
    next?.run.id,
    queued.find((id) => id !== live.run.id),
    "the waiting run is claimed once the lock frees",
  );
});

test("web's queue is durable and readable: core names the live run, then what waits behind it", async () => {
  const built = freshApp();
  const threadRef = "web:U1:visible";
  const first = await built.app.turn(web("summarize the incident", threadRef));
  await claimTurn(built.turnLedger, first.runId!);
  const second = await built.app.turn(web("then the timeline", threadRef));
  const third = await built.app.turn(web("and who was paged", threadRef));

  const active = await built.app.activeRunForThread(threadRef);
  assert.equal(active?.runId, first.runId, "the live run is the head, not the newest message");
  assert.deepEqual(
    active?.queued,
    [
      { runId: second.runId!, text: "then the timeline" },
      { runId: third.runId!, text: "and who was paged" },
    ],
    "the queue comes back in send order, with the text — enough for any surface to render it",
  );

  // A queued turn is withdrawable right up to the moment a worker takes it, and not after.
  assert.deepEqual(await built.app.withdrawRun(second.runId!), { withdrawn: true });
  assert.deepEqual(
    (await built.app.activeRunForThread(threadRef))?.queued,
    [{ runId: third.runId!, text: "and who was paged" }],
    "the withdrawn turn is off the queue and will never run",
  );
  assert.deepEqual(
    await built.app.withdrawRun(first.runId!),
    { withdrawn: false, reason: "started" },
    "the running turn is not withdrawable — it can only be steered or stopped",
  );
  assert.deepEqual(await built.app.withdrawRun("no-such-run"), { withdrawn: false, reason: "not_found" });
});

test("an automation wake queued behind a live turn stays out of the composer queue", async () => {
  const built = freshApp();
  const threadRef = "web:U1:wake";
  const first = await built.app.turn(web("summarize the incident", threadRef));
  await claimTurn(built.turnLedger, first.runId!);
  const wake = await built.app.turn({
    surface: "monitor",
    actor,
    conversation: { kind: "dm", threadRef, audience: [actor] },
    text: '<wake reason="monitor" surface="monitor" process-id="p1" at="2026-09-02T00:00:00.000Z">…</wake>',
    async: true,
    origin: { kind: "automation" },
  });
  const typed = await built.app.turn(web("and who was paged", threadRef));

  assert.notEqual(wake.runId, first.runId, "the wake is its own run, waiting behind the live turn");
  assert.deepEqual(
    (await built.app.activeRunForThread(threadRef))?.queued,
    [{ runId: typed.runId!, text: "and who was paged" }],
    "only what a person typed is offered back to them as a steerable, withdrawable queued message",
  );
});

test("a queued web turn runs on its own — the sender's client need never come back", async () => {
  const built = freshApp();
  const threadRef = "web:U1:unattended";
  const first = await built.app.turn(web("the long one", threadRef));
  const live = await claimTurn(built.turnLedger, first.runId!);
  const queued = await built.app.turn(web("the queued one", threadRef));

  await finishTurn(live!, { status: "ok", reply: "done" });
  const next = await claimTurn(built.turnLedger);
  assert.equal(next?.run.id, queued.runId, "the queued turn is claimed by a worker, with no client involved");
  assert.equal(next?.run.request.text, "the queued one");
});

// ── Orphaned-signal replay: a steer that loses the pickup race is never dropped ────────────────

test("orphan replay: a steer unconsumed at run completion replays as a fresh turn (prod 93a5c5ba)", async () => {
  const built = freshApp();
  const channel = "C9";
  const root = "900.9";
  const threadRef = `ch:${channel}:${root}`;
  const first = await built.app.turn(mention("@bot start the task", channel, root));
  const liveRunId = first.runId!;

  await built.app.turn({
    ...mention("@bot why did you do it wrong?", channel, root),
    origin: { kind: "human", messageTs: "900.010" },
  });
  const claimed = await claimTurn(built.turnLedger, liveRunId);
  assert.ok(claimed);
  await finishTurn(claimed, { status: "silent" });

  const replayed = (await eventually(
    async () => (await built.runs.list()).find((r) => r.sessionId === threadRef && r.id !== liveRunId),
    { until: (value) => value !== undefined },
  ))!;
  assert.equal(replayed.status, "pending");
  const text = `${replayed.request.text ?? ""} ${replayed.request.displayText ?? ""}`;
  assert.ok(
    text.includes("why did you do it wrong?"),
    `the replayed turn carries the steered message (got: ${text.slice(0, 120)})`,
  );
  assert.equal(
    (await takePending(built.signals, liveRunId)).length,
    0,
    "the orphaned signal was consumed by the drain",
  );
});

test("orphan replay: a stale abort is drained; a request-less steer replays on the run's own request", async () => {
  const built = freshApp();
  const channel = "C10";
  const root = "1000.1";
  const threadRef = `ch:${channel}:${root}`;
  const first = await built.app.turn(mention("@bot go", channel, root));
  const liveRunId = first.runId!;
  await built.signals.send(liveRunId, { kind: "abort" });
  await built.signals.send(liveRunId, { kind: "steer", text: "manual web steer" });

  await built.app.replayOrphanedRunSignals(liveRunId);
  assert.equal((await takePending(built.signals, liveRunId)).length, 0, "drained");
  const runs = (await built.runs.list()).filter((r) => r.sessionId === threadRef);
  assert.equal(runs.length, 2, "the abort is dropped; the steer text becomes a fresh turn, never lost");
  const fresh = runs.find((r) => r.id !== liveRunId);
  assert.equal(fresh?.request.text, "manual web steer");
});

test("signalRun: a web steer that races the run's end is replayed and reports the fresh run", async () => {
  const built = freshApp();
  const channel = "C14";
  const root = "1400.1";
  const first = await built.app.turn(mention("@bot go", channel, root));
  const liveRunId = first.runId!;
  completeOnSend(built);

  const raced = await built.app.signalRun(liveRunId, { kind: "steer", text: "did this make it?" });
  assert.equal(raced.accepted, false);
  assert.equal(raced.reason, "terminal");
  assert.equal(raced.replayed, true, "the caller is told the text now rides a fresh run");
  const fresh = (await eventually(
    async () => (await built.runs.list()).find((r) => r.sessionId === `ch:${channel}:${root}` && r.id !== liveRunId),
    { until: (value) => value !== undefined },
  ))!;
  assert.equal(fresh.request.text, "did this make it?");
});

test("signalRun: a steer already terminal at send is refused up front", async () => {
  const built = freshApp();
  const channel = "C11";
  const root = "1100.1";
  const first = await built.app.turn(mention("@bot go", channel, root));
  const liveRunId = first.runId!;
  await finishTurn((await claimTurn(built.turnLedger, liveRunId))!, { status: "ok", reply: "done" });

  const refused = await built.app.signalRun(liveRunId, { kind: "steer", text: "too late" });
  assert.equal(refused.accepted, false);
  assert.equal(refused.reason, "terminal");
  assert.equal((await takePending(built.signals, liveRunId)).length, 0, "nothing left rotting in the queue");
});

function completeOnSend(built: ReturnType<typeof freshApp>, sanitize = false): void {
  const origSend = built.signals.send.bind(built.signals);
  built.signals.send = async (runId, signal) => {
    const sent = await origSend(runId, sanitize ? JSON.parse(jsonbStringify(signal)) : signal);
    const claimed = await claimTurn(built.turnLedger);
    if (claimed) await finishTurn(claimed, { status: "silent" });
    return sent;
  };
}

test("signalRun: a steer whose run goes terminal mid-send is REFUSED, never a false accept", async () => {
  const built = freshApp();
  const channel = "C12";
  const root = "1200.1";
  const first = await built.app.turn(mention("@bot go", channel, root));
  const liveRunId = first.runId!;
  completeOnSend(built);

  const raced = await built.app.signalRun(liveRunId, { kind: "steer", text: "did this make it?" });
  assert.equal(raced.accepted, false, "a signal that raced the run's completion must not report success");
  assert.equal(raced.reason, "terminal");
  assert.equal((await takePending(built.signals, liveRunId)).length, 0, "nothing left rotting in the queue");
});

for (const sanitize of [false, true])
  test(`steer path: a message whose run goes terminal mid-send returns the fresh run (sanitize=${sanitize})`, async () => {
    const built = freshApp();
    const channel = "C13";
    const root = "1300.1";
    const threadRef = `ch:${channel}:${root}`;
    const first = await built.app.turn(mention("@bot go", channel, root));
    const liveRunId = first.runId!;
    completeOnSend(built, sanitize);
    built.app.replayOrphanedRunSignals = async () => {};

    const second = await built.app.turn({
      ...mention("@bot and another thing\u0000\ud800", channel, root),
      origin: { kind: "human", messageTs: "1300.010" },
    });
    assert.equal(second.status, "queued");
    assert.notEqual(second.runId, liveRunId, "the caller follows the replayed run, not the dead one");
    const replayed = (await built.runs.list()).find((r) => r.id === second.runId);
    assert.equal(replayed?.sessionId, threadRef);
    const text = `${replayed?.request.text ?? ""} ${replayed?.request.displayText ?? ""}`;
    assert.ok(
      text.includes("and another thing"),
      `the fresh run carries the raced message (got: ${text.slice(0, 120)})`,
    );
    assert.equal(
      (await takePending(built.signals, liveRunId)).length,
      0,
      "the raced signal was consumed by the inline drain",
    );
  });

test("reverse race: a sanitized mention follows its fresh run after the ambient run ends", async () => {
  const built = freshApp();
  const channel = "C-ambient-unicode";
  const askTs = "1600.2";
  const ambientRef = `slack:${channel}:ambient:${askTs}`;
  await built.sessions.getOrCreateByThread(ambientRef, "channel", `channel:${channel}`);
  const ambient = await built.app.turn(spawnedWorker(channel, askTs));
  completeOnSend(built, true);
  built.app.replayOrphanedRunSignals = async () => {};
  const second = await built.app.turn({
    ...mention("@bot more\u0000 work\ud800", channel, askTs),
    origin: { kind: "human", messageTs: askTs },
  });
  assert.equal(second.status, "queued");
  assert.notEqual(second.runId, ambient.runId);
  const replayed = await built.runs.get(second.runId!);
  assert.ok(`${replayed?.request.text} ${replayed?.request.displayText}`.includes("@bot more work�"));
});

test("queued web edits require the author and preserve queue identity", async () => {
  const built = freshApp();
  const threadRef = "web:U1:edit";
  const first = await built.app.turn(web("first", threadRef));
  await claimTurn(built.turnLedger, first.runId!);
  const second = await built.app.turn(web("second", threadRef));
  const owner = (await built.runs.get(second.runId!))!.request.actor.id;
  assert.deepEqual(await built.app.editQueuedRun(second.runId!, "edited", "second", "internal:other"), {
    edited: false,
    reason: "not_found",
  });
  assert.deepEqual(await built.app.editQueuedRun(second.runId!, "", "second", owner), {
    edited: false,
    reason: "empty_text",
  });
  assert.deepEqual(await built.app.editQueuedRun(second.runId!, "edited", "second", owner), { edited: true });
  assert.deepEqual((await built.app.activeRunForThread(threadRef, owner))?.queued, [
    { runId: second.runId, text: "edited" },
  ]);
  assert.deepEqual(await built.app.editQueuedRun(second.runId!, "stale", "second", owner), {
    edited: false,
    reason: "changed_or_started",
  });
  assert.deepEqual(await built.app.editQueuedRun(first.runId!, "late", "first", owner), {
    edited: false,
    reason: "changed_or_started",
  });
});

test("run snapshots expose authorized durable web input with safe attachment metadata", async () => {
  const built = freshApp();
  const turn = await built.app.turn({
    ...web("pending input", "web:U1:pending-input"),
    attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: 50, blobId: "private-blob" }],
  });
  const run = (await built.runs.get(turn.runId!))!;
  const snapshot = await built.app.getRun(run.id, run.request.actor.id);
  assert.deepEqual(snapshot?.input, {
    runId: run.id,
    seq: null,
    text: "pending input",
    createdAt: run.createdAt,
    attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: 50 }],
  });
  assert.equal(await built.app.getRun(run.id, "internal:other"), null);
  await built.runs.noteTurnUserSeq(run.id, 0);
  assert.equal((await built.app.getRun(run.id, run.request.actor.id))?.input?.seq, 0);
  const slack = await built.app.turn(dm("slack input", "D-no-web-input"));
  assert.equal((await built.app.getRun(slack.runId!))?.input, undefined);
  const replay = await built.runs.enqueue({
    sessionId: run.sessionId,
    request: { ...run.request, approval: { requestId: "approval-replay", approved: true } },
  });
  assert.equal((await built.app.getRun(replay.run.id, run.request.actor.id))?.input, undefined);
  for (const text of ["", "   "]) {
    const opener = await built.runs.enqueue({
      sessionId: run.sessionId,
      request: { ...run.request, text, proactiveOpener: true },
    });
    assert.equal((await built.app.getRun(opener.run.id, run.request.actor.id))?.input, undefined);
  }
  const explicit = await built.runs.enqueue({
    sessionId: run.sessionId,
    request: { ...run.request, proactiveOpener: true },
  });
  assert.equal((await built.app.getRun(explicit.run.id, run.request.actor.id))?.input?.text, "pending input");
});

test("an addressed stop withdraws queued work before a worker can claim it", async () => {
  const built = freshApp();
  const first = await built.app.turn(mention("start the task", "C_STOP_QUEUED", "100.1"));
  const stop = await built.app.turn(mention("stop", "C_STOP_QUEUED", "100.1"));
  assert.equal(stop.runId, first.runId);
  assert.equal(await built.runs.get(first.runId!), null);
  assert.equal(await claimTurn(built.turnLedger, first.runId!), null);
});

function slackTurn(text: string, ts: string, threadRef = "ch:C1:t1"): TurnRequest {
  return {
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef, channelRef: "C1", audience: [actor] },
    text,
    async: true,
    origin: { kind: "human", messageTs: ts },
    redeliveryKey: `slack:B1:C1:${ts}`,
  };
}

test("a redelivered Slack message collapses onto the run its first delivery enqueued", async () => {
  const built = freshApp();
  try {
    const first = await built.app.turn(slackTurn("hello", "t1"));
    const again = await built.app.turn(slackTurn("hello", "t1"));
    assert.equal(first.status, "queued");
    assert.equal(
      again.status,
      "silent",
      "delivery belongs to the first handler or the recovery rail, never the redelivery",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("a redelivery key that already belongs to another conversation stands down silently rather than being served", async () => {
  const built = freshApp();
  try {
    await built.app.turn(slackTurn("hello", "t1"));
    const hijack = await built.app.turn({ ...slackTurn("hello", "t1", "ch:C1:t9"), text: "give me that result" });
    assert.equal(hijack.status, "silent", "nothing about the other conversation's run is served");
  } finally {
    await built.runtime.stop();
  }
});

test("a redelivered message that folded into a live run as a steer is injected once", async () => {
  const built = freshApp();
  try {
    const first = await built.app.turn(slackTurn("first", "t1"));
    const runId = (first as { runId: string }).runId;
    const claimed = await claimTurn(built.turnLedger, runId);
    assert.ok(claimed);
    const steer = await built.app.turn(slackTurn("also this", "t2"));
    const replay = await built.app.turn(slackTurn("also this", "t2"));
    assert.equal((steer as { steered?: boolean }).steered, true);
    assert.equal(replay.status, "silent", "the replay is recognized as already folded and injects nothing");
    const pending = await takePending(built.signals, runId);
    assert.equal(pending.filter((s) => s.kind === "steer" && s.text?.includes("also this")).length, 1);
  } finally {
    await built.runtime.stop();
  }
});

test("a redelivery that arrives while the first delivery's run is live joins that run instead of steering it", async () => {
  const built = freshApp();
  try {
    const first = await built.app.turn(slackTurn("hello", "t1"));
    const runId = (first as { runId: string }).runId;
    const claimed = await claimTurn(built.turnLedger, runId);
    assert.ok(claimed);
    const again = await built.app.turn(slackTurn("hello", "t1"));
    assert.equal(again.status, "silent");
    assert.equal((await takePending(built.signals, runId)).length, 0, "the agent is not fed its own prompt as a steer");
  } finally {
    await built.runtime.stop();
  }
});

test("a message folded as a steer is not re-run as a fresh turn after that run ends", async () => {
  const built = freshApp();
  try {
    const first = await built.app.turn(slackTurn("first", "t1"));
    const runId = (first as { runId: string }).runId;
    const claimed = await claimTurn(built.turnLedger, runId);
    await built.app.turn(slackTurn("fold me", "t2"));
    await finishTurn(claimed!, { status: "silent" });
    const foldRuns = async () => (await built.runs.list()).filter((run) => run.request.text.includes(">fold me<"));
    await settle(async () => (await foldRuns()).length > 0);
    const late = await built.app.turn(slackTurn("fold me", "t2"));
    assert.equal(late.status, "silent");
    assert.equal((await foldRuns()).length, 1, "only the orphaned steer's replay runs it; the redelivery adds none");
  } finally {
    await built.runtime.stop();
  }
});

test("a Slack approval that reuses the message's request still enqueues its own run", async () => {
  const built = freshApp();
  try {
    const first = await built.app.turn(slackTurn("hello", "t1"));
    const runId = (first as { runId: string }).runId;
    const approval = await built.app.turn({
      ...slackTurn("hello", "t1"),
      approval: { requestId: "req-1", approved: true },
    });
    assert.notEqual(
      (approval as { runId?: string }).runId,
      runId,
      "the approval is not collapsed onto the message's run",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("a redelivery that slips past the lookup still cannot steer the run it belongs to", async () => {
  const built = freshApp();
  try {
    const first = await built.app.turn(slackTurn("hello", "t1"));
    const runId = (first as { runId: string }).runId;
    await claimTurn(built.turnLedger, runId);
    const real = built.runs.getByDedupKey.bind(built.runs);
    let misses = 1;
    built.runs.getByDedupKey = async (key) => (misses-- > 0 ? null : real(key));
    const again = await built.app.turn(slackTurn("hello", "t1"));
    assert.equal(again.status, "silent");
    assert.equal((await takePending(built.signals, runId)).length, 0);
  } finally {
    await built.runtime.stop();
  }
});

test("a redelivery of a finished run posts nothing rather than the answer a second time", async () => {
  const built = freshApp();
  try {
    const first = await built.app.turn(slackTurn("hello", "t1"));
    const runId = (first as { runId: string }).runId;
    await finishTurn((await claimTurn(built.turnLedger, runId))!, { status: "ok", reply: "the answer" });
    const again = await built.app.turn({ ...slackTurn("hello", "t1"), async: false });
    assert.equal(again.status, "silent");
  } finally {
    await built.runtime.stop();
  }
});

function message(threadTs?: string, text = "Continue", key = crypto.randomUUID()): TurnRequest {
  return {
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: `dm:D1${threadTs ? `:${threadTs}` : ""}` },
    deliveryTarget: `D1${threadTs ? `:${threadTs}` : ""}`,
    text,
    async: true,
    redeliveryKey: key,
    origin: { kind: "human" },
  };
}

async function fixture() {
  const built = freshApp();
  const first = await built.app.turn(message("10.1", "Investigate job"));
  const root = (await built.runs.get(first.runId!))!;
  async function legacy(name: string, target = "D1:20.1", actorId = root.request.actor.id) {
    const ref = `dm:D1:task:${name}`;
    return (
      await built.runs.enqueue({
        sessionId: ref,
        request: {
          ...root.request,
          actor: { ...root.request.actor, id: actorId },
          conversation: { ...root.request.conversation, threadRef: ref },
          deliveryTarget: target,
        },
      })
    ).run;
  }
  return { ...built, root, legacy };
}

test("top-level messages stay at top level while another thread is active", async () => {
  const b = await fixture();
  try {
    await b.legacy("older");
    const first = await b.app.turn(message(undefined, "This schedule is overwhelming"));
    const run = (await b.runs.get(first.runId!))!;
    assert.equal(run.sessionId, "dm:D1");
    assert.equal(run.request.deliveryTarget, "D1");
    const followup = await b.app.turn(message(undefined, "Can't you tell?"));
    assert.equal(followup.runId, run.id);
    assert.equal(followup.steered, true);
    assert.equal((await takePending(b.signals, b.root.id)).length, 0);
  } finally {
    await b.runtime.stop();
  }
});

test("explicit threads steer only their own active conversation", async () => {
  const b = await fixture();
  try {
    const other = await b.app.turn(message("30.1"));
    const update = await b.app.turn(message("10.1", "Are you there?"));
    assert.equal(update.runId, b.root.id);
    assert.equal(update.steered, true);
    assert.equal((await takePending(b.signals, other.runId!)).length, 0);
    const [signal] = await takePending(b.signals, b.root.id);
    assert.equal(signal?.request?.deliveryTarget, "D1:10.1");
  } finally {
    await b.runtime.stop();
  }
});

test("changing model accounts queues in the same Slack thread without steering the old account", async () => {
  const b = await fixture();
  try {
    await completeTurn(b.turnLedger, b.root.id, { status: "ok", reply: "Done" });
    const old = (
      await b.runs.enqueue({
        sessionId: b.root.sessionId,
        request: { ...b.root.request, modelAccount: "openai" },
      })
    ).run;
    const update = await b.app.turn(message("10.1"));
    assert.notEqual(update.runId, old.id);
    assert.notEqual(update.steered, true);
    const queued = (await b.runs.get(update.runId!))!;
    assert.equal(queued.sessionId, b.root.sessionId);
    assert.equal(queued.request.deliveryTarget, "D1:10.1");
    assert.equal(queued.request.modelAccount, "company");
    assert.deepEqual(await takePending(b.signals, old.id), []);
  } finally {
    await b.runtime.stop();
  }
});
