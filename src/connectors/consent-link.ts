import type { DurableMap } from "../persistence/durable-map.ts";
import { createOneTimeStore, type OneTimeResult } from "../persistence/one-time-store.ts";
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

export function createConsentLinkStore(
  backing: DurableMap<ConsentLinkRecord>,
  opts: { ttlMs?: number; now?: () => number } = {},
): ConsentLinkStore {
  const links = createOneTimeStore(backing, opts.ttlMs ?? CONSENT_LINK_TTL_MS, opts.now);
  return { ...links, mint: async (rec, now) => ({ linkId: await links.mint(rec, now) }) };
}
