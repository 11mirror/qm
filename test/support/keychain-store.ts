import { type Keychain } from "../../src/credentials/keychain.ts";
import { createKeychain } from "../../src/credentials/create-keychain.ts";
import { deriveConnectorKey } from "../../src/connectors/connector-client-store.ts";
import { testAdvisoryLock } from "./test-database.ts";
import { testDatabaseUrl } from "./test-database.ts";
import { createKeychainStore } from "../../src/credentials/keychain-store.ts";

export const KEY = deriveConnectorKey("keychain-test-key");

export function kc(now?: () => number): Keychain {
  return createKeychain({
    lock: testAdvisoryLock(),
    store: createKeychainStore(testDatabaseUrl()),
    key: KEY,
    ...(now ? { now } : {}),
  });
}

export const GH = {
  ownerId: "U1",
  service: "github",
  secret: "ghp_secret",
  envKey: "GITHUB_TOKEN",
  accountLabel: "AliceBell",
};
