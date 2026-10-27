import { LOOPS_TO_CRONS_MIGRATION } from "../cron/migrations.ts";
import { INBOX_ITEM_SOURCE_MIGRATION, inboxConversationKeyMigration } from "../inbox/ledger.ts";
import type { Stores } from "./stores.ts";

/** Legacy durable-map and runtime table migrations, registered on the shared pool before first use. */
export function registerLegacyMigrations(w: Pick<Stores, "pgArtifactMap">) {
  const { pgArtifactMap } = w;

  pgArtifactMap.pool.registerMigration(LOOPS_TO_CRONS_MIGRATION);
  pgArtifactMap.pool.registerMigration(INBOX_ITEM_SOURCE_MIGRATION);
  pgArtifactMap.pool.registerMigration(inboxConversationKeyMigration());
  pgArtifactMap.pool.registerMigration({
    id: "durable-map/model_registry/0002-drop",
    statements: [
      "DROP TABLE IF EXISTS model_registry",
      "DELETE FROM durable_map_versions WHERE tbl = 'model_registry'",
    ],
  });
  pgArtifactMap.pool.registerMigration({
    id: "runtime/0002-drop-harness-choice",
    statements: [
      "DROP TABLE IF EXISTS approved_harness_configs",
      "DELETE FROM durable_map_versions WHERE tbl = 'approved_harness_configs'",
      `DO $$ BEGIN IF to_regclass('base_model_configs') IS NOT NULL THEN UPDATE base_model_configs SET json = (CASE WHEN json ? 'harnessId' AND NOT json ? 'orgRevision' THEN json || '{"orgRevision":0}'::jsonb ELSE json END) - 'harnessId' #- '{cronRuntime,harnessId}' #- '{subagentRuntime,harnessId}' #- '{fallbackRuntime,harnessId}' WHERE json ? 'harnessId' OR (json -> 'cronRuntime') ? 'harnessId' OR (json -> 'subagentRuntime') ? 'harnessId' OR (json -> 'fallbackRuntime') ? 'harnessId'; END IF; END $$`,
      `DO $$ BEGIN IF to_regclass('auto_flagger_configs') IS NOT NULL THEN UPDATE auto_flagger_configs SET json = json - 'harnessId' WHERE json ? 'harnessId'; END IF; END $$`,
      `DO $$ BEGIN IF to_regclass('crons') IS NOT NULL THEN UPDATE crons SET json = json #- '{runtime,harnessId}' WHERE (json -> 'runtime') ? 'harnessId'; END IF; END $$`,
      `DO $$ BEGIN IF to_regclass('swarms') IS NOT NULL THEN UPDATE swarms SET json = json #- '{template,harness}' WHERE (json -> 'template') ? 'harness'; END IF; END $$`,
    ],
  });
  pgArtifactMap.pool.registerMigration({
    id: "runtime/0003-promote-legacy-base-models",
    statements: [
      `DO $$ BEGIN IF to_regclass('base_model_configs') IS NOT NULL THEN UPDATE base_model_configs SET json = json || '{"orgRevision":0}'::jsonb WHERE json ? 'modelId' AND NOT json ? 'orgRevision'; END IF; END $$`,
    ],
  });
  pgArtifactMap.pool.registerMigration({
    id: "durable-map/swarms/0002-drop",
    statements: [
      `DO $$ BEGIN IF to_regclass('runs') IS NOT NULL THEN UPDATE runs SET status = 'failed', result = json_build_object('status', 'failed', 'sessionId', session_id, 'reason', 'swarms were removed')::text, lease_token = NULL, lease_expires_at = NULL, worker_id = NULL, finished_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint WHERE status IN ('pending', 'running') AND (session_id LIKE 'swarm:%' OR request LIKE '%"swarm":%'); END IF; END $$`,
      "DROP TABLE IF EXISTS swarms",
      "DELETE FROM durable_map_versions WHERE tbl = 'swarms'",
      "DO $$ BEGIN IF to_regclass('feature_flags') IS NOT NULL THEN DELETE FROM feature_flags WHERE id = 'swarms'; END IF; END $$",
    ],
  });
}
