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

function homeConfig(config: Config, settings: TenantSettings): TenantConfig {
  return {
    ...config,
    ...(config.sandbox.namePrefix ? { sandboxNamePrefix: config.sandbox.namePrefix } : {}),
    ...(config.modelGateway?.apiKey ? { modelGatewayApiKey: config.modelGateway.apiKey } : {}),
    ...(settings.secrets.slackServiceToken ? { slackServiceToken: settings.secrets.slackServiceToken } : {}),
    ...(settings.sentryDeployment ? { sentryDeployment: settings.sentryDeployment } : {}),
  };
}

function rehomed(value: string | undefined, homeOrigins: readonly string[], origin: string): string | undefined {
  const from = value && homeOrigins.find((o) => value === o || value.startsWith(`${o}/`));
  return from ? origin + value.slice(from.length) : value;
}

function registeredConfig(config: Config, settings: TenantSettings & { id: string }): TenantConfig {
  const origin = settings.hosts[0] ? `https://${settings.hosts[0]}` : undefined;
  const homeOrigins = [config.publicUrl, config.apiBaseUrl, config.publicWebUrl].flatMap((url) =>
    url ? [new URL(url).origin] : [],
  );
  const derived = (shared: string | undefined) => (shared ? deriveTenantSecret(shared, settings.id) : undefined);
  const view = {
    ...config,
    orgId: settings.orgId,
    apiBaseUrl: origin ?? config.apiBaseUrl,
    publicUrl: origin ?? config.publicUrl,
    publicWebUrl: origin ?? config.publicWebUrl,
    slack: undefined,
    externalSlackPolicies: {},
    s3Bucket: settings.s3Bucket ?? config.s3Bucket,
    s3Prefix: settings.s3Bucket ? undefined : `tenants/${settings.slug}/`,
    adminGrants: settings.secrets.adminGrants,
    deployAppsSessionSecret: derived(config.deployAppsSessionSecret),
    deployAppsLoginUrl: origin ? rehomed(config.deployAppsLoginUrl, homeOrigins, origin) : config.deployAppsLoginUrl,
    deployAppsDomain: settings.appsDomain,
    awsDeploy: { ...config.awsDeploy, appsDomain: settings.appsDomain },
    signingSecret: derived(config.signingSecret),
    capabilitySecret: derived(config.capabilitySecret),
    portalIdentitySecret: derived(config.portalIdentitySecret),
    connectorSecretKey: settings.secrets.connectorSecretKey ?? config.connectorSecretKey,
    sandboxNamePrefix: tenantSandboxPrefix(config.sandbox.namePrefix ?? "qm", settings.id),
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
    view = settings.id ? registeredConfig(config, { ...settings, id: settings.id }) : homeConfig(config, settings);
    byTenant.set(settings, view);
  }
  return view;
}
