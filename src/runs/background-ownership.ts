import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";

export interface BackgroundOwnership {
  ownerDeploymentId: string | null;
  setAt: string | null;
  setBy: string | null;
}

export interface BackgroundOwnershipChange {
  ownerDeploymentId: string | null;
  expectedOwnerDeploymentId?: string | null;
  setBy: string;
}

export class BackgroundOwnershipConflict extends Error {}

const BACKGROUND_OWNERSHIP: TableSpec = {
  table: "background_ownership",
  key: "id",
  columns: cols(`ownerDeploymentId text, setAt text, setBy text`),
};

const MEMBER_PROTOCOL_KEYS = [
  "enabled",
  "generation",
  "desiredDeploymentId",
  "lastRequestId",
  "lastRequest",
  "members",
];

const OWNER_FROM_MEMBER_PROTOCOL = `DO $owner$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'background_ownership'::regclass AND attname = 'json' AND NOT attisdropped) THEN
    UPDATE background_ownership SET json = jsonb_build_object(
      'ownerDeploymentId', CASE WHEN json->'enabled' = 'true'::jsonb THEN json->'desiredDeploymentId' ELSE 'null'::jsonb END,
      'setAt', null, 'setBy', null)
    WHERE NOT json ? 'ownerDeploymentId'
       OR (json ? 'desiredDeploymentId' AND json->'desiredDeploymentId' IS DISTINCT FROM json->'ownerDeploymentId');
  END IF;
END $owner$`;

const converted = mapToTableMigration("runs/background-ownership/0001-typed", BACKGROUND_OWNERSHIP, {
  dropKeys: MEMBER_PROTOCOL_KEYS,
});

export const BACKGROUND_OWNERSHIP_MIGRATION = {
  ...converted,
  statements: [converted.statements[0]!, OWNER_FROM_MEMBER_PROTOCOL, ...converted.statements.slice(1)],
};

const KEY = "ownership";

const UNOWNED: BackgroundOwnership = { ownerDeploymentId: null, setAt: null, setBy: null };

export function createBackgroundOwnershipStore(databaseUrl: string) {
  const table = typedTable<Partial<BackgroundOwnership>>(
    createPgPool(databaseUrl, [BACKGROUND_OWNERSHIP_MIGRATION]),
    BACKGROUND_OWNERSHIP,
  );
  const get = async (): Promise<BackgroundOwnership> => ({ ...UNOWNED, ...(await table.get(KEY)) });
  return {
    get,
    async set(change: BackgroundOwnershipChange): Promise<BackgroundOwnership> {
      const next = await table.modify(KEY, (stored) => {
        const current = { ...UNOWNED, ...stored };
        if (
          change.expectedOwnerDeploymentId !== undefined &&
          current.ownerDeploymentId !== change.expectedOwnerDeploymentId &&
          current.ownerDeploymentId !== change.ownerDeploymentId
        )
          throw new BackgroundOwnershipConflict("Background owner changed");
        if (current.ownerDeploymentId === change.ownerDeploymentId) return stored;
        return { ownerDeploymentId: change.ownerDeploymentId, setAt: new Date().toISOString(), setBy: change.setBy };
      });
      return { ...UNOWNED, ...next };
    },
  };
}

export type BackgroundOwnershipStore = ReturnType<typeof createBackgroundOwnershipStore>;

export interface BackgroundOwnershipControl {
  store: BackgroundOwnershipStore;
  instanceId: string;
  deploymentId: string;
  active: () => boolean;
}
