import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "./support/migrations.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL (a Postgres) to run the legacy base model migration test";

async function withDatabase(run: (url: string, admin: pg.Pool) => Promise<void>): Promise<void> {
  const parent = new pg.Pool({ connectionString: databaseUrl });
  const name = `promote_base_${randomUUID().replaceAll("-", "")}`;
  await parent.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  const admin = new pg.Pool({ connectionString: url.toString() });
  try {
    await run(url.toString(), admin);
  } finally {
    await admin.end();
    await parent.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await parent.end();
  }
}

const rows = async (pool: pg.Pool, table: string) =>
  Object.fromEntries(
    (await pool.query(`SELECT id, json FROM ${table}`)).rows.map((row) => [row.id, row.json]),
  ) as Record<string, Record<string, unknown>>;

test("legacy base models become runtime selections with the same model", { skip }, async () => {
  await withDatabase(async (url, admin) => {
    await migrate(url);
    await admin.query("DELETE FROM qm_schema_migrations WHERE id = 'runtime/0003-promote-legacy-base-models'");
    await admin.query("CREATE TABLE IF NOT EXISTS base_model_configs (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
    const insert = (id: string, json: unknown) =>
      admin.query("INSERT INTO base_model_configs (id, json) VALUES ($1, $2)", [id, JSON.stringify(json)]);
    await insert("org:o", { scopeId: "org:o", modelId: "claude-opus-5", cronRuntime: { modelId: "gpt-5.5" } });
    await insert("personal:a", { scopeId: "personal:a", modelId: "gpt-5.5" });
    await insert("personal:b", { scopeId: "personal:b", modelId: "claude-opus-5", orgRevision: 2, effortLevel: "low" });
    await insert("channel:c", { scopeId: "channel:c", embeddingModelId: "e" });

    await migrate(url);

    const base = await rows(admin, "base_model_configs");
    assert.deepEqual(base["org:o"], {
      scopeId: "org:o",
      modelId: "claude-opus-5",
      cronRuntime: { modelId: "gpt-5.5" },
      orgRevision: 0,
    });
    assert.deepEqual(base["personal:a"], { scopeId: "personal:a", modelId: "gpt-5.5", orgRevision: 0 });
    assert.deepEqual(
      base["personal:b"],
      { scopeId: "personal:b", modelId: "claude-opus-5", orgRevision: 2, effortLevel: "low" },
      "a row that is already a runtime selection is untouched",
    );
    assert.deepEqual(base["channel:c"], { scopeId: "channel:c", embeddingModelId: "e" }, "rows without a model stay");
  });
});
