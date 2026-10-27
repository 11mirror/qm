import assert from "node:assert/strict";
import { test } from "node:test";
import { settle } from "../support/settle.ts";
import { fixture } from "../support/slack-plugin.ts";

test("an unreadable channel roster fails closed before core or mirror ingestion", async () => {
  const f = await fixture();
  try {
    f.client.membershipFailures.add("C1");
    await f.app.emitEvent("app_mention", {
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text: "<@UBOT> hello",
      ts: "103.2",
    });
    assert.equal(f.core.turns.length, 0);
    assert.equal(f.core.ingests.length, 0);
    assert.equal(f.client.ephemerals.length, 1);
  } finally {
    await f.stop();
  }
});

test("the admin external-participant toggle permits capability without hiding the guest audience", async () => {
  const f = await fixture({ externalParticipants: true });
  try {
    const event = { channel: "CX", channel_type: "channel", user: "U1", text: "<@UBOT> collaborate", ts: "103.3" };
    f.client.messagesByChannel.set("CX", [event]);
    await f.app.emitEvent("app_mention", event);
    assert.equal(f.core.turns.length, 1);
    assert.equal(
      f.core.turns[0].conversation.audience.some((a: any) => a.externalId === "UX" && a.isExternalGuest),
      true,
    );
    assert.equal(f.client.posts[0].text, "agent reply");
    assert.equal(
      f.core.ingests.flat().some((e: any) => e.ts === "103.3"),
      true,
    );
  } finally {
    await f.stop();
  }
});

test("a core boundary refusal stays requester-only in a channel", async () => {
  const f = await fixture({ externalParticipants: true });
  try {
    f.core.result = { status: "refused", reason: "conversation must be fully internal" };
    const event = { channel: "CX", channel_type: "channel", user: "U1", text: "<@UBOT> collaborate", ts: "103.4" };
    f.client.messagesByChannel.set("CX", [event]);
    await f.app.emitEvent("app_mention", event);
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.client.posts.length, 0);
    assert.equal(f.client.ephemerals.length, 1);
    assert.match(f.client.ephemerals[0].text, /fully internal/);
  } finally {
    await f.stop();
  }
});

test("a blocked-thread result without approval details tells only the sender instead of posting a dead approval card", async () => {
  const f = await fixture();
  try {
    f.core.result = {
      status: "pending_approval",
      sessionId: "S1",
      reason: "This conversation is waiting for someone else to resolve a pending approval.",
    };
    const event = { channel: "C1", channel_type: "channel", user: "U2", text: "<@UBOT> any update?", ts: "105.1" };
    f.client.messagesByChannel.set("C1", [event]);
    await f.app.emitEvent("app_mention", event);
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.client.posts.length, 0, "no public post and no approval buttons for a non-requester");
    assert.equal(f.client.ephemerals.length, 1);
    assert.match(f.client.ephemerals[0].text, /waiting for someone else/);
    assert.equal(f.client.ephemerals[0].blocks, undefined);
  } finally {
    await f.stop();
  }
});

test("a DM thread reply carries its reply thread as a typed Slack source field", async () => {
  const f = await fixture();
  try {
    await f.app.emitMessage({
      channel: "D1",
      channel_type: "im",
      user: "U1",
      text: "and this?",
      ts: "100.2",
      thread_ts: "100.1",
    });
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.core.turns[0].conversation.kind, "dm");
    assert.equal(f.core.turns[0].source.replyThread, "100.1");
  } finally {
    await f.stop();
  }
});

test("an internal channel mention carries the complete audience and thread context", async () => {
  const f = await fixture();
  try {
    const event = { channel: "C1", channel_type: "channel", user: "U1", text: "<@UBOT> status?", ts: "104.1" };
    f.client.messagesByChannel.set("C1", [event]);
    await f.app.emitEvent("app_mention", event);
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.core.turns[0].text, "@qmbot status?");
    assert.equal(f.core.turns[0].conversation.threadRef, "ch:C1:104.1");
    assert.equal(f.core.turns[0].conversation.channelRef, "C1");
    assert.deepEqual(f.core.turns[0].conversation.audience.map((a: any) => a.externalId).sort(), ["U1", "U2"]);
    assert.equal(f.core.turns[0].deliveryTarget, "C1:104.1");
    assert.equal(f.client.posts[0].thread_ts, "104.1");
    assert.equal(
      f.core.ingests.flat().some((e: any) => e.ts === "104.1" && e.handled && e.mentionsSelf),
      true,
    );
  } finally {
    await f.stop();
  }
});

test("an unaddressed top-level channel message is mirrored but never becomes a turn", async () => {
  const f = await fixture();
  try {
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      user: "U2",
      text: "ambient update",
      ts: "104.2",
    });
    assert.equal(f.core.turns.length, 0);
    assert.equal(f.client.posts.length, 0);
    assert.equal(
      f.core.ingests.flat().some((e: any) => e.ts === "104.2" && e.text === "ambient update" && !e.handled),
      true,
    );
  } finally {
    await f.stop();
  }
});

test("a group-DM thread-follow runs unprompted yet attests its author's liveness", async () => {
  const f = await fixture();
  try {
    f.client.channelsById.set("G1", { id: "G1", name: "", is_member: true, is_private: true, is_mpim: true });
    f.client.membersByChannel.set("G1", ["U1", "U2", "UBOT"]);
    f.client.messagesByChannel.set("G1", [
      { channel: "G1", user: "U1", text: "kick off", ts: "300.1" },
      { channel: "G1", user: "UBOT", text: "on it", ts: "300.2", thread_ts: "300.1" },
    ]);
    await f.app.emitMessage({
      channel: "G1",
      channel_type: "mpim",
      user: "U2",
      text: "also update the skill",
      ts: "300.3",
      thread_ts: "300.1",
    });
    assert.equal(f.core.turns.length, 1);
    assert.deepEqual(
      f.core.turns[0].origin,
      { kind: "ambient", entryTs: "300.3", live: true },
      "a member's own verbatim follow-up is a live act",
    );
    assert.equal(f.core.turns[0].conversation.kind, "group");
    assert.equal(f.core.turns[0].conversation.threadRef, "grp:G1:300.1");
  } finally {
    await f.stop();
  }
});

test("a message from an unseen group DM resyncs the directory so it becomes addressable", async () => {
  const f = await fixture();
  try {
    f.client.channelsById.set("G9", { id: "G9", name: "", is_member: true, is_private: true, is_mpim: true });
    f.client.membersByChannel.set("G9", ["U1", "U2", "UBOT"]);
    const listedBefore = f.client.groupListings;
    await f.app.emitMessage({ channel: "G9", channel_type: "mpim", user: "U1", text: "hi", ts: "400.1" });
    await settle(() => f.client.groupListings > listedBefore);
    await settle(() => (f.core.directories.at(-1)?.groupMembers ?? []).some((g: any) => g.groupId === "G9"));
    assert.deepEqual(
      f.core.directories
        .at(-1)
        .groupMembers.filter((g: any) => g.groupId === "G9")
        .map((g: any) => g.principalId)
        .sort(),
      ["U1", "U2"],
      "the new group's internal roster reaches core, bot excluded",
    );

    const listedAfter = f.client.groupListings;
    await f.app.emitMessage({ channel: "G9", channel_type: "mpim", user: "U1", text: "again", ts: "400.2" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.client.groupListings, listedAfter, "a group DM already seen does not resync on every message");
  } finally {
    await f.stop();
  }
});

test("a failed group listing pushes its fallback rows under the OLD stamp, never a fresh one", async () => {
  const f = await fixture();
  try {
    f.client.channelsById.set("G7", { id: "G7", name: "", is_member: true, is_private: true, is_mpim: true });
    f.client.membersByChannel.set("G7", ["U1", "U2", "UBOT"]);
    await f.app.emitMessage({ channel: "G7", channel_type: "mpim", user: "U1", text: "hi", ts: "402.1" });
    await settle(() =>
      f.core.directories.some((d: any) => (d.groupMembers ?? []).some((g: any) => g.groupId === "G7")),
    );
    const goodStamp = f.core.directories.findLast((d: any) => d.groupsSyncedAt !== undefined).groupsSyncedAt;
    assert.ok(goodStamp > 0);

    f.client.failGroupListing = true;
    f.client.channelsById.set("G6", { id: "G6", name: "", is_member: true, is_private: true, is_mpim: true });
    await f.app.emitMessage({ channel: "G6", channel_type: "mpim", user: "U1", text: "hi", ts: "402.2" });
    await settle(() => f.core.directories.findLast((d: any) => d.channels)?.channelsSyncedAt > goodStamp);
    const last = f.core.directories.findLast((d: any) => d.channels);
    assert.equal(
      last.groupMembers,
      undefined,
      "a failed group listing must omit the groups section, never ship rows under a fresh stamp",
    );
  } finally {
    await f.stop();
  }
});

test("a failed group member read marks only that roster unknown", async () => {
  const f = await fixture();
  try {
    f.client.channelsById.set("G5", { id: "G5", name: "", is_member: true, is_private: true, is_mpim: true });
    f.client.membersByChannel.set("G5", ["U1", "U2", "UBOT"]);
    await f.app.emitMessage({ channel: "G5", channel_type: "mpim", user: "U1", text: "hi", ts: "403.1" });
    await settle(() =>
      f.core.directories.some((d: any) => (d.groupMembers ?? []).some((g: any) => g.groupId === "G5")),
    );
    const good = f.core.directories.findLast((d: any) => d.groupsSyncedAt !== undefined);
    f.client.membershipFailures.add("G5");
    const pushes = f.core.directories.length;
    await f.app.emitMessage({ channel: "G5", channel_type: "mpim", subtype: "group_join", ts: "403.2" });
    await settle(() => f.core.directories.length > pushes);
    const last = f.core.directories.at(-1);
    assert.ok(last.groupsSyncedAt > good.groupsSyncedAt);
    assert.ok(last.groupIds.includes("G5"));
    assert.ok(!last.groupRosterIds.includes("G5"));
    assert.equal(last.groupMembers.filter((member: any) => member.groupId === "G5").length, 0);
  } finally {
    await f.stop();
  }
});

test("all listed group DMs reach the directory past the legacy private-channel cap", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 51; i++) {
      const id = `G${i}`;
      f.client.channelsById.set(id, { id, name: "", is_member: true, is_private: true, is_mpim: true });
      f.client.membersByChannel.set(id, ["U1", "U2", "UBOT"]);
    }
    const pushes = f.core.directories.length;
    await f.app.emitMessage({ channel: "G0", channel_type: "mpim", subtype: "group_join", ts: "403.3" });
    await settle(() => f.core.directories.length > pushes);
    assert.equal(new Set(f.core.directories.at(-1).groupMembers.map((member: any) => member.groupId)).size, 51);
  } finally {
    await f.stop();
  }
});

test("a group DM whose listing fails is retried at most once, never once per message", async () => {
  const f = await fixture();
  try {
    f.client.channelsById.set("G8", { id: "G8", name: "", is_member: true, is_private: true, is_mpim: true });
    f.client.membersByChannel.set("G8", ["U1", "U2", "UBOT"]);
    f.client.failGroupListing = true;
    const listedBefore = f.client.groupListings;
    for (const ts of ["401.1", "401.2", "401.3"]) {
      await f.app.emitMessage({ channel: "G8", channel_type: "mpim", user: "U1", text: "hi", ts });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      f.client.groupListings - listedBefore,
      1,
      "a failing listing must not make every message trigger another full sync",
    );
  } finally {
    await f.stop();
  }
});

test("a peer bot's thread reply dispatches without attesting liveness", async () => {
  const f = await fixture();
  try {
    f.client.usersById.set("UB2", { id: "UB2", team_id: "T1", name: "copilot", is_bot: true });
    f.client.membersByChannel.set("C1", ["U1", "U2", "UB2", "UBOT"]);
    f.client.messagesByChannel.set("C1", [
      { channel: "C1", user: "U1", text: "kick off", ts: "301.1" },
      { channel: "C1", user: "UBOT", text: "on it", ts: "301.2", thread_ts: "301.1" },
    ]);
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      subtype: "bot_message",
      user: "UB2",
      text: "automated status: done",
      ts: "301.3",
      thread_ts: "301.1",
    });
    assert.equal(f.core.turns.length, 1);
    assert.deepEqual(
      f.core.turns[0].origin,
      { kind: "ambient", entryTs: "301.3" },
      "a bot author is automation, never a live act",
    );
  } finally {
    await f.stop();
  }
});

test("an untrusted inbound file URL is never fetched and reaches core only as a missing-file note", async (t) => {
  const f = await fixture();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("untrusted URL was fetched");
  });
  try {
    await f.app.emitMessage({
      channel: "D1",
      channel_type: "im",
      user: "U1",
      text: "inspect this",
      ts: "104.3",
      files: [{ id: "F1", name: "payload.txt", url_private_download: "https://evil.example/payload.txt" }],
    });
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.core.turns[0].attachments, undefined);
    assert.match(f.core.turns[0].inboundNotes[0], /payload\.txt/);
  } finally {
    await f.stop();
  }
});

test("message edits and deletes update the mirror without creating turns", async () => {
  const f = await fixture();
  try {
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      subtype: "message_changed",
      message: { channel_type: "channel", user: "U1", text: "edited", ts: "105.1" },
      ts: "105.2",
    });
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      subtype: "message_deleted",
      deleted_ts: "105.1",
      ts: "105.3",
    });
    assert.equal(f.core.turns.length, 0);
    const events = f.core.ingests.flat();
    assert.equal(
      events.some((e: any) => e.ts === "105.1" && e.text === "edited" && typeof e.editedAt === "number"),
      true,
    );
    assert.equal(
      events.some((e: any) => e.ts === "105.1" && e.deleted === true),
      true,
    );
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      subtype: "message_changed",
      message: { channel_type: "channel", user: "U1", text: "unfurled", ts: "105.7" },
      previous_message: { user: "U1", text: "unfurled" },
      ts: "105.8",
    });
    const unfurl = f.core.ingests.flat().find((e: any) => e.ts === "105.7");
    assert.ok(unfurl, "an unchanged message_changed still refreshes the mirror");
    assert.equal(unfurl.editedAt, undefined, "but it is not stamped as an edit");
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      subtype: "message_changed",
      message: {
        channel_type: "channel",
        subtype: "tombstone",
        user: "USLACKBOT",
        text: "This message was deleted.",
        ts: "105.9",
      },
      ts: "106.0",
    });
    const tombstone = f.core.ingests.flat().find((e: any) => e.ts === "105.9");
    assert.equal(tombstone?.deleted, true, "a tombstoned thread root reads as a deletion");
  } finally {
    await f.stop();
  }
});

test("a stalled run keeps its still-working wording instead of the generic failure", async () => {
  const f = await fixture();
  try {
    f.core.submitError = Object.assign(new Error("run stalled"), { code: "run_stalled" });
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "hello", ts: "106.0" });
    assert.equal(f.client.posts.length, 1);
    assert.match(f.client.posts[0].text, /taking unusually long/);
  } finally {
    await f.stop();
  }
});

test("raw core failures never leak through Slack", async () => {
  const f = await fixture();
  try {
    f.core.submitError = new Error("password=super-secret postgres://internal-db/run/abc");
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "hello", ts: "106.1" });
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.client.posts.length, 1);
    assert.match(f.client.posts[0].text, /Something went wrong on my end/);
    assert.doesNotMatch(f.client.posts[0].text, /super-secret|postgres|run\/abc/);
  } finally {
    await f.stop();
  }
});

test("stop aborts the active run without enqueuing a second turn", async () => {
  const f = await fixture();
  try {
    f.core.activeRun = "run-active";
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "stop", ts: "107.1" });
    assert.deepEqual(f.core.abortedRuns, ["run-active"]);
    assert.equal(f.core.turns.length, 0);
    assert.equal(f.client.posts.length, 0);
  } finally {
    await f.stop();
  }
});

test("an allowFrom account answers listed members and is silent to everyone else", async () => {
  const f = await fixture({ identityEmail: "1", allowFrom: ["example.com"] });
  try {
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "hello agent", ts: "300.1" });
    assert.equal(f.core.turns.length, 1);
    assert.equal(f.core.turns[0].conversation.audience[0].externalId, "alice@example.com");
  } finally {
    await f.stop();
  }
});

test("an allowFrom account drops unlisted members before any core work", async () => {
  const f = await fixture({ identityEmail: "1", allowFrom: ["staff@example.com"] });
  try {
    await f.app.emitMessage({ channel: "D2", channel_type: "im", user: "U2", text: "hey there", ts: "301.1" });
    await f.app.emitEvent("app_mention", { channel: "C1", user: "U2", text: "<@UBOT> ping", ts: "301.2" });
    assert.equal(f.core.turns.length, 0);
    assert.equal(f.core.ackPicks.length, 0);
    assert.deepEqual(f.core.ingests, []);
    assert.deepEqual(f.client.posts, []);
    assert.deepEqual(f.client.ephemerals, []);
  } finally {
    await f.stop();
  }
});

test("a non-singleton account still serves turns but runs no core-singleton subsystems", async () => {
  const f = await fixture({ coreSingleton: false });
  try {
    assert.deepEqual(f.core.directories, []);
    assert.equal(f.core.contextSubscriptions, 0);
    assert.equal(f.core.modelChangeListeners.length, 0);
    assert.equal(f.core.headerPinChangeListeners.length, 0);
    assert.equal(f.core.publishedEmojiCatalogs.length, 0);
    await f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "hello agent", ts: "302.1" });
    assert.equal(f.core.turns.length, 1);
  } finally {
    await f.stop();
  }
});

test("the default account keeps every core-singleton subsystem", async () => {
  const f = await fixture();
  try {
    assert.equal(f.core.contextSubscriptions, 1);
    assert.equal(f.core.modelChangeListeners.length, 1);
    assert.equal(f.core.headerPinChangeListeners.length, 1);
    await settle(() => f.core.publishedEmojiCatalogs.length === 1);
  } finally {
    await f.stop();
  }
});

for (const coreSingleton of [true, false]) {
  test(`${coreSingleton ? "the default" : "a non-singleton"} account registers a Slack sender that posts through its client until stopped`, async () => {
    const f = await fixture({ coreSingleton });
    try {
      assert.equal(f.core.senders.length, 1);
      await f.core.senders[0]!({
        destination: { type: "slack", target: "C1:100.1" },
        text: "a cron update",
        idempotencyKey: "reach:1",
      });
      const posted = f.client.posts.find((p) => p.text === "a cron update");
      assert.equal(posted?.channel, "C1");
      assert.equal(posted?.thread_ts, "100.1");
    } finally {
      await f.stop();
    }
    assert.deepEqual(f.core.senders, []);
  });
}

test("a gated account joining a channel stays silent — no welcome, no header", async () => {
  const f = await fixture({
    identityEmail: "1",
    allowFrom: ["staff@example.com"],
    webUiPublicUrl: "https://claw.example.dev",
  });
  try {
    f.core.headerPinScopes.add("channel:C1");
    await f.app.emitEvent("member_joined_channel", { user: "UBOT", channel: "C1", event_ts: "400.1" }, "Ev-gated-join");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(f.client.posts, []);
    assert.equal(f.client.pinnedByChannel.get("C1"), undefined);
  } finally {
    await f.stop();
  }
});

test("the default account still pushes the core directory", async () => {
  const f = await fixture();
  try {
    await settle(() => f.core.directories.length >= 1);
  } finally {
    await f.stop();
  }
});

test("a gated account with a denyMessage answers direct approaches with it, once per user", async () => {
  const f = await fixture({
    identityEmail: "1",
    allowFrom: ["staff@example.com"],
    denyMessage: "I only work with Acme staff — ask your administrator.",
  });
  try {
    await f.app.emitEvent("app_mention", { channel: "C1", user: "U2", text: "<@UBOT> help", ts: "500.1" });
    assert.equal(f.client.ephemerals.length, 1);
    assert.equal(f.client.ephemerals[0].user, "U2");
    assert.equal(f.client.ephemerals[0].text, "I only work with Acme staff — ask your administrator.");
    await f.app.emitEvent("app_mention", { channel: "C1", user: "U2", text: "<@UBOT> hello?", ts: "500.2" });
    assert.equal(f.client.ephemerals.length, 1);
    await f.app.emitMessage({ channel: "D2", channel_type: "im", user: "U2", text: "hi", ts: "500.3" });
    assert.equal(f.client.posts.length, 1);
    assert.equal(f.client.posts[0].channel, "D2");
    assert.equal(f.client.posts[0].text, "I only work with Acme staff — ask your administrator.");
    await f.app.emitMessage({ channel: "D2", channel_type: "im", user: "U2", text: "hello??", ts: "500.4" });
    assert.equal(f.client.posts.length, 1);
    assert.equal(f.core.turns.length, 0);
    assert.deepEqual(f.core.ingests, []);
  } finally {
    await f.stop();
  }
});

test("a denyMessage account stays silent on ambient channel chatter from unlisted members", async () => {
  const f = await fixture({
    identityEmail: "1",
    allowFrom: ["staff@example.com"],
    denyMessage: "Staff only, I fear.",
  });
  try {
    await f.app.emitMessage({ channel: "C1", channel_type: "channel", user: "U2", text: "morning all", ts: "501.1" });
    assert.deepEqual(f.client.posts, []);
    assert.deepEqual(f.client.ephemerals, []);
    assert.deepEqual(f.core.ingests, []);
  } finally {
    await f.stop();
  }
});

test("thread status is detached from reply delivery and steering cannot take ownership", async () => {
  const f = await fixture({ coreSingleton: false });
  const starts: unknown[][] = [];
  let release!: () => void;
  const network = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.core.sessionStatus = {
    start: async (...args) => {
      starts.push(args.slice(1));
      await network;
    },
    reconcile: async () => {},
  };
  f.core.engageRun = true;
  f.core.holdRun("r1");
  try {
    const original = f.app.emitEvent("app_mention", { channel: "C1", user: "U1", text: "<@UBOT> work", ts: "700.1" });
    await settle(() => starts.length === 1);
    await f.app.emitEvent("app_mention", {
      channel: "C1",
      thread_ts: "700.1",
      user: "U1",
      text: "<@UBOT> also this",
      ts: "700.2",
    });
    assert.deepEqual(starts, [["T1:UBOT", "r1", "C1", "700.1"]]);
    f.core.finishRun({ status: "ok", reply: "finished" });
    await original;
    assert.ok(f.client.posts.some((post) => post.text === "finished" && post.thread_ts === "700.1"));
    assert.equal(starts.length, 1);
  } finally {
    release();
    await f.stop();
  }
});

test("top-level DM replies remain top-level and never start native thread status", async () => {
  const f = await fixture();
  let starts = 0;
  f.core.sessionStatus = {
    start: async () => {
      starts++;
    },
    reconcile: async () => {},
  };
  f.core.engageRun = true;
  f.core.holdRun("r1");
  try {
    const incoming = f.app.emitMessage({ channel: "D1", channel_type: "im", user: "U1", text: "hello", ts: "701.1" });
    await settle(() => f.core.polled.length === 1);
    f.core.finishRun({ status: "ok", reply: "hello back" });
    await incoming;
    assert.equal(starts, 0);
    assert.ok(f.client.posts.some((post) => post.text === "hello back" && !post.thread_ts));
  } finally {
    await f.stop();
  }
});

test("own task-card status events never enter the mirror, but ordinary bot edits remain", async () => {
  const f = await fixture();
  const status = {
    user: "UBOT",
    bot_id: "BBOT",
    text: "Working",
    ts: "200.1",
    blocks: [{ type: "task_card", task_id: "qm_status:test", title: "Working", status: "in_progress" }],
  };
  try {
    await f.app.emitMessage({ channel: "C1", channel_type: "channel", ...status });
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      subtype: "message_changed",
      message: { ...status, text: "Finished" },
      previous_message: status,
      ts: "200.2",
    });
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      subtype: "message_deleted",
      previous_message: status,
      deleted_ts: status.ts,
      ts: "200.3",
    });
    assert.equal(f.core.ingests.flat().filter((event: any) => event.ts === status.ts).length, 0);
    assert.equal(f.core.turns.length, 0);
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      subtype: "message_changed",
      message: { user: "UBOT", bot_id: "BBOT", text: "Updated answer", ts: "201.1" },
      ts: "201.2",
    });
    assert.equal(f.core.ingests.flat().find((event: any) => event.ts === "201.1")?.text, "Updated answer");
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      user: "UBOT",
      bot_id: "BBOT",
      text: "ordinary malformed blocks",
      ts: "201.3",
      blocks: { unexpected: true },
    });
    assert.equal(f.core.ingests.flat().find((event: any) => event.ts === "201.3")?.text, "ordinary malformed blocks");
    await f.app.emitMessage({
      channel: "C1",
      channel_type: "channel",
      ...status,
      user: "U1",
      bot_id: undefined,
      ts: "202.1",
    });
    assert.ok(f.core.ingests.flat().some((event: any) => event.ts === "202.1"));
  } finally {
    await f.stop();
  }
});
