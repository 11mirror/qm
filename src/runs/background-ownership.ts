import { createPgPool, withPgTransaction, type PoolClient } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, type TableSpec } from "../persistence/typed-table.ts";

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
  const pg = createPgPool(databaseUrl, [BACKGROUND_OWNERSHIP_MIGRATION]);
  const read = async (client: Pick<PoolClient, "query">): Promise<BackgroundOwnership> => {
    const { rows } = await client.query(
      'SELECT owner_deployment_id AS "ownerDeploymentId", set_at AS "setAt", set_by AS "setBy" FROM background_ownership WHERE id = $1',
      [KEY],
    );
    return { ...UNOWNED, ...rows[0] };
  };
  const get = async () => read(await pg.deploymentPool());
  return {
    get,
    async set(change: BackgroundOwnershipChange): Promise<BackgroundOwnership> {
      return withPgTransaction(await pg.deploymentPool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('qm:background-ownership'))");
        const current = await read(client);
        if (
          change.expectedOwnerDeploymentId !== undefined &&
          current.ownerDeploymentId !== change.expectedOwnerDeploymentId &&
          current.ownerDeploymentId !== change.ownerDeploymentId
        )
          throw new BackgroundOwnershipConflict("Background owner changed");
        if (current.ownerDeploymentId === change.ownerDeploymentId) return current;
        const next = {
          ownerDeploymentId: change.ownerDeploymentId,
          setAt: new Date().toISOString(),
          setBy: change.setBy,
        };
        await client.query(
          "INSERT INTO background_ownership(id, owner_deployment_id, set_at, set_by) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET owner_deployment_id=EXCLUDED.owner_deployment_id, set_at=EXCLUDED.set_at, set_by=EXCLUDED.set_by",
          [KEY, next.ownerDeploymentId, next.setAt, next.setBy],
        );
        return next;
      });
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
