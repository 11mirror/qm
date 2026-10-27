import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { scopeId } from "../src/types.ts";
import { failTableWrites, testConfigStore, testDatabaseUrl } from "./support/test-database.ts";

const channel = scopeId("channel", "C1");

test("a config write resolves only after another instance can read it from the store", async () => {
  const databaseUrl = testDatabaseUrl();
  const writer = testConfigStore("default-org", { databaseUrl });
  const reader = testConfigStore("default-org", { databaseUrl });

  await writer.setSetting("orgAmbient", false);

  assert.equal(await reader.settingDurable("orgAmbient"), false);
});

test("a failed config write rejects and leaves this instance's cache on the stored value", async () => {
  const databaseUrl = testDatabaseUrl();
  const config = testConfigStore("default-org", { databaseUrl });
  await config.hydrate!();
  await failTableWrites(databaseUrl, "egress_policies");

  await assert.rejects(
    config.setSetting("egress", { allowedHosts: ["api.example.com"], deniedHosts: [] }, channel),
    /forced durable write failure/,
  );

  assert.equal(config.setting("egress", channel), null);
  assert.deepEqual(await createPgPool(databaseUrl).q("SELECT scope_id FROM egress_policies"), []);
});
