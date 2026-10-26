import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import { importTranscripts, parseTranscriptImport } from "../src/sessions/transcript-import.ts";

const URL = process.env.DATABASE_URL;
const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);

const line = (principalId: string, threadRef: string, entries: { role: string; text: string; createdAt: number }[]) =>
  JSON.stringify({ principalId, threadRef, title: "Fundraising plan", entries });

const conversation = [
  { role: "user", text: "How should I plan my seed round?", createdAt: T0 },
  { role: "assistant", text: "Start with your runway.", createdAt: T0 + 5_000 },
  { role: "user", text: "Runway is 14 months.", createdAt: T0 + 60_000 },
  { role: "assistant", text: "Then raise in about six months.", createdAt: T0 + 65_000 },
];

async function withStores(fn: (store: SessionStore) => Promise<void>): Promise<void> {
  await fn(createMemorySessionStore());
  if (!URL) return;
  const pg = (await import("pg")).default;
  const admin = new pg.Pool({ connectionString: URL });
  const schema = `transcript_import_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new globalThis.URL(URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  try {
    await fn(createPostgresSessionStore(url.toString()));
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

test("an imported transcript becomes a private web conversation with its original times", async () => {
  await withStores(async (store) => {
    const thread = `web:ada@example.com:${randomUUID()}`;
    const [result] = await importTranscripts(store, [line("ada@example.com", thread, conversation)]);
    assert.equal(result!.appended, 4);
    assert.equal(result!.session.scopeId, "personal:ada@example.com");
    assert.equal(result!.session.surface, "web");
    assert.equal(result!.session.title, "Fundraising plan");
    assert.equal(result!.session.createdAt, T0);
    const seen = await store.visibleEntries(result!.session.id, "ada@example.com");
    assert.deepEqual(
      seen.map((entry) => [entry.type, (entry.payload as { text: string }).text, entry.createdAt]),
      conversation.map((entry) => [entry.role, entry.text, entry.createdAt]),
    );
    assert.deepEqual(await store.visibleEntries(result!.session.id, "bob@example.com"), []);
    const page = await store.listParticipantPage("ada@example.com", { limit: 10 });
    assert.deepEqual(
      page.sessions.map((session) => session.id),
      [result!.session.id],
    );
    const activity = page.sessions[0]!.lastActivityAt!;
    assert.ok(activity >= T0 + 60_000 && activity <= T0 + 65_000);
    assert.deepEqual((await store.listParticipantPage("bob@example.com", { limit: 10 })).sessions, []);
  });
});

test("re-importing a transcript appends only messages newer than the conversation", async () => {
  await withStores(async (store) => {
    const thread = `web:ada@example.com:${randomUUID()}`;
    await importTranscripts(store, [line("ada@example.com", thread, conversation.slice(0, 2))]);
    const [again] = await importTranscripts(store, [line("ada@example.com", thread, conversation.slice(0, 2))]);
    assert.equal(again!.appended, 0);
    const [more] = await importTranscripts(store, [line("ada@example.com", thread, conversation)]);
    assert.equal(more!.appended, 2);
    const seen = await store.visibleEntries(more!.session.id, "ada@example.com");
    assert.deepEqual(
      seen.map((entry) => entry.createdAt),
      conversation.map((entry) => entry.createdAt),
    );
  });
});

test("a resumed imported conversation keeps live turns after the imported history", async () => {
  await withStores(async (store) => {
    const thread = `web:ada@example.com:${randomUUID()}`;
    const [imported] = await importTranscripts(store, [line("ada@example.com", thread, conversation)]);
    const session = await store.getOrCreateByThread(thread, "dm", "personal:ada@example.com", undefined, "web");
    assert.equal(session.id, imported!.session.id);
    const { lease } = await store.acquireLease(session.id);
    assert.ok(lease);
    await store.append(lease, {
      type: "user",
      payload: { text: "What changed since then?" },
      scopeLabel: session.scopeId,
      author: "ada@example.com",
    });
    await store.releaseLease(lease);
    const seen = await store.visibleEntries(session.id, "ada@example.com");
    assert.equal(seen.length, 5);
    assert.ok(seen[4]!.createdAt > T0 + 65_000);
    const [rerun] = await importTranscripts(store, [line("ada@example.com", thread, conversation)]);
    assert.equal(rerun!.appended, 0);
  });
});

test("an import cannot reuse a conversation from another scope", async () => {
  await withStores(async (store) => {
    const thread = `web:ada@example.com:${randomUUID()}`;
    await store.getOrCreateByThread(thread, "dm", "channel:C1", undefined, "web");
    await assert.rejects(importTranscripts(store, [line("ada@example.com", thread, conversation)]), /different scope/);
  });
});

test("transcript lines are rejected unless they describe the principal's own web thread", () => {
  const ok = { principalId: "ada@example.com", threadRef: "web:ada@example.com:t1", entries: conversation };
  assert.equal(parseTranscriptImport(JSON.stringify(ok)).scopeId, "personal:ada@example.com");
  const bad: [string, Record<string, unknown>][] = [
    ["principalId", { ...ok, principalId: "" }],
    ["threadRef", { ...ok, threadRef: "web:bob@example.com:t1" }],
    ["threadRef", { ...ok, threadRef: "slack:ada@example.com:t1" }],
    ["entries", { ...ok, entries: [] }],
    ["role", { ...ok, entries: [{ role: "tool", text: "x", createdAt: T0 }] }],
    ["text", { ...ok, entries: [{ role: "user", text: " ", createdAt: T0 }] }],
    ["ascending", { ...ok, entries: [conversation[1], conversation[0]] }],
  ];
  for (const [what, value] of bad) assert.throws(() => parseTranscriptImport(JSON.stringify(value)), new RegExp(what));
});
