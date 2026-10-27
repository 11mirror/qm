import { createOneTimeStore, type OneTimeResult } from "../persistence/one-time-store.ts";
import { mapToTableMigration } from "../persistence/typed-table.ts";
import type { AccountType } from "./oauth.ts";

export interface ConsentLinkRecord {
  principalId: string;
  orgId?: string;
  provider: string;
  accountType: AccountType;
  redirectUri: string;
  returnTo?: string;
  createdAt: number;
}

export interface ConsentLinkStore {
  mint(rec: Omit<ConsentLinkRecord, "createdAt">, now?: number): Promise<{ linkId: string }>;
  peek(linkId: string, now?: number): Promise<OneTimeResult<ConsentLinkRecord>>;
  redeem(linkId: string, now?: number): Promise<OneTimeResult<ConsentLinkRecord>>;
}

const CONSENT_LINK_TTL_MS = 24 * 60 * 60_000;

export const CONSENT_LINKS_MIGRATION = mapToTableMigration("connectors/consent-links/0001-typed", {
  table: "consent_links",
  key: "id",
  columns: {
    principalId: { type: "text", required: true },
    orgId: { type: "text" },
    provider: { type: "text", required: true },
    accountType: { type: "text", required: true },
    redirectUri: { type: "text", required: true },
    returnTo: { type: "text" },
    createdAt: { type: "bigint", required: true },
  },
});

export function createConsentLinkStore(
  databaseUrl: string,
  opts: { ttlMs?: number; now?: () => number } = {},
): ConsentLinkStore {
  const links = createOneTimeStore<ConsentLinkRecord>(
    databaseUrl,
    CONSENT_LINKS_MIGRATION,
    opts.ttlMs ?? CONSENT_LINK_TTL_MS,
    opts.now,
  );
  return { ...links, mint: async (rec, now) => ({ linkId: await links.mint(rec, now) }) };
}
