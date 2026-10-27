import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { rowToSession } from "../../src/sessions/postgres-session-rows.ts";
import { scopeId } from "../../src/types.ts";
import { assertLateJoinerScopes, assertLeanListing } from "../support/participant-scopes.ts";
import { assertParticipantSessionParity } from "../support/participant-session-parity.ts";

const URL = process.env.DATABASE_URL!;

test("pg session row mapping ignores incomplete fork provenance", () => {
  const session = rowToSession({
    id: "fork",
    type: "dm",
    scope_id: "personal:U1",
    thread_ref: "thread",
    created_at: 1,
    forked_from_session_id: "source",
    fork_boundary_seq: null,
  });
  assert.equal(session.forkedFrom, undefined);
  assert.equal(session.forkBoundarySeq, undefined);
});

test("pg session store: fork provenance survives a store restart", async () => {
  const first = createPostgresSessionStore(URL);
  const session = await first.getOrCreateByThread("fork-provenance", "dm", scopeId("personal", "U1"));
  await first.updateForkProvenance(session.id, {
    forkedFrom: { sessionId: "source-session", title: "Original" },
    forkBoundarySeq: 4,
  });
  const restarted = createPostgresSessionStore(URL);
  const loaded = await restarted.get(session.id);
  assert.deepEqual(loaded?.forkedFrom, { sessionId: "source-session", title: "Original" });
  assert.equal(loaded?.forkBoundarySeq, 4);
});

test("pg session store: getForParticipant returns exactly the row listByParticipant returns", async () => {
  await assertParticipantSessionParity(createPostgresSessionStore(URL), `pg-parity-${randomUUID()}`);
});

test("pg participant presence checks seek into the visible history window", async (t) => {
  const store = createPostgresSessionStore(URL);
  const owner = `window-${randomUUID()}`;
  const session = await store.getOrCreateByThread(owner, "channel", scopeId("channel", owner));
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    await raw.query(
      `INSERT INTO items(tenant_id, session_id, seq, kind, body, created_at)
       SELECT qm_tenant_id(), $1, n, 'UserMessage', '{"text":"window fixture"}', to_timestamp(n * 10 / 1000.0)
         FROM generate_series(0, 3999) n`,
      [session.id],
    );
    await raw.query("ANALYZE items");
    await store.addParticipant(session.id, owner);
    const captured: { text: string; values: unknown[] }[] = [];
    const execute = pg.Client.prototype.query;
    t.mock.method(pg.Client.prototype, "query", function (this: InstanceType<typeof pg.Client>, ...args: unknown[]) {
      const config = args[0] as { text?: string; values?: unknown[] } | string;
      const text = typeof config === "string" ? config : config.text;
      if (text?.includes("AS has_entries")) {
        captured.push({ text, values: typeof config === "string" ? (args[1] as unknown[]) : (config.values ?? []) });
      }
      return Reflect.apply(execute, this, args);
    });
    await store.listByParticipant(owner);
    await store.getForParticipant(session.id, owner);
    t.mock.restoreAll();
    assert.equal(captured.length, 2);

    const windows = [
      { fromSeq: 4000, toSeq: null, visible: [] },
      { fromSeq: 0, toSeq: 1, visible: [0] },
      { fromSeq: 3998, toSeq: 4000, visible: [3998] },
      { fromSeq: 1, toSeq: 2, visible: [1] },
      { fromSeq: 2, toSeq: 2, visible: [] },
    ];
    type Plan = { "Relation Name"?: string; "Rows Removed by Filter"?: number; Plans?: Plan[] };
    const rejectedEntries = (plan: Plan): number =>
      (plan["Relation Name"] === "items" ? (plan["Rows Removed by Filter"] ?? 0) : 0) +
      (plan.Plans ?? []).reduce((sum, child) => sum + rejectedEntries(child), 0);
    for (const window of windows) {
      await raw.query(
        `UPDATE participants SET valid_from_seq=$3, valid_to_seq=$4, valid_from=$5, valid_to=$6
          WHERE session_id=$1 AND principal_id=$2`,
        [session.id, owner, window.fromSeq, window.toSeq, 0, window.toSeq === null ? null : 1],
      );
      assert.deepEqual(
        (await store.visibleItems(session.id, owner)).map((entry) => entry.seq),
        window.visible,
      );
      assert.equal((await store.listByParticipant(owner))[0]!.hasEntries, window.visible.length > 0);
      assert.equal((await store.getForParticipant(session.id, owner))!.hasEntries, window.visible.length > 0);
      for (const query of captured) {
        const result = await raw.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${query.text}`, query.values);
        const rejected = rejectedEntries(result.rows[0]["QUERY PLAN"][0].Plan);
        assert.ok(
          rejected < 32,
          `presence check rejected ${rejected} historical entries for ${JSON.stringify(window)}`,
        );
      }
    }
  } finally {
    t.mock.restoreAll();
    await raw.end();
  }
});

test("pg participant activity uses the latest user entry, including overheard entries", async () => {
  let at = 1_000;
  const store = createPostgresSessionStore(URL, { now: () => at });
  const owner = `activity-${randomUUID()}`;
  const scope = scopeId("personal", owner);
  const session = await store.getOrCreateByThread(owner, "dm", scope);
  await store.addParticipant(session.id, owner);
  const { lease } = await store.acquireLease(session.id);
  assert.ok(lease);
  at = 300_000;
  await store.append(lease, { kind: "UserMessage", text: "overheard", body: { overheard: true } });
  at = 500_000;
  await store.append(lease, { kind: "AgentMessage", text: "later reply" });
  await store.releaseLease(lease);
  at = 400_000;
  const empty = await store.getOrCreateByThread(`${owner}-empty`, "dm", scope);
  await store.addParticipant(empty.id, owner);
  const listed = await store.listByParticipant(owner);
  assert.equal(listed.find((row) => row.id === session.id)?.lastActivityAt, 300_000);
  assert.equal(listed.find((row) => row.id === empty.id)?.lastActivityAt, 400_000);
  assert.equal((await store.getForParticipant(session.id, owner))?.lastActivityAt, 300_000);
  assert.deepEqual(
    (await store.listByParticipant(owner, { limit: 1 })).map((row) => row.id),
    [session.id],
  );
  assert.deepEqual(await store.listByParticipant(owner, { limit: 0 }), []);
});

test("pg latestItemSeq and participant windows round-trip", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("personal", "proj-reads");
  const session = await s.getOrCreateByThread("pg-projection-reads", "dm", scope);
  const { lease } = await s.acquireLease(session.id);
  assert.ok(lease);

  assert.equal(await s.latestItemSeq(session.id), -1);
  await s.append(lease!, { kind: "UserMessage", text: "one" });
  await s.append(lease!, { kind: "AgentMessage", text: "two" });
  assert.equal(await s.latestItemSeq(session.id), 1);

  await s.addParticipant(session.id, "proj-reads", undefined, { includeHistory: true });
  await s.addParticipant(session.id, "late-joiner");
  const windows = await s.participantWindowsOf(session.id);
  const byPrincipal = Object.fromEntries(windows.map((w) => [w.principalId, w]));
  assert.equal(byPrincipal["proj-reads"]!.validFromSeq, 0);
  assert.equal(byPrincipal["proj-reads"]!.validToSeq, null);
  assert.equal(byPrincipal["late-joiner"]!.validFromSeq, 2);
  const listed = (await s.listParticipants()).filter((w) => w.sessionId === session.id);
  assert.deepEqual(
    listed.map((w) => [w.principalId, w.validFromSeq, w.validToSeq]).sort(),
    windows.map((w) => [w.principalId, w.validFromSeq, w.validToSeq]).sort(),
  );
});

test("pg participant tenure remains exact when every event shares a timestamp", async () => {
  const at = Date.now() + 1_000_000;
  const s = createPostgresSessionStore(URL, { now: () => at });
  const scope = scopeId("personal", "SAME-TICK");
  const session = await s.getOrCreateByThread("same-tick-window", "dm", scope);
  const { lease } = await s.acquireLease(session.id);
  assert.ok(lease);
  await s.append(lease!, { kind: "UserMessage", text: "before" });
  await s.addParticipant(session.id, "SAME-TICK");
  assert.deepEqual(await s.visibleItems(session.id, "SAME-TICK"), []);
  await s.append(lease!, { kind: "UserMessage", text: "during" });
  assert.deepEqual(
    (await s.visibleItems(session.id, "SAME-TICK")).map((entry) => entry.seq),
    [1],
  );
  await s.removeParticipant(session.id, "SAME-TICK");
  await s.append(lease!, { kind: "UserMessage", text: "gap" });
  await s.addParticipant(session.id, "SAME-TICK");
  assert.deepEqual(await s.visibleItems(session.id, "SAME-TICK"), []);
  await s.append(lease!, { kind: "UserMessage", text: "after" });
  assert.deepEqual(
    (await s.visibleItems(session.id, "SAME-TICK")).map((entry) => entry.seq),
    [3],
  );
});

test("pg participant view: pin/color are per-participant, survive re-add, and clear", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("channel", "CPIN");
  const sess = await s.getOrCreateByThread("pv-pin", "channel", scope);
  await s.addParticipant(sess.id, "U1");
  await s.addParticipant(sess.id, "U2");

  await s.updateParticipantView(sess.id, "U1", { title: "Mine", pinned: true, color: "#3b82f6" });
  const u1 = (await s.listByParticipant("U1")).find((x) => x.id === sess.id)!;
  assert.equal(u1.pinned, true);
  assert.equal(u1.color, "#3b82f6");
  const u2 = (await s.listByParticipant("U2")).find((x) => x.id === sess.id)!;
  assert.ok(!u2.pinned, "one participant's pin never pins the thread for another");
  assert.equal(u2.color ?? null, null);

  await s.removeParticipant(sess.id, "U1");
  await s.addParticipant(sess.id, "U1");
  const readded = (await s.listByParticipant("U1")).find((x) => x.id === sess.id)!;
  assert.equal(readded.pinned, true, "pin survives re-add");
  assert.equal(readded.color, "#3b82f6", "color survives re-add");

  await s.updateParticipantView(sess.id, "U1", { pinned: false, color: null });
  const cleared = (await s.listByParticipant("U1")).find((x) => x.id === sess.id)!;
  assert.ok(!cleared.pinned);
  assert.equal(cleared.color ?? null, null, "null clears the color");
});

test("pg conversation pins: add, list, remove, and delete with the session", async () => {
  let clock = Date.now();
  const s = createPostgresSessionStore(URL, { now: () => ++clock });
  const scope = scopeId("personal", "UPINS");
  const sess = await s.getOrCreateByThread("pins-1", "dm", scope);

  const a = (await s.addPin(sess.id, { text: "launch: Sept 4", addedBy: "UPINS" }))!;
  const b = (await s.addPin(sess.id, { entrySeq: 0, addedBy: "UPINS" }))!;
  assert.ok(a && b, "pins insert for a live session");
  assert.equal(await s.addPin(sess.id, { text: "over cap", addedBy: "UPINS" }, 2), null, "the cap refuses the insert");
  assert.equal(
    await s.addPin("no-such-session", { text: "orphan", addedBy: "UPINS" }),
    null,
    "no orphan rows for a missing session",
  );
  const listed = await s.listPins(sess.id);
  assert.deepEqual(
    listed.map((x) => x.id),
    [a.id, b.id],
    "pins list in creation order",
  );
  assert.equal(listed[0]!.text, "launch: Sept 4");
  assert.equal(listed[1]!.entrySeq, 0);
  assert.equal(listed[1]!.text, undefined);

  assert.equal(await s.removePin(sess.id, a.id), true);
  assert.equal(await s.removePin(sess.id, a.id), false, "removing twice reports missing");
  assert.equal((await s.listPins(sess.id)).length, 1);

  await s.deleteSession(sess.id);
  assert.equal((await s.listPins(sess.id)).length, 0, "pins go with the session");
});

test("pg session store: bounded participant listing is recent and optional", async () => {
  let at = 1000;
  const store = createPostgresSessionStore(URL, { now: () => at });
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    at += 1000;
    const session = await store.getOrCreateByThread(`bounded:${i}`, "dm", scopeId("personal", "bounded-user"));
    ids.push(session.id);
    await store.addParticipant(session.id, "bounded-user");
  }
  assert.equal((await store.listByParticipant("bounded-user")).length, 5);
  assert.deepEqual(
    (await store.listByParticipant("bounded-user", { limit: 2 })).map((s) => s.id),
    ids.slice(-2).reverse(),
  );
  assert.deepEqual(await store.listByParticipant("bounded-user", { limit: 0 }), []);
});

test("pg child parentage and spawn metadata survive reopening", async () => {
  const first = createPostgresSessionStore(URL);
  const ownerScope = scopeId("personal", `parentage-${randomUUID()}`);
  const parent = await first.getOrCreateByThread(`parent-${randomUUID()}`, "dm", ownerScope);
  const child = await first.getOrCreateByThread(`agent:main:subagent:${randomUUID()}`, "dm", ownerScope);
  const meta = {
    surface: "web",
    actor: { id: "tester", type: "internal" as const },
    conversation: {
      kind: "dm" as const,
      threadRef: parent.threadRef,
      audience: [{ id: "tester", type: "internal" as const }],
    },
    readOnly: true,
  };
  await first.setParentSession(child.id, parent.id);
  await first.setSpawnMeta(child.id, meta);
  const reopened = createPostgresSessionStore(URL);
  assert.equal((await reopened.get(child.id))?.parentSessionId, parent.id);
  assert.deepEqual((await reopened.get(child.id))?.spawnMeta, meta);
  assert.deepEqual(
    (await reopened.childrenOf(parent.id)).map((session) => session.id),
    [child.id],
  );
  await reopened.setParentSession(child.id, null);
  assert.equal((await reopened.get(child.id))?.parentSessionId, undefined);
});

test("desktop tool definitions survive a store restart without changing on later turns", async () => {
  const { desktopComputerTool } = await import("../../plugins/chassis/src/desktop-computer.ts");
  const first = createPostgresSessionStore(URL);
  const session = await first.getOrCreateByThread(
    `desktop-${randomUUID()}`,
    "dm",
    scopeId("personal", "U1"),
    undefined,
    "web",
    [desktopComputerTool],
  );
  const restarted = createPostgresSessionStore(URL);
  const loaded = await restarted.getOrCreateByThread(session.threadRef, "dm", session.scopeId, undefined, "web");
  assert.deepEqual(loaded.clientTools, [desktopComputerTool]);
  const changed = await restarted.getOrCreateByThread(session.threadRef, "dm", session.scopeId, undefined, "web", [
    { ...desktopComputerTool, description: "new version" },
  ]);
  assert.deepEqual(changed.clientTools, [desktopComputerTool]);
});

test("pg session lists leave out spawn metadata and group scopes per participant", async () => {
  await assertLeanListing(createPostgresSessionStore(URL), "pg-lean");
});

test("pg participantScopes leaves out sessions whose content predates the participant", async () => {
  await assertLateJoinerScopes(createPostgresSessionStore(URL), "pg-late");
});

test("pg late joiners start after any stored sequence gap", async () => {
  const store = createPostgresSessionStore(URL);
  const scope = scopeId("channel", "gap-C1");
  const session = await store.getOrCreateByThread("slack:gap-C1:1", "channel", scope, "eng");
  await store.addParticipant(session.id, "gap-early");
  const { lease } = await store.acquireLease(session.id);
  assert.ok(lease);
  await store.append(lease, { kind: "UserMessage", text: "before" });
  await store.releaseLease(lease);
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  await pool.query("UPDATE sessions SET messages = messages + 3 WHERE id = $1", [session.id]);
  await pool.end();
  await store.addParticipant(session.id, "gap-late");
  assert.equal((await store.getForParticipant(session.id, "gap-late"))?.hasEntries, false);
  assert.deepEqual(await store.participantScopes("gap-late"), [
    { scopeId: scope, channelName: "eng", sessionCount: 0, lastActivityAt: null },
  ]);
});

test("pg session pages sort by the person's last message, which appends keep", async () => {
  const s = createPostgresSessionStore(URL);
  const me = `paging-${randomUUID()}`;
  const personal = scopeId("personal", me);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const session = await s.getOrCreateByThread(`web:${me}:${i}`, "dm", personal, undefined, "web");
    await s.addParticipant(session.id, me, `Chat ${i}`);
    ids.push(session.id);
  }
  const say = async (sessionId: string, type: "user" | "assistant") => {
    const { lease } = await s.acquireLease(sessionId);
    assert.ok(lease);
    await s.append(lease, { kind: type === "user" ? "UserMessage" : "AgentMessage", text: type });
    await s.releaseLease(lease);
  };
  await say(ids[0]!, "user");
  await say(ids[2]!, "assistant");
  const order = async () => {
    const first = await s.listParticipantPage(me, { limit: 2 });
    const rest = first.next ? await s.listParticipantPage(me, { limit: 2, before: first.next }) : null;
    assert.equal(rest?.next, null);
    return [...first.sessions, ...(rest?.sessions ?? [])].map((row) => row.id);
  };
  assert.deepEqual(await order(), [ids[0], ids[2], ids[1]], "a reply doesn't move a chat; the person's message does");

  const child = await s.getOrCreateByThread(`subagent:${me}:1`, "dm", personal, undefined, "web");
  await s.setParentSession(child.id, ids[0]!);
  const grandchild = await s.getOrCreateByThread(`subagent:${me}:2`, "dm", personal, undefined, "web");
  await s.setParentSession(grandchild.id, child.id);
  assert.deepEqual(
    (await s.descendantsOf([ids[0]!])).map((d) => [d.id, d.rootId]).sort(),
    [
      [child.id, ids[0]],
      [grandchild.id, ids[0]],
    ].sort(),
  );
});
