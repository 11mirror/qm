import { createKeychain, type Keychain } from "../../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../../src/connectors/connector-client-store.ts";
import { testAdvisoryLock } from "./test-database.ts";
import { testDatabaseUrl } from "./test-database.ts";
import { createKeychainStore } from "../../src/credentials/keychain-store.ts";

export const KEY = deriveConnectorKey("keychain-ask-test-key");

export function kcAt(now: () => number): Keychain {
  return createKeychain({
    lock: testAdvisoryLock(),
    store: createKeychainStore(testDatabaseUrl()),
    key: KEY,
    now,
  });
}

export const GH = {
  ownerId: "U_ALICE",
  service: "github",
  secret: "ghp_alice",
  envKey: "GITHUB_TOKEN",
  accountLabel: "alice-acme",
};
