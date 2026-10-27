import "../../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, before, after, test } from "node:test";
import { createServer, createInsecureTestServer } from "../../../src/api/server.ts";
import { startSession } from "../../../src/api/start-session.ts";
import {
  mintCapabilityToken,
  CAPABILITY_TTL_MS,
  CONTROL_PLANE_AUD,
  type CapabilityClaims,
} from "../../../src/auth/capability-token.ts";
import { createPostgresReplayDedupe } from "../../../src/auth/replay-dedupe.ts";
import type { OrchestratorInput } from "../../../src/core/orchestrator.ts";
import { scopeId, type TurnRequest, type Principal, type Session } from "../../../src/types.ts";
import { type BuiltApp, buildApp as buildWiredApp } from "../../../src/wiring.ts";
import { buildApp } from "../../support/build-app.ts";
import { testConfig } from "../../support/test-config.ts";
import { testDatabaseUrl } from "../../support/test-database.ts";

const SECRET = "agent-conversations-secret".repeat(2);

function dm(externalId: string, text: string, thread: string): TurnRequest {
  return { surface: "test", actor: { externalId }, conversation: { kind: "dm", threadRef: thread }, text };
}

describe("agent conversations self-API", async () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;
  let mineId: string;
  let theirsId: string;

  const capFor = (actorId: string, scope = scopeId("personal", actorId), live = true) =>
    mintCapabilityToken(
      { actorId, scopeId: scope, aud: CONTROL_PLANE_AUD, exp: Date.now() + CAPABILITY_TTL_MS, liveActor: live },
      SECRET,
    );

  const get = async (path: string, token?: string) =>
    fetch(`${base}${path}`, { headers: token ? { "x-agent-capability": token } : {} });
  const post = async (path: string, body: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { "x-agent-capability": token } : {}) },
      body: JSON.stringify(body),
    });

  before(async () => {
    built = buildApp(testConfig({ signingSecret: SECRET }));
    server = createServer(built.app, {
      replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
      signingSecret: SECRET,
      portalUrl: "https://portal.example/",
      sessions: built.sessions,
      memory: built.memory,
      config: built.config,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    mineId = (await built.app.turn(dm("U1", "plan the launch", "web:U1:c1"))).sessionId!;
    theirsId = (await built.app.turn(dm("U2", "someone else's chat", "web:U2:c1"))).sessionId!;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("web conversations go unread on an agent reply until read; other threads never do", async () => {
    const unread = async (id: string) => (await built.app.listSessions("U1")).find((s) => s.id === id)?.unread === true;
    assert.equal(await unread(mineId), true);
    await built.app.updateSession(mineId, "U1", { readAt: Date.now() });
    assert.equal(await unread(mineId), false);
    await built.app.updateSession(mineId, "U1", { readAt: 0 });
    assert.equal(await unread(mineId), true);
    const slackId = (await built.app.turn(dm("U1", "from slack", "dm:D1")))!.sessionId!;
    assert.equal(await unread(slackId), false);
  });

  it("new sessions start clean with only the seed text", async () => {
    const out = await startSession(built.app, built.sessions, "U1", {
      scopeId: scopeId("personal", "U1"),
      text: "investigate the flaky test",
      title: "Flaky test hunt",
    });
    assert.ok("session" in out);
    assert.notEqual(out.session.id, mineId);
    assert.equal(out.session.title, "Flaky test hunt");
    const [run] = await built.runs.inFlightForThread(out.session.threadRef);
    assert.equal(run?.request.text, "investigate the flaky test");
    assert.equal(run?.request.surface, "web");
    const items = await built.sessions.getItems(out.session.id);
    assert.ok(!items.some((e) => JSON.stringify(e).includes("plan the launch")));
    const listed = await built.app.listSessions("U1");
    assert.ok(listed.some((s) => s.id === out.session.id));
  });

  it("new sessions and forks seeded by a person's turn keep that person's origin and provenance", async () => {
    const source = await built.runs.latestForThread("web:U1:c1");
    const provenance = {
      origin: { kind: "human" as const, messageTs: "1700000000.000100" },
      sessionSenderId: mineId,
      ...(source ? { delegatingRunId: source.id } : {}),
    };
    for (const extra of [{}, { forkOf: mineId }]) {
      const out = await startSession(built.app, built.sessions, "U1", {
        scopeId: scopeId("personal", "U1"),
        text: "follow up on the launch",
        ...extra,
        ...provenance,
      });
      assert.ok("session" in out);
      const [run] = await built.runs.inFlightForThread(out.session.threadRef);
      assert.deepEqual(run?.request.origin, { kind: "human" });
      assert.equal(run?.request.sessionSenderId, mineId);
      assert.equal(run?.request.delegatingRunId, source?.id);
    }
  });

  it("a blank fork starts no turn", async () => {
    const out = await startSession(built.app, built.sessions, "U1", {
      scopeId: scopeId("personal", "U1"),
      forkOf: mineId,
      origin: { kind: "human" },
      sessionSenderId: mineId,
    });
    assert.ok("session" in out);
    assert.deepEqual(await built.runs.inFlightForThread(out.session.threadRef), []);
  });

  it("spawned provenance fields stay out of public turns", async () => {
    await built.app.turn({
      ...dm("U1", "pretend", "web:U1:c9"),
      sessionSenderId: mineId,
      delegatingRunId: "run-forged",
      async: true,
    });
    const [run] = await built.runs.inFlightForThread("web:U1:c9");
    assert.ok(run);
    assert.equal(run.request.sessionSenderId, undefined);
    assert.equal(run.request.delegatingRunId, undefined);
  });

  it("new sessions in a channel seed their turn on that channel", async () => {
    await built.app.upsertDirectory([{ principalId: "U1", displayName: "User One", type: "internal" }]);
    await built.app.upsertChannels(
      [{ channelId: "C1", name: "engineering", isPrivate: true }],
      [{ channelId: "C1", principalId: "U1" }],
    );
    const out = await startSession(built.app, built.sessions, "U1", {
      scopeId: scopeId("channel", "C1"),
      text: "investigate the channel deployment",
    });
    assert.ok("session" in out);
    assert.equal(out.session.scopeId, scopeId("channel", "C1"));
    const [run] = await built.runs.inFlightForThread(out.session.threadRef);
    assert.equal(run?.request.conversation.channelRef, "C1");
  });

  it("a refused seed discards a new session but reports a fork it left", async () => {
    const raced: typeof built.app = {
      ...built.app,
      turn: async (req) =>
        (req as { spawned?: boolean }).spawned
          ? { status: "refused", reason: "project membership changed" }
          : built.app.turn(req),
    };
    const ids = async () => (await built.app.listSessions("U1")).map((s) => s.id).sort();
    const before = await ids();
    assert.deepEqual(
      await startSession(raced, built.sessions, "U1", { scopeId: scopeId("personal", "U1"), text: "refused" }),
      { error: "project membership changed" },
    );
    assert.deepEqual(await ids(), before);
    const forked = await startSession(raced, built.sessions, "U1", {
      scopeId: scopeId("personal", "U1"),
      forkOf: mineId,
      text: "refused",
    });
    assert.ok("session" in forked);
    assert.equal(forked.refused, "project membership changed");
  });

  it("refuses a scope or fork source the actor can't use", async () => {
    assert.ok(
      "error" in
        (await startSession(built.app, built.sessions, "U1", { scopeId: scopeId("personal", "U2"), text: "peek" })),
    );
    assert.ok(
      "error" in
        (await startSession(built.app, built.sessions, "U1", { scopeId: scopeId("personal", "U1"), forkOf: theirsId })),
    );
  });

  it("requires a capability token", async () => {
    assert.equal((await get("/v1/conversations")).status, 401);
    assert.equal((await get(`/v1/conversations/${mineId}`)).status, 401);
    assert.equal((await post(`/v1/conversations/${mineId}`, { archived: true })).status, 401);
  });

  it("lists only the actor's own conversations", async () => {
    const res = await get("/v1/conversations", await capFor("U1"));
    assert.equal(res.status, 200);
    const { conversations } = (await res.json()) as { conversations: Array<{ id: string; archived: boolean }> };
    assert.ok(conversations.some((c) => c.id === mineId));
    assert.ok(!conversations.some((c) => c.id === theirsId), "another person's conversation never appears");
  });

  it("archives and unarchives one of the actor's own conversations", async () => {
    const token = await capFor("U1");
    const res = await post(`/v1/conversations/${mineId}`, { archived: true }, token);
    assert.equal(res.status, 200);
    const { conversation } = (await res.json()) as { conversation: { archived: boolean } };
    assert.equal(conversation.archived, true);

    const back = await post(`/v1/conversations/${mineId}`, { archived: false }, token);
    assert.equal(back.status, 200);
    assert.equal(((await back.json()) as { conversation: { archived: boolean } }).conversation.archived, false);
  });

  it("archiving is per-participant view state, not visible to the other viewer's list semantics", async () => {
    const token = await capFor("U1");
    await post(`/v1/conversations/${mineId}`, { archived: true }, token);
    const other = await built.app.listSessions("U2");
    assert.ok(!other.some((s) => s.id === mineId && s.archived), "U1's archive never marks U2's view");
    await post(`/v1/conversations/${mineId}`, { archived: false }, token);
  });

  it("refuses a conversation the actor can't see (404, no existence leak)", async () => {
    const token = await capFor("U1");
    assert.equal((await get(`/v1/conversations/${theirsId}`, token)).status, 404);
    assert.equal((await post(`/v1/conversations/${theirsId}`, { archived: true }, token)).status, 404);
  });

  it("reads and tail-pages one of the actor's own conversations", async () => {
    for (let turn = 2; turn <= 21; turn++) {
      await built.app.turn(dm("U1", `launch question ${turn}`, "web:U1:c1"));
    }
    const token = await capFor("U1");
    const bounded = await get(`/v1/conversations/${mineId}`, token);
    assert.equal(bounded.status, 200);
    const boundedBody = (await bounded.json()) as {
      items: Array<{ kind: string; text: string | null }>;
      earlierItems?: number;
    };
    assert.ok(!boundedBody.items.some((item) => item.text === "plan the launch"));
    assert.ok(boundedBody.items.some((item) => item.text === "launch question 21"));
    assert.ok((boundedBody.earlierItems ?? 0) > 0);

    const tail = await get(`/v1/conversations/${mineId}?tailTurns=1`, token);
    assert.equal(tail.status, 200);
    const tailBody = (await tail.json()) as {
      items: Array<{ kind: string; text: string | null }>;
      earlierItems?: number;
    };
    assert.ok(tailBody.items.some((item) => item.text === "launch question 21"));
    assert.ok(!tailBody.items.some((item) => item.text === "launch question 20"));
    assert.ok((tailBody.earlierItems ?? 0) > 0);
    assert.equal((await get(`/v1/conversations/${mineId}?sinceSeq=0`, token)).status, 400);
  });

  it("forks carry the source transcript into a new sidebar session", async () => {
    const out = await startSession(built.app, built.sessions, "U1", {
      scopeId: scopeId("personal", "U1"),
      forkOf: mineId,
    });
    assert.ok("session" in out);
    assert.notEqual(out.session.id, mineId);
    const items = await built.sessions.getItems(out.session.id);
    assert.ok(items.some((e) => JSON.stringify(e).includes("plan the launch")));
    assert.ok((await built.app.listSessions("U1")).some((s) => s.id === out.session.id));
  });

  it("refuses to color a conversation the actor can't see", async () => {
    const res = await post(`/v1/conversations/${theirsId}`, { color: "#123456" }, await capFor("U1"));
    assert.equal(res.status, 404);
  });

  it("validates the patch body", async () => {
    const token = await capFor("U1");
    assert.equal((await post(`/v1/conversations/${mineId}`, {}, token)).status, 400);
    assert.equal((await post(`/v1/conversations/${mineId}`, { archived: "yes" }, token)).status, 400);
    assert.equal((await post(`/v1/conversations/${mineId}`, { title: 5 }, token)).status, 400);
    assert.equal((await post(`/v1/conversations/${mineId}`, { color: "red" }, token)).status, 400);
  });

  it("sets and clears the sidebar color", async () => {
    const token = await capFor("U1");
    const set = await post(`/v1/conversations/${mineId}`, { color: "#A1B2C3" }, token);
    assert.equal(set.status, 200);
    assert.equal(((await set.json()) as { conversation: { color: string | null } }).conversation.color, "#a1b2c3");

    const clear = await post(`/v1/conversations/${mineId}`, { color: null }, token);
    assert.equal(clear.status, 200);
    assert.equal(((await clear.json()) as { conversation: { color: string | null } }).conversation.color, null);
  });

  it("renames and pins through the same patch", async () => {
    const token = await capFor("U1");
    const res = await post(`/v1/conversations/${mineId}`, { title: "Launch plan", pinned: true }, token);
    assert.equal(res.status, 200);
    const { conversation } = (await res.json()) as { conversation: { title: string | null; pinned: boolean } };
    assert.equal(conversation.title, "Launch plan");
    assert.equal(conversation.pinned, true);
  });
});

type Page = { sessions: Session[]; pinned?: Session[]; nextCursor: string | null; hasArchived?: boolean };

async function withServer<T>(
  fn: (
    built: ReturnType<typeof buildWiredApp>,
    get: (path: string) => Promise<{ status: number; body: unknown }>,
  ) => Promise<T>,
): Promise<T> {
  const built = buildWiredApp(testConfig());
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
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

const CAPABILITY_ROUTES_SECRET = "route-test-secret".repeat(3);

describe("capability-token control plane (SOUL)", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const capFor = async (actorId: string, scope = scopeId("personal", actorId), extra: Partial<CapabilityClaims> = {}) =>
    await mintCapabilityToken(
      {
        actorId,
        scopeId: scope,
        destination: { type: "slack", target: `D-${actorId}`, audienceScopeId: scope },
        exp: Date.now() + CAPABILITY_TTL_MS,
        ...extra,
      },
      CAPABILITY_ROUTES_SECRET,
    );

  const THREAD = {
    key: "k-thread",
    type: "slack",
    target: "C:111",
    audienceScopeId: scopeId("channel", "C"),
    label: "this thread",
  } as const;
  const ROOT = {
    key: "k-root",
    type: "slack",
    target: "C",
    audienceScopeId: scopeId("channel", "C"),
    label: "#eng (the whole channel)",
  } as const;
  const capChannel = async (actorId: string, extra: Partial<CapabilityClaims> = {}) =>
    await mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("channel", "C"),
        destination: { type: THREAD.type, target: THREAD.target, audienceScopeId: THREAD.audienceScopeId },
        destinations: [THREAD, ROOT],
        defaultDestinationKey: THREAD.key,
        exp: Date.now() + CAPABILITY_TTL_MS,
        ...extra,
      },
      CAPABILITY_ROUTES_SECRET,
    );

  before(async () => {
    built = buildApp(testConfig({ signingSecret: CAPABILITY_ROUTES_SECRET }));
    await built.directory.replaceChannels(
      [{ channelId: "C", name: "eng", isPrivate: false }],
      ["admin-alice", "U1", "U2", "U8"].map((principalId) => ({ channelId: "C", principalId })),
    );
    server = createServer(built.app, {
      replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
      signingSecret: CAPABILITY_ROUTES_SECRET,
      scheduler: built.scheduler,
      config: built.config,
      admin: built.admin,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });
  it("updates only the caller's OWN personal SOUL, ignoring body scope/actor", async () => {
    const orgVerBefore = built.config.instructionsVersion(scopeId("org", "default-org"));
    const res = await post(
      "/v1/instructions",
      { content: "Always answer in bullet points.", scopeId: "org:default-org", actorId: "U2" },
      { "x-agent-capability": await capFor("U1") },
    );
    assert.equal(res.status, 200);
    assert.ok(built.config.instructionsVersion(scopeId("personal", "U1")) >= 1, "U1's personal SOUL was updated");
    assert.equal(
      built.config.instructionsVersion(scopeId("org", "default-org")),
      orgVerBefore,
      "org SOUL floor untouched",
    );
  });

  it("updates the token's shared-scope SOUL without touching the actor's personal SOUL", async () => {
    const personalScope = scopeId("personal", "U8");
    const channelScope = scopeId("channel", "C");
    const personalBefore = built.config.instructionsVersion(personalScope);
    const res = await post(
      "/v1/instructions",
      { content: "Channel C speaks in haiku.", scopeId: personalScope, actorId: "U2" },
      { "x-agent-capability": await capChannel("U8") },
    );
    assert.equal(res.status, 200);

    assert.equal(built.config.getInstructions(channelScope), "Channel C speaks in haiku.");
    assert.ok(built.config.instructionsVersion(channelScope) >= 1, "channel SOUL was updated");
    assert.equal(
      built.config.instructionsVersion(personalScope),
      personalBefore,
      "actor's personal SOUL was not touched",
    );
  });

  it("does not let capability self-update org or team SOUL", async () => {
    const orgScope = scopeId("org", "default-org");
    const teamScope = scopeId("team", "T");
    const orgBefore = built.config.instructionsVersion(orgScope);

    const orgRes = await post(
      "/v1/instructions",
      { content: "replace org" },
      { "x-agent-capability": await capFor("U1", orgScope) },
    );
    const teamRes = await post(
      "/v1/instructions",
      { content: "replace team" },
      { "x-agent-capability": await capFor("U1", teamScope) },
    );

    assert.equal(orgRes.status, 403);
    assert.equal(teamRes.status, 403);
    assert.equal(built.config.instructionsVersion(orgScope), orgBefore);
    assert.equal(built.config.getInstructions(teamScope), null);
  });

  it("reads the caller's in-scope SOUL under a capability", async () => {
    const personalScope = scopeId("personal", "U7");
    await built.config.setInstructions(personalScope, "Prefer precise, compact answers.");

    const res = await get("/v1/instructions?scopeId=personal:U2", { "x-agent-capability": await capFor("U7") });
    assert.equal(res.status, 200);

    const got = (await res.json()) as any;
    assert.equal(got.scopeId, personalScope, "query scope is ignored; the token's signed scope wins");
    assert.equal(got.instructions, "Prefer precise, compact answers.");
    assert.ok(got.instructionsVersion >= 1);
    assert.equal(got.orgScopeId, scopeId("org", "default-org"));
    assert.equal(typeof got.orgInstructions, "string");
    assert.ok(got.effectiveInstructions.includes("Prefer precise, compact answers."));
    assert.ok(got.effectiveInstructions.includes(got.orgInstructions));
  });

  it("effective SOUL deduplicates organization text without rewriting stored scope policy", async () => {
    const orgScope = scopeId("org", "default-org");
    const personalScope = scopeId("personal", "U7");
    const orgInstructions = built.config.getInstructions(orgScope)!;
    await built.config.setInstructions(personalScope, ` ${orgInstructions} `);
    const res = await get("/v1/instructions", { "x-agent-capability": await capFor("U7") });
    assert.equal(res.status, 200);
    const got = (await res.json()) as any;
    assert.equal(got.instructions, ` ${orgInstructions} `);
    assert.equal(got.effectiveInstructions.split(orgInstructions).length - 1, 1);
    assert.equal(built.config.getInstructions(personalScope), got.instructions);
  });

  it("reads channel SOUL for a channel-scoped token without exposing the actor's personal SOUL", async () => {
    await built.config.setInstructions(scopeId("personal", "U8"), "Private U8 instruction.");
    await built.config.setInstructions(scopeId("channel", "C"), "Channel C instruction.");

    const res = await get("/v1/instructions?scopeId=personal:U8", { "x-agent-capability": await capChannel("U8") });
    assert.equal(res.status, 200);

    const got = (await res.json()) as any;
    assert.equal(got.scopeId, scopeId("channel", "C"));
    assert.equal(got.instructions, "Channel C instruction.");
    assert.ok(got.effectiveInstructions.includes("Channel C instruction."));
    assert.equal(got.effectiveInstructions.includes("Private U8 instruction."), false);
  });

  it("channel-header-pin takes the actor and scope from the token and refuses non-live tokens", async () => {
    const put = (body: unknown, token: string) =>
      fetch(`${base}/v1/channel-header-pin`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-agent-capability": token },
        body: JSON.stringify(body),
      });
    const live = await capChannel("U1", { liveActor: true });
    const spoofed = await put({ on: true, principalId: "U2", scopeId: "channel:OTHER" }, live);
    assert.equal(spoofed.status, 200);
    assert.equal(((await spoofed.json()) as { scopeId: string }).scopeId, "channel:C");
    const triggered = await put({ on: false }, await capChannel("U1", { triggered: true }));
    assert.equal(triggered.status, 403);
    assert.deepEqual(await triggered.json(), { error: "live_actor_required" });
  });

  it("rejects an invalid/expired token with 401", async () => {
    assert.equal((await post("/v1/instructions", { content: "x" }, { "x-agent-capability": "garbage" })).status, 401);
    const expired = await mintCapabilityToken(
      { actorId: "U1", scopeId: "personal:U1", exp: Date.now() - 1 },
      CAPABILITY_ROUTES_SECRET,
    );
    assert.equal((await post("/v1/instructions", { content: "x" }, { "x-agent-capability": expired })).status, 401);
  });

  it("refuses a capability token on a non-self-service route (e.g. /v1/turns) with 403", async () => {
    const res = await post(
      "/v1/turns",
      { surface: "x", actor: { externalId: "U1" }, conversation: { kind: "dm", threadRef: "t" }, text: "hi" },
      { "x-agent-capability": await capFor("U1") },
    );
    assert.equal(res.status, 403);
  });

  it("refuses a capability token minted for another audience on a self-service route", async () => {
    const foreign = await capFor("U1", scopeId("personal", "U1"), { aud: "some-other-surface" });
    const res = await get("/v1/keychain/overview", { "x-agent-capability": foreign });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /audience not valid/);
    const ok = await get("/v1/keychain/overview", { "x-agent-capability": await capFor("U1") });
    assert.notEqual(ok.status, 403);
  });

  it("a public channel remains available to an active internal principal outside its current roster", async () => {
    await built.directory.replaceChannels(
      [{ channelId: "C", name: "eng", isPrivate: false }],
      ["admin-alice", "U1", "U2"].map((principalId) => ({ channelId: "C", principalId })),
    );
    assert.equal((await get("/v1/instructions", { "x-agent-capability": await capChannel("U8") })).status, 200);
  });

  it("a live verified bot retains private-channel tools without a Slack user principal", async () => {
    await built.directory.replaceChannels(
      [{ channelId: "C", name: "eng", isPrivate: true }],
      ["admin-alice", "U1", "U2"].map((principalId) => ({ channelId: "C", principalId })),
    );
    const members = [{ id: "B-LEGACY", type: "internal" as const }];
    const token = await capFor("B-LEGACY", scopeId("channel", "C"), {
      botActor: true,
      liveActor: true,
      members,
    });
    assert.equal((await get("/v1/instructions", { "x-agent-capability": token })).status, 200);
    assert.equal(
      (
        await get("/v1/instructions", {
          "x-agent-capability": await capFor("B-LEGACY", scopeId("channel", "C"), { members }),
        })
      ).status,
      403,
    );
  });
});
