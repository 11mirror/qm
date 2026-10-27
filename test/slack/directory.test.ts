import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { createDirectory } from "../../src/slack/directory.ts";
import { isGatedEnvelope, createDeferredAckReceiver, type AckGate } from "../../src/slack/deferred-ack.ts";
import type { SlackCoreClient } from "../../src/api/slack-core-client.ts";
import { createPostgresDirectoryStore } from "../../src/directory/postgres-directory-store.ts";
import { testDatabaseUrl, testMap } from "../support/test-database.ts";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { SocketModeClient } from "@slack/socket-mode";
import type { App as BoltApp, ReceiverEvent } from "@slack/bolt";
import { createEnvelopeStaging, type StagedEnvelope } from "../../src/slack/envelope-staging.ts";
import { createHttpEventsReceiver } from "../../src/slack/http-events.ts";
import { createDeduper, dedupedRun } from "../../src/slack/message-gating.ts";

const channel = (id: string, isPrivate = false) => ({
  id,
  name: id.toLowerCase(),
  is_member: true,
  is_private: isPrivate,
});

function fixture(t: TestContext) {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const advance = (ms = 301_000) => {
    now += ms;
  };
  const store = createPostgresDirectoryStore(testDatabaseUrl());
  function core(channels = [channel("C_ONE")]) {
    const state = {
      channels,
      memberIds: ["U_ONE"],
      failMembers: false,
      failList: false,
      memberCalls: 0,
      rejectPush: false,
    };
    const pushes: Parameters<SlackCoreClient["pushDirectory"]>[0][] = [];
    const user = { id: "U_ONE", team_id: "T_TEST" };
    const client = {
      async *paginate(method: string, args: { types?: string }) {
        if (method === "users.list") yield { members: [user] };
        else if (method === "conversations.list") {
          if (state.failList) throw Error("list unavailable");
          yield { channels: args.types === "mpim" ? [] : state.channels };
        } else if (method === "conversations.members") {
          state.memberCalls++;
          if (state.failMembers) throw Error("members unavailable");
          yield { members: state.memberIds };
        }
      },
      users: { info: async () => ({ user }) },
    };
    const directory = createDirectory({
      core: {
        holdDirectorySync: async (fn: (lost: Promise<void>) => Promise<boolean>) => fn(new Promise(() => {})),
        pushDirectory: async (body: Parameters<SlackCoreClient["pushDirectory"]>[0]) => {
          if (state.rejectPush) {
            pushes.push(body);
            return false;
          }
          const members = await store.replace(body.members ?? [], body.membersSyncedAt);
          const channels = body.channels
            ? await store.replaceChannels(
                body.channels,
                body.channelMembers,
                body.channelsSyncedAt,
                body.channelRosterIds,
                body.channelRevocations,
              )
            : true;
          const groups = body.groupMembers
            ? await store.replaceGroups(body.groupMembers, body.groupsSyncedAt, body.groupIds, body.groupRosterIds)
            : true;
          pushes.push(body);
          return members && channels && groups;
        },
      } as SlackCoreClient,
      ids: {
        ownTeamId: "T_TEST",
        botUserId: "U_BOT",
        ownBotId: "B_BOT",
        botHandle: "bot",
        ownWorkspaceUrl: "",
        identityMode: "slack-id",
      },
    });
    async function refresh() {
      const count = pushes.length;
      await directory.getUserSnapshot(client);
      for (let i = 0; i < 400 && pushes.length === count; i++) await sleep(5);
      assert.equal(pushes.length, count + 1);
      await sleep(20);
      return pushes.at(-1)!;
    }
    return { state, directory, client, refresh, pushes };
  }
  return { store, core, advance };
}

test("a fresh listing discovers channels without replaying cached rosters", async (t) => {
  const { core, advance, store } = fixture(t);
  const a = core();
  await a.refresh();
  advance();
  a.state.channels.push(channel("C_NEW"));
  const pushed = await a.refresh();
  assert.equal(await store.channelPrivacy("C_NEW"), false);
  assert.equal(pushed.channelsSyncedAt, Date.now());
  assert.deepEqual(pushed.channelRosterIds, []);
  assert.deepEqual(pushed.channelMembers, []);
  assert.equal(pushed.groupMembers, undefined);
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), true);
  assert.equal(a.state.memberCalls, 1);
});

test("fresh listings update names and privacy while roster refresh is throttled", async (t) => {
  const { core, advance, store } = fixture(t);
  const a = core();
  await a.refresh();
  advance();
  a.state.channels = [{ ...channel("C_ONE", true), name: "renamed" }];
  const pushed = await a.refresh();
  assert.equal(await store.channelPrivacy("C_ONE"), true);
  assert.equal(pushed.channels?.[0]?.name, "renamed");
  advance();
  a.state.channels = [channel("C_ONE")];
  await a.refresh();
  assert.equal(await store.channelPrivacy("C_ONE"), false);
});

test("two cores recover a successful omission through healthy periodic listings", async (t) => {
  const { core, advance, store } = fixture(t);
  const a = core();
  await a.refresh();
  advance(1);
  const b = core([channel("C_OTHER")]);
  await b.refresh();
  assert.equal(await store.channelPrivacy("C_ONE"), undefined);
  b.state.channels = [channel("C_ONE")];
  for (const node of [a, b, a, b]) {
    advance();
    await node.refresh();
    assert.equal(await store.channelPrivacy("C_ONE"), false);
    assert.equal(await store.channelMember("C_ONE", "U_ONE"), false);
  }
});

test("periodic and unrelated targeted refreshes cannot resurrect another core's revocation", async (t) => {
  const { core, advance, store } = fixture(t);
  const a = core([channel("C_ONE", true), channel("C_OTHER")]);
  await a.refresh();
  advance(1);
  const b = core([channel("C_ONE", true), channel("C_OTHER")]);
  await b.refresh();
  advance(1);
  await b.directory.forceDirectorySync(b.client, "C_ONE", "U_ONE");
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), false);
  advance(1);
  await a.directory.forceDirectorySync(a.client, "C_OTHER");
  advance();
  await a.refresh();
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), false);
  assert.equal(await store.channelMember("C_OTHER", "U_ONE"), true);
});

test("targeted refresh does not postpone the next full roster refresh", async (t) => {
  const { core, advance, store } = fixture(t);
  const a = core([channel("C_ONE"), channel("C_OTHER")]);
  await a.refresh();
  advance(1_500_000);
  await a.refresh();
  advance(299_000);
  await a.directory.forceDirectorySync(a.client, "C_OTHER");
  a.state.memberIds = [];
  advance(2_000);
  const pushed = await a.refresh();
  assert.deepEqual(pushed.channelRosterIds?.sort(), ["C_ONE", "C_OTHER"]);
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), false);
});

test("API errors preserve stored rosters and metadata but successful omissions remove them", async (t) => {
  const { core, advance, store } = fixture(t);
  const a = core();
  await a.refresh();
  advance();
  a.state.failMembers = true;
  a.state.channels = [channel("C_ONE", true)];
  await a.directory.forceDirectorySync(a.client, "C_ONE");
  assert.equal(await store.channelPrivacy("C_ONE"), true);
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), true);
  advance();
  a.state.failList = true;
  await a.refresh();
  assert.equal(await store.channelPrivacy("C_ONE"), true);
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), true);
  advance();
  a.state.failList = false;
  a.state.channels = [];
  await a.refresh();
  assert.equal(await store.channelPrivacy("C_ONE"), undefined);
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), false);
});

test("a rejected full crawl is retried instead of throttling unpublished rosters", async (t) => {
  const { core, advance, store } = fixture(t);
  const a = core();
  a.state.rejectPush = true;
  await a.refresh();
  assert.equal(await store.channelPrivacy("C_ONE"), undefined);
  a.state.rejectPush = false;
  advance();
  await a.refresh();
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), true);
  assert.equal(a.state.memberCalls, 2);
});

test("a member_left revocation that core rejects fails the event so the gated envelope is redelivered", async (t) => {
  const { core, store } = fixture(t);
  const a = core([channel("C_ONE", true)]);
  await a.refresh();
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), true);
  a.state.rejectPush = true;
  await assert.rejects(a.directory.forceDirectorySync(a.client, "C_ONE", "U_ONE"), /revocation was not persisted/);
  a.state.rejectPush = false;
  await a.directory.forceDirectorySync(a.client, "C_ONE", "U_ONE");
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), false);
  assert.equal(
    isGatedEnvelope({
      type: "event_callback",
      event: { type: "member_left_channel", channel: "C_ONE", user: "U_ONE" },
    }),
    true,
  );
});

function directory() {
  return createDirectory({
    core: {} as SlackCoreClient,
    ids: {
      ownTeamId: "",
      botUserId: "UBOT",
      ownBotId: "BBOT",
      botHandle: "qm",
      ownWorkspaceUrl: "",
      identityMode: "email",
    },
    coreSingleton: false,
  });
}

const rateLimited = Object.assign(new Error("An API error occurred: ratelimited"), { data: { error: "ratelimited" } });

test("a failed users.info lookup is logged with its cause before the user is treated as a guest", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const client = {
    users: {
      info: async () => {
        throw rateLimited;
      },
    },
  };
  const result = await directory().classifyUserCached(client, "U1");
  assert.equal(result.ok, false);
  assert.equal(result.actor.isExternalGuest, true);
  const logged = warn.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(
    logged.some((line) => line.includes("users.info") && line.includes("ratelimited")),
    logged.join("\n"),
  );
});

test("a failed conversations.info lookup is logged with its cause", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const client = {
    conversations: {
      info: async () => {
        throw rateLimited;
      },
    },
  };
  assert.equal(await directory().getChannelInfo(client, "C1"), undefined);
  const logged = warn.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(
    logged.some((line) => line.includes("conversations.info") && line.includes("ratelimited")),
    logged.join("\n"),
  );
});

function verifiedFixture(options: { secondary?: boolean; failWrite?: boolean; throwWrite?: boolean } = {}) {
  const store = createPostgresDirectoryStore(testDatabaseUrl());
  const state = { memberIds: ["U_ONE"], failMembers: false, failUser: false, writes: 0 };
  const client = {
    async *paginate(method: string) {
      if (method === "conversations.members") {
        if (state.failMembers) throw Error("unavailable");
        yield { members: state.memberIds };
      } else if (method === "users.list") yield { members: [] };
      else yield { channels: [] };
    },
    users: {
      info: async ({ user }: { user: string }) => {
        if (state.failUser) throw Error("unavailable");
        return { user: { id: user, team_id: "T_TEST" } };
      },
    },
  };
  const directory = createDirectory({
    core: {
      holdDirectorySync: async () => null,
      pushDirectory: async (body: Parameters<SlackCoreClient["pushDirectory"]>[0]) => {
        state.writes++;
        if (options.throwWrite) throw new Error("directory transport unavailable");
        if (options.failWrite) return false;
        return store.replaceChannels(
          body.channels!,
          body.channelMembers,
          body.channelsSyncedAt,
          body.channelRosterIds,
          body.channelRevocations,
          body.partialChannels,
        );
      },
    } as unknown as SlackCoreClient,
    coreSingleton: !options.secondary,
    ids: {
      ownTeamId: "T_TEST",
      botUserId: "U_BOT",
      ownBotId: "B_BOT",
      botHandle: "bot",
      ownWorkspaceUrl: "",
      identityMode: "slack-id",
    },
  });
  const observe = (
    info: import("../../src/slack/identity.ts").ChannelMeta | undefined = { name: "room", is_private: true },
  ) => directory.channelMembership(client, "C_ONE", { externalId: "U_ONE" }, "U_ONE", info, Date.now());
  return { store, state, observe };
}

test("verified channel membership persists before admission without deleting another room", async () => {
  const { store, observe } = verifiedFixture();
  await store.replaceChannels([{ channelId: "C_OTHER", name: "other" }], [], 1);
  const result = await observe();
  assert.ok(result.publishMembers);
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), true);
  assert.equal(await store.channelPrivacy("C_ONE"), true);
  assert.equal(await store.channelPrivacy("C_OTHER"), false);
});

test("live observation repairs stale privacy", async () => {
  const { store, observe } = verifiedFixture();
  await store.replaceChannels([{ channelId: "C_ONE", name: "old", isPrivate: true }], [], 1);
  await observe({ name: "room", is_private: false });
  assert.equal(await store.channelPrivacy("C_ONE"), false);
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), true);
});

test("secondary accounts never publish live channels", async () => {
  const { state, observe } = verifiedFixture({ secondary: true });
  assert.ok((await observe()).publishMembers);
  assert.equal(state.writes, 0);
});

test("failed persistence propagates to envelope recovery instead of declaring an external audience", async () => {
  for (const options of [{ failWrite: true }, { throwWrite: true }]) {
    const { observe } = verifiedFixture(options);
    await assert.rejects(observe(), /not persisted before admission|directory transport unavailable/);
  }
});

test("removed speakers and failed member classification do not publish", async () => {
  for (const failure of ["removed", "members", "user"]) {
    const { state, observe } = verifiedFixture();
    if (failure === "removed") state.memberIds = [];
    if (failure === "members") state.failMembers = true;
    if (failure === "user") state.failUser = true;
    assert.equal((await observe()).publishMembers, undefined);
    assert.equal(state.writes, 0);
  }
});

test("unknown, external and group metadata never publish an ordinary channel", async () => {
  for (const info of [
    {},
    { name: "room" },
    { name: "room", is_private: true, is_member: false },
    { name: "room", is_private: true, is_ext_shared: true },
    { name: "room", is_private: true, is_mpim: true },
  ]) {
    const { state, observe } = verifiedFixture();
    await observe(info);
    assert.equal(state.writes, 0);
  }
});

test("newer removal rejects an older in-flight live observation", async () => {
  const { store, observe } = verifiedFixture();
  await store.replaceChannels([], [], Date.now() + 60_000);
  await assert.rejects(observe(), /not persisted before admission/);
  assert.equal(await store.channelPrivacy("C_ONE"), undefined);
});

test("equal observation stamps trigger recovery without changing the internal roster", async (t) => {
  t.mock.method(Date, "now", () => 100_000);
  const { store, observe } = verifiedFixture();
  assert.ok((await observe()).publishMembers);
  await assert.rejects(observe(), /not persisted before admission/);
  assert.equal(await store.channelMember("C_ONE", "U_ONE"), true);
});

for (const mode of ["socket", "http"] as const)
  for (const afterCap of [false, true])
    test(`${mode} roster failure ${afterCap ? "after" : "before"} ack cap recovers without false external admission`, async (t) => {
      const options = { failWrite: true };
      const { observe } = verifiedFixture(options);
      const deduper = createDeduper();
      const map = testMap<StagedEnvelope>();
      const staging = createEnvelopeStaging(map, { account: "test", staleAfterMs: 0 });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let complete!: () => void;
      const completed = new Promise<void>((resolve) => {
        complete = resolve;
      });
      let eventDone: (() => void) | undefined;
      let attempts = 0;
      let admitted = 0;
      let externalRefusals = 0;
      let acks = 0;
      const retries: Array<number | undefined> = [];
      const processEvent = async (event: ReceiverEvent) => {
        await event.ack();
        retries.push(event.retryNum);
        const gate = event.customProperties!.ackGate as AckGate;
        await dedupedRun(
          deduper,
          "message-key",
          async () => {
            if (++attempts === 1 && afterCap) await blocked;
            const membership = await observe();
            if (!membership.publishMembers) {
              externalRefusals++;
              gate.persisted();
              return;
            }
            admitted++;
            gate.persisted();
          },
          (error) => gate.failed(String(error)),
        );
        eventDone?.();
        eventDone = undefined;
        complete();
      };
      const receiver =
        mode === "socket"
          ? createDeferredAckReceiver({ appToken: "xapp-test", capMs: afterCap ? 1 : 5000, staging })
          : createHttpEventsReceiver({
              signingSecret: "test-secret",
              capMs: afterCap ? 1 : 5000,
              staging,
              serve: () => () => {},
            });
      receiver.init?.({ processEvent } as unknown as BoltApp);
      const body = {
        type: "event_callback",
        event_id: "EvTest",
        event: { type: "app_mention", channel: "C_ONE", ts: "1.1" },
      };
      let acked!: () => void;
      const acknowledgement = new Promise<void>((resolve) => {
        acked = resolve;
      });
      let port = 0;
      const deliver = async (retryNum = 0): Promise<number | undefined> => {
        if ("client" in receiver) {
          const processed = new Promise<void>((resolve) => {
            eventDone = resolve;
          });
          (receiver.client as SocketModeClient).emit("slack_event", {
            body,
            retry_num: retryNum,
            ack: async () => {
              acks++;
              acked();
            },
          });
          if (afterCap && retryNum === 0) await acknowledgement;
          else await processed;
          return undefined;
        }
        const timestamp = String(Math.floor(Date.now() / 1000));
        const raw = JSON.stringify(body);
        const signature = `v0=${createHmac("sha256", "test-secret").update(`v0:${timestamp}:${raw}`).digest("hex")}`;
        const response = await fetch(`http://127.0.0.1:${port}/slack/events`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-slack-signature": signature,
            "x-slack-request-timestamp": timestamp,
            "x-slack-retry-num": String(retryNum),
          },
          body: raw,
        });
        if (response.status === 200) acks++;
        else assert.deepEqual(await response.json(), { error: "not_persisted" });
        return response.status;
      };
      if (mode === "http") {
        const http = receiver as ReturnType<typeof createHttpEventsReceiver>;
        const server = createServer((req, res) => void http.handle(req, res));
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = (server.address() as AddressInfo).port;
        t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
      }
      const status = await deliver();
      if (mode === "http") assert.equal(status, afterCap ? 200 : 503);
      assert.equal(acks, afterCap ? 1 : 0);
      release();
      await completed;
      assert.equal(admitted, 0);
      assert.equal(externalRefusals, 0);
      assert.equal(await deduper.seen("message-key"), false);
      deduper.forget("message-key");
      options.failWrite = false;
      if (afterCap) {
        assert.equal((await map.entries()).length, 1);
        assert.equal(
          await staging.sweep((replayed, ackGate) =>
            processEvent({ body: replayed, ack: async () => {}, customProperties: { ackGate } }),
          ),
          1,
        );
      } else {
        assert.equal((await map.entries()).length, 0);
        const retryStatus = await deliver(1);
        if (mode === "http") assert.equal(retryStatus, 200);
        assert.equal(retries.at(-1), 1);
      }
      for (let i = 0; i < 200 && admitted === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(admitted, 1);
      assert.equal(attempts, 2);
      for (let i = 0; i < 200 && (await map.entries()).length > 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal((await map.entries()).length, 0);
    });
