import { createKeychain, type Keychain } from "../../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../../src/connectors/connector-client-store.ts";
import { testAdvisoryLock, testMap } from "./test-database.ts";

export const KEY = deriveConnectorKey("keychain-test-key");

export function kc(now?: () => number): Keychain {
  return createKeychain({
    lock: testAdvisoryLock(),
    creds: testMap(),
    grants: testMap(),
    asks: testMap(),
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
