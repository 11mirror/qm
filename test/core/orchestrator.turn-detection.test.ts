import "../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isOverheard, isUserMessage, messageTs, type Item } from "../../src/sessions/items.ts";
import { freshApp, internalActor, dm, channel } from "../support/orchestrator-app.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTestApp } from "../support/test-app.ts";
import { scopeId, type TurnRequest } from "../../src/types.ts";
import { testConfig } from "../support/test-config.ts";

test("an unexpected turn fault is recorded to the error log (then rethrown → 500)", async () => {
  const { app, errors } = freshApp();
  await assert.rejects(app.turn(dm("!boom")), /boom: simulated turn fault/);
  const turnError = (await errors.list()).find((e) => e.category === "turn" && e.code === "error");
  assert.ok(turnError, "the turn fault should be recorded in the error log");
  assert.match(turnError!.message, /boom/);
  assert.ok(turnError!.sessionId, "the recorded error carries the session id for triage");
});

test("an unprompted thread message the colleague wouldn't answer is silent (no run, no writes)", async () => {
  const { app } = freshApp();
  const res = await app.turn(channel("ok sounds good to me", { origin: { kind: "ambient" as const } }));
  assert.equal(res.status, "silent");
  assert.ok(res.sessionId);
  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    [],
  );
});

test("a poll fire that ends with no message resolves to silent, not a delivered empty reply", async () => {
  const { app } = freshApp();
  const cron = {
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm" as const, threadRef: "dm:U1:cron" },
    text: "!silent",
    origin: { kind: "automation" as const },
  };
  const res = await app.turn(cron);
  assert.equal(res.status, "silent", "the agent had nothing to add, so the turn is silent");
  assert.ok(res.sessionId, "the turn still ran — it's silent, not skipped");
});

test("a poll fire whose reply is a bracketed token is an ordinary reply; only finish_silently silences it", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron2" },
    text: "!run printf %s 'Nothing changed.\n\n[no-update]'",
    origin: { kind: "automation" },
  });
  assert.equal(res.status, "ok");
  assert.equal(res.reply, "Nothing changed.\n\n[no-update]");
  const silenced = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron2b" },
    text: "!finish-silent",
    origin: { kind: "automation" },
  });
  assert.equal(silenced.status, "silent");
});

test("a poll fire with a real reply still delivers (status ok), and a non-triggered empty reply is not silenced", async () => {
  const { app } = freshApp();
  const real = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron3" },
    text: "!run printf %s 'PTO is due today'",
    origin: { kind: "automation" },
  });
  assert.equal(real.status, "ok");
  assert.match(real.reply ?? "", /PTO is due today/);
  const interactive = await app.turn(dm("!silent"));
  assert.notEqual(interactive.status, "silent");
});

test("a poll fire whose only output is an attached file delivers it — files, not silence", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron6" },
    text: "!writeattach digest.png PNG",
    origin: { kind: "automation" },
  });
  assert.equal(res.status, "ok", "files are a real update — the empty reply must not silence the fire");
  assert.equal(res.reply, "");
  assert.deepEqual(
    (res.attachments ?? []).map((a) => a.name),
    ["digest.png"],
  );
});

test("a poll fire that attaches a file and then finishes silently still delivers the file", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron7" },
    text: "!attachsilent digest.png PNG",
    origin: { kind: "automation" },
  });
  assert.equal(res.status, "ok", "the file was confirmed to the model, so silence must not discard it");
  assert.deepEqual(
    (res.attachments ?? []).map((a) => a.name),
    ["digest.png"],
  );
});

test("a poll fire that calls finish_silently ends the turn with an empty reply and resolves to silent", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron4" },
    text: "!finish-silent",
    origin: { kind: "automation" },
  });
  assert.equal(res.status, "silent", "the tool terminates the turn — the empty closing reply is the silence");
  assert.equal(res.reply, undefined, "nothing is delivered — the model never gets a step to narrate its silence");
});

test("finish_silently is a no-op off a poll fire — the agent's reply still delivers", async () => {
  const { app } = freshApp();
  const interactive = await app.turn(dm("!finish-silent"));
  assert.notEqual(interactive.status, "silent", "a person is waiting, so the turn is never silenced");
  assert.match(interactive.reply ?? "", /ending silently/);
});

test("finish_silently on a poll fire wins over a coexisting collected approval", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron5" },
    text: "!finish-silent-approval",
    origin: { kind: "automation" },
  });
  assert.equal(res.status, "silent", "explicit silence must win over the pending-approval branch");
  assert.equal(res.reply, undefined, "no narration leaks");
  assert.equal(res.pendingApprovals, undefined, "no approval prompt is surfaced on a silenced poll fire");
});

test("a poll fire that PAUSED on a gated command is never silenced — the approval persists", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: internalActor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron7" },
    text: "!finish-silent-paused",
    origin: { kind: "automation" },
  });
  assert.equal(
    res.status,
    "pending_approval",
    "a paused turn outranks explicit silence — silencing it would starve the cron with no trace",
  );
  assert.ok(res.pendingApprovals?.length, "the approval stays durable so it can be approved and the run resumed");
});

test("an unprompted acknowledgement gets an emoji reaction, not a reply (no run, no writes)", async () => {
  const { app } = freshApp();
  const res = await app.turn(channel("thanks, that's perfect", { origin: { kind: "ambient" } }));
  assert.equal(res.status, "react");
  assert.ok((res.reactions ?? []).length > 0);
  assert.ok(res.sessionId);
  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    [],
  );
});

test("on a surface without reactions, the same acknowledgement just stays silent (no REACT leaks)", async () => {
  const { app } = freshApp();
  const res = await app.turn(
    channel("thanks, that's perfect", { gatewayContext: undefined, origin: { kind: "ambient" } }),
  );
  assert.equal(res.status, "silent");
  assert.equal((res.reactions ?? []).length, 0);
  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    [],
  );
});

test("an unprompted thread question gets a reply (turn detection chimes in)", async () => {
  const { app } = freshApp();
  const res = await app.turn(channel("what does everyone think about the rollout?", { origin: { kind: "ambient" } }));
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /You said: what does everyone think/);
  const found = await app.getSession(res.sessionId!);
  assert.deepEqual(
    found!.items.map((e) => e.kind),
    ["UserMessage", "AgentMessage"],
  );
});

test("priorTurns are routed to the harness as structured roled turns (PR3)", async () => {
  const { app } = freshApp();
  const res = await app.turn(
    channel("!priorturns", {
      priorTurns: [
        { role: "user", name: "U2", text: "I think we ship Friday" },
        { role: "user", name: "U3", text: "I'd wait for QA" },
        { role: "assistant", text: "let me check the dashboard" },
      ],
      origin: { kind: "ambient" },
    }),
  );
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /user\/U2: I think we ship Friday/);
  assert.match(res.reply ?? "", /user\/U3: I'd wait for QA/);
  assert.match(res.reply ?? "", /assistant: let me check the dashboard/);
});

test("overheard messages are imported ONCE into the durable log, author-labeled, and handed to the harness", async () => {
  const { app, sessions } = freshApp();
  const entryBatches: number[] = [];
  const appendMany = sessions.appendMany.bind(sessions);
  sessions.appendMany = async (lease, entries) => {
    if (entries.some((entry) => entry.body?.overheard === true)) entryBatches.push(entries.length);
    return appendMany(lease, entries);
  };
  const overheardEntries = (entries: Item[]) => entries.filter((e) => isOverheard(e));

  const r1 = await app.turn(
    channel("!overheard", {
      overheard: [
        { ts: "100.001", role: "user", name: "Alice", text: "I posted a cat photo", files: ["cat.jpg"] },
        { ts: "100.002", role: "self", text: "nice cat" },
        { ts: "100.003", role: "user", name: "Bob", text: "love it" },
      ],
    }),
  );
  assert.equal(r1.status, "ok");
  assert.match(r1.reply ?? "", /Alice@100\.001: I posted a cat photo \[cat\.jpg\]/);
  assert.match(r1.reply ?? "", /Bob@100\.003: love it/);
  assert.match(r1.reply ?? "", /nice cat/);

  const s1 = await app.getSession(r1.sessionId!);
  const ov1 = overheardEntries(s1!.items);
  assert.deepEqual(
    ov1.map((e) => messageTs(e)),
    ["100.001", "100.002", "100.003"],
  );
  assert.equal((ov1[1]!.body as { sourceRole: string }).sourceRole, "agent");
  assert.equal((ov1[0]!.body as { name: string }).name, "Alice");
  assert.ok(ov1.every((entry) => entry.body.speakerId === undefined));
  assert.deepEqual((ov1[0]!.body as { files: string[] }).files, ["cat.jpg"]);

  const r2 = await app.turn(
    channel("!overheard", {
      overheard: [
        { ts: "100.001", role: "user", name: "Alice", text: "I posted a cat photo", files: ["cat.jpg"] },
        { ts: "100.002", role: "self", text: "nice cat" },
        { ts: "100.003", role: "user", name: "Bob", text: "love it" },
        { ts: "100.004", role: "user", name: "Carol", text: "me too" },
      ],
    }),
  );
  assert.equal(r2.status, "ok");
  assert.match(r2.reply ?? "", /Carol@100\.004: me too/);
  assert.doesNotMatch(r2.reply ?? "", /Alice@100\.001/);

  const s2 = await app.getSession(r2.sessionId!);
  const ov2 = overheardEntries(s2!.items);
  assert.deepEqual(
    ov2.map((e) => messageTs(e)),
    ["100.001", "100.002", "100.003", "100.004"],
    "append-only: each message recorded exactly once",
  );
  assert.deepEqual(entryBatches, [3, 1]);
});

test("a message answered on one turn is not re-imported as overheard on the next (full-stack dedupe)", async () => {
  const { app } = freshApp();
  const overheardEntries = (entries: Item[]) => entries.filter((e) => isOverheard(e));

  const r1 = await app.turn(
    channel("run it now on the first 20 emails", { origin: { kind: "human", messageTs: "200.001" } }),
  );
  assert.equal(r1.status, "ok");
  const s1 = await app.getSession(r1.sessionId!);
  const trigger = s1!.items.find((e) => isUserMessage(e) && messageTs(e) === "200.001");
  assert.ok(trigger, "the trigger entry carries its surface ts");
  assert.match(
    String(trigger!.text ?? ""),
    /run it now on the first 20 emails/,
    "the addressed message rides the recorded entry",
  );

  const r2 = await app.turn(
    channel("did that work?", {
      overheard: [{ ts: "200.001", role: "user", name: "Avery", text: "run it now on the first 20 emails" }],
      origin: { kind: "human", messageTs: "200.002" },
    }),
  );
  assert.equal(r2.status, "ok");
  const s2 = await app.getSession(r2.sessionId!);
  assert.deepEqual(
    overheardEntries(s2!.items).map((e) => messageTs(e)),
    [],
    "the just-answered message is not doubled as overheard",
  );
  const withText = s2!.items.filter(
    (e) => isUserMessage(e) && String(e.text ?? "").includes("run it now on the first 20 emails"),
  );
  assert.equal(withText.length, 1, "recorded exactly once");
});

test("an unprompted thread-follow (no triggerTs) is stamped via entryTs and not re-imported as overheard", async () => {
  const { app } = freshApp();
  const overheardEntries = (entries: Item[]) => entries.filter((e) => isOverheard(e));

  const followText = "should I actually skip the last one?";
  const r1 = await app.turn(channel(followText, { origin: { kind: "ambient", entryTs: "300.001" } }));
  assert.equal(r1.status, "ok");
  const s1 = await app.getSession(r1.sessionId!);
  const trigger = s1!.items.find((e) => isUserMessage(e) && messageTs(e) === "300.001");
  assert.ok(trigger, "the unprompted-follow entry carries its surface ts via entryTs");

  const r2 = await app.turn(
    channel("ok done?", {
      overheard: [{ ts: "300.001", role: "user", name: "Avery", text: followText }],
      origin: { kind: "human", messageTs: "300.002" },
    }),
  );
  assert.equal(r2.status, "ok");
  const s2 = await app.getSession(r2.sessionId!);
  assert.deepEqual(
    overheardEntries(s2!.items).map((e) => messageTs(e)),
    [],
    "the unprompted follow is not doubled as overheard",
  );
  const withText = s2!.items.filter((e) => isUserMessage(e) && String(e.text ?? "").includes(followText));
  assert.equal(withText.length, 1, "recorded exactly once");
});

test("turn file context leads the environment block before the conversation header", async () => {
  const { app, blobTransfer } = freshApp();
  const blob = await blobTransfer.put(Buffer.from("notes"));

  const res = await app.turn(
    channel("what should I do with this?", {
      conversationHeader: "You are in #eng. People here: @Alice, @Bob. You are replying to a top-level message.",
      attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
    }),
  );

  assert.equal(res.status, "ok");
  const reply = res.reply ?? "";
  const requestAt = reply.indexOf("what should I do with this?");
  const envAt = reply.indexOf("<environment>");
  const inboxAt = reply.indexOf("The user shared 1 file");
  const headerAt = reply.indexOf("You are in #eng");
  const envEndAt = reply.indexOf("</environment>");
  assert.notEqual(requestAt, -1, "expected live user request");
  assert.notEqual(envAt, -1, "expected environment block");
  assert.notEqual(inboxAt, -1, "expected inbound attachment manifest");
  assert.notEqual(headerAt, -1, "expected conversation header");
  assert.notEqual(envEndAt, -1, "expected environment block close");
  assert.ok(requestAt < envAt, "live user request remains the leading turn content");
  assert.ok(envAt < inboxAt, "file manifest should be inside the environment block");
  assert.ok(inboxAt < headerAt, "file manifest should precede the conversation header");
  assert.ok(headerAt < envEndAt, "conversation header should remain inside the environment block");
});

test("the situational conversationHeader rides in the <environment> block, not as a message list", async () => {
  const { app } = freshApp();
  const res = await app.turn(
    channel("@agent is this possible?", {
      conversationHeader: "You are in #design. People here: @U2, @U3. You are replying in a thread @U2 started.",
      priorTurns: [{ role: "user", name: "U2", text: "here's the original idea that started this thread" }],
    }),
  );
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /<environment>/);
  assert.match(res.reply ?? "", /People here: @U2, @U3/);
  const found = await app.getSession(res.sessionId!);
  const userEntry = found!.items.find((e) => isUserMessage(e));
  const userText = userEntry!.text ?? "";
  assert.doesNotMatch(userText, /original idea that started this thread/);
  assert.equal(userText, "@agent is this possible?");
  assert.doesNotMatch(userText, /<environment>/);
});

test("a reply in a thread the agent STARTED chimes in, even as a bare statement (deploy-notification-reply bug)", async () => {
  const { app } = freshApp();
  const bare = await app.turn(channel("looks good to me", { origin: { kind: "ambient" } }));
  assert.equal(bare.status, "silent");
  const withOpener = await app.turn(
    channel("looks good to me", {
      detectOpener: "deploy abc123 — auth refactor (#125)",
      origin: { kind: "ambient" },
    }),
  );
  assert.equal(withOpener.status, "ok");
});

test("detectOpener drives turn detection but is NOT rendered into the prompt", async () => {
  const { app } = freshApp();
  const res = await app.turn(
    channel("looks good to me", {
      detectOpener: "deploy abc123 — auth refactor (#125)",
      origin: { kind: "ambient" },
    }),
  );
  assert.equal(res.status, "ok");
  assert.doesNotMatch(res.reply ?? "", /auth refactor/);
});

test("an explicit (prompted) thread message always runs, even as a plain statement", async () => {
  const { app } = freshApp();
  const res = await app.turn(channel("ok sounds good to me"));
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /You said: ok sounds good/);
});

test("read/write round-trip through the workspace", async () => {
  const { app } = freshApp();
  const w = await app.turn(dm("!write notes.md hello-workspace"));
  assert.equal(w.status, "ok");
  const r = await app.turn(dm("!read notes.md"));
  assert.equal(r.status, "ok");
  assert.match(r.reply ?? "", /hello-workspace/);
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pollFireApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-pollsilence-"));
  return buildTestApp(testConfig({ dataDir }));
}

function monitorFire(text: string, channel: string, root: string, fireKey: string): TurnRequest {
  return {
    surface: "monitor",
    actor: { externalId: "U1" },
    conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel },
    text,
    surfaceTools: true,
    addressed: true,
    idempotencyKey: fireKey,
    async: false,
    origin: {
      kind: "automation",
      destination: {
        type: "slack",
        target: `slack:${channel}:${root}`,
        audienceScopeId: scopeId("channel", channel),
      },
    },
  };
}

async function slackDeliveries(outbound: { pending(type: string): Promise<unknown[]> }): Promise<any[]> {
  return (await outbound.pending("slack")) as any[];
}

test("poll fire: narration before a tool call is NOT auto-posted as an ack when the turn ends silently", async () => {
  const built = pollFireApp();
  built.runtime.start();
  try {
    const res = await built.app.turn(
      monitorFire("!preamble-then-quiet Still queued — silent.", "C-watch", "800.1", "monitor:m1:f1"),
    );
    assert.equal(res.status, "silent", "the model finished silently — the turn is silent");
    await sleep(300);
    assert.deepEqual(
      (await slackDeliveries(built.posts)).map((d) => d.text),
      [],
      "no mid-turn narration leaks to the surface on a background fire that ends silent",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("poll fire: a closing reply ending in a bracketed token is delivered, since only finish_silently silences", async () => {
  const built = pollFireApp();
  built.runtime.start();
  try {
    const res = await built.app.turn(monitorFire("Still queued.\n\n[no-update]", "C-watch2", "801.1", "monitor:m1:f2"));
    assert.equal(res.status, "silent", "surfaceTools turn: delivery happens via the surface, result is silent");
    await sleep(300);
    const texts = (await slackDeliveries(built.posts)).map((d) => d.text);
    assert.equal(texts.length, 1, JSON.stringify(texts));
    assert.match(texts[0]!, /You said: Still queued\.\n\n\[no-update\]/);
  } finally {
    await built.runtime.stop();
  }
});

test("poll fire: a genuine report is still delivered exactly once, buffered to the end of the turn", async () => {
  const built = pollFireApp();
  built.runtime.start();
  try {
    const res = await built.app.turn(
      monitorFire("!preamble Deploy finished — all green.", "C-watch3", "802.1", "monitor:m1:f3"),
    );
    assert.equal(res.status, "silent", "surfaceTools turn: delivery happens via the surface, result is silent");
    await sleep(300);
    const texts = (await slackDeliveries(built.posts)).map((d) => d.text);
    assert.equal(texts.length, 1, `exactly one delivery, buffered to turn end (got: ${JSON.stringify(texts)})`);
    assert.match(texts[0]!, /Deploy finished — all green\./, "the full report text is delivered");
    assert.match(texts[0]!, /All clear — nothing broke\./, "the trailing reply text is included");
  } finally {
    await built.runtime.stop();
  }
});

test("interactive mention: the first-block ack still posts immediately (unchanged)", async () => {
  const built = pollFireApp();
  built.runtime.start();
  try {
    await built.app.turn({
      surface: "slack",
      actor: { externalId: "U1" },
      conversation: {
        kind: "channel",
        threadRef: "ch:C-live:900.1",
        channelRef: "C-live",
        audience: [{ externalId: "U1" }],
      },
      deliveryTarget: "slack:C-live:900.1",
      text: "!preamble On it — checking.",
      async: true,
      origin: { kind: "human" },
    });
    const deadline = Date.now() + 5_000;
    let ack: any;
    while (Date.now() < deadline && !ack) {
      ack = (await slackDeliveries(built.posts)).find((d) => d.text === "On it — checking.");
      if (!ack) await sleep(50);
    }
    assert.ok(ack, "a person is waiting: the ack still posts mid-turn");
  } finally {
    await built.runtime.stop();
  }
});
