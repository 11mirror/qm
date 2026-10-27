import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId } from "../src/types.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { testRunStore } from "./support/turns.ts";

test("batch appends keep order, roll back atomically and check leases", async () => {
  const databaseUrl = testDatabaseUrl();
  const store = createPostgresSessionStore(databaseUrl);
  const scope = scopeId("personal", "batch");
  for (let i = 0; i < 2; i++) {
    const session = await store.getOrCreateByThread(`web:batch:${randomUUID()}`, "dm", scope);
    const { lease } = await store.acquireLease(session.id);
    assert.ok(lease);
    const entries = await store.appendMany(
      lease,
      Array.from({ length: 5 }, (_, n) => ({ kind: "UserMessage" as const, text: `message ${n}` })),
    );
    assert.deepEqual(
      entries.map((entry) => entry.seq),
      [0, 1, 2, 3, 4],
    );
    assert.deepEqual((await store.getItems(session.id)).slice(-5), entries);
    assert.deepEqual(await store.appendMany(lease, []), []);
    const batch = [5, 6].map((n) => ({ kind: "UserMessage" as const, text: `message ${n}` }));
    {
      const pool = new pg.Pool({ connectionString: databaseUrl });
      try {
        const constraint = `items_batch_${randomUUID().replaceAll("-", "")}`;
        await pool.query(
          `ALTER TABLE items ADD CONSTRAINT ${constraint} CHECK (session_id <> '${session.id}' OR seq <> 6) NOT VALID`,
        );
        try {
          await assert.rejects(store.appendMany(lease, batch));
          assert.equal((await store.getItems(session.id)).length, 5);
        } finally {
          await pool.query(`ALTER TABLE items DROP CONSTRAINT ${constraint}`);
        }
      } finally {
        await pool.end();
      }
    }
    await store.releaseLease(lease);
    await assert.rejects(store.appendMany(lease, batch), /lease/);
  }
});
test("session goals live on the session row behind its lease", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("personal", "batch");
  const goal = (objective: string) => ({
    objective,
    status: "active" as const,
    tokensUsed: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const session = await store.getOrCreateByThread(`web:batch:${randomUUID()}`, "dm", scope);
    ids.push(session.id);
  }
  for (const [i, id] of ids.slice(0, 2).entries()) {
    const { lease } = await store.acquireLease(id);
    assert.ok(lease);
    await store.setGoal(lease, goal(`first ${i}`));
    const notice = {
      kind: "Wake" as const,
      wakeCause: "system" as const,
      body: { kind: "goal_cancelled", objective: `goal ${i}`, cancelledBy: "u" },
    };
    await store.setGoal(lease, { ...goal(`goal ${i}`), status: "paused" }, [notice]);
    await store.releaseLease(lease);
    await assert.rejects(store.setGoal(lease, goal("stale lease"), [notice]), /valid session lease/);
    assert.deepEqual(
      (await store.getItems(id)).map((item) => ({ kind: item.kind, wakeCause: item.wakeCause, body: item.body })),
      [notice],
      "the notice lands with the goal and not with a rejected write",
    );
  }
  const found = await store.goals([...ids, "missing"]);
  assert.deepEqual(
    [...found.entries()].sort(([a], [b]) => ids.indexOf(a) - ids.indexOf(b)),
    [
      [ids[0], { ...goal("goal 0"), status: "paused" }],
      [ids[1], { ...goal("goal 1"), status: "paused" }],
    ],
  );
  assert.deepEqual(await store.goals([]), new Map());
});

test("latest runs batch matches single reads including private messages and ties", async () => {
  const { runs, close } = testRunStore();
  const ids = [`batch:${randomUUID()}`, `batch:${randomUUID()}`];
  const actor = { id: "internal:batch", type: "internal" as const };
  try {
    for (const id of ids)
      for (const privateSessionMessage of [false, true])
        await runs.enqueue({
          sessionId: id,
          request: {
            actor,
            conversation: { kind: "dm", threadRef: id, audience: [actor] },
            origin: { kind: "direct" },
            text: "batch",
            ...(privateSessionMessage ? { privateSessionMessage: true as const } : {}),
          },
        });
    for (const excludePrivateMessages of [false, true]) {
      const batch = await runs.latestForThreads([...ids, "missing", ids[0]!], { excludePrivateMessages });
      assert.equal(batch.size, 2);
      for (const id of ids) assert.deepEqual(batch.get(id), await runs.latestForThread(id, { excludePrivateMessages }));
    }
    assert.deepEqual(await runs.latestForThreads([]), new Map());
  } finally {
    await close();
  }
});
