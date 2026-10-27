import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import {
  cols,
  mapToTableMigration,
  tableCodec,
  type ColumnSpec,
  type MapConversion,
} from "../persistence/typed-table.ts";

export interface SandboxBodies<T> {
  get(scopeId: string): Promise<T | null>;
  entries(): Promise<Array<[string, T]>>;
  update(scopeId: string, patch: Partial<T>): Promise<void>;
  upsert(scopeId: string, patch: Partial<T>): Promise<void>;
  delete(scopeId: string): Promise<void>;
}

const BODY_COLUMNS: Record<string, ColumnSpec> =
  cols(`initializationPending boolean, lastSnapshotMs bigint, homeDirty boolean, snapshotError text,
    checkpointId text, checkpointAtMs bigint`);

export function sandboxBodiesMigration(
  table: string,
  extra: Record<string, ColumnSpec> = {},
  opts: { dropKeys?: readonly string[] } = {},
): MapConversion {
  return mapToTableMigration(
    `sandbox/${table}/0001-typed`,
    { table, key: "scopeId", columns: { ...BODY_COLUMNS, ...extra } },
    opts,
  );
}

export function createSandboxBodies<T extends object>(databaseUrl: string, migration: MapConversion): SandboxBodies<T> {
  const { table } = migration.spec;
  const { q } = createPgPool(databaseUrl, [migration]);
  const codec = tableCodec<T>(migration.spec);
  const names = codec.columns.split(", ");
  const fields = Object.keys(migration.spec.columns);
  const patched = (scopeId: string, patch: Partial<T>) => {
    const values = codec.values(scopeId, patch as T);
    const picked = fields.flatMap((field, i) => (Object.hasOwn(patch, field) ? [i + 1] : []));
    return { cols: picked.map((i) => names[i]!), params: [scopeId, ...picked.map((i) => values[i])] };
  };
  return {
    get: async (scopeId) =>
      codec.rows(await q(`SELECT ${codec.columns} FROM ${table} WHERE scope_id = $1`, [scopeId]))[0] ?? null,
    entries: async () =>
      (await q(`SELECT ${codec.columns} FROM ${table} ORDER BY scope_id`)).map((r) => [
        r.scope_id as string,
        codec.row(r),
      ]),
    async update(scopeId, patch) {
      const { cols, params } = patched(scopeId, patch);
      if (cols.length)
        await q(`UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE scope_id = $1`, params);
    },
    async upsert(scopeId, patch) {
      const { cols, params } = patched(scopeId, patch);
      const set = cols.length ? `UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}` : "NOTHING";
      await q(
        `INSERT INTO ${table} (${["scope_id", ...cols].join(", ")}) VALUES (${params.map((_, i) => `$${i + 1}`).join(", ")})
         ON CONFLICT (${tenantCols("scope_id")}) DO ${set}`,
        params,
      );
    },
    async delete(scopeId) {
      await q(`DELETE FROM ${table} WHERE scope_id = $1`, [scopeId]);
    },
  };
}
