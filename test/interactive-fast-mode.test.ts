import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { scopeId } from "../src/types.ts";
import { resolveTurnFastMode } from "../src/core/turn-options.ts";
import { testConfigStore, testDatabaseUrl } from "./support/test-database.ts";

test("interactive fast mode defaults off and persists across instances", async () => {
  const databaseUrl = testDatabaseUrl();
  const first = testConfigStore("org", { databaseUrl });
  await first.hydrate!();
  assert.equal(first.setting("interactiveFastMode"), false);
  assert.equal(await first.settingDurable("interactiveFastMode"), false);

  await first.setSetting("interactiveFastMode", true);
  assert.equal(first.setting("interactiveFastMode"), true);

  const second = testConfigStore("org", { databaseUrl });
  await second.hydrate!();
  assert.equal(second.setting("interactiveFastMode"), true);
  assert.equal(await second.settingDurable("interactiveFastMode"), true);
});

test("the org default reaches only human turns that expressed no preference", () => {
  assert.equal(resolveTurnFastMode(undefined, true, true), true);
  assert.equal(resolveTurnFastMode(undefined, true, false), undefined);
  assert.equal(resolveTurnFastMode(undefined, false, true), undefined);
  assert.equal(resolveTurnFastMode(false, true, true), false);
  assert.equal(resolveTurnFastMode(true, false, false), true);
});

test("refreshScope picks up an interactive fast mode change written elsewhere", async () => {
  const databaseUrl = testDatabaseUrl();
  const store = testConfigStore("org", { databaseUrl });
  await store.hydrate!();
  const org = scopeId("org", "org");
  await createPgPool(databaseUrl).q(`INSERT INTO interactive_fast_mode_flag (scope_id, "on") VALUES ($1, true)`, [org]);
  await store.refreshScope(org);
  assert.equal(store.setting("interactiveFastMode"), true);
});
