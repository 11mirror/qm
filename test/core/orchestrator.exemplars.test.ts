import "../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTestApp } from "../support/test-app.ts";
import type { TurnRequest } from "../../src/types.ts";
import { testConfig } from "../support/test-config.ts";
import { setChannelInstructions } from "../support/channel-instructions.ts";
import { buildApp } from "../support/build-app.ts";
import type { Item } from "../../src/sessions/items.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const REQUEST = "<@U_CAROL> can you review these drafts and flag anything I missed?";

test("exemplar: a thread reply addressed to a teammate arrives author-attributed and the turn may stay silent", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-exemplar-"));
  const built = buildTestApp(testConfig({ dataDir }));
  built.runtime.start();
  try {
    const channel = "C_DRAFT_FIXTURE";
    const root = "100.1";

    await built.app.ingestSurfaceEvents(
      [
        {
          container: channel,
          ts: root,
          authorId: "U_CAROL",
          authorName: "Carol",
          text: "<@U_BOT> create draft replies for these customers",
          createdAt: 1,
        },
        {
          container: channel,
          ts: "100.3",
          sub: root,
          authorId: "U_ALICE",
          authorName: "Alice",
          text: REQUEST,
          createdAt: 2,
        },
      ],
      "slack",
      { name: "agent", mentionId: "U_BOT" },
    );

    const req: TurnRequest = {
      surface: "slack",
      actor: { externalId: "U_ALICE", displayName: "Alice" },
      conversation: {
        kind: "channel",
        threadRef: `ch:${channel}:${root}`,
        channelRef: channel,
        audience: [{ externalId: "U_ALICE" }],
      },
      deliveryTarget: `slack:${channel}:${root}`,
      text: REQUEST,
      async: true,
      origin: { kind: "ambient" },
    };
    await built.app.turn(req);

    const deadline = Date.now() + 5_000;
    let trigger: any;
    while (Date.now() < deadline && !trigger) {
      const sub = await built.sessions.getByThread(`ch:${channel}:${root}`);
      if (sub) {
        const items = await built.sessions.getItems(sub.id);
        trigger = items.find((e) => e.kind === "UserMessage" && String(e.text ?? "").includes("review these drafts"));
      }
      if (!trigger) await sleep(50);
    }
    assert.ok(trigger, "the message reached the turn's session");
    assert.equal(trigger.body.name, "Alice", "the trigger is author-attributed");
    assert.equal(trigger.text, REQUEST, "the message text is preserved");

    await sleep(500);
    assert.deepEqual(await built.posts.pending("slack"), [], "no delivery: the bot neither replied nor acted as Alice");
  } finally {
    await built.runtime.stop();
  }
});

const X_LINK_TS = "300.1";
const DIRECTIVE = [
  "TRIGGER: any top-level message containing an X/tweet link (x.com, twitter.com, t.co)",
  "ACTION: post ONE short, playful PIRATEY one-liner (vary the wording; include a 🏴‍☠️, ⚓, or ☠️) as a reply in that message's own thread",
  "DON'T: respond piratey to messages without an X link",
  "(per alice, updated 2026-07-01)",
  `!engage !postthread ${X_LINK_TS} Arrr, a fresh dispatch washes up from the X seas! 🏴‍☠️`,
].join("\n");

test("exemplar (piratey X-link): the worker gets the channel instructions verbatim and threads its reply under the trigger", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-exemplar-pirate-"));
  const built = buildTestApp(testConfig({ dataDir }));
  built.runtime.start();
  try {
    const container = "C-pirate";
    await setChannelInstructions(built, container, DIRECTIVE, "U-alice");

    await built.app.ingestSurfaceEvents(
      [
        {
          container,
          ts: X_LINK_TS,
          authorId: "U-alice",
          authorName: "alice",
          text: "<https://x.com/example/status/1234567890?s=20>",
          createdAt: 1,
        },
      ],
      "slack",
      { name: "qm", mentionId: "UBOT" },
    );

    const deadline = Date.now() + 5_000;
    let pending: any[] = [];
    while (Date.now() < deadline && !pending.length) {
      pending = (await built.posts.pending("slack")) as any[];
      if (!pending.length) await sleep(50);
    }
    assert.equal(pending.length, 1, "exactly one pirate reply");
    assert.equal(
      pending[0].destination.target,
      `${container}:${X_LINK_TS}`,
      "threaded under the X link, not top-level",
    );
    assert.match(pending[0].text, /^Arrr/);

    const workerSession = await built.sessions.getByThread(`slack:${container}:ambient:${X_LINK_TS}`);
    assert.ok(workerSession, "the ambient worker ran as its own sub-conversation");
    const prompts = JSON.stringify(await built.sessions.listLlmRequests(workerSession!.id));
    for (const line of ["DON'T: respond piratey to messages without an X link", "(per alice, updated 2026-07-01)"]) {
      assert.ok(
        prompts.includes(JSON.stringify(line).slice(1, -1)),
        `instructions not verbatim in the prompt: "${line}"`,
      );
    }
    const entries = await built.sessions.getItems(workerSession!.id);
    assert.ok(
      !entries.some((e) => e.kind === "UserMessage" && (e.text ?? "").includes("<standing-orders")),
      "the wake no longer repeats the instructions",
    );
  } finally {
    await built.runtime.stop();
  }
});

const QUESTION = "can you summarize the time constraints discussed here for the customer workshop next month";

const SOUP = [
  { ts: "10.1", author: "bob", text: "the new gallery exhibit is open through the end of the month" },
  { ts: "10.2", author: "alice", text: "nice, my cousin is visiting then" },
  { ts: "10.3", author: "bob", text: "here is a poster you might like", files: ["gallery-poster.heic"] },
  { ts: "10.4", author: "alice", text: "", files: ["vacation-photo.jpg"] },
  { ts: "10.5", author: "alice", text: "a designer sent me an unrelated prototype" },
  { ts: "10.6", author: "alice", text: "should we choose dates for the customer workshop next month?" },
];

test("exemplar: a narrow question runs topic-scoped — no soup replay, no pushed files, history pullable", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-exemplar-topic-"));
  const built = buildApp(testConfig({ dataDir }));
  built.runtime.start();
  try {
    const channel = "C_TOPIC_FIXTURE";

    await built.app.ingestSurfaceEvents(
      SOUP.map((m, i) => ({
        container: channel,
        ts: m.ts,
        authorId: `U-${m.author}`,
        authorName: m.author,
        text: m.text,
        createdAt: i + 1,
      })),
      "slack",
      { name: "agent", mentionId: "U_BOT" },
    );

    const root = "20.1";
    const alice = { externalId: "U_ALICE", displayName: "alice" };
    const req: TurnRequest = {
      surface: "slack",
      actor: alice,
      conversation: { kind: "channel", threadRef: `ch:${channel}:${root}`, channelRef: channel, audience: [alice] },
      deliveryTarget: `slack:${channel}:${root}`,
      text: QUESTION,
      async: true,
      origin: { kind: "human" },
    };
    await built.app.turn(req);

    const deadline = Date.now() + 5_000;
    let items: Item[] = [];
    while (Date.now() < deadline) {
      const sub = await built.sessions.getByThread(`ch:${channel}:${root}`);
      if (sub) items = await built.sessions.getItems(sub.id);
      if (items.some((e) => e.kind === "UserMessage" && String(e.text ?? "").includes("time constraints"))) break;
      await sleep(50);
    }
    const users = items.filter((e) => e.kind === "UserMessage");
    assert.ok(
      users.some((p) => (p.text ?? "").includes("time constraints") && p.body.name === "alice"),
      "the question is in its own thread session, attributed",
    );

    for (const m of SOUP) {
      if (!m.text) continue;
      assert.ok(
        !users.some((p) => (p.text ?? "").includes(m.text.slice(0, 40))),
        `overheard soup replayed into the session: ${m.text.slice(0, 60)}`,
      );
    }

    const allPayloads = items.map((e) => JSON.stringify(e));
    for (const f of ["vacation-photo.jpg", "gallery-poster.heic"]) {
      assert.ok(!allPayloads.some((s) => s.includes(f)), `backscroll file pushed into the turn: ${f}`);
    }

    let fulfilling = true;
    const fulfiller = (async () => {
      while (fulfilling) {
        const pending = await (built.app as any).pendingContextRequests("slack");
        for (const r of pending)
          await (built.app as any).fulfillContextRequest(r.id, {
            result: { messages: SOUP.map((m) => ({ ts: m.ts, author: m.author, text: m.text })) },
          });
        await sleep(20);
      }
    })();
    const root2 = "21.1";
    await built.app.turn({
      surface: "slack",
      actor: alice,
      conversation: { kind: "channel", threadRef: `ch:${channel}:${root2}`, channelRef: channel, audience: [alice] },
      deliveryTarget: `slack:${channel}:${root2}`,
      text: "!whats_new",
      async: true,
      origin: { kind: "human" },
    });
    let pulled = false;
    const d2 = Date.now() + 5_000;
    while (Date.now() < d2 && !pulled) {
      const sub2 = await built.sessions.getByThread(`ch:${channel}:${root2}`);
      if (sub2) {
        const e2 = await built.sessions.getItems(sub2.id);
        pulled = e2.some((e) => e.kind === "ToolResult" && e.tool === "whats_new" && e.body.ok === true);
      }
      if (!pulled) await sleep(50);
    }
    fulfilling = false;
    await fulfiller;
    assert.ok(pulled, "the channel history is readable on demand (whats_new succeeded)");
  } finally {
    await built.runtime.stop();
  }
});
