import { deriveTenantSecret, tenantSandboxPrefix } from "../../plugins/chassis/src/tenant-settings.ts";
import type { Config, TenantPart } from "../config.ts";
import { defined } from "../config-env.ts";
import { tenant, tenantSettings } from "../tenant.ts";
import type { TenantSettings } from "./registry.ts";

export interface TenantConfig
  extends
    TenantPart,
    Pick<
      Config,
      "s3Bucket" | "signingSecret" | "capabilitySecret" | "portalIdentitySecret" | "connectorSecretKey" | "awsDeploy"
    > {
  sandboxNamePrefix?: string;
  modelGatewayApiKey?: string;
  slackServiceToken?: string;
  sentryDeployment?: string;
}

const views = new WeakMap<Config, WeakMap<TenantSettings, TenantConfig>>();

function registeredConfig(config: Config, settings: TenantSettings & { id: string }): TenantConfig {
  const origin = settings.hosts[0] ? `https://${settings.hosts[0]}` : undefined;
  const derived = (shared: string | undefined) => (shared ? deriveTenantSecret(shared, settings.id) : undefined);
  const view = {
    ...config,
    orgId: settings.orgId,
    brandingDefault: settings.brandingDefault,
    brokerCredentials: settings.secrets.brokerCredentials,
    trustedOidcAdminIssuer: settings.trustedOidcAdminIssuer,
    emailAuthPrincipals: settings.emailAuthPrincipals,
    emailAuthDomain: settings.emailAuthDomain,
    apiBaseUrl: settings.apiBaseUrl ?? origin,
    publicUrl: settings.publicUrl ?? origin,
    publicWebUrl: settings.publicWebUrl ?? origin,
    slack: settings.secrets.slack,
    chatSurfaces: settings.secrets.chatSurfaces,
    externalSlackPolicies: settings.externalSlackPolicies ?? {},
    s3Bucket: settings.s3Bucket ?? config.s3Bucket,
    s3Prefix: settings.s3Prefix ?? (settings.s3Bucket ? undefined : `tenants/${settings.slug}/`),
    adminGrants: settings.secrets.adminGrants,
    deployAppsSessionSecret:
      settings.secrets.deployAppsSessionSecret ?? derived(config.deployAppsSessionSecret ?? config.portalSessionSecret),
    deployAppsLoginUrl:
      settings.deployAppsLoginUrl ??
      (origin ? new URL(settings.deployAppsLoginPath ?? "/auth/login", origin).href : undefined),
    deployAppsDomain: settings.appsDomain,
    deployAppsLoginPath: settings.deployAppsLoginPath,
    awsDeploy: { ...config.awsDeploy, appsDomain: settings.appsDomain },
    signingSecret: derived(config.signingSecret),
    capabilitySecret: derived(config.capabilitySecret),
    portalIdentitySecret: derived(config.portalIdentitySecret),
    connectorSecretKey: settings.secrets.connectorSecretKey ?? config.connectorSecretKey,
    sandboxNamePrefix:
      settings.sandboxNamePrefix ?? tenantSandboxPrefix(config.sandbox.namePrefix ?? "qm", settings.id),
    modelGatewayApiKey: settings.secrets.modelGatewayApiKey ?? config.modelGateway?.apiKey,
    slackServiceToken: settings.secrets.slackServiceToken,
    sentryDeployment: settings.sentryDeployment,
  } satisfies TenantConfig;
  return defined(view) as TenantConfig;
}

export function tenantConfig(config: Config): TenantConfig {
  const settings = tenantSettings(tenant());
  let byTenant = views.get(config);
  if (!byTenant) views.set(config, (byTenant = new WeakMap()));
  let view = byTenant.get(settings);
  if (!view) {
    if (!settings.id) throw new Error("Tenant config requires a registered tenant id");
    view = registeredConfig(config, { ...settings, id: settings.id });
    byTenant.set(settings, view);
  }
  return view;
}
