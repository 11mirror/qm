import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, describe, it, before, after } from "node:test";
import { deflateRawSync } from "node:zlib";
import { createServer } from "../../src/api/server.ts";
import {
  BLOB_TRANSFER_AUD,
  CAPABILITY_TTL_MS,
  mintCapabilityToken,
  verifyBlobTransferCapability,
  verifyCapabilityToken,
  type CapabilityClaims,
  CONTROL_PLANE_AUD,
} from "../../src/auth/capability-token.ts";
import { createPostgresReplayDedupe } from "../../src/auth/replay-dedupe.ts";
import { mintSignedPayload } from "../../src/auth/signed-token.ts";
import { loadConfig } from "../../src/config.ts";
import type { BuiltApp } from "../../src/wiring.ts";
import { buildApp } from "../support/build-app.ts";
import { testConfig } from "../support/test-config.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

const SECRET = "test-signing-secret";
const claims = (over: Partial<CapabilityClaims> = {}): CapabilityClaims => ({
  actorId: "U1",
  scopeId: "personal:U1",
  destination: { type: "slack", target: "D123", audienceScopeId: "personal:U1" },
  exp: Date.now() + CAPABILITY_TTL_MS,
  ...over,
});

test("large room capabilities fit an 8 KiB header without losing authorization claims", async () => {
  const members = Array.from({ length: 120 }, (_, i) => ({
    id: `${createHash("sha256").update(String(i)).digest("hex").slice(0, 16)}@example.test`,
    type: i === 119 ? ("guest" as const) : ("internal" as const),
    displayName: `Member ${i}`,
    teamIds: ["engineering", `team-${i % 4}`],
  }));
  const c = claims({ members, keychainMembers: members.filter((p) => p.type === "internal"), grants: ["read"] });
  const value = { orgId: "default-org", ...c };
  const legacy = await mintSignedPayload(value, SECRET);
  assert.ok(Buffer.byteLength(legacy) > 16 * 1024);
  const token = await mintCapabilityToken(c, SECRET);
  assert.ok(Buffer.byteLength(`x-agent-capability: ${token}\r\n`) < 8 * 1024);
  assert.deepEqual(await verifyCapabilityToken(token, SECRET), value);
  assert.deepEqual(await verifyCapabilityToken(legacy, SECRET), value);
  assert.deepEqual(await verifyCapabilityToken(token, ["rotated-secret", SECRET]), value);
  assert.equal(await verifyCapabilityToken(token, "wrong-secret"), null);
  assert.equal(await verifyCapabilityToken(token, SECRET, c.exp), null);
  const [header, payload, signature] = token.split(".");
  const altered = Buffer.from(signature!, "base64url");
  altered[0] = altered[0]! ^ 1;
  assert.equal(await verifyCapabilityToken(`${header}.${payload}.${altered.toString("base64url")}`, SECRET), null);
});

test("compressed capability envelopes reject malformed and oversized claims", async () => {
  for (const value of [
    { encoding: "unknown", claims: "e30" },
    { encoding: "deflate-raw", claims: 42 },
    { encoding: "deflate-raw", claims: "not-compressed" },
    { encoding: "deflate-raw", claims: deflateRawSync("not-json").toString("base64url") },
    { encoding: "deflate-raw", claims: deflateRawSync("null").toString("base64url") },
    { encoding: "deflate-raw", claims: deflateRawSync("x".repeat(1024 * 1024 + 1)).toString("base64url") },
  ]) {
    assert.equal(await verifyCapabilityToken(await mintSignedPayload(value, SECRET), SECRET), null);
  }
  await assert.rejects(mintCapabilityToken(claims({ threadRef: "x".repeat(1024 * 1024) }), SECRET), /size limit/);
  for (const invalid of [{ timezone: "not-a-zone" }, { grants: [1] }, { runAttempt: 0 }]) {
    const token = await mintSignedPayload(
      {
        encoding: "deflate-raw",
        claims: deflateRawSync(JSON.stringify(claims(invalid as Partial<CapabilityClaims>))).toString("base64url"),
      },
      SECRET,
    );
    assert.equal(await verifyCapabilityToken(token, SECRET), null);
  }
});

test("mint → verify round-trips the claims", async () => {
  const c = claims();
  const got = await verifyCapabilityToken(await mintCapabilityToken(c, SECRET), SECRET);
  assert.deepEqual(got, { orgId: "default-org", ...c });
});

test("grants round-trip and reject malformed claims", async () => {
  const granted = claims({ grants: ["admin.sessions.read"] });
  assert.deepEqual(await verifyCapabilityToken(await mintCapabilityToken(granted, SECRET), SECRET), {
    orgId: "default-org",
    ...granted,
  });
  for (const grants of ["admin.sessions.read", ["admin.sessions.read", 1]]) {
    assert.equal(
      await verifyCapabilityToken(
        await mintCapabilityToken(claims({ grants } as unknown as Partial<CapabilityClaims>), SECRET),
        SECRET,
      ),
      null,
    );
  }
});

test("timezone claims must be valid IANA timezone strings", async () => {
  const c = claims({ timezone: "America/Los_Angeles" });
  assert.deepEqual(await verifyCapabilityToken(await mintCapabilityToken(c, SECRET), SECRET), {
    orgId: "default-org",
    ...c,
  });

  for (const timezone of ["", " America/Los_Angeles ", "not-a-zone", "x".repeat(65), 12]) {
    assert.equal(
      await verifyCapabilityToken(
        await mintCapabilityToken(claims({ timezone } as Partial<CapabilityClaims>), SECRET),
        SECRET,
      ),
      null,
    );
  }
});

test("scope authorization metadata is type-checked", async () => {
  assert.ok(await verifyCapabilityToken(await mintCapabilityToken(claims({ scopeVersion: "42" }), SECRET), SECRET));
  assert.equal(
    await verifyCapabilityToken(
      await mintCapabilityToken(claims({ scopeVersion: 42 } as unknown as Partial<CapabilityClaims>), SECRET),
      SECRET,
    ),
    null,
  );
});

test("a tampered payload fails verification", async () => {
  const token = await mintCapabilityToken(claims(), SECRET);
  const [header, payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify(claims({ actorId: "U2" })), "utf8").toString("base64url");
  assert.equal(await verifyCapabilityToken(`${header}.${forged}.${sig}`, SECRET), null);
  const tamperedSignature = Buffer.from(sig!, "base64url");
  tamperedSignature[0] = tamperedSignature[0]! ^ 1;
  assert.equal(
    await verifyCapabilityToken(`${header}.${payload}.${tamperedSignature.toString("base64url")}`, SECRET),
    null,
  );
});

test("the wrong secret fails verification", async () => {
  assert.equal(await verifyCapabilityToken(await mintCapabilityToken(claims(), SECRET), "other-secret"), null);
});

test("an expired token fails closed", async () => {
  assert.equal(
    await verifyCapabilityToken(await mintCapabilityToken(claims({ exp: Date.now() - 1 }), SECRET), SECRET),
    null,
  );
});

test("malformed tokens return null, not throw", async () => {
  for (const t of ["not-a-token", "", ".", "YQ.deadbeef"]) assert.equal(await verifyCapabilityToken(t, SECRET), null);
});

test("blob-transfer verification enforces its audience-specific grant", async () => {
  const id = "a".repeat(32);
  const read = await mintCapabilityToken(claims({ aud: BLOB_TRANSFER_AUD, blob: { dir: "read", id } }), SECRET);
  assert.ok(await verifyBlobTransferCapability(read, SECRET, { dir: "read", id }));
  assert.equal(await verifyBlobTransferCapability(read, SECRET, { dir: "read", id: "b".repeat(32) }), null);
  assert.equal(await verifyBlobTransferCapability(read, SECRET, { dir: "write" }), null);

  const malformed = await mintCapabilityToken(
    claims({ aud: BLOB_TRANSFER_AUD, blob: { dir: "read", id: "../../etc/passwd" } }),
    SECRET,
  );
  assert.equal(await verifyBlobTransferCapability(malformed, SECRET, { dir: "read", id: "../../etc/passwd" }), null);

  const write = await mintCapabilityToken(claims({ aud: BLOB_TRANSFER_AUD, blob: { dir: "write" } }), SECRET);
  assert.ok(await verifyBlobTransferCapability(write, SECRET, { dir: "write" }));
  assert.equal(
    await verifyBlobTransferCapability(await mintCapabilityToken(claims({ blob: { dir: "write" } }), SECRET), SECRET, {
      dir: "write",
    }),
    null,
  );
});

test("a deployment claim round-trips and must be a non-empty string", async () => {
  const c = claims({ deployment: "dpl-1" });
  assert.deepEqual(await verifyCapabilityToken(await mintCapabilityToken(c, SECRET), SECRET), {
    orgId: "default-org",
    ...c,
  });
  for (const deployment of [7, "", null] as unknown[]) {
    const token = await mintCapabilityToken(claims({ deployment } as Partial<CapabilityClaims>), SECRET);
    assert.equal(await verifyCapabilityToken(token, SECRET), null, `deployment=${JSON.stringify(deployment)}`);
  }
});

test("session and run-attempt claims round-trip and reject malformed values", async () => {
  const bound = claims({ sessionId: "session", runAttempt: 2, runLeaseToken: "lease" });
  assert.deepEqual(await verifyCapabilityToken(await mintCapabilityToken(bound, SECRET), SECRET), {
    orgId: "default-org",
    ...bound,
  });
  for (const invalid of [
    { sessionId: "" },
    { sessionId: 1 },
    { runAttempt: 0 },
    { runAttempt: -1 },
    { runAttempt: 1.5 },
    { runAttempt: "1" },
    { runLeaseToken: "" },
    { runLeaseToken: 1 },
  ]) {
    assert.equal(
      await verifyCapabilityToken(
        await mintCapabilityToken(claims(invalid as Partial<CapabilityClaims>), SECRET),
        SECRET,
      ),
      null,
    );
  }
});

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
    built = buildApp(testConfig({ signingSecret: SOURCE }));
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

  it("throws when CAPABILITY_SECRET is absent (no fallback to the source secret)", () => {
    assert.throws(() => load({ PORTAL_IDENTITY_SECRET: PORTAL }), /CAPABILITY_SECRET is not set/);
  });

  it("throws when PORTAL_IDENTITY_SECRET is absent", () => {
    assert.throws(() => load({ CAPABILITY_SECRET: CAP }), /PORTAL_IDENTITY_SECRET is not set/);
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

  it("requires the split secrets whenever source signing is on, not only under enforcement", () => {
    assert.throws(() => loadConfig({ CORE_SIGNING_SECRET: SOURCE }), /CAPABILITY_SECRET is not set/);
    assert.ok(loadConfig({}));
  });
});
