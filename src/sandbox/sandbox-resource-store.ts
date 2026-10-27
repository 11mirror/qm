import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import type { SandboxBackendName } from "./sandbox-routing.ts";
import type { SandboxDefault, SandboxResource } from "./sandbox-resources.ts";

export interface LegacyRoute {
  backend: SandboxBackendName;
}

const SANDBOX_RESOURCES: TableSpec = {
  table: "sandbox_resources",
  key: "id",
  keyIsField: true,
  columns: cols(`backend text!, ownerScopeId text!, backingScopeId text!, name text!, createdBy text!,
    createdAt text!, legacy boolean!, state text!, machineId text, cleanupPending boolean,
    holders text[], spec jsonb, error text`),
};

const SANDBOX_DEFAULTS: TableSpec = {
  table: "sandbox_defaults",
  key: "scopeId",
  columns: { sandboxId: { type: "text" } },
};

const SANDBOX_RESOURCE_ROLLOUT: TableSpec = {
  table: "sandbox_resource_rollout",
  key: "id",
  columns: { activatedAt: { type: "text", required: true } },
};

const SANDBOX_ROUTING: TableSpec = {
  table: "sandbox_routing",
  key: "scopeId",
  columns: { backend: { type: "text", required: true } },
};

export const SANDBOX_RESOURCES_MIGRATION = mapToTableMigration(
  "sandbox/sandbox_resources/0001-typed",
  SANDBOX_RESOURCES,
  { dropKeys: ["availableActions"] },
);
export const SANDBOX_DEFAULTS_MIGRATION = mapToTableMigration("sandbox/sandbox_defaults/0001-typed", SANDBOX_DEFAULTS);
export const SANDBOX_RESOURCE_ROLLOUT_MIGRATION = mapToTableMigration(
  "sandbox/sandbox_resource_rollout/0001-typed",
  SANDBOX_RESOURCE_ROLLOUT,
);
export const SANDBOX_ROUTING_MIGRATION = mapToTableMigration("sandbox/sandbox_routing/0001-typed", SANDBOX_ROUTING);

const UPGRADE_MARKER = "explicit-defaults";

export function createSandboxResourceStore(databaseUrl: string) {
  const db = createPgPool(databaseUrl, [
    SANDBOX_RESOURCES_MIGRATION,
    SANDBOX_DEFAULTS_MIGRATION,
    SANDBOX_RESOURCE_ROLLOUT_MIGRATION,
    SANDBOX_ROUTING_MIGRATION,
  ]);
  const { q } = db;
  const resources = typedTable<SandboxResource>(db, SANDBOX_RESOURCES);
  const defaults = typedTable<{ sandboxId?: string }>(db, SANDBOX_DEFAULTS);
  const rollout = typedTable<{ activatedAt: string }>(db, SANDBOX_RESOURCE_ROLLOUT);
  return {
    get: resources.get,
    list: resources.all,
    async put(record: SandboxResource): Promise<void> {
      await resources.put(record.id, record);
    },
    async insertIfAbsent(record: SandboxResource): Promise<void> {
      await resources.insert(record.id, record);
    },
    async addHolder(id: string, runId: string): Promise<void> {
      await q(
        `UPDATE sandbox_resources SET holders = coalesce(holders, '{}') || $2::text
         WHERE id = $1 AND NOT ($2 = ANY (coalesce(holders, '{}')))`,
        [id, runId],
      );
    },
    async dropHolders(id: string, runIds: readonly string[]): Promise<SandboxResource | null> {
      const rows = await q(
        `UPDATE sandbox_resources
         SET holders = ARRAY(SELECT h FROM unnest(coalesce(holders, '{}')) WITH ORDINALITY AS u(h, n)
                             WHERE h <> ALL ($2::text[]) ORDER BY n)
         WHERE id = $1 RETURNING ${resources.codec.columns}`,
        [id, runIds],
      );
      return rows.length ? resources.codec.row(rows[0]!) : null;
    },
    async defaultFor(scopeId: string): Promise<SandboxDefault | null> {
      const row = await defaults.get(scopeId);
      return row && { sandboxId: row.sandboxId ?? null };
    },
    defaults: async (): Promise<Array<[string, SandboxDefault]>> =>
      (await q(`SELECT scope_id, sandbox_id FROM sandbox_defaults ORDER BY scope_id`)).map((r) => [
        r.scope_id as string,
        { sandboxId: (r.sandbox_id as string | null) ?? null },
      ]),
    async setDefault(scopeId: string, sandboxId: string | null): Promise<void> {
      await defaults.put(scopeId, sandboxId ? { sandboxId } : {});
    },
    async setDefaultIfAbsent(scopeId: string, sandboxId: string | null): Promise<void> {
      await defaults.insert(scopeId, sandboxId ? { sandboxId } : {});
    },
    upgraded: async () => (await rollout.get(UPGRADE_MARKER)) !== null,
    async markUpgraded(): Promise<void> {
      await rollout.put(UPGRADE_MARKER, { activatedAt: new Date().toISOString() });
    },
    legacyRoutes: async (): Promise<Array<[string, LegacyRoute]>> =>
      (await q(`SELECT scope_id, backend FROM sandbox_routing ORDER BY scope_id`)).map((r) => [
        r.scope_id as string,
        { backend: r.backend as SandboxBackendName },
      ]),
  };
}

export type SandboxResourceStore = ReturnType<typeof createSandboxResourceStore>;
