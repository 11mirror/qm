import type { NewItem } from "../../src/sessions/items.ts";
import { contextSummaryItem } from "../../src/sessions/session-store.ts";
import "../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrchestratorInput } from "../../src/core/orchestrator.ts";
import type { AdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { testRunStore } from "../support/turns.ts";
import type { Run, RunStore } from "../../src/runs/run-store.ts";
import { isUserMessage } from "../../src/sessions/items.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { createSessionMailbox, type SessionMailbox } from "../../src/sessions/session-mailbox.ts";
import type { SessionStore } from "../../src/sessions/session-store.ts";
import { createSessionSyscalls } from "../../src/subagents/session-tools.ts";
import { scopeId, type Principal, type Conversation, type ScopeId, type Session } from "../../src/types.ts";
import { buildApp } from "../support/build-app.ts";
import { settle } from "../support/settle.ts";
import { testConfig } from "../support/test-config.ts";
import { testAdvisoryLock, testDatabaseUrl } from "../support/test-database.ts";
import { createMemoryRunSignalStore } from "../support/memory-run-signal-store.ts";

const alice: Principal = { id: "alice@example.com", type: "internal" };
const bob: Principal = { id: "bob@example.com", type: "internal" };

test("session search reuses indexed search with participant intersection, tenure windows and bounded references", async () => {
  const { app, sessions } = buildApp(testConfig({ publicWebUrl: "https://qm.example" }));
  const scope = scopeId("group", "room");
  const current = await sessions.getOrCreateByThread("web:room", "group", scope);
  const source = await sessions.getOrCreateByThread("web:source", "group", scopeId("group", "source"));
  await sessions.addParticipant(source.id, alice.id, undefined, { includeHistory: true });
  const { lease } = await sessions.acquireLease(source.id);
  assert.ok(lease);
  await sessions.append(lease, {
    kind: "UserMessage",
    text: "memo before Bob joined",
  });
  await sessions.addParticipant(source.id, bob.id);
  const shared = await sessions.append(lease, {
    kind: "UserMessage",
    text: "memo shared",
  });
  await sessions.releaseLease(lease);
  const { runs } = testRunStore();
  let members: Principal[] | undefined;
  const factory = createSessionSyscalls({
    sessions,
    runs,
    signals: createMemoryRunSignalStore(),
    mailbox: createSessionMailbox(testDatabaseUrl()),
    maxAttempts: 1,
    advisoryLock: testAdvisoryLock(),
    prepareRequest: async (request) => ({
      ...request,
      conversation: { ...request.conversation, publishMembers: members },
    }),
    conversations: {
      list: async () => [],
      start: async () => ({ error: "unused" }),
      search: ({ query, principals, limit }) => app.searchConversations(query, principals, limit),
    },
  });
  const tools = factory.forTurn({
    session: current,
    scopeId: scope,
    request: {
      surface: "web",
      actor: alice,
      conversation: { kind: "group", threadRef: current.threadRef, audience: [alice], publishMembers: [alice] },
    },
  });
  await assert.rejects(() => tools.search!({ query: "memo" }), /complete principal set/);
  members = [bob];
  const result = await tools.search!({ query: "memo" });
  assert.deepEqual(result.failedBackends, []);
  assert.equal(result.hits.length, 1);
  assert.deepEqual(
    result.hits.map((h) => [h.metadata?.sessionId, h.metadata?.seq, h.snippet, h.url]),
    [[source.id, shared.seq, "memo shared", `https://qm.example/s/${source.id}`]],
  );
  assert.equal((await tools.search!({ query: "memo shared", limit: 1 })).hits.length, 1);
  members = [alice];
  assert.equal((await tools.search!({ query: "memo" })).hits.length, 2);
  assert.equal((await tools.search!({ query: "memo", limit: 1 })).hits.length, 1);
  members = [bob, { id: "outsider@example.com", type: "internal" }];
  assert.deepEqual((await tools.search!({ query: "memo" })).hits, []);
});

test("a subagent shows its delegated tasks while the parent's completion wake stays hidden", async (t) => {
  const built = buildApp(testConfig({ memoryCapture: "off" }));
  t.after(async () => {
    await built.runtime.stop();
  });
  const threadRef = "dm:U1:subagent-visibility";
  await built.app.turn({
    surface: "test",
    surfaceTools: true,
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef },
    text: "hello",
    origin: { kind: "human" },
  });
  const parentRun = (await built.runs.latestForThread(threadRef))!;
  const parentSession = (await built.sessions.getByThread(threadRef))!;
  await built.config.setPersonalModelAuth("U1", true, "openai");
  await built.featureFlags.setEnabled("responsive_spine", parentSession.scopeId, true, "U1");
  const syscalls = createSessionSyscalls({
    advisoryLock: testAdvisoryLock(),
    sessions: built.sessions,
    runs: built.runs,
    signals: built.signals,
    mailbox: createSessionMailbox(testDatabaseUrl()),
    maxAttempts: 1,
  }).forTurn({
    session: parentSession,
    scopeId: parentSession.scopeId,
    request: { ...parentRun.request, runId: parentRun.id },
  });
  const finished = async (lookup: () => Promise<Run | null | undefined>) => {
    let run: Run | null | undefined;
    await settle(async () => ["done", "failed"].includes((run = await lookup())?.status ?? ""));
    assert.equal(run?.result?.status, "ok", JSON.stringify(run?.result));
    return run!;
  };
  const userEntry = async (run: Run) => {
    const session = (await built.sessions.getByThread(run.sessionId))!;
    const items = await built.sessions.getItems(session.id);
    const item = items.find((entry) => isUserMessage(entry) && entry.seq === run.turnUserSeq)!;
    assert.equal(item.body.speakerId, undefined, "delegated input is not a new human message");
    return { hidden: item.hidden === true, display: item.body.display as string | undefined };
  };

  const opened = await syscalls.open({ task: "Summarize the repo", name: "repo summary" });
  assert.ok(opened.ok);
  const child = (await built.sessions.get(opened.sessionId))!;
  built.runtime.startBackground();
  const first = await finished(() => built.runs.latestForThread(child.threadRef));
  assert.equal(first.request.origin.kind, "human");
  assert.deepEqual(await userEntry(first), { hidden: false, display: "Summarize the repo" });
  const wake = await finished(() => built.runs.getByDedupKey(`subagent-return:${first.id}`));
  assert.equal((await userEntry(wake)).hidden, true);
  assert.equal(wake.request.origin.kind, "human");

  assert.ok((await syscalls.write({ followup: true, target: child.id, text: "Check the tests too" })).ok);
  const second = await finished(() => built.runs.latestForThread(child.threadRef));
  assert.deepEqual(await userEntry(second), { hidden: false, display: "Check the tests too" });
});

for (const fork of [false, true]) {
  test(`a human-initiated ${fork ? "fork" : "new session"} shows its seed without claiming human authorship`, async (t) => {
    const { startSession } = await import("../../src/api/start-session.ts");
    const built = buildApp(testConfig({ memoryCapture: "off" }));
    t.after(async () => {
      await built.runtime.stop();
    });
    const threadRef = `web:U1:seed-${fork}`;
    await built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef },
      origin: { kind: "human" },
      text: "start another task",
    });
    const parent = (await built.runs.latestForThread(threadRef))!;
    const session = (await built.sessions.getByThread(threadRef))!;
    await built.config.setPersonalModelAuth("U1", true, "openai");
    const out = await startSession(built.app, built.sessions, "U1", {
      scopeId: session.scopeId,
      ...(fork ? { forkOf: session.id } : {}),
      text: "work on the seed",
      origin: parent.request.origin,
      sessionSenderId: session.id,
      delegatingRunId: parent.id,
    });
    assert.ok("session" in out);
    const queued = (await built.runs.latestForThread(out.session.threadRef))!;
    assert.equal(queued.request.modelAccount, "company");
    built.runtime.startBackground();
    await settle(async () => (await built.runs.get(queued.id))!.status === "done");
    const run = (await built.runs.get(queued.id))!;
    assert.equal(run.result?.status, "ok");
    const entry = (await built.sessions.getItems(out.session.id)).find((entry) => entry.seq === run.turnUserSeq)!;
    assert.equal(entry.hidden === true, false);
    assert.equal(entry.body.speakerId, undefined);
    assert.equal(entry.text, "work on the seed");
  });
}

const actor: Principal = { id: "U1", type: "internal", displayName: "Alex" };
const scope: ScopeId = scopeId("personal", "U1");
const conversation: Conversation = { kind: "dm", threadRef: "slack:dm:D1", audience: [actor] };

interface Rig {
  mailbox: SessionMailbox;
  sessions: SessionStore;
  runs: RunStore;
  signals: ReturnType<typeof createMemoryRunSignalStore>;
  advisoryLock: AdvisoryLock;
  room: Session;
  syscallsFor(session: Session): ReturnType<ReturnType<typeof createSessionSyscalls>["forTurn"]>;
}

async function rig(opts?: { treeRunCap?: number }): Promise<Rig> {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const { runs } = testRunStore();
  const signals = createMemoryRunSignalStore();
  const mailbox = createSessionMailbox(testDatabaseUrl());
  const advisoryLock = testAdvisoryLock();
  const factory = createSessionSyscalls({
    mailbox,
    sessions,
    runs,
    signals,
    advisoryLock,
    maxAttempts: 3,
    ...(opts?.treeRunCap !== undefined ? { treeRunCap: opts.treeRunCap } : {}),
  });
  const room = await sessions.getOrCreateByThread("slack:dm:D1", "dm", scope, undefined, "slack");
  await sessions.updateTitle(room.id, "dm with alex");
  await sessions.addParticipant(room.id, actor.id);
  const binding = (session: Session) => ({
    session,
    memoryContext: { audience: "safe-audience" },
    scopeId: scope,
    request: {
      surface: "slack",
      conversation,
      actor,
      deliveryTarget: "D1",
      timezone: "America/Los_Angeles",
    } as Pick<OrchestratorInput, "surface" | "conversation" | "actor" | "deliveryTarget" | "timezone" | "readOnly">,
  });
  return {
    mailbox,
    sessions,
    runs,
    signals,
    advisoryLock,
    room,
    syscallsFor: (session) => factory.forTurn(binding(session)),
  };
}

test("participant can read child history and title across memory checkpoints", async () => {
  const r = await rig();
  const child = await r.sessions.getOrCreateByThread("subagent:synthetic", "dm", scope);
  await r.sessions.setParentSession(child.id, r.room.id);
  await r.sessions.addParticipant(child.id, actor.id);
  await r.sessions.updateTitle(child.id, "PRIVATE_SENTINEL");
  const { lease } = await r.sessions.acquireLease(child.id);
  assert.ok(lease);
  await r.sessions.append(lease, {
    kind: "UserMessage",
    text: "PRIVATE_SENTINEL",
    body: {
      memoryContext: {
        kind: "memory_context",
        fingerprint: "old",
        snapshot: { audience: "previous-audience" },
        throughSeq: -1,
      },
    },
  });
  await r.sessions.append(lease, { kind: "AgentMessage", text: "PRIVATE_SENTINEL" });
  await r.sessions.releaseLease(lease);
  const result = await r.syscallsFor(r.room).read({ target: child.id });
  assert.ok(result.ok && result.mode === "transcript");
  assert.equal(result.title, "PRIVATE_SENTINEL");
  assert.match(result.rendered, /PRIVATE_SENTINEL/);
  const listed = await r.syscallsFor(r.room).read({});
  assert.ok(listed.ok && listed.mode === "children");
  assert.equal(listed.children[0]?.title, "PRIVATE_SENTINEL");
  assert.equal(listed.children[0]?.lastSaid, "PRIVATE_SENTINEL");
});

test("read shows whole entries, honours the caller's limit and maxChars, and says what it left out", async () => {
  const r = await rig();
  const child = await r.sessions.getOrCreateByThread("subagent:long", "dm", scope);
  await r.sessions.setParentSession(child.id, r.room.id);
  await r.sessions.addParticipant(child.id, actor.id);
  const { lease } = await r.sessions.acquireLease(child.id);
  assert.ok(lease);
  const long = `LONG-START ${"detail ".repeat(200)}LONG-END`;
  await r.sessions.append(lease, { kind: "AgentMessage", text: long });
  for (let i = 0; i < 250; i++) await r.sessions.append(lease, { kind: "AgentMessage", text: `line ${i}` });
  await r.sessions.releaseLease(lease);
  const api = r.syscallsFor(r.room);
  const whole = await api.read({ target: child.id, limit: 300, maxChars: 100_000 });
  assert.ok(whole.ok && whole.mode === "transcript");
  assert.match(whole.rendered, /LONG-START detail .*LONG-END/, "an entry is never cut to a snippet");
  assert.match(whole.rendered, /line 249/);
  const window = await api.read({ target: child.id, limit: 300, maxChars: 400 });
  assert.ok(window.ok && window.mode === "transcript");
  assert.match(window.rendered, /^…\[\d+ earlier chars not shown; raise maxChars or lower limit to see them\]\n/);
  assert.match(window.rendered, /line 249$/);
  assert.ok(window.rendered.length <= 400 + 120);
  const loaded: number[] = [];
  const visibleItems = r.sessions.visibleItems.bind(r.sessions);
  r.sessions.visibleItems = async (sessionId, principals, opts) => {
    const items = await visibleItems(sessionId, principals, opts);
    loaded.push(items.length);
    return items;
  };
  const small = await api.read({ target: child.id, limit: 300, maxChars: 400 });
  assert.ok(small.ok && small.mode === "transcript" && small.rendered === window.rendered);
  const total = loaded.reduce((n, count) => n + count, 0);
  assert.ok(total < 100, `only the newest entries that can fill 400 chars are loaded, not all 300 (loaded ${total})`);
  r.sessions.visibleItems = visibleItems;
});

test("a child's last word is found by paging back, reads a stop with no reply, and stops at its compaction boundary", async () => {
  const r = await rig();
  const api = r.syscallsFor(r.room);
  const child = async (thread: string, items: NewItem[]) => {
    const session = await r.sessions.getOrCreateByThread(thread, "dm", scope);
    await r.sessions.setParentSession(session.id, r.room.id);
    await r.sessions.addParticipant(session.id, actor.id);
    const { lease } = await r.sessions.acquireLease(session.id);
    assert.ok(lease);
    for (const item of items) await r.sessions.append(lease, item);
    await r.sessions.releaseLease(lease);
    return session.id;
  };
  const buried = await child("subagent:buried", [
    { kind: "AgentMessage", text: "BURIED-REPLY" },
    ...Array.from({ length: 90 }, (_, i): NewItem => ({
      kind: "ToolCall",
      tool: "execute",
      callId: `c${i}`,
      body: {},
    })),
  ]);
  const stopped = await child("subagent:stopped", [{ kind: "Stop", body: { reason: "by the user" } }]);
  const compacted = await child("subagent:compacted", [
    { kind: "AgentMessage", text: "FORGOTTEN-REPLY" },
    contextSummaryItem(0, "summary"),
    { kind: "ToolCall", tool: "execute", callId: "c2", body: {} },
  ]);
  const listed = await api.read({});
  assert.ok(listed.ok && listed.mode === "children");
  const said = new Map(listed.children.map((c) => [c.sessionId, c.lastSaid]));
  assert.equal(said.get(buried), "BURIED-REPLY");
  assert.equal(said.get(stopped), "[system] Subagent stopped by the user. No reply.");
  assert.equal(said.get(compacted), undefined, "nothing said since the child's context was compacted");
});

test("explicit source title changes reach fresh child tasks without copying history", async () => {
  const r = await rig();
  await r.sessions.updateTitle(r.room.id, "PRIVATE_SENTINEL");
  const { lease } = await r.sessions.acquireLease(r.room.id);
  assert.ok(lease);
  const old = await r.sessions.append(lease, { kind: "AgentMessage", text: "PRIVATE_SENTINEL" });
  await r.sessions.append(lease, {
    kind: "UserMessage",
    text: "new audience turn",
    body: { memoryContext: { kind: "memory_context", snapshot: { audience: "safe-audience" }, throughSeq: old.seq } },
  });
  await r.sessions.releaseLease(lease);
  await r.sessions.updateTitle(r.room.id, "Current parent");
  const opened = await r.syscallsFor((await r.sessions.get(r.room.id))!).open({ task: "safe task", name: "safe name" });
  assert.ok(opened.ok);
  const child = (await r.sessions.get(opened.sessionId))!;
  const run = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  assert.match(run.request.text, /Current parent/);
  assert.doesNotMatch(run.request.text, /PRIVATE_SENTINEL/);
});
test("participant sees child title in session write response", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "task", name: "PRIVATE_SENTINEL" });
  assert.ok(opened.ok);
  const child = (await r.sessions.get(opened.sessionId))!;
  await r.sessions.setParentSession(child.id, r.room.id);
  await r.sessions.addParticipant(child.id, actor.id);
  await r.sessions.updateTitle(child.id, "PRIVATE_SENTINEL");
  const { lease } = await r.sessions.acquireLease(child.id);
  assert.ok(lease);
  await r.sessions.append(lease, {
    kind: "UserMessage",
    text: "PRIVATE_SENTINEL",
    body: {
      memoryContext: {
        kind: "memory_context",
        fingerprint: "old",
        snapshot: { audience: "previous-audience" },
        throughSeq: -1,
      },
    },
  });
  await r.sessions.append(lease, { kind: "AgentMessage", text: "PRIVATE_SENTINEL" });
  await r.sessions.releaseLease(lease);
  const result = await r.syscallsFor(r.room).write({ target: child.id, text: "generic message" });
  assert.match(JSON.stringify(result), /PRIVATE_SENTINEL/);
});
