import { createDeployStore, type Deployment } from "../deploy/deploy-store.ts";
import type { DeployGitArchive } from "../deploy/deploy-git-store.ts";
import type { DeployProvider } from "../deploy/deploy-provider.ts";
import { createAwsDeployProvider, type StoredDeployBody } from "../deploy/aws-deploy-provider.ts";
import type { Config } from "../config.ts";
import { createDockerDeployProvider } from "../deploy/docker-deploy-provider.ts";
import { createPorterDeployProvider, type StoredPorterDeployBody } from "../deploy/porter-deploy-provider.ts";
import { createE2bDeployProvider, type StoredE2bDeployBody } from "../deploy/e2b-deploy-provider.ts";
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
  w: Pick<
    StoresModule,
    | "artifactMap"
    | "pgArtifactMap"
    | "advisoryLock"
    | "canReadScope"
    | "canWriteScope"
    | "featureFlags"
    | "identity"
    | "directory"
    | "managesArtifactHome"
  > &
    Pick<FilesModule, "s3Bytes" | "acl"> &
    Pick<SandboxBackendsModule, "sandboxOnError" | "e2bClient"> &
    Pick<OutboundModule, "outbound"> &
    Pick<RunsModule, "productAnalytics"> &
    Pick<DeploymentLayerModule, "auditLog"> &
    Pick<CredentialsModule, "serviceCreds"> & { config: Config },
) {
  const {
    artifactMap,
    pgArtifactMap,
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
    deployments: artifactMap<Deployment>("deployments"),
    pg: pgArtifactMap.pool,
    git: {
      repoRoot: config.deployGitDir,
      archiveStore: artifactMap<DeployGitArchive>("deploy_git_repos"),
      ...(config.s3Bucket ? { archiveBytes: s3Bytes(config.s3Bucket, "deploy-git/") } : {}),
    },
  });
  const buildAwsDeploy = (): DeployProvider =>
    createAwsDeployProvider({
      ...config.awsDeploy,
      advisoryLock,
      store: artifactMap<StoredDeployBody>("aws_deploy_bodies"),
      onError: sandboxOnError,
    });
  const buildDeployProvider: Record<Config["deployProvider"], () => DeployProvider> = {
    aws: buildAwsDeploy,
    docker: () => createDockerDeployProvider({ onError: sandboxOnError }),
    porter: () =>
      createPorterDeployProvider({
        ...config.porterDeploy,
        advisoryLock,
        store: artifactMap<StoredPorterDeployBody>("porter_deploy_bodies"),
        onError: sandboxOnError,
      }),
    e2b: () =>
      createE2bDeployProvider({
        client: e2bClient("apps"),
        ...(config.sandbox.namePrefix ? { namePrefix: config.sandbox.namePrefix } : {}),
        advisoryLock,
        store: artifactMap<StoredE2bDeployBody>("e2b_deploy_bodies"),
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
