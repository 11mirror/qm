import "../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TurnRequest } from "../../src/types.ts";
import { claimTurn } from "../support/turns.ts";
import { freshApp, actor, mention, overheard, dm, spawnedWorker } from "../support/turn-requests.ts";
import { takePending } from "../support/memory-run-signal-store.ts";

test("spine ON: a mid-turn DM message STEERS the live run instead of forking a second reply", async () => {
  const built = freshApp();
  const channel = "D1";
  const first = await built.app.turn(dm("why did you choose this for me", channel));
  const liveRunId = first.runId!;

  const second = await built.app.turn(dm("@bot why did you choose this", channel));
  assert.equal(second.runId, liveRunId, "the second DM message attached to the LIVE run, not a new turn");
  // The surface can only tell "I joined this run" from "I started it" by this flag; without it
  // both handlers poll the shared run and each posts its reply (the duplicate-message bug).
  assert.equal(second.steered, true, "a joined run is flagged steered so the surface stands down");

  const signals = await takePending(built.signals, liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "steer");
  assert.equal(signals[0]!.text, "@bot why did you choose this");

  const runs = await built.runs.list();
  assert.equal(runs.filter((r) => r.sessionId === `dm:${channel}`).length, 1, "no second run enqueued for the DM");
});

test("a mid-turn message from a DIFFERENT person is attributed and its author durably recorded", async () => {
  const built = freshApp();
  const channel = "C_FOREIGN";
  const root = "100.9";
  const first = await built.app.turn(mention("@bot file the ticket", channel, root));
  const liveRunId = first.runId!;

  const second = await built.app.turn({
    ...mention("you can use my linear key", channel, root),
    actor: { externalId: "U_PAUL", displayName: "Paul" },
  });
  assert.equal(second.runId, liveRunId);
  assert.equal(second.steered, true);

  const signals = await takePending(built.signals, liveRunId);
  assert.equal(signals[0]!.text, "Paul: you can use my linear key", "a foreign human steer names its author");
  assert.deepEqual(
    await built.signals.steerAuthors(liveRunId),
    ["U_PAUL"],
    "the steer author is durably recorded so keychain onBehalfOf can verify them",
  );

  const third = await built.app.turn(mention("also add a screenshot", channel, root));
  assert.equal(third.steered, true);
  assert.equal(
    (await takePending(built.signals, liveRunId))[0]!.text,
    "also add a screenshot",
    "a steer from the turn's own actor stays unprefixed",
  );
});

test("spine ON: a mid-turn message STEERS the live run instead of forking a second turn", async () => {
  const built = freshApp();
  const channel = "C1";
  const root = "100.1";
  const first = await built.app.turn(mention("@bot start the task", channel, root));
  assert.equal(first.status, "queued");
  const liveRunId = first.runId!;

  const second = await built.app.turn(mention("actually make it blue", channel, root));
  assert.equal(second.status, "queued");
  assert.equal(second.runId, liveRunId, "the second message attached to the LIVE run, not a new turn");
  assert.equal(second.steered, true, "a joined run is flagged steered so the surface stands down");

  const signals = await takePending(built.signals, liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "steer");
  assert.equal(signals[0]!.text, "actually make it blue");

  const runs = await built.runs.list();
  assert.equal(runs.filter((r) => r.sessionId === `ch:${channel}:${root}`).length, 1, "no second run was enqueued");
});

test("spine ON: an empty mid-turn message DROPS (attaches to the live run) — no second turn, no signal", async () => {
  const built = freshApp();
  const channel = "C5";
  const root = "500.5";
  const first = await built.app.turn(mention("@bot go", channel, root));
  const liveRunId = first.runId!;
  const empty = await built.app.turn(mention("   ", channel, root));
  assert.equal(empty.runId, liveRunId, "the empty message attached to the live run, not a new turn");
  assert.equal((await takePending(built.signals, liveRunId)).length, 0, "a drop sends no signal");
  const runs = await built.runs.list();
  assert.equal(
    runs.filter((r) => r.sessionId === `ch:${channel}:${root}`).length,
    1,
    "no second run enqueued on a drop",
  );
});

test("spine ON: a bare 'stop' mid-turn routes through the ABORT interrupt (not a steer)", async () => {
  const built = freshApp();
  const channel = "C2";
  const root = "200.2";
  const first = await built.app.turn(mention("@bot do a long thing", channel, root));
  const liveRunId = first.runId!;
  assert.ok(await claimTurn(built.turnLedger, liveRunId));

  const stop = await built.app.turn(mention("stop", channel, root));
  assert.equal(stop.runId, liveRunId, "the stop attached to the live run");
  const signals = await takePending(built.signals, liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "abort", "a bare stop aborts the live run");
});

test("spine ON: an OVERHEARD thread-follow (unprompted, not addressed) STEERS the live run", async () => {
  const built = freshApp();
  const channel = "C6";
  const root = "600.6";
  const first = await built.app.turn(mention("@bot make custom emoji for :gruel:", channel, root));
  const liveRunId = first.runId!;

  const follow = await built.app.turn(overheard("and :caviar:", channel, root));
  assert.equal(follow.runId, liveRunId, "the overheard follow attached to the LIVE run, not a new turn");

  const signals = await takePending(built.signals, liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "steer");
  assert.match(signals[0]!.text!, /: and :caviar:$/, "overheard steer text carries an author label");

  const runs = await built.runs.list();
  assert.equal(runs.filter((r) => r.sessionId === `ch:${channel}:${root}`).length, 1, "no second run enqueued");
});

test("the proxy receives ambient provenance for an unprompted mid-turn coworker update", async () => {
  const metadata: Array<Readonly<Record<string, unknown>> | undefined> = [];
  const built = freshApp({
    provider: "example-screen",
    async classify(input) {
      metadata.push(input.metadata);
      return {
        verdict: { decision: "auto" },
        score: 0.1,
        threshold: 0.7,
        outcome: "benign",
      };
    },
  });
  const first = await built.app.turn(mention("@bot prepare the report", "C-origin", "601.8"));
  await built.app.turn(overheard("ordinary update", "C-origin", "601.8"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal((await takePending(built.signals, first.runId!)).length, 1);
  assert.deepEqual(metadata, [{ surface: "steer", origin: "ambient" }]);
});

test("spine ON: the steer signal carries the message's real surface ts (so the harness can persist + dedupe it)", async () => {
  const built = freshApp();
  const channel = "C8";
  const root = "800.8";
  const first = await built.app.turn(mention("@bot start", channel, root));
  const liveRunId = first.runId!;

  await built.app.turn({
    ...mention("make it blue", channel, root),
    origin: { kind: "human", messageTs: "800.010" },
  });
  await built.app.turn({
    ...overheard("and rounded", channel, root),
    origin: { kind: "ambient", live: true, entryTs: "800.011" },
  });

  const signals = await takePending(built.signals, liveRunId);
  assert.equal(signals.length, 2);
  assert.equal(signals[0]!.ts, "800.010", "addressed steer forwards triggerTs as the persist/dedupe key");
  assert.equal(signals[1]!.ts, "800.011", "unprompted steer forwards entryTs as the persist/dedupe key");
});

test("spine ON: an overheard bare 'stop' folds in as steer text (a bystander does NOT abort)", async () => {
  const built = freshApp();
  const channel = "C7";
  const root = "700.7";
  const first = await built.app.turn(mention("@bot do a long thing", channel, root));
  const liveRunId = first.runId!;

  const stop = await built.app.turn(overheard("stop", channel, root));
  assert.equal(stop.runId, liveRunId);
  const signals = await takePending(built.signals, liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "steer", "an overheard stop steers, it does not abort");
});

test("an ADDRESSED mention never steers into a live UNPROMPTED run — it enqueues its own turn", async () => {
  const built = freshApp();
  const channel = "C9";
  const root = "900.9";
  const first = await built.app.turn(overheard("hm, interesting", channel, root));
  const liveRunId = first.runId!;

  const second = await built.app.turn(mention("@bot why did you do it wrong?", channel, root));
  assert.notEqual(second.runId, liveRunId, "the mention got its own run, not a steer into the detection turn");
  assert.equal(
    (await takePending(built.signals, liveRunId)).length,
    0,
    "no signal was sent to the detection-gated run",
  );
  const runs = await built.runs.list();
  assert.equal(
    runs.filter((r) => r.sessionId === `ch:${channel}:${root}`).length,
    2,
    "the mention enqueued behind the live run",
  );
});

test("an overheard follow still steers a live UNPROMPTED run (a stranded one re-imports from the mirror)", async () => {
  const built = freshApp();
  const channel = "C10";
  const root = "1000.1";
  const first = await built.app.turn(overheard("hm, interesting", channel, root));
  const liveRunId = first.runId!;

  const follow = await built.app.turn(overheard("and another thing", channel, root));
  assert.equal(follow.runId, liveRunId);
  const signals = await takePending(built.signals, liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "steer");
});

test("an addressed bare 'stop' still ABORTS a live UNPROMPTED run", async () => {
  const built = freshApp();
  const channel = "C11";
  const root = "1100.1";
  const first = await built.app.turn(overheard("hm, interesting", channel, root));
  const liveRunId = first.runId!;
  assert.ok(await claimTurn(built.turnLedger, liveRunId));

  const stop = await built.app.turn(mention("stop", channel, root));
  assert.equal(stop.runId, liveRunId, "the stop attached to the live run");
  const signals = await takePending(built.signals, liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "abort");
});

function automationRun(channel: string, root: string): TurnRequest {
  return {
    surface: "slack",
    actor: { externalId: "U-owner" },
    conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [] },
    deliveryTarget: `slack:${channel}:${root}`,
    text: "check the deploy and report back",
    async: true,
    origin: { kind: "automation" },
  };
}

test("a person's reply never steers into a live AUTOMATION run — it enqueues behind it with its own claims", async () => {
  const built = freshApp();
  const channel = "C12";
  const root = "1200.1";
  const first = await built.app.turn(automationRun(channel, root));
  const liveRunId = first.runId!;

  const second = await built.app.turn(mention("@bot also update the shared skill", channel, root));
  assert.notEqual(second.runId, liveRunId, "the person's message got its own run, not a steer into the cron's");
  assert.equal((await takePending(built.signals, liveRunId)).length, 0, "no signal was sent to the automation run");
  const runs = await built.runs.list();
  assert.equal(
    runs.filter((r) => r.sessionId === `ch:${channel}:${root}`).length,
    2,
    "the reply enqueued behind the live automation run",
  );
});

test("a person's verbatim thread-follow (authored detection) also enqueues behind a live AUTOMATION run", async () => {
  const built = freshApp();
  const channel = "C13";
  const root = "1300.1";
  const first = await built.app.turn(automationRun(channel, root));
  const liveRunId = first.runId!;

  const follow = await built.app.turn(overheard("actually, please change the plan", channel, root));
  assert.notEqual(follow.runId, liveRunId, "the authored follow got its own run");
  assert.equal((await takePending(built.signals, liveRunId)).length, 0, "no signal was sent to the automation run");
});

test("an addressed bare 'stop' still ABORTS a live AUTOMATION run", async () => {
  const built = freshApp();
  const channel = "C14";
  const root = "1400.1";
  const first = await built.app.turn(automationRun(channel, root));
  const liveRunId = first.runId!;
  assert.ok(await claimTurn(built.turnLedger, liveRunId));

  const stop = await built.app.turn(mention("stop", channel, root));
  assert.equal(stop.runId, liveRunId, "the stop attached to the live automation run");
  const signals = await takePending(built.signals, liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "abort");
});

test("a SYNTHETIC detection (no live author) still steers a live AUTOMATION run — screened, no authority", async () => {
  const built = freshApp();
  const channel = "C15";
  const root = "1500.1";
  const first = await built.app.turn(automationRun(channel, root));
  const liveRunId = first.runId!;

  const synthetic: TurnRequest = {
    surface: "slack",
    actor: { externalId: "U2" },
    conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [actor] },
    deliveryTarget: `slack:${channel}:${root}`,
    text: "bot posted: build finished",
    async: true,
    origin: { kind: "ambient" },
  };
  const follow = await built.app.turn(synthetic);
  assert.equal(follow.runId, liveRunId, "the synthetic detection folded into the live run as context");
  const signals = await takePending(built.signals, liveRunId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "steer");
});

test("a keyed live turn does NOT steer (it routes to enqueue where it dedupes); an unkeyed one DOES", async () => {
  const built = freshApp();

  const kFirst = await built.app.turn(mention("@bot start", "C14", "1400.1"));
  const keyed = await built.app.turn({
    ...mention("make it green", "C14", "1400.1"),
    idempotencyKey: "slack:evt:1400",
  });
  assert.equal((await takePending(built.signals, kFirst.runId!)).length, 0, "the keyed live turn sent no steer");
  assert.notEqual(keyed.runId, kFirst.runId, "the keyed turn did not fold into the live run");

  const uFirst = await built.app.turn(mention("@bot start", "C14b", "1401.1"));
  const steered = await built.app.turn(mention("make it green", "C14b", "1401.1"));
  assert.equal(steered.runId, uFirst.runId, "the unkeyed live turn folded into the live run");
  const signals = await takePending(built.signals, uFirst.runId!);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "steer");
  assert.equal(signals[0]!.text, "make it green");
});

test("a same-key REDELIVERY of a live keyed turn never steers — it dedupes to the existing run", async () => {
  const built = freshApp();
  const channel = "C17";
  const root = "1700.1";
  const keyed = { ...mention("@bot start the task", channel, root), idempotencyKey: "slack:evt:1700" };
  const first = await built.app.turn(keyed);
  const liveRunId = first.runId!;

  const redelivered = await built.app.turn(keyed);
  assert.equal(redelivered.runId, liveRunId, "the redelivery deduped to the existing run");
  assert.equal(
    (await takePending(built.signals, liveRunId)).length,
    0,
    "no steer injected the redelivered text into the live run",
  );
  const runs = await built.runs.list();
  assert.equal(runs.filter((r) => r.sessionId === `ch:${channel}:${root}`).length, 1, "one run for the message");
});

test("an approval decision reusing the original send's key is never deduped against that turn", async () => {
  const built = freshApp();
  const keyed = { ...dm("run the risky thing", "D18"), idempotencyKey: "web:U1:gesture-18" };
  const first = await built.app.turn(keyed);
  const approved = await built.app.turn({
    ...keyed,
    approval: { requestId: "req-18", approved: true },
  });
  assert.notEqual(approved.runId, first.runId, "the approval enqueued its own run instead of replaying the old one");
  const replayed = await built.app.turn({
    ...keyed,
    approval: { requestId: "req-18", approved: true },
  });
  assert.equal(replayed.runId, approved.runId, "a redelivered copy of the same decision deduped to its run");
});

test("a spawned worker turn never steers — a duplicate spawn DEDUPES at enqueue", async () => {
  const built = freshApp();
  const channel = "C15";
  const askTs = "1500.1";
  const first = await built.app.turn(spawnedWorker(channel, askTs));
  const dup = await built.app.turn(spawnedWorker(channel, askTs));
  assert.equal(dup.runId, first.runId, "the duplicate spawn deduped to the same run");
  assert.equal(
    (await takePending(built.signals, first.runId!)).length,
    0,
    "no steer folded the duplicate's text into the live first run",
  );
  const runs = await built.runs.list();
  assert.equal(
    runs.filter((r) => r.sessionId === `slack:${channel}:ambient:${askTs}`).length,
    1,
    "one run for the batch",
  );
});

test("reverse race: an addressed mention steers into the live ambient run, not a second reply", async () => {
  const built = freshApp();
  const channel = "C16";
  const askTs = "1600.1";
  const ambientRef = `slack:${channel}:ambient:${askTs}`;
  await built.sessions.getOrCreateByThread(ambientRef, "channel", `channel:${channel}`);
  const ambient = await built.app.turn(spawnedWorker(channel, askTs));

  const second = await built.app.turn({
    ...mention("@bot are you on it?", channel, askTs),
    origin: { kind: "human", messageTs: askTs },
  });
  assert.equal(second.runId, ambient.runId, "the mention steered into the LIVE ambient run, not a second reply");
  // NOT flagged steered: the ambient owner is unprompted and stays silent on a refusal/failure,
  // so the addressed caller must keep waiting on the run — it's the only one that would report it.
  assert.equal(second.steered, undefined, "the ambient reverse-race join keeps the addressed caller waiting");
  const signals = await takePending(built.signals, ambient.runId!);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "steer");
  assert.equal(signals[0]!.text, "@bot are you on it?");
});

for (const personalSide of ["ambient", "mention"] as const) {
  test(`reverse race: ${personalSide} personal access cannot share the other run's company account`, async () => {
    const built = freshApp();
    const channel = `C-account-${personalSide}`;
    const askTs = "1600.2";
    const ambientRef = `slack:${channel}:ambient:${askTs}`;
    await built.config.setPersonalModelAuth(personalSide === "ambient" ? "jordan@acme.test" : "U1", true, "openai");
    await built.sessions.getOrCreateByThread(ambientRef, "channel", `channel:${channel}`);
    const ambient = await built.app.turn(spawnedWorker(channel, askTs));
    const second = await built.app.turn({
      ...mention("@bot continue", channel, askTs),
      origin: { kind: "human", messageTs: askTs },
    });
    assert.equal(second.status, "queued");
    assert.notEqual(second.runId, ambient.runId);
    assert.notEqual(second.steered, true);
    assert.deepEqual(await takePending(built.signals, ambient.runId!), []);
    assert.equal(
      (await built.runs.get(second.runId!))?.request.modelAccount,
      personalSide === "mention" ? "openai" : "company",
    );
  });
}

test("spine ON: the FIRST message (no live run) engages normally — no steer", async () => {
  const built = freshApp();
  const channel = "C4";
  const root = "400.4";
  const first = await built.app.turn(mention("@bot hello", channel, root));
  assert.equal(first.status, "queued");
  assert.equal(first.steered, undefined, "an engaged run belongs to its caller — never flagged steered");
  // A fresh engage sends no signal (there was no live run to steer).
  const signals = await takePending(built.signals, first.runId!);
  assert.equal(signals.length, 0);
});
