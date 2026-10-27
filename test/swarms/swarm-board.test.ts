import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresSwarmBoard } from "../../src/swarms/swarm-board.ts";
import { swarmCall, type SwarmCallContext, type SwarmInput, type SwarmMemberOpen } from "../../src/swarms/swarm.ts";
import type { SessionMailbox, SessionMessage } from "../../src/sessions/session-mailbox.ts";
import type { Session } from "../../src/types.ts";
import { createSwarmNoticeSweep } from "../../src/swarms/swarm-notices.ts";
import pg from "pg";

const URL = process.env.DATABASE_URL!;
const actor = { id: "alice@example.com" } as SwarmCallContext["actor"];

function world() {
  const board = createPostgresSwarmBoard(URL);
  const sessions = new Map<string, Session>();
  const sent: SessionMessage[] = [];
  const mailboxDown = { value: false };
  const opened: SwarmMemberOpen[] = [];
  const add = (title: string, parentSessionId?: string) => {
    const session = { id: randomUUID(), title, ...(parentSessionId ? { parentSessionId } : {}) } as Session;
    sessions.set(session.id, session);
    return session;
  };
  const ctx = (session: Session): SwarmCallContext => ({
    board,
    sessions: { get: async (id: string) => sessions.get(id) ?? null },
    mailbox: {
      send: async (message: SessionMessage) => {
        if (mailboxDown.value) throw new Error("mailbox unavailable");
        sent.push(message);
      },
    } as unknown as SessionMailbox,
    session,
    actor,
    audience: [],
    async open(input) {
      opened.push(input);
      const child = add(input.name ?? "member", session.id);
      return { ok: true, sessionId: child.id, title: child.title! };
    },
  });
  const call = async (session: Session, input: Omit<SwarmInput, "requestId">) => {
    const result = await swarmCall(ctx(session), { requestId: randomUUID(), ...input });
    if (!result.ok) throw new Error(result.message);
    return result.result;
  };
  return { board, sessions, sent, mailboxDown, opened, add, ctx, call };
}

test("start opens ordinary subagents that share the coordinator's board", async () => {
  const w = world();
  const parent = w.add("Requester");
  const coordinator = w.add("Coordinator", parent.id);
  const started = await w.call(coordinator, {
    action: "start",
    members: [
      { task: "Map the API", name: "api" },
      { task: "Map the UI", name: "ui" },
      { task: "Map the tests", name: "tests" },
    ],
    model: "cheap-model",
  });
  assert.equal(started.swarmId, coordinator.id);
  assert.equal((started.members as unknown[]).length, 3);
  assert.equal(w.opened.length, 3);
  assert.ok(w.opened.every((open) => open.model === "cheap-model"));
  assert.match(w.opened[0]!.task, /^Map the API\n\nYou are a member of the swarm "Coordinator" \(swarm ID /);
  const [api] = [...w.sessions.values()].filter((s) => s.title === "api");
  assert.equal((await w.call(api!, { action: "channels" })).swarmId, coordinator.id);
  const outside = await swarmCall(w.ctx(parent), { requestId: "x", action: "channels" });
  assert.equal(outside.ok, false);
  const nested = await swarmCall(w.ctx(api!), { requestId: "y", action: "start", members: [{ task: "more" }] });
  assert.equal(nested.ok, false);
});

test("members post, reply, search and read threads; subscribers are told about new posts", async () => {
  const w = world();
  const coordinator = w.add("Coordinator");
  await w.call(coordinator, {
    action: "start",
    members: [
      { task: "a", name: "a" },
      { task: "b", name: "b" },
    ],
  });
  const [a, b] = [...w.sessions.values()].filter((s) => s.parentSessionId === coordinator.id);
  await w.call(coordinator, { action: "subscribe" });
  await w.call(a!, { action: "subscribe" });
  assert.deepEqual((await w.call(b!, { action: "create_channel", channel: "Findings" })).created, true);
  const root = (await w.call(b!, { action: "post", text: "lane C is at 41.2" })).post as { id: string };
  assert.deepEqual(w.sent.map((m) => m.recipientId).sort(), [a!.id, coordinator.id].sort());
  assert.match(w.sent[0]!.text, /<swarm-board-post swarm="[^"]+" channel="general" postId="[^"]+" from="b"/);
  const reply = (await w.call(a!, { action: "post", replyTo: root.id, text: "confirmed" })).post as {
    replyTo: string;
    channel: string;
  };
  assert.equal(reply.replyTo, root.id);
  assert.equal(reply.channel, "general");
  assert.equal(w.sent.filter((m) => m.recipientId === a!.id).length, 1);
  await w.call(b!, { action: "post", channel: "findings", text: "separate finding" });
  const threads = (await w.call(coordinator, { action: "threads", channel: "general" })).posts as Array<{
    id: string;
    replies: number;
  }>;
  assert.deepEqual(
    threads.map((t) => [t.id, t.replies]),
    [[root.id, 1]],
  );
  const thread = (await w.call(coordinator, { action: "read_thread", postId: root.id })).posts as Array<{
    text: string;
  }>;
  assert.deepEqual(
    thread.map((p) => p.text),
    ["lane C is at 41.2", "confirmed"],
  );
  const found = (await w.call(a!, { action: "search", query: "FINDING" })).posts as Array<{ channel: string }>;
  assert.deepEqual(
    found.map((p) => p.channel),
    ["findings"],
  );
  const channels = (await w.call(a!, { action: "channels" })).channels as Array<{ name: string; posts: number }>;
  assert.deepEqual(
    channels.map((c) => [c.name, c.posts]),
    [
      ["general", 2],
      ["findings", 1],
    ],
  );
  await w.call(a!, { action: "unsubscribe" });
  await w.call(b!, { action: "post", text: "after unsubscribe" });
  assert.equal(w.sent.filter((m) => m.recipientId === a!.id).length, 1);
  const missing = await swarmCall(w.ctx(a!), { requestId: "z", action: "post", channel: "nope", text: "x" });
  assert.equal(missing.ok, false);
});

async function ageBoardPost(id: string, ms: number): Promise<void> {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  await client.query("UPDATE swarm_board_posts SET created_at = created_at - $2 WHERE id = $1", [id, ms]);
  await client.end();
}

const strandedPost = async (w: ReturnType<typeof world>) => {
  const coordinator = w.add("Coordinator");
  await w.call(coordinator, { action: "start", members: [{ task: "a", name: "a" }] });
  const [a] = [...w.sessions.values()].filter((s) => s.parentSessionId === coordinator.id);
  await w.call(coordinator, { action: "subscribe" });
  w.mailboxDown.value = true;
  const posted = await w.call(a!, { action: "post", text: "stranded" });
  assert.equal(posted.notified, 0);
  assert.match(String(posted.notifyError), /mailbox unavailable/);
  w.mailboxDown.value = false;
  return { coordinator, a: a!, postId: (posted.post as { id: string }).id };
};

const sweepFor = (w: ReturnType<typeof world>, author: Session) =>
  createSwarmNoticeSweep({ board: w.board, mailbox: w.ctx(author).mailbox });

test("a post whose notices failed is redelivered by the background sweep with the actor it was posted under", async () => {
  const w = world();
  const { coordinator, a, postId } = await strandedPost(w);
  const sweep = sweepFor(w, a);
  await w.call(a, { action: "channels" });
  assert.equal(w.sent.length, 0, "board actions no longer carry redelivery");
  assert.equal(await sweep.sweep(), 0, "a fresh post is left to its own delivery for the grace period");
  await ageBoardPost(postId, 120_000);
  w.sessions.delete(a.id);
  assert.equal(await sweep.sweep(), 1, "the author's session is not needed to redeliver");
  assert.deepEqual(
    w.sent.map((m) => [m.recipientId, m.senderId, m.actor.id, m.audience]),
    [[coordinator.id, a.id, actor.id, []]],
  );
  assert.equal(await sweep.sweep(), 0, "a delivered post is not sent again");
  assert.equal(w.sent.length, 1);
});

test("start opens members concurrently and keeps their order", async () => {
  const w = world();
  const coordinator = w.add("Coordinator");
  let inFlight = 0;
  let peak = 0;
  const base = w.ctx(coordinator);
  const result = await swarmCall(
    {
      ...base,
      async open(input) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return base.open(input);
      },
    },
    {
      requestId: "r",
      action: "start",
      members: Array.from({ length: 6 }, (_, i) => ({ task: `t${i}`, name: `m${i}` })),
    },
  );
  assert.ok(result.ok);
  assert.deepEqual(
    (result.result.members as Array<{ title: string }>).map((m) => m.title),
    ["m0", "m1", "m2", "m3", "m4", "m5"],
  );
  assert.equal(peak, 4);
});

test("read_thread stops at a text budget and pages on", async () => {
  const w = world();
  const coordinator = w.add("Coordinator");
  await w.call(coordinator, { action: "start", members: [{ task: "a", name: "a" }] });
  const root = (await w.call(coordinator, { action: "post", text: "root" })).post as { id: string };
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 3));
    await w.call(coordinator, { action: "post", replyTo: root.id, text: `${i}`.repeat(15_000) });
  }
  const first = await w.call(coordinator, { action: "read_thread", postId: root.id });
  const page = first.posts as Array<{ text: string; cursor: number }>;
  assert.equal(page.length, 5);
  assert.equal(first.nextAfter, page.at(-1)!.cursor);
  const rest = (await w.call(coordinator, { action: "read_thread", postId: root.id, after: first.nextAfter as number }))
    .posts as Array<{ text: string }>;
  assert.equal(rest.length, 2);
});
