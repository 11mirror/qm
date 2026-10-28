import { z } from "zod";

export type Env = Readonly<Record<string, string | undefined>>;
const ENV_NAME = "\u0000env\u0000";
export const raw = z.string().optional();
export const str = raw.transform((v) => v || undefined);
export const trimmed = raw.transform((v) => v?.trim() || undefined);
const csv = raw.transform((v) => {
  const items = (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
});
export const num = raw.transform((v, ctx) => {
  if (v === undefined || v.trim() === "") return undefined;
  const n = numEnv(v);
  if (n === undefined)
    ctx.addIssue({
      code: "custom",
      message: `${ENV_NAME}=${JSON.stringify(v)} is not a number — set a finite numeric value, or unset it.`,
    });
  return n;
});
export const flag = raw.transform((v, ctx) => {
  if (v === undefined || v.trim() === "") return undefined;
  const b = boolEnv(v);
  if (b === undefined)
    ctx.addIssue({
      code: "custom",
      message: `${ENV_NAME}=${JSON.stringify(v)} is not a recognized boolean — use 1/true/yes/on or 0/false/no/off/none (case-insensitive), or unset it.`,
    });
  return b;
});

export function readEnv<S extends z.ZodRawShape>(env: Env, shape: S): z.output<z.ZodObject<S>> {
  const parsed = z.object(shape).safeParse(env);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw new Error(issue.message.replaceAll(ENV_NAME, String(issue.path[0])));
}

export function defined<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as never;
}

export function sandboxEnv(env: Env) {
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

export function sandboxProvidersEnv(env: Env) {
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
    SUPERSERVE_API_KEY: str,
    SUPERSERVE_TEMPLATE: str,
    SUPERSERVE_BASE_URL: str,
  });
  return {
    superserveSandbox: defined({
      apiKey: e.SUPERSERVE_API_KEY,
      template: e.SUPERSERVE_TEMPLATE,
      baseUrl: e.SUPERSERVE_BASE_URL,
    }),
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

export function awsDeployEnv(env: Env, deployAppsDomain: string | undefined) {
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

export const porterLocatorPresent = (env: Env): boolean =>
  Boolean(porterApiBaseUrl(env) || env.PORTER_CLUSTER_ID || env.KUBERNETES_SERVICE_HOST);

const PORTER_VISIBILITIES = ["public", "private", "internal"] as const;

export function porterDeployEnv(env: Env) {
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
  });
}

export function deployAppsEnv(
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

export function deployAppsDomainEnv(env: Env): string | undefined {
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

export function flyDeployEnv(env: Env) {
  const e = readEnv(env, {
    FLY_DEPLOY_API_TOKEN: str,
    FLY_DEPLOY_APP_PREFIX: str,
    FLY_DEPLOY_BASE_IMAGE: str,
    FLY_ORG: str,
    FLY_DEPLOY_REGION: str,
    FLY_DEPLOY_SHARED_APP_NAME: str,
    FLY_DEPLOY_DATA_VOLUME_SIZE_GB: num,
    FLY_DEPLOY_SOCKS_PROXY_PORT: num,
  });
  return {
    token: e.FLY_DEPLOY_API_TOKEN ?? "",
    appPrefix: e.FLY_DEPLOY_APP_PREFIX ?? "",
    baseImage: e.FLY_DEPLOY_BASE_IMAGE ?? "",
    org: e.FLY_ORG ?? "",
    ...defined({
      region: e.FLY_DEPLOY_REGION,
      sharedAppName: e.FLY_DEPLOY_SHARED_APP_NAME,
      dataVolumeSizeGb: e.FLY_DEPLOY_DATA_VOLUME_SIZE_GB,
      socksProxyPort: e.FLY_DEPLOY_SOCKS_PROXY_PORT,
    }),
  };
}
