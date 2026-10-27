import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
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

const BROWSER_SESSIONS_MIGRATION = mapToTableMigration("connectors/browser-sessions/0001-typed", BROWSER_SESSIONS);

export function createBrowserSessionStore(deps: {
  databaseUrl: string;
  key: SecretKey;
  now?: () => number;
}): BrowserSessionStore {
  const now = deps.now ?? Date.now;
  const table = typedTable<StoredBrowserSession>(
    createPgPool(deps.databaseUrl, [BROWSER_SESSIONS_MIGRATION]),
    BROWSER_SESSIONS,
  );
  return {
    async get(principalId) {
      const rec = await table.get(principalId);
      if (!rec) return null;
      try {
        return decryptSecret(rec.stateEnc, deps.key);
      } catch (e) {
        swallow(`browser-session decrypt ${principalId}`, e);
        return null;
      }
    },
    async put(principalId, storageStateJson) {
      await table.put(principalId, {
        principalId,
        stateEnc: encryptSecret(storageStateJson, deps.key),
        updatedAt: now(),
      });
    },
  };
}
