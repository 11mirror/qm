import type { PgMigrationDefinition } from "../persistence/pg-migrations.ts";

export const REMOVE_LOOP_WORK_MIGRATION: PgMigrationDefinition = {
  id: "durable-map/crons/0001-remove-loop-work",
  statements: [
    `DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'crons'::regclass AND attname = 'json' AND NOT attisdropped) THEN
        DELETE FROM crons WHERE json ? 'loopId' OR NULLIF(json #>> '{inbox,source}', '') IS NOT NULL;
        UPDATE crons SET json = jsonb_set(json, '{enabled}', 'false') WHERE json ? 'inbox';
      ELSIF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'crons'::regclass AND attname = 'inbox' AND NOT attisdropped) THEN
        DELETE FROM crons WHERE NULLIF(inbox ->> 'source', '') IS NOT NULL;
        UPDATE crons SET enabled = false WHERE inbox IS NOT NULL;
      END IF;
    END $$`,
  ],
};
