import { createPgPool, tenantCols, tenantLockKey, withPgTransaction, type PgPool } from "../persistence/pg-pool.ts";
import {
  columnName,
  mapToTableMigration,
  tableCodec,
  type ColumnSpec,
  type MapConversion,
  type TableSpec,
} from "../persistence/typed-table.ts";

const scoped = (table: string, columns: Record<string, ColumnSpec>): TableSpec => ({
  table,
  key: "scopeId",
  keyIsField: true,
  columns,
});
const required = (type: ColumnSpec["type"]): ColumnSpec => ({ type, required: true });
const flag = (table: string) => scoped(table, { on: required("boolean") });

export const CONFIG_TABLES = {
  connectorClients: {
    table: "connector_clients",
    key: "id",
    columns: {
      scopeId: required("text"),
      provider: required("text"),
      clientId: required("text"),
      secretEnc: required("text"),
      scopes: { type: "text[]" },
      redirectAllowlist: { type: "text[]" },
      consentMode: { type: "text" },
      hostedDomain: { type: "text" },
      enabled: required("boolean"),
      updatedBy: { type: "text" },
      updatedAt: required("bigint"),
    },
  },
  instructions: scoped("soul_configs", {
    content: required("text"),
    version: required("bigint"),
    updatedAt: { type: "bigint" },
    updatedBy: { type: "text" },
    history: { type: "jsonb" },
  }),
  instructionsHistory: {
    table: "soul_history",
    key: "id",
    columns: {
      scopeId: required("text"),
      content: required("text"),
      version: required("bigint"),
      updatedAt: { type: "bigint" },
      updatedBy: { type: "text" },
    },
  },
  commandPolicies: scoped("command_policies", { policy: required("jsonb") }),
  approvalGrantModes: scoped("approval_grant_modes", { modes: required("jsonb") }),
  egressPolicies: scoped("egress_policies", { policy: required("jsonb") }),
  unfulfilledInsights: flag("unfulfilled_insights_flag"),
  externalSlackParticipants: flag("external_slack_participants_flag"),
  channelHeaderPin: flag("channel_header_pin_flag"),
  baseModels: scoped("base_model_configs", {
    embeddingModelId: { type: "text" },
    modelId: { type: "text" },
    cronRuntime: { type: "jsonb" },
    subagentRuntime: { type: "jsonb" },
    fallbackRuntime: { type: "jsonb" },
    orgRevision: { type: "bigint" },
    revision: { type: "bigint" },
    effortLevel: { type: "text" },
    fastMode: { type: "boolean" },
  }),
  orgAmbient: flag("org_ambient_flag"),
  interactiveFastMode: flag("interactive_fast_mode_flag"),
  individualModelAuth: scoped("individual_model_auth_flag", { on: required("boolean"), provider: { type: "text" } }),
  webuiModels: scoped("webui_model_configs", { ids: required("text[]") }),
  ackEmoji: scoped("ack_emoji", { names: required("text[]") }),
  slackEmojiCatalog: scoped("slack_emoji_catalog", { emoji: required("jsonb"), updatedAt: required("bigint") }),
  branding: scoped("branding_configs", { branding: required("jsonb") }),
  browseMaxSteps: scoped("browse_max_steps_configs", { steps: required("bigint") }),
  browseModels: scoped("browse_model_configs", { modelId: required("text") }),
  autoFlaggerConfigs: scoped("auto_flagger_configs", { modelId: required("text"), rubric: required("text") }),
  deploymentIdentity: { table: "deployment_identity", key: "id", columns: { orgId: required("text") } },
} satisfies Record<string, TableSpec>;

export type ConfigTableName = keyof typeof CONFIG_TABLES;

const CONVERSION_OPTIONS: Partial<Record<ConfigTableName, Parameters<typeof mapToTableMigration>[2]>> = {
  instructions: { dropKeys: ["mutationId"] },
  connectorClients: {
    statements: ["CREATE INDEX IF NOT EXISTS connector_clients_scope_id ON connector_clients (scope_id)"],
  },
};

export const CONFIG_TABLE_MIGRATIONS: readonly MapConversion[] = (
  Object.entries(CONFIG_TABLES) as [ConfigTableName, TableSpec][]
).map(([name, spec]) => mapToTableMigration(`typed/config/${spec.table}/0001`, spec, CONVERSION_OPTIONS[name]));

export interface KeyedTable<T> {
  get(key: string): Promise<T | null>;
  all(): Promise<T[]>;
  where(field: Extract<keyof T, string>, value: string): Promise<T[]>;
  put(key: string, record: T): Promise<void>;
  delete(key: string): Promise<void>;
  update(key: string, fn: (current: T | null) => T | null): Promise<T | null>;
  insertOrGet(key: string, record: T): Promise<T>;
}

export function keyedTable<T>(db: PgPool, spec: TableSpec): KeyedTable<T> {
  const codec = tableCodec<T>(spec);
  const key = columnName(spec.key);
  const select = `SELECT ${codec.columns} FROM ${spec.table}`;
  const insert = `INSERT INTO ${spec.table} (${codec.columns}) VALUES (${codec.placeholders})
    ON CONFLICT (${tenantCols(key)}) DO UPDATE SET`;
  const upsert = `${insert} ${codec.updates}`;
  const remove = `DELETE FROM ${spec.table} WHERE ${key} = $1`;
  return {
    get: async (id) => codec.rows(await db.q(`${select} WHERE ${key} = $1`, [id]))[0] ?? null,
    all: async () => codec.rows(await db.q(`${select} ORDER BY ${key}`)),
    where: async (field, value) =>
      codec.rows(await db.q(`${select} WHERE ${columnName(field)} = $1 ORDER BY ${key}`, [value])),
    async put(id, record) {
      await db.q(upsert, codec.values(id, record));
    },
    async delete(id) {
      await db.q(remove, [id]);
    },
    update: async (id, fn) =>
      withPgTransaction(await db.pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [tenantLockKey(`${spec.table}:${id}`)]);
        const current = codec.rows((await client.query(`${select} WHERE ${key} = $1`, [id])).rows)[0] ?? null;
        const next = fn(current);
        if (next === current) return current;
        if (next) await client.query(upsert, codec.values(id, next));
        else await client.query(remove, [id]);
        return next;
      }),
    insertOrGet: async (id, record) =>
      codec.row(
        (
          await db.q(`${insert} ${key} = ${spec.table}.${key} RETURNING ${codec.columns}`, codec.values(id, record))
        )[0]!,
      ),
  };
}

export type ConfigTables<R extends Record<ConfigTableName, unknown>> = { [K in ConfigTableName]: KeyedTable<R[K]> };

export function openConfigTables<R extends Record<ConfigTableName, unknown>>(databaseUrl: string): ConfigTables<R> {
  const db = createPgPool(databaseUrl, CONFIG_TABLE_MIGRATIONS);
  return Object.fromEntries(
    (Object.entries(CONFIG_TABLES) as [ConfigTableName, TableSpec][]).map(([name, spec]) => [
      name,
      keyedTable(db, spec),
    ]),
  ) as ConfigTables<R>;
}
