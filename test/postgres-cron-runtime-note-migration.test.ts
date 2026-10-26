import { test } from "node:test";
import assert from "node:assert/strict";
import { DROP_CRON_RUNTIME_AND_NOTE_MIGRATION } from "../src/cron/cron-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the cron runtime/note migration test";

test("crons lose their per-cron runtime override and shift-change note; everything else stays", { skip }, async () => {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  try {
    await pool.query("DROP TABLE IF EXISTS crons");
    await pool.query(DROP_CRON_RUNTIME_AND_NOTE_MIGRATION.statements[0]!);
    const destination = { type: "slack", target: "C1", audienceScopeId: "channel:C1" };
    const crons = {
      both: {
        action: "check",
        destination,
        runtime: { modelId: "m", effortLevel: "low" },
        lastFireNote: { text: "quiet", at: 1 },
      },
      runtimeOnly: { action: "check", runtime: null },
      plain: { action: "check", destination },
    };
    for (const [id, json] of Object.entries(crons))
      await pool.query("INSERT INTO crons (id, json) VALUES ($1, $2)", [id, JSON.stringify({ id, ...json })]);

    for (const run of [1, 2]) {
      for (const sql of DROP_CRON_RUNTIME_AND_NOTE_MIGRATION.statements) await pool.query(sql);
      const rows: Record<string, Record<string, unknown>> = Object.fromEntries(
        (await pool.query("SELECT id, json FROM crons")).rows.map((row) => [row.id, row.json]),
      );
      assert.deepEqual(rows.both, { id: "both", action: "check", destination }, `run ${run}`);
      assert.deepEqual(rows.runtimeOnly, { id: "runtimeOnly", action: "check" });
      assert.deepEqual(rows.plain, { id: "plain", action: "check", destination });
    }
  } finally {
    await pool.end();
  }
});
