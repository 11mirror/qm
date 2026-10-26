import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { PgPool } from "../persistence/pg-pool.ts";

// The tenant registry: one row per company served from this database. `env` and `secretEnv` are per-service
// environment overlays ({ core: {...}, portal: {...}, "web-ui": {...} }) applied on top of the deployment's own
// environment; `secretEnv` is stored AES-256-GCM encrypted under QM_TENANT_SECRETS_KEY.

type ServiceEnv = Record<string, Record<string, string>>;

export interface TenantRecord {
  id: string;
  slug: string;
  orgId: string;
  hosts: string[];
  status: "active" | "suspended";
  env: ServiceEnv;
  secretEnv: ServiceEnv;
}

export function tenantSecretsKey(env: NodeJS.ProcessEnv): Buffer | undefined {
  const raw = env.QM_TENANT_SECRETS_KEY?.trim();
  if (!raw) return undefined;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("QM_TENANT_SECRETS_KEY must be 32 bytes, base64-encoded");
  return key;
}

function encryptSecretEnv(value: ServiceEnv, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
}

function decryptSecretEnv(blob: Buffer, key: Buffer): ServiceEnv {
  if (blob[0] !== 1) throw new Error("tenant secret_env: unknown format");
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const text = Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString("utf8");
  return JSON.parse(text) as ServiceEnv;
}

function rowToRecord(row: Record<string, unknown>, key: Buffer | undefined): TenantRecord {
  const blob = row.secret_env as Buffer | null;
  let secretEnv: ServiceEnv = {};
  if (blob && blob.length) {
    if (!key) throw new Error(`tenant ${String(row.slug)} has secrets but QM_TENANT_SECRETS_KEY is unset`);
    secretEnv = decryptSecretEnv(blob, key);
  }
  return {
    id: String(row.id),
    slug: String(row.slug),
    orgId: String(row.org_id),
    hosts: (row.hosts as string[] | null) ?? [],
    status: row.status === "suspended" ? "suspended" : "active",
    env: (row.env as ServiceEnv | null) ?? {},
    secretEnv,
  };
}

export async function listTenants(pool: PgPool, key: Buffer | undefined): Promise<TenantRecord[]> {
  const rows = await pool.q("SELECT * FROM tenants ORDER BY created_at, slug");
  return rows.map((row) => rowToRecord(row, key));
}

export async function upsertTenant(pool: PgPool, rec: TenantRecord, key: Buffer | undefined): Promise<void> {
  const hasSecrets = Object.values(rec.secretEnv).some((vars) => Object.keys(vars).length > 0);
  if (hasSecrets && !key) throw new Error("QM_TENANT_SECRETS_KEY is required to store tenant secrets");
  const secret = hasSecrets && key ? encryptSecretEnv(rec.secretEnv, key) : null;
  await pool.query(
    `INSERT INTO tenants(id, slug, org_id, hosts, status, env, secret_env)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, org_id = EXCLUDED.org_id, hosts = EXCLUDED.hosts,
       status = EXCLUDED.status, env = EXCLUDED.env, secret_env = EXCLUDED.secret_env, updated_at = now()`,
    [rec.id, rec.slug, rec.orgId, rec.hosts, rec.status, JSON.stringify(rec.env), secret],
  );
}

export async function homeTenantId(pool: PgPool): Promise<string> {
  const rows = await pool.q("SELECT id::text AS id FROM qm_tenant");
  const id = rows[0]?.id;
  if (typeof id !== "string") throw new Error("qm_tenant has no row; run migrations first");
  return id;
}

/** Refuse to serve several tenants from a login that ignores row-level security. */
export async function assertRowSecurityEnforced(pool: PgPool): Promise<void> {
  const rows = await pool.q("SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user");
  if (rows[0]?.bypass === true) {
    throw new Error(
      "multitenant: the database login is a superuser or has BYPASSRLS, so row-level security would not separate tenants",
    );
  }
}
