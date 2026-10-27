import { randomBytes } from "node:crypto";
import { createPgPool } from "../persistence/pg-pool.ts";
import { mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
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
  columns: {
    provider: { type: "text", required: true },
    principalId: { type: "text", required: true },
    redirectUri: { type: "text", required: true },
    issuedAt: { type: "bigint", required: true },
    returnTo: { type: "text" },
    orgId: { type: "text" },
    accountType: { type: "text" },
    clientRef: { type: "text" },
    codeVerifier: { type: "text" },
    consentLinkId: { type: "text" },
  },
};

export const OAUTH_FLOWS_MIGRATION = mapToTableMigration("connectors/oauth-flows/0001-typed", OAUTH_FLOWS);

const codec = tableCodec<OAuthState>(OAUTH_FLOWS);

export function createOAuthFlowStore(
  databaseUrl: string,
  opts: { ttlMs?: number; now?: () => number } = {},
): OAuthFlowStore {
  const ttl = opts.ttlMs ?? OAUTH_FLOW_TTL_MS;
  const clock = opts.now ?? (() => Date.now());
  const { q } = createPgPool(databaseUrl, [OAUTH_FLOWS_MIGRATION]);
  return {
    async start(state, now) {
      const flowId = randomBytes(32).toString("base64url");
      await q(
        `INSERT INTO oauth_flows (${codec.columns}) VALUES (${codec.placeholders})`,
        codec.values(flowId, { ...state, issuedAt: now ?? clock(), nonce: flowId }),
      );
      return flowId;
    },
    async finish(flowId, now) {
      const rows = await q(`DELETE FROM oauth_flows WHERE nonce = $1 RETURNING ${codec.columns}`, [flowId]).catch(
        swallowAs("oauth flow: take state", []),
      );
      const rec = rows[0] ? codec.row(rows[0]) : null;
      if (!rec) return null;
      if ((now ?? clock()) - rec.issuedAt > ttl) return null;
      return rec;
    },
  };
}
