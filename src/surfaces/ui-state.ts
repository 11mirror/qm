import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { lockedRow } from "../persistence/locked-row.ts";
import { mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";

export interface PersistedUiState {
  value: unknown;
  updatedAt: number;
}

export const UI_STATE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const UI_STATE_MAX_BYTES = 65536;
export const UI_STATE_MAX_FUTURE_SKEW_MS = 300_000;

const WEB_UI_STATE: TableSpec = {
  table: "web_ui_state",
  key: "id",
  columns: { value: { type: "jsonb" }, updatedAt: { type: "bigint", required: true } },
};

export const WEB_UI_STATE_MIGRATION = mapToTableMigration("surfaces/ui-state/0001-typed", WEB_UI_STATE);

const codec = tableCodec<PersistedUiState>(WEB_UI_STATE);

export function uiStateId(principalId: string, key: string): string {
  return `${principalId}#${key}`;
}

export function createUiStateStore(databaseUrl: string) {
  const pg = createPgPool(databaseUrl, [WEB_UI_STATE_MIGRATION]);
  const { q } = pg;
  const upsert = (where = "") =>
    `INSERT INTO web_ui_state (${codec.columns}) VALUES (${codec.placeholders})
     ON CONFLICT (${tenantCols("id")}) DO UPDATE SET ${codec.updates} ${where} RETURNING ${codec.columns}`;
  const one = async (sql: string, params: unknown[]) => codec.rows(await q(sql, params))[0] ?? null;
  return {
    get: (id: string) => one(`SELECT ${codec.columns} FROM web_ui_state WHERE id = $1`, [id]),
    async put(id: string, state: PersistedUiState): Promise<void> {
      await q(upsert(), codec.values(id, state));
    },
    async putIfAbsent(id: string, state: PersistedUiState): Promise<PersistedUiState> {
      const kept = await one(upsert("WHERE false"), codec.values(id, state));
      return kept ?? (await one(`SELECT ${codec.columns} FROM web_ui_state WHERE id = $1`, [id])) ?? state;
    },
    async delete(id: string): Promise<void> {
      await q(`DELETE FROM web_ui_state WHERE id = $1`, [id]);
    },
    take: (id: string) => one(`DELETE FROM web_ui_state WHERE id = $1 RETURNING ${codec.columns}`, [id]),
    async storeIfNewer(id: string, next: PersistedUiState): Promise<{ ok: boolean; updatedAt: number }> {
      for (;;) {
        if (await one(upsert("WHERE web_ui_state.updated_at <= EXCLUDED.updated_at"), codec.values(id, next)))
          return { ok: true, updatedAt: next.updatedAt };
        const existing = await one(`SELECT ${codec.columns} FROM web_ui_state WHERE id = $1`, [id]);
        if (existing) return { ok: false, updatedAt: existing.updatedAt };
      }
    },
    modify: lockedRow<PersistedUiState>(pg, WEB_UI_STATE),
  };
}

export type UiStateStore = ReturnType<typeof createUiStateStore>;
