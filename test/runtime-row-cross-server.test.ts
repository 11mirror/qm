import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { CONFIG_TABLES, keyedTable } from "../src/resolution/config-tables.ts";
import type { PersistedBaseModel } from "../src/resolution/config-store.ts";
import { scopeId } from "../src/types.ts";
import { testConfigStore, testDatabaseUrl } from "./support/test-database.ts";

const org = scopeId("org", "default-org");
const cron = { modelId: "cron-model" };
const pick = { modelId: "org-model" };

function servers() {
  const databaseUrl = testDatabaseUrl();
  return {
    rows: keyedTable<PersistedBaseModel>(createPgPool(databaseUrl), CONFIG_TABLES.baseModels),
    left: testConfigStore("default-org", { databaseUrl }),
    right: testConfigStore("default-org", { databaseUrl }),
  };
}

test("an org runtime change and a cron runtime saved at once on two servers both persist", async () => {
  const { rows, left, right } = servers();
  await Promise.all([left.setRuntimeSelection(org, pick), right.setPurposeRuntime("cron", cron)]);
  const row = await rows.get(org);
  assert.equal(row?.modelId, "org-model");
  assert.deepEqual(row?.cronRuntime, cron);
});

test("concurrent org runtime changes on two servers get distinct revisions", async () => {
  const { rows, left, right } = servers();
  await rows.put(org, { scopeId: org, modelId: "seed", revision: 1, orgRevision: 1 });
  await Promise.all([left.setRuntimeSelection(org, pick), right.setRuntimeSelection(org, { modelId: "other" })]);
  assert.equal((await rows.get(org))?.revision, 3);
});

test("acknowledging the org runtime on one server keeps a scope runtime another server just chose", async () => {
  const { rows, left, right } = servers();
  const channel = scopeId("channel", "c1");
  await rows.put(channel, { scopeId: channel, modelId: "old", orgRevision: 0 });
  await rows.put(org, { scopeId: org, modelId: "org-model", revision: 4, orgRevision: 4 });
  await Promise.all([
    left.acknowledgeRuntimeSelection(channel),
    right.setRuntimeSelection(channel, { modelId: "new" }),
  ]);
  const row = await rows.get(channel);
  assert.equal(row?.modelId, "new");
  assert.equal(row?.orgRevision, 4);
});

test("clearing the org runtime keeps purpose runtimes and removes an empty row", async () => {
  const { rows, left: store } = servers();
  await store.setRuntimeSelection(org, pick);
  await store.setPurposeRuntime("cron", cron);
  await store.setRuntimeSelection(org, null);
  assert.deepEqual(await rows.get(org), { scopeId: org, cronRuntime: cron });
  await store.clearPurposeRuntime("cron");
  assert.equal(await rows.get(org), null);
  assert.equal(store.getRuntimeSelection(org), null);
});
