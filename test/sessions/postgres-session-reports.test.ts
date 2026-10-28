import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { SESSION_STORE_MIGRATIONS } from "../../src/sessions/postgres-session-migrations.ts";
import { scopeId } from "../../src/types.ts";
import { assertSpendRollupParity } from "../support/spend-rollup-parity.ts";

const URL = process.env.DATABASE_URL!;

test("pg session store: spendRollup matches the memory rollup row for row", async () => {
  await assertSpendRollupParity((now) => createPostgresSessionStore(URL, { now }), `pg-spend-${randomUUID()}`);
});

test("pg saved spend refreshes changed days and preserves live attribution", async () => {
  const day = 86_400_000;
  const base = Date.UTC(2024, 0, 1);
  let at = base + 123;
  const store = createPostgresSessionStore(URL, { now: () => at });
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  const scope = scopeId("personal", `saved-${randomUUID()}`);
  const session = await store.getOrCreateByThread(scope, "dm", scope);
  const range = { from: base, to: base + 2 * day };
  const bill = () =>
    store.recordLlmRequest(session.id, {
      turnSeq: null,
      step: 0,
      model: "saved",
      scopeLabel: scope,
      usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14, costUsd: 0.25 },
    });
  const read = async () => (await store.spendReport(range)).rows;
  const check = async () => assert.deepEqual(await read(), await store.spendRollup(range));
  try {
    const first = await bill();
    await check();
    await store.refreshSpendRollup();
    await check();
    at += 1_000;
    await bill();
    assert.equal((await read())[0]!.calls, 1);
    assert.equal((await store.spendReport(range)).asOf, base + 123);
    await store.refreshSpendRollup();
    await check();
    assert.equal((await read())[0]!.calls, 2);
    const restarted = createPostgresSessionStore(URL, { now: () => at });
    assert.deepEqual((await restarted.spendReport(range)).rows, await read());

    await raw.query("UPDATE session_llm_requests SET created_at = $2, model = 'moved', usage_json = $3 WHERE id = $1", [
      first.id,
      base + day + 1,
      JSON.stringify({ input: 1, costUsd: 2 }),
    ]);
    await store.refreshSpendRollup();
    await check();
    assert.equal((await read()).length, 2);
    const parent = await store.getOrCreateByThread(`cron:${randomUUID()}`, "dm", scope);
    await store.setParentSession(session.id, parent.id);
    await store.refreshSpendRollup();
    await check();
    assert.ok((await read()).every((r) => r.origin === "cron"));
    await raw.query("UPDATE sessions SET scope_id = $2 WHERE id = $1", [session.id, "personal:saved-moved"]);
    await store.refreshSpendRollup();
    await check();
    assert.ok((await read()).every((r) => r.scopeId === "personal:saved-moved"));
    await store.deleteSession(parent.id);
    await store.refreshSpendRollup();
    await check();
    assert.ok((await read()).every((r) => r.origin === "conversation"));
    const partial = { from: base + 124, to: base + day };
    assert.deepEqual((await store.spendReport(partial)).rows, await store.spendRollup(partial));
    await store.deleteSession(session.id);
    await store.refreshSpendRollup();
    assert.deepEqual(await read(), []);
    assert.equal(
      (await raw.query("SELECT jsonb_array_length(rows) AS n FROM session_spend_days WHERE day = $1", [base / day]))
        .rows[0].n,
      0,
    );
  } finally {
    await raw.end();
  }
});

test("pg spend refresh keeps concurrent writes pending and failures preserve the last report", async () => {
  const base = Date.UTC(2025, 0, 1);
  const range = { from: base, to: base + 86_400_000 };
  const store = createPostgresSessionStore(URL, { now: () => base + 123 });
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  const scope = scopeId("personal", `race-${randomUUID()}`);
  const session = await store.getOrCreateByThread(scope, "dm", scope);
  const bill = () =>
    store.recordLlmRequest(session.id, {
      turnSeq: null,
      step: 0,
      model: "race",
      scopeLabel: scope,
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, costUsd: 1 },
    });
  const query = pg.Client.prototype.query;
  const wallClock = Date.now;
  let duringRollup: (() => Promise<unknown>) | undefined;
  pg.Client.prototype.query = function (...args: any[]): any {
    if (duringRollup && typeof args[0] === "string" && args[0].startsWith("WITH RECURSIVE ancestry")) {
      const hook = duringRollup;
      duringRollup = undefined;
      return Promise.resolve(Reflect.apply(query, this, args)).then(async (result) => {
        await hook();
        return result;
      });
    }
    return Reflect.apply(query, this, args);
  };
  try {
    await bill();
    await store.refreshSpendRollup();
    await bill();
    duringRollup = bill;
    await store.refreshSpendRollup();
    assert.equal((await store.spendReport(range)).rows[0]!.calls, 2);
    assert.equal((await store.spendRollup(range))[0]!.calls, 3);
    assert.ok(
      Number(
        (await raw.query("SELECT count(*) AS n FROM session_spend_dirty WHERE day = $1", [base / 86_400_000])).rows[0]
          .n,
      ) > 0,
    );
    await store.refreshSpendRollup();
    assert.deepEqual((await store.spendReport(range)).rows, await store.spendRollup(range));
    const healthyId = randomUUID();
    await raw.query(
      "INSERT INTO session_llm_requests(id, session_id, step, model, scope_label, created_at, usage_json) VALUES ($1,$2,0,'healthy',$3,$4,$5)",
      [healthyId, session.id, scope, base - 86_400_000, JSON.stringify({ costUsd: 1 })],
    );
    await store.refreshSpendRollup();
    await raw.query("UPDATE session_llm_requests SET usage_json = $2 WHERE id = $1", [
      healthyId,
      JSON.stringify({ costUsd: 2 }),
    ]);
    await bill();
    duringRollup = async () => {
      const elapsed = wallClock() + 5_001;
      Date.now = () => elapsed;
      throw new Error("injected slow spend refresh failure");
    };
    await store.refreshSpendRollup();
    Date.now = wallClock;
    assert.equal((await store.spendReport(range)).rows[0]!.calls, 3);
    const healthy = await store.spendReport({ from: base - 86_400_000, to: base });
    assert.equal(healthy.rows[0]!.costUsd, 2);
    await Promise.all([store.refreshSpendRollup(), store.refreshSpendRollup()]);
    assert.equal((await store.spendReport(range)).rows[0]!.calls, 4);
    assert.equal(
      Number(
        (await raw.query("SELECT count(*) AS n FROM session_spend_dirty WHERE day = $1", [base / 86_400_000])).rows[0]
          .n,
      ),
      0,
    );
  } finally {
    pg.Client.prototype.query = query;
    Date.now = wallClock;
    await raw.end();
  }
});

test("pg spend refresh takes the newest dirty day, then the stalest days, at least two per pass", async (t) => {
  const pg = (await import("pg")).default;
  const admin = new pg.Pool({ connectionString: URL });
  const schema = `spend_order_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new globalThis.URL(URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const day = 86_400_000;
  const base = Date.UTC(2025, 5, 1);
  let clock = base + 3 * day;
  let at = base;
  let elapsed = 0;
  let slow = false;
  const store = createPostgresSessionStore(url.toString(), {
    now: () => {
      if (slow) elapsed += 10_000;
      return at;
    },
  });
  const raw = new pg.Pool({ connectionString: url.toString() });
  const scope = scopeId("personal", "spend-order");
  const session = await store.getOrCreateByThread("spend-order", "dm", scope);
  const bill = async (offset: number) => {
    at = base + offset * day;
    await store.recordLlmRequest(session.id, {
      turnSeq: null,
      step: 0,
      model: "order",
      scopeLabel: scope,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costUsd: 1 },
    });
    at = clock;
  };
  const slowPass = async () => {
    clock += 60_000;
    at = clock;
    slow = true;
    await store.refreshSpendRollup();
    slow = false;
  };
  const pending = async () =>
    (await raw.query("SELECT DISTINCT day FROM session_spend_dirty WHERE day IS NOT NULL ORDER BY day")).rows.map(
      (r) => Number(r.day) - base / day,
    );
  try {
    for (const offset of [0, 1, 2, 3]) {
      await bill(offset);
      at = base + offset * day;
      await store.refreshSpendRollup();
    }
    for (const offset of [0, 1, 2, 3]) await bill(offset);
    t.mock.method(Date, "now", () => elapsed);
    await slowPass();
    assert.deepEqual(await pending(), [1, 2]);
    await bill(2);
    await bill(3);
    await slowPass();
    assert.deepEqual(await pending(), [2]);
    await slowPass();
    assert.deepEqual(await pending(), []);
    clock = base + 10 * day;
    for (const offset of [0, 1, 2]) await bill(offset);
    await slowPass();
    assert.deepEqual(await pending(), [1]);
  } finally {
    await raw.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test("pg saved spend resolves session changes after commit and preserves non-finite legacy costs", async () => {
  const base = Date.UTC(2025, 2, 1);
  let at = base + 123;
  const range = { from: base, to: base + 86_400_000 };
  const store = createPostgresSessionStore(URL, { now: () => at });
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  const editor = await raw.connect();
  const scope = scopeId("personal", `commit-${randomUUID()}`);
  const session = await store.getOrCreateByThread(scope, "dm", scope);
  try {
    await store.refreshSpendRollup();
    await editor.query("BEGIN");
    await editor.query("UPDATE sessions SET origin = 'cron' WHERE id = $1", [session.id]);
    await store.recordLlmRequest(session.id, {
      turnSeq: null,
      step: 0,
      model: "commit",
      scopeLabel: scope,
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, costUsd: 1 },
    });
    await store.refreshSpendRollup();
    assert.equal((await store.spendReport(range)).rows[0]!.origin, "conversation");
    await editor.query("COMMIT");
    at += 1_000;
    assert.ok((await store.spendReport(range)).asOf! < at);
    await store.refreshSpendRollup();
    assert.deepEqual((await store.spendReport(range)).rows, await store.spendRollup(range));
    assert.equal((await store.spendReport(range)).rows[0]!.origin, "cron");
    for (const cost of ["NaN", "Infinity", "-Infinity"]) {
      await raw.query(
        "INSERT INTO session_llm_requests(id, session_id, step, model, scope_label, created_at, usage_json) VALUES ($1,$2,0,$3,$4,$5,$6)",
        [randomUUID(), session.id, cost, scope, base, JSON.stringify({ costUsd: cost })],
      );
    }
    await store.refreshSpendRollup();
    assert.deepEqual((await store.spendReport(range)).rows, await store.spendRollup(range));
    assert.ok(Number.isNaN((await store.spendReport(range)).rows.find((r) => r.model === "NaN")!.costUsd));
  } finally {
    await editor.query("ROLLBACK");
    editor.release();
    await store.deleteSession(session.id);
    await raw.end();
  }
});

test("pg spend columns count legacy, malformed and unusual usage, and follow later writes", async () => {
  const at = Date.UTC(2022, 0, 1);
  const store = createPostgresSessionStore(URL, { now: () => at });
  const session = await store.getOrCreateByThread("spend-index", "dm", scopeId("personal", "USPENDINDEX"));
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  const usage = { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19, costUsd: 0.5 };
  const wideModel = Array.from({ length: 100 }, () => randomUUID()).join("");
  const wideUsage = { ...usage, legacyDetail: wideModel };
  const deeplyNestedUsage =
    JSON.stringify(usage).slice(0, -1) + ',"detail":' + "[".repeat(20_000) + "0" + "]".repeat(20_000) + "}";
  const insert = async (id: string, model: string, json: string | null, when = at, sessionId = session.id) => {
    await raw.query(
      "INSERT INTO session_llm_requests(id, session_id, step, model, scope_label, created_at, usage_json) VALUES ($1,$2,0,$3,$4,$5,$6)",
      [id, sessionId, model, session.scopeId, when, json],
    );
  };
  const range = { from: at, to: at + 1 };
  try {
    await insert("spend-index-normal", "normal", JSON.stringify(usage));
    await insert("spend-index-wide", wideModel, JSON.stringify(wideUsage));
    await insert("spend-index-null", "null", null);
    await insert("spend-index-empty", "empty", "{}");
    await insert("spend-index-bad-history", "bad-history", "not json", at - 1);
    await insert("spend-index-bad-orphan", "bad-orphan", "not json", at, "missing-spend-session");
    await insert(
      "spend-index-fraction-orphan",
      "fraction-orphan",
      JSON.stringify({ ...usage, input: 0.5 }),
      at,
      "missing-spend-session",
    );
    await insert("spend-index-unicode", "bad-unicode", JSON.stringify({ ...usage, detail: "\u0000" }), at - 1);
    await insert("spend-index-fraction", "fraction", JSON.stringify({ ...usage, input: 0.5 }), at - 1);
    await insert("spend-index-overflow", "overflow", JSON.stringify({ ...usage, input: 1e308 }), at - 1);
    await insert("spend-index-deep-history", "deep-history", deeplyNestedUsage, at - 2);
    const read = async () => (await store.spendRollup(range)).filter((r) => r.scopeId === session.scopeId);
    const before = await read();
    assert.equal(before.length, 3);
    assert.equal(
      before.reduce((sum, row) => sum + row.calls, 0),
      3,
    );
    assert.equal(
      before.reduce((sum, row) => sum + row.costUsd, 0),
      1,
    );
    await store.recordLlmRequest(session.id, {
      turnSeq: null,
      step: 0,
      model: wideModel,
      scopeLabel: session.scopeId,
      usage: wideUsage,
    });
    await store.recordLlmRequest(session.id, {
      turnSeq: null,
      step: 0,
      model: "fraction-after-index",
      scopeLabel: session.scopeId,
      usage: { ...usage, input: 0.5 },
    });
    await raw.query("UPDATE session_llm_requests SET created_at = $1 WHERE model = 'fraction-after-index'", [at - 1]);
    await insert("spend-index-bad-later", "bad-later", "not json", at - 1);
    await insert("spend-index-deep-later", "deep-later", deeplyNestedUsage, at - 2);
    const deep = (await store.spendRollup({ from: at - 2, to: at - 1 })).filter((r) => r.model?.startsWith("deep-"));
    assert.deepEqual(
      deep.map((r) => [r.model, r.calls, r.costUsd]),
      [
        ["deep-history", 1, 0],
        ["deep-later", 1, 0],
      ],
      "usage too deeply nested to parse still counts the call, at zero",
    );
    await raw.query("UPDATE session_llm_requests SET usage_json = $1 WHERE id = 'spend-index-normal'", [
      JSON.stringify({ ...usage, costUsd: 2 }),
    ]);
    assert.equal(
      (await read()).reduce((sum, row) => sum + row.costUsd, 0),
      3,
    );
    await raw.query("UPDATE sessions SET scope_id = 'personal:USPENDMOVED' WHERE id = $1", [session.id]);
    const moved = (await store.spendRollup(range)).filter((r) => r.scopeId === "personal:USPENDMOVED");
    assert.equal(
      moved.reduce((sum, row) => sum + row.calls, 0),
      4,
    );
    await raw.query("UPDATE session_llm_requests SET created_at = $1 WHERE id = 'spend-index-bad-later'", [at]);
    const withBad = (await store.spendRollup(range)).filter((r) => r.scopeId === "personal:USPENDMOVED");
    assert.equal(
      withBad.reduce((sum, row) => sum + row.calls, 0),
      5,
      "malformed usage counts the call instead of failing the report",
    );
    const parsedBefore = await store.spendRollup({ from: at - 2, to: at + 1 });
    await raw.query(
      "UPDATE session_llm_requests SET spend_cost_usd = NULL, spend_input = NULL, spend_output = NULL, spend_cache_read = NULL, spend_cache_write = NULL WHERE session_id IN ($1, 'missing-spend-session')",
      [session.id],
    );
    const backfill = SESSION_STORE_MIGRATIONS.find((m) => m.id === "sessions/store/0053-llm-request-spend-backfill")!;
    for (const statement of backfill.statements) await raw.query(statement);
    const unparsed = await raw.query(
      "SELECT count(*)::int AS n FROM session_llm_requests WHERE session_id IN ($1, 'missing-spend-session') AND usage_json IS NOT NULL AND spend_cost_usd IS NULL",
      [session.id],
    );
    assert.equal(unparsed.rows[0].n, 0, "the migration backfills the spend columns");
    assert.deepEqual(await store.spendRollup({ from: at - 2, to: at + 1 }), parsedBefore);
  } finally {
    await raw.query("DELETE FROM session_llm_requests WHERE session_id IN ($1, 'missing-spend-session')", [session.id]);
    await store.deleteSession(session.id);
    await raw.end();
  }
});

test("pg spend ancestry only visits sessions with usage inside the requested range", async (t) => {
  const at = Date.UTC(2023, 0, 1);
  const store = createPostgresSessionStore(URL, { now: () => at });
  const scope = scopeId("personal", "USPENDANCESTRY");
  const parent = await store.getOrCreateByThread("cron:spend-ancestry", "dm", scope);
  const current = await store.getOrCreateByThread("spend-ancestry-current", "dm", scope);
  const historical = await store.getOrCreateByThread("spend-ancestry-historical", "dm", scope);
  await store.setParentSession(current.id, parent.id);
  await store.setParentSession(historical.id, parent.id);
  await store.recordLlmRequest(current.id, {
    turnSeq: null,
    step: 0,
    model: "ancestry",
    scopeLabel: scope,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costUsd: 1 },
  });
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  const execute = pg.Pool.prototype.query;
  let query = "";
  t.mock.method(pg.Pool.prototype, "query", function (this: InstanceType<typeof pg.Pool>, ...args: unknown[]) {
    if (typeof args[0] === "string" && args[0].startsWith("WITH RECURSIVE")) query = args[0];
    return Reflect.apply(execute, this, args);
  });
  try {
    assert.equal((await store.spendRollup({ from: at, to: at + 1 }))[0]!.origin, "cron");
    assert.ok(query);
    const explained = await raw.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, [at, at + 1]);
    type Plan = { Plans?: Plan[]; "Subplan Name"?: string; "Actual Rows"?: number };
    const plans = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(plans)];
    const ancestry = plans(explained.rows[0]["QUERY PLAN"][0].Plan).find(
      (plan) => plan["Subplan Name"] === "CTE ancestry",
    );
    assert.equal(ancestry?.["Actual Rows"], 2);
  } finally {
    for (const session of [current, historical, parent]) await store.deleteSession(session.id);
    await raw.end();
  }
});

test("pg attributed turns follow later appends, window changes and session deletes", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("personal", "ATTRIB-CACHE");
  const session = await s.getOrCreateByThread(`attrib-cache-${randomUUID()}`, "dm", scope);
  const { lease } = await s.acquireLease(session.id);
  assert.ok(lease);
  const turns = async () =>
    (await s.attributedTurns())
      .filter((t) => t.sessionId === session.id)
      .map((t) => [t.principalId, t.turns])
      .sort();
  await s.addParticipant(session.id, "attrib-a");
  await s.append(lease!, { kind: "UserMessage", text: "one" });
  assert.deepEqual(await turns(), [["attrib-a", 1]]);
  await s.append(lease!, { kind: "UserMessage", text: "two" });
  await s.append(lease!, { kind: "AgentMessage", text: "reply" });
  assert.deepEqual(await turns(), [["attrib-a", 2]], "a later user message is counted on the next read");
  await s.addParticipant(session.id, "attrib-b", undefined, { includeHistory: true });
  assert.deepEqual(
    await turns(),
    [
      ["attrib-a", 2],
      ["attrib-b", 2],
    ],
    "a widened window is picked up",
  );
  await s.deleteSession(session.id);
  assert.deepEqual(await turns(), [], "a deleted session leaves nothing behind");
});

test("pg attributedTurns: covering join credits only user entries, per principal/session/day", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("channel", "uet");
  const a = await s.getOrCreateByThread("uetA", "channel", scope);
  const b = await s.getOrCreateByThread("uetB", "channel", scope);
  await s.addParticipant(a.id, "UET1");
  await s.addParticipant(b.id, "UET1");
  const { lease } = await s.acquireLease(a.id);
  const u0 = await s.append(lease!, { kind: "UserMessage", text: "1" });
  await s.append(lease!, { kind: "AgentMessage", text: "ack" });
  const u1 = await s.append(lease!, { kind: "UserMessage", text: "2" });

  const rows = await s.attributedTurns();
  const forA = rows.filter((r) => r.sessionId === a.id);
  assert.equal(forA.length, 1, "one (principal, session, day) bucket");
  assert.equal(forA[0]!.principalId, "UET1");
  assert.equal(forA[0]!.turns, 2, "only the two user entries; assistant excluded");
  assert.equal(forA[0]!.firstAt, u0.createdAt);
  assert.equal(forA[0]!.lastAt, u1.createdAt);
  assert.equal(forA[0]!.day, Math.floor(u0.createdAt / 86_400_000));
  assert.equal(
    rows.some((r) => r.sessionId === b.id),
    false,
    "a session with no user entries yields no rows",
  );
});

test("pg attributedTurns: the SQL covering join applies each window's [valid_from, valid_to) half-open", async () => {
  const nowRef = { v: 20_000_000_000 };
  const s = createPostgresSessionStore(URL, { now: () => nowRef.v });
  const scope = scopeId("channel", "cov");
  const t0 = nowRef.v;
  const sess = await s.getOrCreateByThread("covA", "channel", scope);
  await s.addParticipant(sess.id, "COV1");
  const { lease } = await s.acquireLease(sess.id);
  nowRef.v = t0 + 1000;
  const early = await s.append(lease!, { kind: "UserMessage", text: "early" });
  nowRef.v = t0 + 2000;
  await s.addParticipant(sess.id, "COV2");
  nowRef.v = t0 + 3000;
  const mid = await s.append(lease!, { kind: "UserMessage", text: "both" });
  nowRef.v = t0 + 4000;
  await s.removeParticipant(sess.id, "COV2");
  nowRef.v = t0 + 5000;
  const late = await s.append(lease!, { kind: "UserMessage", text: "late" });
  await s.releaseLease(lease!);

  const rows = await s.attributedTurns();
  const c1 = rows.filter((r) => r.principalId === "COV1" && r.sessionId === sess.id);
  const c2 = rows.filter((r) => r.principalId === "COV2" && r.sessionId === sess.id);
  assert.equal(
    c1.reduce((n, r) => n + r.turns, 0),
    3,
    "the open-ended window gets all three turns",
  );
  assert.equal(c1[0]!.firstAt, early.createdAt);
  assert.equal(c1[0]!.lastAt, late.createdAt);
  assert.equal(
    c2.reduce((n, r) => n + r.turns, 0),
    1,
    "the closed window gets only the turn inside [valid_from, valid_to)",
  );
  assert.equal(c2[0]!.firstAt, mid.createdAt);
  assert.equal(c2[0]!.lastAt, mid.createdAt);
});

test("pg overheard catch-up entries are excluded from turns/preview/retention (jsonb payload filter)", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("channel", "ov");
  const a = await s.getOrCreateByThread("ovA", "channel", scope);
  await s.addParticipant(a.id, "OV1");
  const { lease } = await s.acquireLease(a.id);
  await s.append(lease!, {
    kind: "UserMessage",
    text: "overheard chatter",
    externalId: "1",
    body: { overheard: true, name: "Alice" },
  });
  await s.append(lease!, { kind: "UserMessage", text: "the real question" });
  await s.append(lease!, { kind: "AgentMessage", text: "answer" });
  await s.append(lease!, {
    kind: "UserMessage",
    text: "more chatter",
    externalId: "2",
    body: { overheard: true, name: "Bob" },
  });
  await s.releaseLease(lease!);

  const row = (await s.scopeSessionSummaries(scope, false, { limit: 500 })).find((r) => r.id === a.id)!;
  assert.equal(row.turns, 1, "summary turns excludes overheard");
  assert.equal(row.messages, 4, "messages still counts every durable entry");
  assert.equal(row.firstMessage, "the real question", "overheard is not the first message");
  assert.equal(row.lastMessage, "the real question", "overheard is not the last message");

  const attributed = (await s.attributedTurns()).filter((t) => t.sessionId === a.id);
  assert.equal(
    attributed.reduce((n, t) => n + t.turns, 0),
    1,
    "retention counts only the real user turn",
  );
});

test("pg spend_usage_json returns NULL for invalid or unusual usage text instead of raising (Postgres 18 inlines SQL functions)", async () => {
  const store = createPostgresSessionStore(URL);
  await store.countSessions();
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    const { rows } = await raw.query(
      `SELECT spend_usage_json(t) AS j FROM (VALUES ('not json'), ('{"costUsd":"abc"}'), ('{"costUsd":0.5,"input":1}'), (NULL)) v(t)`,
    );
    assert.deepEqual(
      rows.map((row) => row.j),
      [null, null, { costUsd: 0.5, input: 1 }, null],
    );
  } finally {
    await raw.end();
  }
});
