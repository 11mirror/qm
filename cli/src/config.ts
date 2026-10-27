import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import { CliError, die, errMessage } from "./log.ts";
import {
  AUTH_BROKER_ENV_KEYS,
  SERVICE_NAMES,
  VIRTUAL_SERVICE_NAMES,
  isDeclaredService,
  isServiceName,
  runnableServices,
  type DeclaredServiceName,
  type ServiceName,
} from "./services.ts";
import { hostingProviderChoices, isTarget, type SandboxBackendId, type Target } from "./providers.ts";
import { envNum, isEnvVarName, isMissingOrPlaceholder } from "./util.ts";
import { validateAws, type AwsAccount } from "./config-aws.ts";
import {
  DNS_LABEL,
  isPlainObject,
  rejectRetiredAdminService,
  validatePlugins,
  validateSandbox,
  validateSecurityScreen,
  validateServiceMap,
  validateStringArray,
  validateStringMap,
} from "./config-validators.ts";

export const CONFIG_FILENAME = "qm.config.jsonc";

export const CONTRACT_VERSION = 1 as const;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const validOrgId = (value: string): boolean =>
  value.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value);

export type { Target } from "./providers.ts";

export interface PluginSecret {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PluginEntry {
  name: string;
  image?: string;
  env?: Record<string, string>;
  secrets?: PluginSecret[];
  coreAccess?: boolean;
}

export interface SandboxConfig {
  backend?: SandboxBackendId;
  image?: string;
  baseImage?: string;
}

export type SecurityScreenConfig = { provider: string; endpoint: string };

export interface AwsServiceConfig {
  ecrRepository: string;
  ecsService: string;
  cpu: number;
  memory: number;
  desiredCount?: number;
  architecture?: "arm64" | "amd64";
  taskRoleArn?: string;
  executionRoleArn?: string;
  assumeRoleArns?: string[];
  buildArgs?: Record<string, string>;
  dockerfile?: string;
  targetGroup?: string;
  publicPaths?: string[];
  logGroup?: string;
  stopTimeout?: number;
}

export const awsMicrovmExecRoleArn = (config: QmConfig, aws: AwsAccount): string =>
  config.env.core?.AWS_DEPLOY_EXEC_ROLE_ARN ?? `arn:aws:iam::${aws.accountId}:role/${aws.cluster}-microvm-exec`;

export interface AwsConfig {
  deploymentState?: { table: string; namespace: string };
  accountId: string;
  region: string;
  cluster: string;
  deployRoleArn: string;
  secretsPrefix: string;
  imageLabel: string;
  alb?: string;
  sharedAlb?: boolean;
  backgroundWorkControl?: boolean;
  rdsInstance?: string;
  dbInstanceClass?: string;
  predeployDbSnapshot?: boolean;
  dbRetentionMinDays?: number;
  deployBranch?: string;
  deployEnvironment?: string;
  objectStoreBucket?: string;
  networking: {
    cloudMapNamespace: string;
  };
  services: Record<string, AwsServiceConfig>;
}

export function awsWorkloadArchitecture(config: QmConfig, workload: string): "arm64" | "amd64" {
  const service = config.aws?.services[workload];
  if (!service) throw new CliError(`aws.services.${workload} is missing`);
  const externalImage =
    config.plugins.some((plugin) => plugin.name === workload && plugin.image) ||
    (isServiceName(workload) && Boolean(config.imageOverrides[workload]));
  if (!service.architecture && externalImage) {
    throw new CliError(
      `aws.services.${workload}.architecture is required because ${workload} uses an external prebuilt image`,
    );
  }
  return service.architecture ?? (isServiceName(workload) ? "amd64" : "arm64");
}

export const MODEL_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const MODEL_PROVIDER_KEYS: Readonly<Record<ModelProvider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export const isModelProvider = (value: unknown): value is ModelProvider =>
  typeof value === "string" && (MODEL_PROVIDERS as readonly string[]).includes(value);

export const EMAIL_TRANSPORTS = ["resend", "smtp"] as const;
export type EmailTransport = (typeof EMAIL_TRANSPORTS)[number];

export const isEmailTransport = (value: unknown): value is EmailTransport =>
  typeof value === "string" && (EMAIL_TRANSPORTS as readonly string[]).includes(value);

export interface QmConfig {
  contract: typeof CONTRACT_VERSION;
  orgId: string;
  publicUrl: string;
  apiUrl?: string;
  target: Target;
  model?: string;
  modelProvider?: ModelProvider;
  basePort?: number;
  services: DeclaredServiceName[];
  plugins: PluginEntry[];
  skills: string[];
  env: Partial<Record<DeclaredServiceName, Record<string, string>>>;
  secretEnv?: Partial<Record<DeclaredServiceName, Record<string, string>>>;
  securityScreen?: SecurityScreenConfig;
  imageOverrides: Partial<Record<ServiceName, string>>;
  sandbox?: SandboxConfig;
  botName?: string;
  orgName?: string;
  aws?: AwsConfig;
}

export function securityScreenEnv(config: Pick<QmConfig, "securityScreen">): Record<string, string> {
  const screen = config.securityScreen;
  if (!screen) return {};
  return {
    SECURITY_SCREEN_PROXY_PROVIDER: screen.provider,
    SECURITY_SCREEN_PROXY_ENDPOINT: screen.endpoint,
  };
}

export function configPathInDir(dir: string): string | undefined {
  const candidate = resolve(dir, CONFIG_FILENAME);
  return existsSync(candidate) ? candidate : undefined;
}

export function findConfigPath(start = process.cwd()): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = configPathInDir(dir);
    if (candidate) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadConfigInDir(dir: string, overrides?: { target?: Target }): { config: QmConfig; path: string } {
  const path = configPathInDir(dir);
  if (!path) {
    die(`no ${CONFIG_FILENAME} in ${resolve(dir)} — run \`qm init\` there, or pass --config <path>.`);
  }
  return loadConfigAt(path, overrides);
}

export const dockerBasePort = (config: QmConfig): number => envNum("QM_BASE_PORT", config.basePort ?? 8080);

export const isDigestPinned = (ref: string): boolean => /@sha256:[0-9a-f]{64}$/.test(ref);

export const effectiveSandboxBackend = (config: Pick<QmConfig, "env" | "sandbox">): string | undefined =>
  config.env.core?.SANDBOX_BACKEND?.trim() || config.sandbox?.backend;

export const localSandboxActive = (config: QmConfig): boolean =>
  config.target === "docker" && config.sandbox?.backend === "local";

export function sandboxCoreEnv(config: QmConfig): { env: Record<string, string> } {
  const env: Record<string, string> = {};
  const sb = config.sandbox;
  if (!sb) return { env };
  if (localSandboxActive(config)) {
    env.SANDBOX_BACKEND = "local";
    if (sb.image) env.LOCAL_SANDBOX_IMAGE = sb.image;
    return { env };
  }
  if (sb.backend && sb.backend !== "sprites") env.SANDBOX_BACKEND = sb.backend;
  return { env };
}

const parseConfigJson = (text: string): unknown => {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors[0]) throw new CliError(`${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
  return value;
};

const setStrings = (raw: string, path: string[], updates: Record<string, string>): string =>
  Object.entries(updates).reduce(
    (text, [key, value]) =>
      applyEdits(text, modify(text, [...path, key], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })),
    raw,
  );

export const updateConfigImageOverrides = (raw: string, updates: Record<string, string>): string =>
  setStrings(raw, ["imageOverrides"], updates);

export function updateConfigCoreEnv(raw: string, updates: Record<string, string>): string {
  const tree = parseTree(raw);
  const env = tree && findNodeAtLocation(tree, ["env"]);
  if (env?.type !== "object") throw new CliError('config has no top-level "env" object');
  if (findNodeAtLocation(env, ["core"])?.type !== "object") throw new CliError('config has no "env.core" object');
  return setStrings(raw, ["env", "core"], updates);
}

export function loadConfigAt(path: string, overrides?: { target?: Target }): { config: QmConfig; path: string } {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new CliError(`config file not found: ${path}`);
  let raw: unknown;
  try {
    raw = parseConfigJson(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new CliError(`${abs} is not valid JSON: ${errMessage(e)}`);
  }
  if (overrides?.target !== undefined) {
    if (!isPlainObject(raw)) throw new CliError(`${abs}: expected a JSON object`);
    raw = { ...raw, target: overrides.target };
  }
  return { config: validate(raw, abs), path: abs };
}

export function readConfigOrgId(path: string): string | undefined {
  try {
    const raw = parseConfigJson(readFileSync(path, "utf8"));
    const orgId = isPlainObject(raw) ? raw.orgId : undefined;
    return typeof orgId === "string" && validOrgId(orgId) ? orgId : undefined;
  } catch {
    return undefined;
  }
}

const VALID_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "contract",
  "orgId",
  "publicUrl",
  "apiUrl",
  "target",
  "model",
  "modelProvider",
  "basePort",
  "services",
  "plugins",
  "skills",
  "env",
  "secretEnv",
  "securityScreen",
  "imageOverrides",
  "sandbox",
  "botName",
  "orgName",
  "aws",
]);

function requireOriginUrl(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new CliError(`${field} must be a non-empty http(s) origin URL`);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
    if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password)
      throw new Error("origin");
    if (parsed.hostname.endsWith(".")) throw new Error("trailing dot");
  } catch {
    throw new CliError(
      `${field} must be a non-empty http(s) origin URL without credentials, a path, query, fragment, or trailing hostname dot`,
    );
  }
}

function validateServiceList(o: Record<string, unknown>, path: string): DeclaredServiceName[] {
  const servicesRaw = o["services"];
  if (!Array.isArray(servicesRaw)) throw new CliError(`${path}: "services" must be an array`);
  const services: DeclaredServiceName[] = [];
  for (const s of servicesRaw) {
    if (typeof s !== "string" || !isDeclaredService(s)) {
      throw new CliError(
        `${path}: unknown service ${JSON.stringify(s)} — valid: ${[...SERVICE_NAMES, ...VIRTUAL_SERVICE_NAMES].join(", ")}`,
      );
    }
    if (!services.includes(s)) services.push(s);
  }
  if (!services.includes("core")) throw new CliError(`${path}: "services" must include "core"`);
  const unfronted = (["web-ui", "auth"] as const).find((s) => services.includes(s));
  if (unfronted && !services.includes("portal")) {
    throw new CliError(`${path}: "${unfronted}" requires "portal" — core serves it only behind the portal`);
  }
  return services;
}

function rejectManagedEnv(
  path: string,
  env: Partial<Record<DeclaredServiceName, Record<string, string>>>,
  secretEnv: Partial<Record<DeclaredServiceName, Record<string, string>>>,
  securityScreen: SecurityScreenConfig | undefined,
  plugins: PluginEntry[],
): void {
  const managedSecurityScreenEnv = ["SECURITY_SCREEN_PROXY_PROVIDER", "SECURITY_SCREEN_PROXY_ENDPOINT"];
  for (const [service, values] of Object.entries(env)) {
    for (const name of [...managedSecurityScreenEnv, "SECURITY_SCREEN_PROXY_TOKEN"]) {
      if (values?.[name] !== undefined) {
        throw new CliError(`${path}: "env.${service}.${name}" is managed by securityScreen and cannot be overridden`);
      }
    }
  }
  for (const [service, values] of Object.entries(secretEnv)) {
    for (const name of managedSecurityScreenEnv) {
      if (values?.[name] !== undefined) {
        throw new CliError(
          `${path}: "secretEnv.${service}.${name}" is managed by securityScreen and cannot be overridden`,
        );
      }
    }
    if (service !== "core" && values?.SECURITY_SCREEN_PROXY_TOKEN !== undefined) {
      throw new CliError(`${path}: SECURITY_SCREEN_PROXY_TOKEN may be routed only to core`);
    }
  }
  if (securityScreen && secretEnv.core?.SECURITY_SCREEN_PROXY_TOKEN === undefined) {
    throw new CliError(`${path}: securityScreen requires secretEnv.core.SECURITY_SCREEN_PROXY_TOKEN`);
  }
  if (!securityScreen && secretEnv.core?.SECURITY_SCREEN_PROXY_TOKEN !== undefined) {
    throw new CliError(`${path}: secretEnv.core.SECURITY_SCREEN_PROXY_TOKEN requires securityScreen`);
  }
  for (const [field, map] of [
    ["env", env],
    ["secretEnv", secretEnv],
  ] as const) {
    for (const [service, values] of Object.entries(map)) {
      const managed = ["PORT", "PUBLIC_PORT"].find((name) => values?.[name] !== undefined);
      if (managed) {
        throw new CliError(
          `${path}: "${field}.${service}.${managed}" is managed by the deployment target and cannot be overridden`,
        );
      }
    }
  }
  for (const [i, plugin] of plugins.entries()) {
    if (plugin.env?.PORT !== undefined) {
      throw new CliError(
        `${path}: "plugins[${i}].env.PORT" is managed by the deployment target and cannot be overridden`,
      );
    }
  }
}

function validateAwsTarget(
  out: QmConfig,
  path: string,
  plugins: PluginEntry[],
  imageOverrides: Partial<Record<DeclaredServiceName, string>>,
  services: DeclaredServiceName[],
): void {
  validateAwsFrontDoor(out, path);
  if (
    out.env.core?.BACKGROUND_DEPLOYMENT_ID !== undefined ||
    out.secretEnv?.core?.BACKGROUND_DEPLOYMENT_ID !== undefined
  )
    throw new CliError(
      `${path}: BACKGROUND_DEPLOYMENT_ID is allocated by aws.backgroundWorkControl and cannot be configured directly`,
    );
  const externalImages = [
    ...plugins.filter((plugin) => plugin.image).map((plugin) => plugin.name),
    ...Object.keys(imageOverrides).filter((service) => services.includes(service as DeclaredServiceName)),
  ];
  for (const workload of new Set([...runnableServices(services), ...externalImages])) {
    if (out.aws?.services[workload]) awsWorkloadArchitecture(out, workload);
  }
}

function validate(raw: unknown, path: string): QmConfig {
  if (!isPlainObject(raw)) throw new CliError(`${path}: expected a JSON object`);
  const o = raw;

  for (const key of Object.keys(o)) {
    if (key !== "//" && !VALID_TOP_LEVEL_KEYS.has(key)) {
      throw new CliError(`${path}: unknown top-level field ${JSON.stringify(key)}`);
    }
  }

  const contract = o["contract"];
  if (contract !== CONTRACT_VERSION) {
    if (typeof contract === "number" && Number.isInteger(contract)) {
      throw new CliError(
        `${path}: unsupported contract major ${contract}; this CLI supports contract ${CONTRACT_VERSION}`,
      );
    }
    throw new CliError(`${path}: "contract" must be ${CONTRACT_VERSION}`);
  }

  const orgId = o["orgId"];
  if (typeof orgId !== "string" || !validOrgId(orgId)) {
    throw new CliError(`${path}: "orgId" must be a lowercase DNS label (a-z, 0-9, and hyphens between)`);
  }

  const publicUrl = o["publicUrl"];
  requireOriginUrl(publicUrl, `${path}: "publicUrl"`);

  const apiUrl = o["apiUrl"];
  if (apiUrl !== undefined) {
    requireOriginUrl(apiUrl, `${path}: "apiUrl"`);
  }

  rejectRetiredAdminService(o, path);

  const target = o["target"];
  if (!isTarget(target)) throw new CliError(`${path}: "target" must be ${hostingProviderChoices()}`);

  const services = validateServiceList(o, path);
  const plugins = validatePlugins(o["plugins"], path);
  const skills = validateStringArray(o["skills"], path, "skills");
  const env = validateServiceMap(o["env"], path, "env", (v, k) => validateStringMap(v, path, `env.${k}`));
  const secretEnv = validateServiceMap(o["secretEnv"], path, "secretEnv", (v, k) => {
    const entries = validateStringMap(v, path, `secretEnv.${k}`);
    for (const [envName, storeName] of Object.entries(entries)) {
      if (!isEnvVarName(envName))
        throw new CliError(`${path}: "secretEnv.${k}" key ${JSON.stringify(envName)} is not a valid env var name`);
      if (!isEnvVarName(storeName))
        throw new CliError(
          `${path}: "secretEnv.${k}.${envName}" must name a secret-store entry (a valid env-var-shaped name)`,
        );
    }
    return entries;
  });
  const securityScreen = validateSecurityScreen(o["securityScreen"], path);
  rejectManagedEnv(path, env, secretEnv, securityScreen, plugins);
  const imageOverrides = validateServiceMap(o["imageOverrides"], path, "imageOverrides", (v, k) => {
    if (typeof v !== "string") throw new CliError(`${path}: "imageOverrides.${k}" must be a string`);
    return v;
  });
  const sandbox = validateSandbox(o["sandbox"], path, target);
  const out: QmConfig = {
    contract,
    orgId,
    publicUrl: publicUrl.replace(/\/$/, ""),
    target,
    services,
    plugins,
    skills,
    env,
    imageOverrides,
  };
  if (Object.keys(secretEnv).length) out.secretEnv = secretEnv;
  if (securityScreen) out.securityScreen = securityScreen;
  if (typeof apiUrl === "string") out.apiUrl = apiUrl.replace(/\/$/, "");
  if (sandbox) out.sandbox = sandbox;
  if (typeof o["model"] === "string") out.model = o["model"];
  if (o["modelProvider"] !== undefined) {
    if (!isModelProvider(o["modelProvider"])) {
      throw new CliError(
        `${path}: "modelProvider" must be one of ${MODEL_PROVIDERS.join(", ")} — it selects which provider key the deployment requires; omit it to supply the base model key from the Admin page instead`,
      );
    }
    out.modelProvider = o["modelProvider"];
  }
  if (o["basePort"] !== undefined) {
    const bp = o["basePort"];
    if (typeof bp !== "number" || !Number.isInteger(bp) || bp <= 0) {
      throw new CliError(`${path}: "basePort" must be a positive integer (the docker host port base)`);
    }
    out.basePort = bp;
  }
  const identityName = (key: "botName" | "orgName", cap: number, what: string): string | undefined => {
    if (o[key] === undefined) return undefined;
    const name = typeof o[key] === "string" ? o[key].trim() : "";
    if (!name || name.length > cap || /[<>{}\u0000-\u001F\u007F-\u009F\u2028\u2029"\\]/.test(name)) {
      throw new CliError(
        `${path}: "${key}" must be a nonempty string of at most ${cap} characters without <>{}, quotes, backslashes, or control characters — ${what}`,
      );
    }
    return name;
  };
  const botName = identityName(
    "botName",
    31,
    'it names the bot everywhere users see it: the Slack apps (including the "<botName> SSO" sign-in app, which Slack caps at 35 characters), the prompt identity, and sign-in pages',
  );
  if (botName) out.botName = botName;
  const orgName = identityName("orgName", 40, "it is how the bot refers to your organization");
  if (orgName) out.orgName = orgName;
  if (o["aws"] !== undefined) {
    const configuredSecretNames = [
      ...plugins.flatMap((plugin) => (plugin.secrets ?? []).map((secret) => secret.name)),
      ...Object.values(secretEnv).flatMap((entries) => Object.values(entries ?? {})),
    ];
    out.aws = validateAws(o["aws"], path, runnableServices(services), configuredSecretNames);
  }
  if (target === "aws" && !out.aws) throw new CliError(`${path}: target "aws" requires an "aws" block`);
  validateModelProvider(out, path);
  validatePortalTrust(out, path);
  if (target === "aws") validateAwsTarget(out, path, plugins, imageOverrides, services);
  return out;
}

export function effectiveModelProvider(config: QmConfig): ModelProvider | undefined {
  const override = config.env.core?.MODEL_PROVIDER?.trim();
  return isModelProvider(override) ? override : config.modelProvider;
}

function validateModelProvider(config: QmConfig, path: string): void {
  const override = config.env.core?.MODEL_PROVIDER?.trim();
  if (override === "") delete config.env.core!.MODEL_PROVIDER;
  if (override !== undefined && override !== "" && !isModelProvider(override)) {
    throw new CliError(
      `${path}: env.core.MODEL_PROVIDER must be one of ${MODEL_PROVIDERS.join(", ")}, or unset to use "modelProvider"`,
    );
  }
}

const validEmailDomain = (value: string): boolean => {
  if (value.length > 253 || !value.includes(".")) return false;
  return value.split(".").every((label) => label.length > 0 && label.length <= 63 && DNS_LABEL.test(label));
};

const DERIVED_AUTH_ENV_KEYS = ["AUTH_ISSUER", "AUTH_CLIENT_ID", "AUTH_REDIRECT_URI"] as const;

function validateBrokerTrust(config: QmConfig, path: string, secrets?: ReadonlyMap<string, string>): void {
  const portalEnv = config.env.portal ?? {};
  const authEnv = config.env.auth ?? {};
  const overriddenPortal = AUTH_BROKER_ENV_KEYS.find((key) => portalEnv[key] !== undefined);
  if (overriddenPortal) {
    throw new CliError(
      `${path}: env.portal.${overriddenPortal} is derived from the built-in auth broker — remove it, or drop "auth" from "services" to use an external identity provider`,
    );
  }
  const overriddenAuth = DERIVED_AUTH_ENV_KEYS.find((key) => authEnv[key] !== undefined);
  if (overriddenAuth) {
    throw new CliError(`${path}: env.auth.${overriddenAuth} is derived from publicUrl and cannot be set`);
  }
  if (portalEnv.PORTAL_EXPECTED_TEAM_ID !== undefined) {
    throw new CliError(
      `${path}: env.portal.PORTAL_EXPECTED_TEAM_ID belongs to Slack sign-in and has no meaning with the built-in auth broker`,
    );
  }
  const transport = authEnv.AUTH_EMAIL_TRANSPORT?.trim();
  if (!isEmailTransport(transport)) {
    throw new CliError(
      `${path}: env.auth.AUTH_EMAIL_TRANSPORT must be ${EMAIL_TRANSPORTS.map((t) => JSON.stringify(t)).join(" or ")}`,
    );
  }
  const domain = authEnv.AUTH_ALLOWED_EMAIL_DOMAIN?.trim();
  if (
    authEnv.AUTH_ALLOWED_EMAIL_DOMAIN !== undefined &&
    (isMissingOrPlaceholder(domain) || !validEmailDomain(domain!))
  ) {
    throw new CliError(
      `${path}: env.auth.AUTH_ALLOWED_EMAIL_DOMAIN must be a valid, non-placeholder email domain when set`,
    );
  }
  if (!secrets || domain) return;
  const allowed = (secrets.get("AUTH_ALLOWED_EMAILS") ?? "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
  if (!allowed.length || allowed.some((email) => isMissingOrPlaceholder(email) || !EMAIL.test(email))) {
    throw new CliError(
      `${path}: the built-in auth broker requires env.auth.AUTH_ALLOWED_EMAIL_DOMAIN or a valid AUTH_ALLOWED_EMAILS in the target secret store — without one, anybody with an inbox could sign in`,
    );
  }
}

function isSlackIssuer(issuer: string): boolean {
  try {
    const host = new URL(issuer).hostname;
    return host === "slack.com" || host.endsWith(".slack.com");
  } catch {
    return false;
  }
}

export function validatePortalTrust(config: QmConfig, path = "config", secrets?: ReadonlyMap<string, string>): void {
  if (!config.services.includes("portal")) return;
  if (config.services.includes("auth")) return validateBrokerTrust(config, path, secrets);
  const env = config.env.portal ?? {};
  const issuer = env.OIDC_ISSUER?.trim() || "https://slack.com";
  const jwksUri = env.OIDC_JWKS_URI?.trim();
  if (!isSlackIssuer(issuer) && isMissingOrPlaceholder(jwksUri)) {
    throw new CliError(`${path}: portal requires env.portal.OIDC_JWKS_URI when using a non-Slack OIDC issuer`);
  }
  if (jwksUri !== undefined) {
    try {
      if (new URL(jwksUri).protocol !== "https:") throw new Error("protocol");
    } catch {
      throw new CliError(`${path}: env.portal.OIDC_JWKS_URI must be a non-placeholder HTTPS URL`);
    }
  }
  if (env.OIDC_CLIENT_ID !== undefined && isMissingOrPlaceholder(env.OIDC_CLIENT_ID)) {
    throw new CliError(`${path}: env.portal.OIDC_CLIENT_ID may not be a placeholder when configured`);
  }
  if (secrets && isMissingOrPlaceholder(env.OIDC_CLIENT_ID ?? secrets.get("OIDC_CLIENT_ID"))) {
    throw new CliError(
      `${path}: portal requires a non-placeholder OIDC_CLIENT_ID in env.portal or the target secret store`,
    );
  }
  const domain = env.OIDC_ALLOWED_EMAIL_DOMAIN?.trim();
  const allowedEmails =
    env.OIDC_ALLOWED_EMAILS?.split(",")
      .map((email) => email.trim())
      .filter(Boolean) ?? [];
  const configuredTeam = env.PORTAL_EXPECTED_TEAM_ID?.trim();
  if (domain !== undefined && (isMissingOrPlaceholder(domain) || !validEmailDomain(domain))) {
    throw new CliError(
      `${path}: env.portal.OIDC_ALLOWED_EMAIL_DOMAIN must be a valid, non-placeholder email domain when set`,
    );
  }
  if (allowedEmails.some((email) => isMissingOrPlaceholder(email) || !EMAIL.test(email))) {
    throw new CliError(`${path}: env.portal.OIDC_ALLOWED_EMAILS must contain valid, non-placeholder email addresses`);
  }
  if ((domain || allowedEmails.length) && (env.OIDC_PRINCIPAL_CLAIM ?? "email") !== "email") {
    throw new CliError(
      `${path}: portal requires env.portal.OIDC_PRINCIPAL_CLAIM=email when using an email trust boundary`,
    );
  }
  if (env.PORTAL_EXPECTED_TEAM_ID !== undefined && isMissingOrPlaceholder(configuredTeam)) {
    throw new CliError(
      `${path}: env.portal.PORTAL_EXPECTED_TEAM_ID is optional, but may not be a placeholder when configured`,
    );
  }
  if (
    secrets &&
    !domain &&
    !allowedEmails.length &&
    isMissingOrPlaceholder(configuredTeam ?? secrets.get("PORTAL_EXPECTED_TEAM_ID"))
  ) {
    throw new CliError(
      `${path}: portal requires OIDC_ALLOWED_EMAILS, OIDC_ALLOWED_EMAIL_DOMAIN, or a non-placeholder PORTAL_EXPECTED_TEAM_ID in env.portal or the target secret store`,
    );
  }
}

export function requiresAwsMicrovmImage(config: QmConfig): boolean {
  if (config.target !== "aws") return false;
  const core = config.env.core;
  return (core?.DEPLOY_PROVIDER?.trim() || "aws") === "aws";
}

function validateAwsFrontDoor(config: QmConfig, path: string): void {
  const hasPortal = config.services.includes("portal");
  const publicUrl = new URL(config.publicUrl);
  const protocol = publicUrl.protocol;
  if (config.apiUrl && new URL(config.apiUrl).protocol !== protocol) {
    throw new CliError(`${path}: AWS apiUrl must use the same protocol as publicUrl`);
  }
  const deployImage = config.env.core?.AWS_DEPLOY_IMAGE?.trim();
  if (
    (requiresAwsMicrovmImage(config) || Boolean(deployImage)) &&
    (isMissingOrPlaceholder(deployImage) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(deployImage!))
  ) {
    throw new CliError(
      `${path}: AWS requires env.core.AWS_DEPLOY_IMAGE to name a non-placeholder, stack-owned Lambda MicroVM image`,
    );
  }
  if (hasPortal && protocol !== "https:") {
    throw new CliError(`${path}: AWS portal requires an HTTPS publicUrl and ACM certificate`);
  }
  if (protocol !== "https:") {
    throw new CliError(
      `${path}: AWS requires an HTTPS publicUrl so sandbox capabilities never cross the Internet in cleartext`,
    );
  }
}
