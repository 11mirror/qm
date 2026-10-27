import type { Head } from "./late.ts";
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
import type { StoresModule } from "./stores.ts";
import type { FilesModule } from "./files.ts";
import type { SandboxBackendsModule } from "./sandbox-backends.ts";
import type { OutboundModule } from "./outbound.ts";
import type { RunsModule } from "./runs.ts";
import type { DeploymentLayerModule } from "./deployment-layer.ts";
import type { CredentialsModule } from "./credentials.ts";

export function buildDeploy(
  w: Head &
    StoresModule &
    FilesModule &
    SandboxBackendsModule &
    OutboundModule &
    RunsModule &
    DeploymentLayerModule &
    CredentialsModule,
) {
  const {
    databaseUrl,
    config,
    s3Bytes,
    advisoryLock,
    sandboxOnError,
    e2bClient,
    outbound,
    productAnalytics,
    auditLog,
    acl,
    canReadScope,
    canWriteScope,
    featureFlags,
    identity,
    directory,
    managesArtifactHome,
    serviceCreds,
  } = w;

  const deployStore = createDeployStore({
    databaseUrl,
    git: {
      repoRoot: config.deployGitDir,
      archiveStore: createDeployGitArchiveStore(databaseUrl),
      ...(config.s3Bucket ? { archiveBytes: s3Bytes(config.s3Bucket, "deploy-git/") } : {}),
    },
  });
  const buildAwsDeploy = (): DeployProvider =>
    createAwsDeployProvider({
      ...config.awsDeploy,
      advisoryLock,
      store: createDeployBodyStore(databaseUrl, AWS_DEPLOY_BODIES_MIGRATION),
      onError: sandboxOnError,
    });
  const buildDeployProvider: Record<Config["deployProvider"], () => DeployProvider> = {
    aws: buildAwsDeploy,
    docker: () => createDockerDeployProvider({ onError: sandboxOnError }),
    porter: () =>
      createPorterDeployProvider({
        ...config.porterDeploy,
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
  const deployProvider: DeployProvider = buildDeployProvider[config.deployProvider]();
  if (config.deployProvider === "aws" && !config.awsDeploy.dataBucket) {
    console.warn(
      "[wiring] aws deploy: no data bucket resolved (AWS_DEPLOY_DATA_BUCKET unset) — deployed apps have NO durable /data",
    );
  }
  const deployGitSecret = config.signingSecret;
  const deployGitBase = config.apiBaseUrl;
  const deployService = createDeployService({
    outbound,
    deployAppsDomain: config.awsDeploy.appsDomain,
    publicLinksAvailable: !!(config.awsDeploy.appsDomain && config.awsDeploy.gateSecret),
    publicWebUrl: config.publicWebUrl,
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
          config.emailAuthPrincipals?.includes(email) ||
          Boolean(config.emailAuthDomain && email.endsWith(`@${config.emailAuthDomain}`)) ||
          identity.externalMember(email) !== undefined)
      );
    },
    managesArtifactHome,
    ...(deployGitSecret && deployGitBase
      ? {
          deploymentEnv: async (deployment: Deployment): Promise<Record<string, string>> => {
            const env: Record<string, string> = {
              VIEWER_IDENTITY_KEY: viewerIdentityKey(deployGitSecret, deployment.id),
            };
            const orgScope = scopeId("org", config.orgId);
            const credentials = await deploymentCredentialSlugs(
              await serviceCreds.listServiceCredentials(orgScope),
              orgScope,
              acl,
            );
            if (credentials.length) {
              env.AGENT_API_URL = deployGitBase;
              env.AGENT_CREDENTIAL_TOKEN = await mintCapabilityToken(
                {
                  actorId: deployment.createdBy,
                  scopeId: personalScope(deployment.createdBy),
                  aud: CREDENTIAL_BROKER_AUD,
                  credentials,
                  deployment: deployment.id,
                  exp: Date.now() + DEPLOYMENT_CREDENTIAL_TTL_MS,
                },
                config.capabilitySecret ?? deployGitSecret,
                config.capabilityTokenCompression,
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
