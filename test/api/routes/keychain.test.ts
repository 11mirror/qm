import "../../support/auto-fake-sprites.ts";

import { it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { type BuiltApp } from "../../../src/wiring.ts";
import { buildApp } from "../../support/build-app.ts";
import { createServer } from "../../../src/api/server.ts";
import { credentialHandle, KeychainError } from "../../../src/credentials/keychain.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, type CapabilityClaims } from "../../../src/auth/capability-token.ts";
import { scopeId } from "../../../src/types.ts";
import { testConfig } from "../../support/test-config.ts";
import { testDatabaseUrl } from "../../support/test-database.ts";
import { createPostgresReplayDedupe } from "../../../src/auth/replay-dedupe.ts";

const SECRET = "keychain-route-secret".repeat(3);

let server: Server;
let base: string;
let built: BuiltApp;

const capFor = async (actorId: string, scope = scopeId("personal", actorId), extra: Partial<CapabilityClaims> = {}) =>
  await mintCapabilityToken({ actorId, scopeId: scope, exp: Date.now() + CAPABILITY_TTL_MS, ...extra }, SECRET);

before(async () => {
  built = buildApp(testConfig({ signingSecret: SECRET }));
  await built.directory.replaceChannels(
    [
      { channelId: "C_SECONDS", name: "seconds", isPrivate: false },
      { channelId: "C_BAD_EXP", name: "bad-exp", isPrivate: false },
      { channelId: "C7", name: "grants", isPrivate: false },
      { channelId: "C_OVERVIEW", name: "overview", isPrivate: false },
      { channelId: "C_NAMED", name: "pilot-portal", isPrivate: false },
      { channelId: "C_MYSTERY", name: "", isPrivate: false },
      { channelId: "C8", name: "file-grants", isPrivate: false },
    ],
    [
      { channelId: "C_SECONDS", principalId: "U_SECONDS" },
      { channelId: "C_BAD_EXP", principalId: "U_BAD_EXP" },
      { channelId: "C7", principalId: "OWNER" },
      { channelId: "C7", principalId: "U3" },
      { channelId: "C_OVERVIEW", principalId: "OVERVIEW_OWNER" },
      { channelId: "C_NAMED", principalId: "SCOPENAME_OWNER" },
      { channelId: "C_MYSTERY", principalId: "SCOPENAME_OWNER" },
      { channelId: "C8", principalId: "OWNER" },
      { channelId: "C8", principalId: "U3" },
    ],
  );
  await built.directory.replaceGroups([
    { groupId: "G_CONN", principalId: "alex@conn" },
    { groupId: "G_CONN", principalId: "carol@conn" },
  ]);
  server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
    keychain: built.keychain,
    workspace: built.workspace,
    auditLog: built.auditLog,
    credentialUsage: built.credentialUsage,
    sessions: built.sessions,
    runs: built.runs,
    signals: built.signals,
    identity: built.identity,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = (path: string, body: unknown, cap: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-capability": cap },
    body: JSON.stringify(body),
  });
const get = (path: string, cap: string) => fetch(`${base}${path}`, { headers: { "x-agent-capability": cap } });
const grantHere = (
  credentialId: string,
  ownerId: string,
  audienceScopeId: CapabilityClaims["scopeId"],
  mode: "once" | "standing",
  purpose: string,
) => built.keychain!.createGrant({ credentialId, ownerId, audienceScopeId, mode, purpose });

it("saves to the TOKEN's actor and lists only the caller's own credentials", async () => {
  const res = await post(
    "/v1/keychain/credentials",
    { service: "github", secret: "ghp_u1", envKey: "GITHUB_TOKEN", accountLabel: "AliceBell" },
    await capFor("U1"),
  );
  assert.equal(res.status, 200);
  const { credential } = (await res.json()) as any;
  assert.equal(credential.ownerId, "U1");
  assert.equal(credential.credentialHandle, credentialHandle(credential));
  assert.ok(!JSON.stringify(credential).includes("ghp_u1"));

  const mine = (await (await get("/v1/keychain/credentials", await capFor("U1"))).json()) as any;
  assert.equal(mine.credentials.length, 1);
  assert.equal(mine.credentials[0].credentialHandle, credential.credentialHandle);
  assert.ok(!JSON.stringify(mine).includes("ghp_u1"));
  const other = (await (await get("/v1/keychain/credentials", await capFor("U2"))).json()) as any;
  assert.deepEqual(other.credentials, []);
});

it("env grants expose the credential's execution handle; committing a once grant consumes it", async () => {
  const owner = "HANDLE_OWNER";
  const cap = await capFor(owner, scopeId("personal", owner), { liveActor: true });
  const saved = (await (
    await post(
      "/v1/keychain/credentials",
      { service: "handle-test", envKey: "HANDLE_TOKEN", secret: "synthetic-handle-secret" },
      cap,
    )
  ).json()) as any;
  const metadata = (await (await get("/v1/keychain/credentials", cap)).json()) as any;
  assert.equal(saved.credential.credentialHandle, metadata.credentials[0].credentialHandle);
  assert.ok(!JSON.stringify([saved, metadata]).includes("synthetic-handle-secret"));
  const grant = await grantHere(saved.credential.id, owner, scopeId("personal", owner), "once", "use the handle");
  const current = (await built.keychain!.grantsForScope(scopeId("personal", owner))).find(
    ({ grant: g }) => g.id === grant.id,
  );
  assert.equal(current?.credential.credentialHandle, saved.credential.credentialHandle);
  const prepared = await built.keychain!.prepareMaterialize(grant.id, scopeId("personal", owner), owner);
  assert.equal(prepared.materialized.kind, "env");
  await prepared.commit();
  const claimed = (await built.keychain!.getGrant(grant.id))!;
  assert.equal(claimed.status, "used");
  assert.ok(claimed.usedAt !== undefined);
  await assert.rejects(prepared.commit(), (e: KeychainError) => e.status === 410);
});

it("a participant's granted connector materializes as a broker reference, never the token", async () => {
  const GROUP = scopeId("group", "G_CONN");
  await built.keychain!.setConnectorToken("gmail.googleapis.com", "alex@conn", {
    accessToken: "ya29.alex",
    expiresAt: Date.now() + 3_600_000,
  });
  const cid = (await built.keychain!.listConnectorsByOwners(["alex@conn"])).get("alex@conn")![0]!.credentialId;

  const grant = await grantHere(cid, "alex@conn", GROUP, "once", "check my signature emails");
  assert.equal((await built.keychain!.getGrant(grant.id))?.status, "active");
  const prepared = await built.keychain!.prepareMaterialize(grant.id, GROUP, "carol@conn");
  assert.equal(prepared.materialized.kind, "connector");
  assert.ok(!JSON.stringify(prepared.materialized).includes("ya29.alex"));
});

it("normalizes keychain credential expiry seconds to milliseconds before storing", async () => {
  const expiresAt = Math.floor((Date.now() + 3_600_000) / 1000);
  const res = await post(
    "/v1/keychain/credentials",
    { service: "npm-seconds", secret: "npm_seconds", envKey: "NPM_SECONDS", expiresAt },
    await capFor("U_SECONDS"),
  );
  assert.equal(res.status, 200);
  const { credential } = (await res.json()) as any;
  assert.equal(credential.expiresAt, expiresAt * 1000);

  const grant = await grantHere(credential.id, "U_SECONDS", "channel:C_SECONDS", "once", "seconds check");
  await built.keychain!.prepareMaterialize(grant.id, "channel:C_SECONDS", "U_SECONDS");
});

it("rejects invalid keychain credential expiry at the route boundary", async () => {
  const badCred = await post(
    "/v1/keychain/credentials",
    { service: "bad-exp", secret: "x", expiresAt: "not-a-date" },
    await capFor("U_BAD_EXP"),
  );
  assert.equal(badCred.status, 400);
});

it("saves a multi-field login via fields[], and rejects a malformed fields[] rather than storing a partial one", async () => {
  const ok = await post(
    "/v1/keychain/credentials",
    {
      service: "doordash",
      fields: [
        { envKey: "DOORDASH_EMAIL", value: "r@acme.co", secret: false },
        { envKey: "DOORDASH_PASSWORD", value: "pw" },
      ],
    },
    await capFor("U_FIELDS"),
  );
  assert.equal(ok.status, 200);
  const { credential } = (await ok.json()) as any;
  assert.deepEqual(credential.fields, [
    { envKey: "DOORDASH_EMAIL", secret: false },
    { envKey: "DOORDASH_PASSWORD", secret: true },
  ]);

  const bad = await post(
    "/v1/keychain/credentials",
    { service: "x", fields: [{ envKey: "OK", value: "v" }, { envKey: "NOPE" }] },
    await capFor("U_FIELDS"),
  );
  assert.equal(bad.status, 400, "a malformed field rejects the whole request");
});

it("rejects keychain calls without a capability token (no source-auth fallback identity)", async () => {
  const res = await fetch(`${base}/v1/keychain/credentials`, { method: "GET" });
  assert.notEqual(res.status, 200);
});

it("one-time grants materialize only in their scope, once", async () => {
  const credential = await built.keychain!.save({
    ownerId: "OWNER",
    service: "github",
    secret: "ghp_grant",
    envKey: "GH_GRANT",
  });
  const grant = await grantHere(credential.id, "OWNER", "channel:C7", "once", "clone the repo");
  await assert.rejects(
    built.keychain!.prepareMaterialize(grant.id, "channel:OTHER", "U3"),
    (e: KeychainError) => e.status === 403,
  );
  const prepared = await built.keychain!.prepareMaterialize(grant.id, "channel:C7", "U3");
  await prepared.commit();
  await assert.rejects(
    built.keychain!.prepareMaterialize(grant.id, "channel:C7", "U3"),
    (e: KeychainError) => e.status === 410,
  );
});

it("overview returns metadata and grants without querying usage history or exposing secrets", async (t) => {
  const owner = "OVERVIEW_OWNER";
  const { credential } = (await (
    await post(
      "/v1/keychain/credentials",
      { service: "overview", secret: "never-return-this", envKey: "OVERVIEW_TOKEN" },
      await capFor(owner),
    )
  ).json()) as any;
  await grantHere(credential.id, owner, "channel:C_OVERVIEW", "standing", "deploy the reporting app");

  const usage = t.mock.method(built.credentialUsage, "list", async () => {
    throw new Error("usage history is unavailable");
  });

  const overview = await get("/v1/keychain/overview", await capFor(owner));
  assert.equal(overview.status, 200);
  const body = (await overview.json()) as any;
  assert.equal(body.credentials[0].id, credential.id);
  assert.equal(body.grants[0].purpose, "deploy the reporting app");
  assert.equal(usage.mock.callCount(), 0);
  assert.ok(!Object.hasOwn(body, "usage"));
  assert.ok(!JSON.stringify(body).includes("never-return-this"));
});

it("overview resolves grant scope ids to human-readable names when known", async () => {
  const owner = "SCOPENAME_OWNER";
  const { credential } = (await (
    await post(
      "/v1/keychain/credentials",
      { service: "scopenames", secret: "shh", envKey: "SCOPENAME_TOKEN" },
      await capFor(owner),
    )
  ).json()) as any;
  await built.sessions.getOrCreateByThread("slack:C_NAMED:1", "channel", "channel:C_NAMED", "pilot-portal");
  await grantHere(credential.id, owner, "channel:C_NAMED", "standing", "named channel work");
  await grantHere(credential.id, owner, "channel:C_MYSTERY", "standing", "unnamed channel work");
  const body = (await (await get("/v1/keychain/overview", await capFor(owner))).json()) as any;
  assert.equal(body.scopeNames["channel:C_NAMED"], "#pilot-portal");
  assert.equal(body.scopeNames["channel:C_MYSTERY"], undefined);
});

it("overview includes safe connector metadata so its grants remain visible and revocable", async () => {
  const owner = "CONNECTOR_OVERVIEW_OWNER";
  await built.keychain!.setConnectorToken("gmail.googleapis.com", owner, {
    accessToken: "never-return-this-connector",
  });
  const connector = (await built.keychain!.listConnectorsByOwners([owner])).get(owner)![0]!;
  const grant = await built.keychain!.createGrant({
    credentialId: connector.credentialId,
    ownerId: owner,
    audienceScopeId: "channel:C_CONNECTOR_OVERVIEW",
    mode: "standing",
    purpose: "read mail here",
  });

  const overview = await get("/v1/keychain/overview", await capFor(owner));
  assert.equal(overview.status, 200);
  const body = (await overview.json()) as any;
  assert.equal(body.connectorCredentials[0].credentialId, connector.credentialId);
  assert.equal(body.grants.find((entry: any) => entry.id === grant!.id)?.status, "active");
  assert.ok(!JSON.stringify(body).includes("never-return-this-connector"));
});

it("named credential asks resolve only current conversation members and return safe ambiguity candidates", async () => {
  await built.directory.replace([
    { principalId: "OWNER", displayName: "Alice", type: "internal" },
    { principalId: "U3", displayName: "Bob", type: "internal" },
    { principalId: "OUTSIDE", displayName: "Outsider", type: "guest" },
  ]);
  const deploy = await built.keychain!.save({
    ownerId: "OWNER",
    service: "named-deploy",
    secret: "named-secret",
    envKey: "NAMED_DEPLOY",
  });
  for (const accountLabel of ["home", "work"])
    await built.keychain!.save({
      ownerId: "OWNER",
      service: "named-twin",
      accountLabel,
      secret: "twin-secret",
      envKey: `TWIN_${accountLabel.toUpperCase()}`,
    });
  const cap = await capFor("U3", "channel:C7", {
    threadRef: "slack:C7:named",
    destination: { type: "slack", target: "C7", audienceScopeId: "channel:C7" },
  });
  const ask = (body: Record<string, string>) => post("/v1/keychain/asks", { purpose: "run the deploy", ...body }, cap);
  const outsider = await post(
    "/v1/keychain/asks",
    { owner: "Alice", service: "unknown-service", purpose: "not a participant" },
    await capFor("OUTSIDE", "channel:C7"),
  );
  assert.equal(outsider.status, 403);
  assert.ok(!(await outsider.text()).includes("named-deploy"));
  const resolved = await ask({ owner: "Alice", service: "Named-Deploy" });
  assert.equal(resolved.status, 200, await resolved.clone().text());
  assert.equal(((await resolved.json()) as { ask: { credentialId: string } }).ask.credentialId, deploy.id);
  const ambiguous = await ask({ owner: "OWNER", service: "named-twin" });
  assert.equal(ambiguous.status, 409);
  const body = (await ambiguous.json()) as { candidates: { credential: string; account: string }[] };
  assert.deepEqual(body.candidates.map((c) => c.account).sort(), ["home", "work"]);
  assert.ok(!JSON.stringify(body).includes("twin-secret"));
  assert.equal((await ask({ credential: body.candidates[0]!.credential })).status, 200);
  assert.equal((await ask({ owner: "Outsider", service: "named-deploy" })).status, 404);
});
