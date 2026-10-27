import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresSwarmBoard } from "../../src/swarms/swarm-board.ts";
import { swarmCall, type SwarmCallContext, type SwarmInput, type SwarmMemberOpen } from "../../src/swarms/swarm.ts";
import type { SessionMailbox, SessionMessage } from "../../src/sessions/session-mailbox.ts";
import type { Session } from "../../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the swarm board tests";
const actor = { id: "alice@example.com" } as SwarmCallContext["actor"];

function world() {
  const board = createPostgresSwarmBoard(URL!);
  const sessions = new Map<string, Session>();
  const sent: SessionMessage[] = [];
  const opened: SwarmMemberOpen[] = [];
  const add = (title: string, parentSessionId?: string) => {
    const session = { id: randomUUID(), title, ...(parentSessionId ? { parentSessionId } : {}) } as Session;
    sessions.set(session.id, session);
    return session;
  };
  const ctx = (session: Session): SwarmCallContext => ({
    board,
    sessions: { get: async (id: string) => sessions.get(id) ?? null },
    mailbox: { send: async (message: SessionMessage) => void sent.push(message) } as unknown as SessionMailbox,
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
  return { board, sessions, sent, opened, add, ctx, call };
}

test("start opens ordinary subagents that share the coordinator's board", { skip }, async () => {
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

test("members post, reply, search and read threads; subscribers are told about new posts", { skip }, async () => {
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
