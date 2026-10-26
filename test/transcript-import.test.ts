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
    const [result] = await Array.fromAsync(importTranscripts(store, [line("ada@example.com", thread, conversation)]));
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
    await Array.fromAsync(importTranscripts(store, [line("ada@example.com", thread, conversation.slice(0, 2))]));
    const [again] = await Array.fromAsync(
      importTranscripts(store, [line("ada@example.com", thread, conversation.slice(0, 2))]),
    );
    assert.equal(again!.appended, 0);
    const [more] = await Array.fromAsync(importTranscripts(store, [line("ada@example.com", thread, conversation)]));
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
    const [imported] = await Array.fromAsync(importTranscripts(store, [line("ada@example.com", thread, conversation)]));
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
    const [rerun] = await Array.fromAsync(importTranscripts(store, [line("ada@example.com", thread, conversation)]));
    assert.equal(rerun!.appended, 0);
  });
});

test("an import cannot reuse a conversation from another scope", async () => {
  await withStores(async (store) => {
    const thread = `web:ada@example.com:${randomUUID()}`;
    await store.getOrCreateByThread(thread, "dm", "channel:C1", undefined, "web");
    await assert.rejects(
      Array.fromAsync(importTranscripts(store, [line("ada@example.com", thread, conversation)])),
      /different scope/,
    );
  });
});

test("an import refuses a conversation that someone else can see", async () => {
  await withStores(async (store) => {
    const thread = `web:ada@example.com:${randomUUID()}`;
    const session = await store.getOrCreateByThread(thread, "dm", "personal:ada@example.com", undefined, "web");
    await store.addParticipant(session.id, "bob@example.com");
    await assert.rejects(
      Array.fromAsync(importTranscripts(store, [line("ada@example.com", thread, conversation)])),
      /other participants/,
    );
    assert.deepEqual(await store.visibleEntries(session.id, "bob@example.com"), []);
    assert.equal((await store.get(session.id))!.title, undefined);
  });
});

test("an import restores the importer's full view of their conversation", async () => {
  await withStores(async (store) => {
    const thread = `web:ada@example.com:${randomUUID()}`;
    const [first] = await Array.fromAsync(
      importTranscripts(store, [line("ada@example.com", thread, conversation.slice(0, 2))]),
    );
    await store.removeParticipant(first!.session.id, "ada@example.com");
    await Array.fromAsync(importTranscripts(store, [line("ada@example.com", thread, conversation)]));
    assert.equal((await store.visibleEntries(first!.session.id, "ada@example.com")).length, 4);
  });
});

test("an imported conversation's activity is its newest message even within a minute", async () => {
  await withStores(async (store) => {
    const thread = `web:ada@example.com:${randomUUID()}`;
    const quick = [
      { role: "user", text: "One", createdAt: T0 },
      { role: "assistant", text: "Two", createdAt: T0 + 5_000 },
      { role: "user", text: "Three", createdAt: T0 + 10_000 },
    ];
    await Array.fromAsync(importTranscripts(store, [line("ada@example.com", thread, quick)]));
    const page = await store.listParticipantPage("ada@example.com", { limit: 10 });
    assert.equal(page.sessions[0]!.lastActivityAt, T0 + 10_000);
  });
});

test("an import waits for a conversation's live turn instead of writing into it", async () => {
  await withStores(async (store) => {
    const thread = `web:ada@example.com:${randomUUID()}`;
    const session = await store.getOrCreateByThread(thread, "dm", "personal:ada@example.com", undefined, "web");
    const { lease } = await store.acquireLease(session.id);
    assert.ok(lease);
    await assert.rejects(
      Array.fromAsync(importTranscripts(store, [line("ada@example.com", thread, conversation)])),
      /in use/,
    );
    await store.releaseLease(lease);
    const [done] = await Array.fromAsync(importTranscripts(store, [line("ada@example.com", thread, conversation)]));
    assert.equal(done!.appended, 4);
  });
});

test("importing into an empty existing conversation dates it by the imported messages", async () => {
  await withStores(async (store) => {
    const thread = `web:ada@example.com:${randomUUID()}`;
    await store.getOrCreateByThread(thread, "dm", "personal:ada@example.com", undefined, "web");
    const [result] = await Array.fromAsync(importTranscripts(store, [line("ada@example.com", thread, conversation)]));
    assert.equal(result!.session.createdAt, T0);
    const page = await store.listParticipantPage("ada@example.com", { limit: 10 });
    const activity = page.sessions[0]!.lastActivityAt!;
    assert.ok(activity >= T0 + 60_000 && activity <= T0 + 65_000);
  });
});

test("an import only targets the principal's own personal web thread", async () => {
  await withStores(async (store) => {
    for (const threadRef of ["web:bob@example.com:t1", "slack:ada@example.com:t1", "web:ada@example.com:"])
      await assert.rejects(
        store.importTranscript({ ...parseTranscriptImport(line("ada@example.com", threadRef, conversation)) }),
        /owned by principalId/,
      );
    assert.deepEqual((await store.listParticipantPage("ada@example.com", { limit: 10 })).sessions, []);
  });
});

test("messages sharing a timestamp are imported once each, including across reruns", async () => {
  await withStores(async (store) => {
    const thread = `web:ada@example.com:${randomUUID()}`;
    const tied = [
      { role: "user", text: "Same second one", createdAt: T0 },
      { role: "assistant", text: "Same second two", createdAt: T0 },
      { role: "user", text: "Same second three", createdAt: T0 },
    ];
    const [first] = await Array.fromAsync(
      importTranscripts(store, [line("ada@example.com", thread, tied.slice(0, 2))]),
    );
    assert.equal(first!.appended, 2);
    const [second] = await Array.fromAsync(importTranscripts(store, [line("ada@example.com", thread, tied)]));
    assert.equal(second!.appended, 1);
    const [third] = await Array.fromAsync(importTranscripts(store, [line("ada@example.com", thread, tied)]));
    assert.equal(third!.appended, 0);
    assert.deepEqual(
      (await store.visibleEntries(first!.session.id, "ada@example.com")).map(
        (entry) => (entry.payload as { text: string }).text,
      ),
      tied.map((entry) => entry.text),
    );
  });
});

test("extending an imported conversation within a minute moves its activity to the new message", async () => {
  await withStores(async (store) => {
    const thread = `web:ada@example.com:${randomUUID()}`;
    const quick = [
      { role: "user", text: "One", createdAt: T0 },
      { role: "assistant", text: "Two", createdAt: T0 + 5_000 },
      { role: "user", text: "Three", createdAt: T0 + 20_000 },
    ];
    await Array.fromAsync(importTranscripts(store, [line("ada@example.com", thread, quick.slice(0, 1))]));
    await Array.fromAsync(importTranscripts(store, [line("ada@example.com", thread, quick)]));
    const page = await store.listParticipantPage("ada@example.com", { limit: 10 });
    assert.equal(page.sessions[0]!.lastActivityAt, T0 + 20_000);
  });
});

test("transcript lines are rejected unless they are well-formed", () => {
  const ok = { principalId: "ada@example.com", threadRef: "web:ada@example.com:t1", entries: conversation };
  assert.equal(parseTranscriptImport(JSON.stringify(ok)).entries[0]!.scopeLabel, "personal:ada@example.com");
  const bad: [string, Record<string, unknown>][] = [
    ["principalId", { ...ok, principalId: 7 }],
    ["entries", { ...ok, entries: [] }],
    ["role", { ...ok, entries: [{ role: "tool", text: "x", createdAt: T0 }] }],
    ["text", { ...ok, entries: [{ role: "user", text: " ", createdAt: T0 }] }],
    ["ascending", { ...ok, entries: [conversation[1], conversation[0]] }],
    ["epoch", { ...ok, entries: [{ role: "user", text: "x", createdAt: T0 + 0.5 }] }],
    ["epoch", { ...ok, entries: [{ role: "user", text: "x", createdAt: 9e15 }] }],
  ];
  for (const [what, value] of bad) assert.throws(() => parseTranscriptImport(JSON.stringify(value)), new RegExp(what));
});
