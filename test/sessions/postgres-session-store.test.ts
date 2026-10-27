import "../support/auto-fake-sprites.ts";
import { createApprovalRecords, type ApprovalRecords } from "../../src/core/approval-store.ts";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { desktopComputerTool } from "../../plugins/chassis/src/desktop-computer.ts";
import { createApp, type AppDeps } from "../../src/api/app.ts";
import { createInsecureTestServer } from "../../src/api/server.ts";
import { createLocalDurableByteStore } from "../../src/files/durable-byte-store.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { claimTurn, completeTurn, finishTurn, testRunStore, type TestRunStore } from "../support/turns.ts";
import type { NewItem } from "../../src/sessions/items.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { DuplicateCallError, type Lease, type SessionStore } from "../../src/sessions/session-store.ts";
import {
  createPostgresToolOutputStore,
  cutToolOutput,
  DEFAULT_INLINE_TOKENS,
  parkedOutputKey,
} from "../../src/sessions/tool-output.ts";
import { scopeId, type ScopeId, type Session, type SpawnMeta, type PendingApprovalRecord } from "../../src/types.ts";
import { buildApp as buildWiredApp } from "../../src/wiring.ts";
import { buildApp } from "../support/build-app.ts";
import { assertLateJoinerScopes, assertLeanListing } from "../support/participant-scopes.ts";
import { testConfig } from "../support/test-config.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

const URL = process.env.DATABASE_URL!;

async function withSchema(
  prefix: string,
  fn: (ctx: {
    raw: import("pg").Pool;
    url: string;
    store: ReturnType<typeof createPostgresSessionStore>;
  }) => Promise<void>,
): Promise<void> {
  const pg = (await import("pg")).default;
  const admin = new pg.Pool({ connectionString: URL });
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new globalThis.URL(URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const raw = new pg.Pool({ connectionString: url.toString() });
  try {
    await fn({ raw, url: url.toString(), store: createPostgresSessionStore(url.toString()) });
  } finally {
    await raw.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

test("pg items keep turn, author and time in typed columns", async () => {
  await withSchema("items_columns", async ({ raw, store }) => {
    const scope = scopeId("personal", "alice");
    const session = await store.getOrCreateByThread("web:columns", "dm", scope);
    const { lease } = await store.acquireLease(session.id);
    assert.ok(lease);
    const runId = randomUUID();
    const turn = { ...lease, turnId: runId };
    const user = await store.append(turn, { kind: "UserMessage", text: "hi", author: "alice" });
    await store.append(turn, { kind: "SteeringMessage", text: "also", author: "bob" });
    await store.append(turn, { kind: "AgentMessage", text: "hello", author: "ignored-on-agent-items" });
    await store.append(lease, { kind: "ToolCall", tool: "execute", callId: "c1" });
    await store.append(lease, { kind: "Error", errorCode: "turn_failure", text: "x" });
    const stopped = await store.append(turn, { kind: "Stop", author: "alice", body: { reason: "user" } });
    const read = await store.getItem(session.id, stopped.seq);
    assert.equal(read?.turnId, runId);
    assert.deepEqual(read?.body, { reason: "user" });
    await assert.rejects(
      store.append({ ...lease, turnId: "not-a-uuid" }, { kind: "ToolCall", tool: "execute", callId: "c2" }),
      /malformed turn id/,
    );
    await store.releaseLease(lease);

    const rows = (
      await raw.query(
        `SELECT seq::int, kind, turn_id::text, author, error_code, (extract(epoch FROM created_at) * 1000)::bigint AS ms
           FROM items WHERE session_id = $1 ORDER BY seq`,
        [session.id],
      )
    ).rows;
    assert.deepEqual(
      rows.map((row) => [row.seq, row.kind, row.turn_id, row.author, row.error_code]),
      [
        [0, "UserMessage", runId, "alice", null],
        [1, "SteeringMessage", runId, "bob", null],
        [2, "AgentMessage", runId, null, null],
        [3, "ToolCall", null, null, null],
        [4, "Error", null, null, "turn_failure"],
        [5, "Stop", runId, "alice", null],
      ],
    );
    assert.equal(Number(rows[0].ms), user.createdAt);
    assert.equal((await store.getItems(session.id))[0]!.createdAt, user.createdAt);
    await assert.rejects(
      raw.query(
        "INSERT INTO items(tenant_id, session_id, seq, kind, author, body, created_at) VALUES (qm_tenant_id(), $1, 9, 'AgentMessage', 'x', '{}', now())",
        [session.id],
      ),
      /items_author_kind/,
    );
  });
});

test("pg items reject a second call with the same call id, leaving the log untouched", async () => {
  await withSchema("items_calls", async ({ store }) => {
    const scope = scopeId("personal", "alice");
    const session = await store.getOrCreateByThread("web:calls", "dm", scope);
    const { lease } = await store.acquireLease(session.id);
    assert.ok(lease);
    const callId = "cron:1";
    const call: NewItem = { kind: "ToolCall", tool: "deliver", callId, body: { text: "hi" } };
    const result: NewItem = { kind: "ToolResult", tool: "deliver", callId, text: "delivered" };
    await store.appendMany(lease, [call, result]);
    await assert.rejects(store.appendMany(lease, [call, result]), DuplicateCallError);
    const items = await store.getItems(session.id);
    assert.equal(items.length, 2);
    assert.equal(items[0]!.callId, callId);
    const next = await store.append(lease, { kind: "AgentMessage", text: "after" });
    assert.equal(next.seq, 2);
    await store.releaseLease(lease);
  });
});

test("pg tool output: the inline cap comes from qm_settings and parked text reads back by a gateway call id carrying a large thought signature", async () => {
  await withSchema("items_tool_output", async ({ raw, url, store }) => {
    const dir = await mkdtemp(join(tmpdir(), "tool-output-"));
    const pool = createPgPool(url);
    try {
      const scope = scopeId("personal", "alice");
      const session = await store.getOrCreateByThread("web:tool-output", "dm", scope);
      let clock = Date.now();
      const outputs = createPostgresToolOutputStore({
        pool,
        bytesFor: (prefix) => createLocalDurableByteStore(join(dir, prefix)),
        now: () => clock,
      });
      assert.equal(await outputs.inlineTokens(), DEFAULT_INLINE_TOKENS);
      await raw.query(
        "INSERT INTO qm_settings(key, value) VALUES ('tool_result_inline_tokens', '0') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      );
      assert.equal(await outputs.inlineTokens(), DEFAULT_INLINE_TOKENS, "cached for a short while");
      clock += 60_000;
      assert.equal(await outputs.inlineTokens(), 0);

      const full = "ünï line\n".repeat(10_000);
      const blob = await outputs.save(full);
      const callId = `call_${randomUUID()}__thought__${randomBytes(4_500).toString("base64")}`;
      const { lease } = await store.acquireLease(session.id);
      assert.ok(lease);
      const call = { kind: "ToolCall" as const, tool: "execute", callId };
      await store.append(lease, call);
      await store.append(lease, {
        kind: "ToolResult",
        tool: "execute",
        callId,
        text: "head…tail",
        blobSha: blob,
        body: { output: { chars: full.length, shownChars: 8 } },
      });
      await assert.rejects(store.append(lease, call), DuplicateCallError);
      await store.append(lease, {
        kind: "ToolResult",
        tool: "execute",
        callId: "toolu_short",
        text: "head…tail",
        blobSha: blob,
        body: { output: {} },
      });
      await store.releaseLease(lease);
      const items = await store.getItems(session.id);
      assert.deepEqual(
        items.map((item) => item.callId),
        [callId, callId, "toolu_short"],
      );
      const markerPath = /tool-output\/\S+(?=;)/.exec(cutToolOutput(full, 1, callId)!.text)![0];
      assert.deepEqual(await outputs.read(session.id, parkedOutputKey(markerPath)!), { text: full });
      const shortPath = /tool-output\/\S+(?=;)/.exec(cutToolOutput(full, 1, "toolu_short")!.text)![0];
      assert.deepEqual(await outputs.read(session.id, parkedOutputKey(shortPath)!), { text: full });
      assert.equal(parkedOutputKey("tool-output/toolu_short"), null);
      assert.equal(await outputs.read(session.id, { digest: "0".repeat(32) }), null);
      assert.equal(await outputs.read("other-session", parkedOutputKey(markerPath)!), null);
      const row = (
        await raw.query(
          "SELECT size, storage_key, (extract(epoch FROM expires_at - created_at) / 86400)::int AS days FROM blobs",
        )
      ).rows[0];
      assert.deepEqual([Number(row.size), row.days], [Buffer.byteLength(full), 30]);
      assert.match(row.storage_key, /^tool-output\/[0-9a-f-]{36}\/files\/[0-9a-f]{64}$/);
    } finally {
      await pool.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("pg items hide a Slack reply receipt once the real message arrives", async () => {
  await withSchema("items_receipts", async ({ store }) => {
    const scope = scopeId("personal", "alice");
    const session = await store.getOrCreateByThread("slack:T1:C1:1.0", "dm", scope);
    const { lease } = await store.acquireLease(session.id);
    assert.ok(lease);
    const receipt: NewItem = {
      kind: "UserMessage",
      text: "sent from web",
      externalId: "2.0",
      body: { name: "Alice", slackReplyReceipt: true, deliveryKey: "k-1" },
    };
    await store.appendMany({ ...lease, turnId: randomUUID() }, [receipt]);
    assert.equal(await store.hasDeliveryItem(session.id, "k-1"), true);
    assert.equal(await store.hasDeliveryItem(session.id, "k-2", "2.0"), true);
    assert.equal(await store.hasDeliveryItem(session.id, "k-2", "3.0"), false);
    const texts = async () =>
      (await store.getItems(session.id, { transcript: true })).map((item) => [
        item.text,
        item.body.slackReplyReceipt === true,
      ]);
    assert.deepEqual(await texts(), [["sent from web", true]]);
    await store.append(lease, { kind: "UserMessage", text: "sent from web", externalId: "2.0" });
    assert.deepEqual(await texts(), [["sent from web", false]]);
    assert.equal(await store.countItemsBefore(session.id, 10), 1);
    assert.equal((await store.getItems(session.id)).length, 2);
  });
});

test("appendMany preserves ordering, counters, and leases", async () => {
  const url = testDatabaseUrl();
  const store = createPostgresSessionStore(url);
  const scope = scopeId("personal", "batch-test");
  const session = await store.getOrCreateByThread(`web:batch-test:${randomUUID()}`, "dm", scope);
  await store.addParticipant(session.id, "batch-test");
  const { lease } = await store.acquireLease(session.id);
  assert.ok(lease);
  await store.append(lease, { kind: "UserMessage", text: "Before batch" });
  const batch = await store.appendMany(lease, [
    { kind: "AgentMessage", text: "First answer" },
    { kind: "UserMessage", text: "Next question" },
    { kind: "AgentMessage", text: "Next answer" },
  ]);
  assert.deepEqual(
    batch.map((item) => item.seq),
    [1, 2, 3],
  );
  assert.deepEqual((await store.getItems(session.id)).slice(1), batch);
  assert.deepEqual(await store.appendMany(lease, []), []);
  const pool = new pg.Pool({ connectionString: url });
  try {
    const { rows } = await pool.query("SELECT messages, turns FROM sessions WHERE id = $1", [session.id]);
    assert.equal(Number(rows[0].messages), 4);
    assert.equal(Number(rows[0].turns), 2);
    const constraint = `batch_failure_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `ALTER TABLE items ADD CONSTRAINT ${constraint} CHECK (session_id <> '${session.id}' OR seq <> 5)`,
    );
    try {
      await assert.rejects(
        store.appendMany(lease, [
          { kind: "UserMessage", text: "Rolled back" },
          { kind: "AgentMessage", text: "Fails item insert" },
        ]),
      );
      assert.equal((await store.getItems(session.id)).length, 4);
      const after = await pool.query("SELECT messages, turns FROM sessions WHERE id = $1", [session.id]);
      assert.deepEqual(after.rows, rows);
    } finally {
      await pool.query(`ALTER TABLE items DROP CONSTRAINT ${constraint}`);
    }
    await store.releaseLease(lease);
    await assert.rejects(store.appendMany(lease, [{ kind: "UserMessage", text: "Rejected" }]), /lease/);
    await assert.rejects(store.appendMany(lease, []), /lease/);
    assert.equal((await store.getItems(session.id)).length, 4);
  } finally {
    await pool.end();
  }
});

test("desktop-created sessions retain the original tool schema when resumed elsewhere", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const first = await store.getOrCreateByThread(
    "web:alice:desktop",
    "dm",
    scopeId("personal", "alice"),
    undefined,
    "web",
    [desktopComputerTool],
  );
  const browser = await store.getOrCreateByThread(first.threadRef, "dm", first.scopeId, undefined, "web");
  assert.deepEqual(browser.clientTools, [desktopComputerTool]);
  const changed = await store.getOrCreateByThread(first.threadRef, "dm", first.scopeId, undefined, "web", [
    { ...desktopComputerTool, description: "changed" },
  ]);
  assert.deepEqual(changed.clientTools, [desktopComputerTool]);
});

test("opening an existing browser session in desktop does not change its tools", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const first = await store.getOrCreateByThread(
    "web:alice:browser",
    "dm",
    scopeId("personal", "alice"),
    undefined,
    "web",
  );
  const desktop = await store.getOrCreateByThread(first.threadRef, "dm", first.scopeId, undefined, "web", [
    desktopComputerTool,
  ]);
  assert.equal(desktop.clientTools, undefined);
});

const scope = "personal:viewer@example.com" as ScopeId;
const VIEWER = "viewer";
const TOOL_SECRET = "brokered-credential-XJQ99";
const THINKING_SECRET = "private-deliberation-KLM42";

interface Sim {
  store: SessionStore;
  session: Session;
  lease: Lease;
}

async function simSession(threadRef = "dm:search-index-test"): Promise<Sim> {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const session = await store.getOrCreateByThread(threadRef, "dm", scope);
  await store.addParticipant(session.id, VIEWER, undefined, { includeHistory: true });
  const { lease } = await store.acquireLease(session.id);
  assert.ok(lease);
  return { store, session, lease: lease! };
}

async function simTurn(
  sim: Sim,
  turn: { input: string; author?: string; reply: string; toolResult?: string; thinking?: string },
): Promise<void> {
  const emit = (item: NewItem) => sim.store.append(sim.lease, item);
  await emit({ kind: "UserMessage", text: turn.input, body: turn.author ? { name: turn.author } : {} });
  if (turn.thinking) await emit({ kind: "Reasoning", text: turn.thinking });
  if (turn.toolResult) {
    await emit({ kind: "ToolCall", tool: "execute", callId: "call_1", body: { command: "fetch" } });
    await emit({ kind: "ToolResult", tool: "execute", callId: "call_1", isError: false, text: turn.toolResult });
  }
  await emit({ kind: "AgentMessage", text: turn.reply });
}

async function secretTurn(sim: Sim): Promise<void> {
  await simTurn(sim, {
    input: "please check the deploy status",
    author: "Alex",
    reply: "The deploy finished cleanly.",
    toolResult: `credential response: ${TOOL_SECRET}`,
    thinking: `weighing options ${THINKING_SECRET}`,
  });
}

test("message writes index only conversational text — tool results and thinking stay unsearchable", async () => {
  const sim = await simSession();
  await secretTurn(sim);
  assert.deepEqual(await sim.store.searchItems(VIEWER, TOOL_SECRET), []);
  assert.deepEqual(await sim.store.searchItems(VIEWER, THINKING_SECRET), []);
  assert.deepEqual(await sim.store.searchItems(VIEWER, "brokered credential"), []);
  const replyHits = await sim.store.searchItems(VIEWER, "finished cleanly");
  assert.equal(replyHits.length, 1);
  assert.equal(replyHits[0]!.type, "assistant");
  const userHits = await sim.store.searchItems(VIEWER, "deploy status");
  assert.ok(userHits.some((h) => h.type === "user" && h.author === "Alex"));
});

test("messages are searchable as soon as they are appended", async () => {
  const sim = await simSession();
  await sim.store.append(sim.lease, { kind: "UserMessage", text: "legacy document" });
  assert.equal((await sim.store.searchItems(VIEWER, "legacy document")).length, 1);
});

test("tenure windows filter search hits", async () => {
  const sim = await simSession();
  await simTurn(sim, { input: "early private question", reply: "early answer" });
  await sim.store.addParticipant(sim.session.id, "latecomer");
  await simTurn(sim, { input: "late shared question", reply: "late answer" });
  assert.deepEqual(await sim.store.searchItems("latecomer", "early private"), []);
  assert.equal((await sim.store.searchItems("latecomer", "late shared")).length, 1);
  assert.equal((await sim.store.searchItems(VIEWER, "early private")).length, 1);
});

test("listed sessions leave out spawn metadata; scopes count only sessions with content", async () => {
  await assertLeanListing(createPostgresSessionStore(testDatabaseUrl()), "mem");
});

test("participantScopes leaves out sessions whose content predates the participant", async () => {
  await assertLateJoinerScopes(createPostgresSessionStore(testDatabaseUrl()), "mem");
});

test("GET /v1/sessions rows carry no spawn metadata, client tools or entry flag", async () => {
  const built = buildWiredApp(testConfig());
  const child = await built.sessions.getOrCreateByThread("subagent:root:2", "dm", "personal:U1", undefined, "web", [
    { name: "screenshot", description: "Take a screenshot", inputSchema: { type: "object" } },
  ]);
  await built.sessions.setSpawnMeta(child.id, {
    surface: "web",
    conversation: { kind: "dm", threadRef: "web:U1:root", audience: [] },
    actor: { id: "U1", type: "internal" },
  } as unknown as SpawnMeta);
  await built.sessions.addParticipant(child.id, "U1", "Research task");
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://localhost:${port}/v1/sessions?principalId=U1`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { sessions: Record<string, unknown>[] };
    const row = body.sessions.find((session) => session.id === child.id);
    assert.ok(row);
    assert.equal(row.title, "Research task");
    for (const field of ["spawnMeta", "clientTools", "hasEntries"]) assert.equal(field in row, false, field);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});

async function seed(sessions: SessionStore, threadRef: string, principal: string, texts: string[]): Promise<string> {
  const s = await sessions.getOrCreateByThread(threadRef, "dm", scopeId("personal", principal));
  await sessions.addParticipant(s.id, principal, undefined, { includeHistory: true });
  const { lease } = await sessions.acquireLease(s.id);
  for (const [i, text] of texts.entries()) {
    await sessions.append(lease!, {
      kind: i % 2 === 0 ? "UserMessage" : "AgentMessage",
      text,
      body: i % 2 === 0 ? { name: "josh" } : {},
    });
  }
  await sessions.releaseLease(lease!);
  return s.id;
}

test("session store: searchItems matches user and assistant text, newest first", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const id = await seed(store, "web:U1:a", "U1", [
    "can you refresh the memo board?",
    "Done — the memo board refresh is pushed.",
    "unrelated chatter",
  ]);

  const hits = await store.searchItems("U1", "memo board");
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.sessionId, id);
  assert.equal(hits[0]!.type, "assistant", "assistant reply is found too");
  assert.equal(hits[1]!.author, "josh", "user hits carry the author");
  assert.ok(hits[0]!.createdAt >= hits[1]!.createdAt, "newest first");

  assert.deepEqual(await store.searchItems("U1", "memo missing"), [], "every term must match");
  assert.deepEqual(await store.searchItems("U1", "  "), [], "blank query matches nothing");
  assert.equal((await store.searchItems("U1", "memo"))[0]!.text.includes("memo"), true);
});

test("session store: search respects participant visibility windows and identity", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const s = await store.getOrCreateByThread("web:U1:w", "dm", scopeId("personal", "U1"));
  await store.addParticipant(s.id, "U1", undefined, { includeHistory: true });
  const { lease } = await store.acquireLease(s.id);
  await store.append(lease!, {
    kind: "UserMessage",
    text: "secret prelude",
  });
  // U2 joins WITHOUT history — the prelude is outside their window.
  await store.addParticipant(s.id, "U2");
  await store.append(lease!, {
    kind: "UserMessage",
    text: "shared secret plans",
  });
  await store.releaseLease(lease!);

  const u2 = await store.searchItems("U2", "secret");
  assert.equal(u2.length, 1, "U2 sees only the post-join message");
  assert.equal(u2[0]!.text, "shared secret plans");

  assert.deepEqual(await store.searchItems("U3", "secret"), [], "a non-participant sees nothing");
  assert.equal((await store.searchItems("U1", "secret")).length, 2, "a full-history participant sees both");
});

test("session store: search ignores non-conversational entry types", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const s = await store.getOrCreateByThread("web:U1:t", "dm", scopeId("personal", "U1"));
  await store.addParticipant(s.id, "U1", undefined, { includeHistory: true });
  const { lease } = await store.acquireLease(s.id);
  await store.append(lease!, {
    kind: "ToolCall",
    tool: "execute",
    callId: "c1",
    body: { text: "grep zanzibar" },
  });
  await store.append(lease!, {
    kind: "AgentMessage",
    variant: "narration",
    text: "zanzibar itinerary",
  });
  await store.releaseLease(lease!);

  const hits = await store.searchItems("U1", "zanzibar");
  assert.equal(hits.length, 1, "tool calls are not searched");
  assert.equal(hits[0]!.type, "text");
});

test("app.searchSessions decorates hits with session metadata and enforces visibility", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "search-"));
  const { app, sessions } = buildApp(testConfig({ dataDir }));

  const id = await seed(sessions, "web:U1:hit", "U1", [
    "let's plan the zanzibar trip",
    "Zanzibar it is — I drafted an itinerary.",
  ]);
  const { lease } = await sessions.acquireLease(id);
  await sessions.append(lease!, {
    kind: "ToolResult",
    tool: "execute",
    callId: "c1",
    text: "zanzibar weather outputonly",
  });
  await sessions.releaseLease(lease!);
  await sessions.updateTitle(id, "Trip planning");
  await seed(sessions, "web:U2:other", "U2", ["zanzibar for U2 only"]);

  sessions.listByParticipant = async () => {
    throw new Error("search must not list every session");
  };
  sessions.getForParticipant = async () => {
    throw new Error("search must not read legacy message activity");
  };
  assert.deepEqual(await app.searchSessions("U1", "outputonly"), []);
  const hits = await app.searchSessions("U1", "zanzibar");
  assert.equal(hits.length, 2, "only U1's own conversation is searched");
  assert.ok(hits.every((h) => h.sessionId === id));
  assert.equal(hits[0]!.title, "Trip planning");
  assert.equal(typeof hits[0]!.seq, "number");
  assert.ok(hits[0]!.snippet.toLowerCase().includes("zanzibar"));
  assert.equal(hits[1]!.author, "josh");

  assert.deepEqual(await app.searchSessions("U1", ""), [], "empty query is empty, not an error");
});

test("app.searchSessions finds sessions by title", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "search-"));
  const { app, sessions } = buildApp(testConfig({ dataDir }));

  const id = await seed(sessions, "web:U1:titled", "U1", ["hello there"]);
  await sessions.updateTitle(id, "Quarterly roadmap review");
  await seed(sessions, "web:U2:other2", "U2", ["hello there"]);

  const byTitle = await app.searchSessions("U1", "roadmap");
  assert.ok(byTitle.some((h) => h.sessionId === id && h.entryType === "title"));

  assert.deepEqual(await app.searchSessions("U2", "roadmap"), [], "title matches respect participation");
});

const approval = (sessionId: string, actor: string, command: string, blocksInput = true): PendingApprovalRecord => ({
  sessionId,
  command,
  createdAt: 1,
  blocksInput,
  request: {
    origin: { kind: "direct" },
    surface: "web",
    actor: { externalId: actor },
    conversation: { kind: "dm", threadRef: `dm:${actor}` },
    text: command,
  },
});

test("session approvals are read by session id, never by scanning every approval", async () => {
  const url = testDatabaseUrl();
  const sessions = createPostgresSessionStore(url);
  const mine = await sessions.getOrCreateByThread("dm:alice:t1", "dm", "personal:alice");
  const other = await sessions.getOrCreateByThread("dm:bob:t1", "dm", "personal:bob");
  await sessions.addParticipant(mine.id, "alice");
  await sessions.addParticipant(mine.id, "bob");
  const backing = createApprovalRecords(url);
  await backing.put("a-blocking", approval(mine.id, "alice", "git push --force"));
  await backing.put("a-input", approval(mine.id, "alice", "ask", false));
  await backing.put("b-blocking", approval(other.id, "bob", "rm -rf /"));
  await backing.put("orphan", approval("no-such-session", "alice", "noop"));
  await backing.put("unicode", approval("sesión-ü", "alice", "echo"));
  const expectedFromFullScan = (await backing.entries()).filter(([, r]) => r.sessionId === mine.id).map(([id]) => id);

  let fullReads = 0;
  const approvals: ApprovalRecords = {
    ...backing,
    async entries() {
      fullReads++;
      return backing.entries();
    },
  };
  const app = createApp({
    sessions,
    approvals,
    identity: createIdentityService(url),
  } as unknown as Parameters<typeof createApp>[0]);

  const listed = await app.listSessionApprovals(mine.id, "alice");
  assert.deepEqual(
    listed.map((a) => a.requestId),
    expectedFromFullScan,
    "the filtered read returns exactly what the old full scan + filter did",
  );
  assert.deepEqual(
    listed.map((a) => a.blocksInput),
    [true, false],
  );
  assert.deepEqual(await app.listSessionApprovals(mine.id, "bob"), [], "viewer visibility still applies");

  const blocking = await app.pendingApprovalForThread(mine.threadRef);
  assert.equal(blocking?.status, "pending_approval");
  assert.deepEqual(
    blocking?.pendingApprovals?.map((a) => a.requestId),
    ["a-blocking"],
    "blockingOnly still drops non-blocking approvals",
  );
  assert.equal(fullReads, 0, "no caller read the whole approvals map");
});

/** Ends the turn the way the runner ends a turn whose error parks it: a failed result stamped with the threadRef. */
async function failRun(store: TestRunStore, runId: string): Promise<void> {
  const claimed = await claimTurn(store.ledger, runId);
  assert.ok(claimed, "claimed for processing");
  const result = { status: "failed" as const, sessionId: claimed.run.sessionId, reason: "An unknown error occurred" };
  await finishTurn(claimed, result, "failed");
}
test("getRun resolves the threadRef to the real UUID and builds the admin link from publicWebUrl", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const store = testRunStore();
  const { runs } = store;
  const threadRef = "ch:C_UUID_FIXTURE:100.1";
  const session = await sessions.getOrCreateByThread(threadRef, "channel", scopeId("org", "default-org"));

  const { run } = await runs.enqueue({ sessionId: threadRef, request: { origin: { kind: "direct" } } as never });
  await failRun(store, run.id);

  const app = createApp({ sessions, runs, publicWebUrl: "https://portal.example.com" } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.status, "failed");
  assert.equal(got?.result?.sessionId, session.id, "threadRef swapped for the real UUID");
  assert.notEqual(got?.result?.sessionId, threadRef);
  assert.equal(
    got?.result?.adminUrl,
    `https://portal.example.com/settings/history/s/${session.id}`,
    "admin link built from the org's portal + resolved UUID",
  );
});

test("getRun omits the admin link when no portal (publicWebUrl) is configured", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const store = testRunStore();
  const { runs } = store;
  const threadRef = "ch:C2:2.2";
  await sessions.getOrCreateByThread(threadRef, "channel", scopeId("org", "default-org"));
  const { run } = await runs.enqueue({ sessionId: threadRef, request: { origin: { kind: "direct" } } as never });
  await failRun(store, run.id);

  const app = createApp({ sessions, runs } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.status, "failed");
  assert.equal(got?.result?.adminUrl, undefined, "no portal ⇒ no link");
});

test("getRun leaves an already-UUID refused sessionId untouched (no false rewrite)", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const { runs, ledger } = testRunStore();
  const session = await sessions.getOrCreateByThread("dm:U1", "dm", scopeId("personal", "U1"));
  const { run } = await runs.enqueue({ sessionId: "ch:C1:1.1", request: { origin: { kind: "direct" } } as never });
  await completeTurn(ledger, run.id, { status: "refused", sessionId: session.id, reason: "session busy" });

  const app = createApp({ sessions, runs } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.sessionId, session.id, "a real session id is left as-is");
});

test("getRun drops an unresolvable threadRef sessionId (turn failed before its session existed)", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const store = testRunStore();
  const { runs } = store;
  const { run } = await runs.enqueue({ sessionId: "ch:C9:9.9", request: { origin: { kind: "direct" } } as never });
  await failRun(store, run.id);

  const app = createApp({ sessions, runs } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.status, "failed");
  assert.equal(got?.result?.sessionId, undefined, "unresolvable id is dropped, not leaked");
});

test("pg items report which message timestamps a session already recorded", async () => {
  await withSchema("items_recorded_ts", async ({ store }) => {
    const session = await store.getOrCreateByThread("slack:T1:C1:2.0", "channel", scopeId("personal", "alice"));
    const { lease } = await store.acquireLease(session.id);
    assert.ok(lease);
    await store.appendMany({ ...lease, turnId: randomUUID() }, [
      { kind: "UserMessage", text: "hi", externalId: "2.0" },
      { kind: "SteeringMessage", text: "steer", body: { ts: "4.0" } },
    ]);
    assert.deepEqual([...(await store.recordedMessageTimestamps(session.id, ["2.0", "3.0", "4.0"]))].sort(), [
      "2.0",
      "4.0",
    ]);
    assert.equal((await store.recordedMessageTimestamps(session.id, [])).size, 0);
  });
});

test("released session migrations still match their pinned source checksums", () => {
  assert.doesNotThrow(() => createPostgresSessionStore("postgres://migration-pin.invalid"));
});
