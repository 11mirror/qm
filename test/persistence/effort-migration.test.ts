import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { EFFORT_MIGRATION } from "../../src/model/effort-migration.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

test("saved effort aliases normalize in scalar, nested, resumed and queued runtime choices", async () => {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  try {
    await pool.query(`DROP TABLE IF EXISTS base_model_configs, crons, runs, items, decision_rules CASCADE;
      CREATE TABLE base_model_configs (effort_level text, cron_runtime jsonb, subagent_runtime jsonb, fallback_runtime jsonb);
      CREATE TABLE crons (runtime jsonb);
      CREATE TABLE runs (request text, result text, delivery_state text);
      CREATE TABLE items (body jsonb);
      CREATE TABLE decision_rules (options jsonb);
      CREATE SCHEMA IF NOT EXISTS absurd;
      CREATE TABLE absurd.t_effort_test (params jsonb, state jsonb, completed_payload jsonb);
      CREATE TABLE absurd.c_effort_test (state jsonb)`);
    const choice = { modelId: "m", effortLevel: "ultracode", fastMode: true };
    const converted = { ...choice, effortLevel: "max" };
    await pool.query("INSERT INTO base_model_configs VALUES ('ultracode',$1,$1,$1)", [choice]);
    await pool.query("INSERT INTO crons VALUES ($1)", [choice]);
    await pool.query("INSERT INTO runs VALUES ($1,$2,$3)", [
      JSON.stringify({ thinkingLevel: "ultracode", text: "ultracode" }),
      JSON.stringify({ runtime: choice }),
      JSON.stringify({ runtime: choice }),
    ]);
    await pool.query("INSERT INTO items VALUES ($1)", [{ runtimeHandoff: { choice } }]);
    await pool.query("INSERT INTO decision_rules VALUES ($1)", [{ choices: [{ runtime: choice }] }]);
    await pool.query("INSERT INTO absurd.t_effort_test VALUES ($1,$1,$1)", [{ runtime: choice }]);
    await pool.query("INSERT INTO absurd.c_effort_test VALUES ($1)", [{ runtime: choice }]);
    for (const statement of EFFORT_MIGRATION.statements) await pool.query(statement);
    assert.deepEqual((await pool.query("SELECT * FROM base_model_configs")).rows[0], {
      effort_level: "max",
      cron_runtime: converted,
      subagent_runtime: converted,
      fallback_runtime: converted,
    });
    assert.deepEqual((await pool.query("SELECT runtime FROM crons")).rows[0].runtime, converted);
    assert.deepEqual(JSON.parse((await pool.query("SELECT request FROM runs")).rows[0].request), {
      thinkingLevel: "max",
      text: "ultracode",
    });
    assert.deepEqual((await pool.query("SELECT body FROM items")).rows[0].body.runtimeHandoff.choice, converted);
    assert.deepEqual(
      (await pool.query("SELECT options FROM decision_rules")).rows[0].options.choices[0].runtime,
      converted,
    );
    assert.deepEqual((await pool.query("SELECT state FROM absurd.c_effort_test")).rows[0].state.runtime, converted);
    assert.deepEqual((await pool.query("SELECT params FROM absurd.t_effort_test")).rows[0].params.runtime, converted);
  } finally {
    await pool.end();
  }
});
