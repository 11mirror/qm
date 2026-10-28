import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { acquireLeaseWithin, sessionCategory } from "../../src/sessions/session-store.ts";
import { cronIdOf, sessionOrigin } from "../../src/sessions/thread-ref.ts";
import { parseSessionWakeRef } from "../../src/api/routes/admin/origins.ts";
import { scopeId } from "../../src/types.ts";

test("sessionOrigin classifies trigger threads by prefix", () => {
  assert.equal(sessionOrigin("agent:main:cron:abc"), "cron");
  assert.equal(sessionOrigin("agent:main:webhook:abc"), "webhook");
  assert.equal(sessionOrigin("agent:main:monitor:abc"), "monitor");
  assert.equal(sessionOrigin("cron:c1:slot"), "cron");
  assert.equal(sessionOrigin("dm:D1"), "conversation");
  assert.equal(sessionOrigin("ch:C1:t1"), "conversation");
  assert.equal(sessionOrigin(null), "conversation");
  assert.equal(sessionOrigin(undefined), "conversation");
});

test("attributedTurns applies each window's [validFrom,validTo) and excludes overheard", async () => {
  const nowRef = { v: 10_000_000_000 };
  const store = createPostgresSessionStore(testDatabaseUrl(), { now: () => nowRef.v });
  const scope = scopeId("channel", "C1");
  const t0 = nowRef.v;
  const s = await store.getOrCreateByThread("ch:C1:t1", "channel", scope);
  await store.addParticipant(s.id, "U1");
  const { lease } = await store.acquireLease(s.id);
  assert.ok(lease);
  nowRef.v = t0 + 1000;
  const early = await store.append(lease, { kind: "UserMessage", text: "early, U1 only" });
  nowRef.v = t0 + 2000;
  await store.addParticipant(s.id, "U2");
  nowRef.v = t0 + 3000;
  await store.append(lease, { kind: "UserMessage", text: "chatter", body: { overheard: true } });
  nowRef.v = t0 + 4000;
  const mid = await store.append(lease, { kind: "UserMessage", text: "both here" });
  nowRef.v = t0 + 5000;
  await store.removeParticipant(s.id, "U2");
  nowRef.v = t0 + 6000;
  const late = await store.append(lease, { kind: "UserMessage", text: "U1 only again" });
  await store.releaseLease(lease);

  const both = (await store.visibleItems(s.id, ["U1", "U2"])).map((i) => i.seq);
  assert.ok(both.includes(mid.seq) && !both.includes(early.seq) && !both.includes(late.seq));
  assert.deepEqual(
    both,
    (await store.visibleItems(s.id, "U2")).map((i) => i.seq),
    "intersection of both windows",
  );
  assert.deepEqual(await store.visibleItems(s.id, ["U1", "nobody"]), [], "a non-participant sees nothing");
  assert.deepEqual(
    (await store.visibleItems(s.id, "U1", { kinds: ["AgentMessage"] })).map((i) => i.kind),
    [],
    "kind filters apply to visible items",
  );

  const rows = await store.attributedTurns();
  const u1 = rows.filter((r) => r.principalId === "U1" && r.sessionId === s.id);
  const u2 = rows.filter((r) => r.principalId === "U2" && r.sessionId === s.id);
  assert.equal(
    u1.reduce((n, r) => n + r.turns, 0),
    3,
    "U1 (open-ended) gets all three real turns; overheard excluded",
  );
  assert.equal(u1[0]!.firstAt, early.createdAt);
  assert.equal(u1[0]!.lastAt, late.createdAt);
  assert.equal(
    u2.reduce((n, r) => n + r.turns, 0),
    1,
    "U2 gets only the turn inside [validFrom,validTo)",
  );
  assert.equal(u2[0]!.firstAt, mid.createdAt);
  assert.equal(u2[0]!.lastAt, mid.createdAt);
});

test("scopeHasSessions + listByScope answer scope questions directly", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("channel", "scoped");
  const other = scopeId("channel", "other");
  assert.equal(await store.scopeHasSessions(scope), false);
  const a = await store.getOrCreateByThread("scopedA", "channel", scope);
  const b = await store.getOrCreateByThread("scopedB", "channel", scope);
  await store.getOrCreateByThread("scopedC", "channel", other);
  assert.equal(await store.scopeHasSessions(scope), true);
  assert.deepEqual(
    new Set((await store.listByScope(scope)).map((s) => s.id)),
    new Set([a.id, b.id]),
    "only the asked-for scope comes back",
  );
});

test("a blocked acquire names, dates, and times out the holder it lost to", async () => {
  const nowRef = { v: 10_000_000_000 };
  const t0 = nowRef.v;
  const store = createPostgresSessionStore(testDatabaseUrl(), { now: () => nowRef.v, leaseTtlMs: 60_000 });
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("t1", "dm", scope);
  const { lease } = await store.acquireLease(s.id, "compaction");
  assert.ok(lease);

  nowRef.v = t0 + 15_000;
  const blocked = await store.acquireLease(s.id, "turn");
  assert.equal(blocked.lease, null, "the live lease still blocks a second writer");
  assert.equal(blocked.heldBy, "compaction", "the refusal can say WHAT kind of work outranked it");
  assert.equal(blocked.heldSince, t0, "…when that work took the lock");
  assert.equal(blocked.heldUntil, t0 + 60_000, "…and when the lock lapses on its own");

  await store.append(lease, { kind: "UserMessage", text: "still working" });
  const later = await store.acquireLease(s.id, "turn");
  assert.equal(later.heldSince, t0, "the age still measures from the acquire");
  assert.equal(later.heldUntil, t0 + 75_000, "the expiry moved with the write");

  nowRef.v = t0 + 200_000;
  const past = await store.acquireLease(s.id, "turn");
  assert.ok(past.lease, "an expired holder no longer blocks");
  assert.equal(past.heldUntil, undefined, "a won acquire reports no holder");
});

test("peekLease reads the holder without contending for it, and clears on release", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("t-peek", "dm", scope);
  assert.equal(await store.peekLease(s.id), null);
  const { lease } = await store.acquireLease(s.id, "compaction");
  assert.ok(lease);
  const seen = await store.peekLease(s.id);
  assert.equal(seen?.holder, "compaction");
  assert.ok((seen?.heldUntil ?? 0) > Date.now());
  await store.releaseLease(lease!);
  assert.equal(await store.peekLease(s.id), null);
});

test("acquireLeaseWithin outlasts a short hold and returns the winning lease", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("t-wait", "dm", scope);
  const { lease: held } = await store.acquireLease(s.id, "compaction");
  assert.ok(held);
  setTimeout(() => void store.releaseLease(held!), 300);

  const attempt = await acquireLeaseWithin(store, s.id, "turn", 5_000);
  assert.ok(attempt.lease, "the waiter wins once the short hold lapses");
});

test("acquireLeaseWithin gives up after its budget and reports the holder it lost to", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("t-wait-loses", "dm", scope);
  const { lease: held } = await store.acquireLease(s.id, "compaction");
  assert.ok(held);

  const attempt = await acquireLeaseWithin(store, s.id, "turn", 100);
  assert.equal(attempt.lease, null, "the budget bounds the wait");
  assert.equal(attempt.heldBy, "compaction", "the loser still learns what outranked it");
  assert.ok((attempt.waitedMs ?? 0) >= 75, "the budget was actually spent waiting");
  await store.releaseLease(held!);
});

test("acquireLeaseWithin bails immediately on holders the caller will not wait for", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("t-wait-turn", "dm", scope);
  const { lease: held } = await store.acquireLease(s.id, "turn");
  assert.ok(held);

  const started = Date.now();
  const attempt = await acquireLeaseWithin(store, s.id, "turn", 5_000, {
    waitFor: (heldBy) => heldBy !== undefined && heldBy !== "turn",
  });
  assert.equal(attempt.lease, null);
  assert.equal(attempt.heldBy, "turn", "the refusal names the holder it declined to wait for");
  assert.ok(Date.now() - started < 1_000, "no wait is spent on a holder that will not release in time");
  await store.releaseLease(held!);
});

test("getItem returns exactly the requested seq and nothing else", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("dm:point-fetch", "dm", scope);
  const { lease } = await store.acquireLease(s.id);
  assert.ok(lease);
  const first = await store.append(lease!, { kind: "UserMessage", text: "one" });
  const second = await store.append(lease!, { kind: "AgentMessage", text: "two" });
  assert.deepEqual(await store.getItem(s.id, first.seq), first);
  assert.deepEqual(await store.getItem(s.id, second.seq), second);
  assert.equal(await store.getItem(s.id, second.seq + 1), undefined);
  assert.equal(await store.getItem("missing", 0), undefined);
});

test("cronIdOf and sessionOrigin agree on which threadRefs are crons", () => {
  const refs = [
    "agent:main:cron:abc",
    "cron:abc",
    "cron:abc:slot",
    "cron:abc:slot:extra",
    "agent:main:webhook:x",
    "webhook:x:y",
    "dm:D1",
    "cron:",
    "agent:main:cron:abc:extra",
  ];
  for (const ref of refs) {
    assert.equal(cronIdOf(ref) !== null, sessionOrigin(ref) === "cron", `classifiers agree on ${ref}`);
  }
  assert.equal(cronIdOf("agent:main:cron:abc"), "abc");
  assert.equal(cronIdOf("cron:abc:slot"), "abc");
  assert.equal(cronIdOf("dm:D1"), null);
});

test("the store's origin and the admin wake-ref parser agree on which threadRefs are background", () => {
  const refs = [
    "agent:main:cron:abc",
    "agent:main:webhook:wh1",
    "agent:main:monitor:m1",
    "agent:main:cron:abc:extra",
    "agent:main:email:e1",
    "agent:cron:abc",
    "cron:c1:fire:abc",
    "cron:c1:2026-01-01T00:00",
    "cron:c1:manual:uuid",
    "webhook:wh1:delivery",
    "monitor:m1:lost",
    "monitor:m1:quiet:123",
    "cron:",
    "cronx:1",
    "Cron:1",
    " cron:1",
    "ch:cron:1",
    "dm:D1",
    "ch:C1:t1",
    "",
  ];
  for (const ref of refs) {
    assert.equal(
      sessionCategory(sessionOrigin(ref)),
      parseSessionWakeRef(ref) ? "background" : "conversation",
      `classifiers agree on ${JSON.stringify(ref)}`,
    );
  }
});

test("deleteSessionIfEmpty refuses while a lease is held and after entries land", async () => {
  const nowRef = { v: 10_000_000_000 };
  const store = createPostgresSessionStore(testDatabaseUrl(), { now: () => nowRef.v, leaseTtlMs: 50 });
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("web:U1:seed", "dm", scope);
  const { lease } = await store.acquireLease(s.id);
  assert.ok(lease);
  assert.equal(await store.deleteSessionIfEmpty(s.id), false, "a held lease blocks the discard");
  await store.append(lease, { kind: "UserMessage", text: "seed" });
  await store.releaseLease(lease);
  assert.equal(await store.deleteSessionIfEmpty(s.id), false, "entries block the discard");
  const empty = await store.getOrCreateByThread("web:U1:seed2", "dm", scope);
  const second = await store.acquireLease(empty.id);
  assert.ok(second.lease);
  await store.releaseLease(second.lease);
  assert.equal(await store.deleteSessionIfEmpty(empty.id), true, "a released empty session is discarded");
  assert.equal(await store.get(empty.id), null);
  assert.equal((await store.acquireLease(empty.id)).lease, null, "no lease is granted on a discarded session");

  const abandoned = await store.getOrCreateByThread("web:U1:seed3", "dm", scope);
  const stale = await store.acquireLease(abandoned.id);
  assert.ok(stale.lease);
  nowRef.v += 60;
  assert.equal(await store.deleteSessionIfEmpty(abandoned.id), true, "an expired lease does not block the discard");
  await assert.rejects(
    store.append(stale.lease, { kind: "UserMessage" }),
    /valid session lease/,
    "the stale holder cannot append after the discard",
  );
});

test("renewLease keeps a live turn's lock fresh and refuses stale or superseded tokens", async () => {
  const nowRef = { v: 10_000_000_000 };
  const t0 = nowRef.v;
  const store = createPostgresSessionStore(testDatabaseUrl(), { now: () => nowRef.v, leaseTtlMs: 60_000 });
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("t-renew", "dm", scope);
  const { lease } = await store.acquireLease(s.id, "turn");
  assert.ok(lease);

  nowRef.v = t0 + 50_000;
  assert.equal(await store.renewLease(lease!), true, "the holder can renew without writing an entry");
  const blocked = await store.acquireLease(s.id, "turn");
  assert.equal(blocked.lease, null);
  assert.equal(blocked.heldUntil, nowRef.v + 60_000, "the renewal moved the expiry");
  assert.equal(await store.renewLease({ sessionId: s.id, token: "stale" }), false, "a foreign token cannot renew");

  nowRef.v = nowRef.v + 70_000;
  assert.equal(await store.renewLease(lease!), false, "an expired lease cannot be revived by its old holder");
  const taken = await store.acquireLease(s.id, "turn");
  assert.ok(taken.lease, "an expired lease can still be taken over");
  assert.equal(await store.renewLease(lease!), false, "the superseded holder cannot renew the new lock");
});
