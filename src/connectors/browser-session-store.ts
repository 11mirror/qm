import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
import { encryptSecret, decryptSecret, type SecretKey } from "./connector-client-store.ts";
import { swallow } from "../util/errors.ts";

export interface BrowserSessionStore {
  get(principalId: string): Promise<string | null>;
  put(principalId: string, storageStateJson: string): Promise<void>;
}

interface StoredBrowserSession {
  principalId: string;
  stateEnc: string;
  updatedAt: number;
}

const BROWSER_SESSIONS: TableSpec = {
  table: "browser_sessions",
  key: "principalId",
  keyIsField: true,
  columns: cols(`stateEnc text!, updatedAt bigint!`),
};

export const BROWSER_SESSIONS_MIGRATION = mapToTableMigration(
  "connectors/browser-sessions/0001-typed",
  BROWSER_SESSIONS,
);

const codec = tableCodec<StoredBrowserSession>(BROWSER_SESSIONS);

export function createBrowserSessionStore(deps: {
  databaseUrl: string;
  key: SecretKey;
  now?: () => number;
}): BrowserSessionStore {
  const now = deps.now ?? Date.now;
  const { q } = createPgPool(deps.databaseUrl, [BROWSER_SESSIONS_MIGRATION]);
  return {
    async get(principalId) {
      const rows = await q(`SELECT ${codec.columns} FROM browser_sessions WHERE principal_id = $1`, [principalId]);
      const rec = rows[0] ? codec.row(rows[0]) : null;
      if (!rec) return null;
      try {
        return decryptSecret(rec.stateEnc, deps.key);
      } catch (e) {
        swallow(`browser-session decrypt ${principalId}`, e);
        return null;
      }
    },
    async put(principalId, storageStateJson) {
      await q(
        `INSERT INTO browser_sessions (${codec.columns}) VALUES (${codec.placeholders})
         ON CONFLICT (${tenantCols("principal_id")}) DO UPDATE SET ${codec.updates}`,
        codec.values(principalId, {
          principalId,
          stateEnc: encryptSecret(storageStateJson, deps.key),
          updatedAt: now(),
        }),
      );
    },
  };
}
