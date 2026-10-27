import { createPgPool } from "../persistence/pg-pool.ts";
import { createOneTimeStore, type OneTimeResult } from "../persistence/one-time-store.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import type { Destination, ScopeId } from "../types.ts";
import type { GrantMode } from "./keychain.ts";

export interface SecretDropField {
  key: string;
  label?: string;
  secret?: boolean;
}

export interface SecretDropRecord {
  ownerId: string;
  orgId?: string;
  service: string;
  envKey?: string;
  host?: string;
  fields?: SecretDropField[];
  purpose: string;
  requestedBy: string;
  audienceScopeId?: ScopeId;
  scopeVersion?: string;
  grantMode?: GrantMode;
  destination?: Destination;
  threadRef?: string;
  requiresToken?: boolean;
  createdAt: number;
}

type SecretDropResult = OneTimeResult<SecretDropRecord>;

export interface SecretDropStore {
  mint(rec: Omit<SecretDropRecord, "createdAt">, now?: number): Promise<{ dropId: string }>;
  peek(dropId: string, now?: number): Promise<SecretDropResult>;
  redeem(dropId: string, now?: number): Promise<SecretDropResult>;
  siblings(rec: SecretDropRecord, now?: number): Promise<SecretDropRecord[]>;
}

export const SECRET_DROP_TTL_MS = 7 * 24 * 60 * 60_000;

const SECRET_DROPS: TableSpec = {
  table: "secret_drops",
  key: "id",
  columns: cols(`ownerId text!, orgId text, service text!, envKey text, host text, fields jsonb, purpose text!,
    requestedBy text!, audienceScopeId text, scopeVersion text, grantMode text, destination jsonb,
    threadRef text, requiresToken boolean, createdAt bigint!`),
};

export const SECRET_DROPS_MIGRATION = mapToTableMigration("credentials/secret-drops/0001-typed", SECRET_DROPS);

export function createSecretDropStore(
  databaseUrl: string,
  opts: { ttlMs?: number; now?: () => number } = {},
): SecretDropStore {
  const ttl = opts.ttlMs ?? SECRET_DROP_TTL_MS;
  const clock = opts.now ?? (() => Date.now());
  const pg = createPgPool(databaseUrl, [SECRET_DROPS_MIGRATION]);
  const table = typedTable<SecretDropRecord>(pg, SECRET_DROPS);
  const drops = createOneTimeStore(table, ttl, clock);
  return {
    ...drops,
    mint: async (rec, now) => ({ dropId: await drops.mint(rec, now) }),
    async siblings(rec, now) {
      const cutoff = (now ?? clock()) - ttl;
      await pg.q(`DELETE FROM secret_drops WHERE created_at < $1`, [cutoff]);
      return table.codec.rows(
        await pg.q(
          `SELECT ${table.codec.columns} FROM secret_drops
           WHERE org_id IS NOT DISTINCT FROM $1 AND audience_scope_id IS NOT DISTINCT FROM $2
             AND thread_ref IS NOT DISTINCT FROM $3 AND service <> $4
           ORDER BY id`,
          [rec.orgId ?? null, rec.audienceScopeId ?? null, rec.threadRef ?? null, rec.service],
        ),
      );
    },
  };
}
