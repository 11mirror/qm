import { httpChatConfigsFromEnv, type HttpChatConfig } from "./chat-surface/http-chat.ts";
import {
  deploymentBrokerCredentialsFromEnv,
  type DeploymentBrokerCredential,
} from "./credentials/deployment-credentials.ts";
import type { ExternalSlackPolicies } from "./resolution/external-slack.ts";
import { isBearerSecret, isStrongSigningSecret } from "./auth/source-auth.ts";
import { parseScopeId } from "./types.ts";
import type { LegacySandboxScopeDefaults } from "./sandbox/sandbox-resource-upgrade.ts";
import type { SandboxBackendName } from "./sandbox/sandbox-routing.ts";
import { existsSync, readdirSync } from "node:fs";
import { parseProviderBaseUrl, type ModelGatewayTransportConfig } from "./model/provider-endpoints.ts";
import { join, resolve } from "node:path";
import { DEFAULT_MEMORY_POLICY, type MemoryCaptureMode, type MemoryRecallMode } from "./memory/policy.ts";
import { parseMemoryProviderConfig, type MemoryProviderConfig } from "./memory/provider-config.ts";
import { sanitizeBranding } from "./resolution/branding.ts";
import type { OrgBranding } from "./resolution/config-store.ts";
import { CORE_SECRET_SPECS, validateCoreSecretEnv } from "./deployment/secret-schema.ts";
import { DEFAULT_CAPTURE_QUIET_MS } from "./memory/strategies/per-turn.ts";
import {
  DEFAULT_SECURITY_POSTURE,
  type SecurityPosture,
  type SecurityScreenMode,
} from "./security/security-posture.ts";
import { DEFAULT_SHARING_POSTURE, type SharingPosture } from "./resolution/sharing-posture.ts";
import {
  parseSlackContextSource,
  type SlackContextSource,
  slackPluginConfigFromEnv,
  slackAccountConfigsFromEnv,
  type SlackPluginConfig,
} from "./slack/config.ts";
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

interface DeploymentConfig {
  productAnalytics?: { apiKey: string; host?: string };
  slackContextSource?: SlackContextSource;
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
  securityPosture: SecurityPosture;
  sharingPosture: SharingPosture;
  legacySandboxScopeDefaults?: LegacySandboxScopeDefaults;
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
  piSystemCacheSplit: boolean;
  resendApiKey?: string;
  emailFrom?: string;
  rateLimitPerWindow: number;
  rateLimitWindowMs: number;
  budgetUsdPerWindow?: number;
  orgBudgetUsdPerWindow?: number;
  budgetWindowMs: number;
  maxContextTokens?: number;
  execTimeoutDefaultMs: number;
  execTimeoutMaxMs: number;
  turnWallClockMs: number;
  runMaxAgeMs: number;
  runWaitMs: number;
  backgroundJobTtlMs: number;
  backgroundJobTtlMaxMs: number;
  roles: QmRole[];
  backgroundWorkEnabled: boolean;
  backgroundDeploymentId?: string;
  deploymentControlSecret?: string;
  spendExportToken?: string;
  buildSha?: string;
  monitorPollMs: number;
  skillSyncPollMs: number;
  monitorHeartbeatMs: number;
  signingSecret?: string;
  capabilitySecret?: string;
  capabilityTokenCompression?: boolean;
  portalIdentitySecret?: string;
  requireSignedPortalIdentity?: boolean;
  connectorSecretKey?: string;
  slackEventsPort?: number;
  runStore: "memory" | "postgres";
  seedSkills: boolean;
  skillsSeedDir: string;
  pluginSkillDirs: string[];
  deploymentLayerDir?: string;
  layerEnv?: Readonly<Record<string, string | undefined>>;
  filesDirectUploadsEnabled: boolean;
  s3Bucket?: string;
  s3Region?: string;
  deployGitDir: string;
  deployDialTimeoutMs: number;
  deepIdleMachineMs: number;
  devIdleMachineMs: number;
  cronFireConcurrency: number;
  memoryRecall: MemoryRecallMode;
  memoryCapture: MemoryCaptureMode;
  memoryCaptureQuietMs: number;
  memoryProviderConfig?: MemoryProviderConfig;
  workers: number;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  reaperIntervalMs: number;
  shutdownDrainMs: number;
  maxAttempts: number;
  maxClaims: number;
  processReaperIntervalMs: number;
  approvalSummaryTimeoutMs: number;
  turnLeaseWaitMs: number;
  securityScreenTimeoutMs: number;
  securityScreen: SecurityScreenMode;
  securityScreenProxy?: {
    provider: string;
    endpoint: string;
    token: string;
  };
  scratchExecEnabled: boolean;
  reachExecEnabled: boolean;
  eagerProvisionEnabled: boolean;
  sandbox: SandboxEnv;
  awsSandbox: AwsSandboxEnv;
  localSandbox: LocalSandboxEnv;
  spritesSandbox: SpritesSandboxEnv;
  smolmachinesSandbox: SmolmachinesSandboxEnv;
  agent37Sandbox: Agent37SandboxEnv;
  superserveSandbox: SuperserveSandboxEnv;
  e2bSandbox: E2bSandboxEnv;
  managedAgentsSandbox: ManagedAgentsSandboxEnv;
  modalSandbox: ModalSandboxEnv;
  porterSandbox: PorterSandboxEnv;
  porterDeploy: PorterDeployEnv;
  awsDeploy: AwsDeployEnv;
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
  if (config.anthropicApiKey ? config.anthropicApiKey.includes("sk-ant-oat") : config.claudeAuthCredential)
    return "anthropic";
  if (config.codexAuthCredential) return "openai";
  return undefined;
}

interface SandboxEnv {
  namePrefix?: string;
  egressProxyUrl?: string;
  snapshotIntervalSec?: number;
  cpus?: number;
  memoryMb?: number;
  diskGb?: number;
  idleParkSec?: number;
  maxLifetimeSec?: number;
}

function sandboxEnv(env: NodeJS.ProcessEnv): SandboxEnv {
  const num = (name: string): number | undefined => numEnvStrict(name, env[name]);
  const entries: Array<[keyof SandboxEnv, string | number | undefined]> = [
    ["namePrefix", env.SANDBOX_NAME_PREFIX?.trim() || undefined],
    ["egressProxyUrl", env.SANDBOX_EGRESS_PROXY_URL?.trim() || undefined],
    ["snapshotIntervalSec", num("SANDBOX_SNAPSHOT_INTERVAL_SEC")],
    ["cpus", num("SANDBOX_CPUS")],
    ["memoryMb", num("SANDBOX_MEMORY_MB")],
    ["diskGb", num("SANDBOX_DISK_GB")],
    ["idleParkSec", num("SANDBOX_IDLE_PARK_SEC")],
    ["maxLifetimeSec", num("SANDBOX_MAX_LIFETIME_SEC")],
  ];
  return Object.fromEntries(entries.filter(([, v]) => v !== undefined)) as SandboxEnv;
}

interface AwsSandboxEnv {
  region: string;
  profile?: string;
  imageIdentifier: string;
  imageVersion?: string;
  executionRoleArn?: string;
  ingressConnectorArns?: string[];
  egressConnectorArns?: string[];
  coreContainer?: string;
}

const csvList = (value: string | undefined): string[] | undefined => {
  const items = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
};

function awsSandboxEnv(env: NodeJS.ProcessEnv): AwsSandboxEnv {
  const ingress = csvList(env.AWS_SANDBOX_INGRESS_CONNECTORS);
  const egress = csvList(env.AWS_SANDBOX_EGRESS_CONNECTORS);
  return {
    region: env.AWS_SANDBOX_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-west-2",
    ...(env.AWS_SANDBOX_PROFILE ? { profile: env.AWS_SANDBOX_PROFILE } : {}),
    imageIdentifier: env.AWS_SANDBOX_IMAGE ?? "qm-microvm-sandbox",
    ...(env.AWS_SANDBOX_IMAGE_VERSION ? { imageVersion: env.AWS_SANDBOX_IMAGE_VERSION } : {}),
    ...(env.AWS_SANDBOX_EXEC_ROLE_ARN ? { executionRoleArn: env.AWS_SANDBOX_EXEC_ROLE_ARN } : {}),
    ...(ingress ? { ingressConnectorArns: ingress } : {}),
    ...(egress ? { egressConnectorArns: egress } : {}),
    ...(env.QM_CORE_CONTAINER ? { coreContainer: env.QM_CORE_CONTAINER } : {}),
  };
}

interface LocalSandboxEnv {
  image?: string;
  dockerBin?: string;
  coreContainer?: string;
}

function localSandboxEnv(env: NodeJS.ProcessEnv): LocalSandboxEnv {
  return {
    ...(env.LOCAL_SANDBOX_IMAGE ? { image: env.LOCAL_SANDBOX_IMAGE } : {}),
    ...(env.LOCAL_SANDBOX_DOCKER_BIN ? { dockerBin: env.LOCAL_SANDBOX_DOCKER_BIN } : {}),
  };
}

interface SpritesSandboxEnv {
  token?: string;
}

function spritesSandboxEnv(env: NodeJS.ProcessEnv): SpritesSandboxEnv {
  return env.SPRITES_TOKEN ? { token: env.SPRITES_TOKEN } : {};
}

interface E2bSandboxEnv {
  apiKey?: string;
  templateId?: string;
}

function e2bSandboxEnv(env: NodeJS.ProcessEnv): E2bSandboxEnv {
  return {
    ...(env.E2B_API_KEY ? { apiKey: env.E2B_API_KEY } : {}),
    ...(env.E2B_TEMPLATE_ID ? { templateId: env.E2B_TEMPLATE_ID } : {}),
  };
}

interface ManagedAgentsSandboxEnv {
  apiToken?: string;
  template?: string;
}

function managedAgentsSandboxEnv(env: NodeJS.ProcessEnv): ManagedAgentsSandboxEnv {
  return {
    ...(env.DO_AGENTS_API_TOKEN ? { apiToken: env.DO_AGENTS_API_TOKEN } : {}),
    ...(env.DO_AGENTS_TEMPLATE ? { template: env.DO_AGENTS_TEMPLATE } : {}),
  };
}

interface ModalSandboxEnv {
  tokenId?: string;
  tokenSecret?: string;
  appName?: string;
  environment?: string;
  image?: string;
}

function modalSandboxEnv(env: NodeJS.ProcessEnv): ModalSandboxEnv {
  return {
    ...(env.MODAL_TOKEN_ID ? { tokenId: env.MODAL_TOKEN_ID } : {}),
    ...(env.MODAL_TOKEN_SECRET ? { tokenSecret: env.MODAL_TOKEN_SECRET } : {}),
    ...(env.MODAL_APP_NAME ? { appName: env.MODAL_APP_NAME } : {}),
    ...(env.MODAL_ENVIRONMENT ? { environment: env.MODAL_ENVIRONMENT } : {}),
    ...(env.MODAL_IMAGE ? { image: env.MODAL_IMAGE } : {}),
  };
}

interface SmolmachinesSandboxEnv {
  token?: string;
}

function smolmachinesSandboxEnv(env: NodeJS.ProcessEnv): SmolmachinesSandboxEnv {
  return env.SMOLMACHINES_TOKEN ? { token: env.SMOLMACHINES_TOKEN } : {};
}

interface PorterSandboxEnv {
  token?: string;
  baseUrl?: string;
}

interface PorterDeployEnv {
  token?: string;
  baseUrl?: string;
  runnerImage?: string;
  appsDomain?: string;
  visibility?: "public" | "private" | "internal";
  namePrefix?: string;
}

function porterApiBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const deployProjectId = numEnvStrict("PORTER_DEPLOY_PROJECT_ID", env.PORTER_DEPLOY_PROJECT_ID);
  const deployClusterId = numEnvStrict("PORTER_DEPLOY_CLUSTER_ID", env.PORTER_DEPLOY_CLUSTER_ID);
  const derived =
    deployProjectId !== undefined && deployClusterId !== undefined
      ? `${(env.PORTER_DEPLOY_URL ?? "https://dashboard.porter.run").replace(/\/+$/, "")}/api/v2/alpha/projects/${deployProjectId}/clusters/${deployClusterId}`
      : undefined;
  return env.PORTER_SANDBOX_BASE_URL ?? derived;
}

const porterLocatorPresent = (env: NodeJS.ProcessEnv): boolean =>
  Boolean(porterApiBaseUrl(env) || env.PORTER_CLUSTER_ID || env.KUBERNETES_SERVICE_HOST);

function porterDeployVisibilityStrict(value: string | undefined): PorterDeployEnv["visibility"] {
  if (value === undefined || value.trim() === "") return undefined;
  const visibility = value.trim();
  if (visibility === "public" || visibility === "private" || visibility === "internal") return visibility;
  throw new Error(
    `PORTER_DEPLOY_VISIBILITY=${JSON.stringify(value)} is not recognized — use public, private, or internal, or unset it.`,
  );
}

function porterDeployEnv(env: NodeJS.ProcessEnv): PorterDeployEnv {
  const token = env.PORTER_DEPLOY_API_TOKEN;
  const baseUrl = porterApiBaseUrl(env);
  const visibility = porterDeployVisibilityStrict(env.PORTER_DEPLOY_VISIBILITY);
  if (visibility === "internal" && env.PORTER_DEPLOY_APPS_DOMAIN) {
    throw new Error(
      "PORTER_DEPLOY_VISIBILITY=internal serves apps inside the cluster only, so it takes no PORTER_DEPLOY_APPS_DOMAIN — unset one of them.",
    );
  }
  const namePrefix = env.SANDBOX_NAME_PREFIX?.trim();
  return {
    ...(token ? { token } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(env.PORTER_DEPLOY_RUNNER_IMAGE ? { runnerImage: env.PORTER_DEPLOY_RUNNER_IMAGE } : {}),
    ...(env.PORTER_DEPLOY_APPS_DOMAIN ? { appsDomain: env.PORTER_DEPLOY_APPS_DOMAIN } : {}),
    ...(visibility ? { visibility } : {}),
    ...(namePrefix ? { namePrefix } : {}),
  };
}

function porterSandboxEnv(env: NodeJS.ProcessEnv): PorterSandboxEnv {
  const token = env.PORTER_DEPLOY_API_TOKEN;
  const baseUrl = porterApiBaseUrl(env);
  return {
    ...(token ? { token } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

interface Agent37SandboxEnv {
  apiKey?: string;
}

function agent37SandboxEnv(env: NodeJS.ProcessEnv): Agent37SandboxEnv {
  return env.AGENT37_API_KEY ? { apiKey: env.AGENT37_API_KEY } : {};
}

interface SuperserveSandboxEnv {
  apiKey?: string;
  template?: string;
}

function superserveSandboxEnv(env: NodeJS.ProcessEnv): SuperserveSandboxEnv {
  return {
    ...(env.SUPERSERVE_API_KEY ? { apiKey: env.SUPERSERVE_API_KEY } : {}),
    ...(env.SUPERSERVE_TEMPLATE?.trim() ? { template: env.SUPERSERVE_TEMPLATE.trim() } : {}),
  };
}

interface AwsDeployEnv {
  region: string;
  profile?: string;
  imageIdentifier: string;
  imageVersion?: string;
  executionRoleArn?: string;
  ingressConnectorArns?: string[];
  egressConnectorArns?: string[];
  agentPort?: number;
  appPort?: number;
  maximumDurationInSeconds?: number;
  maxIdleDurationSeconds?: number;
  suspendedDurationSeconds?: number;
  appsDomain?: string;
  gateSecret?: string;
  tokenTtlMinutes?: number;
  dataBucket?: string;
  dataPrefix?: string;
  snapshotIntervalMs?: number;
  dataRoleArn?: string;
}

function deployAppsEnv(
  env: NodeJS.ProcessEnv,
  defaultLoginUrl: string | undefined,
): {
  deployAppsSessionSecret?: string;
  deployAppsLoginUrl?: string;
  deployAppsLoginPath?: "/auth/login" | "/auth/trusted/login";
} {
  const explicit = env.DEPLOY_APPS_SESSION_SECRET;
  const shared = env.PORTAL_SESSION_SECRET;
  const loginUrl = env.DEPLOY_APPS_LOGIN_URL ?? (explicit || shared ? defaultLoginUrl : undefined);
  if (loginUrl && !explicit && !shared) {
    throw new Error("DEPLOY_APPS_LOGIN_URL requires DEPLOY_APPS_SESSION_SECRET");
  }
  if (explicit && !loginUrl) {
    throw new Error("DEPLOY_APPS_SESSION_SECRET needs a sign-in address — set DEPLOY_APPS_LOGIN_URL or PUBLIC_WEB_URL");
  }
  const secret = explicit ?? (loginUrl ? shared : undefined);
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

function deployAppsDomainEnv(env: NodeJS.ProcessEnv, deployProvider: string): string | undefined {
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
  if (deployProvider === "porter" && env.PORTER_DEPLOY_APPS_DOMAIN) return env.PORTER_DEPLOY_APPS_DOMAIN;
  return env.AWS_DEPLOY_APPS_DOMAIN;
}

function awsDeployEnv(env: NodeJS.ProcessEnv): AwsDeployEnv {
  const csv = (s: string | undefined): string[] | undefined =>
    s
      ? s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined;
  const ingress = csv(env.AWS_DEPLOY_INGRESS_CONNECTORS);
  const egress = csv(env.AWS_DEPLOY_EGRESS_CONNECTORS);
  return {
    region: env.AWS_DEPLOY_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-west-2",
    ...(env.AWS_DEPLOY_PROFILE ? { profile: env.AWS_DEPLOY_PROFILE } : {}),
    imageIdentifier: env.AWS_DEPLOY_IMAGE ?? "qm-microvm-sandbox",
    ...(env.AWS_DEPLOY_IMAGE_VERSION ? { imageVersion: env.AWS_DEPLOY_IMAGE_VERSION } : {}),
    ...(env.AWS_DEPLOY_EXEC_ROLE_ARN ? { executionRoleArn: env.AWS_DEPLOY_EXEC_ROLE_ARN } : {}),
    ...(ingress ? { ingressConnectorArns: ingress } : {}),
    ...(egress ? { egressConnectorArns: egress } : {}),
    ...(numEnvStrict("AWS_DEPLOY_AGENT_PORT", env.AWS_DEPLOY_AGENT_PORT) !== undefined
      ? { agentPort: numEnvStrict("AWS_DEPLOY_AGENT_PORT", env.AWS_DEPLOY_AGENT_PORT) }
      : {}),
    ...(numEnvStrict("AWS_DEPLOY_APP_PORT", env.AWS_DEPLOY_APP_PORT) !== undefined
      ? { appPort: numEnvStrict("AWS_DEPLOY_APP_PORT", env.AWS_DEPLOY_APP_PORT) }
      : {}),
    ...(numEnvStrict("AWS_DEPLOY_MAX_DURATION_SEC", env.AWS_DEPLOY_MAX_DURATION_SEC) !== undefined
      ? { maximumDurationInSeconds: numEnvStrict("AWS_DEPLOY_MAX_DURATION_SEC", env.AWS_DEPLOY_MAX_DURATION_SEC) }
      : {}),
    ...(numEnvStrict("AWS_DEPLOY_MAX_IDLE_SEC", env.AWS_DEPLOY_MAX_IDLE_SEC) !== undefined
      ? { maxIdleDurationSeconds: numEnvStrict("AWS_DEPLOY_MAX_IDLE_SEC", env.AWS_DEPLOY_MAX_IDLE_SEC) }
      : {}),
    ...(numEnvStrict("AWS_DEPLOY_SUSPENDED_SEC", env.AWS_DEPLOY_SUSPENDED_SEC) !== undefined
      ? { suspendedDurationSeconds: numEnvStrict("AWS_DEPLOY_SUSPENDED_SEC", env.AWS_DEPLOY_SUSPENDED_SEC) }
      : {}),
    ...(env.AWS_DEPLOY_APPS_DOMAIN ? { appsDomain: env.AWS_DEPLOY_APPS_DOMAIN } : {}),
    ...(env.AWS_DEPLOY_GATE_SECRET ? { gateSecret: env.AWS_DEPLOY_GATE_SECRET } : {}),
    ...(numEnvStrict("AWS_DEPLOY_TOKEN_TTL_MIN", env.AWS_DEPLOY_TOKEN_TTL_MIN) !== undefined
      ? { tokenTtlMinutes: numEnvStrict("AWS_DEPLOY_TOKEN_TTL_MIN", env.AWS_DEPLOY_TOKEN_TTL_MIN) }
      : {}),
    ...(env.AWS_DEPLOY_DATA_BUCKET ? { dataBucket: env.AWS_DEPLOY_DATA_BUCKET } : {}),
    ...(env.AWS_DEPLOY_DATA_PREFIX ? { dataPrefix: env.AWS_DEPLOY_DATA_PREFIX } : {}),
    ...(env.AWS_DEPLOY_DATA_ROLE_ARN ? { dataRoleArn: env.AWS_DEPLOY_DATA_ROLE_ARN } : {}),
    ...(numEnvStrict("AWS_DEPLOY_SNAPSHOT_INTERVAL_MS", env.AWS_DEPLOY_SNAPSHOT_INTERVAL_MS) !== undefined
      ? {
          snapshotIntervalMs: Math.max(
            60_000,
            numEnvStrict("AWS_DEPLOY_SNAPSHOT_INTERVAL_MS", env.AWS_DEPLOY_SNAPSHOT_INTERVAL_MS)!,
          ),
        }
      : {}),
  };
}

const DEFAULT_ORG_ID = "default-org";

export function processOrgId(): string {
  return process.env.ORG_ID ?? DEFAULT_ORG_ID;
}

export const CONFIG_DEFAULTS = {
  port: 8080,
  rateLimitPerWindow: 60,
  rateLimitWindowMs: 60_000,
  budgetWindowMs: 86_400_000,
  execTimeoutDefaultSec: 120,
  execTimeoutMaxSec: 300,
  turnWallClockSec: 0,
  runMaxAgeMs: 24 * 60 * 60_000,
  backgroundJobTtlSec: 1800,
  backgroundJobTtlMaxSec: 3600,
  backgroundWorkEnabled: true,
  monitorPollMs: 10_000,
  skillSyncPollMs: 0,
  deployDialTimeoutMs: 20_000,
  deepIdleMachineMs: 3 * 24 * 60 * 60_000,
  devIdleMachineMs: 2 * 60 * 60_000,
  cronFireConcurrency: 4,
  monitorHeartbeatSec: 180,
  approvalSummaryTimeoutMs: 6_000,
  turnLeaseWaitMs: 5_000,
  securityScreenTimeoutMs: 15_000,
  workers: 16,
  leaseTtlMs: 120_000,
  heartbeatIntervalMs: 40_000,
  reaperIntervalMs: 15_000,
  shutdownDrainMs: 30_000,
  maxAttempts: 3,
  maxClaims: 8,
  processReaperIntervalMs: 30_000,
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

const QM_ROLES = ["api", "surfaces", "harness"] as const;
type QmRole = (typeof QM_ROLES)[number];

function rolesFromEnv(value: string | undefined): QmRole[] {
  if (value === undefined || value.trim() === "") return [...QM_ROLES];
  const roles = [
    ...new Set(
      value
        .split(",")
        .map((role) => role.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const unknown = roles.filter((role) => !(QM_ROLES as readonly string[]).includes(role));
  if (unknown.length || !roles.length)
    throw new Error(
      `QM_ROLES=${JSON.stringify(value)} must list one or more of ${QM_ROLES.join(", ")}, comma-separated.`,
    );
  return roles as QmRole[];
}

function backgroundWorkFor(roles: readonly QmRole[], env: NodeJS.ProcessEnv): boolean {
  if (roles.includes("surfaces") && !roles.includes("harness"))
    throw new Error(
      "QM_ROLES with surfaces needs harness too: Slack sending and context reads run in the process that runs turns.",
    );
  const explicit = boolEnvStrict("BACKGROUND_WORK_ENABLED", env.BACKGROUND_WORK_ENABLED);
  if (roles.includes("harness")) return explicit ?? CONFIG_DEFAULTS.backgroundWorkEnabled;
  if (explicit)
    throw new Error("BACKGROUND_WORK_ENABLED=1 needs the harness role; add harness to QM_ROLES or unset it.");
  return false;
}

function boolEnvStrict(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = boolEnv(value);
  if (parsed === undefined) {
    throw new Error(
      `${name}=${JSON.stringify(value)} is not a recognized boolean — use 1/true/yes/on or 0/false/no/off/none (case-insensitive), or unset it.`,
    );
  }
  return parsed;
}

function numEnvStrict(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = numEnv(value);
  if (parsed === undefined) {
    throw new Error(`${name}=${JSON.stringify(value)} is not a number — set a finite numeric value, or unset it.`);
  }
  return parsed;
}

function orgBrandingFromEnv(env: NodeJS.ProcessEnv): Config["brandingDefault"] {
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
    agent37: Boolean(config.agent37Sandbox?.apiKey),
    superserve: Boolean(config.superserveSandbox?.apiKey && config.superserveSandbox?.template),
    e2b: Boolean(config.e2bSandbox?.apiKey),
    "do-managed-agents": Boolean(config.managedAgentsSandbox?.apiToken),
    modal: Boolean(config.modalSandbox?.tokenId && config.modalSandbox?.tokenSecret),
    aws: Boolean(config.awsSandbox?.executionRoleArn),
    porter: Boolean(config.porterSandbox?.token),
  };
  const enabled = new Set<Config["sandboxBackend"]>([config.sandboxBackend]);
  for (const [name, on] of Object.entries(credentialed)) {
    if (on) enabled.add(name as Config["sandboxBackend"]);
  }
  return [...enabled];
}

function sandboxBackendEnvStrict(value: string | undefined, name = "SANDBOX_BACKEND"): Config["sandboxBackend"] {
  if (value === undefined || value.trim() === "") return "local";
  const backend = value.trim();
  if (
    backend === "aws" ||
    backend === "local" ||
    backend === "sprites" ||
    backend === "smolmachines" ||
    backend === "e2b" ||
    backend === "modal" ||
    backend === "agent37" ||
    backend === "superserve" ||
    backend === "do-managed-agents" ||
    backend === "porter"
  )
    return backend;
  throw new Error(
    `${name}=${JSON.stringify(value)} is not recognized — use aws, local, sprites, smolmachines, e2b, modal, porter, agent37, superserve, or do-managed-agents, or unset it.`,
  );
}

export function modelGatewayFromEnv(env: NodeJS.ProcessEnv): ModelGatewayTransportConfig | undefined {
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

function modelProviderEnvStrict(env: NodeJS.ProcessEnv): ModelProvider | undefined {
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

function resolveStoreKinds(env: NodeJS.ProcessEnv): Pick<Config, "runStore"> {
  for (const key of ["RUN_STORE", "ARTIFACT_STORE"] as const) {
    if (env[key] === "sqlite") {
      throw new Error(
        `${key}=sqlite is no longer supported — SQLite was removed. ` +
          `Set ${key === "ARTIFACT_STORE" ? "DATABASE_URL (Postgres)" : `${key}=postgres (with DATABASE_URL)`}.`,
      );
    }
  }
  const runStore = env.RUN_STORE === "memory" ? "memory" : "postgres";
  if (env.NODE_ENV === "production" && runStore === "memory") {
    throw new Error(
      "production requires a Postgres run store (got RUN_STORE=memory): in-memory runs are lost on restart and invisible to other instances.",
    );
  }
  return { runStore };
}

function loadDeploymentConfig(env: NodeJS.ProcessEnv): DeploymentConfig {
  const roles = rolesFromEnv(env.QM_ROLES);
  if (roles.length < QM_ROLES.length && env.BACKGROUND_DEPLOYMENT_ID)
    throw new Error("QM_ROLES cannot split roles while BACKGROUND_DEPLOYMENT_ID is set; unset one of them.");
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
  const codexAuthCredential = env.CODEX_AUTH_CREDENTIAL?.trim() || undefined;
  const claudeAuthCredential = env.CLAUDE_AUTH_CREDENTIAL?.trim() || undefined;
  const anthropicApiKey = env.ANTHROPIC_API_KEY;
  const deployAppsDomain = deployAppsDomainEnv(env, env.DEPLOY_PROVIDER ?? "docker");
  const missingSecrets = validateCoreSecretEnv(env);
  if (missingSecrets.length) {
    const described = missingSecrets.map((name) => {
      const reason = CORE_SECRET_SPECS.find((spec) => spec.name === name)?.reason;
      return reason ? `${name} (${reason})` : name;
    });
    throw new Error(`missing or insecure required core secrets: ${described.join(", ")}`);
  }
  const modelProvider = modelProviderEnvStrict(env);
  const { runStore } = resolveStoreKinds(env);
  const dataDir = resolve(env.DATA_DIR ?? "./data");
  const porterSandboxSelected = env.SANDBOX_BACKEND === "porter";
  if (env.DEPLOY_PROVIDER === "porter" && !env.PORTER_DEPLOY_APPS_DOMAIN && !env.DEPLOY_APPS_DOMAIN) {
    console.warn(
      "[config] DEPLOY_PROVIDER=porter without an apps domain — published apps are reachable signed-in at /d/<app>/ only; set DEPLOY_APPS_DOMAIN to a domain you control to serve each app on its own subdomain.",
    );
  }
  for (const [selected, label] of [
    [porterSandboxSelected, "SANDBOX_BACKEND=porter"],
    [env.DEPLOY_PROVIDER === "porter", "DEPLOY_PROVIDER=porter"],
  ] as const) {
    if (selected && !porterLocatorPresent(env)) {
      throw new Error(
        `${label} requires PORTER_DEPLOY_PROJECT_ID and PORTER_DEPLOY_CLUSTER_ID (or PORTER_SANDBOX_BASE_URL, or PORTER_CLUSTER_ID) to locate the Porter sandbox API.`,
      );
    }
  }
  if (env.NODE_ENV === "production" && !env.SANDBOX_BACKEND?.trim()) {
    throw new Error(
      "SANDBOX_BACKEND must be set explicitly in production — use sprites, smolmachines, e2b, modal, porter, agent37, superserve, do-managed-agents, aws, or local.",
    );
  }
  const sandboxBackend = sandboxBackendEnvStrict(env.SANDBOX_BACKEND);
  const legacySandboxScopeDefaults: LegacySandboxScopeDefaults = {};
  if (env.SANDBOX_SCOPE_BACKENDS) {
    const values: unknown = JSON.parse(env.SANDBOX_SCOPE_BACKENDS);
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw new Error("SANDBOX_SCOPE_BACKENDS must be an object of scope kinds and backend names");
    for (const [kind, value] of Object.entries(values)) {
      const parsed = parseScopeId(kind + ":scope").kind;
      if (!parsed || parsed !== kind || typeof value !== "string" || !value.trim())
        throw new Error("Invalid SANDBOX_SCOPE_BACKENDS entry: " + kind);
      legacySandboxScopeDefaults[parsed] = sandboxBackendEnvStrict(value, "SANDBOX_SCOPE_BACKENDS." + kind);
    }
  }
  const selectedBackend = env.SANDBOX_BACKEND?.trim();
  if (selectedBackend && selectedBackend !== "local" && !env.SANDBOX_EGRESS_PROXY_URL?.trim()) {
    console.warn(
      `[config] SANDBOX_BACKEND=${selectedBackend} without SANDBOX_EGRESS_PROXY_URL — sandboxes run with NO egress enforcement (fail-open); set SANDBOX_EGRESS_PROXY_URL to the public egress proxy to force sandbox traffic through it.`,
    );
  }
  const superserveSelected = sandboxBackend === "superserve";
  if (superserveSelected && !env.SUPERSERVE_TEMPLATE?.trim()) {
    throw new Error(
      "SANDBOX_BACKEND=superserve requires SUPERSERVE_TEMPLATE, the ready qm-agent-<release> template that carries the agent toolchain.",
    );
  }

  const ignoredPostureEnv = [
    "HARNESS_SECURITY_POSTURE",
    "HARNESS_SHARING_POSTURE",
    "SECURITY_SCREEN",
    "SECURITY_SCREEN_CLASSIFIER",
    "SECURITY_SCREEN_BACKEND",
    "SECURITY_SCREEN_ALL_POSTURES",
    "SECURITY_SCREEN_PROXY_ROLLOUT",
  ].filter((name) => env[name]?.trim());
  if (ignoredPostureEnv.length) {
    console.warn(
      `[config] ${ignoredPostureEnv.join(", ")} ${ignoredPostureEnv.length === 1 ? "is" : "are"} no longer read: the default security posture is ${DEFAULT_SECURITY_POSTURE}, the default sharing posture is ${DEFAULT_SHARING_POSTURE}, and screening observes. Remove the variables.`,
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
  const slackEventsPort =
    env.SLACK_EVENTS_MODE?.trim() === "http" ? numEnvStrict("SLACK_EVENTS_PORT", env.SLACK_EVENTS_PORT) : undefined;
  if (
    slackEventsPort !== undefined &&
    (!Number.isSafeInteger(slackEventsPort) || slackEventsPort <= 0 || slackEventsPort > 65_535)
  ) {
    throw new Error("SLACK_EVENTS_PORT must be an integer from 1 through 65535");
  }
  const memoryProviderConfig = parseMemoryProviderConfig(env.MEMORY_PROVIDER_CONFIG, env);
  const publicPort = numEnvStrict("PUBLIC_PORT", env.PUBLIC_PORT);
  return {
    suggestedActivitiesEnabled: boolEnvStrict("SUGGESTED_ACTIVITIES_ENABLED", env.SUGGESTED_ACTIVITIES_ENABLED) ?? true,
    ...(env.SUGGESTED_ACTIVITIES_CONTEXT
      ? { suggestedActivitiesContext: env.SUGGESTED_ACTIVITIES_CONTEXT.slice(0, 8000) }
      : {}),
    production: env.NODE_ENV === "production",
    multitenant: env.QM_MULTITENANT === "1",
    port: numEnvStrict("PORT", env.PORT) ?? CONFIG_DEFAULTS.port,
    ...(publicPort !== undefined ? { publicPort } : {}),
    dataDir,
    ...(env.POSTHOG_API_KEY?.trim()
      ? { productAnalytics: { apiKey: env.POSTHOG_API_KEY.trim(), host: env.POSTHOG_HOST?.trim() } }
      : {}),
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    ...(env.DATABASE_POOL_URL ? { databasePoolUrl: env.DATABASE_POOL_URL } : {}),
    ...(env.DATABASE_POOL_CA_CERT ? { databasePoolCaCert: env.DATABASE_POOL_CA_CERT } : {}),
    ...(env.DATABASE_POOL_MAX ? { databasePoolMax: numEnvStrict("DATABASE_POOL_MAX", env.DATABASE_POOL_MAX) } : {}),
    ...(env.DATABASE_DIRECT_POOL_MAX
      ? { databaseDirectPoolMax: numEnvStrict("DATABASE_DIRECT_POOL_MAX", env.DATABASE_DIRECT_POOL_MAX) }
      : {}),
    ...(env.DATABASE_CA_CERT ? { databaseCaCert: env.DATABASE_CA_CERT } : {}),
    ...(env.DATABASE_CA_CERT_FILE ? { databaseCaCertFile: env.DATABASE_CA_CERT_FILE } : {}),
    securityPosture: DEFAULT_SECURITY_POSTURE,
    sharingPosture: DEFAULT_SHARING_POSTURE,
    securityScreen: "observe",
    ...(hasProxyScreen
      ? { securityScreenProxy: { provider: proxyProvider!, endpoint: proxyEndpoint!, token: proxyToken! } }
      : {}),
    sandboxBackend,
    legacySandboxScopeDefaults,
    deployProvider,
    ...(env.PI_MODEL ? { modelId: env.PI_MODEL } : {}),
    ...(codexAuthCredential ? { codexAuthCredential } : {}),
    ...(claudeAuthCredential ? { claudeAuthCredential } : {}),
    ...(env.PI_DETECT_MODEL ? { detectModelId: env.PI_DETECT_MODEL } : {}),
    ...(env.PI_TITLE_MODEL ? { titleModelId: env.PI_TITLE_MODEL } : {}),
    ...(env.PI_JUDGE_MODEL ? { judgeModelId: env.PI_JUDGE_MODEL } : {}),
    ...(anthropicApiKey ? { anthropicApiKey } : {}),
    ...(env.OPENAI_API_KEY ? { openaiApiKey: env.OPENAI_API_KEY } : {}),
    ...(env.OPENROUTER_API_KEY ? { openrouterApiKey: env.OPENROUTER_API_KEY } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    ...(modelGateway ? { modelGateway } : {}),
    ...(env.RESEND_API_KEY?.trim() ? { resendApiKey: env.RESEND_API_KEY.trim() } : {}),
    ...(env.AUTH_EMAIL_FROM?.trim() ? { emailFrom: env.AUTH_EMAIL_FROM.trim() } : {}),
    piSystemCacheSplit: boolEnvStrict("PI_SYSTEM_CACHE_SPLIT", env.PI_SYSTEM_CACHE_SPLIT) ?? false,
    rateLimitPerWindow: CONFIG_DEFAULTS.rateLimitPerWindow,
    rateLimitWindowMs: CONFIG_DEFAULTS.rateLimitWindowMs,
    ...(numEnvStrict("BUDGET_USD_PER_WINDOW", env.BUDGET_USD_PER_WINDOW) !== undefined
      ? { budgetUsdPerWindow: numEnvStrict("BUDGET_USD_PER_WINDOW", env.BUDGET_USD_PER_WINDOW) }
      : {}),
    ...(numEnvStrict("ORG_BUDGET_USD_PER_WINDOW", env.ORG_BUDGET_USD_PER_WINDOW) !== undefined
      ? { orgBudgetUsdPerWindow: numEnvStrict("ORG_BUDGET_USD_PER_WINDOW", env.ORG_BUDGET_USD_PER_WINDOW) }
      : {}),
    budgetWindowMs: CONFIG_DEFAULTS.budgetWindowMs,
    execTimeoutDefaultMs: CONFIG_DEFAULTS.execTimeoutDefaultSec * 1000,
    execTimeoutMaxMs: CONFIG_DEFAULTS.execTimeoutMaxSec * 1000,
    turnWallClockMs: CONFIG_DEFAULTS.turnWallClockSec * 1000,
    runMaxAgeMs: CONFIG_DEFAULTS.runMaxAgeMs,
    runWaitMs: CONFIG_DEFAULTS.runMaxAgeMs + 60_000,
    backgroundJobTtlMs: CONFIG_DEFAULTS.backgroundJobTtlSec * 1000,
    backgroundJobTtlMaxMs: CONFIG_DEFAULTS.backgroundJobTtlMaxSec * 1000,
    roles,
    backgroundWorkEnabled: backgroundWorkFor(roles, env),
    ...(env.BACKGROUND_DEPLOYMENT_ID
      ? { backgroundDeploymentId: env.BACKGROUND_DEPLOYMENT_ID, deploymentControlSecret: env.DEPLOYMENT_CONTROL_SECRET }
      : {}),
    ...(env.SPEND_EXPORT_TOKEN ? { spendExportToken: env.SPEND_EXPORT_TOKEN } : {}),
    ...(env.GIT_SHA ? { buildSha: env.GIT_SHA } : {}),
    monitorPollMs: CONFIG_DEFAULTS.monitorPollMs,
    skillSyncPollMs: CONFIG_DEFAULTS.skillSyncPollMs,
    monitorHeartbeatMs: CONFIG_DEFAULTS.monitorHeartbeatSec * 1000,
    ...(env.CORE_SIGNING_SECRET ? { signingSecret: env.CORE_SIGNING_SECRET } : {}),
    ...((env.CAPABILITY_SECRET ?? env.CORE_SIGNING_SECRET)
      ? { capabilitySecret: env.CAPABILITY_SECRET ?? env.CORE_SIGNING_SECRET }
      : {}),
    ...((env.PORTAL_IDENTITY_SECRET ?? env.CORE_SIGNING_SECRET)
      ? { portalIdentitySecret: env.PORTAL_IDENTITY_SECRET ?? env.CORE_SIGNING_SECRET }
      : {}),
    capabilityTokenCompression:
      boolEnvStrict("CAPABILITY_TOKEN_COMPRESSION", env.CAPABILITY_TOKEN_COMPRESSION) ?? false,
    requireSignedPortalIdentity: env.REQUIRE_SIGNED_PORTAL_IDENTITY === "1",
    ...(env.CONNECTOR_SECRET_KEY ? { connectorSecretKey: env.CONNECTOR_SECRET_KEY } : {}),
    ...(slackEventsPort !== undefined ? { slackEventsPort } : {}),
    layerEnv: { ...env },
    slackContextSource: parseSlackContextSource(env.SLACK_CONTEXT_SOURCE),
    runStore,
    seedSkills: true,
    skillsSeedDir: resolve("./skills-seed"),
    pluginSkillDirs: defaultPluginSkillDirs(),
    ...(env.DEPLOYMENT_LAYER ? { deploymentLayerDir: resolve(env.DEPLOYMENT_LAYER) } : {}),
    memoryRecall: DEFAULT_MEMORY_POLICY.recall,
    memoryCapture: DEFAULT_MEMORY_POLICY.capture,
    memoryCaptureQuietMs: DEFAULT_CAPTURE_QUIET_MS,
    ...(memoryProviderConfig ? { memoryProviderConfig } : {}),
    filesDirectUploadsEnabled: boolEnvStrict("FILES_DIRECT_UPLOADS_ENABLED", env.FILES_DIRECT_UPLOADS_ENABLED) ?? false,
    ...(env.S3_BUCKET ? { s3Bucket: env.S3_BUCKET } : {}),
    ...(env.S3_REGION ? { s3Region: env.S3_REGION } : {}),
    deployGitDir: join(dataDir, "deploy-git"),
    deployDialTimeoutMs: CONFIG_DEFAULTS.deployDialTimeoutMs,
    deepIdleMachineMs: CONFIG_DEFAULTS.deepIdleMachineMs,
    devIdleMachineMs: CONFIG_DEFAULTS.devIdleMachineMs,
    cronFireConcurrency:
      numEnvStrict("CRON_FIRE_CONCURRENCY", env.CRON_FIRE_CONCURRENCY) ?? CONFIG_DEFAULTS.cronFireConcurrency,
    workers: numEnvStrict("WORKERS", env.WORKERS) ?? CONFIG_DEFAULTS.workers,
    leaseTtlMs: CONFIG_DEFAULTS.leaseTtlMs,
    heartbeatIntervalMs: CONFIG_DEFAULTS.heartbeatIntervalMs,
    reaperIntervalMs: CONFIG_DEFAULTS.reaperIntervalMs,
    shutdownDrainMs: numEnvStrict("SHUTDOWN_DRAIN_MS", env.SHUTDOWN_DRAIN_MS) ?? CONFIG_DEFAULTS.shutdownDrainMs,
    maxAttempts: CONFIG_DEFAULTS.maxAttempts,
    maxClaims: CONFIG_DEFAULTS.maxClaims,
    processReaperIntervalMs: CONFIG_DEFAULTS.processReaperIntervalMs,
    approvalSummaryTimeoutMs: CONFIG_DEFAULTS.approvalSummaryTimeoutMs,
    turnLeaseWaitMs: CONFIG_DEFAULTS.turnLeaseWaitMs,
    securityScreenTimeoutMs: CONFIG_DEFAULTS.securityScreenTimeoutMs,
    scratchExecEnabled: boolEnvStrict("EXECUTE_SCRATCH", env.EXECUTE_SCRATCH) ?? false,
    reachExecEnabled: boolEnvStrict("REACH_EXEC", env.REACH_EXEC) ?? false,
    eagerProvisionEnabled: boolEnvStrict("EAGER_PROVISION", env.EAGER_PROVISION) ?? true,
    sandbox: sandboxEnv(env),
    awsSandbox: awsSandboxEnv(env),
    localSandbox: localSandboxEnv(env),
    spritesSandbox: spritesSandboxEnv(env),
    smolmachinesSandbox: smolmachinesSandboxEnv(env),
    agent37Sandbox: agent37SandboxEnv(env),
    superserveSandbox: superserveSandboxEnv(env),
    porterSandbox: porterSandboxEnv(env),
    porterDeploy: porterDeployEnv(env),
    e2bSandbox: e2bSandboxEnv(env),
    managedAgentsSandbox: managedAgentsSandboxEnv(env),
    modalSandbox: modalSandboxEnv(env),
    awsDeploy: {
      ...awsDeployEnv(env),
      ...(env.DEPLOY_APPS_DOMAIN && deployAppsDomain && !env.AWS_DEPLOY_APPS_DOMAIN
        ? { appsDomain: deployAppsDomain }
        : {}),
    },
  };
}

function loadTenantConfig(env: NodeJS.ProcessEnv): TenantConfig {
  const publicApiUrl = env.PUBLIC_API_URL ?? env.AGENT_API_URL;
  const publicUrl = env.PUBLIC_WEB_URL || publicApiUrl;
  const deployAppsDomain = deployAppsDomainEnv(env, env.DEPLOY_PROVIDER ?? "docker");
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
    ...(env.PUBLIC_WEB_URL ? { publicWebUrl: env.PUBLIC_WEB_URL } : {}),
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
