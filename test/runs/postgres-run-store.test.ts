import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { createPostgresRunStore } from "../../src/runs/postgres-run-store.ts";

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
