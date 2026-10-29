import { createPgPool } from "../persistence/pg-pool.ts";
import {
  cols,
  mapToTableMigration,
  typedTable,
  type MapConversion,
  type TableSpec,
  type TypedTable,
} from "../persistence/typed-table.ts";

const scoped = (table: string, defs: string): TableSpec => ({
  table,
  key: "scopeId",
  keyIsField: true,
  columns: cols(defs),
});
const flag = (table: string) => scoped(table, "on boolean!");

export const CONFIG_TABLES = {
  connectorClients: {
    table: "connector_clients",
    key: "id",
    columns: cols(`scopeId text!, provider text!, clientId text!, secretEnc text!, scopes text[],
    redirectAllowlist text[], consentMode text, hostedDomain text, enabled boolean!,
    updatedBy text, updatedAt bigint!`),
  },
  instructions: scoped(
    "soul_configs",
    "content text!, version bigint!, updatedAt bigint, updatedBy text, history jsonb",
  ),
  instructionsHistory: {
    table: "soul_history",
    key: "id",
    columns: cols(`scopeId text!, content text!, version bigint!, updatedAt bigint, updatedBy text`),
  },
  commandPolicies: scoped("command_policies", "policy jsonb!"),
  approvalGrantModes: scoped("approval_grant_modes", "modes jsonb!"),
  egressPolicies: scoped("egress_policies", "policy jsonb!"),
  externalSlackParticipants: flag("external_slack_participants_flag"),
  channelHeaderPin: flag("channel_header_pin_flag"),
  baseModels: scoped(
    "base_model_configs",
    `embeddingModelId text, modelId text, cronRuntime jsonb, subagentRuntime jsonb,
    fallbackRuntime jsonb, orgRevision bigint, revision bigint, effortLevel text, fastMode boolean`,
  ),
  orgAmbient: flag("org_ambient_flag"),
  interactiveFastMode: flag("interactive_fast_mode_flag"),
  individualModelAuth: scoped("individual_model_auth_flag", "on boolean!, provider text"),
  webuiModels: scoped("webui_model_configs", "ids text[]!"),
  ackEmoji: scoped("ack_emoji", "names text[]!"),
  slackEmojiCatalog: scoped("slack_emoji_catalog", "emoji jsonb!, updatedAt bigint!"),
  branding: scoped("branding_configs", "branding jsonb!"),
  browseMaxSteps: scoped("browse_max_steps_configs", "steps bigint!"),
  autoFlaggerConfigs: scoped("auto_flagger_configs", "modelId text!, rubric text!"),
  deploymentIdentity: { table: "deployment_identity", key: "id", columns: cols("orgId text!") },
} satisfies Record<string, TableSpec>;

export type ConfigTableName = keyof typeof CONFIG_TABLES;

const CONVERSION_OPTIONS: Partial<Record<ConfigTableName, Parameters<typeof mapToTableMigration>[2]>> = {
  instructions: { dropKeys: ["mutationId"] },
  connectorClients: {
    statements: ["CREATE INDEX IF NOT EXISTS connector_clients_scope_id ON connector_clients (scope_id)"],
  },
};

const CONFIG_TABLE_MIGRATIONS: readonly MapConversion[] = (
  Object.entries(CONFIG_TABLES) as [ConfigTableName, TableSpec][]
).map(([name, spec]) => mapToTableMigration(`typed/config/${spec.table}/0001`, spec, CONVERSION_OPTIONS[name]));

export type ConfigTables<R extends Record<ConfigTableName, unknown>> = { [K in ConfigTableName]: TypedTable<R[K]> };

export function openConfigTables<R extends Record<ConfigTableName, unknown>>(databaseUrl: string): ConfigTables<R> {
  const db = createPgPool(databaseUrl, CONFIG_TABLE_MIGRATIONS);
  return Object.fromEntries(
    (Object.entries(CONFIG_TABLES) as [ConfigTableName, TableSpec][]).map(([name, spec]) => [
      name,
      typedTable(db, spec),
    ]),
  ) as ConfigTables<R>;
}
