import "../support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../support/build-app.ts";
import { credentialHandle, renderKeychainManifest, KeychainError } from "../../src/credentials/keychain.ts";
import { createKeychain } from "../../src/credentials/create-keychain.ts";
import { type TurnRequest } from "../../src/types.ts";
import { fakeSprites } from "../support/auto-fake-sprites.ts";
import { testConfig } from "../support/test-config.ts";
import { selectDefaultSandbox } from "../support/default-sandbox.ts";
import { materializeGrant } from "../support/materialize-grant.ts";
import { testAdvisoryLock, testDatabaseUrl } from "../support/test-database.ts";
import { KEY, kc, GH } from "../support/keychain-store.ts";
import { createKeychainStore } from "../../src/credentials/keychain-store.ts";

const SECRET = "keychain-route-secret".repeat(3);

function channelTurn(
  text: string,
  actorId: string,
  audience: Array<{ externalId: string; displayName?: string }>,
): TurnRequest {
  return {
    origin: { kind: "direct" },
    surface: "slack",
    actor: { externalId: actorId },
    conversation: { kind: "channel", threadRef: "ch:C1", channelRef: "C1", audience },
    text,
  } as TurnRequest;
}

function execScriptsMention(needle: string, since = 0): boolean {
  return fakeSprites
    .execScripts()
    .slice(since)
    .some((script) => script.includes(needle));
}

test("turn e2e: prompt lists exact handles and keychain env credentials are never ambient", async () => {
  const built = buildApp(testConfig({ signingSecret: SECRET, apiBaseUrl: "http://core.test" }));
  assert.ok(built.keychain, "buildApp with a signing secret wires the keychain");
  built.keychain.materializeOwn = async () => {
    throw new Error("eager owner materialization is forbidden");
  };
  const resolved: string[] = [];
  const materializeOwnById = built.keychain.materializeOwnById.bind(built.keychain);
  built.keychain.materializeOwnById = async (...args) => {
    resolved.push(args[1]);
    return materializeOwnById(...args);
  };
  const cred = await built.keychain!.save({
    ownerId: "U_OWNER",
    service: "github",
    secret: "ghp_e2e",
    envKey: "GITHUB_TOKEN",
    accountLabel: "AliceBell",
  });

  const audience = [{ externalId: "U_ASKER" }, { externalId: "U_OWNER", displayName: "Alice" }];
  const sys = await built.app.turn(channelTurn("!sysprompt", "U_ASKER", audience));
  assert.equal(sys.status, "ok");
  assert.match(sys.reply ?? "", /## Credentials/);
  assert.match(sys.reply ?? "", /No credentials available/);
  assert.ok(!(sys.reply ?? "").includes(cred.id));
  assert.ok(!(sys.reply ?? "").includes("ghp_e2e"), "prompt never carries the secret");
  await selectDefaultSandbox(built, "U_ASKER", "channel:C1");

  let mark = fakeSprites.execScripts().length;
  assert.equal((await built.app.turn(channelTurn("!run true", "U_ASKER", audience))).status, "ok");
  assert.ok(!execScriptsMention("ghp_e2e", mark), "no grant → no secret in the channel sandbox");

  await built.keychain!.createGrant({
    credentialId: cred.id,
    ownerId: "U_OWNER",
    audienceScopeId: "channel:C1",
    mode: "standing",
    purpose: "use my gh here for repo work",
  });
  const sys2 = await built.app.turn(channelTurn("!sysprompt", "U_ASKER", audience));
  assert.doesNotMatch(sys2.reply ?? "", /STANDING grant|use my gh here for repo work/);
  assert.match(sys2.reply ?? "", new RegExp(`github:${cred.id}`));

  mark = fakeSprites.execScripts().length;
  assert.equal((await built.app.turn(channelTurn("!run true", "U_ASKER", audience))).status, "ok");
  assert.ok(!execScriptsMention("export GITHUB_TOKEN=", mark), "standing grants are not ambient");
  assert.ok(!execScriptsMention("ghp_e2e", mark), "an unrequested command never receives the secret");
  const unchanged = await built.app.turn(channelTurn("!sysprompt", "U_ASKER", audience));
  assert.match(unchanged.reply ?? "", /## Credentials/);
  assert.ok((unchanged.reply ?? "").includes(credentialHandle(cred)));

  await selectDefaultSandbox(built, "U_OWNER", "personal:U_OWNER");
  mark = fakeSprites.execScripts().length;
  const dm: TurnRequest = {
    surface: "test",
    actor: { externalId: "U_OWNER" },
    conversation: { kind: "dm", threadRef: "dm:U_OWNER", audience: [{ externalId: "U_OWNER" }] },
    origin: { kind: "human" },
    text: "!run true",
  } as TurnRequest;
  assert.equal((await built.app.turn(dm)).status, "ok");
  assert.ok(!execScriptsMention("ghp_e2e", mark), "unrequested secrets are never materialized");
  const selected = await built.app.turn({
    ...dm,
    text: `!execute ${JSON.stringify({ command: 'test "$GITHUB_TOKEN" = ghp_e2e && echo selected', credentials: [credentialHandle(cred)] })}`,
  });
  assert.equal(selected.reply, "selected");
  assert.deepEqual(resolved, [cred.id]);
});

test("prepared grants reject credential rotation without consuming a single use", async () => {
  const k = kc();
  const credential = await k.save(GH);
  const grant = await k.createGrant({
    credentialId: credential.id,
    ownerId: GH.ownerId,
    audienceScopeId: "channel:C1",
    mode: "once",
    purpose: "rotation regression",
  });
  const prepared = await k.prepareMaterialize(grant.id, "channel:C1", "U2");
  await k.save({ ...GH, secret: "rotated-execution-token" });
  await assert.rejects(prepared.commit(), /credential changed/);
  assert.equal((await k.getGrant(grant.id))?.status, "active");
  const fresh = await k.prepareMaterialize(grant.id, "channel:C1", "U2");
  assert.equal(fresh.materialized.kind, "env");
  if (fresh.materialized.kind === "env") assert.equal(fresh.materialized.env[0]?.value, "rotated-execution-token");
  await fresh.commit();
  const committed = (await k.getGrant(grant.id))!;
  assert.equal(committed.status, "used");
  assert.equal(committed.usedBy, "U2", "only the committed materialization claims the once grant");
});

test("connector refresh during preparation binds the refreshed version and later rotation invalidates it", async () => {
  let refreshes = 0;
  const k = createKeychain({
    lock: testAdvisoryLock(),
    store: createKeychainStore(testDatabaseUrl()),
    key: KEY,
    refreshConnector: async () => {
      refreshes++;
      return { accessToken: "refreshed-token", expiresAt: Date.now() + 3600000 };
    },
  });
  await k.setConnectorToken("gmail.googleapis.com", "U1", {
    accessToken: "expired-token",
    refreshToken: "refresh",
    expiresAt: Date.now() - 1000,
  });
  const connector = (await k.listConnectorsByOwners(["U1"])).get("U1")![0]!;
  const grant = await k.createGrant({
    credentialId: connector.credentialId,
    ownerId: "U1",
    audienceScopeId: "channel:C1",
    mode: "standing",
    purpose: "refresh regression",
  });
  const prepared = await k.prepareMaterialize(grant.id, "channel:C1", "U2");
  assert.equal(refreshes, 1);
  await prepared.commit();
  await k.setConnectorToken("gmail.googleapis.com", "U1", {
    accessToken: "replacement-token",
    expiresAt: Date.now() + 3600000,
  });
  await assert.rejects(prepared.commit(), /credential changed/);
  await (await k.prepareMaterialize(grant.id, "channel:C1", "U2")).commit();
});

test("Composio keys remain backend-only across all materialization paths including multi-field records", async () => {
  for (const input of [
    { secret: "project-key", envKey: "COMPOSIO_API_KEY" },
    {
      fields: [
        { envKey: "COMPOSIO_API_KEY", value: "project-key" },
        { envKey: "OTHER", value: "other" },
      ],
    },
  ]) {
    const k = kc();
    const c = await k.save({ ownerId: "U1", service: "composio", ...input });
    assert.equal(c.credentialHandle, undefined);
    assert.equal((await k.getCredential(c.id))?.credentialHandle, undefined);
    const grant = await k.createGrant({
      credentialId: c.id,
      ownerId: "U1",
      audienceScopeId: "channel:C1",
      mode: "standing",
      purpose: "apps",
    });
    assert.deepEqual(await k.materializeOwn("U1"), []);
    await assert.rejects(k.materializeOwnById("U1", c.id, "personal:U1"), /keys stay in the backend/);
    await assert.rejects(materializeGrant(k, grant.id, "channel:C1", "U1"), /keys stay in the backend/);
    assert.equal(await k.composioKey("U1", c.id), "project-key");
    assert.equal(await k.composioKey("U2", c.id), null);
  }
});

test("manifest excludes expiry timestamps and request status while enforcing actual expiration", async () => {
  let now = Date.parse("2030-01-01T00:00:00Z");
  const k = createKeychain({
    lock: testAdvisoryLock(),
    store: createKeychainStore(testDatabaseUrl()),
    key: KEY,
    now: () => now,
  });
  const expiresAt = now + 50 * 3_600_000;
  const credential = await k.save({ ...GH, expiresAt });
  const { ask } = await k.createAsk({
    credentialId: credential.id,
    requesterId: "U2",
    requesterScopeId: "channel:C1",
    purpose: "test access",
  });
  const manifest = async () =>
    renderKeychainManifest(
      {
        scopeId: "personal:U1",
        conversationKind: "dm",
        actorId: "U1",
        members: [{ id: "U1" }],
        entriesByOwner: new Map([["U1", await k.listByOwner("U1")]]),
        scopeGrants: [],
        scopeAsks: await k.listAsks({ requesterScopeId: "channel:C1" }),
        execution: [
          { credentialId: credential.id, ownerId: "U1", handle: credentialHandle(credential), description: "github" },
        ],
      },
      now,
    );
  const first = await manifest();
  for (const advance of [61_000, 3 * 3_600_000]) {
    now += advance;
    assert.equal(await manifest(), first);
  }
  assert.ok(first.includes(credentialHandle(credential)));
  assert.doesNotMatch(first, /expires at|approval card/);
  now = ask.expiresAt;
  assert.equal(await manifest(), first);
  now++;
  const expiredAsk = await manifest();
  assert.equal(expiredAsk, first);
  assert.doesNotMatch(expiredAsk, /waiting on U1's approval card/);
  await assert.rejects(
    k.approveAsk({ askId: ask.id, ownerId: "U1", mode: "once", purpose: "test access" }),
    (e: KeychainError) => e.status === 410,
  );
  now = expiresAt;
  assert.doesNotMatch(await manifest(), /EXPIRED — they must re-auth/);
  await k.materializeOwnById("U1", credential.id, "personal:U1");
  now++;
  assert.match(await manifest(), /EXPIRED — they must re-auth/);
  await assert.rejects(
    k.materializeOwnById("U1", credential.id, "personal:U1"),
    (e: KeychainError) => e.status === 410,
  );
});

test("manifest inventories are canonical across discovery order without mutating inputs", async () => {
  const k = kc();
  for (const ownerId of ["U2", "U1"]) {
    await k.save({ ...GH, ownerId });
    await k.save({
      ownerId,
      service: "files",
      files: [
        { path: ".config/z", contentBase64: "eg==" },
        { path: ".config/a", contentBase64: "YQ==" },
      ],
    });
    await k.save({
      ownerId,
      service: "custom",
      fields: [
        { envKey: "Z_KEY", value: "z" },
        { envKey: "A_KEY", value: "a" },
      ],
    });
    await k.setConnectorToken("github.com", ownerId, { accessToken: "token" });
    await k.setConnectorToken("gmail.googleapis.com", ownerId, { accessToken: "token" });
  }
  for (const credential of await k.listByOwner("U1")) {
    await k.createAsk({
      credentialId: credential.id,
      requesterId: "U2",
      requesterScopeId: "channel:C1",
      purpose: "access",
    });
  }
  const input: Parameters<typeof renderKeychainManifest>[0] = {
    scopeId: "personal:U1",
    conversationKind: "dm",
    actorId: "U1",
    members: [{ id: "U2" }, { id: "U1" }],
    entriesByOwner: await k.listByOwners(["U2", "U1"]),
    connectorsByOwner: await k.listConnectorsByOwners(["U2", "U1"]),
    scopeGrants: [],
    execution: ["z", "a"].map((id) => ({
      credentialId: id,
      ownerId: "U1",
      handle: `${id}:${id}`,
      description: id,
      scope: "scoped",
    })),
    detectedByOwner: new Map([
      ["U1", ["zsh", "aws"]],
      ["U2", ["gcloud", "aws"]],
    ]),
    scopeAsks: await k.listAsks({ requesterScopeId: "channel:C1" }),
  };
  const before = structuredClone(input);
  const first = renderKeychainManifest(input, 1000);
  const reversed = structuredClone(input);
  reversed.members.reverse();
  reversed.execution!.reverse();
  for (const entries of reversed.entriesByOwner.values()) {
    entries.reverse();
    for (const entry of entries) {
      entry.fields?.reverse();
      entry.targets?.reverse();
    }
  }
  for (const entries of reversed.connectorsByOwner!.values()) entries.reverse();
  for (const entries of reversed.detectedByOwner!.values()) entries.reverse();
  reversed.scopeAsks!.reverse();
  assert.equal(renderKeychainManifest(reversed, 1000), first);
  assert.deepEqual(input, before);
  assert.doesNotMatch(first, /waiting on U1's approval card/);
  assert.ok(!first.includes("Asks waiting on you"));
  reversed.connectorsByOwner!.get("U1")![0]!.needsReconnect = true;
  assert.notEqual(renderKeychainManifest(reversed, 1000), first);
});

test("manifest merges credential representations without conflating login identities or execution scopes", async () => {
  const k = kc();
  const ownerId = "ALICE@example.com";
  await k.setConnectorToken("gmail.googleapis.com", ownerId, { accessToken: "private-token", expiresAt: 5000 });
  const connector = (await k.listConnectorsByOwners([ownerId])).get(ownerId)![0]!;
  const credential = (await k.getCredential(connector.credentialId))!;
  const grant = await k.createGrant({
    ownerId,
    credentialId: credential.id,
    audienceScopeId: "channel:C1",
    mode: "standing",
    purpose: "mail",
  });
  const first = await k.save({
    ownerId,
    service: "aws",
    envKey: "AWS_TOKEN",
    secret: "first-secret",
    accountLabel: "work",
    expiresAt: 900,
  });
  const second = await k.save({
    ownerId,
    service: "aws",
    envKey: "OTHER_AWS_TOKEN",
    secret: "second-secret",
    accountLabel: "personal",
    expiresAt: 5000,
  });
  const input: Parameters<typeof renderKeychainManifest>[0] = {
    scopeId: "channel:C1",
    conversationKind: "channel",
    openSpeakerKeychain: true,
    actorId: "alice@example.com",
    members: [{ id: "alice@example.com", displayName: "Alice" }],
    entriesByOwner: new Map([["alice@example.com", [first, second]]]),
    connectorsByOwner: new Map([["alice@example.com", [{ ...connector, needsReconnect: true }]]]),
    scopeGrants: [{ grant, credential }],
    execution: [
      {
        handle: credentialHandle(credential),
        ownerId,
        credentialId: credential.id,
        description: "mail grant",
      },
      {
        handle: "connector:gmail.googleapis.com:default",
        ownerId,
        credentialId: credential.id,
        description: "own mail",
      },
      ...[first, second].map((c) => ({
        handle: credentialHandle(c),
        ownerId,
        credentialId: c.id,
        description: "aws",
      })),
    ],
  };
  const rendered = renderKeychainManifest(input, 1000);
  assert.equal(rendered.split("### ").length - 1, 1);
  assert.equal(rendered.split("connected app gmail.googleapis.com").length - 1, 1);
  assert.match(rendered, /NEEDS RECONNECT/);
  assert.doesNotMatch(rendered, /token expires at/);
  assert.ok(rendered.includes("call `$AGENT_API_URL/v1/credentials/http/gmail.googleapis.com/<path>`"));
  assert.match(rendered, /account work, EXPIRED/);
  assert.match(rendered, /account personal/);
  assert.doesNotMatch(rendered, /expires at/);
  assert.notEqual(credentialHandle(first), credentialHandle(second));
  for (const secret of ["private-token", "first-secret", "second-secret"]) assert.ok(!rendered.includes(secret));
  input.execution!.reverse();
  assert.equal(renderKeychainManifest(input, 1000), rendered);
});

test("granted connector keeps account and refresh semantics when owner is absent from roster", async () => {
  const k = kc(() => 1000);
  await k.setConnectorToken("gmail.googleapis.com", "U_OWNER", {
    accessToken: "old-token",
    refreshToken: "refresh-token",
    expiresAt: 900,
    accountType: "company",
  });
  const connector = (await k.listConnectorsByOwners(["U_OWNER"])).get("U_OWNER")![0]!;
  const credential = (await k.getCredential(connector.credentialId))!;
  const grant = await k.createGrant({
    ownerId: "U_OWNER",
    credentialId: credential.id,
    audienceScopeId: "channel:C1",
    mode: "standing",
    purpose: "mail",
  });
  const rendered = renderKeychainManifest(
    {
      scopeId: "channel:C1",
      conversationKind: "channel",
      actorId: "U_ACTOR",
      members: [{ id: "U_ACTOR" }],
      entriesByOwner: new Map(),
      scopeGrants: [{ grant, credential }],
      execution: [
        { credentialId: credential.id, ownerId: "U_OWNER", handle: credentialHandle(credential), description: "mail" },
      ],
    },
    1000,
  );
  assert.match(rendered, /connected app gmail\.googleapis\.com, account company/);
  assert.ok(!rendered.includes(grant.id));
  assert.doesNotMatch(rendered, /EXPIRED|NEEDS RECONNECT|refresh-token|old-token/);
});
