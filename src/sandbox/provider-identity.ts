import type { SandboxBodies } from "./sandbox-bodies.ts";
import type { SandboxDriver, StoredSandboxRecord } from "./provider-sandbox.ts";

export function bindProviderIdentity(
  adapter: SandboxDriver,
  store: SandboxBodies<StoredSandboxRecord>,
  scopeOf: (name: string) => Promise<string | undefined>,
): SandboxDriver {
  const field = adapter.identityField;
  if (!field) return adapter;
  const driver = Object.create(adapter) as SandboxDriver;
  driver.inspect = async (name) => {
    const scope = await scopeOf(name);
    const stored = scope ? await store.get(scope) : null;
    const machine = await adapter.inspect(name, stored?.[field]);
    if (scope && machine?.id && stored?.[field] !== machine.id) await store.upsert(scope, { [field]: machine.id });
    return machine;
  };
  driver.create = async (name, options) => {
    const made = await adapter.create(name, options);
    if (options.scope && made?.id) await store.upsert(options.scope, { [field]: made.id });
    return made;
  };
  driver.destroy = async (name) => {
    const scope = await scopeOf(name);
    const stored = scope ? await store.get(scope) : null;
    await adapter.destroy(name, stored?.[field]);
  };
  return driver;
}
