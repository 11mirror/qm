import {
  createSandboxResources,
  type SandboxResource,
  type SandboxDefault,
} from "../../src/sandbox/sandbox-resources.ts";
import { createSandboxRouter } from "../../src/sandbox/sandbox-routing.ts";
import {
  upgradeLegacySandboxes,
  type LegacyRoute,
  type SandboxResourceUpgradeMarker,
} from "../../src/sandbox/sandbox-resource-upgrade.ts";
import { type BackendSandbox, type Sandbox } from "../../src/sandbox/sandbox.ts";
import { testAdvisoryLock, testMap } from "./test-database.ts";

export const processStubs = {
  async startProcess() {
    return { processId: "p" };
  },
  async readProcess() {
    return { chunks: "", cursor: 0, status: { state: "exited" as const, code: 0 } };
  },
  async writeStdin() {},
  async signalProcess() {},
  async listProcesses() {
    return [];
  },
  async exportFiles() {
    return [];
  },
};

export function fixture(configure?: (backend: Sandbox) => void, legacyScopes = ["personal:alice"]) {
  const records = testMap<SandboxResource>();
  const defaults = testMap<SandboxDefault>();
  const routes = testMap<LegacyRoute>();
  const marker = testMap<SandboxResourceUpgradeMarker>();
  const disks = new Map<string, Map<string, string>>();
  const provisioned: string[] = [];
  const backend: BackendSandbox = {
    ...processStubs,
    profile: { backend: "local", writablePersistence: "resident_disk", processSessions: false },
    async provision(layers) {
      const id = layers.find((layer) => layer.mode === "rw")!.scopeId;
      provisioned.push(id);
      if (!disks.has(id)) disks.set(id, new Map());
      return { id, rootDir: "/workspace" };
    },
    async run(handle) {
      return { stdout: handle.id, stderr: "", code: 0, timedOut: false };
    },
    async readFile(handle, path) {
      return disks.get(handle.id)?.get(path) ?? null;
    },
    async writeFile(handle, path, data) {
      disks.get(handle.id)!.set(path, data);
    },
    async readFileBytes() {
      return null;
    },
    async writeFileBytes() {},
    async listDir() {
      return [];
    },
    async removeDir() {},
    async teardown() {},
    async destroyScope(id) {
      disks.delete(id);
    },
    async computerStatus(scopeId) {
      return { machine: scopeId, guestResponsive: true };
    },
    async restartComputer(scopeId) {
      provisioned.push(`restart:${scopeId}`);
    },
  };
  configure?.(backend);
  const lock = testAdvisoryLock();
  const upgrade =
    (overrides: Partial<Parameters<typeof upgradeLegacySandboxes>[0]> = {}) =>
    () =>
      upgradeLegacySandboxes({
        availableBackends: ["local"],
        records,
        defaults,
        marker,
        lock,
        routes: () => routes.entries(),
        legacyScopes: async () => legacyScopes,
        legacyBackend: () => "local",
        ...overrides,
      });
  const options = {
    upgrade: upgrade(),
    records,
    defaults,
    backends: { local: backend },
    defaultBackend: "local",
    lock,
    canUseScope: async (actor: string, scope: string) =>
      actor === "admin" || scope === `personal:${actor}` || (actor === "alice" && scope === "channel:team"),
  } satisfies Parameters<typeof createSandboxResources>[0];
  const resources = createSandboxResources(options);
  const router = createSandboxRouter({ backends: { local: backend }, defaultBackend: "local", resources });
  const layers = [{ scopeId: "personal:alice", mode: "rw" as const, mountPath: "/" }];
  return { records, defaults, routes, resources, router, provisioned, layers, backend, options, marker, upgrade };
}
