import "../support/auto-fake-sprites.ts";

import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderKeychainManifest, KeychainError, type Keychain } from "../../src/credentials/keychain.ts";
import { createKeychain } from "../../src/credentials/create-keychain.ts";
import { scopeId } from "../../src/types.ts";
import { materializeGrant } from "../support/materialize-grant.ts";
import { testAdvisoryLock, testDatabaseUrl } from "../support/test-database.ts";
import { KEY, kc, GH } from "../support/keychain-store.ts";
import { createKeychainStore } from "../../src/credentials/keychain-store.ts";

test("save → list returns metadata only (no secret material), and re-save upserts the same slot", async () => {
  const k = kc();
  const meta = await k.save(GH);
  assert.equal(meta.envKey, "GITHUB_TOKEN");
  assert.ok(!("secretEnc" in meta), "metadata view must not carry the encrypted secret");
  assert.ok(!JSON.stringify(meta).includes("ghp_secret"));

  const again = await k.save({ ...GH, secret: "ghp_rotated" });
  assert.equal(again.id, meta.id, "same owner+service+envKey is one record");
  assert.notEqual(again.fingerprint, meta.fingerprint, "rotation changes the fingerprint");
  assert.equal((await k.listByOwner("U1")).length, 1);
  assert.deepEqual(await k.listByOwner("U9"), []);
});

test("listAllMetadata returns person-facing metadata only", async () => {
  const k = kc();
  const meta = await k.save(GH);
  await k.setConnectorToken("github.com", "U1", { accessToken: "gho_managed" });
  await k.setServiceCredential(scopeId("org", "default-org"), {
    slug: "serp",
    name: "SERP",
    secret: "s3",
    host: "api.serper.dev",
  });

  const all = await k.listAllMetadata();
  assert.deepEqual(
    all.map((c) => c.id),
    [meta.id],
  );
  assert.ok(!JSON.stringify(all).includes("ghp_secret"));
  assert.ok(!JSON.stringify(all).includes("gho_managed"));
  assert.ok(!JSON.stringify(all).includes("s3"));
});

test("listing and per-owner reads match owners across email casing and never return secret material", async () => {
  const k = kc();
  const org = scopeId("org", "default-org");
  await k.save({ ...GH, ownerId: "Alice@X.com" });
  await k.save(GH);
  await k.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "ya29.u1" });
  await k.setServiceCredential(org, { slug: "stripe", name: "Stripe", secret: "sk_live", host: "api.stripe.com" });

  const mine = await k.listByOwner("alice@x.COM");
  assert.equal(mine.length, 1, "owner matching stays samePerson-compatible across email casing");
  assert.ok(mine.every((c) => !("secretEnc" in c)));

  const all = await k.listAllMetadata();
  assert.deepEqual(all.map((c) => c.ownerId).sort(), ["Alice@X.com", "U1"]);
  assert.ok(all.every((c) => !("secretEnc" in c)));

  const grouped = await k.listByOwners(["ALICE@x.com", "U1"]);
  assert.equal(grouped.get("ALICE@x.com")!.length, 1);
  assert.equal(grouped.get("U1")!.length, 1);

  const connectors = await k.listConnectorsByOwners(["U1"]);
  assert.equal(connectors.get("U1")!.length, 1);

  const services = await k.listServiceCredentials(org);
  assert.equal(services.length, 1);
  assert.equal(services[0]!.hasSecret, true, "hasSecret still sees the stored secret");

  const own = await k.materializeOwn("U1");
  assert.deepEqual(
    own.flatMap((m) => m.env),
    [{ key: "GITHUB_TOKEN", value: "ghp_secret" }],
  );
  await k.materializeOwnFiles("U1");
});

test("envKey defaults from the service name (github → GITHUB_TOKEN)", async () => {
  const k = kc();
  const meta = await k.save({ ownerId: "U1", service: "GitHub", secret: "x" });
  assert.equal(meta.envKey, "GITHUB_TOKEN");
  assert.equal(meta.service, "github");
});

test("only the owner can grant; materialize is scope-checked; once-grants are consumed", async () => {
  const k = kc();
  const cred = await k.save(GH);

  await assert.rejects(
    k.createGrant({
      credentialId: cred.id,
      ownerId: "U2",
      audienceScopeId: "channel:C1",
      mode: "once",
      purpose: "go ahead",
    }),
    (e: KeychainError) => e.status === 403,
    "a non-owner actor must not be able to mint a grant",
  );

  const grant = await k.createGrant({
    credentialId: cred.id,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "once",
    purpose: "use my gh to clone the repo",
  });

  await assert.rejects(
    materializeGrant(k, grant.id, "channel:OTHER", "U2"),
    (e: KeychainError) => e.status === 403,
    "grant is audience-bound",
  );

  const m = await materializeGrant(k, grant.id, "channel:C1", "U2");
  assert.equal(m.kind, "env");
  assert.ok(
    m.kind === "env" && m.env.length === 1 && m.env[0]!.value === "ghp_secret" && m.env[0]!.key === "GITHUB_TOKEN",
  );
  assert.equal(m.purpose, "use my gh to clone the repo");

  await assert.rejects(
    materializeGrant(k, grant.id, "channel:C1", "U2"),
    (e: KeychainError) => e.status === 410,
    "a once-grant is single-use",
  );
});

test("concurrent materialization consumes a once grant exactly once", async () => {
  const k = kc();
  const cred = await k.save(GH);
  const grant = await k.createGrant({
    credentialId: cred.id,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "once",
    purpose: "single use",
  });
  const results = await Promise.allSettled([
    materializeGrant(k, grant.id, "channel:C1", "U2"),
    materializeGrant(k, grant.id, "channel:C1", "U2"),
    materializeGrant(k, grant.id, "channel:C1", "U3"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" && result.reason instanceof KeychainError && result.reason.status === 410,
    ).length,
    2,
  );
});

test("legacy retry grants remain consumed and invalidate prepared uses", async () => {
  const store = createKeychainStore(testDatabaseUrl());
  const k = createKeychain({ lock: testAdvisoryLock(), store, key: KEY });
  const credential = await k.save(GH);
  const grant = await k.createGrant({
    credentialId: credential.id,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "once",
    purpose: "one use",
  });
  const prepared = await k.prepareMaterialize(grant.id, "channel:C1", "U2");
  await store.grants.put(grant.id, { ...grant, status: "active", usedAt: Date.now(), usedBy: "U2" });
  assert.equal((await k.grantsForScope("channel:C1")).length, 0);
  for (const actor of ["U2", "U3"])
    await assert.rejects(materializeGrant(k, grant.id, "channel:C1", actor), (e: KeychainError) => e.status === 410);
  await assert.rejects(prepared.commit(), (e: KeychainError) => e.status === 410);
});

test("materializeOwnById: the owner's own credential needs no grant — scope, ownership, expiry, and connectors enforced", async () => {
  const k = kc();
  const cred = await k.save(GH);
  const own = await k.materializeOwnById("U1", cred.id, "personal:U1");
  assert.ok(own.kind === "env" && own.env[0]!.value === "ghp_secret");
  assert.equal(own.grantId, undefined, "own use carries no grant");

  await assert.rejects(
    k.materializeOwnById("U1", cred.id, "channel:C1"),
    (e: KeychainError) => e.status === 403,
    "own use never crosses into a shared scope",
  );
  await assert.rejects(
    k.materializeOwnById("U2", cred.id, "personal:U2"),
    (e: KeychainError) => e.status === 404,
    "someone else's credential id reads as unknown",
  );

  const stale = await k.save({
    ownerId: "U1",
    service: "npm",
    secret: "npm_x",
    envKey: "NPM_TOKEN",
    expiresAt: Date.now() - 1,
  });
  await assert.rejects(
    k.materializeOwnById("U1", stale.id, "personal:U1"),
    (e: KeychainError) => e.status === 410,
    "an expired credential does not materialize",
  );

  await k.setConnectorToken("gmail.googleapis.com", "U1", {
    accessToken: "ya29.own",
    expiresAt: Date.now() + 3_600_000,
  });
  const cid = (await k.listConnectorsByOwners(["U1"])).get("U1")![0]!.credentialId;
  const conn = await k.materializeOwnById("U1", cid, "personal:U1");
  assert.ok(conn.kind === "connector" && conn.host === "gmail.googleapis.com" && conn.ownerId === "U1");
});

test("a grant row pointing at a broker credential cannot materialize (defense in depth)", async () => {
  const store = createKeychainStore(testDatabaseUrl());
  const k = createKeychain({ lock: testAdvisoryLock(), store, key: KEY });
  const ORG = scopeId("org", "default-org");
  await k.setServiceCredential(ORG, { slug: "serp", name: "SERP", secret: "s3", host: "api.serper.dev" });
  const broker = (await store.creds.all()).find((c) => c.kind === "broker")!;
  await store.grants.put("g-broker", {
    id: "g-broker",
    credentialId: broker.id,
    ownerId: ORG,
    audienceScopeId: scopeId("channel", "C1"),
    mode: "once",
    purpose: "x",
    status: "active",
    createdAt: Date.now(),
  });
  await assert.rejects(
    materializeGrant(k, "g-broker", scopeId("channel", "C1"), "U2"),
    (e: KeychainError) => e.status === 403,
  );
  await assert.rejects(
    k.materializeOwnById(ORG, broker.id, `personal:${ORG}`),
    (e: KeychainError) => e.status === 403,
    "own-use refuses broker records too",
  );
});

describe("connectors are grantable like any keychain record", () => {
  const GMAIL = "gmail.googleapis.com";
  const G1 = scopeId("group", "G1");
  function kcWithRefresh(freshToken: string): Keychain {
    return createKeychain({
      lock: testAdvisoryLock(),
      store: createKeychainStore(testDatabaseUrl()),
      key: KEY,
      refreshConnector: async () => ({ accessToken: freshToken, expiresAt: Date.now() + 3_600_000 }),
    });
  }
  const cidOf = async (k: Keychain, owner: string, host = GMAIL) =>
    (await k.listConnectorsByOwners([owner])).get(owner)!.find((c) => c.host === host)!.credentialId;

  it("listConnectorsByOwners returns metadata only (never the token), grouped by requested owner", async () => {
    const k = kc();
    await k.setConnectorToken(GMAIL, "alex@x", { accessToken: "ya29.alex", expiresAt: Date.now() + 3_600_000 });
    await k.setConnectorToken("slack.com", "alex@x", { accessToken: "xoxp.alex" });
    await k.setConnectorToken(GMAIL, "carol@x", { accessToken: "ya29.carol", expiresAt: Date.now() + 3_600_000 });
    const map = await k.listConnectorsByOwners(["alex@x"]);
    assert.equal(map.has("carol@x"), false, "only the owners asked for");
    const alex = map.get("alex@x")!;
    assert.equal(alex.length, 2);
    assert.equal(alex.find((c) => c.host === GMAIL)!.connected, true);
    assert.equal(JSON.stringify(alex).includes("ya29"), false, "no access token in discovery metadata");
    assert.equal(
      (await k.listByOwners(["alex@x"])).get("alex@x"),
      undefined,
      "connectors stay out of the regular keychain listing",
    );
  });

  it("only the owner can grant a connector; materialize hands back the token under the host env var; once is consumed", async () => {
    const k = kc();
    await k.setConnectorToken(GMAIL, "alex@x", { accessToken: "ya29.alex", expiresAt: Date.now() + 3_600_000 });
    const cid = await cidOf(k, "alex@x");
    await assert.rejects(
      k.createGrant({ credentialId: cid, ownerId: "carol@x", audienceScopeId: G1, mode: "once", purpose: "x" }),
      (e: KeychainError) => e.status === 403,
      "a non-owner cannot grant Alex's connector",
    );
    const grant = await k.createGrant({
      credentialId: cid,
      ownerId: "alex@x",
      audienceScopeId: G1,
      mode: "once",
      purpose: "check my signature emails",
    });
    const m = await materializeGrant(k, grant.id, G1, "carol@x");
    assert.equal(m.kind, "connector");
    assert.deepEqual(m.kind === "connector" ? [m.host, m.ownerId, m.grantId] : null, [GMAIL, "alex@x", grant.id]);
    assert.ok(!JSON.stringify(m).includes("ya29.alex"), "the token itself never leaves the keychain");
    await assert.rejects(materializeGrant(k, grant.id, G1, "carol@x"), (e: KeychainError) => e.status === 410);
  });

  it("an expired connector token is refreshed on materialize; with no refresh it 410s for reconnect", async () => {
    const past = Date.now() - 10_000;
    const k = kcWithRefresh("ya29.fresh");
    await k.setConnectorToken(GMAIL, "alex@x", { accessToken: "ya29.stale", refreshToken: "rt", expiresAt: past });
    const cid = await cidOf(k, "alex@x");
    const grant = await k.createGrant({
      credentialId: cid,
      ownerId: "alex@x",
      audienceScopeId: G1,
      mode: "standing",
      purpose: "p",
    });
    const m = await materializeGrant(k, grant.id, G1, "carol@x");
    assert.equal(m.kind, "connector");
    assert.equal(await k.connectorAccessToken(GMAIL, "alex@x"), "ya29.fresh");

    const k2 = kc();
    await k2.setConnectorToken(GMAIL, "bob@x", { accessToken: "ya29.stale", expiresAt: past });
    assert.equal((await k2.listConnectorsByOwners(["bob@x"])).get("bob@x")![0]!.needsReconnect, true);
    const g2 = await k2.createGrant({
      credentialId: await cidOf(k2, "bob@x"),
      ownerId: "bob@x",
      audienceScopeId: G1,
      mode: "once",
      purpose: "p",
    });
    await assert.rejects(materializeGrant(k2, g2.id, G1, "carol@x"), (e: KeychainError) => e.status === 410);
  });

  it("a still-valid token within the refresh margin is refreshed; one with ample life is reused", async () => {
    const k = kcWithRefresh("ya29.fresh");
    await k.setConnectorToken(GMAIL, "alex@x", {
      accessToken: "ya29.aging",
      refreshToken: "rt",
      expiresAt: Date.now() + 5 * 60_000,
    });
    const g = await k.createGrant({
      credentialId: await cidOf(k, "alex@x"),
      ownerId: "alex@x",
      audienceScopeId: G1,
      mode: "standing",
      purpose: "p",
    });
    await materializeGrant(k, g.id, G1, "member@example.com");
    assert.equal(await k.connectorAccessToken(GMAIL, "alex@x"), "ya29.fresh");

    const k2 = kcWithRefresh("ya29.fresh");
    await k2.setConnectorToken(GMAIL, "bob@x", {
      accessToken: "ya29.plenty",
      refreshToken: "rt",
      expiresAt: Date.now() + 30 * 60_000,
    });
    const g2 = await k2.createGrant({
      credentialId: await cidOf(k2, "bob@x"),
      ownerId: "bob@x",
      audienceScopeId: G1,
      mode: "standing",
      purpose: "p",
    });
    await materializeGrant(k2, g2.id, G1, "member@example.com");
    assert.equal(await k2.connectorAccessToken(GMAIL, "bob@x"), "ya29.plenty");
  });

  it("the manifest does not advertise an unavailable participant connector", async () => {
    const k = kc();
    await k.setConnectorToken(GMAIL, "alex@x", { accessToken: "ya29.alex", expiresAt: Date.now() + 3_600_000 });
    const connectorsByOwner = await k.listConnectorsByOwners(["alex@x"]);
    const md = renderKeychainManifest({
      scopeId: G1,
      conversationKind: "group",
      actorId: "carol@x",
      members: [{ id: "alex@x", displayName: "Alex" }, { id: "carol@x" }],
      entriesByOwner: new Map(),
      connectorsByOwner,
      scopeGrants: [],
    });
    assert.match(md, /No credentials available/);
    assert.doesNotMatch(md, /gmail\.googleapis\.com|credential id|no grant for this conversation/);
  });
});

test("standing grants are reusable, revocable, and die with the credential", async () => {
  const k = kc();
  const cred = await k.save(GH);
  const grant = await k.createGrant({
    credentialId: cred.id,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "standing",
    purpose: "gh in this channel for qm PRs",
  });

  assert.equal((await k.grantsForScope("channel:C1")).length, 1);
  assert.equal((await k.grantsForScope("channel:C2")).length, 0);
  await materializeGrant(k, grant.id, "channel:C1", "U2");
  await materializeGrant(k, grant.id, "channel:C1", "U3");

  assert.equal(await k.revokeGrant("U2", grant.id), false, "only the owner can revoke");
  assert.equal(await k.revokeGrant("U1", grant.id), true);
  assert.equal((await k.grantsForScope("channel:C1")).length, 0);
  await assert.rejects(materializeGrant(k, grant.id, "channel:C1", "U2"), (e: KeychainError) => e.status === 410);

  const grant2 = await k.createGrant({
    credentialId: cred.id,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "standing",
    purpose: "again",
  });
  await k.remove("U1", cred.id);
  assert.equal(
    (await k.listGrants({ ownerId: "U1" })).find((g) => g.id === grant2.id)?.status,
    "revoked",
    "deleting a credential revokes its grants",
  );
});
