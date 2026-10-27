import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { mapToTableMigration, tableCodec, type ColumnSpec, type MapConversion } from "../persistence/typed-table.ts";

export interface DeployBodyStore<T> {
  get(deploymentId: string): Promise<T | null>;
  put(deploymentId: string, body: T): Promise<void>;
  delete(deploymentId: string): Promise<void>;
}

export function deploymentKeyedTable(table: string, columns: Readonly<Record<string, ColumnSpec>>): MapConversion {
  return mapToTableMigration(`deploy/${table}/0001-typed`, { table, key: "deploymentId", keyIsField: true, columns });
}

export function createDeployBodyStore<T>(databaseUrl: string, migration: MapConversion): DeployBodyStore<T> {
  const { table } = migration.spec;
  const codec = tableCodec<T>(migration.spec);
  const { q } = createPgPool(databaseUrl, [migration]);
  return {
    async get(deploymentId) {
      const rows = await q(`SELECT ${codec.columns} FROM ${table} WHERE deployment_id = $1`, [deploymentId]);
      return codec.rows(rows)[0] ?? null;
    },
    async put(deploymentId, body) {
      await q(
        `INSERT INTO ${table} (${codec.columns}) VALUES (${codec.placeholders})
         ON CONFLICT (${tenantCols("deployment_id")}) DO UPDATE SET ${codec.updates}`,
        codec.values(deploymentId, body),
      );
    },
    async delete(deploymentId) {
      await q(`DELETE FROM ${table} WHERE deployment_id = $1`, [deploymentId]);
    },
  };
}
