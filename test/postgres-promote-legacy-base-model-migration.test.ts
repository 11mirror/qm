import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_TABLES } from "../src/resolution/config-tables.ts";
import { asMapTables, migrate, skip, typedRows, withMigratedDatabase } from "./support/migrated-database.ts";

test("legacy base models become runtime selections with the same model", { skip }, async () => {
  await withMigratedDatabase(async (url, admin) => {
    await admin.query("DELETE FROM qm_schema_migrations WHERE id = 'runtime/0003-promote-legacy-base-models'");
    await asMapTables(admin, [CONFIG_TABLES.baseModels]);
    await admin.query("CREATE TABLE base_model_configs (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
    const insert = (id: string, json: unknown) =>
      admin.query("INSERT INTO base_model_configs (id, json) VALUES ($1, $2)", [id, JSON.stringify(json)]);
    await insert("org:o", { scopeId: "org:o", modelId: "claude-opus-5", cronRuntime: { modelId: "gpt-5.5" } });
    await insert("personal:a", { scopeId: "personal:a", modelId: "gpt-5.5" });
    await insert("personal:b", { scopeId: "personal:b", modelId: "claude-opus-5", orgRevision: 2, effortLevel: "low" });
    await insert("channel:c", { scopeId: "channel:c", embeddingModelId: "e" });

    await migrate(url);

    const base = await typedRows(admin, CONFIG_TABLES.baseModels);
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
