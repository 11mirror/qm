import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";

export interface AmbientCursor {
  lastJudgedTs: string;
  lastJudgedAt?: number;
}

const AMBIENT_CURSORS: TableSpec = {
  table: "ambient_cursors",
  key: "id",
  columns: cols(`lastJudgedTs text!, lastJudgedAt bigint`),
};

export const AMBIENT_CURSORS_MIGRATION = mapToTableMigration("api/ambient-cursors/0001-typed", AMBIENT_CURSORS);

export function createAmbientCursors(databaseUrl: string) {
  const pg = createPgPool(databaseUrl, [AMBIENT_CURSORS_MIGRATION]);
  const { get, put } = typedTable<AmbientCursor>(pg, AMBIENT_CURSORS);
  return { get, put };
}

export type AmbientCursors = ReturnType<typeof createAmbientCursors>;
