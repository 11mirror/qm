import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";

export interface PersistedUiState {
  value: unknown;
  updatedAt: number;
}

export const UI_STATE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const UI_STATE_MAX_BYTES = 65536;
export const UI_STATE_MAX_FUTURE_SKEW_MS = 300_000;

const WEB_UI_STATE: TableSpec = {
  table: "web_ui_state",
  key: "id",
  columns: cols(`value jsonb, updatedAt bigint!`),
};

export const WEB_UI_STATE_MIGRATION = mapToTableMigration("surfaces/ui-state/0001-typed", WEB_UI_STATE);

export function uiStateId(principalId: string, key: string): string {
  return `${principalId}#${key}`;
}

export function createUiStateStore(databaseUrl: string) {
  const pg = createPgPool(databaseUrl, [WEB_UI_STATE_MIGRATION]);
  const table = typedTable<PersistedUiState>(pg, WEB_UI_STATE);
  const { codec } = table;
  const storeIfNewer = `INSERT INTO web_ui_state (${codec.columns}) VALUES (${codec.placeholders})
     ON CONFLICT (${tenantCols("id")}) DO UPDATE SET ${codec.updates}
     WHERE web_ui_state.updated_at <= EXCLUDED.updated_at RETURNING 1 AS ok`;
  return {
    get: table.get,
    put: table.put,
    putIfAbsent: table.insertOrGet,
    delete: table.delete,
    take: table.take,
    modify: table.modify,
    async storeIfNewer(id: string, next: PersistedUiState): Promise<{ ok: boolean; updatedAt: number }> {
      for (;;) {
        if ((await pg.q(storeIfNewer, codec.values(id, next))).length) return { ok: true, updatedAt: next.updatedAt };
        const existing = await table.get(id);
        if (existing) return { ok: false, updatedAt: existing.updatedAt };
      }
    },
  };
}

export type UiStateStore = ReturnType<typeof createUiStateStore>;
