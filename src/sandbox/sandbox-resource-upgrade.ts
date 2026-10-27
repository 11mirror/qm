import { createHash } from "node:crypto";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { parseScopeId, type ScopeKind } from "../types.ts";
import type { SandboxBackendName } from "./sandbox-routing.ts";
import type { AgentComputerSpec } from "./sandbox.ts";
import type { SandboxResource } from "./sandbox-resources.ts";
import type { SandboxResourceStore } from "./sandbox-resource-store.ts";

export interface LegacySandboxBinding {
  scopeId: string;
  backend: SandboxBackendName;
  machineId?: string;
}

export type LegacySandboxScopeDefaults = Partial<Record<ScopeKind, SandboxBackendName>>;

export function legacySandboxBackendForScope(
  scope: string,
  fallback: SandboxBackendName,
  defaults?: LegacySandboxScopeDefaults,
): SandboxBackendName {
  const kind = parseScopeId(scope).kind;
  return (kind && defaults?.[kind]) || fallback;
}

export const legacySandboxId = (scopeId: string, backend: SandboxBackendName): string =>
  `legacy-${createHash("sha256").update(`${backend}:${scopeId}`).digest("hex").slice(0, 24)}`;

export async function upgradeLegacySandboxes(opts: {
  availableBackends: readonly SandboxBackendName[];
  store: SandboxResourceStore;
  lock: AdvisoryLock;
  legacyScopes?: () => Promise<string[]>;
  legacySandboxes?: () => Promise<LegacySandboxBinding[]>;
  legacyBackend: (scopeId: string) => SandboxBackendName;
  specFor?: (backend: SandboxBackendName) => AgentComputerSpec | undefined;
}): Promise<void> {
  if (await opts.store.upgraded()) return;
  await opts.lock.withLock("sandbox-resources:activation", async () => {
    if (await opts.store.upgraded()) return;
    const [existing, defaults, routes, knownScopes, bindings] = await Promise.all([
      opts.store.list(),
      opts.store.defaults(),
      opts.store.legacyRoutes(),
      opts.legacyScopes?.() ?? [],
      opts.legacySandboxes?.() ?? [],
    ]);
    const managed = new Set(existing.filter((record) => !record.legacy).map((record) => record.backingScopeId));
    const valid = (scope: string): boolean => !!parseScopeId(scope).kind && !managed.has(scope);
    const routed = new Map(routes);
    const backendFor = (scope: string): SandboxBackendName => routed.get(scope)?.backend ?? opts.legacyBackend(scope);
    const scopes = new Set(
      [
        ...knownScopes,
        ...routed.keys(),
        ...bindings.map((binding) => binding.scopeId),
        ...existing.map((record) => record.ownerScopeId),
      ].filter(valid),
    );
    const selected = new Map(defaults);
    const retired = new Set(existing.filter((record) => record.state === "retired").map((record) => record.id));
    for (const scope of scopes) {
      const backend = backendFor(scope);
      if (
        !selected.has(scope) &&
        !retired.has(legacySandboxId(scope, backend)) &&
        !opts.availableBackends.includes(backend)
      )
        throw new Error(
          `cannot import legacy computer for ${scope}: backend ${backend} is not configured; restore that provider before upgrading`,
        );
    }
    const candidates = new Map<string, LegacySandboxBinding>();
    for (const binding of bindings)
      if (valid(binding.scopeId)) candidates.set(legacySandboxId(binding.scopeId, binding.backend), binding);
    for (const scope of scopes) {
      const id = legacySandboxId(scope, backendFor(scope));
      if (!candidates.has(id)) candidates.set(id, { scopeId: scope, backend: backendFor(scope) });
    }
    for (const [id, binding] of candidates) {
      const spec = opts.specFor?.(binding.backend);
      await opts.store.insertIfAbsent({
        id,
        backend: binding.backend,
        ownerScopeId: binding.scopeId as SandboxResource["ownerScopeId"],
        backingScopeId: binding.scopeId,
        name: "Existing scoped computer",
        createdBy: "system",
        createdAt: new Date().toISOString(),
        legacy: true,
        state: "unverified",
        ...(binding.machineId ? { machineId: binding.machineId } : {}),
        ...(spec ? { spec } : {}),
      });
    }
    for (const scope of scopes) {
      const id = legacySandboxId(scope, backendFor(scope));
      const record = await opts.store.get(id);
      await opts.store.setDefaultIfAbsent(scope, record?.state === "retired" ? null : id);
    }
    await opts.store.markUpgraded();
  });
}
