import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createPostgresRunStore } from "../../src/runs/postgres-run-store.ts";
import { createPostgresRunSignalStore } from "../../src/runs/postgres-run-signal-store.ts";
import { claimTurn, finishTurn, testRunStore, type ClaimedTurn } from "../support/turns.ts";
import type { Principal, TurnRequest } from "../../src/types.ts";
import type { OrchestratorInput } from "../../src/core/orchestrator.ts";
import pg from "pg";

const dbUrl = process.env.DATABASE_URL!;
const actor: Principal = { id: "internal:U1", type: "internal" };
const turn = (text: string): OrchestratorInput => ({
  actor,
  conversation: { kind: "dm", threadRef: "t", audience: [actor] },
  origin: { kind: "direct" },
  text,
});

test("pg run store: Unicode stays jsonb-safe through enqueue, edit and both steering paths", async () => {
  const { runs, databaseUrl, close } = testRunStore();
  const signals = createPostgresRunSignalStore(databaseUrl);
  const thread = `unicode-${randomUUID()}`;
  const unsafe = "nul\u0000 lone\ud800 low\udfff emoji😀 literal\\u0000";
  const safe = "nul lone� low� emoji😀 literal\\u0000";
  const inbound: TurnRequest = {
    origin: { kind: "direct" },
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: thread },
    text: unsafe,
  };
  const request = {
    ...turn(unsafe),
    attachments: [{ name: unsafe, mimetype: "text/plain", sizeBytes: 5, blobId: "notes-blob" }],
  };
  try {
    await runs.enqueue({ sessionId: thread, request: turn("working") });
    const first = (await runs.enqueue({ sessionId: thread, request })).run;
    assert.equal(first.request.text, safe);
    assert.equal(first.request.attachments?.[0]?.name, safe);
    assert.equal(request.text, unsafe);
    const privateRun = (
      await runs.enqueue({ sessionId: thread, request: { ...turn(unsafe), privateSessionMessage: true } })
    ).run;
    assert.equal((await runs.latestForThread(thread))?.id, privateRun.id);
    assert.equal((await runs.latestForThread(thread, { excludePrivateMessages: true }))?.id, first.id);
    assert.equal(await runs.editPendingText(first.id, `edit ${unsafe}`, unsafe), true);
    assert.equal(await runs.editPendingText(first.id, "stale", unsafe), false);
    assert.equal((await runs.get(first.id))?.request.displayText, `edit ${safe}`);
    assert.equal(
      await runs.steerQueued(
        first.id,
        privateRun.id,
        {
          kind: "steer",
          text: `edit ${unsafe}`,
          request: { ...inbound, text: `edit ${unsafe}` },
          dedupeKey: `${thread}-queued`,
        },
        signals,
      ),
      true,
    );
    assert.equal(await runs.get(first.id), null);
    const queued = await signals.takePending(privateRun.id);
    assert.equal(queued[0]?.text, `edit ${safe}`);
    assert.equal(queued[0]?.request?.text, `edit ${safe}`);
    assert.equal(
      await signals.send(privateRun.id, {
        kind: "steer",
        text: unsafe,
        request: inbound,
      }),
      true,
    );
    const direct = await signals.takePending(privateRun.id);
    assert.equal(direct[0]?.text, safe);
    assert.equal(direct[0]?.request?.text, safe);
  } finally {
    await signals.close?.();
    await close();
  }
});

test("pg run store: concurrent enqueues with one dedup key create exactly one run", async () => {
  const { runs, close } = testRunStore();
  try {
    const N = 8;
    const raced = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        runs.enqueue({ sessionId: i % 2 ? "s2" : "s3", request: turn(`c${i}`), dedupKey: "kc" }),
      ),
    );
    assert.equal(new Set(raced.map((r) => r.run.id)).size, 1, "all concurrent same-key enqueues return the same run");
    assert.equal(raced.filter((r) => r.deduped === false).length, 1, "exactly one inserter");
    assert.equal(raced.filter((r) => r.deduped === true).length, N - 1, "the rest are dedup hits");
    assert.equal((await runs.list()).length, 1);
  } finally {
    await close();
  }
});

test("pg run store: duplicate enqueue never updates a protected run owner", async () => {
  const { runs, ledger, databaseUrl, close } = testRunStore();
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: databaseUrl });
  const key = `protected-${randomUUID()}`;
  try {
    const original = await runs.enqueue({ sessionId: key, request: turn("original"), dedupKey: key });
    const runId = original.run.id;
    await raw.query(`CREATE FUNCTION reject_run_owner_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'turn dedup owner still has active routes' USING ERRCODE='23503';
      END
    $$`);
    await raw.query(`CREATE TRIGGER reject_run_owner_update BEFORE UPDATE OF id ON runs
      FOR EACH ROW EXECUTE FUNCTION reject_run_owner_update()`);
    let claimed: ClaimedTurn | null = null;
    for (const status of ["pending", "running", "done"]) {
      if (status === "running") claimed = await claimTurn(ledger, runId);
      if (status === "done") await finishTurn(claimed!, { status: "ok", reply: "finished" });
      const before = await runs.get(runId);
      const duplicates = await Promise.all(
        Array.from({ length: 8 }, () =>
          runs.enqueue({
            sessionId: "different-session",
            request: turn("duplicate"),
            dedupKey: key,
            maxAttempts: 9,
          }),
        ),
      );
      for (const duplicate of duplicates) {
        assert.equal(duplicate.deduped, true);
        assert.deepEqual(duplicate.run, before);
        assert.equal(duplicate.run.status, status);
      }
      assert.deepEqual(await runs.get(runId), before);
    }
    assert.deepEqual(await runs.inFlightForThread("different-session"), []);
  } finally {
    await raw.end();
    await close();
  }
});

test("pg run store: enqueue retries when a conflicting key is released before lookup", async () => {
  const { runs, databaseUrl, close } = testRunStore();
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: databaseUrl });
  const key = `released-${randomUUID()}`;
  try {
    await runs.activeSessionIds();
    await raw.query(`CREATE FUNCTION insert_conflicting_run_key() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF pg_trigger_depth() = 1 AND NOT EXISTS (SELECT 1 FROM runs WHERE id = 'interloper') THEN
          INSERT INTO runs(id, session_id, status, request, idempotency_key, created_at)
          VALUES ('interloper', 'elsewhere', 'done', '{}', '${key}', 1);
        END IF;
        RETURN NULL;
      END
    $$`);
    await raw.query(`CREATE FUNCTION release_conflicting_run_key() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF pg_trigger_depth() = 1 THEN
          UPDATE runs SET idempotency_key = NULL WHERE id = 'interloper';
        END IF;
        RETURN NULL;
      END
    $$`);
    await raw.query(`CREATE TRIGGER insert_conflicting_run_key BEFORE INSERT ON runs
      FOR EACH STATEMENT EXECUTE FUNCTION insert_conflicting_run_key()`);
    await raw.query(`CREATE TRIGGER release_conflicting_run_key AFTER INSERT ON runs
      FOR EACH STATEMENT EXECUTE FUNCTION release_conflicting_run_key()`);
    const retried = await runs.enqueue({ sessionId: key, request: turn("retry"), dedupKey: key });
    assert.equal(retried.deduped, false);
    assert.notEqual(retried.run.id, "interloper");
    assert.equal(retried.run.request.text, "retry");
    assert.equal((await runs.get("interloper"))?.dedupKey, null);
    assert.equal((await runs.getByDedupKey(key))?.id, retried.run.id);
  } finally {
    await raw.end();
    await close();
  }
});

test("pg run store: the schema refuses a second running row for a conversation", async () => {
  const { runs, ledger, databaseUrl, close } = testRunStore();
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: databaseUrl });
  try {
    const r1 = (await runs.enqueue({ sessionId: "sRace", request: turn("a") })).run;
    const r2 = (await runs.enqueue({ sessionId: "sRace", request: turn("b") })).run;
    assert.ok(await claimTurn(ledger, r1.id));
    await assert.rejects(
      raw.query("UPDATE runs SET status='running' WHERE id=$1", [r2.id]),
      /idx_runs_one_running_per_session/,
    );
    assert.equal((await runs.get(r2.id))?.status, "queued", "the queued sibling stays queued");
  } finally {
    await raw.end();
    await close();
  }
});

test("pg run store: created_at outranks a scrambled seq backfill in the queue order", async () => {
  const { runs, databaseUrl, close } = testRunStore();
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: databaseUrl });
  try {
    await runs.enqueue({ sessionId: "sBackfill", request: turn("live") });
    const early = (await runs.enqueue({ sessionId: "sBackfill", request: turn("early") })).run;
    await new Promise((r) => setTimeout(r, 5));
    const late = (await runs.enqueue({ sessionId: "sBackfill", request: turn("late") })).run;
    await raw.query("UPDATE runs SET seq = 999999999 WHERE id = $1", [early.id]);
    assert.deepEqual(
      (await runs.inFlightForThread("sBackfill")).slice(1).map((r) => r.id),
      [early.id, late.id],
    );
  } finally {
    await raw.end();
    await close();
  }
});

test("pg run store: withdraw and claim cannot both win the same unstarted run", async () => {
  const { runs, ledger, close } = testRunStore();
  try {
    const live = (await runs.enqueue({ sessionId: "sWd", request: turn("live") })).run;
    assert.ok(await claimTurn(ledger, live.id));
    const queued = (await runs.enqueue({ sessionId: "sWd", request: turn("queued") })).run;
    const results = await Promise.all(Array.from({ length: 8 }, () => runs.withdraw(queued.id)));
    assert.equal(results.filter(Boolean).length, 1, "exactly one withdrawal wins");
    assert.equal(await runs.get(queued.id), null);

    const contested = (await runs.enqueue({ sessionId: "sWd2", request: turn("contested") })).run;
    const [withdrawn, claimed] = await Promise.all([runs.withdraw(contested.id), claimTurn(ledger, contested.id)]);
    assert.notEqual(withdrawn, Boolean(claimed), "the run is either withdrawn or running, never both");
    assert.equal((await runs.get(contested.id))?.status ?? null, claimed ? "running" : null);
  } finally {
    await close();
  }
});

test("pg run store startup does not lock an already-migrated tool ledger", async () => {
  const baseline = createPostgresRunStore(dbUrl);
  await baseline.runs.activeSessionIds();
  const pg = (await import("pg")).default;
  const reader = new pg.Client({ connectionString: dbUrl });
  await reader.connect();
  const reboot = createPostgresRunStore(dbUrl);
  let initialization: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await reader.query("BEGIN");
    await reader.query("SELECT output FROM tool_calls LIMIT 1");
    const runId = `boot-ledger-${randomUUID()}`;
    initialization = (async () => {
      await reboot.runs.activeSessionIds();
      await reboot.ledger.record(runId, 1, 0, "kept");
      assert.deepEqual(await baseline.ledger.begin(runId, 1, 0), { cached: true, output: "kept" });
    })();
    await Promise.race([
      initialization,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("run-store startup blocked on a ledger reader")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await reader.query("ROLLBACK");
    await initialization?.catch(() => {});
    await Promise.all([reader.end(), baseline.close(), reboot.close()]);
  }
});

test("pg run store indexes newest active run by session", async () => {
  const { close } = createPostgresRunStore(dbUrl);
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: dbUrl });
  try {
    const result = await raw.query(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_runs_session_active_created'",
    );
    assert.match(
      result.rows[0]?.indexdef ?? "",
      /\(session_id, created_at DESC\).*WHERE \(status = ANY \(ARRAY.*pending.*running/,
    );
  } finally {
    await raw.end();
    await close();
  }
});

test("pg terminal returns survive reopening the run store", async () => {
  const first = testRunStore();
  const { run } = await first.runs.enqueue({
    sessionId: `agent:main:subagent:${randomUUID()}`,
    request: turn("return result"),
  });
  await finishTurn((await claimTurn(first.ledger, run.id))!, { status: "ok", reply: "done" });
  await first.close();
  const second = createPostgresRunStore(first.databaseUrl);
  assert.ok((await second.runs.pendingReturns(1000)).some((pending) => pending.id === run.id));
  assert.ok(!(await second.runs.pendingReturns(1000, run.id)).some((pending) => pending.id === run.id));
  await second.runs.markReturned(run.id);
  assert.ok(!(await second.runs.pendingReturns(1000)).some((pending) => pending.id === run.id));
  await second.close();
});

test("pg unstarted withdrawal preserves claimed and handed-back turns", async () => {
  const { runs, ledger, close } = testRunStore();
  try {
    const { run } = await runs.enqueue({ sessionId: `wake-retry-${randomUUID()}`, request: turn("completion") });
    const claimed = (await claimTurn(ledger, run.id))!;
    assert.equal(await runs.withdraw(run.id, { unstartedOnly: true }), false);
    await ledger.handBack(claimed.run, claimed.token, { stop: { kind: "shutdown" } });
    assert.equal(await runs.withdraw(run.id, { unstartedOnly: true }), false);
    assert.equal((await runs.get(run.id))!.status, "pending");
    const { run: fresh } = await runs.enqueue({
      sessionId: `wake-fresh-${randomUUID()}`,
      request: turn("completion"),
    });
    assert.equal(await runs.withdraw(fresh.id, { unstartedOnly: true }), true);
    assert.equal(await runs.get(fresh.id), null);
  } finally {
    await close();
  }
});

const database = process.env.DATABASE_URL;
const MIGRATION = "runs/store/0013-turn-origin-backfill";

const base = {
  surface: "slack",
  actor: { externalId: "U1" },
  conversation: { kind: "dm", threadRef: "t" },
  text: "hi",
};
const legacy = {
  automation: [
    { ...base, triggered: true, securityScreenData: "", triggerDestination: { type: "web" }, ownerKeychainUnion: true },
    { kind: "automation", screenData: "", destination: { type: "web" }, useOwnerKeychain: true },
  ],
  ambient: [
    { ...base, unprompted: true, liveActor: true, entryTs: "1.2" },
    { kind: "ambient", entryTs: "1.2", live: true },
  ],
  human: [
    { ...base, liveActor: true, triggerTs: "3.4", entryTs: "" },
    { kind: "human", messageTs: "3.4" },
  ],
  direct: [{ ...base }, { kind: "direct" }],
  typed: [{ ...base, triggered: true, origin: { kind: "human" } }, { kind: "human" }],
} as const;

test(
  "stored runs, approvals and signals written with turn flags gain a typed origin",
  { skip: !database },
  async () => {
    const first = createPostgresRunStore(database!);
    await first.runs.get("warm-up");
    await first.close();
    const client = new pg.Client({ connectionString: database });
    await client.connect();
    try {
      for (const [id, [request]] of Object.entries(legacy)) {
        await client.query(
          `INSERT INTO runs(id, session_id, status, request, attempts, max_attempts, created_at) VALUES ($1, 's', 'succeeded', $2, 1, 3, 0)`,
          [id, JSON.stringify(request)],
        );
      }
      await client.query(`INSERT INTO approvals(id, json) VALUES ('a', $1)`, [
        JSON.stringify({ sessionId: "s", command: "c", request: legacy.automation[0] }),
      ]);
      await client.query(`INSERT INTO run_signals(run_id, kind, payload, created_at) VALUES ('r', 'steer', $1, 0)`, [
        JSON.stringify({ kind: "steer", request: legacy.ambient[0] }),
      ]);
      await client.query(`DELETE FROM qm_schema_migrations WHERE id = $1`, [MIGRATION]);

      const reborn = new URL(database!);
      reborn.searchParams.set("application_name", "qm-origin-backfill");
      const second = createPostgresRunStore(reborn.toString());
      try {
        for (const [id, [, origin]] of Object.entries(legacy)) {
          const run = await second.runs.get(id);
          assert.deepEqual(run?.request.origin, origin, id);
          if (id !== "typed") assert.equal("triggered" in run!.request || "liveActor" in run!.request, false, id);
        }
      } finally {
        await second.close();
      }
      const approval = await client.query(`SELECT json -> 'request' AS r FROM approvals WHERE id = 'a'`);
      assert.deepEqual(approval.rows[0].r.origin, legacy.automation[1]);
      assert.equal(approval.rows[0].r.triggered, undefined);
      const signal = await client.query(`SELECT payload -> 'request' AS r FROM run_signals WHERE run_id = 'r'`);
      assert.deepEqual(signal.rows[0].r.origin, legacy.ambient[1]);
    } finally {
      await client.end();
    }
  },
);
test("released run migrations still match their pinned source checksums", () => {
  assert.doesNotThrow(() => createPostgresRunStore("postgres://migration-pin.invalid"));
});
