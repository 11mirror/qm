import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BuiltApp } from "../src/wiring.ts";
import { buildApp } from "./support/build-app.ts";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken, CONTROL_PLANE_AUD, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";
import { loadConfig } from "../src/config.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const SOURCE = "shared-source-auth-secret-for-tests-0001";
const CAP = "core-only-capability-secret-for-tests-01";

describe("capability tokens verify under the core-only capability secret, not the shared source-auth secret", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const cap = async (secret: string) =>
    mintCapabilityToken(
      { actorId: "U1", scopeId: "personal:U1", aud: CONTROL_PLANE_AUD, exp: Date.now() + CAPABILITY_TTL_MS },
      secret,
    );

  before(async () => {
    built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "cap-iso-")), signingSecret: SOURCE }));
    server = createServer(built.app, {
      replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
      signingSecret: SOURCE,
      capabilitySecret: CAP,
      scheduler: built.scheduler,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const apis = (token: string) => fetch(`${base}/v1/apis`, { headers: { "x-agent-capability": token } });

  it("accepts a capability signed with the capability secret", async () => {
    assert.equal((await apis(await cap(CAP))).status, 200);
  });

  it("rejects a capability forged with only the shared source-auth secret (what a surface holds)", async () => {
    assert.equal((await apis(await cap(SOURCE))).status, 401);
  });
});

describe("loadConfig refuses enforcement that a surface could bypass", () => {
  const PORTAL = "portal-only-identity-secret-for-tests-01";
  const load = (extra: Record<string, string>) =>
    loadConfig({ CORE_SIGNING_SECRET: SOURCE, REQUIRE_SIGNED_PORTAL_IDENTITY: "1", ...extra });

  it("throws when CAPABILITY_SECRET is absent (it would fall back to the source secret)", () => {
    assert.throws(
      () => load({ PORTAL_IDENTITY_SECRET: PORTAL }),
      /CAPABILITY_SECRET must differ from CORE_SIGNING_SECRET/,
    );
  });

  it("throws when PORTAL_IDENTITY_SECRET is absent", () => {
    assert.throws(
      () => load({ CAPABILITY_SECRET: CAP }),
      /PORTAL_IDENTITY_SECRET must differ from CORE_SIGNING_SECRET/,
    );
  });

  it("throws when a split secret equals CORE_SIGNING_SECRET", () => {
    assert.throws(
      () => load({ CAPABILITY_SECRET: SOURCE, PORTAL_IDENTITY_SECRET: PORTAL }),
      /CAPABILITY_SECRET must differ/,
    );
    assert.throws(
      () => load({ CAPABILITY_SECRET: CAP, PORTAL_IDENTITY_SECRET: SOURCE }),
      /PORTAL_IDENTITY_SECRET must differ/,
    );
  });

  it("throws when portal identity and capability signing share a key", () => {
    assert.throws(
      () => load({ CAPABILITY_SECRET: CAP, PORTAL_IDENTITY_SECRET: CAP }),
      /PORTAL_IDENTITY_SECRET must differ from CAPABILITY_SECRET/,
    );
  });

  it("throws when the connector key reuses a signing secret", () => {
    assert.throws(
      () => load({ CAPABILITY_SECRET: CAP, PORTAL_IDENTITY_SECRET: PORTAL, CONNECTOR_SECRET_KEY: CAP }),
      /CONNECTOR_SECRET_KEY must differ from CAPABILITY_SECRET/,
    );
  });

  it("loads when both split secrets are present and distinct", () => {
    assert.ok(load({ CAPABILITY_SECRET: CAP, PORTAL_IDENTITY_SECRET: PORTAL }));
  });

  it("does not gate when enforcement is off, even with shared secrets", () => {
    assert.ok(loadConfig({ CORE_SIGNING_SECRET: SOURCE }));
  });
});
