import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { REMOVE_LOOP_WORK_MIGRATION } from "../../src/cron/retired-work.ts";
import { CONTRACT_MIGRATIONS } from "../../src/persistence/contract-migrations.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

for (const shape of ["json", "typed"])
  test(`removed loop work is not converted or left running (${shape})`, async () => {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
    try {
      await pool.query(`DROP TABLE IF EXISTS crons, loops, loop_items, cron_items, feature_flags, sessions CASCADE; CREATE TABLE crons (${shape === "json" ? "id text, json jsonb" : "id text, enabled boolean, inbox jsonb"});
      CREATE TABLE loops (id text); CREATE TABLE loop_items (id text); CREATE TABLE cron_items (id text);
      CREATE TABLE feature_flags (feature_name text); CREATE TABLE sessions (origin text); INSERT INTO sessions VALUES ('loop')`);
      for (const [id, inbox] of [
        ["ordinary", null],
        ["queue", {}],
        ["source", { source: "gmail" }],
      ]) {
        if (shape === "json")
          await pool.query("INSERT INTO crons VALUES ($1,$2)", [
            id,
            { id, enabled: true, ...(inbox ? { inbox } : {}) },
          ]);
        else await pool.query("INSERT INTO crons VALUES ($1,true,$2)", [id, inbox]);
      }
      if (shape === "json") await pool.query('INSERT INTO crons VALUES (\'loop\', \'{"loopId":"l","enabled":true}\')');
      for (const statement of REMOVE_LOOP_WORK_MIGRATION.statements) await pool.query(statement);
      const rows = (await pool.query("SELECT * FROM crons ORDER BY id")).rows;
      assert.deepEqual(
        rows.map((row) => row.id),
        ["ordinary", "queue"],
      );
      assert.equal(shape === "json" ? rows[0].json.enabled : rows[0].enabled, true);
      assert.equal(shape === "json" ? rows[1].json.enabled : rows[1].enabled, false);
      for (const statement of CONTRACT_MIGRATIONS.find((m) => m.id === "contract/0028-drop-loops-and-cron-inbox")!
        .statements)
        await pool.query(statement);
      assert.deepEqual(
        (
          await pool.query(
            "SELECT to_regclass('loops') AS loops, to_regclass('loop_items') AS items, to_regclass('cron_items') AS inbox",
          )
        ).rows,
        [{ loops: null, items: null, inbox: null }],
      );
    } finally {
      await pool.end();
    }
  });
