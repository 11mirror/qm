import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, deploymentView } from "../../../src/api/app.ts";
import {
  resolveShareTarget,
  renameDeployment,
  archiveDeployment,
  restoreDeployment,
  getDeployment,
  setDeploymentDisplayName,
} from "../../../src/api/routes/deployments.ts";
import type { ApiCtx } from "../../../src/api/routes/route.ts";
import type { CapabilityClaims } from "../../../src/auth/capability-token.ts";
import type { RecipientResolution } from "../../../src/directory/directory-store.ts";
import { scopeId } from "../../../src/types.ts";
import {
  type Dir,
  makeDeploy,
  apiHarness,
  cap,
  callShare,
  callManage,
  toolCtx,
} from "../../support/deployment-share.ts";

const one = (principalId: string, displayName: string): RecipientResolution => ({
  kind: "one",
  member: { principalId, displayName, type: "internal" },
});

function callDetail(app: ReturnType<typeof createApp>, capability: CapabilityClaims, id: string) {
  const out: { status?: number; body?: any } = {};
  const res = {
    getHeader() {},
    writeHead(s: number) {
      out.status = s;
    },
    end(d?: string) {
      out.body = d ? JSON.parse(d) : undefined;
    },
  };
  const ctx = {
    res,
    app,
    params: { id },
    capability,
    secret: "test-secret",
    deps: { apiBaseUrl: "https://api.example", publicUrl: "https://web.example" },
    url: new URL(`http://localhost/v1/deployments/${id}`),
    req: { headers: { host: "localhost" } },
  } as unknown as ApiCtx;
  return getDeployment(ctx).then(() => out);
}

test("manage endpoints (rename/display-name/archive): agent capability is owner-scoped, source auth is trusted", async () => {
  const { app, deploy } = apiHarness();
  const d = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "owned",
  });

  assert.equal((await callManage(renameDeployment, app, cap("U2"), d.id, { name: "hijack" })).status, 403);
  assert.equal(
    (await callManage(setDeploymentDisplayName, app, cap("U2"), d.id, { displayName: "Hijack" })).status,
    403,
  );
  assert.equal((await callManage(archiveDeployment, app, cap("U2"), d.id, {})).status, 403);

  assert.equal(
    (await callManage(setDeploymentDisplayName, app, cap("U1"), d.id, { displayName: "Owned" })).status,
    200,
  );
  assert.equal((await callManage(renameDeployment, app, cap("U1"), d.id, { name: "renamed" })).status, 200);

  assert.equal((await callManage(archiveDeployment, app, null, d.id, {})).status, 200);
  assert.equal((await deploy.reachDeployment("renamed", "U1")).status, "not_found");
});

test("deployment detail is viewer-gated and fixes the permission/gitUrl wire contract", async () => {
  const { app } = apiHarness();
  const d = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "details",
  });

  const visible = await callDetail(app, cap("U1"), d.id);
  assert.equal(visible.status, 200);
  assert.equal(visible.body.deployment.permission, "write");
  assert.equal(typeof visible.body.deployment.gitUrl, "string");
  assert.equal(new URL(visible.body.deployment.gitUrl).origin, "https://api.example");
  assert.equal(visible.body.deployment.currentVersion, 1);
  assert.equal(typeof visible.body.deployment.versions[0].createdAt, "number");
  assert.equal(visible.body.deployment.versions[0].snapshotDir, undefined);
  assert.equal(visible.body.deployment.versions[0].entrypoint, undefined);
  assert.equal(visible.body.deployment.publicUrl, undefined);
  assert.equal((await callDetail(app, cap("U3"), d.id)).status, 404);
});

test("deployment projections omit runtime secrets and local paths", async () => {
  const { app } = apiHarness();
  const d = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    env: { SECRET: "value" },
  });
  const stored = (await app.listDeployments()).find((row) => row.id === d.id)!;
  stored.endpoint = {
    host: "internal",
    port: 123,
    publicUrl: "https://app.example",
    proxyHeaders: { authorization: "secret" },
  };
  const view = deploymentView(stored) as Record<string, any>;

  assert.equal(view.publicUrl, undefined);
  assert.equal(view.endpoint, undefined);
  assert.equal(view.versions[0].env, undefined);
  assert.equal(view.versions[0].snapshotDir, undefined);
  assert.equal(view.versions[0].homeDir, undefined);
  assert.equal(view.versions[0].entrypoint, undefined);
  assert.equal(view.versions[0].image, undefined);
});

test("restore endpoint is manage-gated and reactivates the archived current version", async () => {
  const { app } = apiHarness();
  const d = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "restore-me",
  });
  await app.archiveDeployment(d.id);

  assert.equal((await callManage(restoreDeployment, app, cap("U2"), d.id, {})).status, 403);
  const restored = await callManage(restoreDeployment, app, cap("U1"), d.id, {});
  assert.equal(restored.status, 200);
  assert.equal(restored.body.deployment.status, "running");
  assert.equal(restored.body.deployment.currentVersion, 1);
  assert.equal(restored.body.deployment.permission, "write");
  assert.equal(restored.body.deployment.endpoint, undefined);
  assert.equal(restored.body.deployment.publicUrl, undefined);
  assert.equal(restored.body.deployment.versions[0].snapshotDir, undefined);

  await app.archiveDeployment(d.id);
  const restoredBySlug = await callManage(restoreDeployment, app, cap("U1"), "restore-me", {});
  assert.equal(restoredBySlug.status, 200);
  assert.equal(restoredBySlug.body.deployment.id, d.id);
});

test('share endpoint: "everyone" grants org reach — a non-owner can reach it; access:none re-denies', async () => {
  const { app, deploy } = apiHarness();
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "dead-reckoning",
  });
  assert.equal((await deploy.reachDeployment("dead-reckoning", "U2")).status, "denied");

  const r = await callShare(app, cap("U1"), "dead-reckoning", { scope: "org" });
  assert.equal(r.status, 200);
  assert.equal(r.body.target.scope, scopeId("org", "default-org"));
  assert.match(r.body.reach, /everyone in default-org/);
  assert.equal((await deploy.reachDeployment("dead-reckoning", "U2")).status, "ok");

  const off = await callShare(app, cap("U1"), "dead-reckoning", { scope: "org", access: "none" });
  assert.equal(off.status, 200);
  assert.equal((await deploy.reachDeployment("dead-reckoning", "U2")).status, "denied");
});

test("share endpoint: recipient resolves a teammate via the directory → only that person reaches", async () => {
  const directory: Dir = {
    resolve: async (q) => (q.toLowerCase() === "carol" ? one("U-carol", "Carol") : { kind: "none" }),
  };
  const { app, deploy } = apiHarness(directory);
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "memos",
  });

  const r = await callShare(app, cap("U1"), "memos", { recipient: "carol" });
  assert.equal(r.status, 200);
  assert.equal(r.body.target.scope, scopeId("personal", "U-carol"));
  assert.equal((await deploy.reachDeployment("memos", "U-carol")).status, "ok");
  assert.equal((await deploy.reachDeployment("memos", "U-other")).status, "denied");

  assert.equal((await callShare(app, cap("U1"), "memos", { recipient: "nobody" })).status, 404);
});

test("share endpoint: only the owner can share (non-owner capability → 403)", async () => {
  const { app } = apiHarness();
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "owned",
  });
  const r = await callShare(app, cap("U2"), "owned", { scope: "org" });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "forbidden");
  assert.match(r.body.message, /only the owner/);
});

test("share endpoint: unknown app → 404; no capability → 403; bad/ambiguous/missing args → 400", async () => {
  const { app } = apiHarness();
  const ghost = await callShare(app, cap("U1"), "ghost", { scope: "org" });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.body.error, "not_found");
  const ghostPublic = await callShare(app, cap("U1"), "ghost", { public: true });
  assert.equal(ghostPublic.status, 404);
  assert.equal(ghostPublic.body.error, "not_found");
  assert.equal((await callShare(app, null, "ghost", { scope: "org" })).status, 403);
  await app.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [], name: "a" });
  assert.equal(
    (await callShare(app, cap("U1"), "a", { scope: "org", access: "bogus" })).status,
    400,
    "bad access → 400",
  );
  assert.equal((await callShare(app, cap("U1"), "a", {})).status, 400, "no target → 400");
  assert.equal((await callShare(app, cap("U1"), "a", { public: "yes" })).status, 400, "public is boolean");
  assert.equal(
    (await callShare(app, cap("U1"), "a", { public: true, scope: "org" })).status,
    400,
    "public and authenticated targets change separately",
  );
  assert.equal(
    (await callShare(app, cap("U1"), "a", { scope: "org", recipient: "carol" })).status,
    400,
    "both targets → 400",
  );
  assert.equal((await callShare(app, cap("U1"), "a", { scope: "not-a-scope" })).status, 400, "bad scope id → 400");
});

test("share endpoint: access:manage grants write (reach + manage)", async () => {
  const directory: Dir = { resolve: async () => one("U-eng", "Eng") };
  const { app, deploy } = apiHarness(directory);
  await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "mgmt",
  });
  const r = await callShare(app, cap("U1"), "mgmt", { recipient: "eng", access: "manage" });
  assert.equal(r.status, 200);
  assert.deepEqual(await deploy.deploymentGrantees("mgmt"), [
    { scope: scopeId("personal", "U-eng"), permission: "write" },
  ]);
});

test('resolveShareTarget: scope "org"→org, scope id verbatim, recipient→personal, none/ambiguous/invalid', async () => {
  const directory: Dir = {
    resolve: async (q) => {
      if (q === "ann") return one("U-ann", "Ann");
      if (q === "j") {
        return {
          kind: "ambiguous",
          candidates: [
            { principalId: "a", displayName: "J A", type: "internal" },
            { principalId: "b", displayName: "J B", type: "internal" },
          ],
        };
      }
      return { kind: "none" };
    },
  };
  const { app } = apiHarness(directory);
  assert.deepEqual(await resolveShareTarget(app, { scope: "org" }), {
    kind: "ok",
    scope: "org:default-org",
    label: "everyone in the org",
  });
  assert.deepEqual(await resolveShareTarget(app, { scope: "personal:U9" }), {
    kind: "ok",
    scope: "personal:U9",
    label: "personal:U9",
  });
  assert.deepEqual(await resolveShareTarget(app, { recipient: "ann" }), {
    kind: "ok",
    scope: "personal:U-ann",
    label: "Ann",
  });
  assert.equal((await resolveShareTarget(app, { recipient: "ghost" })).kind, "none");
  assert.equal((await resolveShareTarget(app, { recipient: "j" })).kind, "ambiguous");
  assert.equal((await resolveShareTarget(app, {})).kind, "invalid");
  assert.equal((await resolveShareTarget(app, { scope: "nope" })).kind, "invalid");
});

test("publish keeps apps private by default and refuses a public flag at publish time", async () => {
  const { deploy } = makeDeploy();
  const privateApp = await toolCtx(deploy).publish({ entrypoint: "x", name: "private-app" });
  assert.equal(privateApp.public, undefined);
  assert.equal((await deploy.getDeployment("private-app"))?.public, undefined);

  await assert.rejects(
    () => toolCtx(deploy).publish({ entrypoint: "x", name: "public-app", public: true }),
    /apps action share/,
  );
  assert.equal(await deploy.getDeployment("public-app"), null);
});

test("transferDeploymentOwner re-homes the app to the teammate: they own it, prior grants survive, the giver keeps reach", async () => {
  const { deploy, acl } = makeDeploy();
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "handover",
  });
  await deploy.shareDeployment(d.id, scopeId("personal", "U3"), "read", { createdBy: "U1" });

  await deploy.transferDeploymentOwner("handover", scopeId("personal", "V1"), { callerId: "U1" });

  const after = (await deploy.listDeployments()).find((x) => x.id === d.id)!;
  assert.equal(after.ownerScopeId, scopeId("personal", "V1"), "the teammate is now the owner (home scope)");
  assert.equal(after.createdBy, "U1", "the immutable creator is untouched (provenance)");

  assert.equal((await deploy.reachDeployment("handover", "V1")).status, "ok");
  assert.equal((await deploy.reachDeployment("handover", "U3")).status, "ok", "prior grants are re-keyed, not dropped");
  assert.equal((await deploy.reachDeployment("handover", "U1")).status, "ok", "the giver isn't locked out");
  assert.equal((await deploy.reachDeployment("handover", "U9")).status, "denied");

  assert.equal((await acl.grantsFor(scopeId("personal", "U1"), `deployment:${d.id}`)).length, 0);

  await deploy.shareDeployment(d.id, scopeId("personal", "U4"), "read", { createdBy: "V1" });
  assert.equal((await deploy.reachDeployment("handover", "U4")).status, "ok");
  await assert.rejects(
    () => deploy.shareDeployment(d.id, scopeId("personal", "U5"), "read", { createdBy: "U1" }),
    /only the owner/,
  );
});

test("a manage grantee may redeploy but cannot make the owner's app public", async () => {
  const { deploy } = makeDeploy();
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "managed-private",
  });
  await deploy.shareDeployment(d.id, scopeId("personal", "U2"), "write", { createdBy: "U1" });
  assert.equal((await deploy.getDeployment(d.id))?.public, undefined);
});

test("republish, rename and rollback never change visibility; only the separate public toggle does", async () => {
  const { deploy } = makeDeploy();
  const owner = { ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [] };
  const d = await deploy.deployOrUpdate({ ...owner, name: "vis" });
  assert.equal(d.public, undefined, "first publish is private by default");
  await deploy.deployOrUpdate({ ...owner, name: "vis" });
  const after = await deploy.getDeployment(d.id);
  assert.equal(after?.public, undefined);
  assert.equal(after?.name, "vis");
  assert.equal((await deploy.reachDeployment("vis", "U2")).status, "denied");
  await deploy.setDeploymentPublic(d.id, true, { createdBy: "U1" });
  assert.equal((await deploy.getDeployment(d.id))?.public, true);
  await deploy.deployOrUpdate({ ...owner, name: "vis" });
  await deploy.deployOrUpdate({ ...owner, name: "vis2", renameFrom: "vis" });
  await deploy.deployOrUpdate({ ...owner, name: "vis2", rollbackTo: 1 });
  assert.equal((await deploy.getDeployment(d.id))?.public, true, "republish, rename and rollback keep the setting");
});

test("transferDeploymentOwner is home authority — a write ('manage') grantee cannot give the app away", async () => {
  const { deploy } = makeDeploy();
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "kept",
  });
  await deploy.shareDeployment(d.id, scopeId("personal", "U2"), "write", { createdBy: "U1" });
  assert.equal(await deploy.canManageDeployment(d.id, "U2"), true, "U2 can manage…");
  await assert.rejects(
    () => deploy.transferDeploymentOwner("kept", scopeId("personal", "U2"), { callerId: "U2" }),
    /only the owner/,
  );
  const after = (await deploy.listDeployments()).find((x) => x.id === d.id)!;
  assert.equal(after.ownerScopeId, scopeId("personal", "U1"), "…but not take ownership");
});

test("transferDeploymentOwner to the current home is a no-op", async () => {
  const { deploy, acl } = makeDeploy();
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "same",
  });
  await deploy.transferDeploymentOwner("same", scopeId("personal", "U1"), { callerId: "U1" });
  const after = (await deploy.listDeployments()).find((x) => x.id === d.id)!;
  assert.equal(after.ownerScopeId, scopeId("personal", "U1"));
  assert.equal((await acl.list()).length, 0, "no self-grant sprayed by a no-op transfer");
});
