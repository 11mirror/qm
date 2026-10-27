import { test } from "node:test";
import assert from "node:assert/strict";
import {
  surfaceHeaderText,
  headerUpdate,
  isSurfaceHeaderMessage,
  findHeaderPin,
  createSurfaceHeaderEnsurer,
  scopeSurfaceUrl,
} from "../../src/slack/delivery.ts";

test("surfaceHeaderText names the model and the project link without branding — degrading gracefully", () => {
  assert.equal(
    surfaceHeaderText({ modelName: "Claude Opus 4.8" }, "https://claw.acme.dev/projects/channel/C1"),
    "Using Claude Opus 4.8 here. <https://claw.acme.dev/projects/channel/C1|More settings>",
  );
  assert.equal(surfaceHeaderText({ modelName: "Claude Opus 4.8" }, undefined), "Using Claude Opus 4.8 here.");
  assert.equal(surfaceHeaderText({}, "https://claw.acme.dev"), "<https://claw.acme.dev|More settings>");
  assert.equal(surfaceHeaderText({ modelName: "  " }, "  "), undefined);
});

test("isSurfaceHeaderMessage recognizes only the bot's own header shapes", () => {
  assert.ok(isSurfaceHeaderMessage("Using Claude Opus 4.8 here. <https://claw.acme.dev|More settings>"));
  assert.ok(isSurfaceHeaderMessage("Using Claude Opus 4.8 here."));
  assert.ok(isSurfaceHeaderMessage("<https://claw.acme.dev|More settings>"));
  assert.ok(!isSurfaceHeaderMessage("Reminder: standup at 10"));
  assert.ok(!isSurfaceHeaderMessage(""));
  assert.ok(!isSurfaceHeaderMessage(undefined));
});

test("findHeaderPin picks only the bot's own pinned header message", () => {
  const items = [
    { message: { ts: "1.0", user: "U0HUMAN", text: "Using X here." } },
    { message: { ts: "2.0", user: "U0BOT", text: "team norms doc" } },
    {
      message: { ts: "3.0", user: "U0BOT", text: "Using Claude Opus 4.8 here. <https://claw.acme.dev|More settings>" },
    },
  ];
  assert.deepEqual(findHeaderPin(items, "U0BOT"), {
    ts: "3.0",
    text: "Using Claude Opus 4.8 here. <https://claw.acme.dev|More settings>",
  });
  assert.equal(findHeaderPin(items, "U0OTHER"), undefined);
  assert.equal(findHeaderPin(undefined, "U0BOT"), undefined);
});

test("headerUpdate rewrites only an empty or self-authored header", () => {
  const BOT = "U0BOT";
  const desired = "Using Claude Opus 4.8 here. <https://claw.acme.dev|More settings>";
  assert.equal(headerUpdate(undefined, BOT, desired), "set");
  assert.equal(headerUpdate({ value: "" }, BOT, desired), "set");
  assert.equal(headerUpdate({ value: "Model: Claude Sonnet 5", creator: BOT }, BOT, desired), "set");
  assert.equal(headerUpdate({ value: desired, creator: BOT }, BOT, desired), "skip");
  assert.equal(headerUpdate({ value: "my own notes", creator: "U0HUMAN" }, BOT, desired), "skip");
  assert.equal(
    headerUpdate({ value: "Using Claude Opus 4.8 here. <https://claw.acme.dev>", creator: BOT }, BOT, desired),
    "skip",
  );
});

function headerHarness(
  existing?: { value?: string; creator?: string },
  model = "Claude Opus 4.8",
  kind: "dm" | "channel" = "dm",
  pinnedText?: string,
) {
  const calls = {
    info: 0,
    set: 0,
    pinsListed: 0,
    posted: [] as string[],
    updated: [] as string[],
    pinned: [] as string[],
    unpinned: [] as string[],
    deleted: [] as string[],
  };
  let current = existing;
  let pinned = pinnedText !== undefined ? { ts: "42.0", user: "U0BOT", text: pinnedText } : undefined;
  const client = {
    chat: {
      postMessage: async ({ text }: { text: string }) => {
        calls.posted.push(text);
        pinned = { ts: "99.0", user: "U0BOT", text };
        return { ts: "99.0" };
      },
      update: async ({ ts, text }: { ts: string; text: string }) => {
        calls.updated.push(text);
        if (pinned && pinned.ts === ts) pinned = { ...pinned, text };
        return {};
      },
      delete: async ({ ts }: { ts: string }) => {
        calls.deleted.push(ts);
        if (pinned && pinned.ts === ts) pinned = undefined;
        return {};
      },
    },
    pins: {
      list: async () => {
        calls.pinsListed += 1;
        return { items: pinned ? [{ message: pinned }] : [] };
      },
      add: async ({ timestamp }: { timestamp: string }) => {
        calls.pinned.push(timestamp);
        return {};
      },
      remove: async ({ timestamp }: { timestamp: string }) => {
        calls.unpinned.push(timestamp);
        return {};
      },
    },
    conversations: {
      info: async () => {
        calls.info += 1;
        if (!current) return { channel: {} };
        return { channel: kind === "dm" ? { topic: current } : {} };
      },
      setTopic: async ({ topic: value }: { channel: string; topic: string }) => {
        calls.set += 1;
        current = { value, creator: "U0BOT" };
        return {};
      },
    },
  };
  const flags = { channelPinEnabled: true };
  const raw = createSurfaceHeaderEnsurer({
    headerFacts: async () => ({ modelName: model }),
    channelPinEnabled: async () => flags.channelPinEnabled,
    webUiPublicUrl: "https://claw.acme.dev",
    ids: { botUserId: "U0BOT" },
  });
  const scope = kind === "dm" ? "personal:josh@acme.dev" : "channel:C1";
  const ensure = (c: unknown, channel: string, ensureOpts?: { pinNew?: boolean }) =>
    raw(c as never, channel, scope, kind, ensureOpts);
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  return { client, calls, ensure, flush, read: () => current, readPin: () => pinned, scope, flags };
}

test("surface header ensurer writes the header once, then goes quiet", async () => {
  const h = headerHarness();
  h.ensure(h.client, "D1");
  await h.flush();
  assert.equal(h.calls.set, 1);
  assert.equal(h.read()?.value, "Using Claude Opus 4.8 here. <https://claw.acme.dev/projects/josh|More settings>");
  h.ensure(h.client, "D1");
  await h.flush();
  assert.equal(h.calls.info, 1, "the settled memo spares a steady-state DM both calls");
  assert.equal(h.calls.set, 1);
});

test("surface header ensurer collapses a burst on one channel into a single write", async () => {
  let infos = 0;
  let sets = 0;
  const client = {
    conversations: {
      info: async () => {
        infos += 1;
        await new Promise((r) => setTimeout(r, 5));
        return { channel: {} };
      },
      setTopic: async () => {
        sets += 1;
        return {};
      },
    },
  };
  const ensure = createSurfaceHeaderEnsurer({
    headerFacts: async () => ({ modelName: "Claude Opus 4.8" }),
    channelPinEnabled: async () => true,
    webUiPublicUrl: "https://claw.acme.dev",
    ids: { botUserId: "U0BOT" },
  });
  for (let i = 0; i < 5; i++) ensure(client as any, "D1", "personal:user.one@acme.dev", "dm");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(infos, 1, "the in-flight guard spares the concurrent probes");
  assert.equal(sets, 1);
});

test("a model change during an in-flight ensure is re-run, not dropped", async () => {
  let model = "Claude Opus 4.8";
  const writes: string[] = [];
  let pinned: { ts: string; user: string; text: string } | undefined;
  const client = {
    chat: {
      postMessage: async ({ text }: { text: string }) => {
        writes.push(text);
        pinned = { ts: "9.0", user: "U0BOT", text };
        return { ts: "9.0" };
      },
      update: async ({ text }: { text: string }) => {
        writes.push(text);
        if (pinned) pinned = { ...pinned, text };
        return {};
      },
    },
    pins: {
      list: async () => ({ items: pinned ? [{ message: pinned }] : [] }),
      add: async () => ({}),
    },
    conversations: {
      info: async () => {
        await new Promise((r) => setTimeout(r, 15));
        return { channel: {} };
      },
      setTopic: async () => ({}),
    },
  };
  const ensure = createSurfaceHeaderEnsurer({
    headerFacts: async () => ({ modelName: model }),
    channelPinEnabled: async () => true,
    webUiPublicUrl: "https://claw.acme.dev",
    ids: { botUserId: "U0BOT" },
  });
  ensure(client as any, "C1", "channel:C1", "channel", { pinNew: true });
  model = "Claude Haiku 4.5";
  ensure(client as any, "C1", "channel:C1", "channel");
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(
    writes.map((p) => p.split(" <")[0]),
    ["Using Claude Opus 4.8 here.", "Using Claude Haiku 4.5 here."],
    "the change that landed mid-probe still reaches the pinned header",
  );
});

test("surface header ensurer caps its per-channel memo", async () => {
  const client = {
    conversations: { info: async () => ({ channel: {} }), setTopic: async () => ({}) },
  };
  const ensure = createSurfaceHeaderEnsurer({
    headerFacts: async () => ({ modelName: "Claude Opus 4.8" }),
    channelPinEnabled: async () => true,
    webUiPublicUrl: "https://claw.acme.dev",
    ids: { botUserId: "U0BOT" },
    maxTracked: 3,
  });
  for (let i = 0; i < 10; i++) {
    ensure(client as any, `D${i}`, "personal:user.one@acme.dev", "dm");
    await new Promise((r) => setTimeout(r, 2));
  }
  let reprobed = 0;
  const spy = {
    conversations: {
      info: async () => {
        reprobed += 1;
        return { channel: {} };
      },
      setTopic: async () => ({}),
    },
  };
  ensure(spy as any, "D0", "personal:user.one@acme.dev", "dm");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reprobed, 1, "an evicted channel is re-probed, so the map cannot grow forever");
});

test("surface header ensurer posts and pins a channel's header message when asked to create it", async () => {
  const h = headerHarness(undefined, "Claude Opus 4.8", "channel");
  h.ensure(h.client, "C1", { pinNew: true });
  await h.flush();
  assert.equal(h.calls.set, 0, "a channel's topic and description are left alone");
  assert.deepEqual(h.calls.posted, [
    "Using Claude Opus 4.8 here. <https://claw.acme.dev/projects/channel/C1|More settings>",
  ]);
  assert.deepEqual(h.calls.pinned, ["99.0"], "the posted header message is pinned");
});

test("surface header ensurer updates an existing pinned header in place instead of reposting", async () => {
  const h = headerHarness(
    undefined,
    "Claude Haiku 4.5",
    "channel",
    "Using Claude Opus 4.8 here. <https://claw.acme.dev/projects/channel/C1|More settings>",
  );
  h.ensure(h.client, "C1");
  await h.flush();
  assert.deepEqual(h.calls.posted, [], "no new message when a pinned header already exists");
  assert.deepEqual(h.calls.updated, [
    "Using Claude Haiku 4.5 here. <https://claw.acme.dev/projects/channel/C1|More settings>",
  ]);
  assert.equal(h.readPin()?.text.startsWith("Using Claude Haiku 4.5"), true);
});

test("the pinned header is off by default — join creates nothing until the scope opts in", async () => {
  let wrote = 0;
  const client = {
    chat: {
      postMessage: async () => {
        wrote += 1;
        return { ts: "1.0" };
      },
      update: async () => {
        wrote += 1;
        return {};
      },
      delete: async () => ({}),
    },
    pins: {
      list: async () => ({ items: [] }),
      add: async () => {
        wrote += 1;
        return {};
      },
      remove: async () => ({}),
    },
    conversations: { info: async () => ({ channel: {} }), setTopic: async () => ({}) },
  };
  const ensure = createSurfaceHeaderEnsurer({
    headerFacts: async () => ({ modelName: "Claude Opus 4.8" }),
    webUiPublicUrl: "https://claw.acme.dev",
    ids: { botUserId: "U0BOT" },
  });
  ensure(client as any, "C1", "channel:C1", "channel", { pinNew: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(wrote, 0, "without an opt-in the join posts no header at all");
});

test("disabling the toggle unpins and deletes the bot's header message", async () => {
  const h = headerHarness(
    undefined,
    "Claude Opus 4.8",
    "channel",
    "Using Claude Opus 4.8 here. <https://claw.acme.dev/projects/channel/C1|More settings>",
  );
  h.flags.channelPinEnabled = false;
  h.ensure(h.client, "C1");
  await h.flush();
  assert.deepEqual(h.calls.unpinned, ["42.0"], "the header pin is removed");
  assert.deepEqual(h.calls.deleted, ["42.0"], "the header message is deleted");
  assert.equal(h.readPin(), undefined);
  assert.deepEqual(h.calls.posted, []);
});

test("re-enabling the toggle re-creates the pinned header on the next create-flagged ensure", async () => {
  const h = headerHarness(undefined, "Claude Opus 4.8", "channel");
  h.flags.channelPinEnabled = false;
  h.ensure(h.client, "C1", { pinNew: true });
  await h.flush();
  assert.deepEqual(h.calls.posted, [], "disabled: nothing posted");
  h.flags.channelPinEnabled = true;
  h.ensure(h.client, "C1", { pinNew: true });
  await h.flush();
  assert.deepEqual(h.calls.posted, [
    "Using Claude Opus 4.8 here. <https://claw.acme.dev/projects/channel/C1|More settings>",
  ]);
  assert.deepEqual(h.calls.pinned, ["99.0"]);
});

test("a DM topic ignores the channel toggle entirely", async () => {
  const h = headerHarness();
  h.flags.channelPinEnabled = false;
  h.ensure(h.client, "D1");
  await h.flush();
  assert.equal(h.calls.set, 1, "the DM topic is still written with the toggle off");
});

test("surface header ensurer never posts into an existing channel without the create flag", async () => {
  const h = headerHarness(undefined, "Claude Opus 4.8", "channel");
  h.ensure(h.client, "C1");
  await h.flush();
  assert.deepEqual(h.calls.posted, [], "no pinned header exists, and none may be created mid-conversation");
  assert.deepEqual(h.calls.updated, []);
  assert.deepEqual(h.calls.pinned, []);
});

test("surface header ensurer writes no channel header where an external member could read it", async () => {
  for (const shape of [{ is_ext_shared: true }, { is_mpim: true }]) {
    let writes = 0;
    const client = {
      chat: {
        postMessage: async () => {
          writes += 1;
          return { ts: "1.0" };
        },
        update: async () => {
          writes += 1;
          return {};
        },
      },
      pins: {
        list: async () => {
          writes += 1;
          return { items: [] };
        },
        add: async () => {
          writes += 1;
          return {};
        },
      },
      conversations: {
        info: async () => ({ channel: { ...shape } }),
        setTopic: async () => ({}),
      },
    };
    const ensure = createSurfaceHeaderEnsurer({
      headerFacts: async () => ({ modelName: "Claude Opus 4.8" }),
      channelPinEnabled: async () => true,
      webUiPublicUrl: "https://claw.acme.dev",
      ids: { botUserId: "U0BOT" },
    });
    ensure(client as any, "C1", "channel:C1", "channel", { pinNew: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(writes, 0, `a ${JSON.stringify(shape)} conversation is not the bot's to post a header into`);
  }
});

test("surface header ensurer never edits a pinned message the bot does not own", async () => {
  let updates = 0;
  const client = {
    chat: {
      postMessage: async () => ({ ts: "1.0" }),
      update: async () => {
        updates += 1;
        return {};
      },
    },
    pins: {
      list: async () => ({ items: [{ message: { ts: "5.0", user: "U0HUMAN", text: "Where we plan the launch" } }] }),
      add: async () => ({}),
    },
    conversations: {
      info: async () => ({ channel: {} }),
      setTopic: async () => ({}),
    },
  };
  const ensure = createSurfaceHeaderEnsurer({
    headerFacts: async () => ({ modelName: "Claude Opus 4.8" }),
    channelPinEnabled: async () => true,
    webUiPublicUrl: "https://claw.acme.dev",
    ids: { botUserId: "U0BOT" },
  });
  ensure(client as any, "C1", "channel:C1", "channel");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(updates, 0, "a message a human pinned is theirs");
});

test("scopeSurfaceUrl deep-links each context to its own project page", () => {
  assert.equal(scopeSurfaceUrl("https://claw.acme.dev/", "channel:C1"), "https://claw.acme.dev/projects/channel/C1");
  assert.equal(
    scopeSurfaceUrl("https://claw.acme.dev", "personal:user.one@acme.dev"),
    "https://claw.acme.dev/projects/user.one",
  );
  assert.equal(
    scopeSurfaceUrl("https://claw.acme.dev", "personal:User.Two@acme.dev"),
    "https://claw.acme.dev/projects/user.two",
  );
  assert.equal(
    scopeSurfaceUrl("https://claw.acme.dev", "personal:unsafe+slug@acme.dev"),
    "https://claw.acme.dev/contexts?scope=personal%3Aunsafe%2Bslug%40acme.dev",
  );
  assert.equal(scopeSurfaceUrl("https://claw.acme.dev", "group:G1"), "https://claw.acme.dev/projects/group/G1");
  assert.equal(scopeSurfaceUrl("https://claw.acme.dev", "team:T1"), "https://claw.acme.dev/contexts?scope=team%3AT1");
  assert.equal(scopeSurfaceUrl(undefined, "channel:C1"), undefined);
  assert.equal(scopeSurfaceUrl("https://claw.acme.dev", ""), undefined);
});

test("surface header ensurer never clobbers a human-written topic", async () => {
  const h = headerHarness({ value: "standup notes", creator: "U0HUMAN" });
  h.ensure(h.client, "D1");
  await h.flush();
  assert.equal(h.calls.set, 0);
  assert.equal(h.read()?.value, "standup notes");
});

test("surface header ensurer swallows a Slack failure instead of surfacing it to the turn", async () => {
  const ensure = createSurfaceHeaderEnsurer({
    headerFacts: async () => {
      throw new Error("core unreachable");
    },
    webUiPublicUrl: "https://claw.acme.dev",
    ids: { botUserId: "U0BOT" },
  });
  assert.doesNotThrow(() => ensure({} as any, "D1", "personal:user.one@acme.dev", "dm"));
  for (let i = 0; i < 12; i++) await Promise.resolve();
});
