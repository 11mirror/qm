import assert from "node:assert/strict";
import { runTrigger, type TriggerDeps } from "../../src/triggers/run-trigger.ts";
import { recordingOutbound, type PostLog } from "../support/recording-outbound.ts";
import { createIdempotencyStore } from "../../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { scopeId, type Destination, type TurnRequest, type TurnResult } from "../../src/types.ts";
import { SESSION_BUSY_FIRE_TEXT } from "../../src/core/failure-copy.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { automationOrigin } from "../support/turn-origin.ts";
import { describe, it } from "node:test";
import { createCurrentScopeMembers } from "../../src/resolution/scope-membership.ts";
import type { DirectoryMember } from "../../src/directory/directory-store.ts";

const toChannel: Destination = { type: "slack", target: "C1:169.7", audienceScopeId: scopeId("channel", "C1") };

function directory(member: boolean) {
  return {
    channelMember: async () => member,
    groupMember: async () => member,
    listChannelsFor: async () =>
      member
        ? [
            { channelId: "C1", name: "c1" },
            { channelId: "C-private", name: "private" },
          ]
        : [],
    channelPrivacy: async (id: string) => {
      if (id === "C-private") return true;
      return id === "C1" ? false : undefined;
    },
    get: async () => null,
  };
}

function deps(
  run: (req: TurnRequest) => Promise<TurnResult>,
  dir?: ReturnType<typeof directory>,
): TriggerDeps & { outbound: PostLog } {
  const databaseUrl = testDatabaseUrl();
  return {
    outbound: recordingOutbound(),
    idempotency: createIdempotencyStore(databaseUrl),
    identity: createIdentityService(databaseUrl),
    run,
    ...(dir ? { directory: dir } : {}),
  };
}

it("passes surfaceTools + addressed + the arming destination, and does NOT enqueue the reply", async () => {
  let req: TurnRequest | undefined;
  const d = deps(async (r) => {
    req = r;
    return { status: "ok", reply: "build passed" };
  });
  const out = await runTrigger(d, {
    owner: "U1",
    ownerScopeId: scopeId("channel", "C1"),
    input: "report back",
    fireKey: "monitor:m1:exit",
    surface: "monitor",
    threadRef: "C1:169.7",
    destination: toChannel,
  });
  assert.equal(out.ran, true);
  assert.equal(req?.surfaceTools, true, "a monitor fire wires the surface tools");
  assert.equal(req?.addressed, true, "and is addressed so it must reply-or-decline (shed fallback delivers)");
  assert.deepEqual(automationOrigin(req)?.destination, toChannel, "the post tool aims at the arming thread");
  assert.equal(req?.idempotencyKey, "monitor:m1:exit");
  assert.equal((await d.outbound.pending("slack")).length, 0);
});

it("a monitor whose destination is no longer visible stays off the live path: no surface tools, a note, no enqueue", async () => {
  let req: TurnRequest | undefined;
  const d = deps(async (r) => {
    req = r;
    return { status: "ok", reply: "build passed" };
  }, directory(false));
  const out = await runTrigger(d, {
    owner: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    input: "report back",
    fireKey: "monitor:m2:exit",
    surface: "monitor",
    threadRef: "C1:169.7",
    destination: toChannel,
  });
  assert.equal(req?.surfaceTools, undefined, "a non-visible destination does not get the surface tools");
  assert.match(out.note ?? "", /no longer visible/);
  assert.equal((await d.outbound.pending("slack")).length, 0, "and nothing is delivered");
});

it("§10 leg (a) at fire time: an actor who can no longer READ the trigger's home scope skips the run entirely", async () => {
  let ranTurn = false;
  const d = deps(async () => {
    ranTurn = true;
    return { status: "ok", reply: "should never compose" };
  }, directory(false));
  const out = await runTrigger(d, {
    owner: "U1",
    ownerScopeId: scopeId("channel", "C-private"),
    input: "digest the channel",
    fireKey: "cron:c9:1",
    surface: "cron",
    destination: toChannel,
  });
  assert.equal(ranTurn, false, "the turn must not run — it would mount a scope the actor lost");
  assert.equal(out.ran, true, "the fire is consumed and recorded, not mistaken for a dedupe hit");
  assert.equal(out.authzFailed, false, "skip-not-disable: a stale directory must not kill the trigger");
  assert.match(out.note ?? "", /no longer a member/);
  assert.equal((await d.outbound.pending("slack")).length, 0);
});

it("§10 leg (a): a member in good standing runs as before (group home scope)", async () => {
  let ranTurn = false;
  const d = deps(async () => {
    ranTurn = true;
    return { status: "ok", reply: "digest" };
  }, directory(true));
  const out = await runTrigger(d, {
    owner: "U1",
    ownerScopeId: scopeId("group", "G1"),
    input: "digest",
    fireKey: "cron:c10:1",
    surface: "cron",
    destination: toChannel,
  });
  assert.equal(ranTurn, true);
  assert.equal(out.ran, true);
  assert.equal((await d.outbound.pending("slack")).length, 1, "output delivered");
});

it("a group-DM home destination (slack-typed, group audience scope) is gated by the GROUPS tables, not the channel tables", async () => {
  const mpimOnly = {
    channelMember: async () => false,
    groupMember: async (id: string, who: string) => id === "C-mpim" && who === "U1",
    listChannelsFor: async () => [],
    channelPrivacy: async () => undefined,
    get: async () => null,
  };
  let req: TurnRequest | undefined;
  const d = deps(
    async (r) => {
      req = r;
      return { status: "ok", reply: "delivered" };
    },
    mpimOnly as unknown as ReturnType<typeof directory>,
  );
  const out = await runTrigger(d, {
    owner: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    input: "remind us here",
    fireKey: "monitor:m-mpim:exit",
    surface: "monitor",
    threadRef: "C-mpim:169.7",
    destination: { type: "slack", target: "C-mpim:169.7", audienceScopeId: scopeId("group", "C-mpim") },
  });
  assert.equal(out.ran, true);
  assert.equal(req?.surfaceTools, true, "the fire goes live and can deliver into the group DM");
  assert.doesNotMatch(out.note ?? "", /no longer visible/);
});

it("a group-DM destination whose owner LEFT the mpim still fails closed", async () => {
  const noOne = {
    channelMember: async () => false,
    groupMember: async () => false,
    listChannelsFor: async () => [],
    channelPrivacy: async () => undefined,
    get: async () => null,
  };
  let req: TurnRequest | undefined;
  const d = deps(
    async (r) => {
      req = r;
      return { status: "ok", reply: "should be held" };
    },
    noOne as unknown as ReturnType<typeof directory>,
  );
  const out = await runTrigger(d, {
    owner: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    input: "remind us here",
    fireKey: "monitor:m-mpim2:exit",
    surface: "monitor",
    threadRef: "C-mpim:169.7",
    destination: { type: "slack", target: "C-mpim:169.7", audienceScopeId: scopeId("group", "C-mpim") },
  });
  assert.equal(req?.surfaceTools, undefined, "a lost group membership does not go live");
  assert.match(out.note ?? "", /no longer visible/);
  assert.equal((await d.outbound.pending("slack")).length, 0);
});

it("a bare monitor (no destination) runs but neither goes live nor enqueues", async () => {
  let req: TurnRequest | undefined;
  const d = deps(async (r) => {
    req = r;
    return { status: "ok", reply: "noise" };
  });
  const out = await runTrigger(d, {
    owner: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    input: "watch",
    fireKey: "monitor:m3:exit",
    surface: "monitor",
    threadRef: "t3",
  });
  assert.equal(out.ran, true);
  assert.equal(req?.surfaceTools, undefined);
  assert.equal((await d.outbound.pending("slack")).length, 0);
});

describe("runTrigger: an autonomous cron does NOT go live (it may be conditionally silent by design)", () => {
  it("threads grants only for crons homed in and delivering to their owner's own DM", async () => {
    const requests: TurnRequest[] = [];
    const d = deps(async (request) => {
      requests.push(request);
      return { status: "ok" };
    });
    const base = {
      owner: "U1",
      ownerScopeId: scopeId("personal", "U1"),
      input: "scan",
      surface: "cron",
      unattendedGrants: ["admin.sessions.read"],
    };
    await runTrigger(d, { ...base, fireKey: "cron:owner" });
    await runTrigger(d, { ...base, ownerScopeId: scopeId("channel", "C1"), fireKey: "cron:channel" });
    await runTrigger(d, {
      ...base,
      owner: "system:channel:C1",
      ownerScopeId: scopeId("channel", "C1"),
      fireKey: "cron:conversation",
    });
    await runTrigger(d, { ...base, destination: toChannel, fireKey: "cron:owner-to-room" });
    await runTrigger(d, { ...base, ownerScopeId: scopeId("personal", "U2"), fireKey: "cron:foreign-dm" });
    assert.deepEqual(requests[0]?.unattendedGrants, ["admin.sessions.read"]);
    assert.equal(requests[1]?.unattendedGrants, undefined);
    assert.equal(requests[2]?.unattendedGrants, undefined);
    assert.equal(requests[3]?.unattendedGrants, undefined, "a personal cron delivering to a room carries no grants");
    assert.equal(requests[4]?.unattendedGrants, undefined, "a cron homed in someone else's DM carries no grants");
  });

  it("a failed fire's error notice carries friendly copy while the fire history keeps the raw reason", async () => {
    const d = deps(async () => ({ status: "failed", reason: "TypeError: fetch failed at sandbox.ts:42" }));
    const out = await runTrigger(d, {
      owner: "U1",
      ownerScopeId: scopeId("channel", "C1"),
      input: "report back",
      fireKey: "monitor:m9:exit",
      surface: "monitor",
      threadRef: "C1:169.7",
      destination: toChannel,
      errorNotice: (s) => `⚠️ could not run: ${s}`,
    });
    assert.equal(out.note, "failed: TypeError: fetch failed at sandbox.ts:42", "the operator record keeps the detail");
    const pending = await d.outbound.pending("slack");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.text, "⚠️ could not run: something went wrong on my end");
  });

  it("a busy-session fire's error notice says the conversation was busy, never the raw status", async () => {
    const d = deps(async () => ({
      status: "refused",
      refusalKind: "session_busy",
      reason: SESSION_BUSY_FIRE_TEXT,
    }));
    await runTrigger(d, {
      owner: "U1",
      ownerScopeId: scopeId("channel", "C1"),
      input: "report back",
      fireKey: "monitor:m10:exit",
      surface: "monitor",
      threadRef: "C1:169.7",
      destination: toChannel,
      errorNotice: (s) => `⚠️ could not run: ${s}`,
    });
    const pending = await d.outbound.pending("slack");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.text, "⚠️ could not run: the conversation was busy with another task");
    assert.doesNotMatch(pending[0]!.text, /session busy|refused|try again/);
  });

  it("a destination-bearing cron keeps the compose-then-enqueue path: no surface tools, one delivery", async () => {
    let req: TurnRequest | undefined;
    const d = deps(async (r) => {
      req = r;
      return { status: "ok", reply: "your digest" };
    });
    await runTrigger(d, {
      owner: "U1",
      ownerScopeId: scopeId("channel", "C1"),
      input: "compose the digest",
      fireKey: "cron:c1:t1",
      surface: "cron",
      threadRef: "cron:c1:t1",
      destination: { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") },
    });
    assert.equal(req?.surfaceTools, undefined, "a cron never gets addressed/shed semantics — it may stay silent");
    assert.equal((await d.outbound.pending("slack")).length, 1, "core delivers the cron reply via the enqueue path");
  });
});

describe("runTrigger: a busy session defers a fire instead of consuming it", () => {
  const busy = async (): Promise<TurnResult> => ({
    status: "refused",
    refusalKind: "session_busy",
    reason: SESSION_BUSY_FIRE_TEXT,
  });
  const spec = {
    owner: "U1",
    ownerScopeId: scopeId("channel", "C1"),
    input: "report back",
    fireKey: "cron:c7:1000",
    surface: "cron",
    threadRef: "cron:c7:1000",
    destination: toChannel,
    errorNotice: (s: string) => `⚠️ could not run: ${s}`,
    deferWhenBusy: true,
  };

  it("reports deferred, leaves the fire key unspent, and tells nobody", async () => {
    let attempts = 0;
    const d = deps(async () => {
      attempts++;
      return attempts === 1 ? busy() : { status: "ok", reply: "done" };
    });
    const first = await runTrigger(d, spec);
    assert.equal(first.deferred, true);
    assert.equal(first.ran, false);
    assert.equal(first.status, undefined);
    assert.equal((await d.outbound.pending("slack")).length, 0, "a deferral is not a failure — no notice");
    assert.equal(await d.idempotency.committed(spec.fireKey), false, "the fire key is still available");

    const second = await runTrigger(d, spec);
    assert.equal(second.ran, true, "the same fire key runs again once the session is free");
    assert.equal(second.status, "ok");
    assert.equal(attempts, 2);
  });

  it("without deferWhenBusy a busy refusal is consumed and noticed as before", async () => {
    const d = deps(busy);
    const { deferWhenBusy: _omitted, ...consuming } = spec;
    const out = await runTrigger(d, consuming);
    assert.equal(out.deferred, undefined);
    assert.equal(out.ran, true);
    assert.equal(out.status, "refused");
    assert.equal(await d.idempotency.committed(spec.fireKey), true);
    assert.equal((await d.outbound.pending("slack")).length, 1);
  });
});

const OWNER = "pat@example.com";
const CHAN = "C0PRIVATE";
const SCOPE = scopeId("channel", CHAN);

function unknownChannelDirectory() {
  return {
    channelMember: async (_c: string, _pid: string) => false,
    groupMember: async (_g: string, _pid: string) => false,
    listChannelsFor: async (): Promise<{ channelId: string; name: string }[]> => [],
    channelPrivacy: async (): Promise<boolean | undefined> => undefined,
    list: async () => [{ principalId: OWNER, displayName: "Pete" }],
    get: async () => null,
    conversationMembers: async (_kind: "channel" | "group", _id: string): Promise<DirectoryMember[] | undefined> =>
      undefined,
  };
}

function runTriggerHomeScopeDeps(
  dir: ReturnType<typeof unknownChannelDirectory>,
  opts: { onRun?: () => void } = {},
): TriggerDeps {
  const databaseUrl = testDatabaseUrl();
  const run = async (_r: TurnRequest): Promise<TurnResult> => {
    opts.onRun?.();
    return { status: "ok", reply: "posted" };
  };
  return {
    outbound: recordingOutbound(),
    idempotency: createIdempotencyStore(databaseUrl),
    identity: createIdentityService(databaseUrl),
    run,
    directory: dir,
    currentScopeMembers: createCurrentScopeMembers({ directory: dir }),
  };
}

function spec(key: string) {
  return {
    owner: OWNER,
    ownerScopeId: SCOPE,
    input: "check apps",
    fireKey: `cron:home:${key}`,
    surface: "cron",
    destination: { type: "slack" as const, target: CHAN, audienceScopeId: SCOPE },
  };
}

describe("runTrigger home-scope gate when the directory snapshot dropped the channel", () => {
  it("skips with a note naming the snapshot gap, not lost membership", async () => {
    let ranTurn = false;
    const d = runTriggerHomeScopeDeps(unknownChannelDirectory(), { onRun: () => (ranTurn = true) });
    const out = await runTrigger(d, spec("gap"));
    assert.equal(ranTurn, false, "session history in the channel is not membership");
    assert.equal(out.authzFailed, false, "skip-not-disable survives");
    assert.match(out.note ?? "", /missing from the directory snapshot/);
    assert.doesNotMatch(out.note ?? "", /no longer a member/);
  });

  it("a directory that affirmatively knows the private channel and excludes the actor still skips as lost membership", async () => {
    const dir = {
      ...unknownChannelDirectory(),
      listChannelsFor: async () => [{ channelId: CHAN, name: "private" }],
      channelPrivacy: async (): Promise<boolean | undefined> => true,
    };
    let ranTurn = false;
    const d = runTriggerHomeScopeDeps(dir, { onRun: () => (ranTurn = true) });
    const out = await runTrigger(d, spec("kicked"));
    assert.equal(ranTurn, false, "an affirmative roster skips");
    assert.match(out.note ?? "", /no longer a member/);
  });
});

const GROUP = "G0MPIM";
const GSCOPE = scopeId("group", GROUP);

function groupSpec(key: string) {
  return {
    owner: OWNER,
    ownerScopeId: GSCOPE,
    input: "check apps",
    fireKey: `cron:ghome:${key}`,
    surface: "cron",
    destination: { type: "slack" as const, target: GROUP, audienceScopeId: GSCOPE },
  };
}

describe("runTrigger home-scope gate for group homes", () => {
  it("a group missing from the snapshot skips with the snapshot-gap note", async () => {
    let ranTurn = false;
    const d = runTriggerHomeScopeDeps(unknownChannelDirectory(), { onRun: () => (ranTurn = true) });
    const out = await runTrigger(d, groupSpec("gap"));
    assert.equal(ranTurn, false);
    assert.match(out.note ?? "", /missing from the directory snapshot/);
  });

  it("a group whose known roster excludes the cron owner skips as the owner having left", async () => {
    let ranTurn = false;
    const dir = {
      ...unknownChannelDirectory(),
      groupMember: async (_g: string, pid: string) => pid === "kim@example.com",
      conversationMembers: async (): Promise<DirectoryMember[] | undefined> => [
        { principalId: "kim@example.com", displayName: "Kim", type: "internal" },
      ],
    };
    const d = runTriggerHomeScopeDeps(dir, { onRun: () => (ranTurn = true) });
    const out = await runTrigger(d, groupSpec("kicked"));
    assert.equal(ranTurn, false, "an affirmative group roster skips");
    assert.equal(out.ownerLeft, true);
    assert.match(out.note ?? "", /owner left this conversation/);
  });

  it("without currentScopeMembers wired, an affirmative tri-state non-membership skips", async () => {
    const databaseUrl = testDatabaseUrl();
    let ranTurn = false;
    const dir = {
      ...unknownChannelDirectory(),
      groupMembership: async (): Promise<boolean | undefined> => false,
    };
    const d: TriggerDeps = {
      outbound: recordingOutbound(),
      idempotency: createIdempotencyStore(databaseUrl),
      identity: createIdentityService(databaseUrl),
      run: async () => {
        ranTurn = true;
        return { status: "ok", reply: "posted" };
      },
      directory: dir,
    };
    const out = await runTrigger(d, groupSpec("tri-state"));
    assert.equal(ranTurn, false);
    assert.match(out.note ?? "", /no longer a member/);
  });

  it("without currentScopeMembers wired, an unknown tri-state membership skips with the snapshot-gap note", async () => {
    const databaseUrl = testDatabaseUrl();
    let ranTurn = false;
    const d: TriggerDeps = {
      outbound: recordingOutbound(),
      idempotency: createIdempotencyStore(databaseUrl),
      identity: createIdentityService(databaseUrl),
      run: async () => {
        ranTurn = true;
        return { status: "ok", reply: "posted" };
      },
      directory: { ...unknownChannelDirectory(), groupMembership: async () => undefined },
    };
    const out = await runTrigger(d, groupSpec("tri-state-unknown"));
    assert.equal(ranTurn, false);
    assert.match(out.note ?? "", /missing from the directory snapshot/);
  });
});
