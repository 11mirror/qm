import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";

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
  columns: cols(`url text, toolkit text!, expiresAt bigint!`),
};

const SLACK_ACCOUNTS: TableSpec = {
  table: "slack_accounts",
  key: "principalId",
  keyIsField: true,
  columns: cols(`accountId text!, memberId text!, userId text!, teamId text!, user text!, workspace text!`),
};

export const COMPOSIO_RETURNS_MIGRATION = mapToTableMigration(
  "connectors/composio-returns/0001-typed",
  COMPOSIO_RETURNS,
);
export const SLACK_ACCOUNTS_MIGRATION = mapToTableMigration("connectors/slack-accounts/0001-typed", SLACK_ACCOUNTS);

export function createComposioReturns(databaseUrl: string) {
  const pg = createPgPool(databaseUrl, [COMPOSIO_RETURNS_MIGRATION]);
  const table = typedTable<ComposioReturn>(pg, COMPOSIO_RETURNS);
  return {
    put: table.put,
    async take(key: string): Promise<ComposioReturn | null> {
      const row = await table.take(key);
      return row ? { ...row, url: row.url ?? null } : null;
    },
    async deleteExpired(now: number): Promise<void> {
      await pg.q(`DELETE FROM composio_returns WHERE expires_at <= $1`, [now]);
    },
  };
}

export function createSlackAccounts(databaseUrl: string) {
  const table = typedTable<SlackAccountLink>(createPgPool(databaseUrl, [SLACK_ACCOUNTS_MIGRATION]), SLACK_ACCOUNTS);
  return { get: table.get, put: (link: SlackAccountLink) => table.put(link.principalId, link) };
}

export type ComposioReturns = ReturnType<typeof createComposioReturns>;
export type SlackAccounts = ReturnType<typeof createSlackAccounts>;
