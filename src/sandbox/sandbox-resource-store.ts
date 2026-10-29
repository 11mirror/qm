import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import type { SandboxDefault, SandboxResource } from "./sandbox-resources.ts";

const SANDBOX_RESOURCES: TableSpec = {
  table: "sandbox_resources",
  key: "id",
  keyIsField: true,
  columns: cols(`backend text!, ownerScopeId text!, backingScopeId text!, name text!, createdBy text!,
    createdAt text!, legacy boolean!, state text!, machineId text, cleanupPending boolean,
    holders text[], spec jsonb, error text, jobOnly boolean`),
};

const SANDBOX_DEFAULTS: TableSpec = {
  table: "sandbox_defaults",
  key: "scopeId",
  columns: { sandboxId: { type: "text" } },
};

export const SANDBOX_RESOURCES_MIGRATION = mapToTableMigration(
  "sandbox/sandbox_resources/0001-typed",
  SANDBOX_RESOURCES,
  { dropKeys: ["availableActions"] },
);
export const SANDBOX_DEFAULTS_MIGRATION = mapToTableMigration("sandbox/sandbox_defaults/0001-typed", SANDBOX_DEFAULTS);

export function createSandboxResourceStore(databaseUrl: string) {
  const db = createPgPool(databaseUrl, [SANDBOX_RESOURCES_MIGRATION, SANDBOX_DEFAULTS_MIGRATION]);
  const { q } = db;
  const resources = typedTable<SandboxResource>(db, SANDBOX_RESOURCES);
  const defaults = typedTable<{ sandboxId?: string }>(db, SANDBOX_DEFAULTS);
  return {
    get: resources.get,
    async machineNameFor(backingScopeId: string): Promise<string | undefined> {
      const rows = await q(
        `SELECT machine_id FROM sandbox_resources WHERE backing_scope_id = $1 AND state <> 'retired'`,
        [backingScopeId],
      );
      if (rows.length > 1) throw new Error(`multiple sandbox records own ${backingScopeId}`);
      return rows[0]?.machine_id as string | undefined;
    },
    list: resources.all,
    async put(record: SandboxResource): Promise<void> {
      await resources.put(record.id, record);
    },
    async delete(id: string): Promise<void> {
      await resources.delete(id);
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
  };
}

export type SandboxResourceStore = ReturnType<typeof createSandboxResourceStore>;
