import type { Head } from "./late.ts";
import { createSlackAccounts } from "../connectors/composio-links.ts";
import type { BuiltApp } from "../wiring.ts";
import { createSessionShareStore } from "../sessions/session-share.ts";
import type { ApiAppModule } from "./api-app.ts";
import type { StoresModule } from "./stores.ts";
import type { AppServicesModule } from "./app-services.ts";
import type { DeploymentLayerModule } from "./deployment-layer.ts";
import type { StartupModule } from "./startup.ts";
import type { RunsModule } from "./runs.ts";
import type { HarnessModule } from "./harness.ts";
import type { OrchestratorModule } from "./orchestrator.ts";
import type { BackgroundModule } from "./background.ts";
import type { CredentialsModule } from "./credentials.ts";
import type { ModelCredentialsModule } from "./model-credentials.ts";
import type { FilesModule } from "./files.ts";
import type { ModelKeysModule } from "./model-keys.ts";
import type { SchedulerModule } from "./scheduler.ts";
import type { TriggersModule } from "./triggers.ts";
import type { ReceiversModule } from "./receivers.ts";
import type { CronsModule } from "./crons.ts";
import type { RunStreamsModule } from "./run-streams.ts";
import type { WorkersModule } from "./workers.ts";
import type { MemoryModule } from "./memory.ts";
import type { OutboundModule } from "./outbound.ts";
import type { SlackCoreModule } from "./slack-core.ts";
import type { SandboxModule } from "./sandbox.ts";
import type { SessionSyscallsModule } from "./session-syscalls.ts";

type AssembleBuiltAppInputs = Head &
  ApiAppModule &
  StoresModule &
  AppServicesModule &
  DeploymentLayerModule &
  StartupModule &
  RunsModule &
  HarnessModule &
  OrchestratorModule &
  BackgroundModule &
  CredentialsModule &
  ModelCredentialsModule &
  FilesModule &
  ModelKeysModule &
  SchedulerModule &
  TriggersModule &
  ReceiversModule &
  CronsModule &
  RunStreamsModule &
  WorkersModule &
  MemoryModule &
  OutboundModule &
  SlackCoreModule &
  SandboxModule &
  SessionSyscallsModule;

export function assembleBuiltApp(w: AssembleBuiltAppInputs): BuiltApp {
  return { ...builtAppHead(w), ...builtAppTail(w) };
}

function builtAppHead(w: AssembleBuiltAppInputs) {
  const {
    app,
    pgPool,
    screenSecurity,
    deploymentLayer,
    deploymentLayerStore,
    brokeredTools,
    startOnce,
    sessions,
    runs,
    runSignals,
    sessionStateBus,
    ledgerEventBus,
    surfaceCache,
    runtime,
    configStore,
    connectorTokens,
    slackInstallation,
    resolveClient,
    consentLinks,
    oauthFlows,
    secretDrops,
    gatewayTransport,
    budget,
    resolveBrowserCompanyKeys,
    modelGateway,
    modelCredentials,
    userModelCredentials,
    refreshModels,
    customProviders,
    refreshCustomProviders,
    mcpServers,
    mcpToolService,
    acl,
    skills,
    skillBundles,
    skillFetcher,
    auditLog,
    scheduler,
    sweepAsks,
    inbox,
    webhookReceiver,
    jobs,
  } = w;
  return {
    app,
    checkReadiness: async (signal) => {
      await pgPool.q("SELECT 1", [], { signal });
    },
    ...(screenSecurity ? { screenSecurity } : {}),
    deploymentLayer,
    deploymentLayerStore,
    brokeredTools,
    start: () => startOnce().ready,
    sessions,
    runs,
    signals: runSignals,
    sessionStateBus,
    ledgerEventBus,
    surfaceCache,
    runtime,
    config: configStore,
    connectorTokens,
    slackInstallation,
    resolveClient,
    consentLinks,
    oauthFlows,
    secretDrops,
    modelGatewayTransport: gatewayTransport,
    ...(budget ? { budget } : {}),
    resolveBrowserCompanyKeys,
    modelGateway,
    modelCredentials,
    userModelCredentials,
    refreshModels,
    customProviders,
    refreshCustomProviders,
    mcpServers,
    mcpToolService,
    acl,
    skills,
    skillBundles,
    skillFetcher,
    auditLog,
    scheduler,
    sweepAsks,
    inbox,
    webhookReceiver,
    jobs,
  } satisfies Partial<BuiltApp>;
}

function builtAppTail(w: AssembleBuiltAppInputs) {
  const {
    admin,
    rateLimiter,
    errors,
    crons,
    credentialUsage,
    egressAudit,
    identity,
    principalLinks,
    composioReturns,
    workspace,
    memory,
    keychain,
    serviceCreds,
    outbound,
    keychainApprovals,
    askResolution,
    dropResolution,
    sandbox,
    sandboxResources,
    advisoryLock,
    blobTransfer,
    files,
    fileUploads,
    featureFlags,
    teams,
    decisions,
    replayDedupe,
    brokerSessions,
    directory,
    projects,
    environments,
    processes,
    appPageViews,
    monitors,
    browserSessionStore,
    ambientJudgments,
    ackEmojiPicks,
    channelPolicy,
    config,
    suggestedActivities,
    backgroundOwnership,
    uiState,
    byteStore,
    slackCore,
    chatSurfaces,
    databaseUrl,
  } = w;
  return {
    admin,
    rateLimiter,
    errors,
    crons,
    credentialUsage,
    egressAudit,
    identity,
    principalLinks,
    slackAccounts: createSlackAccounts(databaseUrl),
    composioReturns,
    workspace,
    memory,
    keychain,
    serviceCreds,
    outbound,
    keychainApprovals,
    fireAskResolution: askResolution,
    fireDropResolution: dropResolution,
    sandbox,
    sandboxResources,
    advisoryLock,
    blobTransfer,
    files,
    ...(fileUploads ? { fileUploads } : {}),
    featureFlags,
    teams,
    decisions,
    replayDedupe,
    brokerSessions,
    directory,
    projects,
    environments,
    ...(processes ? { processes } : {}),
    ...(appPageViews ? { appPageViews } : {}),
    monitors,
    browserSessionStore,
    ambientJudgments,
    ackEmojiPicks,
    channelPolicy,
    ...(config.suggestedActivitiesEnabled && (config.backgroundWorkEnabled || config.backgroundDeploymentId)
      ? { suggestedActivities }
      : {}),
    ...(backgroundOwnership ? { backgroundOwnership } : {}),
    uiState,
    sessionShares: createSessionShareStore(databaseUrl),
    sessionShareBytes: byteStore("session-shares/", "session-shares"),
    slackCore,
    chatSurfaces,
  } satisfies Partial<BuiltApp>;
}
