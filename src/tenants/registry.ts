import {
  sealTenantSecret,
  openTenantSecret,
  TENANT_COLUMNS,
  TENANT_TEXT_SETTINGS,
  tenantFromRow,
  type TenantSettings as EdgeTenantSettings,
} from "../../plugins/chassis/src/tenant-settings.ts";
import type { PgPool } from "../persistence/pg-pool.ts";

import type { TenantPart } from "../config.ts";

export type TenantSettings = Omit<EdgeTenantSettings, "secrets"> &
  Partial<
    Omit<
      TenantPart,
      "orgId" | "slack" | "brokerCredentials" | "chatSurfaces" | "deployAppsSessionSecret" | "adminGrants"
    >
  > & {
    sandboxNamePrefix?: string;
    secrets: EdgeTenantSettings["secrets"] &
      Pick<TenantPart, "slack" | "brokerCredentials" | "chatSurfaces" | "deployAppsSessionSecret"> & {
        slackAccounts?: NonNullable<TenantPart["slack"]>[];
        keychainSigningFallback?: string;
      };
  };

export const TENANT_EXTRA_COLUMNS = [
  ["apiBaseUrl", "api_base_url", "text"],
  ["publicUrl", "public_url", "text"],
  ["portalUrl", "portal_url", "text"],
  ["publicWebUrl", "public_web_url", "text"],
  ["sandboxNamePrefix", "sandbox_name_prefix", "text"],
  ["s3Prefix", "s3_prefix", "text"],
  ["deployAppsLoginUrl", "apps_login_url", "text"],
  ["deployAppsLoginPath", "apps_login_path", "text"],
  ["trustedOidcAdminIssuer", "trusted_oidc_admin_issuer", "text"],
  ["emailAuthPrincipals", "email_auth_principals", "text[]"],
  ["emailAuthDomain", "email_auth_domain", "text"],
  ["apiAllowedOrigins", "api_allowed_origins", "text[]"],
  ["principalRule", "principal_rule", "jsonb"],
  ["brandingDefault", "branding_default", "jsonb"],
  ["externalSlackPolicies", "external_slack_policies", "jsonb"],
] as const;

export type TenantRecord = TenantSettings & { id: string };

export async function listTenants(pool: PgPool, key: Buffer | undefined): Promise<TenantRecord[]> {
  const { rows } = await (
    await pool.deploymentPool()
  ).query(
    `SELECT ${TENANT_COLUMNS}, ${TENANT_EXTRA_COLUMNS.map(([, col]) => col).join(", ")} FROM tenants ORDER BY created_at, slug`,
  );
  return rows.map((row) => tenantRecordFromRow(row, key));
}

export function tenantRecordFromRow(row: Record<string, unknown>, key: Buffer | undefined): TenantRecord {
  return {
    ...tenantFromRow(row, key),
    ...Object.fromEntries(
      TENANT_EXTRA_COLUMNS.filter(([, col]) => row[col] !== null).map(([field, col]) => [field, row[col]]),
    ),
    secrets: row.secrets
      ? (openTenantSecret(row.secrets as Buffer, key, String(row.slug)) as TenantSettings["secrets"])
      : {},
  };
}

export interface SqlRunner {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

function requireKey(key: Buffer | undefined): Buffer {
  if (!key) throw new Error("QM_TENANT_SECRETS_KEY is required to store tenant secrets");
  return key;
}

const settingValues = (rec: TenantSettings) => TENANT_TEXT_SETTINGS.map(([field]) => rec[field] ?? null);

export async function upsertTenant(pool: SqlRunner, rec: TenantRecord, key: Buffer | undefined): Promise<void> {
  const columns = [...TENANT_TEXT_SETTINGS, ...TENANT_EXTRA_COLUMNS].map(([, column]) => column);
  const at = (i: number) => `$${i + 8}`;
  await pool.query(
    `INSERT INTO tenants(id, slug, org_id, hosts, status, oidc_admin, secrets, ${columns.join(", ")})
     VALUES ($1, $2, $3, $4, $5, $6, $7, ${columns.map((_, i) => at(i)).join(", ")})
     ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, org_id = EXCLUDED.org_id, hosts = EXCLUDED.hosts,
       status = EXCLUDED.status, oidc_admin = EXCLUDED.oidc_admin, secrets = EXCLUDED.secrets,
       ${columns.map((column) => `${column} = EXCLUDED.${column}`).join(", ")}, updated_at = now()`,
    [
      rec.id,
      rec.slug,
      rec.orgId,
      rec.hosts,
      rec.status,
      rec.oidcAdmin,
      Object.values(rec.secrets).some(Boolean) ? sealTenantSecret(rec.secrets, requireKey(key)) : null,
      ...settingValues(rec),
      ...TENANT_EXTRA_COLUMNS.map(([field, , type]) => {
        if (rec[field] === undefined) return null;
        return type === "jsonb" ? JSON.stringify(rec[field]) : rec[field];
      }),
    ],
  );
}

export async function assertRowSecurityEnforced(pool: PgPool): Promise<void> {
  const { rows } = await (
    await pool.deploymentPool()
  ).query(`SELECT rolsuper OR rolbypassrls AS bypass,
    EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database() AND pg_has_role(current_user, datdba, 'MEMBER')) AS database_owner,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE c.relkind = 'r' AND a.attname = 'tenant_id' AND NOT a.attisdropped
        AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS table_owner,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE c.relkind = 'r' AND a.attname = 'tenant_id' AND NOT a.attisdropped
        AND (has_table_privilege(current_user, c.oid, 'TRUNCATE') OR has_table_privilege(current_user, c.oid, 'TRIGGER'))) AS unsafe_privileges
    FROM pg_roles WHERE rolname = current_user`);
  if (rows[0]?.bypass === true) {
    throw new Error(
      "multitenant: the database login is a superuser or has BYPASSRLS, so row-level security would not separate tenants",
    );
  }
  if (rows[0]?.database_owner === true || rows[0]?.table_owner === true) {
    throw new Error("multitenant: the database login must not own the database or tenant-private tables");
  }
  if (rows[0]?.unsafe_privileges === true) {
    throw new Error("multitenant: the database login must not have TRUNCATE or TRIGGER on tenant-private tables");
  }
}
