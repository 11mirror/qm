import { createPgPool, tenantCols, withPgTransaction, type PgPool } from "../persistence/pg-pool.ts";
import { columnName, mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
import { pgTextSafe } from "../util/text.ts";
import type { KeychainAsk, KeychainCredential, KeychainGrant } from "./keychain.ts";

export type LegacyCredential = KeychainCredential & { target?: string; username?: string };

const CREDENTIALS: TableSpec = {
  table: "keychain_credentials",
  key: "id",
  keyIsField: true,
  columns: {
    ownerId: { type: "text", required: true },
    orgId: { type: "text" },
    service: { type: "text", required: true },
    kind: { type: "text", required: true },
    envKey: { type: "text" },
    targets: { type: "text[]" },
    host: { type: "text" },
    accountLabel: { type: "text" },
    fields: { type: "jsonb" },
    broker: { type: "jsonb" },
    refresh: { type: "jsonb" },
    managed: { type: "text" },
    secretEnc: { type: "text", required: true },
    fingerprint: { type: "text", required: true },
    origin: { type: "text" },
    expiresAt: { type: "bigint" },
    createdAt: { type: "bigint", required: true },
    updatedAt: { type: "bigint", required: true },
    target: { type: "text" },
    username: { type: "text" },
  },
};

const GRANTS: TableSpec = {
  table: "keychain_grants",
  key: "id",
  keyIsField: true,
  columns: {
    credentialId: { type: "text", required: true },
    ownerId: { type: "text", required: true },
    orgId: { type: "text" },
    audienceScopeId: { type: "text", required: true },
    mode: { type: "text", required: true },
    purpose: { type: "text", required: true },
    status: { type: "text", required: true },
    createdAt: { type: "bigint", required: true },
    expiresAt: { type: "bigint" },
    revokedAt: { type: "bigint" },
    usedAt: { type: "bigint" },
    usedBy: { type: "text" },
    askId: { type: "text" },
  },
};

const ASKS: TableSpec = {
  table: "keychain_asks",
  key: "id",
  keyIsField: true,
  columns: {
    credentialId: { type: "text", required: true },
    ownerId: { type: "text", required: true },
    requesterId: { type: "text", required: true },
    orgId: { type: "text" },
    requesterScopeId: { type: "text", required: true },
    requesterDestination: { type: "jsonb" },
    requesterThreadRef: { type: "text" },
    requesterSeq: { type: "bigint" },
    requesterMessageTs: { type: "text" },
    purpose: { type: "text", required: true },
    requestedMode: { type: "text" },
    status: { type: "text", required: true },
    createdAt: { type: "bigint", required: true },
    expiresAt: { type: "bigint", required: true },
    resolvedAt: { type: "bigint" },
    grantId: { type: "text" },
    note: { type: "text" },
    notifiedAt: { type: "bigint" },
  },
};

export const KEYCHAIN_CREDENTIALS_MIGRATION = mapToTableMigration(
  "credentials/keychain/0001-typed-creds",
  CREDENTIALS,
  {
    statements: [
      `CREATE INDEX IF NOT EXISTS keychain_credentials_owner_fold ON keychain_credentials (lower(owner_id))`,
    ],
  },
);

export const KEYCHAIN_GRANTS_MIGRATION = mapToTableMigration("credentials/keychain/0002-typed-grants", GRANTS, {
  statements: [
    `CREATE INDEX IF NOT EXISTS keychain_grants_owner_fold ON keychain_grants (lower(owner_id))`,
    `CREATE INDEX IF NOT EXISTS keychain_grants_audience ON keychain_grants (audience_scope_id)`,
    `CREATE INDEX IF NOT EXISTS keychain_grants_credential ON keychain_grants (credential_id)`,
  ],
});

export const KEYCHAIN_ASKS_MIGRATION = mapToTableMigration("credentials/keychain/0003-typed-asks", ASKS);

const OWNED_BY = `(lower(owner_id) = ANY($1::text[]) OR owner_id ~ '[^\\x01-\\x7f]')`;

function rowTable<T>(spec: TableSpec, pg: PgPool) {
  const codec = tableCodec<T>(spec);
  const key = columnName(spec.key);
  const select = `SELECT ${codec.columns} FROM ${spec.table}`;
  const insert = `INSERT INTO ${spec.table} (${codec.columns}) VALUES (${codec.placeholders})`;
  const upsert = () => `${insert} ON CONFLICT (${tenantCols(key)}) DO UPDATE SET ${codec.updates}`;
  const idOf = (rec: T) => (rec as Record<string, unknown>)[spec.key] as string;
  const where = async (clause: string, params: unknown[] = []): Promise<T[]> =>
    codec.rows(await pg.q(`${select} ${clause}`, params));
  return {
    where,
    async get(id: string): Promise<T | null> {
      return (await where(`WHERE ${key} = $1`, [id]))[0] ?? null;
    },
    async put(rec: T): Promise<void> {
      await pg.q(upsert(), codec.values(idOf(rec), rec));
    },
    async insertIfAbsent(rec: T): Promise<boolean> {
      const res = await pg.query(`${insert} ON CONFLICT DO NOTHING`, codec.values(idOf(rec), rec));
      return res.rowCount > 0;
    },
    async putIfAbsent(rec: T): Promise<T> {
      const rows = await pg.q(
        `${insert} ON CONFLICT (${tenantCols(key)}) DO UPDATE SET ${key} = ${spec.table}.${key} RETURNING ${codec.columns}`,
        codec.values(idOf(rec), rec),
      );
      return codec.row(rows[0]!);
    },
    async delete(id: string): Promise<void> {
      await pg.q(`DELETE FROM ${spec.table} WHERE ${key} = $1`, [id]);
    },
    async update(id: string, fn: (current: T) => T): Promise<T | null> {
      return withPgTransaction(await pg.pool(), async (client) => {
        const found = await client.query(`${select} WHERE ${key} = $1 FOR UPDATE`, [id]);
        if (!found.rows[0]) return null;
        const current = codec.row(found.rows[0]);
        const next = fn(current);
        if (next !== current) await client.query(upsert(), codec.values(id, next));
        return next;
      });
    },
  };
}

const folded = (ownerIds: string[]) => ownerIds.map((id) => id.toLowerCase());

function credentialTable(pg: PgPool) {
  const creds = rowTable<LegacyCredential>(CREDENTIALS, pg);
  return {
    ...creds,
    all: () => creds.where(`ORDER BY id`),
    byOwners: (ownerIds: string[]) => creds.where(`WHERE ${OWNED_BY} ORDER BY id`, [folded(ownerIds)]),
    legacy: () => creds.where(`WHERE target IS NOT NULL OR username IS NOT NULL ORDER BY id`),
    async deleteBrokerIfCurrent(id: string, ownerId: string, updatedAt: number): Promise<boolean> {
      const res = await pg.query(
        `DELETE FROM keychain_credentials WHERE id = $1 AND kind = 'broker' AND owner_id = $2 AND updated_at = $3`,
        [id, ownerId, updatedAt],
      );
      return res.rowCount > 0;
    },
    async markRefreshFailure(rec: KeychainCredential, at: number, message: string): Promise<void> {
      await pg.q(
        `UPDATE keychain_credentials
         SET refresh = COALESCE(refresh, '{}'::jsonb)
               || jsonb_build_object('refreshFailedAt', $4::bigint, 'refreshError', $5::text),
             updated_at = $4
         WHERE id = $1 AND updated_at = $2 AND fingerprint = $3`,
        [rec.id, rec.updatedAt, rec.fingerprint, at, pgTextSafe(message)],
      );
    },
  };
}

function grantTable(pg: PgPool) {
  const grants = rowTable<KeychainGrant>(GRANTS, pg);
  const revokeWhere = async (clause: string, params: unknown[]) => {
    await pg.q(`UPDATE keychain_grants SET status = 'revoked', revoked_at = $2 WHERE ${clause} AND status = 'active'`, [
      ...params,
    ]);
  };
  return {
    ...grants,
    list: (ownerIds?: string[]) =>
      ownerIds ? grants.where(`WHERE ${OWNED_BY} ORDER BY id`, [folded(ownerIds)]) : grants.where(`ORDER BY id`),
    forAsks: (askIds: string[]) => grants.where(`WHERE ask_id = ANY($1::text[]) ORDER BY id`, [askIds]),
    activeFor: (scopeId: string, at: number) =>
      grants.where(
        `WHERE audience_scope_id = $1 AND status = 'active' AND NOT (mode = 'once' AND used_at IS NOT NULL)
           AND (expires_at IS NULL OR expires_at >= $2) ORDER BY id`,
        [scopeId, at],
      ),
    async standing(credentialId: string, scopeId: string): Promise<KeychainGrant | null> {
      const found = await grants.where(
        `WHERE credential_id = $1 AND audience_scope_id = $2 AND mode = 'standing' AND status = 'active'
         ORDER BY id LIMIT 1`,
        [credentialId, scopeId],
      );
      return found[0] ?? null;
    },
    revoke: (id: string, at: number) => revokeWhere(`id = $1`, [id, at]),
    revokeForCredential: (credentialId: string, at: number) => revokeWhere(`credential_id = $1`, [credentialId, at]),
  };
}

export function createKeychainStore(databaseUrl: string) {
  const pg = createPgPool(databaseUrl, [
    KEYCHAIN_CREDENTIALS_MIGRATION,
    KEYCHAIN_GRANTS_MIGRATION,
    KEYCHAIN_ASKS_MIGRATION,
  ]);
  const asks = rowTable<KeychainAsk>(ASKS, pg);
  return {
    creds: credentialTable(pg),
    grants: grantTable(pg),
    asks: {
      ...asks,
      list: (newestFirst: boolean) =>
        asks.where(newestFirst ? `ORDER BY created_at DESC, id DESC` : `ORDER BY created_at, id`),
      merge: (id: string, patch: Partial<KeychainAsk>) => asks.update(id, (current) => ({ ...current, ...patch })),
    },
  };
}

export type KeychainStore = ReturnType<typeof createKeychainStore>;
