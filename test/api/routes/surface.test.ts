import "../../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createInsecureTestServer } from "../../../src/api/server.ts";
import type { OrchestratorInput } from "../../../src/core/orchestrator.ts";
import type { Principal, Session } from "../../../src/types.ts";
import { buildApp as buildWiredApp } from "../../../src/wiring.ts";
import { buildApp } from "../../support/build-app.ts";
import { testConfig } from "../../support/test-config.ts";
import { listenLocal } from "../../support/listen-local.ts";
import type { AddressInfo } from "node:net";
import type { ContextSummary } from "../../../src/api/app.ts";

type Page = { sessions: Session[]; pinned?: Session[]; nextCursor: string | null; hasArchived?: boolean };

async function withServer<T>(
  fn: (
    built: ReturnType<typeof buildWiredApp>,
    get: (path: string) => Promise<{ status: number; body: unknown }>,
  ) => Promise<T>,
): Promise<T> {
  const built = buildWiredApp(testConfig());
  const server = createInsecureTestServer(built.app);
  const base = listenLocal(server);
  try {
    return await fn(built, async (path) => {
      const res = await fetch(base + path);
      return { status: res.status, body: await res.json() };
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
}

async function chat(built: ReturnType<typeof buildApp>, threadRef: string, title: string, owner = "U1") {
  const session = await built.sessions.getOrCreateByThread(threadRef, "dm", `personal:${owner}`, undefined, "web");
  await built.sessions.addParticipant(session.id, owner, title);
  return session;
}

function enqueueRequest(threadRef: string): OrchestratorInput {
  const principal: Principal = { id: "internal:U1", type: "internal" };
  return {
    actor: principal,
    conversation: { kind: "dm", threadRef, audience: [principal] },
    origin: { kind: "direct" },
    text: "working",
  };
}

test("the session list pages top-level chats newest first and keeps pinned, archived, children and automation runs out", async () => {
  await withServer(async (built, get) => {
    const chats = [];
    for (let i = 0; i < 5; i++) chats.push(await chat(built, `web:U1:c${i}`, `Chat ${i}`));
    const pinned = await chat(built, "web:U1:pinned", "Pinned");
    await built.sessions.updateParticipantView(pinned.id, "U1", { pinned: true });
    const archived = await chat(built, "web:U1:archived", "Archived");
    await built.sessions.updateParticipantView(archived.id, "U1", { archived: true });
    const child = await chat(built, "subagent:c0:1", "Child");
    await built.sessions.setParentSession(child.id, chats[0]!.id);
    const cron = await built.sessions.getOrCreateByThread("cron:job:1", "dm", "personal:U1", undefined, "cron");
    await built.sessions.addParticipant(cron.id, "U1", "Cron run");
    await chat(built, "web:U2:theirs", "Someone else's", "U2");

    const seen: Session[] = [];
    let page = (await get("/v1/sessions?principalId=U1&limit=2")).body as Page;
    assert.deepEqual(
      page.pinned?.map((s) => s.id),
      [pinned.id],
    );
    assert.equal(page.hasArchived, true);
    seen.push(...page.sessions);
    for (let guard = 0; page.nextCursor && guard < 5; guard++) {
      page = (await get(`/v1/sessions?principalId=U1&limit=2&before=${encodeURIComponent(page.nextCursor)}`))
        .body as Page;
      assert.equal(page.pinned, undefined, "only the first page carries pinned chats");
      seen.push(...page.sessions);
    }
    assert.equal(page.nextCursor, null);
    assert.deepEqual(
      seen.map((s) => s.id).sort(),
      chats.map((s) => s.id).sort(),
      "every top-level chat once; no pinned, archived, child, automation or foreign rows",
    );
    const activity = seen.map((s) => s.lastActivityAt ?? s.createdAt);
    assert.deepEqual(
      activity,
      [...activity].sort((a, b) => b - a),
    );
    for (const row of seen) assert.equal("hasEntries" in row, false);

    const archivedPage = (await get("/v1/sessions?principalId=U1&status=archived")).body as Page;
    assert.deepEqual(
      archivedPage.sessions.map((s) => s.id),
      [archived.id],
    );
    assert.equal((await get("/v1/sessions?principalId=U1&before=nonsense")).status, 400);
    assert.equal((await get("/v1/sessions?principalId=U1&status=deleted")).status, 400);
  });
});

test("a parent row counts its running subagents and its children load on demand", async () => {
  await withServer(async (built, get) => {
    const parent = await chat(built, "web:U1:parent", "Parent");
    const child = await chat(built, "subagent:parent:1", "Researcher");
    await built.sessions.setParentSession(child.id, parent.id);
    const grandchild = await chat(built, "subagent:child:1", "Helper");
    await built.sessions.setParentSession(grandchild.id, child.id);
    await built.runs.enqueue({ sessionId: grandchild.threadRef, request: enqueueRequest(grandchild.threadRef) });

    const page = (await get("/v1/sessions?principalId=U1")).body as Page;
    const row = page.sessions.find((s) => s.id === parent.id);
    assert.equal(row?.working, true);
    assert.deepEqual(row?.subagents, { running: 2, waiting: 0 }, "the child is working on behalf of its child");

    const children = (await get(`/v1/sessions/${parent.id}/children?principalId=U1`)).body as { sessions: Session[] };
    assert.deepEqual(children.sessions.map((s) => s.id).sort(), [child.id, grandchild.id].sort());
    assert.equal(children.sessions.find((s) => s.id === grandchild.id)?.working, true);
    assert.deepEqual(
      children.sessions.find((s) => s.id === child.id)?.subagents,
      { running: 1, waiting: 0 },
      "a subagent row counts its own subagents",
    );
    const childRow = (await get(`/v1/sessions/row?id=${child.id}&principalId=U1`)).body as { session: Session };
    assert.deepEqual(childRow.session.subagents, { running: 1, waiting: 0 });
    assert.equal((await get(`/v1/sessions/${parent.id}/children?principalId=U2`)).status, 404);
  });
});

test("one row can be looked up by id or thread, and only by someone who can see it", async () => {
  await withServer(async (built, get) => {
    const session = await chat(built, "web:U1:inbox", "Inbox");
    const byThread = (await get("/v1/sessions/row?principalId=U1&threadRef=web%3AU1%3Ainbox")).body as {
      session: Session;
    };
    assert.equal(byThread.session.id, session.id);
    assert.equal(byThread.session.canContinue, true);
    const byId = (await get(`/v1/sessions/row?principalId=U1&id=${session.id}`)).body as { session: Session };
    assert.equal(byId.session.threadRef, "web:U1:inbox");
    assert.equal("spawnMeta" in byId.session, false);
    assert.equal((await get(`/v1/sessions/row?principalId=U2&id=${session.id}`)).status, 404);
    assert.equal((await get("/v1/sessions/row?principalId=U1")).status, 400);
    const unused = await get("/v1/sessions/row?principalId=U2&threadRef=web%3AU2%3Ainbox");
    assert.equal(unused.status, 200, "a thread with no conversation yet is an empty row, not a 404");
    assert.deepEqual(unused.body, { session: null });
    const hidden = await get("/v1/sessions/row?principalId=U2&threadRef=web%3AU1%3Ainbox");
    assert.deepEqual(hidden.body, { session: null }, "someone else's thread reads as empty too");
  });
});

function start() {
  const built = buildApp(testConfig());
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { built, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const contexts = async (base: string, principalId: string): Promise<ContextSummary[]> => {
  const res = await fetch(`${base}/v1/contexts?principalId=${encodeURIComponent(principalId)}`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { contexts: ContextSummary[] }).contexts;
};

const webTurn = (base: string, actor: string, conversation: unknown, text = "hi") =>
  fetch(`${base}/v1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      origin: { kind: "direct" },
      surface: "web",
      actor: { externalId: actor },
      conversation,
      text,
    }),
  });

test("GET /v1/contexts: personal always; public channels and current private memberships", async () => {
  const s = start();
  try {
    const before = await contexts(s.base, "alice");
    assert.equal(before.length, 1);
    assert.equal(before[0]!.scopeId, "personal:alice");
    assert.equal(before[0]!.kind, "personal");

    await s.built.app.upsertChannels(
      [
        { channelId: "C1", name: "eng", isPrivate: false },
        { channelId: "C2", name: "sekrit", isPrivate: true },
      ],
      [{ channelId: "C2", principalId: "alice" }],
    );

    const alice = await contexts(s.base, "alice");
    assert.deepEqual(alice.map((c) => c.scopeId).sort(), ["channel:C1", "channel:C2", "personal:alice"]);
    assert.equal(alice[0]!.kind, "personal", "personal sorts first");
    assert.equal(alice.find((c) => c.scopeId === "channel:C2")!.isPrivate, true);

    const bob = await contexts(s.base, "bob");
    assert.deepEqual(
      bob.map((c) => c.scopeId).sort(),
      ["channel:C1", "personal:bob"],
      "public rooms remain usable without stale-session authority",
    );
  } finally {
    await s.close();
  }
});

test("web turns into a shared scope are membership-checked; sessions then count toward the context", async () => {
  const s = start();
  try {
    await s.built.app.upsertDirectory([
      { principalId: "alice", displayName: "Alice", type: "internal" },
      { principalId: "bob", displayName: "Bob", type: "internal" },
    ]);
    await s.built.app.upsertChannels(
      [
        { channelId: "C1", name: "eng", isPrivate: false },
        { channelId: "C2", name: "sekrit", isPrivate: true },
      ],
      [{ channelId: "C2", principalId: "alice" }],
    );

    const aliceOk = await webTurn(s.base, "alice", { kind: "channel", threadRef: "web:alice:t1", channelRef: "C2" });
    assert.equal(aliceOk.status, 200);
    const bobNo = await webTurn(s.base, "bob", { kind: "channel", threadRef: "web:bob:t1", channelRef: "C2" });
    assert.equal(bobNo.status, 403);
    assert.equal(
      (await webTurn(s.base, "bob", { kind: "channel", threadRef: "web:bob:t2", channelRef: "C1" })).status,
      200,
    );

    assert.equal(
      (await webTurn(s.base, "bob", { kind: "channel", threadRef: "web:bob:t3", channelRef: "C9" })).status,
      403,
    );
    assert.equal((await webTurn(s.base, "bob", { kind: "group", threadRef: "web:bob:t4" })).status, 403);

    const bob = await contexts(s.base, "bob");
    assert.ok(bob.some((c) => c.scopeId === "channel:C1"));

    const alice = await contexts(s.base, "alice");
    const c2 = alice.find((c) => c.scopeId === "channel:C2")!;
    assert.equal(c2.sessionCount, 1);
    assert.ok((c2.lastActivityAt ?? 0) > 0);
    const aliceSessions = await s.built.app.listSessions("alice");
    const expected = Math.max(
      ...aliceSessions.filter((x) => x.scopeId === "channel:C2").map((x) => x.lastActivityAt ?? x.createdAt),
    );
    assert.equal(
      c2.lastActivityAt,
      expected,
      "context recency is derived from session lastActivityAt, not a separate signal",
    );
  } finally {
    await s.close();
  }
});

test("a web turn carrying fastMode on a non-fast model is accepted; dispatch masks the flag", async () => {
  const s = start();
  try {
    const res = await fetch(`${s.base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        origin: { kind: "direct" },
        surface: "web",
        actor: { externalId: "alice" },
        conversation: { kind: "dm", threadRef: "web:alice:fast1" },
        text: "hi",
        model: "claude-fable-5",
        fastMode: true,
      }),
    });
    assert.equal(res.status, 200);
  } finally {
    await s.close();
  }
});

test("prior participation never authorizes a shared scope after directory membership is absent", async () => {
  const s = start();
  try {
    const slack = await fetch(`${s.base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        origin: { kind: "direct" },
        surface: "slack",
        actor: { externalId: "alice" },
        conversation: { kind: "group", threadRef: "grp:G1:1", channelRef: "G1" },
        text: "hello",
      }),
    });
    assert.equal(slack.status, 200);

    assert.equal(
      (await webTurn(s.base, "alice", { kind: "group", threadRef: "web:alice:g1", channelRef: "G1" })).status,
      403,
    );
    assert.equal(
      (await webTurn(s.base, "bob", { kind: "group", threadRef: "web:bob:g1", channelRef: "G1" })).status,
      403,
    );

    const alice = await contexts(s.base, "alice");
    assert.equal(
      alice.find((c) => c.scopeId === "group:G1"),
      undefined,
    );
  } finally {
    await s.close();
  }
});

test("a web turn can't pair an authorized scope claim with a thread living elsewhere", async () => {
  const s = start();
  try {
    await s.built.app.upsertChannels(
      [{ channelId: "C2", name: "sekrit", isPrivate: true }],
      [
        { channelId: "C2", principalId: "alice" },
        { channelId: "C2", principalId: "carol" },
      ],
    );

    assert.equal((await webTurn(s.base, "alice", { kind: "dm", threadRef: "web:alice:p1" })).status, 200);
    assert.equal(
      (await webTurn(s.base, "alice", { kind: "channel", threadRef: "web:alice:t1", channelRef: "C2" })).status,
      200,
    );

    assert.equal(
      (await webTurn(s.base, "carol", { kind: "channel", threadRef: "web:alice:t1", channelRef: "C2" })).status,
      200,
    );

    assert.equal((await webTurn(s.base, "carol", { kind: "dm", threadRef: "web:alice:t1" })).status, 403);
    assert.equal(
      (await webTurn(s.base, "carol", { kind: "channel", threadRef: "web:alice:p1", channelRef: "C2" })).status,
      403,
    );
    assert.equal(
      (await webTurn(s.base, "alice", { kind: "channel", threadRef: "web:alice:p1", channelRef: "C2" })).status,
      403,
    );

    assert.equal(
      (await webTurn(s.base, "carol", { kind: "channel", threadRef: "web:alice:default", channelRef: "C2" })).status,
      403,
    );
    assert.equal((await webTurn(s.base, "alice", { kind: "dm", threadRef: "web:alice:default" })).status, 200);
  } finally {
    await s.close();
  }
});

test("directory push stores the workspace URL; /v1/directory/meta serves it", async () => {
  const s = start();
  try {
    const before = await fetch(`${s.base}/v1/directory/meta`);
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), { workspaceUrl: null });

    const push = await fetch(`${s.base}/v1/directory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        members: [{ principalId: "alice", displayName: "Alice", type: "internal" }],
        workspaceUrl: "https://acme.slack.com/",
      }),
    });
    assert.equal(push.status, 200);

    const after = (await (await fetch(`${s.base}/v1/directory/meta`)).json()) as { workspaceUrl: string | null };
    assert.equal(after.workspaceUrl, "https://acme.slack.com", "stored normalized, trailing slash dropped");
  } finally {
    await s.close();
  }
});
