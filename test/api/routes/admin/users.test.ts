import "../../../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createInsecureTestServer } from "../../../../src/api/server.ts";
import { deriveConnectorKey } from "../../../../src/connectors/connector-client-store.ts";
import { createKeychain } from "../../../../src/credentials/keychain.ts";
import { scopeId, type TurnRequest } from "../../../../src/types.ts";
import { buildApp } from "../../../support/build-app.ts";
import { testConfig } from "../../../support/test-config.ts";
import { testAdminGrantStore, testAdvisoryLock, testMap } from "../../../support/test-database.ts";

function start() {
  const built = buildApp(testConfig());
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ALICE = "admin-alice@default-org";
const BOB = "admin-bob@default-org";
const NOBODY = "user-uma@default-org";

const post = (base: string, actor: string, body: unknown) =>
  fetch(`${base}/v1/admin/grants`, {
    method: "POST",
    headers: { "x-admin-actor": actor, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const del = (base: string, actor: string, principalId: string, scope: string, role: string) =>
  fetch(
    `${base}/v1/admin/grants/${encodeURIComponent(principalId)}?scope=${encodeURIComponent(scope)}&role=${encodeURIComponent(role)}`,
    { method: "DELETE", headers: { "x-admin-actor": actor } },
  );
const whoami = async (base: string, actor: string): Promise<any> =>
  (await fetch(`${base}/v1/admin/whoami`, { headers: { "x-admin-actor": actor } })).json();

test("an org admin promotes a user to org_admin; whoami reflects it; audited", async () => {
  const s = start();
  try {
    const r = await post(s.base, ALICE, { principalId: "U1", role: "org_admin", scopeId: "org:default-org" });
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.grant.grantedBy, "admin-alice");
    assert.deepEqual(await whoami(s.base, "U1@default-org"), {
      isAdmin: true,
      role: "org_admin",
      scopeId: "org:default-org",
      permissions: ["admin"],
    });
    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "grant.create" && e.resource === "U1/org_admin"),
    );
  } finally {
    await s.close();
  }
});

test("a team_admin grant is rejected (400) — the role is unsupported / not wired to data", async () => {
  const s = start();
  try {
    const r = await post(s.base, ALICE, { principalId: "U2", role: "team_admin", scopeId: "team:team-eng" });
    assert.equal(r.status, 400);
    assert.deepEqual(await whoami(s.base, "U2@default-org"), { isAdmin: false, permissions: [] });
  } finally {
    await s.close();
  }
});

test("a non-admin cannot grant (403) — grant mutation is org_admin only", async () => {
  const s = start();
  try {
    const r = await post(s.base, NOBODY, { principalId: "U3", role: "org_admin", scopeId: "org:default-org" });
    assert.equal(r.status, 403);
    assert.deepEqual(await whoami(s.base, "U3@default-org"), { isAdmin: false, permissions: [] });
    assert.equal(
      (await post(s.base, "U-nobody@default-org", { principalId: "U4", role: "org_admin", scopeId: "org:default-org" }))
        .status,
      403,
    );
  } finally {
    await s.close();
  }
});

test("malformed grants are rejected (400): bad role, removed role, scope mismatch, missing principal", async () => {
  const s = start();
  try {
    assert.equal(
      (await post(s.base, ALICE, { principalId: "U5", role: "superuser", scopeId: "org:default-org" })).status,
      400,
    );
    assert.equal(
      (await post(s.base, ALICE, { principalId: "U6", role: "org_admin", scopeId: "team:team-eng" })).status,
      400,
    );
    assert.equal(
      (await post(s.base, ALICE, { principalId: "U7", role: "team_admin", scopeId: "org:default-org" })).status,
      400,
    );
    assert.equal(
      (await post(s.base, ALICE, { principalId: "", role: "org_admin", scopeId: "org:default-org" })).status,
      400,
    );
  } finally {
    await s.close();
  }
});

test("revoke flips a promoted user back to non-admin; audited", async () => {
  const s = start();
  try {
    await post(s.base, ALICE, { principalId: "U1", role: "org_admin", scopeId: "org:default-org" });
    const r = await del(s.base, ALICE, "U1", "org:default-org", "org_admin");
    assert.equal(r.status, 200);
    assert.deepEqual(await whoami(s.base, "U1@default-org"), { isAdmin: false, permissions: [] });
    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "grant.revoke" && e.resource === "U1/org_admin"),
    );
  } finally {
    await s.close();
  }
});

test("a cased stored grant is revoked by its canonical id (the delete follows the person, not the bytes)", async () => {
  const s = start();
  try {
    await post(s.base, ALICE, { principalId: "Jordan@Acme.test", role: "org_admin", scopeId: "org:default-org" });
    assert.deepEqual(await whoami(s.base, "jordan@acme.test@default-org"), {
      isAdmin: true,
      role: "org_admin",
      scopeId: "org:default-org",
      permissions: ["admin"],
    });
    assert.equal((await del(s.base, ALICE, "jordan@acme.test", "org:default-org", "org_admin")).status, 200);
    assert.deepEqual(
      await whoami(s.base, "Jordan@Acme.test@default-org"),
      { isAdmin: false, permissions: [] },
      "the cased row was actually removed",
    );
  } finally {
    await s.close();
  }
});

test("the last-admin guard counts one person's case-variant grants as ONE admin", async () => {
  const s = start();
  try {
    assert.equal((await del(s.base, ALICE, "admin-bob", "org:default-org", "org_admin")).status, 200);
    await post(s.base, ALICE, { principalId: "Jordan@Acme.test", role: "org_admin", scopeId: "org:default-org" });
    await post(s.base, ALICE, { principalId: "jordan@acme.test", role: "org_admin", scopeId: "org:default-org" });
    assert.equal((await del(s.base, ALICE, "admin-alice", "org:default-org", "org_admin")).status, 200);
    const r = await del(s.base, "jordan@acme.test@default-org", "jordan@acme.test", "org:default-org", "org_admin");
    assert.equal(r.status, 400, "two case-variant rows are still one person — the lock-out guard holds");
    assert.deepEqual(await whoami(s.base, "jordan@acme.test@default-org"), {
      isAdmin: true,
      role: "org_admin",
      scopeId: "org:default-org",
      permissions: ["admin"],
    });
  } finally {
    await s.close();
  }
});

test("canAdminister agrees with adminStatusOf: a cased grant admits the canonical actor", async () => {
  const { createAdminService } = await import("../../../../src/admin/admin-service.ts");
  const svc = createAdminService(testAdminGrantStore());
  await svc.createGrant(
    { id: "admin-alice", type: "internal" },
    { principalId: "Jordan@Acme.test", role: "org_admin", scopeId: "org:default-org" },
  );
  assert.equal(await svc.canAdminister({ id: "jordan@acme.test", type: "internal" }, "org:default-org"), true);
  assert.equal(await svc.canAdminister({ id: "casey@acme.test", type: "internal" }, "org:default-org"), false);
});

test("a non-admin cannot revoke (403)", async () => {
  const s = start();
  try {
    const r = await del(s.base, NOBODY, "admin-bob", "org:default-org", "org_admin");
    assert.equal(r.status, 403);
    assert.deepEqual(await whoami(s.base, BOB), {
      isAdmin: true,
      role: "org_admin",
      scopeId: "org:default-org",
      permissions: ["admin"],
    });
  } finally {
    await s.close();
  }
});

test("the last org admin cannot be revoked (400 lock-out guard)", async () => {
  const s = start();
  try {
    assert.equal((await del(s.base, ALICE, "admin-bob", "org:default-org", "org_admin")).status, 200);
    const r = await del(s.base, ALICE, "admin-alice", "org:default-org", "org_admin");
    assert.equal(r.status, 400);
    assert.deepEqual(await whoami(s.base, ALICE), {
      isAdmin: true,
      role: "org_admin",
      scopeId: "org:default-org",
      permissions: ["admin"],
    });
  } finally {
    await s.close();
  }
});

const startImp = (base: string, actor: string, target: string) =>
  fetch(`${base}/v1/admin/impersonate`, {
    method: "POST",
    headers: { "x-admin-actor": actor, "content-type": "application/json" },
    body: JSON.stringify({ target }),
  });
const stopImp = (base: string, actor: string, target: string) =>
  fetch(`${base}/v1/admin/impersonate/stop`, {
    method: "POST",
    headers: { "x-admin-actor": actor, "content-type": "application/json" },
    body: JSON.stringify({ target }),
  });

test("an org admin can start impersonating a user; audited", async () => {
  const s = start();
  try {
    const r = await startImp(s.base, ALICE, "U-target");
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.target, "U-target");
    assert.ok(
      (await s.built.auditLog.events()).some(
        (e) => e.action === "impersonate.start" && e.resource === "U-target" && e.principalId === "admin-alice",
      ),
      "the start is recorded in the durable audit log",
    );
  } finally {
    await s.close();
  }
});

test("a non-admin cannot impersonate (403) — gated by the live grant store", async () => {
  const s = start();
  try {
    assert.equal((await startImp(s.base, NOBODY, "U-target")).status, 403);
    assert.equal((await stopImp(s.base, NOBODY, "U-target")).status, 403);
  } finally {
    await s.close();
  }
});

test("an admin cannot impersonate themselves (400)", async () => {
  const s = start();
  try {
    assert.equal((await startImp(s.base, ALICE, "admin-alice")).status, 400);
  } finally {
    await s.close();
  }
});

test("an empty target is rejected (400)", async () => {
  const s = start();
  try {
    assert.equal((await startImp(s.base, ALICE, "")).status, 400);
  } finally {
    await s.close();
  }
});

test("stopping impersonation is audited", async () => {
  const s = start();
  try {
    const r = await stopImp(s.base, ALICE, "U-target");
    assert.equal(r.status, 200);
    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "impersonate.stop" && e.resource === "U-target"),
      "the stop is recorded in the durable audit log",
    );
  } finally {
    await s.close();
  }
});

function keychainStart() {
  const built = buildApp(testConfig());
  const keychain = createKeychain({
    lock: testAdvisoryLock(),
    creds: testMap(),
    grants: testMap(),
    asks: testMap(),
    key: deriveConnectorKey("admin-keychain-test-key"),
  });
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    keychain,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, keychain, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("/v1/admin/keychain returns metadata, grants, and asks without secrets; non-admin denied; audited", async () => {
  const s = keychainStart();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:t1" },
      text: "hello",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");

    const cred = await s.keychain.save({
      ownerId: "U1",
      service: "github",
      secret: "ghp_secret",
      envKey: "GITHUB_TOKEN",
      accountLabel: "alice",
    });
    const grant = await s.keychain.createGrant({
      credentialId: cred.id,
      ownerId: "U1",
      audienceScopeId: scopeId("channel", "C1"),
      mode: "standing",
      purpose: "use github for deploys",
    });
    const { ask } = await s.keychain.createAsk({
      credentialId: cred.id,
      requesterId: "U2",
      requesterScopeId: scopeId("channel", "C2"),
      purpose: "need github for CI",
    });

    const r = await fetch(`${s.base}/v1/admin/keychain`, { headers: { "x-admin-actor": "admin-alice@default-org" } });
    assert.equal(r.status, 200);
    const d: any = await r.json();
    assert.equal(d.enabled, true);
    assert.ok(
      d.people.some(
        (p: { principalId: string; credentialCount: number }) => p.principalId === "U1" && p.credentialCount === 1,
      ),
    );
    assert.ok(
      d.people.some((p: { principalId: string }) => p.principalId === "U2"),
      "ask requester appears even without sessions",
    );
    assert.deepEqual(
      d.credentials.map((c: { id: string }) => c.id),
      [cred.id],
    );
    assert.equal(d.grants[0].id, grant.id);
    assert.equal(d.asks[0].id, ask.id);
    assert.ok(!JSON.stringify(d).includes("ghp_secret"), "admin projection must not include secret material");

    const denied = await fetch(`${s.base}/v1/admin/keychain`, { headers: { "x-admin-actor": "user-uma@default-org" } });
    assert.equal(denied.status, 403);
    assert.ok((await s.built.auditLog.events()).some((e) => e.action === "keychain.read"));
  } finally {
    await s.close();
  }
});

test("credentials-page summary avoids unrelated history and exposes counts only", async (t) => {
  const s = keychainStart();
  t.after(s.close);
  const credential = await s.keychain.save({
    ownerId: "U1",
    service: "github",
    secret: "summary-test-secret",
    envKey: "GITHUB_TOKEN",
    accountLabel: "test",
  });
  await s.keychain.createGrant({
    credentialId: credential.id,
    ownerId: "U1",
    audienceScopeId: scopeId("channel", "C1"),
    mode: "standing",
    purpose: "test",
  });
  const fail = () => {
    throw new Error("Summary must not scan unrelated data");
  };
  t.mock.method(s.keychain, "listAsks", fail);
  t.mock.method(s.built.sessions, "distinctParticipants", fail);
  t.mock.method(s.built.app, "directoryMembers", fail);
  const response = await fetch(s.base + "/v1/admin/keychain?summary=1", {
    headers: { "x-admin-actor": "admin-alice@default-org" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { users: 1, standing: 1 });
  const denied = await fetch(s.base + "/v1/admin/keychain?summary=1", {
    headers: { "x-admin-actor": "nobody@default-org" },
  });
  assert.equal(denied.status, 403);
});

test("user keychain reads only the selected owner's metadata and grants", async (t) => {
  const s = keychainStart();
  t.after(s.close);
  const credential = await s.keychain.save({
    ownerId: "alice@example.com",
    service: "github",
    secret: "private-user-secret",
    envKey: "GITHUB_TOKEN",
  });
  await s.keychain.save({
    ownerId: "bob@example.com",
    service: "github",
    secret: "other-user-secret",
    envKey: "GITHUB_TOKEN",
  });
  const grant = await s.keychain.createGrant({
    credentialId: credential.id,
    ownerId: "alice@example.com",
    audienceScopeId: scopeId("channel", "C1"),
    mode: "standing",
    purpose: "test",
  });
  const fail = () => {
    throw new Error("User keychain must not load unrelated org data");
  };
  t.mock.method(s.keychain, "listAllMetadata", fail);
  t.mock.method(s.keychain, "listAsks", fail);
  t.mock.method(s.built.sessions, "distinctParticipants", fail);
  t.mock.method(s.built.app, "directoryMembers", fail);
  const response = await fetch(s.base + "/v1/admin/keychain?principal=Alice%40example.com", {
    headers: { "x-admin-actor": "admin-alice@default-org" },
  });
  assert.equal(response.status, 200);
  const data = (await response.json()) as any;
  assert.deepEqual(
    data.credentials.map((c: { id: string }) => c.id),
    [credential.id],
  );
  assert.deepEqual(
    data.grants.map((g: { id: string }) => g.id),
    [grant.id],
  );
  assert.equal(JSON.stringify(data).includes("private-user-secret"), false);
  assert.equal(JSON.stringify(data).includes("bob@example.com"), false);
  const denied = await fetch(s.base + "/v1/admin/keychain?principal=alice%40example.com", {
    headers: { "x-admin-actor": "nobody@default-org" },
  });
  assert.equal(denied.status, 403);
});
