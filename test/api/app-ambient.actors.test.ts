import "../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { settle } from "../support/settle.ts";
import { quietRuns } from "../support/turns.ts";
import { setChannelInstructions } from "../support/channel-instructions.ts";
import { listFull, freshApp, judged } from "../support/ambient-app.ts";
import { takePending } from "../support/memory-run-signal-store.ts";

test("bot ledger — ignore: an ignored-bot-only delta never wakes the judge and records no row (§3.3)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-botignore";
    await setChannelInstructions(built, container, "watch", "U-admin", { newsbot: { mode: "ignore" } });
    await built.app.ingestSurfaceEvents([
      { container, ts: "1.0", authorName: "NewsBot", text: "big news !engage !post go", bot: true, createdAt: 1 },
    ]);
    await quietRuns(built);
    assert.equal(((await built.posts.pending("slack")) as any[]).length, 0, "an ignored bot never triggers a post");
    assert.equal(
      (await built.ambientJudgments!.list({ scope: container })).length,
      0,
      "an ignored-bot-only delta records no judgment row",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("bot ledger — action tags the bot as a trigger; user sheds the (bot) tag; unlisted bots keep it (§3.3)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    await setChannelInstructions(built, "C-botact", "watch", "U-admin", { deploybot: { mode: "action" } });
    await built.app.ingestSurfaceEvents([
      { container: "C-botact", ts: "1.0", authorName: "DeployBot", text: "deploy finished", bot: true, createdAt: 1 },
    ]);
    await setChannelInstructions(built, "C-botuser", "watch", "U-admin", { helperbot: { mode: "user" } });
    await built.app.ingestSurfaceEvents([
      { container: "C-botuser", ts: "1.0", authorName: "HelperBot", text: "hello team", bot: true, createdAt: 1 },
    ]);
    await setChannelInstructions(built, "C-botunlisted", "watch", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container: "C-botunlisted", ts: "1.0", authorName: "RandomBot", text: "beep boop", bot: true, createdAt: 1 },
    ]);
    await settle(async () => {
      for (const container of ["C-botact", "C-botuser", "C-botunlisted"]) {
        if (!(await listFull(built.ambientJudgments!, { scope: container }))[0]?.prompt) return false;
      }
      return true;
    });
    const act = (await listFull(built.ambientJudgments!, { scope: "C-botact" }))[0]!;
    assert.ok(
      act.prompt!.includes('Posts from bot "DeployBot" are triggers you should act on.'),
      "action bot is tagged as a trigger",
    );
    assert.ok(
      act.prompt!.includes("DeployBot (bot): deploy finished"),
      "action bot still renders with the (bot) suffix",
    );
    const user = (await listFull(built.ambientJudgments!, { scope: "C-botuser" }))[0]!;
    assert.ok(user.prompt!.includes("HelperBot: hello team"), "a user-mode bot renders like a person");
    assert.ok(!user.prompt!.includes("HelperBot (bot)"), "a user-mode bot sheds the (bot) suffix");
    const unlisted = (await listFull(built.ambientJudgments!, { scope: "C-botunlisted" }))[0]!;
    assert.ok(unlisted.prompt!.includes("RandomBot (bot): beep boop"), "an unlisted bot keeps the (bot) suffix");
  } finally {
    await built.runtime.stop();
  }
});

test("bot ledger — rollup holds a rollup-only delta within the window (cursor unadvanced), a human lifts it (§3.3)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-botrollup";
    await setChannelInstructions(built, container, "watch", "U-admin", { newsbot: { mode: "rollup", rollupHours: 6 } });
    await built.app.ingestSurfaceEvents([
      { container, ts: "1.0", authorName: "NewsBot", text: "item 1", bot: true, createdAt: 1 },
    ]);
    await settle(async () => (await built.ambientJudgments!.list({ scope: container })).length > 0);
    assert.equal(
      (await built.ambientJudgments!.list({ scope: container })).length,
      1,
      "the first rollup post is judged",
    );
    await built.app.ingestSurfaceEvents([
      { container, ts: "2.0", authorName: "NewsBot", text: "item 2", bot: true, createdAt: 2 },
    ]);
    await quietRuns(built);
    assert.equal(
      (await built.ambientJudgments!.list({ scope: container })).length,
      1,
      "a rollup-only delta within the window is held (no new row)",
    );
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "3.0",
        authorId: "U1",
        authorName: "Alice",
        text: "any updates? !engage !post here",
        createdAt: 3,
      },
    ]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const posted = await built.posts.pending("slack");
    assert.ok(posted.length >= 1, "a human message lifts the rollup hold and the batch engages");
    const engaged = (
      await judged(built.ambientJudgments!, container, (rows) => rows.some((r: any) => r.decision === "act"))
    ).find((r: any) => r.decision === "act")!;
    assert.ok(engaged.prompt!.includes("item 2"), "the previously-held bot post is re-judged with the human message");
  } finally {
    await built.runtime.stop();
  }
});

test("a solicited ambient wake runs as the asking person, not the system actor", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-solicited";
    await built.directory.replace([
      { principalId: "alice@acme.com", displayName: "Alice", type: "internal", slackId: "U1" },
    ]);
    await built.directory.replaceChannels(
      [{ channelId: container, name: "solicited-chan", isPrivate: false }],
      [{ channelId: container, principalId: "alice@acme.com" }],
    );
    await setChannelInstructions(built, container, "!engage-asked", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container, ts: "300.1", authorId: "U1", authorName: "Alice", text: "!post solicited reply", createdAt: 1 },
    ]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 1, "the solicited worker posted exactly once");
    assert.match(pending[0]!.text, /^solicited reply/);
    const session = await built.sessions.getByThread(`slack:${container}:ambient:300.1`);
    assert.ok(session, "the worker session exists");
    const participants = await built.sessions.participantsOf(session!.id);
    assert.deepEqual(participants, ["alice@acme.com"], "the turn ran as the asking person");
    const rows = await judged(built.ambientJudgments!, container);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.askedBy, "300.1", "asked_by is a first-class judgment field");
    assert.ok(!(rows[0]!.reason ?? "").includes("[asked_by"), "the reason carries no asked_by splice");
  } finally {
    await built.runtime.stop();
  }
});

test("a solicited ambient wake carries the complete channel roster", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-solicited-roster";
    await built.directory.replace([
      { principalId: "alice@acme.com", displayName: "Alice", type: "internal", slackId: "U1" },
      { principalId: "bob@acme.com", displayName: "Bob", type: "internal", slackId: "U2" },
    ]);
    await built.directory.replaceChannels(
      [{ channelId: container, name: "solicited-roster", isPrivate: false }],
      [
        { channelId: container, principalId: "alice@acme.com" },
        { channelId: container, principalId: "bob@acme.com" },
      ],
    );
    await setChannelInstructions(built, container, "!engage-asked", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container, ts: "350.1", authorId: "U1", authorName: "Alice", text: "!sysprompt", createdAt: 1 },
    ]);

    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 1);
    assert.match(pending[0]!.text, /Alice \(alice@acme\.com\)/);
    assert.match(pending[0]!.text, /Bob \(bob@acme\.com\)/);
  } finally {
    await built.runtime.stop();
  }
});

test("an ambient worker in a group DM runs at the group scope, not a fabricated channel scope", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-mpim";
    await setChannelInstructions(
      built,
      container,
      "!engage !post group reply",
      "U-admin",
      undefined,
      undefined,
      undefined,
      "group",
    );
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "400.1",
        authorId: "U1",
        authorName: "Alice",
        text: "who owns the deploy?",
        kind: "group",
        createdAt: 1,
      },
    ]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 1, "the spawned worker posted");
    const session = await built.sessions.getByThread(`slack:${container}:ambient:400.1`);
    assert.ok(session, "the worker session exists");
    assert.equal(session!.type, "group", "the session is group-typed");
    assert.equal(session!.scopeId, `group:${container}`, "the worker acts at the group's own scope");
  } finally {
    await built.runtime.stop();
  }
});

test("a solicited ask in a group DM runs as the asking person via group-membership attestation", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-mpim-solicited";
    await built.directory.replace([
      { principalId: "alice@acme.com", displayName: "Alice", type: "internal", slackId: "U1" },
    ]);
    await built.directory.replaceGroups([{ groupId: container, principalId: "alice@acme.com" }]);
    await setChannelInstructions(
      built,
      container,
      "!engage-asked",
      "U-admin",
      undefined,
      undefined,
      undefined,
      "group",
    );
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "500.1",
        authorId: "U1",
        authorName: "Alice",
        text: "!post group solicited reply",
        kind: "group",
        createdAt: 1,
      },
    ]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 1, "the solicited worker posted exactly once");
    assert.match(pending[0]!.text, /^group solicited reply/);
    const session = await built.sessions.getByThread(`slack:${container}:ambient:500.1`);
    assert.ok(session, "the worker session exists");
    assert.equal(session!.scopeId, `group:${container}`, "and it lives at the group scope");
    const participants = await built.sessions.participantsOf(session!.id);
    assert.deepEqual(participants, ["alice@acme.com"], "the turn ran as the asking person, not the system actor");
  } finally {
    await built.runtime.stop();
  }
});

test("a solicited ask in a group DM whose author is NOT a pushed member degrades to proactive", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-mpim-nonmember";
    await built.directory.replace([
      { principalId: "mallory@acme.com", displayName: "Mallory", type: "internal", slackId: "U9" },
    ]);
    await setChannelInstructions(
      built,
      container,
      "!engage-asked !post proactive fallback",
      "U-admin",
      undefined,
      undefined,
      undefined,
      "group",
    );
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "600.1",
        authorId: "U9",
        authorName: "Mallory",
        text: "can you check this?",
        kind: "group",
        createdAt: 1,
      },
    ]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 1, "the wake still engages (proactively)");
    const session = await built.sessions.getByThread(`slack:${container}:ambient:600.1`);
    assert.ok(session, "the worker session exists");
    const participants = await built.sessions.participantsOf(session!.id);
    assert.deepEqual(participants, [], "degraded to the system actor — no person's authority conferred");
  } finally {
    await built.runtime.stop();
  }
});

test("a solicited verdict for a message that isn't the newest speaker's degrades to proactive", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-disarmed";
    await built.directory.replace([
      { principalId: "alice@acme.com", displayName: "Alice", type: "internal", slackId: "U1" },
      { principalId: "mallory@acme.com", displayName: "Mallory", type: "internal", slackId: "U2" },
    ]);
    await built.directory.replaceChannels([{ channelId: container, name: "disarmed-chan", isPrivate: false }]);
    await setChannelInstructions(built, container, "!engage-asked !post disarmed reply", "U-admin");
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "500.1",
        authorId: "U1",
        authorName: "Alice",
        text: "qm can you check the deploy?",
        createdAt: 1,
      },
      { container, ts: "500.2", authorId: "U2", authorName: "Mallory", text: "unrelated chatter", createdAt: 2 },
    ]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 1, "the wake still engaged, proactively");
    assert.match(pending[0]!.text, /^disarmed reply/);
    const session = await built.sessions.getByThread(`slack:${container}:ambient:500.2`);
    assert.ok(session, "the worker session exists, keyed on the batch's latest ts");
    const participants = await built.sessions.participantsOf(session!.id);
    assert.deepEqual(participants, [], "no person's authority was borrowed");
  } finally {
    await built.runtime.stop();
  }
});

test("a solicited wake in a private channel requires the asker in the pre-pushed membership", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-private";
    await built.directory.replace([
      { principalId: "alice@acme.com", displayName: "Alice", type: "internal", slackId: "U1" },
    ]);
    await built.directory.replaceChannels(
      [{ channelId: container, name: "private-chan", isPrivate: true }],
      [{ channelId: container, principalId: "alice@acme.com" }],
    );
    await setChannelInstructions(built, container, "!engage-asked", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container, ts: "600.1", authorId: "U1", authorName: "Alice", text: "!post private reply", createdAt: 1 },
    ]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 1);
    assert.match(pending[0]!.text, /^private reply/);
    const session = await built.sessions.getByThread(`slack:${container}:ambient:600.1`);
    const participants = await built.sessions.participantsOf(session!.id);
    assert.deepEqual(participants, ["alice@acme.com"], "attested private room confers the asker's authority");
  } finally {
    await built.runtime.stop();
  }
});

test("a solicited wake whose author isn't in the directory degrades to the proactive system actor", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-unknown-asker";
    await setChannelInstructions(built, container, "!engage-asked !post fallback reply", "U-admin");
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "400.1",
        authorId: "U-stranger",
        authorName: "Stranger",
        text: "qm can you check something?",
        createdAt: 1,
      },
    ]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 1, "the fallback worker still posted");
    assert.match(pending[0]!.text, /^fallback reply/);
    const session = await built.sessions.getByThread(`slack:${container}:ambient:400.1`);
    assert.ok(session, "the worker session exists");
    const participants = await built.sessions.participantsOf(session!.id);
    assert.deepEqual(participants, [], "no person was impersonated — the system actor ran the turn");
  } finally {
    await built.runtime.stop();
  }
});

test("a second ambient wake while the first worker is LIVE steers into it instead of forking a sibling reply", async () => {
  const built = freshApp();
  const container = "C-coalesce";
  await setChannelInstructions(built, container, "!engage !post tag the team", "U-admin");

  await built.app.ingestSurfaceEvents([
    { container, ts: "100.1", authorId: "U1", text: "events site is down", createdAt: 1 },
  ]);
  await built.app.judgeAmbientContainer("slack", container);
  const firstRef = `slack:${container}:ambient:100.1`;
  const live = await built.runs.activeForThread(firstRef);
  assert.ok(live, "first wake spawned a live worker run");

  await built.app.ingestSurfaceEvents([
    { container, ts: "100.2", authorId: "U2", text: "same here, meetup page too", createdAt: 2 },
  ]);
  let signals: any[] = [];
  await settle(async () => (signals = await takePending(built.signals, live!.id)).length > 0);
  assert.equal(signals.length, 1, "the second wake steered the live run");
  assert.equal(signals[0]!.kind, "steer");
  assert.match(signals[0]!.text!, /meetup page too/);
  assert.ok(signals[0]!.request, "the steer carries its request for terminal-drain replay");
  const runs = await built.runs.list();
  assert.equal(
    runs.filter((r) => r.sessionId.startsWith(`slack:${container}:ambient:`)).length,
    1,
    "no sibling worker run was enqueued",
  );
});
