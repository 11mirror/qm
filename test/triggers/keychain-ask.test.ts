import "../support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderKeychainManifest,
  KeychainError,
  ASK_TTL_MS,
  ASK_PRUNE_AFTER_MS,
  type KeychainAsk,
} from "../../src/credentials/keychain.ts";
import { createKeychain } from "../../src/credentials/create-keychain.ts";
import { createKeychainStore } from "../../src/credentials/keychain-store.ts";
import { createAskExpirySweep, fireAskResolution } from "../../src/triggers/keychain-ask.ts";
import { runTrigger } from "../../src/triggers/run-trigger.ts";
import { recordingOutbound } from "../support/recording-outbound.ts";
import { createIdempotencyStore } from "../../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../../src/types.ts";
import { materializeGrant } from "../support/materialize-grant.ts";
import { testAdvisoryLock, testDatabaseUrl } from "../support/test-database.ts";
import { KEY, kcAt, GH } from "../support/keychain-ask-app.ts";

test("createAsk: owner derived from the credential, purpose frozen, dedup per (credential, scope, task)", async () => {
  const k = kcAt(() => 1_000_000);
  const cred = await k.save(GH);

  await assert.rejects(
    k.createAsk({ credentialId: "nope", requesterId: "U_BOB", requesterScopeId: "channel:C1", purpose: "x" }),
    (e: KeychainError) => e.status === 404,
  );
  const self = await k.createAsk({
    credentialId: cred.id,
    requesterId: "U_ALICE",
    requesterScopeId: "personal:U_ALICE",
    purpose: "scheduled check",
  });
  assert.equal(self.ask.status, "pending");
  await assert.rejects(
    k.createAsk({ credentialId: cred.id, requesterId: "U_BOB", requesterScopeId: "personal:U_BOB", purpose: "x" }),
    (e: KeychainError) => e.status === 403,
  );

  const { ask, existing } = await k.createAsk({
    credentialId: cred.id,
    requesterId: "U_BOB",
    requesterScopeId: "channel:C1",
    purpose: "  clone acme/payments and run the tests  ",
    requesterThreadRef: "ch:C1-t1",
  });
  assert.equal(existing, false);
  assert.equal(ask.ownerId, "U_ALICE", "owner comes from the credential record, never the caller");
  assert.equal(ask.purpose, "clone acme/payments and run the tests");
  assert.equal(ask.status, "pending");
  assert.equal(ask.expiresAt, 1_000_000 + ASK_TTL_MS);

  const again = await k.createAsk({
    credentialId: cred.id,
    requesterId: "U_BOB",
    requesterScopeId: "channel:C1",
    purpose: "different words",
    requesterThreadRef: "ch:C1-t1",
  });
  assert.equal(again.existing, true);
  assert.equal(again.ask.id, ask.id, "one pending ask per (credential, scope, task) — re-asks are silent");
  assert.equal(again.ask.purpose, "clone acme/payments and run the tests", "the original purpose stays frozen");

  const elsewhere = await k.createAsk({
    credentialId: cred.id,
    requesterId: "U_BOB",
    requesterScopeId: "channel:C2",
    purpose: "other room",
  });
  assert.equal(elsewhere.existing, false, "a different scope is a different ask");
});

test("personal cron asks deduplicate recurring fires without combining jobs or re-asking after denial", async () => {
  let now = 1000000;
  const k = kcAt(() => now++);
  const cred = await k.save(GH);
  const base = {
    credentialId: cred.id,
    requesterId: "U_ALICE",
    requesterScopeId: "personal:U_ALICE" as const,
    purpose: "first task",
    triggered: true,
  };
  const first = await k.createAsk({ ...base, requesterThreadRef: "cron:first:fire:one" });
  const second = await k.createAsk({ ...base, requesterThreadRef: "cron:second:fire:one", purpose: "second task" });
  assert.notEqual(first.ask.id, second.ask.id);
  const retry = await k.createAsk({ ...base, requesterThreadRef: "cron:first:fire:two" });
  assert.equal(retry.ask.id, first.ask.id);
  assert.equal(retry.ask.requesterThreadRef, "cron:first:fire:one");
  assert.equal(retry.existing, true);
  await k.declineAsk({ askId: first.ask.id, ownerId: "U_ALICE", note: "no" });
  await assert.rejects(
    k.createAsk({ ...base, requesterThreadRef: "cron:first:fire:three" }),
    (e: KeychainError) => e.status === 409,
  );
  const revived = await k.createAsk({ ...base, triggered: false, requesterThreadRef: "cron:first:fire:four" });
  const waiting = await k.createAsk({ ...base, requesterThreadRef: "cron:first:fire:five" });
  assert.equal(waiting.ask.id, revived.ask.id);
  await k.approveAsk({ askId: revived.ask.id, ownerId: "U_ALICE", mode: "once", purpose: "yes" });
  assert.equal((await k.getAsk(second.ask.id))?.status, "pending");
  now += ASK_TTL_MS + 1;
  await assert.rejects(
    k.createAsk({ ...base, requesterThreadRef: "cron:second:fire:two" }),
    (e: KeychainError) => e.status === 409,
  );
});

for (const outcome of ["declined", "expired"] as const) {
  test(`task ${outcome} decisions survive pruning and a later approval supersedes them`, async () => {
    let now = 1_000_000;
    const k = kcAt(() => now++);
    const credential = await k.save(GH);
    const input = {
      credentialId: credential.id,
      requesterId: "U_ALICE",
      requesterScopeId: "personal:U_ALICE" as const,
      requesterThreadRef: "cron:retained:fire:first",
      purpose: "scheduled check",
      triggered: true,
    };
    const { ask } = await k.createAsk(input);
    if (outcome === "declined") await k.declineAsk({ askId: ask.id, ownerId: "U_ALICE" });
    else now += ASK_TTL_MS + 1;
    const sweep = createAskExpirySweep({ keychain: k, fire: async () => undefined });
    await sweep(now);
    now += ASK_PRUNE_AFTER_MS + 1;
    await sweep(now);
    assert.equal((await k.getAsk(ask.id))?.status, outcome);
    await assert.rejects(
      k.createAsk({ ...input, requesterThreadRef: "cron:retained:fire:later" }),
      (e: KeychainError) => e.status === 409,
    );
    const revived = await k.createAsk({ ...input, triggered: false });
    await k.approveAsk({ askId: revived.ask.id, ownerId: "U_ALICE", mode: "once", purpose: "retry it" });
    await sweep(now);
    now += ASK_PRUNE_AFTER_MS + 1;
    await sweep(now);
    assert.equal(await k.getAsk(ask.id), null);
    assert.equal((await k.getAsk(revived.ask.id))?.status, "approved");
    const next = await k.createAsk({ ...input, requesterThreadRef: "cron:retained:fire:next" });
    assert.equal(next.existing, false);
    assert.equal(next.ask.status, "pending");
  });
}

test("approveAsk: same createGrant owner gate, audience from the record, single resolution", async () => {
  const t = 1_000_000;
  const k = kcAt(() => t);
  const cred = await k.save(GH);
  const { ask } = await k.createAsk({
    credentialId: cred.id,
    requesterId: "U_BOB",
    requesterScopeId: "channel:C1",
    purpose: "clone the repo",
  });

  await assert.rejects(
    k.approveAsk({ askId: ask.id, ownerId: "U_BOB", mode: "once", purpose: "alice said fine" }),
    (e: KeychainError) => e.status === 403,
  );
  assert.equal((await k.getAsk(ask.id))?.status, "pending");
  await assert.rejects(
    k.approveAsk({ askId: "deadbeef0000", ownerId: "U_ALICE", mode: "once", purpose: "x" }),
    (e: KeychainError) => e.status === 404,
  );

  const { ask: approved, grant } = await k.approveAsk({
    askId: ask.id,
    ownerId: "U_ALICE",
    mode: "once",
    purpose: "sure, just this once",
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.grantId, grant.id);
  assert.equal(grant.audienceScopeId, "channel:C1", "audience comes from the ask record — the approver named no scope");
  assert.equal(grant.askId, ask.id);
  assert.equal(grant.purpose, "sure, just this once", "the grant binds the OWNER's verbatim words");

  await assert.rejects(
    k.approveAsk({ askId: ask.id, ownerId: "U_ALICE", mode: "once", purpose: "again" }),
    (e: KeychainError) => e.status === 410,
    "re-approve is a replay",
  );

  await assert.rejects(materializeGrant(k, grant.id, "channel:OTHER", "U_BOB"), (e: KeychainError) => e.status === 403);
  const m = await materializeGrant(k, grant.id, "channel:C1", "U_BOB");
  assert.ok(m.kind === "env" && m.env[0]!.value === "ghp_alice");
  const used = (await k.getGrant(grant.id))!;
  assert.equal(used.status, "used");
  assert.equal(used.usedAt, 1_000_000);
  await assert.rejects(materializeGrant(k, grant.id, "channel:C1", "U_BOB"), (e: KeychainError) => e.status === 410);
});

test("declineAsk is owner-gated and single-resolution", async () => {
  const k = kcAt(Date.now);
  const cred = await k.save(GH);
  const { ask } = await k.createAsk({
    credentialId: cred.id,
    requesterId: "U_BOB",
    requesterScopeId: "channel:C1",
    purpose: "p",
  });

  await assert.rejects(k.declineAsk({ askId: ask.id, ownerId: "U_BOB" }), (e: KeychainError) => e.status === 403);
  const declined = await k.declineAsk({ askId: ask.id, ownerId: "U_ALICE", note: "not for prod" });
  assert.equal(declined.status, "declined");
  assert.equal(declined.note, "not for prod");
  await assert.rejects(k.declineAsk({ askId: ask.id, ownerId: "U_ALICE" }), (e: KeychainError) => e.status === 410);
  await assert.rejects(
    k.approveAsk({ askId: ask.id, ownerId: "U_ALICE", mode: "once", purpose: "x" }),
    (e: KeychainError) => e.status === 410,
  );
});

test("expiry: lazy flip on read, sweep returns each expired ask exactly once", async () => {
  let t = 1_000_000;
  const k = kcAt(() => t);
  const cred = await k.save(GH);
  const { ask } = await k.createAsk({
    credentialId: cred.id,
    requesterId: "U_BOB",
    requesterScopeId: "channel:C1",
    purpose: "p",
  });

  t += ASK_TTL_MS + 1;
  const listed = await k.listAsks({ requesterScopeId: "channel:C1" });
  assert.equal(listed[0]?.status, "expired");
  assert.equal((await k.getAsk(ask.id))?.status, "expired");
  await assert.rejects(
    k.approveAsk({ askId: ask.id, ownerId: "U_ALICE", mode: "once", purpose: "x" }),
    (e: KeychainError) => e.status === 410,
  );

  assert.deepEqual(
    (await k.unnotifiedResolvedAsks(t)).map((a) => a.id),
    [ask.id],
  );
  assert.deepEqual(
    (await k.unnotifiedResolvedAsks(t)).map((a) => a.id),
    [ask.id],
    "still returned until the resolution actually fired",
  );
  await k.markAskNotified(ask.id, "expired");
  assert.deepEqual(await k.unnotifiedResolvedAsks(t), []);
});

test("sweep is the durable retry for approve/decline resolutions that never fired, and prunes old asks", async () => {
  let t = 1_000_000;
  const k = kcAt(() => t);
  const cred = await k.save(GH);
  const { ask } = await k.createAsk({
    credentialId: cred.id,
    requesterId: "U_BOB",
    requesterScopeId: "channel:C1",
    purpose: "p",
  });
  await k.approveAsk({ askId: ask.id, ownerId: "U_ALICE", mode: "once", purpose: "yes" });

  const fired: KeychainAsk[] = [];
  const sweep = createAskExpirySweep({ keychain: k, fire: async (a) => void fired.push(a) });
  await sweep(t);
  assert.deepEqual(
    fired.map((a) => [a.id, a.status]),
    [[ask.id, "approved"]],
    "the sweep retries non-expiry resolutions too",
  );
  await sweep(t);
  assert.equal(fired.length, 1, "marked notified after firing — no refire");

  t += ASK_PRUNE_AFTER_MS + 1;
  await sweep(t);
  assert.equal(await k.getAsk(ask.id), null, "resolved+notified asks are pruned after the retention window");
});

test("a sweep over ask history makes one grant query and no per-ask lookups", async () => {
  let t = 1_000_000;
  const lookups: string[] = [];
  const store = createKeychainStore(testDatabaseUrl());
  const { creds, grants } = store;
  const countedGet =
    <T>(name: string, get: (id: string) => Promise<T>) =>
    (id: string) => {
      lookups.push(name);
      return get(id);
    };
  creds.get = countedGet("creds", creds.get);
  grants.get = countedGet("grants", grants.get);
  const forAsks = grants.forAsks;
  grants.forAsks = (ids) => {
    lookups.push("grants batch");
    return forAsks(ids);
  };
  const k = createKeychain({
    lock: testAdvisoryLock(),
    store,
    key: KEY,
    now: () => t,
  });
  const cred = await k.save(GH);
  for (const channel of ["C1", "C2", "C3"])
    await k.createAsk({
      credentialId: cred.id,
      requesterId: "U_BOB",
      requesterScopeId: `channel:${channel}`,
      requesterThreadRef: `cron:task-${channel}:fire:1`,
      purpose: "p",
    });
  t += ASK_TTL_MS + 1;
  const sweep = createAskExpirySweep({ keychain: k, fire: async () => undefined });
  await sweep(t);
  lookups.length = 0;
  await sweep(t);
  assert.deepEqual(lookups, ["grants batch"], "one grant query covers every unsettled ask");
  t += ASK_PRUNE_AFTER_MS + 1;
  lookups.length = 0;
  await sweep(t);
  assert.deepEqual(lookups, ["grants batch", "creds"], "the retention check reads each credential once per sweep");
  assert.equal((await k.listAsks({ requesterScopeId: "channel:C1" })).length, 1, "each task keeps its latest decision");
});

test("sweep isolates per-ask failures — one failed fire doesn't starve the batch", async () => {
  const t = 1_000_000;
  const k = kcAt(() => t);
  const cred = await k.save(GH);
  const a1 = (
    await k.createAsk({ credentialId: cred.id, requesterId: "U_BOB", requesterScopeId: "channel:C1", purpose: "p1" })
  ).ask;
  const a2 = (
    await k.createAsk({ credentialId: cred.id, requesterId: "U_BOB", requesterScopeId: "channel:C2", purpose: "p2" })
  ).ask;
  await k.approveAsk({ askId: a1.id, ownerId: "U_ALICE", mode: "once", purpose: "y1" });
  await k.approveAsk({ askId: a2.id, ownerId: "U_ALICE", mode: "once", purpose: "y2" });

  const fired: string[] = [];
  const sweep = createAskExpirySweep({
    keychain: k,
    fire: async (a) => {
      if (a.id === a1.id) throw new Error("delivery store down");
      fired.push(a.id);
    },
  });
  await sweep(t);
  assert.deepEqual(fired, [a2.id], "the failure didn't starve the rest of the batch");
  assert.equal((await k.getAsk(a1.id))?.notifiedAt, undefined, "the failed ask stays unnotified and retries next tick");
  assert.notEqual((await k.getAsk(a2.id))?.notifiedAt, undefined);
});

test("runTrigger marks every trigger-fired turn `triggered` (the consent-gate claim)", async () => {
  const databaseUrl = testDatabaseUrl();
  let seen: TurnRequest | undefined;
  const outcome = await runTrigger(
    {
      outbound: recordingOutbound(),
      idempotency: createIdempotencyStore(databaseUrl),
      identity: createIdentityService(databaseUrl),
      run: async (req) => ((seen = req), { status: "ok" } as TurnResult),
    },
    {
      owner: "U_ALICE",
      ownerScopeId: scopeId("channel", "C1"),
      input: "do it",
      fireKey: "f1",
      surface: "cron",
      threadRef: "ch:C1-t1",
    },
  );
  assert.equal(outcome.ran, true);
  assert.equal(seen?.origin.kind, "automation");
  assert.equal(seen?.thinkingLevel, undefined);
  assert.equal(seen?.fastMode, undefined);
  assert.equal(seen?.conversation.threadRef, "ch:C1-t1", "an explicit threadRef overrides the per-fire fireKey thread");
});

test("runTrigger: silent markers never silence a notification-shaped fire (keychain-ask)", async () => {
  const databaseUrl = testDatabaseUrl();
  const outbound = recordingOutbound();
  const outcome = await runTrigger(
    {
      outbound,
      idempotency: createIdempotencyStore(databaseUrl),
      identity: createIdentityService(databaseUrl),
      run: async () => ({ status: "ok", reply: "The keychain ask was approved." }) as TurnResult,
    },
    {
      owner: "U_ALICE",
      ownerScopeId: scopeId("personal", "U_ALICE"),
      input: "your ask was approved — resume",
      fireKey: "f-nu",
      surface: "keychain-ask",
      destination: { type: "slack", target: "D1", audienceScopeId: scopeId("personal", "U_ALICE") },
    },
  );
  assert.equal(outcome.ran, true);
  assert.equal((await outbound.pending("slack")).length, 1, "the sentinel is poll-only; an ask notice must deliver");
});

test("fireAskResolution: a turn that fires but doesn't land falls back to a plain delivery (once)", async () => {
  const ask: KeychainAsk = {
    id: "fa11bacc0000",
    credentialId: "c1",
    ownerId: "U_ALICE",
    requesterId: "U_BOB",
    requesterScopeId: "channel:C1",
    requesterDestination: { type: "slack", target: "C1", audienceScopeId: "channel:C1" },
    purpose: "clone the payments repo",
    status: "approved",
    createdAt: 1,
    expiresAt: 2,
    resolvedAt: 1,
    grantId: "g1",
  };
  const mkDeps = (run: (req: TurnRequest) => Promise<TurnResult>, current: KeychainAsk = ask) => {
    const databaseUrl = testDatabaseUrl();
    const outbound = recordingOutbound();
    return {
      outbound,
      idempotency: createIdempotencyStore(databaseUrl),
      identity: createIdentityService(databaseUrl),
      run,
      getAsk: async () => current,
    };
  };
  const texts = async (deps: ReturnType<typeof mkDeps>) => (await deps.outbound.pending("slack")).map((d) => d.text);

  const refused = mkDeps(async () => ({ status: "refused", reason: "rate limit exceeded" }) as TurnResult);
  await fireAskResolution(refused, ask);
  await fireAskResolution(refused, ask);
  assert.deepEqual(
    await texts(refused),
    ["Access approved, but the task could not restart on its own. It will have access the next time it runs."],
    "fallback is plain and at-most-once",
  );
  for (const status of ["declined", "expired"] as const) {
    const other = { ...ask, id: `fa11bacc${status}`, status };
    const deps = mkDeps(async () => ({ status: "refused" }) as TurnResult, other);
    await fireAskResolution(deps, other);
    assert.deepEqual(await texts(deps), [
      status === "declined" ? "Access was declined." : "The access request expired.",
    ]);
  }

  const notified = { ...ask, id: "fa11bacc1111", notifiedAt: 5 };
  const quiet = mkDeps(async () => ({ status: "refused" }) as TurnResult, notified);
  await fireAskResolution(quiet, notified);
  const before = (await texts(quiet)).length;
  await fireAskResolution(quiet, notified);
  assert.equal((await texts(quiet)).length, before, "no redundant line once notified");

  const prompts: string[] = [];
  for (const mode of ["standing", "once"] as const) {
    const grant = {
      id: `g-${mode}`,
      credentialId: "c1",
      ownerId: "U_ALICE",
      audienceScopeId: "channel:C1",
      mode,
      purpose: "use it for payments work this week",
      status: "active",
      createdAt: 1,
    } as any;
    const current = { ...ask, id: `fa11bacc${mode}`, grantId: grant.id };
    await fireAskResolution(
      {
        ...mkDeps(
          async (req) => (prompts.push(req.text ?? ""), { status: "ok", reply: "on it" }) as TurnResult,
          current,
        ),
        getGrant: async () => grant,
      },
      current,
    );
  }
  assert.match(prompts[0]!, /until revoked/, "mode comes from the looked-up grant");
  assert.match(prompts[1]!, /for one credential use/);
  for (const prompt of prompts) {
    assert.match(prompt, /Re-run the blocked command/);
    assert.ok(!/fa11bacc|g-standing|g-once/.test(prompt), "no ask or grant ids in the resume prompt");
    assert.ok(!prompt.includes(ask.purpose) && !prompt.includes("payments work"), "no purpose text");
  }

  const ok = mkDeps(async () => ({ status: "ok", reply: "done" }) as TurnResult);
  await fireAskResolution(ok, ask);
  assert.deepEqual(await texts(ok), ["done"], "just the turn's reply, no fallback");
});

test("manifest excludes request status, ask ids and purposes from the system inventory", async () => {
  const now = Date.now();
  const pending: KeychainAsk = {
    id: "a1b2c3d4e5f6",
    credentialId: "cred1",
    ownerId: "U_ALICE",
    requesterId: "U_BOB",
    requesterScopeId: "channel:C1",
    purpose: "clone acme/payments and run the tests",
    status: "pending",
    createdAt: now - 2 * 3_600_000,
    expiresAt: now + 22 * 3_600_000,
  };
  const declined: KeychainAsk = {
    ...pending,
    id: "b2c3d4e5f6a1",
    status: "declined",
    note: "not for prod",
    resolvedAt: now - 60_000,
  };

  const channel = renderKeychainManifest({
    scopeId: "channel:C1",
    conversationKind: "channel",
    actorId: "U_BOB",
    members: [{ id: "U_BOB" }],
    entriesByOwner: new Map(),
    scopeGrants: [],
    scopeAsks: [pending, declined],
  });
  assert.doesNotMatch(channel, /Asks sent from this conversation:|waiting on|request to U_ALICE: declined/);
  assert.match(channel, /`request-access` skill/, "the manifest names the request skill");
  assert.doesNotMatch(channel, /approval card/);
  assert.match(channel, /requires an explicit grant/);
  assert.ok(!channel.includes("/v1/keychain/grants"), "no approval-by-POST ladder");
  for (const leak of [pending.id, declined.id, pending.purpose, "not for prod"])
    assert.ok(!channel.includes(leak), `manifest leaks ${leak}`);

  const dm = renderKeychainManifest({
    scopeId: scopeId("personal", "U_ALICE"),
    conversationKind: "dm",
    actorId: "U_ALICE",
    members: [{ id: "U_ALICE" }],
    entriesByOwner: new Map([
      [
        "U_ALICE",
        [
          {
            id: "cred1",
            ownerId: "U_ALICE",
            service: "github",
            kind: "env",
            envKey: "GITHUB_TOKEN",
            accountLabel: "alice-acme",
            fingerprint: "f",
            createdAt: now,
            updatedAt: now,
          },
        ],
      ],
    ]),
    scopeGrants: [],
    scopeAsks: [pending, declined],
  });
  assert.ok(!dm.includes("Asks waiting on you"), "the owner answers on the card, not in chat");
  for (const leak of [pending.id, pending.purpose, "/decline", "/v1/keychain/grants"]) assert.ok(!dm.includes(leak));
});
