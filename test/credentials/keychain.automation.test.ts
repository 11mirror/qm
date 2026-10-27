import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import { deriveConnectorKey } from "../../src/connectors/connector-client-store.ts";
import { credentialHandle, createKeychain, KeychainError, ASK_TTL_MS } from "../../src/credentials/keychain.ts";
import { createCronStore } from "../../src/cron/cron-store.ts";
import { createPostgresCronFireStore } from "../../src/cron/fire-store.ts";
import { createIdempotencyStore } from "../../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { fireAskResolution, type AskResolutionDeps } from "../../src/triggers/keychain-ask.ts";
import { runTrigger } from "../../src/triggers/run-trigger.ts";
import { scopeId, type TurnRequest, type Principal, type ScopeId } from "../../src/types.ts";
import { selectDefaultSandbox } from "../support/default-sandbox.ts";
import { installGlobalFakeSprites, type FakeSprites } from "../support/fake-sprites.ts";
import { materializeGrant } from "../support/materialize-grant.ts";
import { recordingOutbound } from "../support/recording-outbound.ts";
import { testConfig } from "../support/test-config.ts";
import { testAdvisoryLock, testMap, testDatabaseUrl } from "../support/test-database.ts";
import { automationOrigin } from "../support/turn-origin.ts";
import { failedTurn } from "../support/orchestrator-app.ts";
import { buildTestApp } from "../support/test-app.ts";

let ff: FakeSprites;
before(() => {
  ff = installGlobalFakeSprites();
});
beforeEach(() => ff.reset());
after(() => ff.cleanup());

const actor = { externalId: "U1" };

async function setup() {
  const built = buildTestApp(testConfig({ maxAttempts: 1, signingSecret: "own-cred-test" }));
  await selectDefaultSandbox(built, "U1", scopeId("personal", "U1"), scopeId("channel", "C1"));
  const credential = await built.keychain!.save({
    ownerId: "U1",
    service: "aws",
    files: [{ path: ".aws/sso/cache/session.json", contentBase64: Buffer.from("own-login").toString("base64") }],
  });
  const read = `!execute ${JSON.stringify({
    command: 'cat "$HOME/.aws/sso/cache/session.json"',
    credentials: [credentialHandle(credential)],
  })}`;
  return { built, read };
}

test("a scheduled turn in the owner's DM uses the owner's credential without a grant", async () => {
  const { built, read } = await setup();
  const fired = await built.app.turn({
    surface: "cron",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:cron" },
    text: read,
    origin: { kind: "automation" },
  } as TurnRequest);
  assert.equal(fired.status, "ok", fired.reason);
  assert.match(fired.reply ?? "", /own-login/);
  assert.equal((await built.keychain!.listGrants({ ownerId: "U1" })).length, 0);
});

test("a subagent of the owner's DM uses the owner's credential without a grant", async () => {
  const { built, read } = await setup();
  const personal = scopeId("personal", "U1");
  const parent = await built.sessions.getOrCreateByThread("dm:U1:parent", "dm", personal);
  const child = await built.sessions.getOrCreateByThread("agent:main:subagent:own-cred", "dm", personal);
  const conversation = {
    kind: "dm" as const,
    threadRef: "dm:U1:parent",
    audience: [{ id: "U1", type: "internal" as const }],
  };
  await built.sessions.setParentSession(child.id, parent.id);
  await built.sessions.addParticipant(child.id, "U1");
  await built.sessions.setSpawnMeta(child.id, { surface: "web", actor: { id: "U1", type: "internal" }, conversation });
  const result = await built.app.turn({
    surface: "web",
    actor,
    conversation: { kind: "dm", threadRef: child.threadRef },
    text: read,
    origin: { kind: "automation" },
  } as TurnRequest);
  assert.equal(result.status, "ok", result.reason);
  assert.match(result.reply ?? "", /own-login/);
  assert.equal((await built.keychain!.listGrants({ ownerId: "U1" })).length, 0);
});

test("a scheduled turn in a shared channel cannot use the owner's credential without a grant", async () => {
  const { built, read } = await setup();
  await failedTurn(
    built,
    {
      surface: "cron",
      actor,
      conversation: { kind: "channel", threadRef: "ch:C1:cron", channelRef: "C1", audience: [actor] },
      text: read,
      origin: { kind: "automation" },
    } as TurnRequest,
    /credential handle is not available/,
  );
});

function keychain(now = Date.now) {
  return createKeychain({
    lock: testAdvisoryLock(),
    creds: testMap(),
    grants: testMap(),
    asks: testMap(),
    key: deriveConnectorKey("shared-credential-resumption-test"),
    now,
  });
}

async function fixture(scope: ScopeId = "channel:C_SHARED") {
  const clock = { t: Date.now() };
  const k = keychain(() => clock.t);
  const credential = await k.save({
    ownerId: "U_CREDENTIAL_OWNER",
    service: "dummy",
    secret: "dummy-only-secret",
    envKey: "DUMMY_TOKEN",
  });
  const crons = createCronStore(testMap(), { fires: createPostgresCronFireStore(testDatabaseUrl()) });
  const cron = await crons.create({
    owner: `system:${scope}`,
    createdBy: `system:${scope}`,
    ownerScopeId: scope,
    schedule: { everyMs: 60_000 },
    action: "read the dummy account",
    destination: {
      type: "principal",
      target: "U_REQUESTER",
      audienceScopeId: "personal:U_REQUESTER",
      onBehalfOf: "U_JOB_OWNER",
    },
  });
  const state: { members: Principal[] } = { members: [{ id: "U_REQUESTER", type: "internal" }] };
  const requests: TurnRequest[] = [];
  const outbound = recordingOutbound();
  const deps: AskResolutionDeps = {
    outbound,
    idempotency: createIdempotencyStore(testDatabaseUrl()),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    currentScopeMembers: async () => state.members,
    getCron: (id) => crons.get(id),
    getGrant: (id) => k.getGrant(id),
    run: async (request) => {
      requests.push(request);
      return request.surface === "cron" ? { status: "silent" } : { status: "ok", reply: "dummy result" };
    },
  };
  const threadRef = `cron:${cron.id}:fire:first`;
  await runTrigger(deps, {
    ...cron,
    input: cron.action!,
    fireKey: "original-fire",
    threadRef,
    surface: "cron",
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.actor.externalId, `system:${scope}`);
  const { ask } = await k.createAsk({
    credentialId: credential.id,
    requesterId: requests[0]!.actor.externalId,
    requesterScopeId: scope,
    requesterThreadRef: requests[0]!.conversation.threadRef,
    requesterDestination: automationOrigin(requests[0]!)?.destination,
    triggered: true,
    purpose: cron.action!,
  });
  const approved = await k.approveAsk({
    askId: ask.id,
    ownerId: credential.ownerId,
    mode: "once",
    purpose: "read only the dummy account",
  });
  requests.length = 0;
  return { k, clock, credential, crons, cron, state, requests, outbound, deps, ...approved };
}

for (const scope of ["channel:C_SHARED", "group:G_SHARED", "group:web-project-shared"] as const) {
  test(`scope approval resumes another person's credential for a conversation-owned job in ${scope}`, async () => {
    const f = await fixture(scope);

    const outcome = await fireAskResolution(f.deps, f.ask);
    await fireAskResolution(f.deps, f.ask);

    assert.equal(outcome.status, "ok");
    assert.equal(f.requests.length, 1);
    const request = f.requests[0]!;
    assert.equal(request.actor.externalId, `system:${scope}`);
    assert.equal(request.origin.kind === "automation", true);
    assert.equal(request.conversation.threadRef, f.ask.requesterThreadRef);
    assert.equal(request.conversation.kind, scope.startsWith("channel:") ? "channel" : "group");
    assert.equal(request.conversation.channelRef, scope.slice(scope.indexOf(":") + 1));
    assert.deepEqual(request.conversation.audience, [{ externalId: "U_REQUESTER" }]);
    assert.equal(request.unattendedGrants, undefined);
    assert.equal(automationOrigin(request)?.useOwnerKeychain, undefined);
    assert.deepEqual(automationOrigin(request)?.destination, f.cron.destination);
    assert.match(request.text, /approved access for one credential use/);
    assert.ok(!request.text.includes(f.ask.id) && !request.text.includes(f.ask.purpose));
    assert.equal(f.grant.audienceScopeId, scope);
    assert.equal(f.grant.ownerId, "U_CREDENTIAL_OWNER");
    await assert.rejects(
      materializeGrant(f.k, f.grant.id, "channel:C_OTHER", request.actor.externalId),
      (error: KeychainError) => error.status === 403,
    );
    const materialized = await materializeGrant(f.k, f.grant.id, scope, request.actor.externalId);
    assert.ok(materialized.kind === "env" && materialized.env[0]!.value === "dummy-only-secret");
    await assert.rejects(
      materializeGrant(f.k, f.grant.id, scope, request.actor.externalId),
      (error: KeychainError) => error.status === 410,
    );
    const pending = await f.outbound.pending("principal");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.destination.target, "U_REQUESTER");
  });
}

for (const scope of ["channel:C_SHARED", "group:G_SHARED", "group:web-project-shared"] as const) {
  test(`shared asks in ${scope} deduplicate by job across actors and keep live requests separate`, async () => {
    let now = 1_000_000;
    const k = keychain(() => now++);
    const credential = await k.save({ ownerId: "U_OWNER", service: "dummy", secret: "fake", envKey: "DUMMY_TOKEN" });
    const base = {
      credentialId: credential.id,
      requesterId: "U_OWNER",
      requesterScopeId: scope,
      purpose: "read dummy account",
      triggered: true,
    };
    const first = await k.createAsk({ ...base, requesterThreadRef: "cron:first:fire:one" });
    const second = await k.createAsk({ ...base, requesterThreadRef: "cron:second:fire:one" });
    const live = await k.createAsk({ ...base, triggered: false, requesterThreadRef: "live-thread" });
    assert.equal(new Set([first.ask.id, second.ask.id, live.ask.id]).size, 3);
    const retry = await k.createAsk({ ...base, requesterId: "U_OTHER", requesterThreadRef: "cron:first:fire:two" });
    assert.equal(retry.existing, true);
    assert.equal(retry.ask.id, first.ask.id);
    assert.equal(retry.ask.requesterThreadRef, first.ask.requesterThreadRef);
    await k.declineAsk({ askId: first.ask.id, ownerId: "U_OWNER" });
    await k.approveAsk({ askId: live.ask.id, ownerId: "U_OWNER", mode: "once", purpose: "live use only" });
    await assert.rejects(
      k.createAsk({ ...base, requesterThreadRef: "cron:first:fire:three" }),
      (error: KeychainError) => error.status === 409,
    );
    const revived = await k.createAsk({ ...base, triggered: false, requesterThreadRef: "cron:first:fire:four" });
    assert.notEqual(revived.ask.id, first.ask.id);
    assert.equal((await k.getAsk(second.ask.id))?.status, "pending");
    now += ASK_TTL_MS + 1;
    await assert.rejects(
      k.createAsk({ ...base, requesterThreadRef: "cron:second:fire:two" }),
      (error: KeychainError) => error.status === 409,
    );
  });
}
