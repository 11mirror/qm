import { authBrokerRoutes } from "../../../src/api/routes/auth-broker.ts";
import { createControlService } from "../../../src/api/control-service.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../../src/api/app.ts";
import { createIdentityService } from "../../../src/identity/identity-service.ts";
import { getDeploymentShares } from "../../../src/api/routes/deployments.ts";
import { type ApiCtx, respond } from "../../../src/api/routes/route.ts";
import { scopeId } from "../../../src/types.ts";
import type { FeatureFlagStore } from "../../../src/feature-flags.ts";
import { createPostgresDirectoryStore } from "../../../src/directory/postgres-directory-store.ts";
import { testAdvisoryLock, testDatabaseUrl, testMap } from "../../support/test-database.ts";
import {
  externalSharingOn,
  makeDeploy,
  apiHarness,
  cap,
  callShare,
  callManage,
  toolCtx,
} from "../../support/deployment-share.ts";

test("deployment public access is explicit, owner-only, and reversible", async () => {
  const { app } = apiHarness();
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "public-toggle",
  });

  const initial = await callManage(getDeploymentShares, app, cap("U1"), "public-toggle", {});
  assert.equal(initial.status, 200);
  assert.equal(initial.body.public, false, "apps are private by default");

  const denied = await callShare(app, cap("U2"), "public-toggle", { public: true });
  assert.equal(denied.status, 403, "only the owner may make an app public");
  assert.equal(denied.body.error, "forbidden");

  const enabled = await callShare(app, cap("U1"), "public-toggle", { public: true });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.public, true);
  assert.equal((await app.getDeployment("public-toggle"))?.public, true);

  const sharedWhilePublic = await callShare(app, cap("U1"), "public-toggle", {
    scope: "personal:U2",
    access: "view",
  });
  assert.equal(sharedWhilePublic.body.public, true, "person changes preserve and return general access");
  const off = { enabled: async () => false } as unknown as FeatureFlagStore;
  const orgWhileOff = await callShare(app, cap("U1"), "public-toggle", { scope: "org" }, off);
  assert.equal(orgWhileOff.body.public, false, "with external sharing off, a stored public bit is reported as off");

  const disabled = await callShare(app, cap("U1"), "public-toggle", { public: false });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.public, false);
  assert.equal((await app.getDeployment("public-toggle"))?.public, undefined);
});

test("without an apps domain, a public link is refused on the share route and the agent's apps tool", async () => {
  const { deploy } = makeDeploy(undefined, true, false);
  const app = createApp({
    advisoryLock: testAdvisoryLock(),
    deploy,
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
  } as unknown as Parameters<typeof createApp>[0]);
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "path-only",
  });
  const refused = await callShare(app, cap("U1"), "path-only", { public: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "public_links_unavailable");
  await assert.rejects(
    () => toolCtx(deploy).setDeploymentPublic("path-only", true),
    /Public links need an apps domain/,
  );
  assert.equal((await app.getDeployment("path-only"))?.public, undefined);
  assert.equal((await callShare(app, cap("U1"), "path-only", { public: false })).status, 200);
});

test("with external app sharing off, public links and outside emails are refused while org sharing still works", async () => {
  const { deploy } = makeDeploy(async (email) => email.endsWith("@acme.test"), false);
  const app = createApp({
    advisoryLock: testAdvisoryLock(),
    deploy,
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
  } as unknown as Parameters<typeof createApp>[0]);
  const off = { enabled: async () => false } as unknown as FeatureFlagStore;
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "locked",
  });

  const shares = await callManage(getDeploymentShares, app, cap("U1"), "locked", {}, off);
  assert.equal(shares.body.externalSharing, false);

  const makePublic = await callShare(app, cap("U1"), "locked", { public: true }, off);
  assert.equal(makePublic.status, 403);
  assert.equal(makePublic.body.error, "external_sharing_disabled");
  assert.equal((await app.getDeployment("locked"))?.public, undefined);
  assert.equal((await callShare(app, cap("U1"), "locked", { public: false }, off)).status, 200);

  const outside = await callShare(app, cap("U1"), "locked", { email: "guest@elsewhere.test" }, off);
  assert.equal(outside.status, 403);
  assert.equal(outside.body.error, "external_sharing_disabled");

  const member = await callShare(app, cap("U1"), "locked", { email: "teammate@acme.test" }, off);
  assert.equal(member.status, 200);
  const org = await callShare(app, cap("U1"), "locked", { scope: "org" }, off);
  assert.equal(org.status, 200);
  assert.deepEqual((await deploy.deploymentGrantees("locked")).map((g) => g.scope).sort(), [
    "org:default-org",
    "personal:teammate@acme.test",
  ]);

  const d = (await app.getDeployment("locked"))!;
  await assert.rejects(
    app.grant({
      ownerScopeId: d.ownerScopeId,
      ref: `deployment:${d.id}`,
      granteeScopeId: scopeId("personal", "guest@elsewhere.test"),
      permission: "read",
      grantedBy: "U1",
    }),
    /external_app_sharing/,
  );
  assert.ok(!(await deploy.deploymentGrantees("locked")).some((g) => g.scope === "personal:guest@elsewhere.test"));
});

test("deployment permissions are visible only to the owner, including for managers", async () => {
  const { app } = apiHarness();
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "permissions",
  });
  await callShare(app, cap("U1"), "permissions", { scope: "personal:U2", access: "manage" });
  const owner = await callManage(getDeploymentShares, app, cap("U1"), "permissions", {});
  assert.equal(owner.status, 200);
  assert.deepEqual(owner.body.grantees, [{ scope: "personal:U2", permission: "write" }]);
  assert.equal((await callManage(getDeploymentShares, app, cap("U2"), "permissions", {})).status, 403);
  assert.equal((await callManage(getDeploymentShares, app, null, "permissions", {})).status, 403);
  assert.equal((await callManage(getDeploymentShares, app, cap("U1"), "missing", {})).status, 404);
  await callShare(app, cap("U1"), "permissions", { scope: "personal:U2", access: "none" });
  assert.deepEqual((await callManage(getDeploymentShares, app, cap("U1"), "permissions", {})).body.grantees, []);
});

test("app email grants normalize, dedupe, revoke, and reject external manage without changing the grant", async () => {
  const { app, deploy } = apiHarness();
  await app.deploy({ ownerScopeId: "personal:U1", createdBy: "U1", entrypoint: "x", files: [], name: "email-app" });
  for (const email of ["  Invitee@Example.com  ", "invitee@example.com"]) {
    const r = await callShare(app, cap("U1"), "email-app", { email });
    assert.equal(r.status, 200);
    assert.equal(r.body.target.scope, "personal:invitee@example.com");
  }
  const expected = [{ scope: "personal:invitee@example.com", permission: "read" }];
  assert.deepEqual(await deploy.deploymentGrantees("email-app"), expected);
  assert.equal((await deploy.reachDeployment("email-app", "invitee@example.com")).status, "ok");
  assert.equal((await deploy.reachDeployment("email-app", "other@example.com")).status, "denied");
  for (const body of [
    { email: "invitee@example.com", access: "manage" },
    { scope: "personal:invitee@example.com", access: "manage" },
    { email: "not an email" },
    { email: 123 },
    { email: "invitee@example.com", scope: "org" },
    { email: "invitee@example.com", recipient: "other" },
    { email: "invitee@example.com", public: true },
  ])
    assert.equal((await callShare(app, cap("U1"), "email-app", body)).status, 400);
  assert.equal((await callShare(app, cap("U2"), "email-app", { email: "other@example.com" })).status, 403);
  assert.deepEqual(await deploy.deploymentGrantees("email-app"), expected);
  assert.equal(
    (await callShare(app, cap("U1"), "email-app", { email: "INVITEE@example.com", access: "none" })).status,
    200,
  );
  assert.deepEqual(await deploy.deploymentGrantees("email-app"), []);
});

test("directory email recipients retain manage access", async () => {
  const { deploy } = makeDeploy(async (email) => email === "member@example.com");
  const d = await deploy.deploy({ ownerScopeId: "personal:U1", createdBy: "U1", entrypoint: "x", files: [] });
  await deploy.shareDeployment(d.id, "personal:Member@Example.com", "write", { createdBy: "U1" });
  assert.deepEqual(await deploy.deploymentGrantees(d.id), [
    { scope: "personal:member@example.com", permission: "write" },
  ]);
  assert.equal(await deploy.canManageDeployment(d.id, "member@example.com"), true);
});

test("exact email read grants admit app-only login and guest reach without membership or source access", async () => {
  const { deploy, acl } = makeDeploy();
  const identity = createIdentityService(testMap(), { externalMembers: testMap() });
  const directory = createPostgresDirectoryStore(testDatabaseUrl());
  const app = createApp({
    advisoryLock: testAdvisoryLock(),
    deploy,
    acl,
    identity,
    directory,
    auditLog: { record() {} },
  } as unknown as Parameters<typeof createApp>[0]);
  const d = await app.deploy({
    ownerScopeId: "personal:U1",
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "invite-test",
  });
  const email = "invitee@example.com";
  await identity.deactivate(email, "directory-sync");
  assert.equal(identity.classify(email).type, "guest");
  const allowed = async (email: string, featureFlags = externalSharingOn) => {
    let status: number | undefined;
    let body: unknown;
    const handle = authBrokerRoutes.find((r) => "path" in r && r.path.endsWith("email-allowed"))!.handle;
    await respond(handle, {
      app,
      deps: { identity, acl, featureFlags },
      url: new URL(`http://core/v1/auth/broker/email-allowed?email=${encodeURIComponent(email)}`),
      res: {
        getHeader() {},
        writeHead(s: number) {
          status = s;
        },
        end(s: string) {
          body = JSON.parse(s);
        },
      },
    } as unknown as ApiCtx);
    assert.equal(status, 200);
    return body;
  };
  assert.deepEqual(await allowed(email), { allowed: false });
  await app.shareDeployment(d.id, `personal:${email}`, "read", { createdBy: "U1" });
  assert.deepEqual(await allowed(" Invitee@Example.com "), { allowed: true, appOnly: true });
  assert.deepEqual(
    await allowed(email, { enabled: async () => false } as unknown as FeatureFlagStore),
    { allowed: false },
    "existing outside grants stop admitting sign-in while external sharing is off",
  );
  assert.deepEqual(await allowed("other@example.com"), { allowed: false });
  assert.equal(await app.effectiveDeploymentPermission(d, "Invitee@Example.com"), "read");
  assert.equal(await app.effectiveDeploymentPermission(d, "other@example.com"), null);
  assert.equal((await app.reachDeployment(d.id, email)).status, "ok");
  assert.equal(await app.directoryMember(email), null);
  assert.equal(identity.externalMember(email), undefined);
  assert.equal(identity.classify(email).type, "guest");
  await app.archiveDeployment(d.id);
  assert.deepEqual(await allowed(email), { allowed: false });
  await app.restoreDeployment(d.id, "U1");
  await identity.deactivate(email);
  assert.deepEqual(await allowed(email), { allowed: false });
  assert.equal(await app.effectiveDeploymentPermission(d, email), null);
  await identity.reactivate(email);
  await app.shareDeployment(d.id, `personal:${email}`, null, { createdBy: "U1" });
  assert.deepEqual(await allowed(email), { allowed: false });
  assert.equal(await app.effectiveDeploymentPermission(d, email), null);
  for (const grant of [
    { ref: `deployment:${d.id}`, granteeScopeId: `personal:${email}`, permission: "write" as const },
    { ref: "deployment:missing", granteeScopeId: `personal:${email}`, permission: "read" as const },
    { ref: `deployment:${d.id}`, granteeScopeId: "org:default-org" as const, permission: "read" as const },
  ])
    await acl.grant({ ownerScopeId: "personal:U1", grantedBy: "U1", ...grant });
  assert.deepEqual(
    await allowed(email),
    { allowed: false },
    "write, dangling and org grants do not admit an app-only login",
  );
});

test("uniform app share accepts exact emails and enforces view-only outside the directory", async () => {
  const { deploy, acl } = makeDeploy();
  const app = createApp({
    advisoryLock: testAdvisoryLock(),
    deploy,
    acl,
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    directory: createPostgresDirectoryStore(testDatabaseUrl()),
    auditLog: { record() {} },
  } as unknown as Parameters<typeof createApp>[0]);
  const d = await app.deploy({ ownerScopeId: "personal:U1", createdBy: "U1", entrypoint: "x", files: [] });
  const control = createControlService(app);
  const r = await control.shareArtifact({ type: "deploy", id: d.id, email: "Invitee@Example.com" }, cap("U1"));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.target.scope, "personal:invitee@example.com");
  const blocked = await control.shareArtifact(
    { type: "deploy", id: d.id, email: "invitee@example.com", permission: "write" },
    cap("U1"),
  );
  assert.equal(blocked.ok, false);
  assert.deepEqual(await deploy.deploymentGrantees(d.id), [
    { scope: "personal:invitee@example.com", permission: "read" },
  ]);
  const moved = await control.shareArtifact(
    { type: "deploy", id: d.id, email: "invitee@example.com", move: true },
    cap("U1"),
  );
  assert.equal(moved.ok, false);
});

test("new email grants send an app-specific invitation once; re-adds and revocations send nothing", async () => {
  const { deploy, acl } = makeDeploy();
  const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
  const app = createApp({
    advisoryLock: testAdvisoryLock(),
    deploy,
    acl,
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    deployAppsDomain: "apps.example.com",
    inviteMailer: {
      async send(message: (typeof sent)[number]) {
        sent.push(message);
        return "message-id";
      },
    },
  } as unknown as Parameters<typeof createApp>[0]);
  const d = await app.deploy({
    ownerScopeId: "personal:U1",
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "status-page",
  });
  await app.setDeploymentDisplayName(d.id, "Status <page>");
  const added = await callShare(app, cap("U1"), d.id, { email: "  Invitee@Example.com " });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.invitation, { emailSent: true, appUrl: "https://status-page.apps.example.com/" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, "invitee@example.com");
  assert.equal(sent[0]!.subject, "You've been invited to Status <page>");
  assert.match(sent[0]!.text, /Sign in using this email address \(invitee@example.com\)/);
  assert.match(sent[0]!.text, /https:\/\/status-page\.apps\.example\.com\//);
  assert.doesNotMatch(sent[0]!.text, /single-use|token=/);
  assert.match(sent[0]!.html, /Status &lt;page&gt;/);
  const repeated = await Promise.all(
    ["invitee@example.com", "INVITEE@example.com"].map((email) => callShare(app, cap("U1"), d.id, { email })),
  );
  assert.ok(repeated.every((r) => r.body.invitation.alreadyShared && !r.body.invitation.emailSent));
  assert.equal(sent.length, 1);
  await callShare(app, cap("U1"), d.id, { email: "invitee@example.com", access: "none" });
  assert.equal(sent.length, 1);
  const addedConcurrently = await Promise.all(
    ["other@example.com", "OTHER@example.com"].map((email) => callShare(app, cap("U1"), d.id, { email })),
  );
  assert.equal(addedConcurrently.filter((r) => r.body.invitation.emailSent).length, 1);
  assert.equal(sent.length, 2);
});

test("failed invitation delivery leaves the grant and reports the failure and manual app link", async () => {
  for (const mailer of [
    undefined,
    {
      async send() {
        throw new Error("mail unavailable");
      },
    },
  ]) {
    const { deploy, acl } = makeDeploy();
    const app = createApp({
      advisoryLock: testAdvisoryLock(),
      deploy,
      acl,
      identity: createIdentityService(testMap(), { externalMembers: testMap() }),
      deployAppsDomain: "apps.example.com",
      inviteMailer: mailer,
    } as unknown as Parameters<typeof createApp>[0]);
    const d = await app.deploy({
      ownerScopeId: "personal:U1",
      createdBy: "U1",
      entrypoint: "x",
      files: [],
      name: "status-page",
    });
    const added = await callShare(app, cap("U1"), d.id, { email: "invitee@example.com" });
    assert.equal(added.status, 200);
    assert.equal(added.body.invitation.emailSent, false);
    assert.match(added.body.invitation.emailProblem, mailer ? /mail unavailable/ : /not configured/);
    assert.equal(added.body.invitation.appUrl, "https://status-page.apps.example.com/");
    assert.deepEqual(await deploy.deploymentGrantees(d.id), [
      { scope: "personal:invitee@example.com", permission: "read" },
    ]);
  }
});

test("uniform app share uses the same invitation sender", async () => {
  const { deploy, acl } = makeDeploy();
  const sent: string[] = [];
  const app = createApp({
    advisoryLock: testAdvisoryLock(),
    deploy,
    acl,
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    directory: createPostgresDirectoryStore(testDatabaseUrl()),
    deployAppsDomain: "apps.example.com",
    inviteMailer: {
      async send(message: { to: string }) {
        sent.push(message.to);
        return "sent";
      },
    },
  } as unknown as Parameters<typeof createApp>[0]);
  const d = await app.deploy({ ownerScopeId: "personal:U1", createdBy: "U1", entrypoint: "x", files: [] });
  const result = await createControlService(app).shareArtifact(
    { type: "deploy", id: d.id, email: "invitee@example.com" },
    cap("U1"),
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.invitation?.emailSent, true);
  assert.deepEqual(sent, ["invitee@example.com"]);
});
