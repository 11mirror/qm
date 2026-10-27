import { createPgPool } from "../persistence/pg-pool.ts";
import {
  mapToTableMigration,
  typedTable,
  type ColumnSpec,
  type MapConversion,
  type TypedTable,
} from "../persistence/typed-table.ts";

export type DeployBodyStore<T> = TypedTable<T>;

export function deploymentKeyedTable(table: string, columns: Readonly<Record<string, ColumnSpec>>): MapConversion {
  return mapToTableMigration(`deploy/${table}/0001-typed`, { table, key: "deploymentId", keyIsField: true, columns });
}

export function createDeployBodyStore<T>(databaseUrl: string, migration: MapConversion): DeployBodyStore<T> {
  return typedTable<T>(createPgPool(databaseUrl, [migration]), migration.spec);
}
