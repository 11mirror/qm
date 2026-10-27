import { httpChatConfigsFromEnv, type HttpChatConfig } from "./surfaces/http-chat.ts";
import {
  deploymentBrokerCredentialsFromEnv,
  type DeploymentBrokerCredential,
} from "./credentials/deployment-credentials.ts";
import type { ExternalSlackPolicies } from "./resolution/external-slack.ts";
import { isBearerSecret, isStrongSigningSecret } from "./auth/source-auth.ts";
import { SANDBOX_BACKEND_NAMES, type SandboxBackendName } from "./sandbox/sandbox-routing.ts";
import { existsSync, readdirSync } from "node:fs";
import { parseProviderBaseUrl, type ModelGatewayTransportConfig } from "./model/provider-endpoints.ts";
import { join, resolve } from "node:path";
import { z } from "zod";
import { RUN_MAX_AGE_MS } from "./runs/run-store.ts";
import { DEFAULT_MEMORY_POLICY, type MemoryCaptureMode, type MemoryRecallMode } from "./memory/policy.ts";
import { sanitizeBranding } from "./resolution/branding.ts";
import type { OrgBranding } from "./resolution/config-store.ts";
import { CORE_SECRET_SPECS, validateCoreSecretEnv } from "./deployment/secret-schema.ts";
import { DEFAULT_CAPTURE_QUIET_MS } from "./memory/strategies/per-turn.ts";
import { slackPluginConfigFromEnv, slackAccountConfigsFromEnv, type SlackPluginConfig } from "./slack/config.ts";
import {
  DEFAULT_CODEX_MODEL_ID,
  MODEL_PROVIDERS,
  defaultModelForProvider,
  isModelProvider,
  onlyProvider,
  type ModelProvider,
  type ModelProviderAvailability,
} from "./model/pi-models.ts";

interface TenantConfig {
  orgId: string;
  brandingDefault?: OrgBranding;
  brokerCredentials?: DeploymentBrokerCredential[];
  adminGrants?: string;
  trustedOidcAdminIssuer?: string;
  emailAuthPrincipals?: string[];
  emailAuthDomain?: string;
  apiBaseUrl?: string;
  publicUrl?: string;
  publicWebUrl?: string;
  slack?: SlackPluginConfig;
  externalSlackPolicies?: ExternalSlackPolicies;
  chatSurfaces?: HttpChatConfig[];
  s3Prefix?: string;
  deployAppsSessionSecret?: string;
  deployAppsLoginUrl?: string;
  deployAppsLoginPath?: "/auth/login" | "/auth/trusted/login";
  deployAppsDomain?: string;
}

interface DeploymentConfig extends ReturnType<typeof sandboxProvidersEnv> {
  productAnalytics?: { apiKey: string; host?: string };
  suggestedActivitiesEnabled?: boolean;
  suggestedActivitiesContext?: string;
  production: boolean;
  /** QM_MULTITENANT=1: one process serves every registered tenant from one database with row-level tenancy. */
  multitenant: boolean;
  port: number;
  publicPort?: number;
  dataDir: string;
  databaseUrl?: string;
  databaseCaCert?: string;
  databaseCaCertFile?: string;
  databasePoolUrl?: string;
  databasePoolCaCert?: string;
  databasePoolMax?: number;
  databaseDirectPoolMax?: number;
  sandboxBackend: SandboxBackendName;
  deployProvider: "docker" | "aws" | "porter" | "e2b";
  modelId?: string;
  /** Keychain credential id holding the Codex ChatGPT OAuth auth.json (production path). */
  codexAuthCredential?: string;
  /** Keychain credential id holding a Claude Code subscription token (production path). */
  claudeAuthCredential?: string;
  detectModelId?: string;
  titleModelId?: string;
  judgeModelId?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openrouterApiKey?: string;
  modelProvider?: ModelProvider;
  modelGateway?: ModelGatewayTransportConfig;
  resendApiKey?: string;
  emailFrom?: string;
  budgetUsdPerWindow?: number;
  orgBudgetUsdPerWindow?: number;
  maxContextTokens?: number;
  turnWallClockMs: number;
  runWaitMs: number;
  backgroundWorkEnabled: boolean;
  backgroundDeploymentId?: string;
  deploymentControlSecret?: string;
  spendExportToken?: string;
  buildSha?: string;
  signingSecret?: string;
  capabilitySecret?: string;
  capabilityTokenCompression?: boolean;
  portalIdentitySecret?: string;
  requireSignedPortalIdentity?: boolean;
  connectorSecretKey?: string;
  seedSkills: boolean;
  pluginSkillDirs: string[];
  deploymentLayerDir?: string;
  layerEnv?: Readonly<Record<string, string | undefined>>;
  s3Bucket?: string;
  s3Region?: string;
  deployGitDir: string;
  cronFireConcurrency: number;
  memoryRecall: MemoryRecallMode;
  memoryCapture: MemoryCaptureMode;
  memoryCaptureQuietMs: number;
  workers: number;
  reaperIntervalMs: number;
  shutdownDrainMs: number;
  maxAttempts: number;
  approvalSummaryTimeoutMs: number;
  turnLeaseWaitMs: number;
  securityScreenTimeoutMs: number;
  securityScreenProxy?: {
    provider: string;
    endpoint: string;
    token: string;
  };
  reachExecEnabled: boolean;
  sandbox: ReturnType<typeof sandboxEnv>;
  porterDeploy: ReturnType<typeof porterDeployEnv>;
  awsDeploy: ReturnType<typeof awsDeployEnv>;
}

export type Config = DeploymentConfig & TenantConfig;

export function configuredModel(config: Config): string | undefined {
  if (
    !config.modelId &&
    !config.anthropicApiKey &&
    !config.modelProvider &&
    companySubscriptionAuth(config) === "openai"
  )
    return DEFAULT_CODEX_MODEL_ID;
  return config.modelId;
}

export function providerKeysPresent(config: Config): ModelProviderAvailability {
  return {
    anthropic: Boolean(config.anthropicApiKey || config.claudeAuthCredential),
    openai: Boolean(config.openaiApiKey),
    openrouter: Boolean(config.openrouterApiKey),
    ...(config.codexAuthCredential ? { codexOAuth: true } : {}),
  };
}

export function baseModelProviders(config: Config): ModelProviderAvailability | undefined {
  return config.modelProvider ? onlyProvider(config.modelProvider) : undefined;
}

export function companySubscriptionAuth(config: Config): ModelProvider | undefined {
  if (!config.anthropicApiKey && config.claudeAuthCredential) return "anthropic";
  if (config.codexAuthCredential) return "openai";
  return undefined;
}

// ---- Env parsing: one zod object per section; a bad value names its variable. ----

type Env = Readonly<Record<string, string | undefined>>;
const ENV_NAME = "\u0000env\u0000";
/** The raw value, blank included. */
const raw = z.string().optional();
/** A non-empty value, untouched. */
const str = raw.transform((v) => v || undefined);
/** A value with surrounding whitespace removed; blank reads as unset. */
const trimmed = raw.transform((v) => v?.trim() || undefined);
const csv = raw.transform((v) => {
  const items = (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
});
const num = raw.transform((v, ctx) => {
  if (v === undefined || v.trim() === "") return undefined;
  const n = numEnv(v);
  if (n === undefined)
    ctx.addIssue({
      code: "custom",
      message: `${ENV_NAME}=${JSON.stringify(v)} is not a number — set a finite numeric value, or unset it.`,
    });
  return n;
});
const flag = raw.transform((v, ctx) => {
  if (v === undefined || v.trim() === "") return undefined;
  const b = boolEnv(v);
  if (b === undefined)
    ctx.addIssue({
      code: "custom",
      message: `${ENV_NAME}=${JSON.stringify(v)} is not a recognized boolean — use 1/true/yes/on or 0/false/no/off/none (case-insensitive), or unset it.`,
    });
  return b;
});

function readEnv<S extends z.ZodRawShape>(env: Env, shape: S): z.output<z.ZodObject<S>> {
  const parsed = z.object(shape).safeParse(env);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw new Error(issue.message.replaceAll(ENV_NAME, String(issue.path[0])));
}

/** Drop unset keys so an absent variable leaves no key behind. */
function defined<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as never;
}

function sandboxEnv(env: Env) {
  const e = readEnv(env, {
    SANDBOX_NAME_PREFIX: trimmed,
    SANDBOX_EGRESS_PROXY_URL: trimmed,
    SANDBOX_SNAPSHOT_INTERVAL_SEC: num,
    SANDBOX_CPUS: num,
    SANDBOX_MEMORY_MB: num,
    SANDBOX_DISK_GB: num,
    SANDBOX_IDLE_PARK_SEC: num,
    SANDBOX_MAX_LIFETIME_SEC: num,
  });
  return defined({
    namePrefix: e.SANDBOX_NAME_PREFIX,
    egressProxyUrl: e.SANDBOX_EGRESS_PROXY_URL,
    snapshotIntervalSec: e.SANDBOX_SNAPSHOT_INTERVAL_SEC,
    cpus: e.SANDBOX_CPUS,
    memoryMb: e.SANDBOX_MEMORY_MB,
    diskGb: e.SANDBOX_DISK_GB,
    idleParkSec: e.SANDBOX_IDLE_PARK_SEC,
    maxLifetimeSec: e.SANDBOX_MAX_LIFETIME_SEC,
  });
}

function sandboxProvidersEnv(env: Env) {
  const e = readEnv(env, {
    LOCAL_SANDBOX_IMAGE: str,
    LOCAL_SANDBOX_DOCKER_BIN: str,
    QM_CORE_CONTAINER: str,
    SPRITES_TOKEN: str,
    SMOLMACHINES_TOKEN: str,
    E2B_API_KEY: str,
    E2B_TEMPLATE_ID: str,
    DO_AGENTS_API_TOKEN: str,
    DO_AGENTS_TEMPLATE: str,
    MODAL_TOKEN_ID: str,
    MODAL_TOKEN_SECRET: str,
    MODAL_APP_NAME: str,
    MODAL_ENVIRONMENT: str,
    MODAL_IMAGE: str,
  });
  return {
    // The Docker target sets QM_CORE_CONTAINER so core, itself a container, joins each sandbox's network.
    localSandbox: defined({
      image: e.LOCAL_SANDBOX_IMAGE,
      dockerBin: e.LOCAL_SANDBOX_DOCKER_BIN,
      coreContainer: e.QM_CORE_CONTAINER,
    }),
    spritesSandbox: defined({ token: e.SPRITES_TOKEN }),
    smolmachinesSandbox: defined({ token: e.SMOLMACHINES_TOKEN }),
    e2bSandbox: defined({ apiKey: e.E2B_API_KEY, templateId: e.E2B_TEMPLATE_ID }),
    managedAgentsSandbox: defined({ apiToken: e.DO_AGENTS_API_TOKEN, template: e.DO_AGENTS_TEMPLATE }),
    modalSandbox: defined({
      tokenId: e.MODAL_TOKEN_ID,
      tokenSecret: e.MODAL_TOKEN_SECRET,
      appName: e.MODAL_APP_NAME,
      environment: e.MODAL_ENVIRONMENT,
      image: e.MODAL_IMAGE,
    }),
  };
}

function awsDeployEnv(env: Env, deployAppsDomain: string | undefined) {
  const e = readEnv(env, {
    AWS_DEPLOY_REGION: raw,
    AWS_DEPLOY_PROFILE: str,
    AWS_DEPLOY_IMAGE: raw,
    AWS_DEPLOY_IMAGE_VERSION: str,
    AWS_DEPLOY_EXEC_ROLE_ARN: str,
    AWS_DEPLOY_INGRESS_CONNECTORS: csv,
    AWS_DEPLOY_EGRESS_CONNECTORS: csv,
    AWS_DEPLOY_AGENT_PORT: num,
    AWS_DEPLOY_APP_PORT: num,
    AWS_DEPLOY_MAX_DURATION_SEC: num,
    AWS_DEPLOY_MAX_IDLE_SEC: num,
    AWS_DEPLOY_SUSPENDED_SEC: num,
    AWS_DEPLOY_GATE_SECRET: str,
    AWS_DEPLOY_TOKEN_TTL_MIN: num,
    AWS_DEPLOY_DATA_BUCKET: str,
    AWS_DEPLOY_DATA_PREFIX: str,
    AWS_DEPLOY_DATA_ROLE_ARN: str,
    AWS_DEPLOY_SNAPSHOT_INTERVAL_MS: num,
  });
  return {
    region: e.AWS_DEPLOY_REGION ?? "us-west-2",
    imageIdentifier: e.AWS_DEPLOY_IMAGE ?? "qm-microvm-sandbox",
    ...defined({
      profile: e.AWS_DEPLOY_PROFILE,
      imageVersion: e.AWS_DEPLOY_IMAGE_VERSION,
      executionRoleArn: e.AWS_DEPLOY_EXEC_ROLE_ARN,
      ingressConnectorArns: e.AWS_DEPLOY_INGRESS_CONNECTORS,
      egressConnectorArns: e.AWS_DEPLOY_EGRESS_CONNECTORS,
      agentPort: e.AWS_DEPLOY_AGENT_PORT,
      appPort: e.AWS_DEPLOY_APP_PORT,
      maximumDurationInSeconds: e.AWS_DEPLOY_MAX_DURATION_SEC,
      maxIdleDurationSeconds: e.AWS_DEPLOY_MAX_IDLE_SEC,
      suspendedDurationSeconds: e.AWS_DEPLOY_SUSPENDED_SEC,
      appsDomain: deployAppsDomain,
      gateSecret: e.AWS_DEPLOY_GATE_SECRET,
      tokenTtlMinutes: e.AWS_DEPLOY_TOKEN_TTL_MIN,
      dataBucket: e.AWS_DEPLOY_DATA_BUCKET,
      dataPrefix: e.AWS_DEPLOY_DATA_PREFIX,
      dataRoleArn: e.AWS_DEPLOY_DATA_ROLE_ARN,
      snapshotIntervalMs:
        e.AWS_DEPLOY_SNAPSHOT_INTERVAL_MS === undefined
          ? undefined
          : Math.max(60_000, e.AWS_DEPLOY_SNAPSHOT_INTERVAL_MS),
    }),
  };
}

function porterApiBaseUrl(env: Env): string | undefined {
  const e = readEnv(env, {
    PORTER_DEPLOY_PROJECT_ID: num,
    PORTER_DEPLOY_CLUSTER_ID: num,
    PORTER_DEPLOY_URL: raw,
    PORTER_SANDBOX_BASE_URL: raw,
  });
  const derived =
    e.PORTER_DEPLOY_PROJECT_ID !== undefined && e.PORTER_DEPLOY_CLUSTER_ID !== undefined
      ? `${(e.PORTER_DEPLOY_URL ?? "https://dashboard.porter.run").replace(/\/+$/, "")}/api/v2/alpha/projects/${e.PORTER_DEPLOY_PROJECT_ID}/clusters/${e.PORTER_DEPLOY_CLUSTER_ID}`
      : undefined;
  return e.PORTER_SANDBOX_BASE_URL ?? derived;
}

const porterLocatorPresent = (env: Env): boolean =>
  Boolean(porterApiBaseUrl(env) || env.PORTER_CLUSTER_ID || env.KUBERNETES_SERVICE_HOST);

const PORTER_VISIBILITIES = ["public", "private", "internal"] as const;

function porterDeployEnv(env: Env) {
  const e = readEnv(env, {
    PORTER_DEPLOY_API_TOKEN: str,
    PORTER_DEPLOY_RUNNER_IMAGE: str,
    PORTER_DEPLOY_APPS_DOMAIN: str,
    PORTER_DEPLOY_VISIBILITY: raw.transform((v, ctx) => {
      const visibility = v?.trim();
      if (!visibility) return undefined;
      if ((PORTER_VISIBILITIES as readonly string[]).includes(visibility))
        return visibility as (typeof PORTER_VISIBILITIES)[number];
      ctx.addIssue({
        code: "custom",
        message: `PORTER_DEPLOY_VISIBILITY=${JSON.stringify(v)} is not recognized — use public, private, or internal, or unset it.`,
      });
      return undefined;
    }),
    SANDBOX_NAME_PREFIX: trimmed,
  });
  if (e.PORTER_DEPLOY_VISIBILITY === "internal" && e.PORTER_DEPLOY_APPS_DOMAIN) {
    throw new Error(
      "PORTER_DEPLOY_VISIBILITY=internal serves apps inside the cluster only, so it takes no PORTER_DEPLOY_APPS_DOMAIN — unset one of them.",
    );
  }
  return defined({
    token: e.PORTER_DEPLOY_API_TOKEN,
    baseUrl: porterApiBaseUrl(env),
    runnerImage: e.PORTER_DEPLOY_RUNNER_IMAGE,
    appsDomain: e.PORTER_DEPLOY_APPS_DOMAIN,
    visibility: e.PORTER_DEPLOY_VISIBILITY,
    namePrefix: e.SANDBOX_NAME_PREFIX,
  });
}

function deployAppsEnv(
  env: Env,
  defaultLoginUrl: string | undefined,
): {
  deployAppsSessionSecret?: string;
  deployAppsLoginUrl?: string;
  deployAppsLoginPath?: "/auth/login" | "/auth/trusted/login";
} {
  const secret = env.PORTAL_SESSION_SECRET || undefined;
  const loginUrl = env.DEPLOY_APPS_LOGIN_URL ?? (secret ? defaultLoginUrl : undefined);
  if (loginUrl && !secret) throw new Error("DEPLOY_APPS_LOGIN_URL requires PORTAL_SESSION_SECRET");
  const loginPath = env.DEPLOY_APPS_LOGIN_PATH ?? "/auth/login";
  if (loginPath !== "/auth/login" && loginPath !== "/auth/trusted/login") {
    throw new Error("DEPLOY_APPS_LOGIN_PATH must be /auth/login or /auth/trusted/login");
  }
  if (!secret || !loginUrl) return {};
  return {
    deployAppsSessionSecret: secret,
    deployAppsLoginUrl: loginUrl.replace(/\/$/, ""),
    deployAppsLoginPath: loginPath,
  };
}

const SHARED_PLATFORM_SUFFIXES = [
  "onporter.run",
  "withporter.run",
  "porter.run",
  "fly.dev",
  "herokuapp.com",
  "onrender.com",
  "railway.app",
  "vercel.app",
  "netlify.app",
  "ondigitalocean.app",
  "azurewebsites.net",
  "elasticbeanstalk.com",
  "amazonaws.com",
  "cloudfront.net",
  "github.io",
  "pages.dev",
  "workers.dev",
  "e2b.app",
];

function sharedPlatformSuffixOf(domain: string): string | undefined {
  const host = domain.toLowerCase();
  return SHARED_PLATFORM_SUFFIXES.find((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

const HOSTNAME_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})+$`);

function deployAppsDomainEnv(env: Env): string | undefined {
  // Porter's sandbox-ingress name (PORTER_DEPLOY_APPS_DOMAIN) is a separate, ungated mechanism; it stays separate.
  const raw = env.DEPLOY_APPS_DOMAIN?.trim();
  if (raw) {
    const canonical = raw.toLowerCase().replace(/\.$/, "");
    if (!HOSTNAME_RE.test(canonical)) {
      throw new Error(
        `DEPLOY_APPS_DOMAIN (${raw}) is not a plain DNS name — set it to a bare domain like apps.example.com (no scheme, port, path, or wildcard prefix).`,
      );
    }
    const suffix = sharedPlatformSuffixOf(canonical);
    if (suffix) {
      throw new Error(
        `DEPLOY_APPS_DOMAIN (${canonical}) is under ${suffix}, a shared platform domain that cannot carry per-app subdomains — attach a custom domain you control (set DEPLOY_APPS_DOMAIN=apps.<your-domain> with a wildcard DNS record pointing at this instance), or unset it to keep serving apps signed-in at /d/<app>/.`,
      );
    }
    return canonical;
  }
  return env.DEPLOY_PROVIDER === "porter" ? env.PORTER_DEPLOY_APPS_DOMAIN || undefined : undefined;
}

const DEFAULT_ORG_ID = "default-org";

export function processOrgId(): string {
  return process.env.ORG_ID ?? DEFAULT_ORG_ID;
}

export const CONFIG_DEFAULTS = {
  port: 8080,
  turnWallClockSec: 0,
  backgroundWorkEnabled: true,
  cronFireConcurrency: 4,
  approvalSummaryTimeoutMs: 6_000,
  turnLeaseWaitMs: 5_000,
  securityScreenTimeoutMs: 15_000,
  workers: 16,
  reaperIntervalMs: 15_000,
  shutdownDrainMs: 30_000,
  maxAttempts: 3,
} as const;

export function boolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off", "none"].includes(v)) return false;
  return undefined;
}

export function numEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function backgroundWorkEnabled(env: Env): boolean {
  return (
    readEnv(env, { BACKGROUND_WORK_ENABLED: flag }).BACKGROUND_WORK_ENABLED ?? CONFIG_DEFAULTS.backgroundWorkEnabled
  );
}

function orgBrandingFromEnv(env: Env): Config["brandingDefault"] {
  return sanitizeBranding({
    accent: env.ORG_BRAND_ACCENT,
    mark: env.ORG_BRAND_MARK,
    selfLabel: env.ORG_BRAND_SELF_LABEL,
    orgName: env.ORG_BRAND_ORG_NAME,
  });
}

export function enabledSandboxBackends(config: Config): Array<Config["sandboxBackend"]> {
  const credentialed: Record<Config["sandboxBackend"], boolean> = {
    local: Boolean(config.localSandbox?.image),
    sprites: Boolean(config.spritesSandbox?.token),
    smolmachines: Boolean(config.smolmachinesSandbox?.token),
    e2b: Boolean(config.e2bSandbox?.apiKey),
    "do-managed-agents": Boolean(config.managedAgentsSandbox?.apiToken),
    modal: Boolean(config.modalSandbox?.tokenId && config.modalSandbox?.tokenSecret),
  };
  const enabled = new Set<Config["sandboxBackend"]>([config.sandboxBackend]);
  for (const [name, on] of Object.entries(credentialed)) {
    if (on) enabled.add(name as Config["sandboxBackend"]);
  }
  return [...enabled];
}

/** "a, b, or c" */
const orList = (names: readonly string[]): string => `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;

function sandboxBackendEnvStrict(value: string | undefined, name = "SANDBOX_BACKEND"): Config["sandboxBackend"] {
  if (value === undefined || value.trim() === "") return "local";
  const backend = value.trim();
  if ((SANDBOX_BACKEND_NAMES as readonly string[]).includes(backend)) return backend as SandboxBackendName;
  throw new Error(
    `${name}=${JSON.stringify(value)} is not recognized — use ${orList(SANDBOX_BACKEND_NAMES)}, or unset it.`,
  );
}

export function modelGatewayFromEnv(env: Env): ModelGatewayTransportConfig | undefined {
  const names = ["MODEL_GATEWAY_URL", "MODEL_GATEWAY_API_KEY", "MODEL_GATEWAY_API_KEY_HEADER", "MODEL_GATEWAY_MODELS"];
  if (!names.some((name) => env[name]?.trim())) return undefined;
  for (const name of names.filter((name) => name !== "MODEL_GATEWAY_MODELS")) {
    if (!env[name]?.trim()) throw new Error(`${name} is required when model gateway routing is configured`);
  }
  const apiKeyHeader = env.MODEL_GATEWAY_API_KEY_HEADER!.trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(apiKeyHeader)) {
    throw new Error("MODEL_GATEWAY_API_KEY_HEADER must be a valid HTTP header name");
  }
  const models: Record<string, string> = {};
  for (const mapping of env.MODEL_GATEWAY_MODELS?.trim() ? env.MODEL_GATEWAY_MODELS.split(",") : []) {
    const separator = mapping.indexOf("=");
    const source = mapping.slice(0, separator).trim();
    const target = mapping.slice(separator + 1).trim();
    if (separator < 1 || !source || !target) throw new Error(`invalid MODEL_GATEWAY_MODELS mapping: ${mapping}`);
    if (models[source]) throw new Error(`duplicate MODEL_GATEWAY_MODELS source: ${source}`);
    models[source] = target;
  }
  return {
    url: parseProviderBaseUrl("MODEL_GATEWAY_URL", env.MODEL_GATEWAY_URL!),
    apiKey: env.MODEL_GATEWAY_API_KEY!,
    apiKeyHeader,
    models,
  };
}

function defaultPluginSkillDirs(): string[] {
  const root = resolve("./plugins");
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, "skills"))
      .filter((dir) => existsSync(dir));
  } catch {
    return [];
  }
}

function modelProviderEnvStrict(env: Env): ModelProvider | undefined {
  const declared = env.MODEL_PROVIDER?.trim();
  if (!declared) return undefined;
  if (!isModelProvider(declared)) {
    throw new Error(
      `MODEL_PROVIDER=${JSON.stringify(declared)} is not recognized — use ${MODEL_PROVIDERS.join(", ")}.`,
    );
  }
  if (!defaultModelForProvider(declared)) {
    throw new Error(
      `MODEL_PROVIDER=${declared} cannot serve a base model — no ${declared} model is available, so every turn would be refused.`,
    );
  }
  return declared;
}

/**
 * Source requests, capability tokens, portal identity and connector keys each sign with their own secret, so a
 * surface holding one cannot forge another. Whenever source signing or portal identity is on, all three are required.
 */
function assertDistinctSecrets(secrets: {
  signing?: string;
  capability?: string;
  portalIdentity?: string;
  connector?: string;
  enforcePortalIdentity: boolean;
}): void {
  if (secrets.signing || secrets.enforcePortalIdentity) {
    const shared = (name: string, value: string | undefined): string | null => {
      if (!value) return `${name} is not set`;
      return value === secrets.signing ? `${name} must differ from CORE_SIGNING_SECRET` : null;
    };
    const problem =
      shared("CAPABILITY_SECRET", secrets.capability) ??
      shared("PORTAL_IDENTITY_SECRET", secrets.portalIdentity) ??
      (secrets.capability === secrets.portalIdentity
        ? "PORTAL_IDENTITY_SECRET must differ from CAPABILITY_SECRET"
        : null);
    if (problem)
      throw new Error(
        `${problem}: CORE_SIGNING_SECRET, CAPABILITY_SECRET and PORTAL_IDENTITY_SECRET must all be set and distinct, or a surface could forge capabilities or portal identity.`,
      );
  }
  const reusedConnectorKey = (
    [
      ["CORE_SIGNING_SECRET", secrets.signing],
      ["CAPABILITY_SECRET", secrets.capability],
      ["PORTAL_IDENTITY_SECRET", secrets.portalIdentity],
    ] as const
  ).find(([, value]) => secrets.connector && secrets.connector === value)?.[0];
  if (reusedConnectorKey) throw new Error(`CONNECTOR_SECRET_KEY must differ from ${reusedConnectorKey}`);
}

function loadDeploymentConfig(env: Env): DeploymentConfig {
  const token = env.SPEND_EXPORT_TOKEN;
  if (token) {
    const reused = Object.entries(env).some(([name, value]) => name !== "SPEND_EXPORT_TOKEN" && value === token);
    if (!isStrongSigningSecret(token) || !isBearerSecret(token) || reused)
      throw new Error(
        "SPEND_EXPORT_TOKEN must be at least 32 characters, have no surrounding whitespace and differ from every other environment value",
      );
  }
  if (env.BACKGROUND_DEPLOYMENT_ID !== undefined) {
    if (!env.BACKGROUND_DEPLOYMENT_ID.trim() || env.BACKGROUND_DEPLOYMENT_ID.length > 256)
      throw new Error("BACKGROUND_DEPLOYMENT_ID must be nonempty and at most 256 characters");
    if (!env.DATABASE_URL) throw new Error("Background ownership requires DATABASE_URL");
    if (
      !isStrongSigningSecret(env.CORE_SIGNING_SECRET) ||
      !isStrongSigningSecret(env.DEPLOYMENT_CONTROL_SECRET) ||
      env.DEPLOYMENT_CONTROL_SECRET === env.CORE_SIGNING_SECRET
    )
      throw new Error(
        "Background ownership requires a distinct DEPLOYMENT_CONTROL_SECRET of at least 32 characters and CORE_SIGNING_SECRET",
      );
  }
  const deployAppsDomain = deployAppsDomainEnv(env);
  const missingSecrets = validateCoreSecretEnv(env);
  if (missingSecrets.length) {
    const described = missingSecrets.map((name) => {
      const reason = CORE_SECRET_SPECS.find((spec) => spec.name === name)?.reason;
      return reason ? `${name} (${reason})` : name;
    });
    throw new Error(`missing or insecure required core secrets: ${described.join(", ")}`);
  }
  assertDistinctSecrets({
    signing: env.CORE_SIGNING_SECRET || undefined,
    capability: env.CAPABILITY_SECRET || undefined,
    portalIdentity: env.PORTAL_IDENTITY_SECRET || undefined,
    connector: env.CONNECTOR_SECRET_KEY || undefined,
    enforcePortalIdentity: env.NODE_ENV === "production" || env.REQUIRE_SIGNED_PORTAL_IDENTITY === "1",
  });
  const modelProvider = modelProviderEnvStrict(env);
  const dataDir = resolve(env.DATA_DIR ?? "./data");
  if (env.DEPLOY_PROVIDER === "porter" && !env.PORTER_DEPLOY_APPS_DOMAIN && !deployAppsDomain) {
    console.warn(
      "[config] DEPLOY_PROVIDER=porter without an apps domain — published apps are reachable signed-in at /d/<app>/ only; set DEPLOY_APPS_DOMAIN to a domain you control to serve each app on its own subdomain.",
    );
  }
  if (env.DEPLOY_PROVIDER === "porter" && !porterLocatorPresent(env)) {
    throw new Error(
      "DEPLOY_PROVIDER=porter requires PORTER_DEPLOY_PROJECT_ID and PORTER_DEPLOY_CLUSTER_ID (or PORTER_SANDBOX_BASE_URL, or PORTER_CLUSTER_ID) to locate the Porter sandbox API.",
    );
  }
  if (env.NODE_ENV === "production" && !env.SANDBOX_BACKEND?.trim()) {
    throw new Error(`SANDBOX_BACKEND must be set explicitly in production — use ${orList(SANDBOX_BACKEND_NAMES)}.`);
  }
  const sandboxBackend = sandboxBackendEnvStrict(env.SANDBOX_BACKEND);
  const selectedBackend = env.SANDBOX_BACKEND?.trim();
  if (selectedBackend && selectedBackend !== "local" && !env.SANDBOX_EGRESS_PROXY_URL?.trim()) {
    console.warn(
      `[config] SANDBOX_BACKEND=${selectedBackend} without SANDBOX_EGRESS_PROXY_URL — sandboxes run with NO egress enforcement (fail-open); set SANDBOX_EGRESS_PROXY_URL to the public egress proxy to force sandbox traffic through it.`,
    );
  }
  const proxyProvider = env.SECURITY_SCREEN_PROXY_PROVIDER?.trim();
  const proxyEndpoint = env.SECURITY_SCREEN_PROXY_ENDPOINT?.trim();
  const proxyToken = env.SECURITY_SCREEN_PROXY_TOKEN?.trim();
  const hasProxyScreen = [proxyProvider, proxyEndpoint, proxyToken].some(Boolean);
  if (hasProxyScreen && (!proxyProvider || !proxyEndpoint || !proxyToken)) {
    throw new Error(
      "SECURITY_SCREEN_PROXY_PROVIDER, SECURITY_SCREEN_PROXY_ENDPOINT, and SECURITY_SCREEN_PROXY_TOKEN must be set together",
    );
  }
  if (proxyProvider && (proxyProvider.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(proxyProvider))) {
    throw new Error("SECURITY_SCREEN_PROXY_PROVIDER must be a lowercase DNS label");
  }
  if (proxyProvider === "surface" || proxyProvider === "origin") {
    throw new Error("SECURITY_SCREEN_PROXY_PROVIDER must not collide with a security screen metadata field");
  }
  if (proxyEndpoint) {
    try {
      const url = new URL(proxyEndpoint);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.hostname.endsWith("."))
        throw new Error("endpoint");
    } catch {
      throw new Error(
        "SECURITY_SCREEN_PROXY_ENDPOINT must be an HTTPS URL without credentials, a fragment, or a trailing hostname dot",
      );
    }
  }
  const deployProvider = env.DEPLOY_PROVIDER ?? "docker";
  if (
    deployProvider !== "aws" &&
    deployProvider !== "docker" &&
    deployProvider !== "porter" &&
    deployProvider !== "e2b"
  ) {
    throw new Error(
      `DEPLOY_PROVIDER=${JSON.stringify(deployProvider)} is not recognized (expected aws, docker, porter, or e2b)`,
    );
  }
  const modelGateway = modelGatewayFromEnv(env);
  const e = readEnv(env, {
    NODE_ENV: raw,
    QM_MULTITENANT: raw,
    PORT: num,
    PUBLIC_PORT: num,
    POSTHOG_API_KEY: trimmed,
    POSTHOG_HOST: raw,
    DATABASE_URL: str,
    DATABASE_POOL_URL: str,
    DATABASE_POOL_CA_CERT: str,
    DATABASE_POOL_MAX: num,
    DATABASE_DIRECT_POOL_MAX: num,
    DATABASE_CA_CERT: str,
    DATABASE_CA_CERT_FILE: str,
    PI_MODEL: str,
    CODEX_AUTH_CREDENTIAL: trimmed,
    CLAUDE_AUTH_CREDENTIAL: trimmed,
    PI_DETECT_MODEL: str,
    PI_TITLE_MODEL: str,
    PI_JUDGE_MODEL: str,
    ANTHROPIC_API_KEY: str,
    OPENAI_API_KEY: str,
    OPENROUTER_API_KEY: str,
    RESEND_API_KEY: trimmed,
    AUTH_EMAIL_FROM: trimmed,
    BUDGET_USD_PER_WINDOW: num,
    ORG_BUDGET_USD_PER_WINDOW: num,
    BACKGROUND_DEPLOYMENT_ID: str,
    DEPLOYMENT_CONTROL_SECRET: raw,
    SPEND_EXPORT_TOKEN: str,
    GIT_SHA: str,
    CORE_SIGNING_SECRET: str,
    CAPABILITY_SECRET: str,
    PORTAL_IDENTITY_SECRET: str,
    CAPABILITY_TOKEN_COMPRESSION: flag,
    REQUIRE_SIGNED_PORTAL_IDENTITY: raw,
    CONNECTOR_SECRET_KEY: str,
    DEPLOYMENT_LAYER: str,
    S3_BUCKET: str,
    S3_REGION: str,
    CRON_FIRE_CONCURRENCY: num,
    WORKERS: num,
    SHUTDOWN_DRAIN_MS: num,
    REACH_EXEC: flag,
    SUGGESTED_ACTIVITIES_ENABLED: flag,
    SUGGESTED_ACTIVITIES_CONTEXT: str,
  });
  return {
    ...defined({
      suggestedActivitiesContext: e.SUGGESTED_ACTIVITIES_CONTEXT?.slice(0, 8000),
      publicPort: e.PUBLIC_PORT,
      productAnalytics: e.POSTHOG_API_KEY ? { apiKey: e.POSTHOG_API_KEY, host: e.POSTHOG_HOST?.trim() } : undefined,
      databaseUrl: e.DATABASE_URL,
      databasePoolUrl: e.DATABASE_POOL_URL,
      databasePoolCaCert: e.DATABASE_POOL_CA_CERT,
      databasePoolMax: e.DATABASE_POOL_MAX,
      databaseDirectPoolMax: e.DATABASE_DIRECT_POOL_MAX,
      databaseCaCert: e.DATABASE_CA_CERT,
      databaseCaCertFile: e.DATABASE_CA_CERT_FILE,
      securityScreenProxy: hasProxyScreen
        ? { provider: proxyProvider!, endpoint: proxyEndpoint!, token: proxyToken! }
        : undefined,
      modelId: e.PI_MODEL,
      codexAuthCredential: e.CODEX_AUTH_CREDENTIAL,
      claudeAuthCredential: e.CLAUDE_AUTH_CREDENTIAL,
      detectModelId: e.PI_DETECT_MODEL,
      titleModelId: e.PI_TITLE_MODEL,
      judgeModelId: e.PI_JUDGE_MODEL,
      anthropicApiKey: e.ANTHROPIC_API_KEY,
      openaiApiKey: e.OPENAI_API_KEY,
      openrouterApiKey: e.OPENROUTER_API_KEY,
      modelProvider,
      modelGateway,
      resendApiKey: e.RESEND_API_KEY,
      emailFrom: e.AUTH_EMAIL_FROM,
      budgetUsdPerWindow: e.BUDGET_USD_PER_WINDOW,
      orgBudgetUsdPerWindow: e.ORG_BUDGET_USD_PER_WINDOW,
      spendExportToken: e.SPEND_EXPORT_TOKEN,
      buildSha: e.GIT_SHA,
      signingSecret: e.CORE_SIGNING_SECRET,
      capabilitySecret: e.CAPABILITY_SECRET,
      portalIdentitySecret: e.PORTAL_IDENTITY_SECRET,
      connectorSecretKey: e.CONNECTOR_SECRET_KEY,
      deploymentLayerDir: e.DEPLOYMENT_LAYER ? resolve(e.DEPLOYMENT_LAYER) : undefined,
      s3Bucket: e.S3_BUCKET,
      s3Region: e.S3_REGION,
    }),
    ...(e.BACKGROUND_DEPLOYMENT_ID
      ? { backgroundDeploymentId: e.BACKGROUND_DEPLOYMENT_ID, deploymentControlSecret: e.DEPLOYMENT_CONTROL_SECRET }
      : {}),
    suggestedActivitiesEnabled: e.SUGGESTED_ACTIVITIES_ENABLED ?? true,
    production: e.NODE_ENV === "production",
    multitenant: e.QM_MULTITENANT === "1",
    port: e.PORT ?? CONFIG_DEFAULTS.port,
    dataDir,
    sandboxBackend,
    deployProvider,
    turnWallClockMs: CONFIG_DEFAULTS.turnWallClockSec * 1000,
    runWaitMs: RUN_MAX_AGE_MS + 60_000,
    seedSkills: true,
    pluginSkillDirs: defaultPluginSkillDirs(),
    memoryRecall: DEFAULT_MEMORY_POLICY.recall,
    memoryCapture: DEFAULT_MEMORY_POLICY.capture,
    memoryCaptureQuietMs: DEFAULT_CAPTURE_QUIET_MS,
    reaperIntervalMs: CONFIG_DEFAULTS.reaperIntervalMs,
    maxAttempts: CONFIG_DEFAULTS.maxAttempts,
    approvalSummaryTimeoutMs: CONFIG_DEFAULTS.approvalSummaryTimeoutMs,
    turnLeaseWaitMs: CONFIG_DEFAULTS.turnLeaseWaitMs,
    securityScreenTimeoutMs: CONFIG_DEFAULTS.securityScreenTimeoutMs,
    backgroundWorkEnabled: backgroundWorkEnabled(env),
    capabilityTokenCompression: e.CAPABILITY_TOKEN_COMPRESSION ?? false,
    requireSignedPortalIdentity: e.REQUIRE_SIGNED_PORTAL_IDENTITY === "1",
    layerEnv: { ...env },
    deployGitDir: join(dataDir, "deploy-git"),
    cronFireConcurrency: e.CRON_FIRE_CONCURRENCY ?? CONFIG_DEFAULTS.cronFireConcurrency,
    workers: e.WORKERS ?? CONFIG_DEFAULTS.workers,
    shutdownDrainMs: e.SHUTDOWN_DRAIN_MS ?? CONFIG_DEFAULTS.shutdownDrainMs,
    reachExecEnabled: e.REACH_EXEC ?? false,
    sandbox: sandboxEnv(env),
    ...sandboxProvidersEnv(env),
    porterDeploy: porterDeployEnv(env),
    awsDeploy: awsDeployEnv(env, env.DEPLOY_APPS_DOMAIN?.trim() ? deployAppsDomain : undefined),
  };
}

function loadTenantConfig(env: Env): TenantConfig {
  const publicApiUrl = env.PUBLIC_API_URL?.replace(/\/+$/, "");
  const publicWebUrl = env.PUBLIC_WEB_URL?.replace(/\/+$/, "");
  const publicUrl = publicWebUrl || publicApiUrl;
  const deployAppsDomain = deployAppsDomainEnv(env);
  const brokerCredentials = deploymentBrokerCredentialsFromEnv(env);
  const slack = slackPluginConfigFromEnv(env);
  const externalSlackPolicies = Object.fromEntries(
    [...(slack ? [slack] : []), ...slackAccountConfigsFromEnv(env)]
      .filter((account) => account.externalAccess)
      .map((account) => [account.accountId ?? "default", account.externalAccess!]),
  );
  const brandingDefault = orgBrandingFromEnv(env);
  return {
    orgId: env.ORG_ID ?? DEFAULT_ORG_ID,
    ...(brandingDefault ? { brandingDefault } : {}),
    ...(brokerCredentials.length ? { brokerCredentials } : {}),
    ...(env.TRUSTED_OIDC_ADMIN_ISSUER ? { trustedOidcAdminIssuer: env.TRUSTED_OIDC_ADMIN_ISSUER } : {}),
    ...(env.ADMIN_GRANTS ? { adminGrants: env.ADMIN_GRANTS } : {}),
    ...(env.AUTH_ALLOWED_EMAILS
      ? {
          emailAuthPrincipals: [
            ...new Set(
              env.AUTH_ALLOWED_EMAILS.split(",")
                .map((email) => email.trim().toLowerCase())
                .filter(Boolean),
            ),
          ],
        }
      : {}),
    ...(env.AUTH_ALLOWED_EMAIL_DOMAIN?.trim()
      ? { emailAuthDomain: env.AUTH_ALLOWED_EMAIL_DOMAIN.trim().toLowerCase() }
      : {}),
    ...(publicApiUrl ? { apiBaseUrl: publicApiUrl } : {}),
    ...(publicUrl ? { publicUrl } : {}),
    ...(publicWebUrl ? { publicWebUrl } : {}),
    ...(slack ? { slack } : {}),
    externalSlackPolicies,
    chatSurfaces: httpChatConfigsFromEnv(env),
    ...(env.S3_PREFIX ? { s3Prefix: env.S3_PREFIX } : {}),
    ...deployAppsEnv(env, publicUrl),
    ...(deployAppsDomain ? { deployAppsDomain } : {}),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return { ...loadDeploymentConfig(env), ...loadTenantConfig(env) };
}
