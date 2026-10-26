import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

test("a server without a keychain key refuses to start and names the missing setting", () => {
  const config = testConfig();
  delete (config as { connectorSecretKey?: string }).connectorSecretKey;
  assert.throws(() => buildApp(config), /CONNECTOR_SECRET_KEY is required/);
});
