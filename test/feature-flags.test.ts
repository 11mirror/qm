import { tenant } from "../src/tenant.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createFeatureFlagStore } from "../src/feature-flags.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("feature flags map each feature to enabled scopes", async () => {
  const store = createFeatureFlagStore(testDatabaseUrl());
  assert.equal(await store.enabled("team_scopes", "channel:C1"), false);
  await store.setEnabled("team_scopes", "channel:C1", true, "admin");
  await store.setEnabled("team_scopes", "personal:U1", true, "admin");
  assert.equal(await store.enabled("team_scopes", "channel:C1"), true);
  assert.equal(await store.enabled("team_scopes", "channel:C2"), false);
  assert.deepEqual((await store.get("team_scopes"))?.enabledScopes, ["channel:C1", "personal:U1"]);
  await store.setEnabled("team_scopes", "channel:C1", false, "admin");
  assert.equal(await store.enabled("team_scopes", "channel:C1"), false);
});

test("the org scope enables a feature everywhere", async () => {
  const store = createFeatureFlagStore(testDatabaseUrl());
  await store.setEnabled("team_scopes", "org:default-org", true, "admin");
  assert.equal(await store.enabled("team_scopes", "channel:C1"), true);
});

test("ui canvas and responsive spine default off and are enabled per person, independently", async () => {
  const store = createFeatureFlagStore(testDatabaseUrl());
  assert.equal(await store.enabled("ui_canvas", "personal:U1"), false);
  await store.setEnabled("ui_canvas", "personal:U1", true, "admin");
  assert.equal(await store.enabled("ui_canvas", "personal:U1"), true);
  assert.equal(await store.enabled("ui_canvas", "personal:U2"), false);
  assert.equal(await store.enabled("ui_canvas", "channel:C1"), false);

  await store.setEnabled("ui_canvas", "personal:U2", true, "admin");
  assert.equal(await store.enabled("responsive_spine", "personal:U2"), false);
  await store.setEnabled("responsive_spine", "personal:U1", true, "admin");
  assert.equal(await store.enabled("responsive_spine", "personal:U1"), true);
  assert.equal(await store.enabled("responsive_spine", "personal:U2"), false);
  assert.equal(await store.enabled("responsive_spine", "channel:C1"), false);
  await store.setEnabled("responsive_spine", "personal:U1", false, "admin");
  assert.equal(await store.enabled("responsive_spine", "personal:U1"), false);
});

test("retired feature records are not offered as configurable flags", async () => {
  const url = testDatabaseUrl();
  await createPgPool(url).q(
    `INSERT INTO feature_flags (feature_name, enabled_scopes, updated_at, updated_by)
     VALUES ('command_scoped_credentials', ARRAY['channel:C1'], 1, 'admin')`,
  );
  const store = createFeatureFlagStore(url);
  await store.setEnabled("team_scopes", "channel:C1", true, "admin");
  assert.deepEqual(
    (await store.list()).map((row) => row.featureName),
    ["team_scopes"],
  );
});

test("enabledFor includes the tenant org and personal scopes in a single snapshot", async () => {
  const store = createFeatureFlagStore(testDatabaseUrl());
  await store.setEnabled("team_scopes", tenant().orgScope, true, "admin");
  await store.setEnabled("ui_canvas", "personal:U1", true, "admin");
  assert.deepEqual([...(await store.enabledFor("personal:U1"))].sort(), ["team_scopes", "ui_canvas"]);
  assert.deepEqual([...(await store.enabledFor("personal:U2"))], ["team_scopes"]);
});
