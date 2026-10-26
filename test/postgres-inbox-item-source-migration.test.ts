import { test } from "node:test";
import assert from "node:assert/strict";
import { INBOX_ITEM_SOURCE_MIGRATION } from "../src/inbox/ledger.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the inbox item source migration test";

test("inbox items keep their source in one place after the source migration", { skip }, async () => {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  try {
    await pool.query("DROP TABLE IF EXISTS cron_items");
    await pool.query("CREATE TABLE cron_items (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
    await pool.query("CREATE TABLE IF NOT EXISTS durable_map_versions (tbl TEXT PRIMARY KEY, v BIGINT NOT NULL)");
    await pool.query("DELETE FROM durable_map_versions WHERE tbl = 'cron_items'");
    await pool.query("INSERT INTO durable_map_versions (tbl, v) VALUES ('cron_items', 7)");
    const rows = {
      legacy: { sourcePayload: { source: "slack", title: "DM" } },
      both: { source: "gmail", sourcePayload: { source: "gmail", title: "Mail" } },
      current: { source: "gmail", sourcePayload: { title: "Mail" } },
      generic: { sourcePayload: { title: "Ticket" } },
      differing: { source: "gmail", sourcePayload: { source: "crm", title: "Lead" } },
    };
    for (const [id, json] of Object.entries(rows))
      await pool.query("INSERT INTO cron_items (id, json) VALUES ($1, $2)", [id, JSON.stringify(json)]);
    for (let run = 0; run < 2; run++) for (const sql of INBOX_ITEM_SOURCE_MIGRATION.statements) await pool.query(sql);
    const after = Object.fromEntries(
      (await pool.query("SELECT id, json FROM cron_items")).rows.map((row) => [row.id, row.json]),
    );
    assert.deepEqual(after, {
      legacy: { source: "slack", sourcePayload: { title: "DM" } },
      both: { source: "gmail", sourcePayload: { title: "Mail" } },
      current: { source: "gmail", sourcePayload: { title: "Mail" } },
      generic: { sourcePayload: { title: "Ticket" } },
      differing: { source: "gmail", sourcePayload: { source: "crm", title: "Lead" } },
    });
    const [version] = (await pool.query("SELECT v FROM durable_map_versions WHERE tbl = 'cron_items'")).rows;
    assert.equal(Number(version.v), 9);
  } finally {
    await pool.query("DROP TABLE IF EXISTS cron_items");
    await pool.end();
  }
});
