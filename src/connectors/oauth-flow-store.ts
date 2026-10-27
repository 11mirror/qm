import { randomBytes } from "node:crypto";
import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import type { OAuthState } from "./oauth.ts";
import { swallowAs } from "../util/errors.ts";

export interface OAuthFlowStore {
  start(state: Omit<OAuthState, "issuedAt" | "nonce">, now?: number): Promise<string>;
  finish(flowId: string, now?: number): Promise<OAuthState | null>;
}

const OAUTH_FLOW_TTL_MS = 10 * 60_000;

const OAUTH_FLOWS: TableSpec = {
  table: "oauth_flows",
  key: "nonce",
  keyIsField: true,
  columns: cols(`provider text!, principalId text!, redirectUri text!, issuedAt bigint!, returnTo text,
    orgId text, accountType text, clientRef text, codeVerifier text, consentLinkId text`),
};

const OAUTH_FLOWS_MIGRATION = mapToTableMigration("connectors/oauth-flows/0001-typed", OAUTH_FLOWS);

export function createOAuthFlowStore(
  databaseUrl: string,
  opts: { ttlMs?: number; now?: () => number } = {},
): OAuthFlowStore {
  const ttl = opts.ttlMs ?? OAUTH_FLOW_TTL_MS;
  const clock = opts.now ?? (() => Date.now());
  const table = typedTable<OAuthState>(createPgPool(databaseUrl, [OAUTH_FLOWS_MIGRATION]), OAUTH_FLOWS);
  return {
    async start(state, now) {
      const flowId = randomBytes(32).toString("base64url");
      await table.insert(flowId, { ...state, issuedAt: now ?? clock(), nonce: flowId });
      return flowId;
    },
    async finish(flowId, now) {
      const rec = await table.take(flowId).catch(swallowAs("oauth flow: take state", null));
      if (!rec) return null;
      if ((now ?? clock()) - rec.issuedAt > ttl) return null;
      return rec;
    },
  };
}
