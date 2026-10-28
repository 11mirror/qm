import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAclStore } from "../../src/acl/acl-store.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";
import type { DeployProvider } from "../../src/deploy/deploy-provider.ts";
import { createDeployService, type DeployService } from "../../src/deploy/deploy-service.ts";
import {
  createDeployStore,
  type DeployStore,
  type Deployment,
  type DeploymentVersion,
} from "../../src/deploy/deploy-store.ts";
import type { AdvisoryLock } from "../../src/persistence/advisory-lock.ts";

import { scopeId } from "../../src/types.ts";
import { singleProcessDeps } from "../support/single-process.ts";
import { testDeployBackings, testDatabaseUrl } from "../support/test-database.ts";

interface ProviderProbe {
  appliedImages: Array<string | undefined>;
}

function flyLikeService(): { deploy: DeployService; deployStore: DeployStore; probe: ProviderProbe } {
  const deployStore = createDeployStore(testDeployBackings());
  const probe: ProviderProbe = { appliedImages: [] };
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore,
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    deployDir: mkdtempSync(join(tmpdir(), "deploy-img-")),
    provider: {
      profile: { managedScaleToZero: true },
      apply: async (_d: Deployment, version: DeploymentVersion) => {
        probe.appliedImages.push(version.image);
        const image = version.image ?? `registry.fly.io/app:v${version.version}`;
        return { host: "app.flycast", port: 80, image };
      },
      resolveEndpoint: async (d) => d.endpoint,
      logs: async () => null,
      destroy: async () => {},
    },
  });
  return { deploy, deployStore, probe };
}

const owner = scopeId("personal", "U1");

test("deploy records the provider's converged image ref onto the version", async () => {
  const { deploy, deployStore } = flyLikeService();
  const d = await deploy.deploy({
    ownerScopeId: owner,
    createdBy: "U1",
    entrypoint: "node s.js",
    files: [{ path: "s.js", data: "x" }],
  });
  assert.equal(
    (await deployStore.versionOf(d.id, 1))!.image,
    "registry.fly.io/app:v1",
    "v1 image persisted after apply",
  );
});

test("redeploy builds a new image and records it; each version keeps its own ref", async () => {
  const { deploy, deployStore } = flyLikeService();
  const d = await deploy.deploy({
    ownerScopeId: owner,
    createdBy: "U1",
    entrypoint: "node s.js",
    files: [{ path: "s.js", data: "v1" }],
  });
  await deploy.redeploy(d.id, { entrypoint: "node s.js", files: [{ path: "s.js", data: "v2" }] });
  assert.equal((await deployStore.versionOf(d.id, 1))!.image, "registry.fly.io/app:v1");
  assert.equal((await deployStore.versionOf(d.id, 2))!.image, "registry.fly.io/app:v2");
});

test("rollback reuses the stored image — the provider gets the recorded ref, never rebuilds", async () => {
  const { deploy, deployStore, probe } = flyLikeService();
  const d = await deploy.deploy({
    ownerScopeId: owner,
    createdBy: "U1",
    entrypoint: "node s.js",
    files: [{ path: "s.js", data: "v1" }],
  });
  await deploy.redeploy(d.id, { entrypoint: "node s.js", files: [{ path: "s.js", data: "v2" }] });
  probe.appliedImages.length = 0;

  await deploy.rollbackDeployment(d.id, 1);
  assert.deepEqual(
    probe.appliedImages,
    ["registry.fly.io/app:v1"],
    "rollback hands the provider the stored v1 image (no rebuild)",
  );
  assert.equal((await deployStore.get(d.id))!.currentVersion, 1);
  assert.equal((await deployStore.versionOf(d.id, 1))!.image, "registry.fly.io/app:v1");
});

test("a runtime-mount provider (no image) leaves versions image-less — Docker behavior unchanged", async () => {
  const deployStore = createDeployStore(testDeployBackings());
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore,
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    deployDir: mkdtempSync(join(tmpdir(), "deploy-noimg-")),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 9200 }),
      resolveEndpoint: async (d) => d.endpoint,
      logs: async () => null,
      destroy: async () => {},
    },
  });
  const d = await deploy.deploy({
    ownerScopeId: owner,
    createdBy: "U1",
    entrypoint: "node s.js",
    files: [{ path: "s.js", data: "x" }],
  });
  assert.equal(
    "image" in (await deployStore.versionOf(d.id, 1))!,
    false,
    "no image recorded for a runtime-mount provider",
  );
});

test("a git-bundle provider receives each version's bundle on apply and marks the applied version", async () => {
  const deployStore = createDeployStore(testDeployBackings());
  const bundles: Array<Uint8Array | undefined> = [];
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore,
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    deployDir: mkdtempSync(join(tmpdir(), "deploy-reconcile-")),
    provider: {
      profile: { managedScaleToZero: true, appliesGitBundle: true },
      apply: async (_d, _version, gitBundle) => {
        bundles.push(gitBundle);
        return { host: "app.flycast", port: 80 };
      },
      resolveEndpoint: async (d) => d.endpoint,
      logs: async () => null,
      destroy: async () => {},
    },
  });

  const d = await deploy.deploy({
    ownerScopeId: owner,
    createdBy: "U1",
    entrypoint: "node s.js",
    files: [
      { path: "s.js", data: "v1" },
      { path: "data.json", data: "1" },
    ],
  });
  await deploy.redeploy(d.id, {
    entrypoint: "node s.js",
    files: [
      { path: "s.js", data: "v1" },
      { path: "data.json", data: "2" },
    ],
  });

  assert.equal(bundles.length, 2);
  assert.ok((bundles[0]?.byteLength ?? 0) > 0, "v1 apply receives a git bundle");
  assert.ok((bundles[1]?.byteLength ?? 0) > 0, "v2 apply receives a git bundle");
  assert.equal((await deployStore.get(d.id))!.appliedVersion, 2);
});

test("applied version is marked only after endpoint metadata is persisted", async () => {
  const baseStore = createDeployStore(testDeployBackings());
  const deployStore: DeployStore = {
    ...baseStore,
    setEndpoint: async () => {
      throw new Error("endpoint write failed");
    },
  };
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore,
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    deployDir: mkdtempSync(join(tmpdir(), "deploy-applied-order-")),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 9200 }),
      resolveEndpoint: async (d) => d.endpoint,
      logs: async () => null,
      destroy: async () => {},
    },
  });

  await assert.rejects(
    () =>
      deploy.deploy({
        ownerScopeId: owner,
        createdBy: "U1",
        entrypoint: "node s.js",
        files: [{ path: "s.js", data: "x" }],
      }),
    /endpoint write failed/,
  );
  const [d] = await baseStore.list();
  assert.equal(d!.appliedVersion, undefined);
});

test("a failed redeploy does not move the hosted git current ref", async () => {
  const deployStore = createDeployStore(testDeployBackings());
  let applies = 0;
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore,
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    deployDir: mkdtempSync(join(tmpdir(), "deploy-current-ref-")),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => {
        applies++;
        if (applies > 1) throw new Error("apply failed");
        return { host: "127.0.0.1", port: 9200 };
      },
      resolveEndpoint: async (d) => d.endpoint,
      logs: async () => null,
      destroy: async () => {},
    },
  });

  const d = await deploy.deploy({
    ownerScopeId: owner,
    createdBy: "U1",
    entrypoint: "node s.js",
    files: [{ path: "s.js", data: "v1" }],
  });
  const v1 = (await deployStore.versionOf(d.id, 1))!;
  assert.equal(await deployStore.refOf(d.id, "refs/heads/current"), v1.commit);

  await assert.rejects(
    () => deploy.redeploy(d.id, { entrypoint: "node s.js", files: [{ path: "s.js", data: "v2" }] }),
    /apply failed/,
  );
  const after = (await deployStore.get(d.id))!;
  assert.equal(after.currentVersion, 2, "the failed candidate remains recorded as the desired version");
  assert.equal(after.appliedVersion, 1);
  assert.equal(await deployStore.refOf(d.id, "refs/heads/current"), v1.commit);
});

function svc(opts: { lock?: AdvisoryLock; managed?: boolean } = {}) {
  const deployStore = createDeployStore(testDeployBackings());
  let destroys = 0;
  const provider: DeployProvider = {
    profile: { managedScaleToZero: opts.managed ?? false },
    apply: async () => ({ host: "127.0.0.1", port: 5000 }),
    resolveEndpoint: async (d) => d.endpoint,
    logs: async () => null,
    destroy: async () => {
      destroys++;
    },
  };
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore,
    provider,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    deployDir: mkdtempSync(join(tmpdir(), "concurrency-")),
    ...(opts.lock ? { advisoryLock: opts.lock } : {}),
  });
  return {
    deploy,
    deployStore,
    get destroys() {
      return destroys;
    },
  };
}

function spyLock(): { lock: AdvisoryLock; keys: string[] } {
  const keys: string[] = [];
  const withLock = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    keys.push(key);
    return fn();
  };
  const lock: AdvisoryLock = {
    withLock,
    withSharedLock: withLock,
    tryWithLock: withLock,
  };
  return { lock, keys };
}

test("withDeployLock: redeploy/rollback/archive each acquire the advisory mutex keyed deploy:<id>", async () => {
  const { lock, keys } = spyLock();
  const { deploy } = svc({ lock });
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  assert.deepEqual(keys, [], "the initial create takes no deploy lock");

  await deploy.redeploy(d.id, { entrypoint: "y", files: [] });
  await deploy.rollbackDeployment(d.id, 1);
  await deploy.archiveDeployment(d.id);

  const want = `deploy:${d.id}`;
  assert.deepEqual(keys, [want, want, want], "redeploy, rollback, archive each lock deploy:<id>");
});

test("withDeployLock: same-instance lifecycle ops still serialize (no overlap)", async () => {
  const deployStore = createDeployStore(testDeployBackings());
  let active = 0;
  let maxActive = 0;
  const provider: DeployProvider = {
    profile: { managedScaleToZero: false },
    apply: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
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
    deployDir: mkdtempSync(join(tmpdir(), "serialize-")),
  });
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  await Promise.all([
    deploy.redeploy(d.id, { entrypoint: "a", files: [] }),
    deploy.redeploy(d.id, { entrypoint: "b", files: [] }),
  ]);
  assert.equal(maxActive, 1, "two redeploys on one deployment never ran apply() concurrently");
});

for (const [visit, stop, status] of [
  ["reach", "archive", "archived"],
  ["keep-warm", "archive", "archived"],
] as const) {
  test(`withDeployLock: a ${visit} waiting on the ${stop} leaves the app ${status} and never re-applies it`, async () => {
    const deployStore = createDeployStore(testDeployBackings());
    let applies = 0;
    const destroying = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const resolving = Promise.withResolvers<void>();
    const provider: DeployProvider = {
      profile: { managedScaleToZero: false },
      apply: async () => {
        applies++;
        return { host: "127.0.0.1", port: 5000 };
      },
      resolveEndpoint: async () => {
        resolving.resolve();
        return null;
      },
      logs: async () => null,
      destroy: async () => {
        destroying.resolve();
        await release.promise;
      },
    };
    const deploy = createDeployService({
      ...singleProcessDeps(),
      deployStore,
      provider,
      auditLog: { record() {}, events: async () => [], tail: async () => [] },
      acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
      deployDir: mkdtempSync(join(tmpdir(), "reach-stop-")),
    });
    const d = await deploy.deploy({
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      entrypoint: "x",
      files: [],
      alwaysOn: visit === "keep-warm",
    });
    const stopping = deploy.archiveDeployment(d.id);
    await destroying.promise;
    let settled = false;
    const visiting = (visit === "reach" ? deploy.reachDeployment(d.id, "U1") : deploy.maintainDeployments()).finally(
      () => {
        settled = true;
      },
    );
    await resolving.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, `the ${visit} waits while the ${stop} holds the deploy lock`);
    release.resolve();
    await stopping;
    const result = await visiting;
    assert.equal(applies, 1, `the waiting ${visit} does not re-apply the ${status} app`);
    const after = (await deployStore.get(d.id))!;
    assert.equal(after.status, status, `the app stays ${status}`);
    assert.equal(after.endpoint, null);
    assert.deepEqual(result, visit === "reach" ? { status: "not_found" } : 0);
  });
}
