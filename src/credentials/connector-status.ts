import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
import type { ConnectorTokenStore, OAuthTokenStatus } from "./keychain.ts";
import {
  ACCOUNT_TYPES,
  ConnectorNotConfiguredError,
  oauthProviderEntries,
  PROVIDERS,
  type OAuthClientResolver,
  type OAuthProviderConfig,
} from "../connectors/oauth.ts";
import { swallow } from "../util/errors.ts";

interface ConnectorStatusEntry {
  connected: boolean;
  mcpLabel?: string;
  expiresAt?: number;
  needsReconnect?: boolean;
  refreshFailedAt?: number;
  refreshError?: string;
}

export interface ConnectorStatusRecord {
  principalId: string;
  checkedAt: number;
  providers: Record<string, ConnectorStatusEntry>;
}

export interface ConnectorStatusCache {
  get(principalId: string): Promise<ConnectorStatusRecord | null>;
  put(record: ConnectorStatusRecord): Promise<void>;
}

const CONNECTOR_STATUS: TableSpec = {
  table: "connector_status",
  key: "principalId",
  keyIsField: true,
  columns: cols(`checkedAt bigint!, providers jsonb!`),
};

export const CONNECTOR_STATUS_MIGRATION = mapToTableMigration(
  "credentials/connector-status/0001-typed",
  CONNECTOR_STATUS,
);

const codec = tableCodec<ConnectorStatusRecord>(CONNECTOR_STATUS);

export function createConnectorStatusCache(databaseUrl: string): ConnectorStatusCache {
  const { q } = createPgPool(databaseUrl, [CONNECTOR_STATUS_MIGRATION]);
  return {
    async get(principalId) {
      const rows = await q(`SELECT ${codec.columns} FROM connector_status WHERE principal_id = $1`, [principalId]);
      return rows[0] ? codec.row(rows[0]) : null;
    },
    async put(record) {
      await q(
        `INSERT INTO connector_status (${codec.columns}) VALUES (${codec.placeholders})
         ON CONFLICT (${tenantCols("principal_id")}) DO UPDATE SET ${codec.updates}`,
        codec.values(record.principalId, record),
      );
    },
  };
}

const CONNECTOR_STATUS_MAX_TTL_MS = 15 * 60_000;

export function connectorStatusIsStale(
  record: ConnectorStatusRecord | null,
  now: number,
  maxTtlMs: number = CONNECTOR_STATUS_MAX_TTL_MS,
): boolean {
  if (!record) return true;
  if (now - record.checkedAt > maxTtlMs) return true;
  for (const entry of Object.values(record.providers)) {
    const expiredSinceChecked =
      entry.connected && entry.expiresAt !== undefined && now >= entry.expiresAt && entry.expiresAt > record.checkedAt;
    if (expiredSinceChecked) return true;
  }
  return false;
}

function bestOAuthTokenStatus(statuses: readonly OAuthTokenStatus[]): OAuthTokenStatus {
  return (
    statuses.find((s) => s.connected && !s.needsReconnect) ??
    statuses.find((s) => s.connected) ??
    statuses[0] ?? { connected: false }
  );
}

function mergeStatus(entry: ConnectorStatusEntry, status: OAuthTokenStatus): ConnectorStatusEntry {
  if (!status.connected) return entry;
  const next: ConnectorStatusEntry = { ...entry, connected: true };
  if (status.expiresAt !== undefined) {
    next.expiresAt = next.expiresAt === undefined ? status.expiresAt : Math.min(next.expiresAt, status.expiresAt);
  }
  if (status.needsReconnect) next.needsReconnect = true;
  if (
    status.refreshFailedAt !== undefined &&
    (next.refreshFailedAt === undefined || status.refreshFailedAt > next.refreshFailedAt)
  ) {
    next.refreshFailedAt = status.refreshFailedAt;
    if (status.refreshError) next.refreshError = status.refreshError;
  }
  return next;
}

export type HostTokenStatus = OAuthTokenStatus & { host: string };

export async function providerTokenStatuses(
  tokens: ConnectorTokenStore,
  principalId: string,
): Promise<Array<{ name: string; provider: OAuthProviderConfig; hosts: HostTokenStatus[] }>> {
  const all = await Promise.all(
    oauthProviderEntries().map(async ([name, provider]) => {
      const hosts = await Promise.all(
        provider.hosts.map(async (host) => {
          const statuses = await Promise.all(
            ACCOUNT_TYPES.map((accountType) => tokens.connectorTokenStatus(host, principalId, accountType)),
          );
          return { host, ...bestOAuthTokenStatus(statuses) };
        }),
      );
      return { name, provider, hosts };
    }),
  );
  return all.filter(({ provider, hosts }) => !provider.mcpLabel || hosts.some((h) => h.connected));
}

export async function refreshConnectorStatus(
  tokens: ConnectorTokenStore,
  principalId: string,
  now: number,
): Promise<ConnectorStatusRecord> {
  const providers: Record<string, ConnectorStatusEntry> = {};
  for (const { name, provider, hosts } of await providerTokenStatuses(tokens, principalId)) {
    const entry = hosts.reduce<ConnectorStatusEntry>((acc, status) => mergeStatus(acc, status), { connected: false });
    providers[name] = provider.mcpLabel ? { ...entry, mcpLabel: provider.mcpLabel } : entry;
  }
  return { principalId, checkedAt: now, providers };
}

export function connectorLabel(name: string): string {
  return PROVIDERS[name]?.label ?? name.charAt(0).toUpperCase() + name.slice(1);
}

export async function configuredConnectorProviders(resolveClient: OAuthClientResolver): Promise<string[]> {
  const configured = await Promise.all(
    Object.keys(PROVIDERS).map(async (provider) => {
      try {
        await resolveClient(provider, {});
        return provider;
      } catch (e) {
        if (!(e instanceof ConnectorNotConfiguredError)) swallow(`connectors: resolving the ${provider} client`, e);
        return null;
      }
    }),
  );
  return configured.filter((provider): provider is string => provider !== null);
}
