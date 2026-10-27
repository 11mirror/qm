import type { PgMigrationDefinition } from "./pg-pool.ts";
import { mapConversions } from "./typed-table.ts";

export const CONTRACT_MIGRATIONS: readonly PgMigrationDefinition[] = [
  { id: "contract/0001-drop-deliveries", statements: ["DROP TABLE IF EXISTS deliveries"] },
  {
    id: "contract/0002-drop-model-registry",
    statements: [
      "DROP TABLE IF EXISTS model_registry",
      "DELETE FROM durable_map_versions WHERE tbl = 'model_registry'",
    ],
  },
  {
    id: "contract/0003-drop-approved-harness-configs",
    statements: [
      "DROP TABLE IF EXISTS approved_harness_configs",
      "DELETE FROM durable_map_versions WHERE tbl = 'approved_harness_configs'",
    ],
  },
  {
    id: "contract/0004-drop-swarms",
    statements: ["DROP TABLE IF EXISTS swarms", "DELETE FROM durable_map_versions WHERE tbl = 'swarms'"],
  },
  {
    id: "contract/0005-drop-spend-json-indexes",
    statements: [
      "SET LOCAL lock_timeout = '3s'",
      "DROP INDEX IF EXISTS session_llm_requests_spend",
      "DROP INDEX IF EXISTS session_llm_requests_spend_wide",
    ],
  },
  {
    id: "contract/0006-drop-channel-policy-orders",
    statements: [
      "SET LOCAL lock_timeout = '3s'",
      "ALTER TABLE channel_policy DROP COLUMN IF EXISTS orders",
      "ALTER TABLE channel_policy_history DROP COLUMN IF EXISTS orders",
    ],
  },
  {
    id: "contract/0007-drop-durable-map-versions",
    statements: ["DROP FUNCTION IF EXISTS qm_durable_map_bump() CASCADE", "DROP TABLE IF EXISTS durable_map_versions"],
  },
  {
    id: "contract/0008-drop-sandbox-routing",
    statements: ["DROP TABLE IF EXISTS sandbox_routing", "DROP TABLE IF EXISTS sandbox_resource_rollout"],
  },
];

export const contractMigrations = (): PgMigrationDefinition[] => [
  ...CONTRACT_MIGRATIONS,
  ...mapConversions().map((conversion) => conversion.contract),
];
