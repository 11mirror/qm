import { createPressureObserver } from "./provider-controls.ts";
import type { SandboxBodies } from "./sandbox-bodies.ts";
import type { SandboxDriver, SandboxShared, StoredSandboxRecord } from "./provider-sandbox.ts";

export function createProviderRecovery(
  driver: SandboxDriver,
  store: SandboxBodies<StoredSandboxRecord>,
  shared: SandboxShared,
  deps: {
    scopeOf: (name: string) => Promise<string | undefined>;
    initialize: (scope: string, name: string) => Promise<unknown>;
    touch: (name: string, force?: boolean) => Promise<void>;
  },
): SandboxDriver {
  const notePressure = createPressureObserver((name, pressure) =>
    shared.onError?.({
      category: "agent_computer",
      code: "io_pressure_high",
      message: `${driver.backend} ${name}: io pressure full avg60=${pressure.ioFull60}% (load ${pressure.load1}) — disk-bound work is stalling`,
    }),
  );
  const reviving = new Map<string, Promise<unknown>>();
  const use = <T>(scope: string | undefined, action: () => Promise<T>): Promise<T> =>
    scope && driver.lifetimeMs
      ? (shared.advisoryLock.withSharedLock ?? shared.advisoryLock.withLock)(`${driver.backend}-use:${scope}`, action)
      : action();

  async function withMachine<T>(name: string, action: () => Promise<T>): Promise<T> {
    const scope = await deps.scopeOf(name);
    await deps.touch(name);
    try {
      return await use(scope, action);
    } catch (error) {
      if (driver.isCommandLost?.(error)) driver.forget?.(name);
      if (!driver.isGone?.(error)) throw error;
      driver.forget?.(name);
      if (scope && (await store.get(scope))?.initializationPending) throw error;
      let pending = reviving.get(name);
      if (!pending) {
        pending = (scope ? deps.initialize(scope, name) : driver.create(name, { scratch: true })).finally(() =>
          reviving.delete(name),
        );
        reviving.set(name, pending);
      }
      await pending;
      return use(scope, action);
    }
  }

  return {
    ...driver,
    exec: async (name, script, timeoutSec, env) => {
      const result = await withMachine(name, () => driver.exec(name, script, timeoutSec, env));
      notePressure(name, result.pressure);
      return result;
    },
    writeAbsBytes: (name, path, data) => withMachine(name, () => driver.writeAbsBytes(name, path, data)),
    readAbsBytes: (name, path) => withMachine(name, () => driver.readAbsBytes(name, path)),
  };
}
