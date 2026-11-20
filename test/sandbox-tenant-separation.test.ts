import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSandboxRouter } from "../src/sandbox/sandbox-routing.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import {
  createSandboxResources,
  type SandboxDefault,
  type SandboxResource,
  type SandboxResources,
} from "../src/sandbox/sandbox-resources.ts";
import { bindBootTenant } from "../src/tenants/boot.ts";
import { withTenant } from "../src/tenants/context.ts";
import type { LoadSample } from "../src/sandbox/load-probe.ts";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import type { AdvisoryLock } from "../src/persistence/advisory-lock.ts";

await bindBootTenant(async () => undefined);

const ran: string[] = [];
const backend = (name: string): Sandbox =>
  ({
    profile: { backend: name },
    provision: async (scopeId: string) => ({ id: scopeId, rootDir: "/workspace" }),
    destroyScope: async () => undefined,
    run: async () => {
      ran.push(name);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  }) as unknown as Sandbox;

const router = createSandboxRouter({
  backends: { e2b: backend("e2b"), sprites: backend("sprites"), local: backend("local") },
  defaultBackend: "sprites",
  resources: {} as SandboxResources,
});

const handle = (name: string): SandboxHandle => ({ scopeId: "personal:pat", backend: name }) as SandboxHandle;

function memoryMap<T>(): DurableMap<T> {
  const values = new Map<string, T>();
  return {
    all: async () => [...values.values()],
    get: async (id) => values.get(id) ?? null,
    put: async (id, value) => void values.set(id, value),
    update: async (id, apply) => {
      const current = values.get(id);
      if (current === undefined) return null;
      const updated = apply(current);
      values.set(id, updated);
      return updated;
    },
  } as DurableMap<T>;
}

const lock = {
  withLock: async <T>(_key: string, work: () => Promise<T>) => work(),
} as AdvisoryLock;

test("on a deployment shared by tenants, backends that cannot keep tenants apart are refused", async () => {
  const tenant = randomUUID();
  await withTenant(tenant, async () => {
    for (const name of ["e2b", "local"])
      await assert.rejects(async () => router.run(handle(name), "true"), /does not keep tenants apart/);
    await router.run(handle("sprites"), "true");
  });
  await assert.rejects(async () => router.run(handle("e2b"), "true"), /does not keep tenants apart/);
  assert.deepEqual(ran, ["sprites"]);
});

test("shared tenants can only discover, create, and run isolated providers", async () => {
  const backends = { e2b: backend("e2b"), sprites: backend("sprites"), local: backend("local") };
  const records = memoryMap<SandboxResource>();
  const resources = createSandboxResources({
    records,
    loads: memoryMap<LoadSample>(),
    defaults: memoryMap<SandboxDefault>(),
    backends,
    defaultBackend: "sprites",
    lock,
    canUseScope: async () => true,
  });
  const tenantRouter = createSandboxRouter({ backends, defaultBackend: "sprites", resources });
  await withTenant(randomUUID(), async () => {
    await records.put("legacy-local", {
      id: "legacy-local",
      backend: "local",
      ownerScopeId: "personal:pat",
      backingScopeId: "sandbox-legacy-local",
      name: "Legacy local",
      createdBy: "pat",
      createdAt: new Date(0).toISOString(),
      legacy: true,
      state: "ready",
    });
    assert.deepEqual(
      (await resources.list("pat", "personal:pat")).providers.map(({ name }) => name),
      ["sprites"],
    );
    assert.deepEqual((await resources.list("pat", "personal:pat")).sandboxes[0]?.availableActions, []);
    await assert.rejects(resources.status("pat", "legacy-local"), /does not keep tenants apart/);
    await assert.rejects(resources.restart("pat", "legacy-local"), /does not keep tenants apart/);
    await assert.rejects(resources.retire("pat", "legacy-local"), /does not keep tenants apart/);
    await records.update("legacy-local", (record) => ({ ...record, state: "retired", cleanupPending: true }));
    const retired = (await resources.list("pat", "personal:pat")).sandboxes.find(({ id }) => id === "legacy-local");
    assert.deepEqual(retired?.availableActions, []);
    await assert.rejects(resources.create("pat", "personal:pat", "local"), /does not keep tenants apart/);
    const record = await resources.create("pat", "personal:pat", "sprites");
    const handle = await tenantRouter.provision("personal:pat", { sandboxId: record.id });
    await tenantRouter.run(handle, "true");
  });
});
