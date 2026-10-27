import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { scopeId } from "../../src/types.ts";

const URL = process.env.DATABASE_URL!;

test("pg search: full-text over entries with prefix match, window ACL, and type filter", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("personal", "USRCH");
  const sess = await s.getOrCreateByThread("srch-1", "dm", scope);
  await s.addParticipant(sess.id, "USRCH", undefined, { includeHistory: true });

  const att = await s.acquireLease(sess.id);
  const lease = att.lease!;
  await s.append(lease, { kind: "UserMessage", text: "can you refresh the memo board data?", body: { name: "josh" } });
  await s.append(lease, { kind: "AgentMessage", text: "Done — pushed the memo board refresh." });
  await s.append(lease, {
    kind: "ToolCall",
    tool: "execute",
    callId: "noise",
    body: { text: "memo board tool noise" },
  });
  // A latecomer joins without history, then one more message lands.
  await s.addParticipant(sess.id, "ULATE");
  await s.append(lease, { kind: "UserMessage", text: "memo board postscript" });
  await s.releaseLease(lease);

  const hits = await s.searchItems("USRCH", "memo boar");
  assert.equal(hits.length, 3, "prefix terms match user and assistant text; tool calls are ignored");
  assert.equal(hits[0]!.text, "memo board postscript", "newest first");
  assert.equal(hits[2]!.author, "josh", "user hits carry the author");

  const late = await s.searchItems("ULATE", "memo");
  assert.equal(late.length, 1, "a latecomer only searches inside their window");
  assert.equal(late[0]!.text, "memo board postscript");

  assert.deepEqual(await s.searchItems("UNONE", "memo"), [], "a non-participant sees nothing");
  assert.deepEqual(await s.searchItems("USRCH", "  !!  "), [], "an unusable query is empty, not an error");
  assert.deepEqual(await s.searchItems("USRCH", "memo missing"), [], "every term must match");
});

test("pg search: participation windows filter global matches before the result limit", async () => {
  let at = Date.now();
  const s = createPostgresSessionStore(URL, { now: () => at });
  const scope = scopeId("personal", "SEARCH-WINDOW");
  const session = await s.getOrCreateByThread("search-window-limit", "dm", scope);
  const lease = (await s.acquireLease(session.id)).lease!;
  const append = async (text: string) => {
    at += 1;
    return s.append(lease, { kind: "UserMessage", text });
  };
  await append("limitwindow before joining");
  await s.addParticipant(session.id, "SEARCH-WINDOW");
  const visible = await append("limitwindow visible");
  await s.removeParticipant(session.id, "SEARCH-WINDOW");
  await append("limitwindow after leaving");
  await s.releaseLease(lease);

  const hidden = await s.getOrCreateByThread("search-hidden-limit", "dm", scope);
  const hiddenLease = (await s.acquireLease(hidden.id)).lease!;
  at += 1;
  await s.append(hiddenLease, { kind: "UserMessage", text: "limitwindow inaccessible session" });
  await s.releaseLease(hiddenLease);

  for (const limit of [1, 200]) {
    const hits = await s.searchItems("SEARCH-WINDOW", "limitwindow", limit);
    assert.deepEqual(
      hits.map((hit) => [hit.sessionId, hit.seq]),
      [[session.id, visible.seq]],
    );
  }
  assert.deepEqual(await s.searchItems("SEARCH-OUTSIDER", "limitwindow", 1), []);
});

test("pg search: message writes populate the index and tool results stay unfindable", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("personal", "UIDX");
  const sess = await s.getOrCreateByThread("srch-idx-1", "dm", scope);
  await s.addParticipant(sess.id, "UIDX", undefined, { includeHistory: true });
  const lease = (await s.acquireLease(sess.id)).lease!;
  await s.append(lease, {
    kind: "UserMessage",
    text: "please rotate the deploy key",
    body: { name: "alex" },
  });
  await s.append(lease, {
    kind: "ToolResult",
    tool: "execute",
    callId: "c1",
    isError: false,
    text: "secret broker value QQ17",
  });
  await s.append(lease, { kind: "AgentMessage", text: "Rotated the deploy key." });

  const before = await s.searchItems("UIDX", "deploy key");
  assert.equal(before.length, 2, "message writes are searchable immediately");
  assert.equal(before.find((hit) => hit.type === "user")?.author, "alex");

  await s.append(lease, { kind: "UserMessage", text: "also rotate the staging deploy key" });
  assert.equal((await s.searchItems("UIDX", "deploy key")).length, 3, "a new message is indexed immediately");

  assert.deepEqual(await s.searchItems("UIDX", "secret broker"), [], "tool results are unfindable");

  await s.addParticipant(sess.id, "ULATE2");
  await s.append(lease, { kind: "UserMessage", text: "deploy key postscript" });
  const late = await s.searchItems("ULATE2", "deploy key");
  assert.equal(late.length, 1, "a latecomer only searches messages inside their window");
  assert.equal(late[0]!.text, "deploy key postscript");

  await s.append(lease, {
    kind: "UserMessage",
    text: "nul\u0000riddled deploy key",
    body: { name: "e\u0000ve" },
  });
  const nulHits = await s.searchItems("UIDX", "nulriddled");
  assert.equal(nulHits.length, 1, "a NUL byte in the text never wedges the index write");
  assert.equal(nulHits[0]!.author, "eve");
  await s.releaseLease(lease);
});

test("pg search: globally limits indexed hits across sessions", async () => {
  const store = createPostgresSessionStore(URL, { now: () => 5000 });
  const scope = scopeId("personal", "ULIMITSEARCH");
  const expected: Array<{ sessionId: string; seq: number }> = [];
  for (let i = 0; i < 3; i++) {
    const session = await store.getOrCreateByThread(`search-global-limit-${i}`, "dm", scope);
    await store.addParticipant(session.id, "ULIMITSEARCH", undefined, { includeHistory: true });
    const lease = (await store.acquireLease(session.id)).lease!;
    for (let j = 0; j < 4; j++) {
      const entry = await store.append(lease, { kind: "UserMessage", text: "document limit" });
      expected.push({ sessionId: session.id, seq: entry.seq });
    }
    await store.releaseLease(lease);
  }
  expected.sort((a, b) => a.sessionId.localeCompare(b.sessionId) || b.seq - a.seq);
  for (const limit of [1, 5, 12, 20]) {
    const hits = await store.searchItems("ULIMITSEARCH", "doc lim", limit);
    assert.deepEqual(
      hits.map(({ sessionId, seq }) => ({ sessionId, seq })),
      expected.slice(0, limit),
    );
  }
});

test("pg search: reads items directly, items are append-only, and deleting the session removes its hits", async () => {
  const store = createPostgresSessionStore(URL);
  const session = await store.getOrCreateByThread("search-atomic", "dm", scopeId("personal", "UATOMIC"));
  await store.addParticipant(session.id, "UATOMIC", undefined, { includeHistory: true });
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  const lease = (await store.acquireLease(session.id)).lease!;
  try {
    const entry = await store.append(lease, { kind: "UserMessage", text: "original document" });
    await assert.rejects(
      pool.query("UPDATE items SET body=$3 WHERE session_id=$1 AND seq=$2", [
        session.id,
        entry.seq,
        { text: "edited document", name: "Editor" },
      ]),
      /UPDATE on items is forbidden/,
    );
    assert.equal((await store.searchItems("UATOMIC", "original")).length, 1);
    await assert.rejects(
      pool.query("DELETE FROM items WHERE session_id=$1", [session.id]),
      /only allowed through its session/,
    );
  } finally {
    await store.releaseLease(lease);
    await store.deleteSession(session.id);
    await pool.end();
  }
  assert.deepEqual(await store.searchItems("UATOMIC", "original"), []);
});
