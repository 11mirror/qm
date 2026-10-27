import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import "../support/auto-fake-sprites.ts";

import { test, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildTestApp } from "../support/test-app.ts";
import { createServer } from "../../src/api/server.ts";
import { KeychainError, type KeychainAsk } from "../../src/credentials/keychain.ts";
import { createKeychainApprovals, type KeychainApprovals } from "../../src/credentials/keychain-approval.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, type CapabilityClaims } from "../../src/auth/capability-token.ts";
import { scopeId, type TurnRequest } from "../../src/types.ts";
import { fakeSprites } from "../support/auto-fake-sprites.ts";
import { testConfig } from "../support/test-config.ts";
import { selectDefaultSandbox } from "../support/default-sandbox.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { createPostgresReplayDedupe } from "../../src/auth/replay-dedupe.ts";
const SECRET = "keychain-ask-route-secret".repeat(3);

let server: Server;
let base: string;
let built: ReturnType<typeof buildTestApp>;
let approvals: KeychainApprovals;
const decide = (askId: string, actorId: string, decision: "once" | "standing" | "deny") =>
  approvals.decide(askId, { externalId: actorId }, decision);
const resumeTurns = async (sessionId: string, pattern: RegExp) =>
  (await built.sessions.getItems(sessionId)).filter((i) => i.kind === "UserMessage" && pattern.test(i.text ?? ""));

const capFor = (actorId: string, scope = scopeId("personal", actorId), extra: Partial<CapabilityClaims> = {}) =>
  mintCapabilityToken({ actorId, scopeId: scope, exp: Date.now() + CAPABILITY_TTL_MS, ...extra }, SECRET);
const bobInInfra = () =>
  capFor("U_BOB", "channel:C_INFRA", {
    threadRef: "ch:C_INFRA-thread",
    destination: { type: "slack", target: "C_INFRA", audienceScopeId: "channel:C_INFRA" },
  });

const post = (path: string, body: unknown, cap: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-capability": cap },
    body: JSON.stringify(body),
  });
const get = (path: string, cap: string) => fetch(`${base}${path}`, { headers: { "x-agent-capability": cap } });
const waitFor = async <T>(probe: () => Promise<T[]>, ms = 5_000): Promise<T[]> => {
  const start = Date.now();
  for (;;) {
    const v = await probe();
    if (v.length > 0 || Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
};

before(async () => {
  built = buildTestApp(testConfig({ signingSecret: SECRET }));
  await built.app.upsertDirectory([
    { principalId: "U_ALICE", displayName: "Alice", type: "internal" },
    { principalId: "U_BOB", displayName: "Bob", type: "internal" },
  ]);
  await built.app.upsertChannels(
    [
      { channelId: "C_INFRA", name: "infra", isPrivate: true },
      { channelId: "C_NOALICE", name: "no-alice", isPrivate: true },
      { channelId: "C_PUBLIC", name: "public-room" },
    ],
    [
      { channelId: "C_INFRA", principalId: "U_ALICE" },
      { channelId: "C_INFRA", principalId: "U_BOB" },
      { channelId: "C_NOALICE", principalId: "U_BOB" },
      { channelId: "C_PUBLIC", principalId: "U_BOB" },
    ],
  );
  approvals = createKeychainApprovals({
    keychain: built.keychain!,
    app: built.app,
    identity: built.identity,
    sessions: built.sessions,
    outbound: built.outbound,
    resume: (ask, grant) => built.fireAskResolution!(ask, grant),
  });
  server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
    keychain: built.keychain,
    keychainApprovals: approvals,
    outbound: built.outbound,
    workspace: built.workspace,
    auditLog: built.auditLog,
    credentialUsage: built.credentialUsage,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it("the web approval route decides through the same card path, owner only, never by capability", async () => {
  const { credential } = (await (
    await post("/v1/keychain/credentials", { service: "web-card", secret: "w" }, await capFor("U_ALICE"))
  ).json()) as any;
  const { ask } = (await (
    await post(
      "/v1/keychain/asks",
      { credential: credential.id, purpose: "deploy" },
      await capFor("U_BOB", "channel:C_INFRA", {
        threadRef: "ch:C_INFRA-web",
        destination: { type: "slack", target: "C_INFRA", audienceScopeId: "channel:C_INFRA" },
      }),
    )
  ).json()) as any;
  const session = await built.sessions.getOrCreateByThread("ch:C_INFRA-web", "channel", "channel:C_INFRA");
  await built.sessions.addParticipant(session.id, "U_ALICE");
  const inline = async (viewer: string) => {
    const listPath = `/v1/sessions/${session.id}/approvals?viewer=${viewer}`;
    const r = await fetch(`${base}${listPath}`, { headers: signedRequestHeaders(SECRET, "GET", listPath, "") });
    return ((await r.json()) as any).approvals.map((a: any) => a.requestId);
  };
  assert.deepEqual(await inline("U_ALICE"), [`keychain:${ask.id}`], "the owner sees the card inline in the session");
  const path = `/v1/keychain/approvals/${ask.id}`;
  const signed = (principalId: string) => {
    const body = JSON.stringify({ principalId, decision: "standing" });
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: signedRequestHeaders(SECRET, "POST", path, body),
      body,
    });
  };
  assert.notEqual(
    (await post(path, { principalId: "U_ALICE", decision: "standing" }, await capFor("U_ALICE"))).status,
    200,
  );
  assert.equal((await signed("U_BOB")).status, 403);
  const res = await signed("U_ALICE");
  assert.equal(res.status, 200);
  const view = (await res.json()) as any;
  assert.equal(view.ask.status, "approved");
  assert.equal(view.mode, "standing");
  assert.equal((await built.keychain!.getGrant(view.ask.grantId))!.audienceScopeId, "channel:C_INFRA");
  assert.deepEqual(await inline("U_ALICE"), [], "a decided card leaves the session");
  assert.ok(
    (await built.posts.pending("slack")).some((d) => d.idempotencyKey === `ask:${ask.id}:resolved`),
    "the Slack card is told to update",
  );
});

it("gates creation: personal ownership and directory-verified channel membership", async () => {
  const { credential } = (await (
    await post(
      "/v1/keychain/credentials",
      { service: "github", secret: "ghp_alice", envKey: "GITHUB_TOKEN", accountLabel: "alice-acme" },
      await capFor("U_ALICE"),
    )
  ).json()) as any;

  const fromDm = await post("/v1/keychain/asks", { credential: credential.id, purpose: "p" }, await capFor("U_BOB"));
  assert.equal(fromDm.status, 403, "dm scopes cannot send asks in v1");

  const fromGroup = await post(
    "/v1/keychain/asks",
    { credential: credential.id, purpose: "p" },
    await capFor("U_BOB", "group:G_MPIM"),
  );
  assert.equal(fromGroup.status, 403, "group scopes fail closed too");

  const notMember = await post(
    "/v1/keychain/asks",
    { credential: credential.id, purpose: "p" },
    await capFor("U_BOB", "channel:C_NOALICE"),
  );
  assert.equal(notMember.status, 403, "owner not in the private channel → fail closed");

  const unknownChannel = await post(
    "/v1/keychain/asks",
    { credential: credential.id, purpose: "p" },
    await capFor("U_BOB", "channel:C_GHOST"),
  );
  assert.equal(unknownChannel.status, 403, "channel the directory hasn't seen → fail closed");

  const unknownCred = await post("/v1/keychain/asks", { credential: "nope", purpose: "p" }, await bobInInfra());
  assert.equal(unknownCred.status, 404);
});

it("rejects invalid ask expiry at the route boundary", async () => {
  const { credential } = (await (
    await post("/v1/keychain/credentials", { service: "invalid-ask-exp", secret: "x" }, await capFor("U_ALICE"))
  ).json()) as any;
  const res = await post(
    "/v1/keychain/asks",
    { credential: credential.id, purpose: "p", expiresAt: "not-a-date" },
    await bobInInfra(),
  );
  assert.equal(res.status, 400);
});

it("creates the ask, posts ONE card in the requesting conversation without ids or purpose text, dedups silently", async () => {
  const creds = (await (await get("/v1/keychain/credentials", await capFor("U_ALICE"))).json()) as any;
  const gh = creds.credentials.find((c: any) => c.service === "github");

  const res = await post(
    "/v1/keychain/asks",
    { credential: gh.id, purpose: "clone acme/payments and run the tests" },
    await bobInInfra(),
  );
  assert.equal(res.status, 200);
  const { ask, existing } = (await res.json()) as any;
  assert.equal(existing, false);
  assert.equal(ask.status, "pending");
  assert.equal(ask.ownerId, "U_ALICE");
  assert.equal(ask.requesterScopeId, "channel:C_INFRA", "scope comes from the token, not the body");
  assert.equal(ask.requesterThreadRef, "ch:C_INFRA-thread");

  const notices = (await built.posts.pending("slack")).filter((d) => d.idempotencyKey === `ask:${ask.id}:notice`);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.destination.target, "C_INFRA", "the card lands where the request came from");
  assert.equal(notices[0]!.destination.keychainAskId, ask.id);
  assert.equal(
    (await built.posts.pending("principal")).filter((d) => d.idempotencyKey === `ask:${ask.id}:notice`).length,
    0,
    "no separate owner DM",
  );
  assert.match(
    notices[0]!.text,
    /Bob \(U_BOB\) in \*\*#infra\*\* wants to use your \*\*github\*\* credential \(alice-acme\)\./,
    "core composes the notice from the directory + token",
  );
  assert.match(notices[0]!.text, /Approve or deny on the card/);
  assert.ok(!notices[0]!.text.includes(ask.id), "no ask id");
  assert.ok(!notices[0]!.text.includes("clone acme/payments"), "no requester purpose text");
  assert.ok(!/Mention me|reply/i.test(notices[0]!.text), "chat replies are not approval");

  const again = await post(
    "/v1/keychain/asks",
    { credential: gh.id, purpose: "totally different words" },
    await bobInInfra(),
  );
  const dup = (await again.json()) as any;
  assert.equal(dup.existing, true);
  assert.equal(dup.ask.id, ask.id);
  assert.equal(
    (await built.posts.pending("slack")).filter((d) => d.idempotencyKey === `ask:${ask.id}:notice`).length,
    1,
    "no second card — no nagging",
  );
});

it("public channel: any internal owner is askable", async () => {
  const { credential } = (await (
    await post(
      "/v1/keychain/credentials",
      { service: "npm", secret: "npm_alice", envKey: "NPM_TOKEN" },
      await capFor("U_ALICE"),
    )
  ).json()) as any;
  const res = await post(
    "/v1/keychain/asks",
    { credential: credential.id, purpose: "publish the package" },
    await capFor("U_BOB", "channel:C_PUBLIC"),
  );
  assert.equal(res.status, 200);
});

it("only the owner's card click mints the audience-bound grant; replay is a no-op; the original thread resumes once", async () => {
  const creds = (await (await get("/v1/keychain/credentials", await capFor("U_ALICE"))).json()) as any;
  const gh = creds.credentials.find((c: any) => c.service === "github");
  const list = (await (await get("/v1/keychain/asks", await bobInInfra())).json()) as any;
  const ask = list.asks.find((a: any) => a.credentialId === gh.id && a.status === "pending");
  assert.ok(ask, "the pending ask is visible from the asking conversation");

  const seeded = await built.app.turn({
    origin: { kind: "direct" },
    surface: "slack",
    actor: { externalId: "U_BOB" },
    conversation: {
      kind: "channel",
      threadRef: "ch:C_INFRA-thread",
      channelRef: "C_INFRA",
      audience: [{ externalId: "U_BOB" }],
    },
    text: "waiting on alice",
  } as TurnRequest);
  assert.equal(seeded.status, "ok");
  const session = await built.sessions.getByThread("ch:C_INFRA-thread");
  assert.ok(session);

  await assert.rejects(decide(ask.id, "U_BOB", "once"), (e: KeychainError) => e.status === 403, "relayed approval");
  await assert.rejects(decide("deadbeef0000", "U_ALICE", "once"), (e: KeychainError) => e.status === 403);
  assert.equal((await built.keychain!.getAsk(ask.id))?.status, "pending");

  const view = await decide(ask.id, "U_ALICE", "once");
  assert.equal(view.ask.status, "approved");
  assert.equal(view.mode, "once");
  const grant = (await built.keychain!.getGrant(view.ask.grantId!))!;
  assert.equal(grant.audienceScopeId, "channel:C_INFRA");
  assert.equal(grant.askId, ask.id);
  assert.equal(grant.purpose, ask.purpose, "the card records the request, not relayed chat words");
  const replay = await decide(ask.id, "U_ALICE", "standing");
  assert.equal(replay.ask.grantId, grant.id, "a second click resolves to the first decision");

  const resolution = await waitFor(() => resumeTurns(session!.id, /The credential owner approved access/));
  assert.equal(resolution.length, 1, "exactly one resolution turn, in the original thread's session");
  const prompt = resolution[0]!.text ?? "";
  const environment = resolution[0]!.body.environment as string;
  assert.ok(
    !prompt.includes(ask.id) && !prompt.includes(grant.id) && !prompt.includes(gh.id),
    "no ids in the resume text",
  );
  assert.ok(environment.includes(`github:${gh.id}`), "the credential handle belongs in the inventory");
  assert.ok(environment.includes(grant.id), "the inventory includes the approved grant");
  assert.ok(!prompt.includes("clone acme/payments"), "no purpose text in the resume text");

  await waitFor(async () =>
    (((await (await get("/v1/keychain/asks", await bobInInfra())).json()) as any).asks as any[]).filter(
      (a) => a.id === ask.id && a.notifiedAt !== undefined,
    ),
  );
  await built.fireAskResolution!({ ...view.ask } as KeychainAsk, grant);
  assert.equal((await resumeTurns(session!.id, /The credential owner approved access/)).length, 1);

  await assert.rejects(
    built.keychain!.prepareMaterialize(grant.id, "channel:OTHER", "U_EVE"),
    (e: KeychainError) => e.status === 403,
  );
  const prepared = await built.keychain!.prepareMaterialize(grant.id, "channel:C_INFRA", "U_BOB");
  await prepared.commit();
  await assert.rejects(
    built.keychain!.prepareMaterialize(grant.id, "channel:C_INFRA", "U_BOB"),
    (e: KeychainError) => e.status === 410,
    "a child or retry needs a new approval after consumption",
  );
});

it("deny on the card flips the ask and fires exactly one resolution turn into the asking channel", async () => {
  const creds = (await (await get("/v1/keychain/credentials", await capFor("U_ALICE"))).json()) as any;
  const npm = creds.credentials.find((c: any) => c.service === "npm");
  const made = (await (
    await post("/v1/keychain/asks", { credential: npm.id, purpose: "publish from infra" }, await bobInInfra())
  ).json()) as any;
  const session = await built.sessions.getByThread("ch:C_INFRA-thread");
  assert.ok(session);

  await assert.rejects(decide(made.ask.id, "U_BOB", "deny"), (e: KeychainError) => e.status === 403);
  const view = await decide(made.ask.id, "U_ALICE", "deny");
  assert.equal(view.ask.status, "declined");
  const resolution = await waitFor(() => resumeTurns(session!.id, /declined the access request/));
  assert.equal(resolution.length, 1);
  assert.equal((await decide(made.ask.id, "U_ALICE", "once")).ask.status, "declined", "a decided card stays decided");
});

for (const kind of ["channel", "group", "project"] as const) {
  for (const requesterId of ["U_ALICE", "U_BOB"]) {
    it(`${kind} scheduled request for ${requesterId === "U_ALICE" ? "own" : "another person's"} credential requires approval and resumes in place`, async () => {
      let scope: CapabilityClaims["scopeId"] = "channel:C_INFRA";
      let scopeVersion: string | undefined;
      if (kind === "group") {
        scope = "group:G_SHARED";
        await built.app.upsertGroups([
          { groupId: "G_SHARED", principalId: "U_ALICE" },
          { groupId: "G_SHARED", principalId: "U_BOB" },
        ]);
      } else if (kind === "project") {
        const project = await built.app.createProject("U_ALICE", `Approval QA ${requesterId}`);
        assert.ok(project);
        assert.equal((await built.app.addProjectMember(project.id, "U_ALICE", "U_BOB")).status, "ok");
        scope = project.scopeId;
        scopeVersion = await built.projects.version(scope.slice("group:".length));
      }
      const credential = await built.keychain!.save({
        ownerId: "U_ALICE",
        service: `shared-${kind}-${requesterId}`,
        secret: "synthetic-shared-value",
        envKey: "SHARED_QA_TOKEN",
      });
      const cron = await built.app.createCron({
        owner: requesterId,
        createdBy: requesterId,
        ownerScopeId: scope,
        title: "Shared credential QA",
        action: "run the synthetic shared check",
        schedule: { firstFireAt: Date.now() + 3600000 },
      });
      const threadRef = `cron:${cron.id}:fire:first`;
      const token = await capFor(requesterId, scope, {
        triggered: true,
        threadRef,
        ...(scopeVersion ? { scopeVersion } : {}),
      });
      const seed = await built.app.turn({
        surface: "cron",
        origin: { kind: "automation" },
        actor: { externalId: requesterId },
        conversation: {
          kind: kind === "channel" ? "channel" : "group",
          threadRef,
          channelRef: scope.slice(scope.indexOf(":") + 1),
          audience: [{ externalId: "U_ALICE" }, { externalId: "U_BOB" }],
        },
        text: "waiting for permission for a synthetic shared job",
      } as TurnRequest);
      assert.equal(seed.status, "ok");
      const session = await built.sessions.getByThread(threadRef);
      assert.ok(session);
      const made = await post(
        "/v1/keychain/asks",
        { credential: credential.id, purpose: "run the synthetic shared check" },
        token,
      );
      assert.equal(made.status, 200, await made.clone().text());
      const { ask } = (await made.json()) as any;
      assert.equal(ask.ownerId, "U_ALICE");
      assert.equal(ask.requesterId, requesterId);
      const notices = (await built.posts.pending("principal")).filter(
        (d) => d.idempotencyKey === `ask:${ask.id}:notice`,
      );
      assert.equal(notices.length, 1);
      assert.equal(notices[0]!.destination.target, "U_ALICE");
      assert.match(notices[0]!.text, /Scheduled task "Shared credential QA"/);
      if (kind === "project") assert.match(notices[0]!.text, /Approval QA/);
      assert.ok(!notices[0]!.text.includes("synthetic-shared-value"));
      assert.ok(!notices[0]!.text.includes(ask.id) && !notices[0]!.text.includes(ask.purpose));
      if (requesterId !== "U_ALICE")
        await assert.rejects(decide(ask.id, requesterId, "once"), (e: KeychainError) => e.status === 403);
      const view = await decide(ask.id, "U_ALICE", "once");
      const grant = (await built.keychain!.getGrant(view.ask.grantId!))!;
      assert.equal(grant.audienceScopeId, scope);
      const resumed = await waitFor(() => resumeTurns(session.id, /The credential owner approved access/));
      assert.equal(resumed.length, 1);
    });
  }
}

it("shared background requests reject nonmembers, outsiders, stale project membership and inaccessible credentials", async () => {
  const credential = await built.keychain!.save({
    ownerId: "U_ALICE",
    service: "shared-private-gates",
    secret: "dummy",
    envKey: "QA_TOKEN",
  });
  await built.app.upsertDirectory([
    { principalId: "U_ALICE", displayName: "Alice", type: "internal" },
    { principalId: "U_BOB", displayName: "Bob", type: "internal" },
    { principalId: "U_EVE", displayName: "Eve", type: "internal" },
    { principalId: "U_EXTERNAL", displayName: "External", type: "guest" },
  ]);
  await built.app.upsertGroups([
    { groupId: "G_GUEST_QA", principalId: "U_ALICE" },
    { groupId: "G_GUEST_QA", principalId: "U_EXTERNAL" },
  ]);
  const external = await built.keychain!.save({
    ownerId: "U_EXTERNAL",
    service: "external-gate",
    secret: "dummy",
    envKey: "QA_TOKEN",
  });
  for (const [actor, scope, credentialId] of [
    ["U_BOB", "channel:C_NOALICE", credential.id],
    ["U_EVE", "channel:C_INFRA", credential.id],
    ["U_BOB", "group:G_UNKNOWN", credential.id],
    ["U_BOB", "channel:C_PUBLIC", external.id],
    ["U_EXTERNAL", "group:G_GUEST_QA", credential.id],
    ["U_BOB", "personal:U_BOB", credential.id],
  ] as const) {
    assert.equal(
      (
        await post(
          "/v1/keychain/asks",
          { credential: credentialId, purpose: "denied check" },
          await capFor(actor, scope, { triggered: true }),
        )
      ).status,
      403,
      `${actor} in ${scope} requesting ${credentialId}`,
    );
  }
  const project = await built.app.createProject("U_BOB", "Membership check");
  assert.ok(project);
  await built.app.addProjectMember(project.id, "U_BOB", "U_ALICE");
  const scopeVersion = await built.projects.version(project.scopeId.slice("group:".length));
  const stale = await capFor("U_BOB", project.scopeId, { triggered: true, scopeVersion });
  await built.app.removeProjectMember(project.id, "U_BOB", "U_ALICE");
  assert.equal(
    (await post("/v1/keychain/asks", { credential: credential.id, purpose: "stale check" }, stale)).status,
    403,
  );
});

for (const mode of ["once", "standing"] as const) {
  it(`personal scheduled request waits for approval, resumes its original thread, and respects ${mode} grants`, async () => {
    const threadRef = `dm:U_ALICE-cron-${mode}`;
    const personal = scopeId("personal", "U_ALICE");
    const token = await capFor("U_ALICE", personal, { triggered: true, threadRef });
    const live = await capFor("U_ALICE", personal, { liveActor: true });
    const { credential } = (await (
      await post(
        "/v1/keychain/credentials",
        { service: `cron-${mode}`, secret: "dummy-cron-value", envKey: "CRON_QA_TOKEN" },
        live,
      )
    ).json()) as any;
    const seed = await built.app.turn({
      origin: { kind: "direct" },
      surface: "slack",
      actor: { externalId: "U_ALICE" },
      conversation: { kind: "dm", threadRef },
      text: "waiting for scheduled credential approval",
    } as TurnRequest);
    assert.equal(seed.status, "ok");
    const session = await built.sessions.getByThread(threadRef);
    assert.ok(session);
    const requested = await post(
      "/v1/keychain/asks",
      { credential: credential.id, purpose: "read-only dummy scheduled check", requestedMode: mode },
      token,
    );
    assert.equal(requested.status, 200);
    const { ask } = (await requested.json()) as any;
    assert.equal(ask.status, "pending");
    assert.equal(
      (await built.keychain!.listGrants({ audienceScopeId: personal })).filter((g) => g.credentialId === credential.id)
        .length,
      0,
    );
    const duplicate = (await (
      await post("/v1/keychain/asks", { credential: credential.id, purpose: "retry" }, token)
    ).json()) as any;
    assert.equal(duplicate.ask.id, ask.id);
    assert.equal(duplicate.existing, true);
    const notices = (await built.posts.pending("principal")).filter((d) => d.idempotencyKey === `ask:${ask.id}:notice`);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.destination.target, "U_ALICE");
    assert.match(notices[0]!.text, /A task in your personal conversation wants to use/);
    assert.ok(!notices[0]!.text.includes("dummy-cron-value"));
    await assert.rejects(decide(ask.id, "U_BOB", mode), (e: KeychainError) => e.status === 403);
    const view = await decide(ask.id, "U_ALICE", mode);
    assert.equal(view.mode, mode);
    const approved = { grant: (await built.keychain!.getGrant(view.ask.grantId!))! };
    assert.equal(approved.grant.audienceScopeId, personal);
    const resumed = await waitFor(() => resumeTurns(session.id, /The credential owner approved access/));
    assert.equal(resumed.length, 1);
    const prepared = await built.keychain!.prepareMaterialize(approved.grant.id, personal, "U_ALICE");
    await prepared.commit();
    if (mode === "once")
      await assert.rejects(
        built.keychain!.prepareMaterialize(approved.grant.id, personal, "U_ALICE"),
        (e: KeychainError) => e.status === 410,
      );
    const after = (await built.keychain!.getGrant(approved.grant.id))!;
    assert.equal(after.status, mode === "once" ? "used" : "active");
    if (mode === "once") assert.ok(after.usedAt !== undefined);
    assert.equal(after.expiresAt, approved.grant.expiresAt);
    if (mode === "standing") {
      assert.equal((await post(`/v1/keychain/grants/${approved.grant.id}/revoke`, {}, live)).status, 200);
    }
  });
}

it("a scheduled personal request can be declined without granting access", async () => {
  const live = await capFor("U_ALICE", "personal:U_ALICE", { liveActor: true });
  const token = await capFor("U_ALICE", "personal:U_ALICE", { triggered: true });
  const { credential } = (await (
    await post("/v1/keychain/credentials", { service: "cron-decline", secret: "dummy", envKey: "CRON_QA_TOKEN" }, live)
  ).json()) as any;
  const { ask } = (await (
    await post("/v1/keychain/asks", { credential: credential.id, purpose: "dummy declined check" }, token)
  ).json()) as any;
  await assert.rejects(decide(ask.id, "U_BOB", "deny"), (e: KeychainError) => e.status === 403);
  assert.equal((await decide(ask.id, "U_ALICE", "deny")).ask.status, "declined");
  assert.equal((await built.keychain!.getAsk(ask.id))?.status, "declined");
  assert.equal(
    (
      await post(
        "/v1/keychain/asks",
        { credential: credential.id, purpose: "wrong scope" },
        await capFor("U_ALICE", "personal:U_BOB", { triggered: true }),
      )
    ).status,
    403,
  );
});

it("expiry: the scheduler sweep fires exactly one expired-resolution turn into the asking channel", async () => {
  const { credential } = (await (
    await post(
      "/v1/keychain/credentials",
      { service: "vercel", secret: "v_alice", envKey: "VERCEL_TOKEN" },
      await capFor("U_ALICE"),
    )
  ).json()) as any;
  const made = (await (
    await post(
      "/v1/keychain/asks",
      { credential: credential.id, purpose: "ship the preview", expiresAt: Date.now() + 80 },
      await bobInInfra(),
    )
  ).json()) as any;
  await new Promise((r) => setTimeout(r, 120));

  const session = await built.sessions.getByThread("ch:C_INFRA-thread");
  assert.ok(session);
  await built.sweepAsks(Date.now());
  const resolved = await waitFor(() => resumeTurns(session!.id, /did not answer the access request/));
  assert.equal(resolved.length, 1, "exactly one expired-resolution turn in the asking thread");
  assert.ok(!(resolved[0]!.text ?? "").includes(made.ask.id));

  await built.sweepAsks(Date.now());
  assert.equal(
    (await resumeTurns(session!.id, /did not answer the access request/)).length,
    1,
    "a second sweep refires nothing — notifiedAt + fireKey both hold",
  );
});

test("turn e2e: trigger-fired turns mint `triggered` into the capability token; threadRef is carried", async () => {
  const built = buildTestApp(testConfig({ signingSecret: SECRET, apiBaseUrl: "http://core.test" }));
  // The recorded script is the backend's OUTER `sh -c` wrapper, so the export's single quotes
  // arrive shell-escaped — match the token's own alphabet instead of the quoting around it.
  const extractToken = (since: number): CapabilityClaims | null => {
    for (const script of fakeSprites.execScripts().slice(since)) {
      const m = /export AGENT_API_TOKEN=\W*([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(script);
      if (!m) continue;
      const token = m[1]!;
      return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as CapabilityClaims;
    }
    return null;
  };

  await selectDefaultSandbox(built, "U_ALICE", "channel:C9");
  let mark = fakeSprites.execScripts().length;
  const turn = (triggered: boolean): TurnRequest =>
    ({
      surface: triggered ? "keychain-ask" : "slack",
      actor: { externalId: "U_ALICE" },
      conversation: { kind: "channel", threadRef: "ch:C9-t", channelRef: "C9", audience: [{ externalId: "U_ALICE" }] },
      text: "!run true",
      origin: triggered ? { kind: "automation" } : { kind: "direct" },
    }) as TurnRequest;

  assert.equal((await built.app.turn(turn(false))).status, "ok");
  const human = extractToken(mark);
  assert.ok(human, "the turn exported a capability token into the sandbox");
  assert.equal(human!.triggered, undefined, "a surface-authenticated human turn carries no triggered claim");
  assert.equal(human!.threadRef, "ch:C9-t", "the token carries the conversation threadRef for ask continuity");

  mark = fakeSprites.execScripts().length;
  assert.equal((await built.app.turn(turn(true))).status, "ok");
  const fired = extractToken(mark);
  assert.ok(fired);
  assert.equal(fired!.triggered, true, "a trigger-fired turn's token says so — consent routes refuse it");
});
