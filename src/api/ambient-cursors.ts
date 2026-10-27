import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";

export interface AmbientCursor {
  lastJudgedTs: string;
  lastJudgedAt?: number;
}

const AMBIENT_CURSORS: TableSpec = {
  table: "ambient_cursors",
  key: "id",
  columns: { lastJudgedTs: { type: "text", required: true }, lastJudgedAt: { type: "bigint" } },
};

export const AMBIENT_CURSORS_MIGRATION = mapToTableMigration("api/ambient-cursors/0001-typed", AMBIENT_CURSORS);

const codec = tableCodec<AmbientCursor>(AMBIENT_CURSORS);

export function createAmbientCursors(databaseUrl: string) {
  const { q } = createPgPool(databaseUrl, [AMBIENT_CURSORS_MIGRATION]);
  return {
    async get(key: string): Promise<AmbientCursor | null> {
      return codec.rows(await q(`SELECT ${codec.columns} FROM ambient_cursors WHERE id = $1`, [key]))[0] ?? null;
    },
    async put(key: string, cursor: AmbientCursor): Promise<void> {
      await q(
        `INSERT INTO ambient_cursors (${codec.columns}) VALUES (${codec.placeholders})
         ON CONFLICT (${tenantCols("id")}) DO UPDATE SET ${codec.updates}`,
        codec.values(key, cursor),
      );
    },
  };
}

export type AmbientCursors = ReturnType<typeof createAmbientCursors>;
