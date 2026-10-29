import { parseAllowedOrigins } from "../../plugins/chassis/src/allowed-origins.ts";
import type { OidcConfig } from "../../plugins/chassis/src/oidc-config.ts";
import type { PoolClient } from "pg";
import { tenantSettingsFromEnv, tenantSecretsKey } from "../../plugins/chassis/src/tenant-settings.ts";
import { upsertTenant, tenantRecordFromRow, type TenantRecord } from "./registry.ts";

let convert: ((client: PoolClient, id: string, existing: boolean) => Promise<void | boolean>) | undefined;

export function useTenantConversion(
  next: (client: PoolClient, id: string, existing: boolean) => Promise<void | boolean>,
): void {
  convert = next;
}

function primaryOidc(env: NodeJS.ProcessEnv, hosts: string[]): OidcConfig | undefined {
  if (!env.OIDC_CLIENT_ID || env.AUTH_BROKER_UPSTREAM) return undefined;
  const origin = env.PORTAL_PUBLIC_URL ?? env.PUBLIC_WEB_URL ?? `https://${hosts[0]}`;
  return {
    authEndpoint: env.OIDC_AUTH_ENDPOINT ?? "https://slack.com/openid/connect/authorize",
    tokenEndpoint: env.OIDC_TOKEN_ENDPOINT ?? "https://slack.com/api/openid.connect.token",
    userinfoEndpoint: env.OIDC_USERINFO_ENDPOINT ?? "https://slack.com/api/openid.connect.userInfo",
    issuer: env.OIDC_ISSUER ?? "https://slack.com",
    jwksUri: env.OIDC_JWKS_URI ?? "https://slack.com/openid/connect/keys",
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET ?? "",
    redirectUri: `${origin.replace(/\/$/, "")}/auth/callback`,
    scopes: env.OIDC_SCOPES ?? "openid profile email",
    expectedTeamId: env.PORTAL_EXPECTED_TEAM_ID,
    prompt: env.OIDC_PROMPT,
    hostedDomain: env.OIDC_ISSUER === "https://accounts.google.com" ? env.OIDC_ALLOWED_EMAIL_DOMAIN : undefined,
    ...(env.AUTH_BROKER_UPSTREAM ? { headers: { "x-forwarded-host": hosts[0]! } } : {}),
  };
}

function trustedOidc(env: NodeJS.ProcessEnv, record: TenantRecord): OidcConfig | undefined {
  if (record.secrets.trustedOidc) return record.secrets.trustedOidc;
  if (!record.oidcClientId) return undefined;
  if (!env.PORTAL_TRUSTED_OIDC)
    throw new Error(`tenant ${record.slug}: trusted sign-in endpoints are required for conversion`);
  const provider = JSON.parse(env.PORTAL_TRUSTED_OIDC) as OidcConfig;
  return {
    ...provider,
    clientId: record.oidcClientId,
    clientSecret: record.secrets.oidcClientSecret ?? "",
    redirectUri: `${record.portalUrl ?? `https://${record.hosts[0]}`}/auth/trusted/callback`,
    scopes: "openid profile",
  };
}

export function configureTenantConversion(env: NodeJS.ProcessEnv): void {
  convert = async (client, id, existingDatabase) => {
    if (!existingDatabase) return false;
    const existing = (await client.query("SELECT * FROM tenants WHERE id = $1", [id])).rows[0];
    const { tenantPartFromEnv } = await import("../config.ts");
    const { slackAccountConfigsFromEnv } = await import("../slack/config.ts");
    if (env.OIDC_PRINCIPAL_CLAIM && !["sub", "email"].includes(env.OIDC_PRINCIPAL_CLAIM))
      throw new Error("Tenant principal claim must be sub or email");
    const part = tenantPartFromEnv(env);
    const { slack, brokerCredentials, chatSurfaces, deployAppsSessionSecret: _viewerSecret, ...settings } = part;
    const { deriveConnectorKey } = await import("../connectors/connector-client-store.ts");
    const base = tenantSettingsFromEnv(env, {
      id,
      orgId: part.orgId,
      slug: part.orgId.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    });
    const cors = parseAllowedOrigins(env.PORTAL_API_ALLOWED_ORIGINS);
    if (cors.problems.length) throw new Error(cors.problems.join("; "));
    const record: TenantRecord = {
      ...base,
      id,
      ...settings,
      sandboxNamePrefix: env.SANDBOX_NAME_PREFIX?.trim() || "qm",
      s3Prefix: settings.s3Prefix ?? "",
      portalUrl: env.PORTAL_PUBLIC_URL,
      apiAllowedOrigins: [...cors.origins],
      principalRule: {
        claim: env.OIDC_PRINCIPAL_CLAIM === "sub" ? "sub" : "email",
        allowedEmailDomain: env.OIDC_ALLOWED_EMAIL_DOMAIN,
        allowedEmails: env.OIDC_ALLOWED_EMAILS?.split(",")
          .map((email) => email.trim())
          .filter(Boolean),
        requireCoreAdmission: Boolean(env.AUTH_BROKER_UPSTREAM),
      },
      secrets: {
        ...base.secrets,
        keychainSigningFallback: env.CORE_SIGNING_SECRET
          ? deriveConnectorKey(env.CORE_SIGNING_SECRET, "keychain").current.toString("base64")
          : undefined,
        primaryOidc: primaryOidc(env, base.hosts),
        slack,
        ...(slackAccountConfigsFromEnv(env).length ? { slackAccounts: slackAccountConfigsFromEnv(env) } : {}),
        ...(brokerCredentials?.length ? { brokerCredentials } : {}),
        ...(chatSurfaces?.length ? { chatSurfaces } : {}),
      },
    };
    const key = tenantSecretsKey(env);
    const stored = existing ? tenantRecordFromRow(existing, key) : undefined;
    await upsertTenant(
      client,
      {
        ...record,
        ...stored,
        hosts: [...new Set([...(stored?.hosts ?? []), ...record.hosts])],
        secrets: { ...record.secrets, ...stored?.secrets },
      },
      key,
    );
    for (const row of (await client.query("SELECT * FROM tenants")).rows) {
      const rec = tenantRecordFromRow(row, key);
      if (rec.secrets.trustedOidc || !rec.oidcClientId) continue;
      await upsertTenant(client, { ...rec, secrets: { ...rec.secrets, trustedOidc: trustedOidc(env, rec) } }, key);
    }
  };
}

export async function convertDatabaseTenant(client: PoolClient, id: string, existing: boolean): Promise<boolean> {
  if (!convert) throw new Error("Existing database tenant requires a registered settings conversion");
  return (await convert(client, id, existing)) !== false;
}
