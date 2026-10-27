import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresCronFireStore } from "../../src/cron/fire-store.ts";
import { registeredPgMigrations } from "../../src/persistence/pg-pool.ts";
import { applyPgMigrations } from "../../src/persistence/pg-migrations.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the cron fire history migration test";

test(
  "legacy fire history (cron_fire_log rows and cron json fireLog arrays) moves into cron_fires once",
  { skip },
  async () => {
    const pg = (await import("pg")).default;
    const client = new pg.Pool({ connectionString: URL! });
    try {
      // A database from before this migration: the baseline and everything else applied, the legacy history still there.
      const fires = createPostgresCronFireStore(URL!);
      await applyPgMigrations(
        client,
        registeredPgMigrations(URL!).filter((m) => m.id !== "cron/fires/0002-retire-legacy-history"),
      );
      await client.query(`CREATE TABLE cron_fire_log (
        cron_id text NOT NULL, fire_key text NOT NULL, fired_at bigint NOT NULL, json jsonb NOT NULL,
        PRIMARY KEY (cron_id, fire_key)
      )`);
      await client.query(`INSERT INTO cron_fire_log VALUES ('legacy-c', 'k-table', 1000, $1)`, [
        { fireKey: "k-table", threadRef: "t-table", firedAt: 1000, endedAt: 2000, status: "ok", reply: "done" },
      ]);
      await client.query(`INSERT INTO crons VALUES ('json-c', $1)`, [
        { id: "json-c", fireLog: [{ fireKey: "k-json", threadRef: "t-json", firedAt: 3000, status: "running" }] },
      ]);
      await client.query(`INSERT INTO crons VALUES ('empty-c', $1)`, [{ id: "empty-c", fireLog: [] }]);

      assert.deepEqual((await fires.listByCron("legacy-c")).runs, [
        { fireKey: "k-table", threadRef: "t-table", firedAt: 1000, endedAt: 2000, status: "ok", reply: "done" },
      ]);
      assert.deepEqual((await fires.listByCron("json-c")).runs, [
        { fireKey: "k-json", threadRef: "t-json", firedAt: 3000, status: "running" },
      ]);
      assert.equal((await client.query("SELECT to_regclass('cron_fire_log') AS t")).rows[0].t, null);
      assert.equal(
        (await client.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'qm_sync_legacy_cron_fire'"))
          .rows[0].n,
        0,
      );
      assert.equal((await client.query("SELECT count(*)::int AS n FROM crons WHERE json ? 'fireLog'")).rows[0].n, 0);
    } finally {
      await client.end();
    }
  },
);
