import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveConnectorKey } from "../../src/connectors/connector-client-store.ts";
import { createBrowserSessionStore } from "../../src/connectors/browser-session-store.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

const KEY = deriveConnectorKey(Buffer.alloc(32, 7));
const STATE = JSON.stringify({ cookies: [{ name: "sid", value: "abc", domain: ".doordash.com" }] });

test("round-trips a principal's storage_state, encrypted at rest and keyed per principal", async () => {
  const databaseUrl = testDatabaseUrl();
  const store = createBrowserSessionStore({ databaseUrl, key: KEY });
  assert.equal(await store.get("U1"), null);
  await store.put("U1", STATE);
  assert.equal(await store.get("U1"), STATE);
  assert.equal(await store.get("U2"), null);
  const [rec] = await createPgPool(databaseUrl).q(`SELECT state_enc FROM browser_sessions WHERE principal_id = 'U1'`);
  assert.doesNotMatch(rec!.state_enc as string, /doordash|cookies|sid/);
  const other = createBrowserSessionStore({ databaseUrl, key: deriveConnectorKey(Buffer.alloc(32, 9)) });
  assert.equal(await other.get("U1"), null, "a blob that doesn't decrypt under the current key reads as absent");
});
