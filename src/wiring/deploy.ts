import { perTenant, tenant, tenantSettings } from "../tenant.ts";
import { createFlyDeployProvider } from "../deploy/fly-deploy-provider.ts";
import { flyDeployPorts } from "../deploy/fly-deploy-ports.ts";
import type { StoresModule } from "./stores.ts";
import type { FilesModule } from "./files.ts";
import type { SandboxModule } from "./sandbox.ts";
import type { OutboundModule } from "./outbound.ts";
import type { RunsModule } from "./runs.ts";
import type { DeploymentLayerModule } from "./deployment-layer.ts";
import type { CredentialsModule } from "./credentials.ts";
import type { Head } from "./late.ts";
import { tenantConfig } from "../tenants/tenant-config.ts";
import { createDeployStore, type Deployment } from "../deploy/deploy-store.ts";
import { createDeployGitArchiveStore } from "../deploy/deploy-git-store.ts";
import { createDeployBodyStore } from "../deploy/deploy-body-store.ts";
import type { DeployProvider } from "../deploy/deploy-provider.ts";
import { AWS_DEPLOY_BODIES_MIGRATION, createAwsDeployProvider } from "../deploy/aws-deploy-provider.ts";
import type { Config } from "../config.ts";
import { createDockerDeployProvider } from "../deploy/docker-deploy-provider.ts";
import { createPorterDeployProvider, PORTER_DEPLOY_BODIES_MIGRATION } from "../deploy/porter-deploy-provider.ts";
import { createE2bDeployProvider, E2B_DEPLOY_BODIES_MIGRATION } from "../deploy/e2b-deploy-provider.ts";
import { createDeployService } from "../deploy/deploy-service.ts";
import { join } from "node:path";
import { externalAppSharingAllowed } from "../feature-flags.ts";
import { viewerIdentityKey } from "../deploy/access-token.ts";
import { scopeId, personalScope } from "../types.ts";
import { deploymentCredentialSlugs } from "../deploy/deployment-credentials.ts";
import { mintCapabilityToken, CREDENTIAL_BROKER_AUD, DEPLOYMENT_CREDENTIAL_TTL_MS } from "../auth/capability-token.ts";

type DeployInputs = Pick<Head, "config"> & {
  stores: StoresModule;
  files: FilesModule;
  sandbox: SandboxModule;
  outbound: OutboundModule;
  runs: RunsModule;
  deploymentLayer: DeploymentLayerModule;
  credentials: CredentialsModule;
};

export function buildDeploy(deps: DeployInputs) {
  const {
    databaseUrl,
    advisoryLock,
    canReadScope,
    canWriteScope,
    featureFlags,
    identity,
    directory,
    managesArtifactHome,
  } = deps.stores;
  const { config } = deps;
  const { s3Bytes, acl } = deps.files;
  const { sandboxOnError, e2bClient } = deps.sandbox;
  const { outbound } = deps.outbound;
  const { productAnalytics } = deps.runs;
  const { auditLog } = deps.deploymentLayer;
  const { serviceCreds } = deps.credentials;

  const deployStore = createDeployStore({
    databaseUrl,
    git: {
      repoRoot: config.deployGitDir,
      archiveStore: createDeployGitArchiveStore(databaseUrl),
      ...(config.s3Bucket ? { archiveBytes: s3Bytes("deploy-git/") } : {}),
    },
  });
  const buildAwsDeploy = (): DeployProvider =>
    createAwsDeployProvider({
      ...config.awsDeploy,
      get appsDomain() {
        return tenantConfig(config).awsDeploy.appsDomain;
      },
      advisoryLock,
      store: createDeployBodyStore(databaseUrl, AWS_DEPLOY_BODIES_MIGRATION),
      onError: sandboxOnError,
    });
  const buildDeployProvider: Record<Config["deployProvider"], () => DeployProvider> = {
    fly: () => buildFlyDeploy(config, databaseUrl, sandboxOnError),
    aws: buildAwsDeploy,
    docker: () => createDockerDeployProvider({ onError: sandboxOnError }),
    porter: () =>
      createPorterDeployProvider({
        ...config.porterDeploy,
        ...(config.sandbox.namePrefix ? { namePrefix: config.sandbox.namePrefix } : {}),
        advisoryLock,
        store: createDeployBodyStore(databaseUrl, PORTER_DEPLOY_BODIES_MIGRATION),
        onError: sandboxOnError,
      }),
    e2b: () =>
      createE2bDeployProvider({
        client: e2bClient("apps"),
        ...(config.sandbox.namePrefix ? { namePrefix: config.sandbox.namePrefix } : {}),
        advisoryLock,
        store: createDeployBodyStore(databaseUrl, E2B_DEPLOY_BODIES_MIGRATION),
        onError: sandboxOnError,
      }),
  };
  const currentProvider = perTenant(() =>
    buildDeployProvider[tenantSettings().deployProvider ?? config.deployProvider](),
  );
  const deployProvider: DeployProvider = {
    get profile() {
      return currentProvider().profile;
    },
    apply: (...args) => currentProvider().apply(...args),
    resolveEndpoint: (...args) => currentProvider().resolveEndpoint(...args),
    destroy: (...args) => currentProvider().destroy(...args),
    logs: (...args) => currentProvider().logs(...args),
  };
  if (config.deployProvider === "aws" && !config.awsDeploy.dataBucket) {
    console.warn(
      "[wiring] aws deploy: no data bucket resolved (AWS_DEPLOY_DATA_BUCKET unset) — deployed apps have NO durable /data",
    );
  }
  const current = () => tenantConfig(config);
  const deployService = createDeployService({
    outbound,
    get deployAppsDomain() {
      return current().awsDeploy.appsDomain;
    },
    get publicLinksAvailable() {
      return !!(current().awsDeploy.appsDomain && config.awsDeploy.gateSecret);
    },
    get publicWebUrl() {
      return current().publicWebUrl;
    },
    appPublished: productAnalytics.appPublished,
    deployStore,
    provider: deployProvider,
    deployDir: join(config.dataDir, "deployments"),
    auditLog,
    acl,
    advisoryLock,
    canReadScope,
    canWriteScope,
    externalSharingAllowed: (ownerScopeId) => externalAppSharingAllowed(featureFlags, ownerScopeId),
    canManageEmail: async (email) => {
      await identity.refresh();
      return (
        identity.isInternal(identity.classify(email)) &&
        ((await directory.get(email))?.type === "internal" ||
          current().emailAuthPrincipals?.includes(email) ||
          Boolean(current().emailAuthDomain && email.endsWith(`@${current().emailAuthDomain}`)) ||
          identity.externalMember(email) !== undefined)
      );
    },
    managesArtifactHome,
    ...(config.signingSecret && config.apiBaseUrl
      ? {
          deploymentEnv: async (deployment: Deployment): Promise<Record<string, string>> => {
            const { signingSecret, apiBaseUrl, capabilitySecret, orgId } = current();
            const env: Record<string, string> = {
              VIEWER_IDENTITY_KEY: viewerIdentityKey(signingSecret!, deployment.id),
            };
            const orgScope = scopeId("org", orgId);
            const credentials = await deploymentCredentialSlugs(
              await serviceCreds.listServiceCredentials(orgScope),
              orgScope,
              acl,
            );
            if (credentials.length) {
              env.AGENT_API_URL = apiBaseUrl!;
              env.AGENT_CREDENTIAL_TOKEN = await mintCapabilityToken(
                {
                  actorId: deployment.createdBy,
                  scopeId: personalScope(deployment.createdBy),
                  aud: CREDENTIAL_BROKER_AUD,
                  credentials,
                  deployment: deployment.id,
                  exp: Date.now() + DEPLOYMENT_CREDENTIAL_TTL_MS,
                },
                capabilitySecret ?? signingSecret!,
              );
            }
            return env;
          },
        }
      : {}),
  });
  return { deployService };
}

export type DeployModule = ReturnType<typeof buildDeploy>;

function buildFlyDeploy(
  config: Config,
  databaseUrl: string,
  onError: Parameters<typeof createFlyDeployProvider>[0]["onError"],
) {
  const settings = tenantSettings();
  const port = config.flyDeploy.socksProxyPort;
  const { sharedAppName: deploymentApp, ...deployment } = config.flyDeploy;
  const sharedAppName = tenant().id ? settings.flySharedAppName : (settings.flySharedAppName ?? deploymentApp);
  const appPrefix = settings.flyAppPrefix ?? (tenant().id ? "" : deployment.appPrefix);
  if (!appPrefix && !sharedAppName) throw new Error("Fly tenant requires its own app prefix or shared app name");
  return createFlyDeployProvider({
    ...deployment,
    appPrefix,
    ...(sharedAppName ? { sharedAppName } : {}),
    ...(port ? { privateTransport: { ensure: async () => port } } : {}),
    portStore: flyDeployPorts(databaseUrl),
    ...(onError ? { onError } : {}),
  });
}
