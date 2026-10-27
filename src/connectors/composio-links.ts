import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";

export interface ComposioReturn {
  url: string | null;
  toolkit: string;
  expiresAt: number;
}

export interface SlackAccountLink {
  principalId: string;
  accountId: string;
  memberId: string;
  userId: string;
  teamId: string;
  user: string;
  workspace: string;
}

const COMPOSIO_RETURNS: TableSpec = {
  table: "composio_returns",
  key: "id",
  columns: {
    url: { type: "text" },
    toolkit: { type: "text", required: true },
    expiresAt: { type: "bigint", required: true },
  },
};

const SLACK_ACCOUNTS: TableSpec = {
  table: "slack_accounts",
  key: "principalId",
  keyIsField: true,
  columns: {
    accountId: { type: "text", required: true },
    memberId: { type: "text", required: true },
    userId: { type: "text", required: true },
    teamId: { type: "text", required: true },
    user: { type: "text", required: true },
    workspace: { type: "text", required: true },
  },
};

export const COMPOSIO_RETURNS_MIGRATION = mapToTableMigration(
  "connectors/composio-returns/0001-typed",
  COMPOSIO_RETURNS,
);
export const SLACK_ACCOUNTS_MIGRATION = mapToTableMigration("connectors/slack-accounts/0001-typed", SLACK_ACCOUNTS);

const returns = tableCodec<ComposioReturn>(COMPOSIO_RETURNS);
const accounts = tableCodec<SlackAccountLink>(SLACK_ACCOUNTS);

export function createComposioReturns(databaseUrl: string) {
  const { q } = createPgPool(databaseUrl, [COMPOSIO_RETURNS_MIGRATION]);
  return {
    async put(key: string, value: ComposioReturn): Promise<void> {
      await q(
        `INSERT INTO composio_returns (${returns.columns}) VALUES (${returns.placeholders})
         ON CONFLICT (${tenantCols("id")}) DO UPDATE SET ${returns.updates}`,
        returns.values(key, value),
      );
    },
    async take(key: string): Promise<ComposioReturn | null> {
      const row = returns.rows(
        await q(`DELETE FROM composio_returns WHERE id = $1 RETURNING ${returns.columns}`, [key]),
      )[0];
      return row ? { ...row, url: row.url ?? null } : null;
    },
    async deleteExpired(now: number): Promise<void> {
      await q(`DELETE FROM composio_returns WHERE expires_at <= $1`, [now]);
    },
  };
}

export function createSlackAccounts(databaseUrl: string) {
  const { q } = createPgPool(databaseUrl, [SLACK_ACCOUNTS_MIGRATION]);
  return {
    async get(principalId: string): Promise<SlackAccountLink | null> {
      return (
        accounts.rows(
          await q(`SELECT ${accounts.columns} FROM slack_accounts WHERE principal_id = $1`, [principalId]),
        )[0] ?? null
      );
    },
    async put(link: SlackAccountLink): Promise<void> {
      await q(
        `INSERT INTO slack_accounts (${accounts.columns}) VALUES (${accounts.placeholders})
         ON CONFLICT (${tenantCols("principal_id")}) DO UPDATE SET ${accounts.updates}`,
        accounts.values(link.principalId, link),
      );
    },
  };
}

export type ComposioReturns = ReturnType<typeof createComposioReturns>;
export type SlackAccounts = ReturnType<typeof createSlackAccounts>;
