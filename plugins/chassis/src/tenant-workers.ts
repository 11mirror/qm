import { deriveTenantSecret, homeHosts, type TenantSettings } from "./tenant-settings.ts";

type Env = Record<string, string | undefined>;

const DERIVED_SECRETS = [
  "CORE_SIGNING_SECRET",
  "CAPABILITY_SECRET",
  "PORTAL_IDENTITY_SECRET",
  "PORTAL_SESSION_SECRET",
  "AUTH_TOKEN_SECRET",
];

const EMBEDDED_AUTH_SECRETS = ["AUTH_CLIENT_SECRET", "OIDC_CLIENT_SECRET"];

const PUBLIC_URLS = [
  "PUBLIC_WEB_URL",
  "PUBLIC_API_URL",
  "WEB_UI_PUBLIC_URL",
  "PORTAL_PUBLIC_URL",
  "AWS_PUBLIC_ORIGIN_URL",
];

const HOST_URLS = [
  "AGENT_API_URL",
  "DEPLOY_APPS_LOGIN_URL",
  "AUTH_ISSUER",
  "AUTH_REDIRECT_URI",
  "OIDC_ISSUER",
  "OIDC_AUTH_ENDPOINT",
  "OIDC_TOKEN_ENDPOINT",
  "OIDC_USERINFO_ENDPOINT",
  "OIDC_JWKS_URI",
];

const HOME_ONLY = [
  "ADMIN_GRANTS",
  "QM_SLACK_SERVICE_TOKEN",
  "QM_SLACK_SERVICE_URL",
  "SENTRY_DEPLOYMENT",
  "PORTAL_APPS_DOMAIN",
  "DEPLOY_APPS_DOMAIN",
  "S3_PREFIX",
  "PORTAL_API_ALLOWED_ORIGINS",
  "PORTAL_TRUSTED_OIDC",
  "PORTAL_TRUSTED_OIDC_CLIENT_SECRET",
  "PORTAL_TRUSTED_OIDC_LABEL",
  "PORTAL_TRUSTED_OIDC_ADMIN",
];

function hostUrls(base: Env, url: string): Env {
  const origins = homeHosts(base).map((host) => `https://${host}`);
  const rebased: Env = Object.fromEntries(PUBLIC_URLS.map((name) => [name, url]));
  for (const name of HOST_URLS) {
    const value = base[name];
    const origin = value && origins.find((o) => value === o || value.startsWith(`${o}/`));
    if (origin) rebased[name] = url + value.slice(origin.length);
  }
  return rebased;
}

function trustedOidc(base: Env, tenant: TenantSettings): Env {
  if (!tenant.oidcClientId) return {};
  const shared = base.PORTAL_TRUSTED_OIDC?.trim() ? (JSON.parse(base.PORTAL_TRUSTED_OIDC) as object) : {};
  return {
    PORTAL_TRUSTED_OIDC: JSON.stringify({ ...shared, clientId: tenant.oidcClientId }),
    PORTAL_TRUSTED_OIDC_CLIENT_SECRET: tenant.secrets.oidcClientSecret,
    PORTAL_TRUSTED_OIDC_LABEL: tenant.oidcLabel,
    PORTAL_TRUSTED_OIDC_ADMIN: tenant.oidcAdmin ? "1" : undefined,
  };
}

function derivedSecrets(base: Env, tenantId: string): Env {
  const names = base.AUTH_EMBEDDED === "1" ? [...DERIVED_SECRETS, ...EMBEDDED_AUTH_SECRETS] : DERIVED_SECRETS;
  return Object.fromEntries(
    names.filter((name) => base[name]).map((name) => [name, deriveTenantSecret(base[name]!, tenantId)]),
  );
}

function registeredTenantEnv(base: Env, tenant: TenantSettings & { id: string }): Env {
  const env: Env = { ...base };
  for (const name of HOME_ONLY) delete env[name];
  const favicon = tenant.faviconSvg;
  const own = tenant.secrets;
  return Object.assign(
    env,
    tenant.hosts[0] ? hostUrls(base, `https://${tenant.hosts[0]}`) : {},
    derivedSecrets(base, tenant.id),
    trustedOidc(base, tenant),
    {
      ORG_ID: tenant.orgId,
      S3_BUCKET: tenant.s3Bucket ?? base.S3_BUCKET,
      S3_PREFIX: tenant.s3Bucket ? undefined : `tenants/${tenant.slug}/`,
      SANDBOX_NAME_PREFIX: tenant.sandboxNamePrefix ?? `qm-${tenant.slug}`,
      MODAL_APP_NAME: tenant.modalAppName ?? base.MODAL_APP_NAME,
      MODAL_ENVIRONMENT: tenant.modalEnvironment ?? base.MODAL_ENVIRONMENT,
      MODAL_SNAPSHOT_S3_BUCKET: tenant.modalSnapshotBucket ?? base.MODAL_SNAPSHOT_S3_BUCKET,
      AWS_SANDBOX_S3_BUCKET: tenant.awsSandboxBucket ?? base.AWS_SANDBOX_S3_BUCKET,
      SENTRY_DEPLOYMENT: tenant.sentryDeployment,
      WEB_UI_FAVICON_SVG: favicon ?? base.WEB_UI_FAVICON_SVG,
      PORTAL_FAVICON_SVG: favicon ?? base.PORTAL_FAVICON_SVG,
      AUTH_FAVICON_SVG: favicon ?? base.AUTH_FAVICON_SVG,
      PORTAL_APPS_DOMAIN: tenant.appsDomain,
      DEPLOY_APPS_DOMAIN: tenant.appsDomain,
      MODEL_GATEWAY_API_KEY: own.modelGatewayApiKey ?? base.MODEL_GATEWAY_API_KEY,
      QM_SLACK_SERVICE_TOKEN: own.slackServiceToken,
      QM_SLACK_SERVICE_URL: own.slackServiceToken ? base.QM_SLACK_SERVICE_URL : undefined,
      ADMIN_GRANTS: own.adminGrants,
      CONNECTOR_SECRET_KEY: own.connectorSecretKey ?? base.CONNECTOR_SECRET_KEY,
    },
  );
}

export function tenantServiceEnv(base: Env, tenant: TenantSettings): Record<string, string> {
  const merged: Env = tenant.id ? registeredTenantEnv(base, { ...tenant, id: tenant.id }) : { ...base };
  return Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
