import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
import type { SandboxDefault, SandboxResource } from "./sandbox-resources.ts";

export interface SandboxResourceStore {
  get(id: string): Promise<SandboxResource | null>;
  list(): Promise<SandboxResource[]>;
  put(record: SandboxResource): Promise<void>;
  addHolder(id: string, runId: string): Promise<void>;
  dropHolders(id: string, runIds: readonly string[]): Promise<SandboxResource | null>;
  defaultFor(scopeId: string): Promise<SandboxDefault | null>;
  defaults(): Promise<Array<[string, SandboxDefault]>>;
  setDefault(scopeId: string, sandboxId: string | null): Promise<void>;
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

export const SANDBOX_RESOURCES_MIGRATION = mapToTableMigration(
  "sandbox/sandbox_resources/0001-typed",
  SANDBOX_RESOURCES,
  { dropKeys: ["availableActions"] },
);
export const SANDBOX_DEFAULTS_MIGRATION = mapToTableMigration("sandbox/sandbox_defaults/0001-typed", SANDBOX_DEFAULTS);

const resources = tableCodec<SandboxResource>(SANDBOX_RESOURCES);

export function createSandboxResourceStore(databaseUrl: string): SandboxResourceStore {
  const { q } = createPgPool(databaseUrl, [SANDBOX_RESOURCES_MIGRATION, SANDBOX_DEFAULTS_MIGRATION]);
  const insert = (record: SandboxResource, onConflict: string) =>
    q(
      `INSERT INTO sandbox_resources (${resources.columns}) VALUES (${resources.placeholders})
       ON CONFLICT (${tenantCols("id")}) DO ${onConflict}`,
      resources.values(record.id, record),
    );
  const insertDefault = (scopeId: string, sandboxId: string | null, onConflict: string) =>
    q(
      `INSERT INTO sandbox_defaults (scope_id, sandbox_id) VALUES ($1, $2)
       ON CONFLICT (${tenantCols("scope_id")}) DO ${onConflict}`,
      [scopeId, sandboxId],
    );
  return {
    get: async (id) =>
      resources.rows(await q(`SELECT ${resources.columns} FROM sandbox_resources WHERE id = $1`, [id]))[0] ?? null,
    list: async () => resources.rows(await q(`SELECT ${resources.columns} FROM sandbox_resources ORDER BY id`)),
    async put(record) {
      await insert(record, `UPDATE SET ${resources.updates}`);
    },
    async addHolder(id, runId) {
      await q(
        `UPDATE sandbox_resources SET holders = coalesce(holders, '{}') || $2::text
         WHERE id = $1 AND NOT ($2 = ANY (coalesce(holders, '{}')))`,
        [id, runId],
      );
    },
    async dropHolders(id, runIds) {
      const rows = await q(
        `UPDATE sandbox_resources
         SET holders = ARRAY(SELECT h FROM unnest(coalesce(holders, '{}')) WITH ORDINALITY AS u(h, n)
                             WHERE h <> ALL ($2::text[]) ORDER BY n)
         WHERE id = $1 RETURNING ${resources.columns}`,
        [id, runIds],
      );
      return rows.length ? resources.row(rows[0]!) : null;
    },
    async defaultFor(scopeId) {
      const rows = await q(`SELECT sandbox_id FROM sandbox_defaults WHERE scope_id = $1`, [scopeId]);
      return rows.length ? { sandboxId: (rows[0]!.sandbox_id as string | null) ?? null } : null;
    },
    defaults: async () =>
      (await q(`SELECT scope_id, sandbox_id FROM sandbox_defaults ORDER BY scope_id`)).map((r) => [
        r.scope_id as string,
        { sandboxId: (r.sandbox_id as string | null) ?? null },
      ]),
    async setDefault(scopeId, sandboxId) {
      await insertDefault(scopeId, sandboxId, "UPDATE SET sandbox_id = EXCLUDED.sandbox_id");
    },
  };
}
