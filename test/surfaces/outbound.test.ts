import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutbound, type OutboundPost, createWebSurface } from "../../src/surfaces/outbound.ts";
import { createIdempotencyStore } from "../../src/idempotency/idempotency-store.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { createQueuedPosts, type QueuedPosts } from "../../src/surfaces/queued-posts.ts";
import { createMemorySessionStateBus, type SessionStateEvent } from "../../src/runs/session-state-bus.ts";
import { createTranscriptSource } from "../../src/sessions/transcript-source.ts";
import type { SessionStore } from "../../src/sessions/session-store.ts";
import type { DeliveryProvenance, Destination, ScopeId } from "../../src/types.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";

const post = (key: string, type = "slack"): OutboundPost => ({
  destination: { type, target: "C1:1.0" },
  text: `hello ${key}`,
  idempotencyKey: key,
});

const queued = async (retries: QueuedPosts, key: string) =>
  (await retries.entries()).find(([id]) => id === key)?.[1] ?? null;

function rig() {
  const url = testDatabaseUrl();
  const retries = createQueuedPosts(url);
  const sent: string[] = [];
  const after: string[] = [];
  let failure: Error | null = null;
  const outbound = createOutbound({
    idempotency: createIdempotencyStore(url),
    retries,
    afterSend: async (p) => void after.push(p.idempotencyKey),
  });
  outbound.register(["slack", "web"], async (p) => {
    if (failure) throw failure;
    sent.push(p.idempotencyKey);
  });
  return { outbound, retries, sent, after, fail: (e: Error | null) => (failure = e) };
}

test("a transient surface failure is queued, counted as sent once, and goes out when the surface recovers", async () => {
  const r = rig();
  r.fail(new Error("Slack is unreachable"));
  assert.deepEqual(await r.outbound.send(post("k1")), { queued: true });
  assert.deepEqual(await r.outbound.send(post("k1")), {}, "a repeat of the key is not queued twice");
  assert.equal((await r.retries.entries()).length, 1);
  r.fail(new Error("Slack is still unreachable"));
  assert.equal(await r.outbound.retryQueued(), 0);
  assert.equal((await queued(r.retries, "k1"))?.lastError, "Slack is still unreachable", "kept with its latest error");
  r.fail(null);
  assert.equal(await r.outbound.retryQueued(), 1);
  assert.deepEqual(r.sent, ["k1"]);
  assert.deepEqual(r.after, ["k1"], "recipient bookkeeping runs once the post really lands");
  assert.equal(await queued(r.retries, "k1"), null);
  assert.equal(await r.outbound.retryQueued(), 0);
});

test("a post for a surface that is not connected yet waits in the queue for it", async () => {
  const retries = createQueuedPosts(testDatabaseUrl());
  const outbound = createOutbound({ retries });
  assert.deepEqual(await outbound.send(post("k6")), { queued: true });
  const sent: string[] = [];
  outbound.register(["slack"], async (p) => void sent.push(p.idempotencyKey));
  assert.equal(await outbound.retryQueued(), 1);
  assert.deepEqual(sent, ["k6"]);
  await assert.rejects(createOutbound({}).send(post("k7")), /no slack connection is available/);
});

test("permanent refusals and web transcript failures throw instead of queueing", async () => {
  const r = rig();
  r.fail(Object.assign(new Error("channel_not_found"), { permanent: true }));
  await assert.rejects(r.outbound.send(post("k2")), /channel_not_found/);
  r.fail(new Error("database unavailable"));
  await assert.rejects(r.outbound.send(post("k3", "web")), /database unavailable/);
  assert.equal((await r.retries.entries()).length, 0);
  r.fail(null);
  await r.outbound.send(post("k2"));
  assert.deepEqual(r.sent, ["k2"], "a refused key was not remembered, so a later send can still go out");
});

test("a queued post that turns permanent or ages out is dropped", async () => {
  const r = rig();
  r.fail(new Error("timeout"));
  await r.outbound.send(post("k4"));
  await r.outbound.send(post("k5"));
  r.fail(Object.assign(new Error("not_in_channel"), { permanent: true }));
  const k5 = (await queued(r.retries, "k5"))!;
  await r.retries.put("k5", { ...k5, firstFailedAt: k5.firstFailedAt - 7 * 60 * 60_000 });
  assert.equal(await r.outbound.retryQueued(), 0);
  assert.equal((await r.retries.entries()).length, 0);
  assert.deepEqual(r.sent, []);
});

const THREAD = "web:alice@example.com:conv-1";
const SCOPE = "personal:alice@example.com" as ScopeId;

const cronProvenance = (over: Partial<DeliveryProvenance> = {}): DeliveryProvenance => ({
  trigger: "cron",
  surface: "cron",
  fireKey: "agent:main:cron:c1:100",
  sourceScopeId: SCOPE,
  sourceThreadRef: "agent:main:cron:c1",
  sourceSessionId: "cron-session",
  ...over,
});

const webDestination = (target = THREAD): Destination => ({ type: "web", target, audienceScopeId: SCOPE });

async function webSession(sessions: SessionStore, threadRef = THREAD) {
  return sessions.getOrCreateByThread(threadRef, "dm", SCOPE, undefined, "web");
}

function wired(leaseWaitMs?: number) {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const bus = createMemorySessionStateBus();
  const states: SessionStateEvent[] = [];
  bus.subscribe((event) => void states.push(event));
  const outbound = createOutbound({ idempotency: createIdempotencyStore(testDatabaseUrl()) });
  outbound.register(
    ["web"],
    createWebSurface({ sessions, sessionStates: bus, ...(leaseWaitMs !== undefined ? { leaseWaitMs } : {}) }).deliver,
  );
  return { sessions, outbound, states };
}

test("a cron post to a web conversation becomes one assistant message there, however often it is sent", async () => {
  const { sessions, outbound, states } = wired();
  const session = await webSession(sessions);
  await sessions.addParticipant(session.id, "alice@example.com");
  const post = {
    destination: webDestination(),
    text: "Reminder: standup in 10 minutes",
    idempotencyKey: "agent:main:cron:c1:900",
    provenance: cronProvenance(),
  };
  await outbound.send(post);
  await outbound.send(post);
  const items = (await createTranscriptSource(sessions).forRender(session.id)).items;
  assert.deepEqual(
    items.map((e) => [e.kind, e.text]),
    [["AgentMessage", "Reminder: standup in 10 minutes"]],
  );
  assert.equal(states.length, 1, "open web views are told to reload once");
  assert.deepEqual(
    [states[0]!.threadRef, states[0]!.state, states[0]!.participants],
    [THREAD, "idle", ["alice@example.com"]],
  );
});

test("a post marks the web conversation unread for its participant", async () => {
  const { sessions, outbound } = wired();
  const session = await webSession(sessions);
  await sessions.addParticipant(session.id, "alice@example.com");
  await sessions.updateParticipantView(session.id, "alice@example.com", { readAt: 1 });
  await outbound.send({
    destination: webDestination(),
    text: "Reminder",
    idempotencyKey: "agent:main:cron:c1:901",
    provenance: cronProvenance(),
  });
  assert.equal((await sessions.getForParticipant(session.id, "alice@example.com"))!.unread, true);
});

test("a conversation's own posts are already in its transcript and write nothing", async () => {
  const { sessions, outbound, states } = wired();
  const session = await webSession(sessions);
  await outbound.send({
    destination: webDestination(),
    text: "spine post",
    idempotencyKey: "post:1",
    provenance: cronProvenance({ sourceThreadRef: THREAD, trigger: "conversation" }),
  });
  await outbound.send({ destination: webDestination(), text: "no provenance", idempotencyKey: "reach:1" });
  assert.equal((await sessions.getItems(session.id)).length, 0);
  assert.equal(states.length, 0);
});

test("a recovered reply the turn never wrote is added to its own transcript", async () => {
  const { sessions, outbound } = wired();
  const session = await webSession(sessions);
  await outbound.send({
    destination: { ...webDestination(), webTranscript: { kind: "reply" } },
    text: "recovered reply",
    idempotencyKey: "run:r-1",
    provenance: cronProvenance({ sourceThreadRef: THREAD, trigger: "conversation" }),
  });
  const items = await sessions.getItems(session.id);
  assert.deepEqual(
    items.map((e) => [e.kind, e.text]),
    [["AgentMessage", "recovered reply"]],
  );
});

test("a busy conversation gets the message once its turn ends", async () => {
  const { sessions, outbound } = wired();
  const session = await webSession(sessions);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  assert.ok(lease);
  const sent = outbound.send({
    destination: webDestination(),
    text: "while you were busy",
    idempotencyKey: "agent:main:cron:c1:902",
    provenance: cronProvenance(),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await sessions.getItems(session.id)).length, 0);
  await sessions.releaseLease(lease);
  await sent;
  assert.equal((await sessions.getItems(session.id)).length, 1);
});

test("a conversation that stays busy fails the post, so the sender can retry it", async () => {
  const { sessions, outbound } = wired(100);
  const session = await webSession(sessions);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  const post = {
    destination: webDestination(),
    text: "retry me",
    idempotencyKey: "agent:main:cron:c1:903",
    provenance: cronProvenance(),
  };
  await assert.rejects(outbound.send(post), /stayed busy/);
  await sessions.releaseLease(lease!);
  await outbound.send(post);
  assert.equal((await sessions.getItems(session.id)).length, 1);
});

test("a post to a web conversation that does not exist fails loudly", async () => {
  const { outbound } = wired();
  await assert.rejects(
    outbound.send({
      destination: webDestination("web:alice@example.com:gone"),
      text: "hello?",
      idempotencyKey: "agent:main:cron:c1:904",
      provenance: cronProvenance(),
    }),
    /does not exist/,
  );
});
