import { createServer } from "../../src/api/server.ts";
import { buildApp } from "./build-app.ts";
import { createKeychain } from "../../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../../src/connectors/connector-client-store.ts";
import { scopeId } from "../../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../../src/auth/capability-token.ts";
import { testConfig } from "./test-config.ts";
import { testAdvisoryLock, testMap, testDatabaseUrl } from "./test-database.ts";
import { createPostgresReplayDedupe } from "../../src/auth/replay-dedupe.ts";
import { listenLocal } from "./listen-local.ts";

export const SECRET = "agent-admin-test-secret".repeat(3);

export const ORG = scopeId("org", "default-org");

export async function start(withConfig = true) {
  const built = buildApp(
    testConfig({
      signingSecret: SECRET,
      capabilitySecret: SECRET,
      apiBaseUrl: "http://core.example.test",
    }),
  );
  await built.directory.replaceChannels(
    [{ channelId: "C1", name: "agent-admin", isPrivate: false }],
    [
      { channelId: "C1", principalId: "admin-alice" },
      { channelId: "C1", principalId: "U1" },
    ],
  );
  const keychain = createKeychain({
    lock: testAdvisoryLock(),
    creds: testMap(),
    grants: testMap(),
    asks: testMap(),
    key: deriveConnectorKey("admin-agent-capability-keychain"),
  });
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    admin: built.admin,
    memory: built.memory,
    ...(withConfig ? { config: built.config } : {}),
    auditLog: built.auditLog,
    sessions: built.sessions,
    runs: built.runs,
    errors: built.errors,
    keychain,
    capabilitySecret: SECRET,
    signingSecret: SECRET,
  });
  const base = listenLocal(server);
  return { base, built, keychain, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export const capFor = async (
  actorId: string,
  opts: { aud?: string | null; live?: boolean; liveAuthor?: boolean; scope?: string; grants?: string[] } = {},
) => {
  const aud = opts.aud === undefined ? CONTROL_PLANE_AUD : opts.aud;
  return await mintCapabilityToken(
    {
      actorId,
      scopeId: opts.scope ?? scopeId("personal", actorId),
      ...(aud === null ? {} : { aud }),
      ...(opts.live === false ? {} : { liveActor: true }),
      ...(opts.liveAuthor ? { liveAuthor: true } : {}),
      ...(opts.grants ? { grants: opts.grants } : {}),
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    SECRET,
  );
};
