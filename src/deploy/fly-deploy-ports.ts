import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable } from "../persistence/typed-table.ts";

export const FLY_DEPLOY_PORTS = mapToTableMigration("deploy/fly_deploy_ports/0001-typed", {
  table: "fly_deploy_ports",
  key: "slot",
  columns: cols("deploymentId text!"),
});

const stringPorts = {
  id: "deploy/fly_deploy_ports/0000-assignments",
  statements: [
    `DO $ports$ BEGIN
      IF to_regclass('fly_deploy_ports') IS NOT NULL AND EXISTS (
        SELECT 1 FROM pg_attribute WHERE attrelid = 'fly_deploy_ports'::regclass AND attname = 'json' AND NOT attisdropped
      ) THEN UPDATE fly_deploy_ports SET json = jsonb_build_object('deploymentId', json #>> '{}')
        WHERE jsonb_typeof(json) = 'string';
      END IF;
    END $ports$`,
  ],
};

FLY_DEPLOY_PORTS.before = [stringPorts];

export function flyDeployPorts(databaseUrl: string) {
  const db = createPgPool(databaseUrl, [stringPorts, FLY_DEPLOY_PORTS]);
  const rows = typedTable<{ deploymentId: string }>(db, FLY_DEPLOY_PORTS.spec);
  return {
    putIfAbsent: async (slot: string, deploymentId: string): Promise<string> =>
      (await rows.insertOrGet(slot, { deploymentId })).deploymentId,
  };
}
