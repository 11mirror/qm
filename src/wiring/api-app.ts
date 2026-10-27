import { createApp } from "../api/app.ts";
import { createPostgresResourceSearch } from "../search/resource-search.ts";
import type { SurfaceContextRequest } from "../types.ts";
import { deriveConnectorKey } from "../connectors/connector-client-store.ts";
import type { StoresModule } from "./stores.ts";
import type { Config } from "../config.ts";
import type { AdmittedWork } from "../util/admitted-work.ts";
import type { Gates, Late } from "./late.ts";
import type { OrchestratorModule } from "./orchestrator.ts";
import type { RunsModule } from "./runs.ts";
import type { RunStreamsModule } from "./run-streams.ts";
import type { HarnessModule } from "./harness.ts";
import type { CredentialsModule } from "./credentials.ts";
import type { ModelCredentialsModule } from "./model-credentials.ts";
import type { ModelKeysModule } from "./model-keys.ts";
import type { FilesModule } from "./files.ts";
import type { AppOverrides } from "../wiring.ts";
import type { AppServicesModule } from "./app-services.ts";
import type { DeploymentLayerModule } from "./deployment-layer.ts";
import type { CronsModule } from "./crons.ts";
import type { OutboundModule } from "./outbound.ts";
import type { DeployModule } from "./deploy.ts";
import type { SandboxModule } from "./sandbox.ts";

type BuildApiAppInputs = Pick<
  StoresModule,
  | "teams"
  | "pgArtifactMap"
  | "identity"
  | "sessions"
  | "admin"
  | "skills"
  | "skillPacks"
  | "skillBundles"
  | "advisoryLock"
  | "configStore"
  | "directory"
  | "projects"
  | "environments"
  | "artifactMap"
> &
  Pick<OrchestratorModule, "orchestrator" | "surfaceCache" | "channelPolicy"> &
  Pick<RunsModule, "runs" | "leaseTtlMs" | "maxAttempts" | "sessionStateBus" | "ledgerEventBus"> &
  Pick<RunStreamsModule, "turnStream" | "runStreamEvents" | "runActivity" | "processes" | "contextRequestEvents"> &
  Pick<HarnessModule, "runSignals" | "harness" | "judgeModelId" | "fallback"> &
  Pick<CredentialsModule, "modelGateway" | "userModelCredentials" | "mcpToolService"> &
  Pick<ModelCredentialsModule, "modelCredentials"> &
  Pick<ModelKeysModule, "refreshModels" | "customProviders" | "refreshCustomProviders"> &
  Pick<FilesModule, "mcpServers" | "acl" | "files"> &
  Pick<
    AppServicesModule,
    "skillFetcher" | "engaged" | "pokeReaper" | "screenSecurity" | "ambientJudgments" | "ackEmojiPicks" | "providerKeys"
  > &
  Pick<DeploymentLayerModule, "auditLog" | "deploymentLayer"> &
  Pick<CronsModule, "crons" | "webhooks" | "monitors" | "approvals"> &
  Pick<OutboundModule, "outbound"> &
  Pick<DeployModule, "deployService"> &
  Pick<SandboxModule, "sandbox"> & {
    config: Config;
    admittedWork: AdmittedWork;
    gates: Gates;
    overrides: AppOverrides;
    connectorSecretKey: string;
    late: Late;
  };

export function buildApiApp(w: BuildApiAppInputs) {
  const { late } = w;

  const app = createApp({
    ...appDepsHead(w),
    ...appDepsTail(w),
  });
  late.app = app;
  return { app };
}

function appDepsHead(w: BuildApiAppInputs) {
  const {
    teams,
    config,
    admittedWork,
    gates,
    pgArtifactMap,
    identity,
    sessions,
    orchestrator,
    runs,
    leaseTtlMs,
    maxAttempts,
    turnStream,
    runStreamEvents,
    runActivity,
    runSignals,
    modelGateway,
    modelCredentials,
    userModelCredentials,
    refreshModels,
    customProviders,
    refreshCustomProviders,
    mcpServers,
    mcpToolService,
    overrides,
    acl,
    admin,
    skills,
    skillPacks,
    skillFetcher,
    skillBundles,
    advisoryLock,
    auditLog,
    configStore,
    crons,
    webhooks,
    outbound,
    directory,
    projects,
    environments,
  } = w;
  return {
    teams,
    externalSlackPolicies: config.externalSlackPolicies,
    admittedWork,
    shutdown: () => gates.inlineShutdown.signal,
    resourceSearch: createPostgresResourceSearch(pgArtifactMap.pool),
    identity,
    ...(config.publicWebUrl ? { publicWebUrl: config.publicWebUrl } : {}),
    sessions,
    orchestrator,
    runs,
    leaseTtlMs,
    maxAttempts,
    turnStream,
    runStreamEvents,
    runActivity,
    signals: runSignals,
    modelGateway,
    modelCredentials,
    userModelCredentials,
    refreshModels,
    customProviders,
    refreshCustomProviders,
    mcpServers,
    mcpToolService,
    ...(overrides.modelCredentialFetch ? { modelCredentialFetch: overrides.modelCredentialFetch } : {}),
    acl,
    admin,
    skills,
    skillPacks,
    skillFetcher,
    skillBundles,
    advisoryLock,
    auditLog,
    config: configStore,
    crons,
    webhooks,
    outbound,
    directory,
    ...(config.emailAuthPrincipals?.length
      ? {
          emailAuthMembers: config.emailAuthPrincipals.map((principalId) => ({
            principalId,
            displayName: principalId,
            type: "internal" as const,
          })),
        }
      : {}),
    projects,
    environments,
  } satisfies Partial<Parameters<typeof createApp>[0]>;
}

function appDepsTail(w: BuildApiAppInputs) {
  const {
    config,
    deployService,
    deploymentLayer,
    processes,
    monitors,
    sandbox,
    files,
    approvals,
    sessionStateBus,
    ledgerEventBus,
    artifactMap,
    contextRequestEvents,
    connectorSecretKey,
    engaged,
    pokeReaper,
    surfaceCache,
    channelPolicy,
    harness,
    screenSecurity,
    ambientJudgments,
    ackEmojiPicks,
    judgeModelId,
    fallback,
    providerKeys,
  } = w;
  return {
    deploy: deployService,
    deployAppsDomain: config.awsDeploy.appsDomain,
    deploymentLayer,
    ...(processes ? { processes } : {}),
    monitors,
    sandbox,
    files,
    approvals,
    sessionStateBus,
    ledgerEventBus,
    contextRequests: artifactMap<SurfaceContextRequest>("context_requests"),
    contextRequestEvents,
    contextViewerTokenKey: deriveConnectorKey(connectorSecretKey, "context-viewer-tokens"),
    engaged,
    reaperPoke: pokeReaper,
    surfaceCache,
    channelPolicy,
    ...(harness.models.judge
      ? { ambientJudge: (s: string, pr: string, signal?: AbortSignal) => harness.models.judge!(s, pr, signal) }
      : {}),
    ...(screenSecurity ? { screenSecurity } : {}),
    ambientCursors: artifactMap<{ lastJudgedTs: string; lastJudgedAt?: number }>("ambient_cursors"),
    ambientJudgments,
    ackEmojiPicks,
    judgeModelId,
    runtimeFallback: fallback,
    providerKeys,
    runWaitMs: config.runWaitMs,
  } satisfies Partial<Parameters<typeof createApp>[0]>;
}

export type ApiAppModule = ReturnType<typeof buildApiApp>;
