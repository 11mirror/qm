import type { Head } from "./late.ts";
import { createAmbientCursors } from "../api/ambient-cursors.ts";
import { createContextRequests } from "../api/context-requests.ts";
import { createApp } from "../api/app.ts";
import { createPostgresResourceSearch } from "../search/resource-search.ts";
import { deriveConnectorKey } from "../connectors/connector-client-store.ts";
import type { StoresModule } from "./stores.ts";
import type { OrchestratorModule } from "./orchestrator.ts";
import type { RunsModule } from "./runs.ts";
import type { RunStreamsModule } from "./run-streams.ts";
import type { HarnessModule } from "./harness.ts";
import type { CredentialsModule } from "./credentials.ts";
import type { ModelCredentialsModule } from "./model-credentials.ts";
import type { ModelKeysModule } from "./model-keys.ts";
import type { FilesModule } from "./files.ts";
import type { AppServicesModule } from "./app-services.ts";
import type { DeploymentLayerModule } from "./deployment-layer.ts";
import type { CronsModule } from "./crons.ts";
import type { OutboundModule } from "./outbound.ts";
import type { DeployModule } from "./deploy.ts";
import type { SandboxModule } from "./sandbox.ts";

type BuildApiAppInputs = Head &
  StoresModule &
  OrchestratorModule &
  RunsModule &
  RunStreamsModule &
  HarnessModule &
  CredentialsModule &
  ModelCredentialsModule &
  ModelKeysModule &
  FilesModule &
  AppServicesModule &
  DeploymentLayerModule &
  CronsModule &
  OutboundModule &
  DeployModule &
  SandboxModule;

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
    pgPool,
    identity,
    sessions,
    orchestrator,
    runs,
    late,
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
    resourceSearch: createPostgresResourceSearch(pgPool),
    identity,
    ...(config.publicWebUrl ? { publicWebUrl: config.publicWebUrl } : {}),
    sessions,
    orchestrator,
    runs,
    startTurns: () => {
      if (!gates.inlineShutdown.signal.aborted) late.turnRunner.start();
    },
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
    contextRequestEvents,
    connectorSecretKey,
    surfaceCache,
    channelPolicy,
    harness,
    screenSecurity,
    ambientJudgments,
    ackEmojiPicks,
    judgeModelId,
    fallback,
    providerKeys,
    databaseUrl,
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
    contextRequests: createContextRequests(databaseUrl),
    contextRequestEvents,
    contextViewerTokenKey: deriveConnectorKey(connectorSecretKey, "context-viewer-tokens"),
    surfaceCache,
    channelPolicy,
    ...(harness.models.judge
      ? { ambientJudge: (s: string, pr: string, signal?: AbortSignal) => harness.models.judge!(s, pr, signal) }
      : {}),
    ...(screenSecurity ? { screenSecurity } : {}),
    ambientCursors: createAmbientCursors(databaseUrl),
    ambientJudgments,
    ackEmojiPicks,
    judgeModelId,
    runtimeFallback: fallback,
    providerKeys,
    runWaitMs: config.runWaitMs,
  } satisfies Partial<Parameters<typeof createApp>[0]>;
}

export type ApiAppModule = ReturnType<typeof buildApiApp>;
