import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveConnectorKey } from "../../src/connectors/connector-client-store.ts";
import { type KeychainAsk, createKeychain } from "../../src/credentials/keychain.ts";
import { createCronStore } from "../../src/cron/cron-store.ts";
import { createIdempotencyStore } from "../../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { type AskResolutionDeps, createAskExpirySweep, fireAskResolution } from "../../src/triggers/keychain-ask.ts";
import type { Cron, Destination, TurnRequest, TurnResult } from "../../src/types.ts";
import { testAdvisoryLock, testDatabaseUrl } from "../support/test-database.ts";
import { createKeychainStore } from "../../src/credentials/keychain-store.ts";
import { recordingOutbound } from "../support/recording-outbound.ts";
import { automationOrigin } from "../support/turn-origin.ts";

const recipient: Destination = {
  type: "principal",
  target: "U_BOB",
  audienceScopeId: "personal:U_BOB",
  onBehalfOf: "U_ALICE",
};

async function fixture() {
  const crons = createCronStore(testDatabaseUrl());
  const cron = await crons.create({
    owner: "U_ALICE",
    createdBy: "U_ALICE",
    ownerScopeId: "personal:U_ALICE",
    schedule: { everyMs: 60_000 },
    action: "read the dummy account and report the result",
    destination: recipient,
  });
  const outbound = recordingOutbound();
  const requests: TurnRequest[] = [];
  const deps: AskResolutionDeps = {
    outbound,
    idempotency: createIdempotencyStore(testDatabaseUrl()),
    identity: createIdentityService(testDatabaseUrl()),
    getCron: (id) => crons.get(id),
    run: async (request) => {
      requests.push(request);
      return { status: "ok", reply: "dummy scheduled result" };
    },
  };
  const ask: KeychainAsk = {
    id: "dummy-ask",
    credentialId: "dummy-credential",
    ownerId: "U_ALICE",
    requesterId: "U_ALICE",
    orgId: "test",
    requesterScopeId: "personal:U_ALICE",
    requesterThreadRef: `cron:${cron.id}:fire:123456789abc`,
    requesterDestination: recipient,
    purpose: cron.action!,
    status: "approved",
    grantId: "dummy-grant",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  return { crons, cron, deps, ask, outbound, requests };
}

test("cron credential approval resumes the original fire once and delivers to the current destination", async () => {
  const f = await fixture();
  const destination: Destination = {
    type: "principal",
    target: "U_CAROL",
    audienceScopeId: "personal:U_CAROL",
    onBehalfOf: "U_ALICE",
  };
  await f.crons.setDestination(f.cron.id, destination);
  await f.crons.update(f.cron.id, { unattendedGrants: ["allowed-job-grant"] });

  await fireAskResolution(f.deps, f.ask);
  await fireAskResolution(f.deps, f.ask);

  assert.equal(f.requests.length, 1);
  const request = f.requests[0]!;
  assert.equal(request.origin.kind === "automation", true);
  assert.equal(request.actor.externalId, "U_ALICE");
  assert.equal(request.conversation.threadRef, f.ask.requesterThreadRef);
  assert.deepEqual(automationOrigin(request)?.destination, destination);
  assert.equal(request.unattendedGrants, undefined, "grants never ride a fire that delivers to another person");
  assert.match(request.text, /approved access until revoked/);
  assert.ok(!request.text.includes(f.ask.id) && !request.text.includes(f.ask.purpose));
  const pending = await f.outbound.pending("principal");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.destination.target, "U_CAROL");
  assert.equal(pending[0]!.text, "dummy scheduled result");
  assert.equal(pending[0]!.provenance?.sourceThreadRef, f.ask.requesterThreadRef);
});

for (const changed of ["missing", "archived", "scope", "owner"] as const) {
  test(`cron credential approval fails closed when the original cron is ${changed}`, async () => {
    const f = await fixture();
    if (changed === "missing") await f.crons.delete(f.cron.id);
    else if (changed === "archived") await f.crons.update(f.cron.id, { archived: true });
    else {
      const current: Cron = {
        ...f.cron,
        ...(changed === "scope" ? { ownerScopeId: "personal:U_BOB" as const } : { owner: "U_BOB" }),
      };
      f.deps.getCron = async () => current;
    }

    const outcome = await fireAskResolution(f.deps, f.ask);

    assert.equal(outcome.ran, false);
    assert.equal(f.requests.length, 0);
    assert.equal((await f.outbound.pending("principal")).length, 0);
  });
}

test("cron credential approval fails closed when no cron lookup is available", async () => {
  const f = await fixture();
  delete f.deps.getCron;

  const outcome = await fireAskResolution(f.deps, f.ask);

  assert.equal(outcome.ran, false);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.outbound.pending("principal")).length, 0);
});

test("cron credential approval does not restore a removed delivery destination", async () => {
  const f = await fixture();
  await f.crons.setDestination(f.cron.id, undefined);

  await fireAskResolution(f.deps, f.ask);

  assert.equal(f.requests.length, 1);
  assert.equal(automationOrigin(f.requests[0]!)?.destination, undefined);
  assert.equal((await f.outbound.pending("principal")).length, 0);
});

for (const schedule of [{ everyMs: 60_000 }, { cron: "0 9 * * *", timezone: "UTC" }]) {
  test(`cron credential approval does not resume a paused recurring job (${JSON.stringify(schedule)})`, async () => {
    const f = await fixture();
    await f.crons.update(f.cron.id, { schedule });
    await f.crons.setEnabled(f.cron.id, false);

    const outcome = await fireAskResolution(f.deps, f.ask);

    assert.equal(outcome.ran, false);
    assert.equal(f.requests.length, 0);
    assert.equal((await f.outbound.pending("principal")).length, 0);
  });
}

test("cron credential approval resumes a disabled one-shot job in its original fire", async () => {
  const f = await fixture();
  await f.crons.update(f.cron.id, { schedule: { firstFireAt: Date.now() + 60_000 } });
  await f.crons.setEnabled(f.cron.id, false);

  const outcome = await fireAskResolution(f.deps, f.ask);

  assert.equal(outcome.ran, true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.conversation.threadRef, f.ask.requesterThreadRef);
  assert.equal((await f.outbound.pending("principal")).length, 1);
});

async function credentialRetryFixture(run: (request: TurnRequest) => Promise<TurnResult>) {
  const crons = createCronStore(testDatabaseUrl());
  const cron = await crons.create({
    owner: "U_ALICE",
    createdBy: "U_ALICE",
    ownerScopeId: "personal:U_ALICE",
    schedule: { everyMs: 60_000 },
    action: "read a private dummy account",
    runtime: { modelId: "gpt-6-luna", effortLevel: "low" },
    destination: {
      type: "principal",
      target: "U_BOB",
      audienceScopeId: "personal:U_BOB",
      onBehalfOf: "U_ALICE",
    },
  });
  const outbound = recordingOutbound();
  const idempotency = createIdempotencyStore(testDatabaseUrl());
  const ask: KeychainAsk = {
    id: "retry-ask",
    credentialId: "dummy-credential",
    ownerId: "U_ALICE",
    requesterId: "U_ALICE",
    orgId: "test",
    requesterScopeId: "personal:U_ALICE",
    requesterThreadRef: `cron:${cron.id}:fire:123456789abc`,
    requesterDestination: cron.destination,
    purpose: "read a private dummy account",
    status: "approved",
    grantId: "dummy-grant",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  const deps: AskResolutionDeps = {
    outbound,
    idempotency,
    identity: createIdentityService(testDatabaseUrl()),
    getCron: (id) => crons.get(id),
    run,
  };
  return { crons, cron, outbound, idempotency, ask, deps };
}

test("busy cron credential resolution leaves its fire retryable and resumes exactly once when available", async () => {
  const requests: TurnRequest[] = [];
  const f = await credentialRetryFixture(async (request) => {
    requests.push(request);
    return requests.length === 1
      ? { status: "refused", refusalKind: "session_busy", reason: "conversation is busy" }
      : { status: "ok", reply: "dummy scheduled result" };
  });
  const fireKey = `ask:${f.ask.id}:approved`;

  await assert.rejects(fireAskResolution(f.deps, f.ask));

  assert.equal(requests[0]?.model, "gpt-6-luna");
  assert.equal(requests[0]?.thinkingLevel, "low");
  assert.equal(await f.idempotency.committed(fireKey), false);
  assert.equal((await f.outbound.pending("principal")).length, 0);
  const resumed = await fireAskResolution(f.deps, f.ask);
  assert.equal(resumed.status, "ok");
  assert.equal(await f.idempotency.committed(fireKey), true);
  await fireAskResolution(f.deps, f.ask);

  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.conversation.threadRef === f.ask.requesterThreadRef));
  assert.ok(requests.every((request) => request.origin.kind === "automation"));
  const pending = await f.outbound.pending("principal");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.destination.target, "U_BOB");
  assert.equal(pending[0]!.text, "dummy scheduled result");
});

test("failed cron credential resolution notifies only the owner", async () => {
  let runs = 0;
  const f = await credentialRetryFixture(async () => {
    runs++;
    return { status: "failed", reason: "model unavailable" };
  });

  const failed = await fireAskResolution(f.deps, f.ask);
  await fireAskResolution(f.deps, f.ask);

  assert.equal(failed.status, "failed");
  assert.equal(runs, 1);
  const pending = await f.outbound.pending("principal");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.destination.target, "U_ALICE");
  assert.equal(pending[0]!.destination.audienceScopeId, "personal:U_ALICE");
  assert.match(pending[0]!.text, /^Access approved, but the task could not restart on its own\./);
  assert.equal(pending.filter((delivery) => delivery.destination.target === "U_BOB").length, 0);
});

test("a concurrent sweep cannot mark an in-flight busy resume notified before it becomes retryable", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<TurnResult>();
  let runs = 0;
  const f = await credentialRetryFixture(async () => {
    runs++;
    if (runs > 1) return { status: "ok", reply: "dummy scheduled result" };
    entered.resolve();
    return release.promise;
  });
  const store = createKeychainStore(testDatabaseUrl());
  await store.asks.put(f.ask);
  const keychain = createKeychain({
    lock: testAdvisoryLock(),
    store,
    key: deriveConnectorKey("concurrent-cron-resume-test"),
  });
  const sweep = createAskExpirySweep({ keychain, fire: (ask) => fireAskResolution(f.deps, ask) });
  const initial = assert.rejects(fireAskResolution(f.deps, f.ask), /waiting for the original conversation/);
  await entered.promise;

  await sweep(Date.now());
  assert.equal((await keychain.getAsk(f.ask.id))?.notifiedAt, undefined);
  release.resolve({ status: "refused", refusalKind: "session_busy", reason: "conversation is busy" });
  await initial;
  assert.equal(await f.idempotency.committed(`ask:${f.ask.id}:approved`), false);

  await sweep(Date.now());
  await sweep(Date.now());

  assert.equal(runs, 2);
  assert.notEqual((await keychain.getAsk(f.ask.id))?.notifiedAt, undefined);
  assert.equal(await f.idempotency.committed(`ask:${f.ask.id}:approved`), true);
  const pending = await f.outbound.pending("principal");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.destination.target, "U_BOB");
});
