import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAclStore } from "../../src/acl/acl-store.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";
import { createApp } from "../../src/api/app.ts";
import { createInsecureTestServer } from "../../src/api/server.ts";
import { mintSignedPayload } from "../../src/auth/signed-token.ts";
import type { DeployProvider } from "../../src/deploy/deploy-provider.ts";
import { createDeployService } from "../../src/deploy/deploy-service.ts";
import {
  createDeployStore,
  type DeployEndpoint,
  type Deployment,
  type DeploymentVersion,
  type DeployStore,
} from "../../src/deploy/deploy-store.ts";
import { scopeId } from "../../src/types.ts";
import { singleProcessDeps } from "../support/single-process.ts";
import { testDeployBackings, testDatabaseUrl } from "../support/test-database.ts";
import { listenLocal } from "../support/listen-local.ts";

function svc(
  opts: {
    managedScaleToZero?: boolean;
    resolve?: () => Promise<DeployEndpoint | null>;
    apply?: DeployProvider["apply"];
  } = {},
) {
  const deployStore = createDeployStore(testDeployBackings());
  let applies = 0;
  let resolves = 0;
  const provider: DeployProvider = {
    profile: { managedScaleToZero: opts.managedScaleToZero ?? true },
    apply: async (d, version) => {
      applies++;
      if (opts.apply) return opts.apply(d, version);
      return { host: "127.0.0.1", port: 5000 };
    },
    resolveEndpoint: async (d) => d.endpoint,
    logs: async () => null,
    destroy: async () => {},
    ...(opts.resolve
      ? {
          resolveEndpoint: async () => {
            resolves++;
            return opts.resolve!();
          },
        }
      : {}),
  };
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore,
    provider,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    deployDir: mkdtempSync(join(tmpdir(), "always-on-")),
  });
  return {
    deploy,
    deployStore,
    get applies() {
      return applies;
    },
    get resolves() {
      return resolves;
    },
  };
}

const owner = { ownerScopeId: scopeId("personal", "U1"), createdBy: "U1" };

for (const operation of ["redeploy", "rollback"] as const) {
  for (const initial of [false, true]) {
    test(`failed ${operation} preserves always-on=${initial} and permits a subsequent settings retry`, async () => {
      let reject = false;
      const seen: Array<boolean | undefined> = [];
      const { deploy, deployStore } = svc({
        apply: async (d) => {
          seen.push(d.alwaysOn);
          if (reject) throw new Error("publication failed");
          return { host: "127.0.0.1", port: 5000 };
        },
      });
      const d = await deploy.deploy({ ...owner, entrypoint: "first", files: [], alwaysOn: initial });
      await deploy.redeploy(d.id, { entrypoint: "second", files: [] });
      const accepted = (await deployStore.get(d.id))!;
      reject = true;
      await assert.rejects(
        operation === "redeploy"
          ? deploy.redeploy(d.id, { entrypoint: "third", files: [], alwaysOn: !initial })
          : deploy.rollbackDeployment(d.id, 1, { alwaysOn: !initial }),
        /publication failed/,
      );
      assert.equal(seen.at(-1), !initial);
      const after = (await deployStore.get(d.id))!;
      assert.equal(!!after.alwaysOn, initial);
      assert.equal(after.appliedVersion, accepted.appliedVersion);
      assert.deepEqual(after.endpoint, accepted.endpoint);
      await deploy.setDeploymentAlwaysOn(d.id, !initial);
      assert.equal((await deployStore.get(d.id))!.alwaysOn, !initial);
    });
  }
}

test("setDeploymentAlwaysOn flips the flag on and off, and persists", async () => {
  const { deploy, deployStore } = svc();
  const d = await deploy.deploy({ ...owner, entrypoint: "x", files: [] });
  assert.equal((await deployStore.get(d.id))!.alwaysOn, undefined);

  const on = await deploy.setDeploymentAlwaysOn(d.id, true);
  assert.equal(on.alwaysOn, true);
  assert.equal((await deployStore.get(d.id))!.alwaysOn, true);

  const off = await deploy.setDeploymentAlwaysOn(d.id, false);
  assert.ok(!off.alwaysOn);
  assert.ok(!(await deployStore.get(d.id))!.alwaysOn);
});

test("deployOrUpdate carries alwaysOn on create and on update", async () => {
  const { deploy, deployStore } = svc();
  const d = await deploy.deployOrUpdate({ ...owner, name: "warm-app", entrypoint: "x", files: [], alwaysOn: true });
  assert.equal((await deployStore.get(d.id))!.alwaysOn, true);

  await deploy.deployOrUpdate({ ...owner, name: "warm-app", entrypoint: "x", files: [] });
  assert.equal((await deployStore.get(d.id))!.alwaysOn, true);

  await deploy.deployOrUpdate({ ...owner, name: "warm-app", entrypoint: "x", files: [], alwaysOn: false });
  assert.ok(!(await deployStore.get(d.id))!.alwaysOn);
});

test("alwaysOn is visible to the provider at first launch (not applied after the fact)", async () => {
  const deployStore = createDeployStore(testDeployBackings());
  const seen: Array<boolean | undefined> = [];
  const provider: DeployProvider = {
    profile: { managedScaleToZero: true },
    apply: async (d) => {
      seen.push(d.alwaysOn);
      return { host: "127.0.0.1", port: 5000 };
    },
    resolveEndpoint: async (d) => d.endpoint,
    logs: async () => null,
    destroy: async () => {},
  };
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore,
    provider,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    deployDir: mkdtempSync(join(tmpdir(), "always-on-")),
  });
  await deploy.deployOrUpdate({ ...owner, name: "warm-launch", entrypoint: "x", files: [], alwaysOn: true });
  assert.deepEqual(seen, [true]);
});

test("rename and rollback branches carry alwaysOn too", async () => {
  const { deploy, deployStore } = svc();
  const d = await deploy.deployOrUpdate({ ...owner, name: "app-a", entrypoint: "x", files: [] });
  await deploy.deployOrUpdate({ ...owner, name: "app-a", entrypoint: "x", files: [] });

  await deploy.deployOrUpdate({ ...owner, name: "app-b", renameFrom: "app-a", alwaysOn: true });
  assert.equal((await deployStore.get(d.id))!.alwaysOn, true);

  await deploy.deployOrUpdate({ ...owner, name: "app-b", rollbackTo: 1, alwaysOn: false });
  assert.ok(!(await deployStore.get(d.id))!.alwaysOn);
});

test("maintainDeployments re-ensures a live endpoint only for running always-on deployments", async () => {
  const ctx = svc({ resolve: async () => ({ host: "127.0.0.1", port: 5001 }) });
  const { deploy } = ctx;
  const cold = await deploy.deploy({ ...owner, entrypoint: "x", files: [] });
  const warm = await deploy.deploy({ ...owner, entrypoint: "x", files: [] });
  await deploy.setDeploymentAlwaysOn(warm.id, true);
  const resolvesBefore = ctx.resolves;

  const warmed = await deploy.maintainDeployments();
  assert.equal(warmed, 1);
  assert.equal(ctx.resolves, resolvesBefore + 1);
  assert.ok(cold.id !== warm.id);
});

test("maintainDeployments skips a deployment whose flag was turned off after the list snapshot", async () => {
  const ctx = svc({ resolve: async () => null });
  const { deploy, deployStore } = ctx;
  const d = await deploy.deploy({ ...owner, entrypoint: "x", files: [] });
  await deploy.setDeploymentAlwaysOn(d.id, true);
  const realList = deployStore.list.bind(deployStore);
  deployStore.list = async () => {
    const snapshot = await realList();
    await deployStore.setAlwaysOn(d.id, false);
    return snapshot;
  };
  const appliesBefore = ctx.applies;
  const warmed = await deploy.maintainDeployments();
  assert.equal(warmed, 0);
  assert.equal(ctx.applies, appliesBefore);
});

test("maintainDeployments relaunches when the platform has torn the app down", async () => {
  const ctx = svc({ resolve: async () => null });
  const { deploy, deployStore } = ctx;
  const d = await deploy.deploy({ ...owner, entrypoint: "x", files: [] });
  await deploy.setDeploymentAlwaysOn(d.id, true);
  const appliesBefore = ctx.applies;

  const warmed = await deploy.maintainDeployments();
  assert.equal(warmed, 1);
  assert.ok(ctx.applies > appliesBefore, "expected a re-apply when no live endpoint exists");
  assert.equal((await deployStore.get(d.id))!.status, "running");
});

test("maintainDeployments re-applies an app whose placement is due for renewal", async () => {
  const placements = new Map<string, number>();
  const ctx = svc({
    apply: async (d) => {
      const n = (placements.get(d.id) ?? 0) + 1;
      placements.set(d.id, n);
      return { host: "127.0.0.1", port: 5000, renewAt: n === 1 && d.name === "stale" ? 0 : Date.now() + 3_600_000 };
    },
  });
  const { deploy, deployStore } = ctx;
  const stale = await deploy.deploy({ ...owner, name: "stale", entrypoint: "x", files: [] });
  const fresh = await deploy.deploy({ ...owner, name: "fresh", entrypoint: "x", files: [] });

  const maintained = await deploy.maintainDeployments();
  assert.equal(maintained, 1, "only the due app is renewed");
  assert.equal(placements.get(stale.id), 2);
  assert.equal(placements.get(fresh.id), 1);
  assert.equal((await deployStore.get(stale.id))!.status, "running");
  assert.ok((await deployStore.get(stale.id))!.endpoint!.renewAt! > Date.now());
  assert.equal(await deploy.maintainDeployments(), 0);
});

test("repair publication and rollback apply always-on with the version instead of restarting the old app", async () => {
  const { deploy, deployStore } = svc();
  const d = await deploy.deployOrUpdate({ ...owner, name: "repair-app", entrypoint: "first", files: [] });
  await deploy.deployOrUpdate({ ...owner, name: "repair-app", entrypoint: "fixed", files: [], alwaysOn: true });
  assert.equal((await deployStore.get(d.id))!.alwaysOn, true);
  await deploy.deployOrUpdate({ ...owner, name: "repair-app", rollbackTo: 1, alwaysOn: false });
  assert.equal((await deployStore.get(d.id))!.alwaysOn, false);
  assert.equal((await deployStore.get(d.id))!.appliedVersion, 1);
});

function service(maxAppBytes?: number) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-app-size-"));
  let applies = 0;
  const store = createDeployStore(testDeployBackings({ git: { repoRoot: join(dir, "repos") } }));
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: store,
    provider: {
      profile: { managedScaleToZero: false, ...(maxAppBytes ? { maxAppBytes } : {}) },
      apply: async () => {
        applies++;
        return { host: "127.0.0.1", port: 1 };
      },
      resolveEndpoint: async (d) => d.endpoint,
      logs: async () => null,
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    deployDir: join(dir, "deploy"),
  });
  return { deploy, store, applies: () => applies };
}

const appSizeOwner = { ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "node server.js" };

test("a provider's app size cap rejects oversized publishes and redeploys before anything is applied", async () => {
  const { deploy, applies } = service(10);
  await assert.rejects(
    deploy.deploy({
      ...appSizeOwner,
      files: [
        { path: "a.bin", data: new Uint8Array(6) },
        { path: "b.txt", data: "hello" },
      ],
    }),
    /^Error: the app is too large to publish: 11 bytes, maximum 10 bytes/,
  );
  assert.equal(applies(), 0);
  const d = await deploy.deploy({ ...appSizeOwner, files: [{ path: "a.txt", data: "0123456789" }] });
  assert.equal(applies(), 1);
  await assert.rejects(
    deploy.redeploy(d.id, { entrypoint: "node server.js", files: [{ path: "a.txt", data: "0123456789!" }] }),
    /too large to publish: 11 bytes/,
  );
  assert.equal(applies(), 1);
});

test("the cap also blocks an oversized version pushed to the deployment's git repo", async () => {
  const { deploy, store, applies } = service(10);
  const d = await deploy.deploy({ ...appSizeOwner, files: [{ path: "a.txt", data: "0123456789" }] });
  const work = mkdtempSync(join(tmpdir(), "deploy-app-size-push-"));
  execFileSync("git", ["clone", "--quiet", (await deploy.gitRepoPath(d.id))!, work]);
  writeFileSync(join(work, "a.txt"), "0123456789!");
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-aqm", "big"], { cwd: work });
  execFileSync("git", ["push", "--quiet", (await deploy.gitRepoPath(d.id))!, "HEAD:current"], { cwd: work });
  await deploy.pushGit(d.id, async () => ({ result: true, ok: true }));
  assert.equal(applies(), 1);
  const after = (await store.get(d.id))!;
  assert.equal(after.currentVersion, 1);
  assert.equal(after.versions.length, 1);
});

const tmp = () => mkdtempSync(join(tmpdir(), "deployment-env-"));

function environmentSvc(deploymentEnv?: (deployment: Deployment) => Promise<Record<string, string>>) {
  const deployStore = createDeployStore(testDeployBackings());
  let applied: DeploymentVersion | undefined;
  const provider: DeployProvider = {
    profile: { managedScaleToZero: false },
    apply: async (_d, version) => {
      applied = version;
      return { host: "127.0.0.1", port: 5000 };
    },
    resolveEndpoint: async (d) => d.endpoint,
    logs: async () => null,
    destroy: async () => {},
  };
  const service = createDeployService({
    ...singleProcessDeps(),
    deployStore,
    provider,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    deployDir: tmp(),
    ...(deploymentEnv ? { deploymentEnv } : {}),
  });
  return {
    service,
    deployStore,
    get applied() {
      return applied;
    },
  };
}

test("deploy-service: deploymentEnv sees the deployment record and is merged into the version handed to the provider, never persisted", async () => {
  const s = environmentSvc(async (deployment) => ({
    AGENT_API_URL: "https://core",
    AGENT_CREDENTIAL_TOKEN: `tok-${deployment.id}-${deployment.createdBy}`,
  }));
  const d = await s.service.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node x",
    files: [],
  });
  assert.equal(s.applied?.env?.AGENT_CREDENTIAL_TOKEN, `tok-${d.id}-U1`, "provider sees the publisher-bound token");
  assert.equal(s.applied?.env?.AGENT_API_URL, "https://core");
  const stored = (await s.deployStore.get(d.id))!.versions[0]!;
  assert.equal(stored.env?.AGENT_CREDENTIAL_TOKEN, undefined, "the stored version record never holds the token");
});

test("deploy-service: without deploymentEnv the provider sees no deployment env", async () => {
  const s = environmentSvc();
  await s.service.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "node x", files: [] });
  assert.equal(s.applied?.env?.AGENT_CREDENTIAL_TOKEN, undefined);
});

test("deploy-service: redeploy inherits the current version's env and home files unless the input replaces them", async () => {
  const s = environmentSvc(async () => ({ VIEWER_IDENTITY_KEY: "viewer" }));
  const d = await s.service.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node x",
    files: [],
    homeFiles: [{ path: ".npmrc", data: "token" }],
    env: { DB_URL: "postgres://one" },
  });
  const versionAt = async (n: number) => (await s.deployStore.get(d.id))!.versions[n - 1]!;

  await s.service.redeploy(d.id, { entrypoint: "node x", files: [] });
  assert.deepEqual((await versionAt(2)).env, { DB_URL: "postgres://one" }, "omitted env inherits");
  assert.equal((await versionAt(2)).homeDir, (await versionAt(1)).homeDir, "omitted homeFiles inherit");
  assert.deepEqual(s.applied?.env, { DB_URL: "postgres://one", VIEWER_IDENTITY_KEY: "viewer" }, "deploymentEnv on top");

  await s.service.redeploy(d.id, { entrypoint: "node x", files: [], env: { DB_URL: "postgres://two" } });
  assert.deepEqual((await versionAt(3)).env, { DB_URL: "postgres://two" }, "provided env replaces");

  await s.service.redeploy(d.id, { entrypoint: "node x", files: [], env: {}, homeFiles: [] });
  assert.deepEqual((await versionAt(4)).env, {}, "an empty env clears");
  assert.equal((await versionAt(4)).homeDir, undefined, "empty homeFiles clear");
  assert.deepEqual(s.applied?.env, { VIEWER_IDENTITY_KEY: "viewer" });

  await s.service.rollbackDeployment(d.id, 3);
  await s.service.redeploy(d.id, { entrypoint: "node x", files: [] });
  assert.deepEqual((await versionAt(5)).env, { DB_URL: "postgres://two" }, "inherits from the rolled-back version");

  await s.service.redeploy(d.id, { entrypoint: "node x", files: [], stampEnv: { STAMP: "s" } });
  assert.deepEqual((await versionAt(6)).env, { DB_URL: "postgres://two", STAMP: "s" }, "stampEnv merges on top");
});

function embedAncestorsSvc() {
  const deployStore = createDeployStore(testDeployBackings());
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 5000 }),
      resolveEndpoint: async (d) => d.endpoint,
      logs: async () => null,
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    deployDir: mkdtempSync(join(tmpdir(), "embed-ancestors-")),
  });
  return { deploy, deployStore };
}
const files = [{ path: "server.js", data: new TextEncoder().encode("listen") }];
const ancestors = ["https://internal.example.com", "https://mail.example.com"];

test("publish sets embed ancestors, a republish that omits them keeps them, and [] clears them", async () => {
  const { deploy } = embedAncestorsSvc();
  const created = await deploy.deployOrUpdate({
    ...owner,
    name: "panel",
    entrypoint: "node server.js",
    files,
    embedAncestors: ancestors,
  });
  assert.deepEqual(created.embedAncestors, ancestors);

  const kept = await deploy.deployOrUpdate({ ...owner, name: "panel", files });
  assert.deepEqual(kept.embedAncestors, ancestors, "a republish without the field leaves the setting alone");
  assert.equal(kept.currentVersion, 2);

  const cleared = await deploy.deployOrUpdate({ ...owner, name: "panel", files, embedAncestors: [] });
  assert.deepEqual(cleared.embedAncestors, []);
});

test("embed ancestors can be changed without a new version, through rename and rollback too", async () => {
  const { deploy } = embedAncestorsSvc();
  const first = await deploy.deployOrUpdate({ ...owner, name: "panel", entrypoint: "node server.js", files });
  await deploy.deployOrUpdate({ ...owner, name: "panel", files });

  const renamed = await deploy.deployOrUpdate({
    ...owner,
    name: "panel2",
    renameFrom: "panel",
    embedAncestors: ancestors,
  });
  assert.equal(renamed.id, first.id);
  assert.deepEqual(renamed.embedAncestors, ancestors);
  assert.equal(renamed.currentVersion, 2, "setting the list is not a redeploy");

  const rolled = await deploy.deployOrUpdate({ ...owner, name: "panel2", rollbackTo: 1, embedAncestors: [] });
  assert.deepEqual(rolled.embedAncestors, []);
});

test("an invalid embed ancestor is refused before anything is published", async () => {
  const { deploy, deployStore } = embedAncestorsSvc();
  await assert.rejects(
    deploy.deployOrUpdate({
      ...owner,
      name: "panel",
      entrypoint: "node server.js",
      files,
      embedAncestors: ["http://x.example.com"],
    }),
    /embedAncestors must be an array of up to 16 https origins/,
  );
  assert.equal(await deployStore.getByName("panel"), null);

  const d = await deploy.deploy({ ...owner, entrypoint: "node server.js", files });
  await assert.rejects(deploy.setDeploymentEmbedAncestors(d.id, ["*"]), /embedAncestors must be an/);
  assert.equal((await deployStore.get(d.id))!.embedAncestors, undefined);
});

function harness(failRestore = false) {
  let applies = 0;
  let destroys = 0;
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: createDeployStore(testDeployBackings()),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => {
        applies++;
        if (failRestore && applies > 1) throw new Error("runtime unavailable");
        return { host: "127.0.0.1", port: 20200 + applies };
      },
      resolveEndpoint: async (d) => d.endpoint,
      logs: async () => null,
      destroy: async () => {
        destroys++;
      },
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    deployDir: mkdtempSync(join(tmpdir(), "deploy-restore-")),
  });
  return { deploy, counts: () => ({ applies, destroys }) };
}

function persistenceFailureHarness(failMethod: "setVersionImage" | "setEndpoint" | "setStatus" | "setAppliedVersion") {
  const base = createDeployStore(testDeployBackings());
  let armed = false;
  let failed = false;
  const store = new Proxy(base, {
    get(target, property, receiver) {
      if (property !== failMethod) return Reflect.get(target, property, receiver);
      return async (...args: unknown[]) => {
        if (armed && !failed) {
          failed = true;
          throw new Error(`failed ${failMethod}`);
        }
        return (target[failMethod] as (...values: unknown[]) => Promise<void>)(...args);
      };
    },
  }) as DeployStore;
  let destroys = 0;
  let applies = 0;
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: store,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 20300, image: `image:${++applies}` }),
      resolveEndpoint: async (d) => d.endpoint,
      logs: async () => null,
      destroy: async () => {
        destroys++;
      },
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    deployDir: mkdtempSync(join(tmpdir(), "deploy-restore-persistence-")),
  });
  return {
    deploy,
    arm: () => {
      armed = true;
    },
    destroys: () => destroys,
  };
}

test("restore reapplies the archived current version before marking it running", async () => {
  const { deploy, counts } = harness();
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "server.js",
    files: [],
  });
  await deploy.archiveDeployment(d.id);
  const restored = await deploy.restoreDeployment(d.id);

  assert.deepEqual(counts(), { applies: 2, destroys: 1 });
  assert.equal(restored.status, "running");
  assert.equal(restored.currentVersion, 1);
  assert.equal(restored.appliedVersion, 1);
  assert.equal(restored.endpoint?.port, 20202);
});

test("a failed restore leaves the deployment archived and unreachable", async () => {
  const { deploy } = harness(true);
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "server.js",
    files: [],
  });
  await deploy.archiveDeployment(d.id);

  await assert.rejects(() => deploy.restoreDeployment(d.id), /runtime unavailable/);
  const after = (await deploy.listDeployments()).find((row) => row.id === d.id)!;
  assert.equal(after.status, "archived");
  assert.equal(after.endpoint, null);
  assert.equal((await deploy.reachDeployment(d.id, "U1")).status, "not_found");
});

test("restore is idempotent for retries and concurrent callers", async () => {
  const { deploy } = harness();
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "server.js",
    files: [],
  });
  await deploy.archiveDeployment(d.id);
  const [first, second] = await Promise.all([deploy.restoreDeployment(d.id), deploy.restoreDeployment(d.id)]);
  assert.equal(first.status, "running");
  assert.equal(second.status, "running");
  assert.equal((await deploy.restoreDeployment(d.id)).status, "running");
});

for (const failMethod of ["setVersionImage", "setEndpoint", "setStatus", "setAppliedVersion"] as const) {
  test(`restore destroys the runtime and remains archived when ${failMethod} fails`, async () => {
    const { deploy, arm, destroys } = persistenceFailureHarness(failMethod);
    const d = await deploy.deploy({
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      entrypoint: "server.js",
      files: [],
    });
    await deploy.archiveDeployment(d.id);
    arm();

    await assert.rejects(() => deploy.restoreDeployment(d.id), new RegExp(`failed ${failMethod}`));
    const after = (await deploy.listDeployments()).find((row) => row.id === d.id)!;
    assert.equal(destroys(), 2);
    assert.equal(after.status, "archived");
    assert.equal(after.endpoint, null);
  });
}

function renameDisplaySvc() {
  const deployStore = createDeployStore(testDeployBackings());
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 20000 }),
      resolveEndpoint: async (d) => d.endpoint,
      logs: async () => null,
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "rn-")),
  });
  return { deploy, deployStore };
}

const make = (deploy: ReturnType<typeof renameDisplaySvc>["deploy"], name: string) =>
  deploy.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [], name });

test("renameDeployment moves the URL slug by id, keeping the immutable id", async () => {
  const s = renameDisplaySvc();
  const d = await make(s.deploy, "old-slug");
  const r = await s.deploy.renameDeployment(d.id, "new-slug");
  assert.equal(r.id, d.id, "same deployment");
  assert.equal(r.name, "new-slug");
  assert.equal(await s.deployStore.getByName("old-slug"), null, "old slug no longer resolves");
  assert.equal((await s.deployStore.getByName("new-slug"))!.id, d.id);
});

test("renameDeployment rejects a taken slug, an invalid slug, and an unknown id", async () => {
  const s = renameDisplaySvc();
  const a = await make(s.deploy, "alpha");
  await make(s.deploy, "beta");
  await assert.rejects(() => s.deploy.renameDeployment(a.id, "beta"), /name taken/);
  await assert.rejects(() => s.deploy.renameDeployment(a.id, "Bad_Slug"), /invalid deployment name/);
  await assert.rejects(() => s.deploy.renameDeployment("nope", "ok-slug"), /unknown deployment/);
});

test("setDeploymentDisplayName sets the label, then clears it (independent of the slug)", async () => {
  const s = renameDisplaySvc();
  const d = await make(s.deploy, "my-app");
  const set = await s.deploy.setDeploymentDisplayName(d.id, "My Cool App");
  assert.equal(set.displayName, "My Cool App");
  assert.equal(set.name, "my-app", "the URL slug is untouched");
  const cleared = await s.deploy.setDeploymentDisplayName(d.id, "");
  assert.equal(cleared.displayName, undefined, "empty clears the label (falls back to name/id)");
  assert.equal(cleared.name, "my-app");
});

test("HTTP: the /name (slug) route does not shadow /display-name", async () => {
  const s = renameDisplaySvc();
  const app = createApp({ deploy: s.deploy } as unknown as Parameters<typeof createApp>[0]);
  const identitySecret = "deployment-route-identity-secret";
  const server = createInsecureTestServer(app, {
    portalIdentitySecret: identitySecret,
    requireSignedPortalIdentity: true,
  });
  const base = listenLocal(server);
  const identity = await mintSignedPayload({ p: "U1", exp: Date.now() + 60_000 }, identitySecret);
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-portal-identity": identity },
      body: JSON.stringify(body),
    });
  try {
    const d = await make(s.deploy, "my-app");
    const dn = await post(`/v1/deployments/${d.id}/display-name`, { displayName: "Pretty" });
    assert.equal(dn.status, 200);
    const dnBody = (await dn.json()) as { deployment: { name?: string; displayName?: string } };
    assert.equal(dnBody.deployment.displayName, "Pretty");
    assert.equal(dnBody.deployment.name, "my-app", "the URL slug is untouched");
    const rn = await post(`/v1/deployments/${d.id}/name`, { name: "new-slug" });
    assert.equal(rn.status, 200);
    const rnBody = (await rn.json()) as { deployment: { name?: string; displayName?: string } };
    assert.equal(rnBody.deployment.name, "new-slug");
    assert.equal(rnBody.deployment.displayName, "Pretty");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("setDeploymentDisplayName rejects an over-long or control-char label, and an unknown id", async () => {
  const s = renameDisplaySvc();
  const d = await make(s.deploy, "app");
  await assert.rejects(() => s.deploy.setDeploymentDisplayName(d.id, "x".repeat(61)), /too long/);
  await assert.rejects(() => s.deploy.setDeploymentDisplayName(d.id, "badname"), /control characters/);
  await assert.rejects(() => s.deploy.setDeploymentDisplayName("nope", "label"), /unknown deployment/);
});
