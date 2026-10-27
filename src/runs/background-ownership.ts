import { createPgPool, tenantCols, withPgTransaction } from "../persistence/pg-pool.ts";
import { mapToTableMigration, type TableSpec } from "../persistence/typed-table.ts";

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
  columns: { ownerDeploymentId: { type: "text" }, setAt: { type: "text" }, setBy: { type: "text" } },
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

function ownership(row: Record<string, unknown> | undefined): BackgroundOwnership {
  return {
    ownerDeploymentId: (row?.owner_deployment_id as string | null | undefined) ?? null,
    setAt: (row?.set_at as string | null | undefined) ?? null,
    setBy: (row?.set_by as string | null | undefined) ?? null,
  };
}

export function createBackgroundOwnershipStore(databaseUrl: string) {
  const { q, pool } = createPgPool(databaseUrl, [BACKGROUND_OWNERSHIP_MIGRATION]);
  const columns = "owner_deployment_id, set_at, set_by";
  return {
    async get(): Promise<BackgroundOwnership> {
      return ownership((await q(`SELECT ${columns} FROM background_ownership WHERE id = $1`, [KEY]))[0]);
    },
    async set(change: BackgroundOwnershipChange): Promise<BackgroundOwnership> {
      return withPgTransaction(await pool(), async (client) => {
        await client.query(
          `INSERT INTO background_ownership (id) VALUES ($1) ON CONFLICT (${tenantCols("id")}) DO NOTHING`,
          [KEY],
        );
        const current = ownership(
          (await client.query(`SELECT ${columns} FROM background_ownership WHERE id = $1 FOR UPDATE`, [KEY])).rows[0],
        );
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
          `UPDATE background_ownership SET owner_deployment_id = $2, set_at = $3, set_by = $4 WHERE id = $1`,
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
