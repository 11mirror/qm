import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { scopeId } from "../../src/types.ts";

const URL = process.env.DATABASE_URL!;

test("pg scopeSessionSummaries: counts via aggregate, not per-transcript reads", async () => {
  const s = createPostgresSessionStore(URL);
  const team = scopeId("channel", "team-eng");
  const other = scopeId("channel", "team-sales");

  const a = await s.getOrCreateByThread("sumA", "channel", team);
  const b = await s.getOrCreateByThread("sumB", "channel", team);
  const c = await s.getOrCreateByThread("sumC", "channel", other);
  const { lease } = await s.acquireLease(a.id);
  await s.append(lease!, { kind: "UserMessage", text: "1" });
  await s.append(lease!, { kind: "AgentMessage", text: "ack" });
  await s.append(lease!, { kind: "UserMessage", text: "2" });

  const cron = await s.getOrCreateByThread("agent:main:cron:c1", "channel", team);
  const webhook = await s.getOrCreateByThread("agent:main:webhook:wh1", "channel", team);

  const scoped = await s.scopeSessionSummaries(team, false, { limit: 500 });
  assert.deepEqual(
    scoped.map((r) => r.id).sort(),
    [a.id, b.id, cron.id, webhook.id].sort(),
    "scope filter excludes other scopes",
  );
  assert.equal(scoped.find((r) => r.id === a.id)!.origin, "conversation", "real conversation tagged conversation");
  assert.equal(scoped.find((r) => r.id === cron.id)!.origin, "cron", "cron monologue thread tagged cron");
  const ra = scoped.find((r) => r.id === a.id)!;
  assert.equal(ra.turns, 2, "turns = user entries");
  assert.equal(ra.messages, 3, "messages = all entries");
  assert.equal(
    ra.lastActivity,
    a.createdAt,
    "the debounce pins last activity to the session's creation for appends within 60s",
  );
  assert.equal(ra.firstMessage, "1", "first message = opening user turn (not the assistant reply)");
  assert.equal(ra.lastMessage, "2", "last message = newest user turn");
  const rb = scoped.find((r) => r.id === b.id)!;
  assert.deepEqual([rb.turns, rb.messages], [0, 0], "entry-less session counts zero");
  assert.equal(rb.lastActivity, rb.createdAt, "entry-less last activity falls back to created_at");
  assert.deepEqual([rb.firstMessage, rb.lastMessage], ["", ""], "entry-less session has no message preview");

  const all = await s.scopeSessionSummaries(team, true, { limit: 500 });
  assert.equal(
    all.some((r) => r.id === c.id),
    true,
    "orgWide includes every scope",
  );

  const conversations = await s.scopeSessionSummaries(team, false, { limit: 10, category: "conversation" });
  assert.deepEqual(
    conversations.map((r) => r.id).sort(),
    [a.id, b.id].sort(),
    "conversation page excludes cron monologues before pagination",
  );
  const background = await s.scopeSessionSummaries(team, false, { limit: 10, category: "background" });
  assert.deepEqual(
    background.map((r) => r.id).sort(),
    [cron.id, webhook.id].sort(),
    "background page contains trigger sessions",
  );
  const cronPage = await s.scopeSessionSummaries(team, false, {
    limit: 1,
    category: "background",
    origin: "cron",
  });
  assert.deepEqual(
    cronPage.map((r) => r.id),
    [cron.id],
    "origin page filters before pagination",
  );
  const otherPage = await s.scopeSessionSummaries(team, false, {
    limit: 1,
    category: "background",
    origin: "other_background",
  });
  assert.deepEqual(
    otherPage.map((r) => r.id),
    [webhook.id],
    "other background page filters before pagination",
  );
});

test("pg scopeSessionSummaries: cronId page filters one cron's fires", async () => {
  const s = createPostgresSessionStore(URL);
  const team = scopeId("channel", "cron-groups");
  const c1a = await s.getOrCreateByThread("cron:g1:slot1", "channel", team);
  const c1b = await s.getOrCreateByThread("cron:g1:slot2", "channel", team);
  await s.getOrCreateByThread("agent:main:cron:g2", "channel", team);
  await s.getOrCreateByThread("agent:main:webhook:gwh", "channel", team);
  const fresh = await s.getOrCreateByThread("cron:g1:slot3", "channel", team);

  const fires = await s.scopeSessionSummaries(team, false, { limit: 10, cronId: "g1" });
  assert.deepEqual(
    fires.map((r) => r.id).sort(),
    [c1a.id, c1b.id, fresh.id].sort(),
    "cronId page returns only that cron's fires",
  );
  const page = await s.scopeSessionSummaries(team, false, {
    limit: 1,
    cronId: "g1",
    before: { lastActivity: fires[0]!.lastActivity, id: fires[0]!.id },
  });
  assert.equal(page.length, 1, "cronId filter applies before pagination");
});

test("pg scopeActivity: one row per scope with conversation, cron and other background counts", async () => {
  const nowRef = { v: 40_000_000_000 };
  const t0 = nowRef.v;
  const s = createPostgresSessionStore(URL, { now: () => nowRef.v });
  const a = scopeId("channel", "activity-a");
  const b = scopeId("channel", "activity-b");
  await s.getOrCreateByThread("activity:t1", "channel", a);
  await s.getOrCreateByThread("agent:main:webhook:activity-w1", "channel", a);
  nowRef.v = t0 + 50_000;
  await s.getOrCreateByThread("agent:main:monitor:activity-m1", "channel", b);
  nowRef.v = t0 + 300_000;
  await s.getOrCreateByThread("cron:activity-c1:fire:abc", "channel", a);
  await s.getOrCreateByThread("activity:t2", "channel", a);

  const rows = (await s.scopeActivity()).filter((r) => [a, b].includes(r.scopeId));
  assert.deepEqual(
    rows.sort((x, y) => x.scopeId.localeCompare(y.scopeId)),
    [
      { scopeId: a, conversations: 2, crons: 1, background: 1, lastActivity: t0 + 300_000 },
      { scopeId: b, conversations: 0, crons: 0, background: 1, lastActivity: t0 + 50_000 },
    ],
  );
});

test("pg session origin columns are written at insert", async () => {
  const s = createPostgresSessionStore(URL);
  const team = scopeId("channel", "origin-columns");
  const shapes: Record<string, { origin: string; cronId: string | null }> = {
    "agent:main:cron:oc1": { origin: "cron", cronId: "oc1" },
    "cron:oc2:slot": { origin: "cron", cronId: "oc2" },
    "agent:main:webhook:ocw": { origin: "webhook", cronId: null },
    "monitor:ocm:extra": { origin: "monitor", cronId: null },
    "swarm:ocs:member": { origin: "swarm", cronId: null },
    "ch:C1:oc-thread": { origin: "conversation", cronId: null },
  };
  const ids: string[] = [];
  for (const threadRef of Object.keys(shapes)) ids.push((await s.getOrCreateByThread(threadRef, "channel", team)).id);

  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  const q = async (text: string, params?: unknown[]) =>
    (await raw.query(text, params)).rows as Record<string, unknown>[];
  const columns = async () =>
    Object.fromEntries(
      (await q("SELECT thread_ref, origin, origin_id FROM sessions WHERE id = ANY($1)", [ids])).map((r) => [
        r.thread_ref,
        { origin: r.origin, cronId: r.origin_id },
      ]),
    );
  const classify = async () => ({
    summaries: (await s.scopeSessionSummaries(team, false, { limit: 500 })).map((r) => [r.threadRef, r.origin]).sort(),
    background: (await s.scopeSessionSummaries(team, false, { limit: 10, category: "background" }))
      .map((r) => r.threadRef)
      .sort(),
    conversation: (await s.scopeSessionSummaries(team, false, { limit: 10, category: "conversation" })).map(
      (r) => r.threadRef,
    ),
    cron: (await s.scopeSessionSummaries(team, false, { limit: 10, origin: "cron" })).map((r) => r.threadRef).sort(),
    other: (await s.scopeSessionSummaries(team, false, { limit: 10, origin: "other_background" }))
      .map((r) => r.threadRef)
      .sort(),
    oc2: (await s.scopeSessionSummaries(team, false, { limit: 10, cronId: "oc2" })).map((r) => r.threadRef),
  });
  try {
    assert.deepEqual(await columns(), shapes, "insert derives origin and origin_id from the thread ref");
    const stored = await classify();
    assert.deepEqual(stored.other, ["agent:main:webhook:ocw", "monitor:ocm:extra", "swarm:ocs:member"]);
    assert.deepEqual(stored.conversation, ["ch:C1:oc-thread"]);
    assert.deepEqual(stored.cron, ["agent:main:cron:oc1", "cron:oc2:slot"]);
    assert.deepEqual(stored.oc2, ["cron:oc2:slot"]);

    await q("UPDATE sessions SET origin = 'cron' WHERE id = ANY($1) AND thread_ref = 'ch:C1:oc-thread'", [ids]);
    assert.deepEqual(
      (await s.scopeSessionSummaries(team, false, { limit: 10, origin: "cron" }))
        .filter((r) => r.threadRef === "ch:C1:oc-thread")
        .map((r) => r.origin),
      ["cron"],
      "a listed session reports the stored origin its filter matched",
    );
  } finally {
    await raw.end();
  }
});

test("pg scopeSessionSummaries: keyset cursor pages stitch into the full listing", async () => {
  let clock = Date.now() + 1_000_000;
  const s = createPostgresSessionStore(URL, { now: () => ++clock });
  const scope = scopeId("channel", "keyset");
  for (let i = 0; i < 5; i++) {
    const sess = await s.getOrCreateByThread(`keyset:${i}`, "channel", scope);
    const { lease } = await s.acquireLease(sess.id);
    await s.append(lease!, { kind: "UserMessage", text: `m${i}` });
    await s.releaseLease(lease!);
  }
  const all = await s.scopeSessionSummaries(scope, false, { limit: 10 });
  const page1 = await s.scopeSessionSummaries(scope, false, { limit: 2 });
  const c1 = page1[page1.length - 1]!;
  const page2 = await s.scopeSessionSummaries(scope, false, {
    limit: 2,
    before: { lastActivity: c1.lastActivity, id: c1.id },
  });
  const c2 = page2[page2.length - 1]!;
  const page3 = await s.scopeSessionSummaries(scope, false, {
    limit: 2,
    before: { lastActivity: c2.lastActivity, id: c2.id },
  });
  assert.deepEqual(
    [...page1, ...page2, ...page3].map((r) => r.id),
    all.map((r) => r.id),
    "cursor pages stitch into the full newest-first listing",
  );
  assert.equal(page3.length, 1, "final partial page");

  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    await raw.query("UPDATE sessions SET messages = NULL, turns = NULL, last_activity = NULL WHERE id = $1", [
      all[2]!.id,
    ]);
  } finally {
    await raw.end();
  }
  const rerun = await s.scopeSessionSummaries(scope, false, { limit: 10 });
  const p1 = await s.scopeSessionSummaries(scope, false, { limit: 2 });
  const p2 = await s.scopeSessionSummaries(scope, false, {
    limit: 2,
    before: { lastActivity: p1[1]!.lastActivity, id: p1[1]!.id },
  });
  const p3 = await s.scopeSessionSummaries(scope, false, {
    limit: 2,
    before: { lastActivity: p2[1]!.lastActivity, id: p2[1]!.id },
  });
  assert.deepEqual(
    [...p1, ...p2, ...p3].map((r) => r.id),
    rerun.map((r) => r.id),
    "a NULL-counter row still pages through on its created_at fallback",
  );
  assert.ok(
    rerun.some((r) => r.id === all[2]!.id),
    "the NULL-counter row is present in the listing",
  );
});

test("pg scopeSessionSummaries: previews are stored on append and match the JS extraction", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("channel", "pvw");
  const obj = await s.getOrCreateByThread("pvwA", "channel", scope);
  const { lease } = await s.acquireLease(obj.id);
  await s.append(lease!, { kind: "UserMessage", text: "the real\n\n  opener" });
  await s.append(lease!, { kind: "UserMessage", text: "x".repeat(300) });
  await s.releaseLease(lease!);
  const strp = await s.getOrCreateByThread("pvwB", "channel", scope);
  const { lease: lease2 } = await s.acquireLease(strp.id);
  await s.append(lease2!, { kind: "UserMessage", text: "nul\u0000byte" });
  await s.releaseLease(lease2!);

  const rows = await s.scopeSessionSummaries(scope, false, { limit: 500 });
  const ra = rows.find((r) => r.id === obj.id)!;
  assert.equal(ra.firstMessage, "the real opener", "whitespace collapses to one line");
  assert.equal(ra.lastMessage, "x".repeat(99) + "…", "last-message preview truncated to 100 like before");
  const rb = rows.find((r) => r.id === strp.id)!;
  assert.equal(rb.lastMessage, "nulbyte", "a null byte never reaches the text column");

  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    const stored = await raw.query(
      "SELECT id, first_user_preview, last_user_preview FROM sessions WHERE id = ANY($1) ORDER BY thread_ref",
      [[obj.id, strp.id]],
    );
    assert.deepEqual(
      stored.rows.map((r) => [r.first_user_preview, r.last_user_preview]),
      [
        ["the real opener", "x".repeat(99) + "…"],
        ["nulbyte", "nulbyte"],
      ],
      "the append path persists bounded previews on the session row",
    );
  } finally {
    await raw.end();
  }
});

test("pg appendMany maintains first/last user previews across batches", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("channel", "pvw-batch");
  const session = await s.getOrCreateByThread("pvwBatch", "channel", scope);
  const preview = async () => {
    const row = (await s.scopeSessionSummaries(scope, false, { limit: 10 })).find((r) => r.id === session.id)!;
    return [row.firstMessage, row.lastMessage, row.turns];
  };
  assert.deepEqual(await preview(), ["", "", 0], "a fresh session has no preview");
  const { lease } = await s.acquireLease(session.id);
  await s.appendMany(lease!, [
    { kind: "AgentMessage", text: "greeting" },
    { kind: "UserMessage", text: "an overheard aside", body: { overheard: true } },
    { kind: "UserMessage", text: "first ask" },
    { kind: "UserMessage", text: "second ask" },
  ]);
  assert.deepEqual(await preview(), ["first ask", "second ask", 2], "one batch sets both ends, skipping overheard");
  await s.appendMany(lease!, [{ kind: "AgentMessage", text: "reply" }]);
  assert.deepEqual(await preview(), ["first ask", "second ask", 2], "a batch without user turns keeps both");
  await s.append(lease!, { kind: "UserMessage", text: "third ask" });
  assert.deepEqual(await preview(), ["first ask", "third ask", 3], "later user turns move only the last preview");
  await s.append(lease!, { kind: "UserMessage", text: "eavesdrop", body: { overheard: true } });
  assert.deepEqual(await preview(), ["first ask", "third ask", 3], "an overheard turn is not the last message");
  await s.releaseLease(lease!);
});

test("pg scopeSessionSummaries: rows without stored previews fall back to the title and never read items", async () => {
  let clock = Date.now() + 5_000_000;
  const s = createPostgresSessionStore(URL, { now: () => (clock += 120_000) });
  const scope = scopeId("channel", "pvw-legacy");
  const titled = await s.getOrCreateByThread("pvwLegacyTitled", "channel", scope);
  const bare = await s.getOrCreateByThread("pvwLegacyBare", "channel", scope);
  for (const session of [titled, bare]) {
    const { lease } = await s.acquireLease(session.id);
    await s.append(lease!, { kind: "UserMessage", text: "open" });
    await s.releaseLease(lease!);
  }
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    await raw.query("UPDATE sessions SET first_user_preview = NULL, last_user_preview = NULL WHERE id = ANY($1)", [
      [titled.id, bare.id],
    ]);
    await raw.query("UPDATE sessions SET title = 'Quarterly plan' WHERE id = $1", [titled.id]);
    const rows = await s.scopeSessionSummaries(scope, false, { limit: 10 });
    assert.deepEqual(
      rows.map((r) => [r.id, r.firstMessage, r.lastMessage]),
      [
        [bare.id, "", ""],
        [titled.id, "Quarterly plan", ""],
      ],
      "previews come only from stored session columns",
    );
  } finally {
    await raw.end();
  }
});

test("pg scopeSessionSummaries: keyset pages break last_activity ties by id without gaps", async () => {
  const at = Date.now() + 9_000_000;
  const s = createPostgresSessionStore(URL, { now: () => at });
  const scope = scopeId("channel", `ties-${randomUUID()}`);
  for (let i = 0; i < 7; i++) await s.getOrCreateByThread(`ties:${scope}:${i}`, "channel", scope);
  const all = await s.scopeSessionSummaries(scope, false, { limit: 50 });
  assert.equal(new Set(all.map((r) => r.lastActivity)).size, 1, "every row ties on last_activity");
  assert.deepEqual(
    all.map((r) => r.id),
    all
      .map((r) => r.id)
      .sort()
      .reverse(),
    "ties order by id descending",
  );
  for (const orgWide of [false, true]) {
    const walked: string[] = [];
    let before = { lastActivity: at + 1, id: "" };
    while (walked.length < all.length) {
      const page = await s.scopeSessionSummaries(scope, orgWide, { limit: 3, before });
      const mine = page.filter((r) => r.scopeId === scope);
      walked.push(...mine.map((r) => r.id));
      if (mine.length < 3) break;
      before = { lastActivity: page[2]!.lastActivity, id: page[2]!.id };
    }
    assert.deepEqual(
      walked,
      all.map((r) => r.id),
      `${orgWide ? "org-wide" : "scoped"} cursor walk visits each tie once`,
    );
  }
});

test("pg scopeSessionSummaries: a cancelled caller releases the listing query", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("channel", "listing-abort");
  await s.getOrCreateByThread("listing-abort", "channel", scope);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    s.scopeSessionSummaries(scope, false, { limit: 10, signal: controller.signal }),
    { name: "AbortError" },
    "a disconnected admin request does not keep a pool connection busy",
  );
  assert.equal((await s.scopeSessionSummaries(scope, false, { limit: 10 })).length, 1);
});

test("pg scopeSessionSummaries: the listing plan is an index walk with no per-row subplans", async (t) => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("channel", "plan-shape");
  const session = await s.getOrCreateByThread("plan-shape", "channel", scope);
  const { lease } = await s.acquireLease(session.id);
  await s.append(lease!, { kind: "UserMessage", text: "hi" });
  await s.releaseLease(lease!);
  const pg = (await import("pg")).default;
  const execute = pg.Client.prototype.query;
  const captured: { text: string; values: unknown[] }[] = [];
  t.mock.method(pg.Client.prototype, "query", function (this: InstanceType<typeof pg.Client>, ...args: unknown[]) {
    const config = args[0] as { text?: string; values?: unknown[] } | string;
    if (typeof config === "object" && config.text?.includes("AS last_activity, s.first_user_preview")) {
      captured.push({ text: config.text, values: config.values ?? [] });
    }
    return Reflect.apply(execute, this, args);
  });
  const before = { lastActivity: Date.now() + 1e9, id: "~" };
  await s.scopeSessionSummaries(scope, false, { limit: 50, before, category: "conversation" });
  await s.scopeSessionSummaries(scope, true, { limit: 50, before, category: "conversation" });
  await s.scopeSessionSummaries(scope, false, {
    limit: 50,
    before,
    category: "background",
    origin: "other_background",
  });
  t.mock.restoreAll();
  assert.equal(captured.length, 3);
  const raw = await new pg.Pool({ connectionString: URL }).connect();
  try {
    await raw.query("BEGIN");
    await raw.query("SET LOCAL enable_seqscan = off");
    await raw.query("SET LOCAL enable_bitmapscan = off");
    await raw.query("SET LOCAL enable_sort = off");
    const indexes = [
      "sessions_conversations_by_scope_activity",
      "sessions_by_activity",
      "sessions_other_background_by_scope_activity",
    ];
    for (const [query, index] of captured.map((c, i) => [c, indexes[i]!] as const)) {
      const explained = await raw.query(`EXPLAIN (FORMAT JSON) ${query.text}`, query.values);
      const plan = JSON.stringify(explained.rows[0]["QUERY PLAN"]);
      assert.doesNotMatch(plan, /SubPlan|"Relation Name":"items"/, "no correlated subquery over items");
      assert.doesNotMatch(plan, /"Node Type":"Sort"/, "the index supplies the order; nothing is sorted");
      assert.match(plan, new RegExp(`"Index Name":"${index}"`), `${index} serves the listing`);
    }
    await raw.query("ROLLBACK");
  } finally {
    raw.release();
  }
});

test("pg sessions table indexes scoped activity pages", async () => {
  const s = createPostgresSessionStore(URL);
  await s.countSessions();
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    const result = await raw.query("SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY($1::text[])", [
      ["sessions_by_scope", "sessions_by_scope_activity", "sessions_by_activity"],
    ]);
    const indexes = new Map(result.rows.map((row) => [row.indexname as string, row.indexdef as string]));
    assert.match(indexes.get("sessions_by_scope") ?? "", /\(scope_id, created_at DESC\)/);
    assert.match(
      indexes.get("sessions_by_scope_activity") ?? "",
      /scope_id, COALESCE\(last_activity, created_at\) DESC, id DESC/,
    );
    assert.match(
      indexes.get("sessions_by_activity") ?? "",
      /COALESCE\(last_activity, created_at\) DESC, id DESC/,
      "the org-wide listing walks its own activity index",
    );
    const relopts = await raw.query("SELECT reloptions FROM pg_class WHERE relname = 'sessions'");
    assert.ok(
      ((relopts.rows[0]?.reloptions ?? []) as string[]).includes("fillfactor=70"),
      "sessions leaves page room so counter-only appends can go HOT",
    );
  } finally {
    await raw.end();
  }
});

test("pg append debounces last_activity by 60s but keeps counters exact", async () => {
  const nowRef = { v: 20_000_000_000 };
  const t0 = nowRef.v;
  const s = createPostgresSessionStore(URL, { now: () => nowRef.v });
  const scope = scopeId("channel", "debounce");
  const session = await s.getOrCreateByThread("debounceA", "channel", scope);
  const { lease } = await s.acquireLease(session.id);
  assert.ok(lease);
  const activityOf = async () =>
    (await s.scopeSessionSummaries(scope, false, { limit: 500 })).find((r) => r.id === session.id)!;

  nowRef.v = t0 + 30_000;
  await s.append(lease, { kind: "UserMessage", text: "within the window" });
  let row = await activityOf();
  assert.equal(row.lastActivity, t0, "an append within 60s leaves last_activity alone");
  assert.equal(row.messages, 1, "…while messages stays exact");
  assert.equal(row.turns, 1, "…and turns stays exact");

  nowRef.v = t0 + 90_000;
  await s.append(lease, { kind: "UserMessage", text: "past the window" });
  row = await activityOf();
  assert.equal(row.lastActivity, t0 + 90_000, "an append past 60s advances last_activity");
  assert.equal(row.messages, 2);
  assert.equal(row.turns, 2);

  nowRef.v = t0 + 120_000;
  await s.append(lease, { kind: "AgentMessage", text: "still within" });
  row = await activityOf();
  assert.equal(row.lastActivity, t0 + 90_000, "the window measures from the stored value, not the last append");
  assert.equal(row.messages, 3);
  await s.releaseLease(lease);
});

test("pg scopeHasSessions + listByScope answer scope questions without a table scan", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("channel", "scoped-reads");
  const other = scopeId("channel", "scoped-reads-other");
  assert.equal(await s.scopeHasSessions(scope), false, "an unused scope reports no sessions");
  const a = await s.getOrCreateByThread("scopedReadsA", "channel", scope);
  const b = await s.getOrCreateByThread("scopedReadsB", "channel", scope);
  await s.getOrCreateByThread("scopedReadsC", "channel", other);
  assert.equal(await s.scopeHasSessions(scope), true);
  const listed = await s.listByScope(scope);
  assert.deepEqual(new Set(listed.map((x) => x.id)), new Set([a.id, b.id]), "only the asked-for scope comes back");
});

test("pg session counters: legacy and mismatched counters heal on the next append, not at startup", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("channel", "counters");
  const a = await s.getOrCreateByThread("countersA", "channel", scope);
  const b = await s.getOrCreateByThread("countersB", "channel", scope);
  const { lease } = await s.acquireLease(a.id);
  await s.append(lease!, { kind: "UserMessage", text: "hi" });
  await s.append(lease!, { kind: "AgentMessage", text: "yo" });
  await s.append(lease!, { kind: "UserMessage", text: "heard", body: { overheard: true } });
  await s.releaseLease(lease!);

  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    await raw.query("UPDATE sessions SET messages = NULL, turns = NULL, last_activity = NULL WHERE id = ANY($1)", [
      [a.id, b.id],
    ]);
    const s2 = createPostgresSessionStore(URL);
    const rows = await s2.scopeSessionSummaries(scope, false, { limit: 500 });
    const ra = rows.find((r) => r.id === a.id)!;
    assert.equal(ra.messages, 0, "startup no longer backfills: an idle legacy row reads as zero until it is written");
    assert.equal(ra.lastActivity, ra.createdAt, "…and sorts by created_at");
    assert.equal((await s2.getItems(a.id)).length, 3, "its stored messages are all still readable");
    const rb = rows.find((r) => r.id === b.id)!;
    assert.equal(rb.messages, 0, "entry-less legacy session reads as zero");
    assert.equal(rb.lastActivity, rb.createdAt, "entry-less last-activity falls back to created_at");

    const { lease: legacyLease } = await s2.acquireLease(a.id);
    await s2.append(legacyLease!, { kind: "AgentMessage", text: "first write on new code" });
    await s2.releaseLease(legacyLease!);
    const entries = await s2.getItems(a.id);
    const legacy = (await s2.scopeSessionSummaries(scope, false, { limit: 500 })).find((r) => r.id === a.id)!;
    assert.equal(legacy.messages, 4, "append counts every entry of a legacy row");
    assert.equal(legacy.turns, 1, "append recount excludes overheard user rows");
    assert.equal(legacy.lastActivity, entries[entries.length - 1]!.createdAt, "last-activity = newest entry");

    await raw.query(
      "INSERT INTO items(tenant_id, session_id, seq, kind, body, created_at) VALUES (qm_tenant_id(),$1,$2,'UserMessage',$3,to_timestamp($4 / 1000.0))",
      [a.id, 4, { text: "from the old instance" }, Date.now()],
    );
    const { lease: lease2 } = await s2.acquireLease(a.id);
    await s2.append(lease2!, { kind: "UserMessage", text: "back on new code" });
    await s2.releaseLease(lease2!);
    const healed = (await s2.scopeSessionSummaries(scope, false, { limit: 500 })).find((r) => r.id === a.id)!;
    assert.equal(healed.messages, 6, "messages self-heal from the entry seq");
    assert.equal(healed.turns, 3, "seq/messages mismatch triggers a full turns recount");

    await raw.query(
      "INSERT INTO items(tenant_id, session_id, seq, kind, body, created_at) VALUES (qm_tenant_id(),$1,0,'UserMessage',$2,to_timestamp($3 / 1000.0)), (qm_tenant_id(),$1,1,'AgentMessage',$4,to_timestamp($5 / 1000.0))",
      [b.id, { text: "drained turn" }, Date.now(), { text: "reply" }, Date.now() + 1],
    );
    await raw.query("UPDATE sessions SET messages = 0, turns = 0 WHERE id = $1", [b.id]);
    const s3 = createPostgresSessionStore(URL);
    const stale = (await s3.scopeSessionSummaries(scope, false, { limit: 500 })).find((r) => r.id === b.id)!;
    assert.equal(stale.messages, 0, "a fresh store leaves stale non-NULL counters alone");
    const { lease: leaseB } = await s3.acquireLease(b.id);
    await s3.append(leaseB!, { kind: "AgentMessage", text: "next" });
    await s3.releaseLease(leaseB!);
    const rb2 = (await s3.scopeSessionSummaries(scope, false, { limit: 500 })).find((r) => r.id === b.id)!;
    assert.equal(rb2.messages, 3, "the next append repairs stale non-NULL counters");
    assert.equal(rb2.turns, 1, "…and restores turns the old writer never counted");

    const future = Date.now() + 5_000_000;
    await raw.query("UPDATE sessions SET last_activity = $2 WHERE id = $1", [a.id, future]);
    const { lease: lease3 } = await s3.acquireLease(a.id);
    await s3.append(lease3!, { kind: "AgentMessage", text: "late clock" });
    await s3.releaseLease(lease3!);
    const ra2 = (await s3.scopeSessionSummaries(scope, false, { limit: 500 })).find((r) => r.id === a.id)!;
    assert.equal(ra2.lastActivity, future, "an older-clocked append never moves last_activity backwards");
    const ra3 = (await createPostgresSessionStore(URL).scopeSessionSummaries(scope, false, { limit: 500 })).find(
      (r) => r.id === a.id,
    )!;
    assert.equal(ra3.lastActivity, future, "a fresh store never moves last_activity either");

    await raw.query("UPDATE sessions SET turns = 7 WHERE id = $1", [b.id]);
  } finally {
    await raw.end();
  }
  assert.equal(
    (await s.scopeSessionSummaries(scope, false, { limit: 500 })).find((r) => r.id === b.id)!.turns,
    7,
    "listings read the stored turns counter, never the entries",
  );
});

test("pg sessionsByThreadRefs, distinctScopes, countSessions, distinctParticipants: bulk projections match a full scan", async () => {
  const s = createPostgresSessionStore(URL);
  const eng = scopeId("channel", "CENG");
  const uma = scopeId("personal", "UMA");
  const a = await s.getOrCreateByThread("btr-a", "channel", eng, "eng");
  await s.getOrCreateByThread("btr-b", "channel", eng);
  await s.getOrCreateByThread("btr-c", "dm", uma);
  await s.updateTitle(a.id, "board deck");

  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  const all = (
    await raw.query<{ threadRef: string; scopeId: string; type: string }>(
      `SELECT thread_ref AS "threadRef", scope_id AS "scopeId", type FROM sessions`,
    )
  ).rows;
  await raw.end();
  const byRefExpected = new Map(all.map((x) => [x.threadRef, x]));
  const refs = await s.sessionsByThreadRefs(["btr-a", "btr-c", "btr-missing"]);
  assert.deepEqual(refs.map((r) => r.threadRef).sort(), ["btr-a", "btr-c"], "only existing refs returned");
  const ra = refs.find((r) => r.threadRef === "btr-a")!;
  assert.equal(ra.scopeId, byRefExpected.get("btr-a")!.scopeId);
  assert.equal(ra.type, byRefExpected.get("btr-a")!.type);
  assert.equal(ra.title, "board deck", "title projected");
  assert.equal(refs.find((r) => r.threadRef === "btr-c")!.type, "dm");
  assert.deepEqual(await s.sessionsByThreadRefs([]), [], "empty input short-circuits");

  const distinct = new Map((await s.distinctScopes()).map((d) => [d.scopeId, d.channelName]));
  const scopesFromAll = new Set(all.map((x) => x.scopeId));
  assert.deepEqual([...distinct.keys()].sort(), [...scopesFromAll].sort(), "same distinct scope set as a full scan");
  assert.equal(distinct.get(eng), "eng", "a non-null channel name wins for the scope");
  assert.equal(distinct.get(uma), undefined, "no channel name for a personal scope");

  assert.equal(await s.countSessions(), all.length, "same total as a full scan");
  await s.addParticipant(a.id, "UMA");
  await s.addParticipant(a.id, "UBOB");
  await s.removeParticipant(a.id, "UBOB");
  const principalsFromAll = new Set((await s.listParticipants()).map((w) => w.principalId));
  assert.deepEqual(
    (await s.distinctParticipants()).sort(),
    [...principalsFromAll].sort(),
    "same principal set as listParticipants, removed participants included",
  );
});
