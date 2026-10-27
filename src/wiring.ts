import { type TeamStore } from "./teams/teams.ts";
import { type DecisionStore } from "./decisions/store.ts";
import type { SlackSessionStatusState } from "./slack/session-status.ts";
import { availableRuntimeError } from "./api/runtime-config.ts";
import { createKeychainApprovals, type KeychainApprovals } from "./credentials/keychain-approval.ts";
import { flushErrorReporting } from "../plugins/chassis/src/error-reporting.ts";
import { createAdmittedWork } from "./util/admitted-work.ts";
import { runSessionSmoke } from "./deployment/postdeploy-smoke.ts";
import {
  createBackgroundOwnershipStore,
  type BackgroundOwnershipControl,
  type BackgroundOwnership,
} from "./runs/background-ownership.ts";
import { createPostgresNotifyBus } from "./persistence/postgres-notify-bus.ts";
import type { TaskAckState } from "./slack/task-ack.ts";
import { createSuggestedActivityService, type SuggestedActivityProfile } from "./suggestions/activities.ts";
import { createMemoryTidyService, type MemoryTidyProfile } from "./memory/tidy.ts";
import { createRuntimeService } from "./harness/runtime-control.ts";
import { deliverSubagentMail } from "./subagents/mail.ts";
import { sessionTreeWorking, stoppableAncestors } from "./subagents/tree.ts";
import { isSubagentThreadRef } from "./sessions/thread-ref.ts";
import { type BrokerSessionStore } from "./auth/broker-sessions.ts";
import { type DirectFileUploads } from "./files/direct-file-upload.ts";
import { type SandboxResources } from "./sandbox/sandbox-resources.ts";
import { type AwsRoleBroker } from "./auth/aws-role-broker.ts";
import type { SessionShare, SessionShareStore } from "./sessions/session-share.ts";
import { mkdirSync } from "node:fs";
import type { StagedEnvelope } from "./slack/envelope-staging.ts";
import type { HandledEvent } from "./slack/message-gating.ts";
import { randomUUID } from "node:crypto";
import { companySubscriptionAuth, configuredModel, providerKeysPresent, type Config } from "./config.ts";
import type { ServerDeps } from "./api/deps.ts";
import { type IdentityService } from "./identity/identity-service.ts";
import { type PrincipalLinkService } from "./identity/principal-links.ts";
import type { SlackAccountLink, ComposioReturn } from "./api/routes/composio.ts";
import { resendMailer } from "../plugins/chassis/src/resend.ts";
import { type ScopedConfigStore } from "./resolution/config-store.ts";
import { type AclStore } from "./acl/acl-store.ts";
import { type SkillStore } from "./skills/skill-store.ts";
import { type SkillBundleStore } from "./skills/skill-bundle-store.ts";
import { type SkillPackFetcher } from "./skills/pack-fetcher.ts";
import { type DurableMap } from "./persistence/durable-map.ts";
import type { UiStateStore } from "./surfaces/ui-state.ts";
import { slackUserClientFactory } from "./inbox/sources/slack.ts";
import { configurePgCaTrust, configurePgPooling } from "./persistence/pg-pool.ts";
import { type AdvisoryLock } from "./persistence/advisory-lock.ts";
import type { Session, TurnRequest } from "./types.ts";
import { scopeId } from "./types.ts";
import type { AuditLog } from "./audit/audit-log.ts";
import { type AppPageViewLog } from "./deploy/page-views.ts";
import type { RateLimiter } from "./ratelimit/rate-limiter.ts";
import { type BudgetTracker } from "./ratelimit/budget.ts";
import type { SecurityScreenProbe } from "./security/security-screener.ts";
import { type CronStore } from "./cron/cron-store.ts";
import { type LedgerEventBus } from "./inbox/events.ts";
import { createInboxSourceRefresh } from "./inbox/source-refresh.ts";
import { createInboxRealtime } from "./inbox/realtime.ts";
import { createInboxChat } from "./inbox/item-chat.ts";
import type { InboxServiceDeps } from "./api/routes/cron-items.ts";
import { type Outbound } from "./surfaces/outbound.ts";
import type { DirectoryStore } from "./directory/directory-store.ts";
import { type EnvironmentStore } from "./environments/environment-store.ts";
import { createScheduler, type Scheduler } from "./cron/scheduler.ts";
import { createJobWorker, type JobWorker } from "./jobs/job-worker.ts";
import { createWebhookReceiver, type WebhookReceiver } from "./webhooks/webhook-receiver.ts";
import { type WorkspaceStore } from "./workspace/workspace-store.ts";
import type { MemoryService } from "./memory/memory-service.ts";
import { type McpServerStore } from "./mcp/mcp-server-store.ts";
import { type McpToolService } from "./mcp/mcp-tool-service.ts";
import { type BlobTransferStore } from "./persistence/blob-transfer.ts";
import { type DurableByteStore } from "./files/durable-byte-store.ts";
import type { FileArtifactStore } from "./files/file-artifact-store.ts";
import { effectiveEgressEnforcement, type Sandbox } from "./sandbox/sandbox.ts";
import {
  type ConnectorTokenStore,
  type Keychain,
  type KeychainAsk,
  type KeychainGrant,
  type ServiceCredentialStore,
} from "./credentials/keychain.ts";
import {
  fireAskResolution,
  fireDropResolution,
  createAskExpirySweep,
  type DropResolution,
} from "./triggers/keychain-ask.ts";
import { type SecretDropStore } from "./credentials/secret-drop.ts";
import { type FeatureFlagStore } from "./feature-flags.ts";
import { type OAuthClientResolver } from "./connectors/oauth.ts";
import { type BrowserSessionStore } from "./connectors/browser-session-store.ts";
import type { CredentialUsageSink } from "./admin/credential-usage-sink.ts";
import type { EgressAuditSink } from "./admin/egress-audit-sink.ts";
import { type ConsentLinkStore } from "./connectors/consent-link.ts";
import { type OAuthFlowStore } from "./connectors/oauth-flow-store.ts";
import { type ModelGateway } from "./model/model-gateway.ts";
import { type ModelCredentialStore } from "./model/model-credential-store.ts";
import { type UserModelCredentialStore } from "./model/user-model-credential-store.ts";
import type { ModelGatewayTransportConfig } from "./model/provider-endpoints.ts";
import { type CustomProviderStore } from "./model/custom-provider-store.ts";
import { LLM_CAPTURE_RETENTION_MS, type SessionStore } from "./sessions/session-store.ts";
import { type ProviderKeys } from "./harness/pi-model-runtime.ts";
import type { Harness } from "./harness/harness.ts";
import { type SecurityScreener } from "./security/security-screener.ts";
import { createControlService } from "./api/control-service.ts";
import { TURN_QUEUES } from "./turns/absurd-schema.ts";
import { type RunSignalStore } from "./runs/run-signal-store.ts";
import { isTerminal, type Run, type RunStore } from "./runs/run-store.ts";
import { TURN_CANCEL_CHANNEL, TURN_READY_CHANNEL, TURN_YIELD_CHANNEL } from "./turns/turn-ledger.ts";
import { createTurnRunner, type TurnRunner } from "./turns/turn-runner.ts";
import { repairStaleTurns } from "./turns/turn-engine.ts";
import { createRunPreemption, createWorker, RUN_MAX_CLAIMS, type Worker } from "./runs/worker.ts";
import {
  createNoopInstanceRegistry,
  createPostgresInstanceRegistry,
  type InstanceRegistry,
} from "./runs/instance-registry.ts";
import { createDrainController, type DrainController } from "./runs/drain.ts";
import { createSweeper as createUntrackedSweeper } from "./util/sweeper.ts";
import { type ProcessRegistry } from "./processes/process-registry.ts";
import {
  createProcessReaper,
  createReaperKillHook,
  PROCESS_REAPER_INTERVAL_MS,
  type ProcessReaper,
} from "./processes/process-reaper.ts";
import { type MonitorStore } from "./monitors/monitor-store.ts";
import { createMonitorPoller, MONITOR_POLL_MS, type MonitorPoller } from "./monitors/monitor-poller.ts";
import { createSkillSyncEngine, type SkillSyncEngine } from "./skills/skill-sync-engine.ts";
import { supportsProcessSessions, type SandboxHandle } from "./sandbox/sandbox.ts";
import { finishProcessCredentials } from "./credentials/execute-files.ts";
import { type SessionStateBus } from "./runs/session-state-bus.ts";
import { type App } from "./api/app.ts";
import { createSlackCoreClient, type SlackCoreClient } from "./api/slack-core-client.ts";
import { type SurfaceRegistry } from "./surfaces/registry.ts";
import { createSurfaceContextPuller } from "./api/surface-context-puller.ts";
import { createWakeSweep, type WakeSweep } from "./wake/sweep.ts";
import { type SurfaceCache } from "./surface-cache/surface-cache.ts";
import { type ChannelPolicyStore } from "./surface-cache/channel-policy-store.ts";
import { type AmbientJudgmentStore } from "./surface-cache/ambient-judgment-store.ts";
import { type AckEmojiPickStore } from "./surface-cache/ack-emoji-pick-store.ts";
import { auxiliaryModelForProvider } from "./model/pi-models.ts";
import { type AdminService } from "./admin/admin-service.ts";
import { type ProjectStore } from "./projects/project-store.ts";
import { type ErrorLog } from "./admin/error-log.ts";
import { type ReplayDedupe } from "./auth/replay-dedupe.ts";
import { type BrokeredLayerTool, type DeploymentLayerRuntime } from "./deployment/load-layer.ts";
import { type DeploymentLayerStore } from "./deployment/deployment-layer-store.ts";
import { errMessage, reportFailureAs, swallowAs } from "./util/errors.ts";
import { sleep, withTimeout } from "./util/async.ts";
import { type SlackInstallationStore } from "./surfaces/slack-installation.ts";

import type { Gates, Late } from "./wiring/late.ts";

import { buildStores } from "./wiring/stores.ts";

import { buildModelCredentials } from "./wiring/model-credentials.ts";

import { buildDeploymentLayer } from "./wiring/deployment-layer.ts";

import { buildFiles } from "./wiring/files.ts";

import { buildSandboxBackends } from "./wiring/sandbox-backends.ts";

import { buildSandbox } from "./wiring/sandbox.ts";

import { buildCredentials } from "./wiring/credentials.ts";

import { buildModelKeys } from "./wiring/model-keys.ts";

import { buildHarness } from "./wiring/harness.ts";

import { buildStartup } from "./wiring/startup.ts";

import { buildMemory } from "./wiring/memory.ts";

import { buildRuns } from "./wiring/runs.ts";

import { buildRunStreams } from "./wiring/run-streams.ts";

import { buildOutbound } from "./wiring/outbound.ts";

import { buildDeploy } from "./wiring/deploy.ts";

import { registerLegacyMigrations } from "./wiring/legacy-migrations.ts";

import { buildCrons } from "./wiring/crons.ts";

import { buildSessionSyscalls } from "./wiring/session-syscalls.ts";

import { buildOrchestrator } from "./wiring/orchestrator.ts";

import { buildAppServices } from "./wiring/app-services.ts";

import { buildApiApp } from "./wiring/api-app.ts";

export interface Runtime {
  start(): void;
  startBackground(): void;
  stopBackgroundClaims(): Promise<void>;
  setBackgroundAdmission(canClaim: () => boolean, active: () => boolean): void;
  stopBackground(): Promise<void>;
  backgroundDrained(): Promise<void>;
  stop(): Promise<void>;
  releaseInFlightRuns(): Promise<void>;
}

export function stopWithBackstop(
  runtime: Pick<Runtime, "stop" | "releaseInFlightRuns">,
  shutdownDrainMs: number,
  label: string,
  beforeExit?: () => void,
): void {
  const hardExit = setTimeout(() => {
    console.error(`[${label}] drain overran; releasing in-flight leases before forced exit`);
    void Promise.race([runtime.releaseInFlightRuns(), sleep(3_000, { unref: true })]).finally(async () => {
      await flushErrorReporting();
      process.exit();
    });
  }, shutdownDrainMs + 5_000);
  hardExit.unref();
  void runtime.stop().then(
    async () => {
      await flushErrorReporting();
      clearTimeout(hardExit);
      beforeExit?.();
      process.exit();
    },
    (e: unknown) => {
      console.error(`[${label}] graceful stop failed: ${errMessage(e)}`);
      clearTimeout(hardExit);
      void Promise.race([runtime.releaseInFlightRuns(), sleep(3_000, { unref: true })]).finally(async () => {
        await flushErrorReporting();
        process.exit(1);
      });
    },
  );
}

export interface BuiltApp {
  checkReadiness: (signal: AbortSignal) => Promise<void>;
  /** Startup I/O (store hydration, deployment layer, skill seeding); buildApp itself only constructs. */
  start: () => Promise<void>;
  backgroundOwnership?: BackgroundOwnershipControl;
  suggestedActivities?: ReturnType<typeof createSuggestedActivityService>;
  app: App;
  screenSecurity?: SecurityScreenProbe;
  deploymentLayer: DeploymentLayerRuntime;
  brokeredTools: readonly BrokeredLayerTool[];
  deploymentLayerStore: DeploymentLayerStore;
  sessions: SessionStore;
  runs: RunStore;
  signals: RunSignalStore;
  sessionStateBus: SessionStateBus;
  ledgerEventBus: LedgerEventBus;
  surfaceCache: SurfaceCache;
  runtime: Runtime;
  config: ScopedConfigStore;
  connectorTokens: ConnectorTokenStore;
  slackInstallation: SlackInstallationStore;
  resolveClient: OAuthClientResolver;
  consentLinks: ConsentLinkStore;
  oauthFlows: OAuthFlowStore;
  secretDrops: SecretDropStore;
  modelGatewayTransport?: ModelGatewayTransportConfig;
  resolveBrowserCompanyKeys: (includeSubscription?: boolean) => Promise<ProviderKeys>;
  modelGateway: ModelGateway;
  modelCredentials: ModelCredentialStore;
  userModelCredentials: UserModelCredentialStore;
  refreshModels: () => Promise<void>;
  customProviders: CustomProviderStore;
  refreshCustomProviders: () => Promise<void>;
  mcpServers: McpServerStore;
  mcpToolService: McpToolService;
  acl: AclStore;
  skills: SkillStore;
  skillBundles: SkillBundleStore;
  skillFetcher: SkillPackFetcher;
  auditLog: AuditLog;
  scheduler: Scheduler;
  /** Resolve expired keychain asks now (the `cron:asks` job runs it every few seconds). */
  sweepAsks(now: number): Promise<void>;
  inbox: InboxServiceDeps;
  webhookReceiver: WebhookReceiver;
  jobs: JobWorker;
  admin: AdminService;
  rateLimiter: RateLimiter;
  budget?: BudgetTracker;
  errors: ErrorLog;
  crons: CronStore;
  credentialUsage: CredentialUsageSink;
  egressAudit: EgressAuditSink;
  identity: IdentityService;
  principalLinks: PrincipalLinkService;
  slackAccounts: DurableMap<SlackAccountLink>;
  composioReturns: DurableMap<ComposioReturn>;
  keychain: Keychain;
  serviceCreds: ServiceCredentialStore;
  outbound: Outbound;
  keychainApprovals: KeychainApprovals;
  fireAskResolution: (ask: KeychainAsk, grant?: KeychainGrant) => Promise<unknown>;
  fireDropResolution: (drop: DropResolution) => Promise<unknown>;
  workspace: WorkspaceStore;
  memory: MemoryService;
  sandbox: Sandbox;
  advisoryLock: AdvisoryLock;
  sandboxResources: SandboxResources;
  blobTransfer: BlobTransferStore;
  files: FileArtifactStore;
  fileUploads?: DirectFileUploads;
  featureFlags: FeatureFlagStore;
  teams: TeamStore;
  decisions: DecisionStore;
  replayDedupe: ReplayDedupe;
  brokerSessions: BrokerSessionStore;
  directory: DirectoryStore;
  projects: ProjectStore;
  environments: EnvironmentStore;
  processes?: ProcessRegistry;
  appPageViews?: AppPageViewLog;
  monitors: MonitorStore;
  browserSessionStore: BrowserSessionStore;
  monitorPoller?: MonitorPoller;
  ambientJudgments: AmbientJudgmentStore;
  ackEmojiPicks: AckEmojiPickStore;
  channelPolicy: ChannelPolicyStore;
  uiState: UiStateStore;
  sessionShares: SessionShareStore;
  sessionShareBytes: DurableByteStore;
  skillSyncEngine: SkillSyncEngine;
  slackCore: SlackCoreClient;
  chatSurfaces: SurfaceRegistry;
}

export interface AppOverrides {
  securityScreener?: SecurityScreener;
  credentialBrokers?: Record<string, AwsRoleBroker>;
  modelCredentialFetch?: typeof fetch;
  harness?: Harness;
  env?: NodeJS.ProcessEnv;
}

export function buildApp(config: Config, overrides: AppOverrides = {}): BuiltApp {
  // Switches the background lifecycle flips at runtime; modules read them through this object.
  const gates: Gates = {
    backgroundAdmission: () => !config.backgroundDeploymentId,
    backgroundActive: () => false,
    inlineShutdown: new AbortController(),
  };
  const admittedWork = createAdmittedWork({
    canStart: () => !config.backgroundDeploymentId || gates.backgroundAdmission(),
  });
  const createSweeper: typeof createUntrackedSweeper = (work, interval, options) =>
    createUntrackedSweeper(() => admittedWork.run(work), interval, options);
  // Values built later in buildApp that earlier modules reach through closures.
  const late = {} as Late;
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl) throw new Error("DATABASE_URL is required: QM keeps all state in Postgres");
  const connectorSecretKey = config.connectorSecretKey;
  if (!connectorSecretKey) throw new Error("CONNECTOR_SECRET_KEY is required");
  configurePgPooling({
    databaseUrl,
    // Tenancy sets qm.tenant_id per session, which a transaction-mode pooler would leak between clients.
    ...(config.databasePoolUrl && !config.multitenant ? { poolUrl: config.databasePoolUrl } : {}),
    ...(config.databasePoolCaCert ? { caCert: config.databasePoolCaCert } : {}),
    ...(config.databasePoolMax !== undefined ? { queryMax: config.databasePoolMax } : {}),
    ...(config.databaseDirectPoolMax !== undefined ? { sessionMax: config.databaseDirectPoolMax } : {}),
    tenancy: config.multitenant,
  });
  configurePgCaTrust({
    ...(config.databaseCaCert ? { cert: config.databaseCaCert } : {}),
    ...(config.databaseCaCertFile ? { certFile: config.databaseCaCertFile } : {}),
  });
  mkdirSync(config.dataDir, { recursive: true });
  const {
    artifactMap,
    managesArtifactHome,
    skills,
    skillBundles,
    advisoryLock,
    identity,
    configStore,
    pgArtifactMap,
    canUseSandboxScope,
    decisions,
    featureFlags,
    sessions,
    canReadScope,
    canWriteScope,
    directory,
    projects,
    currentScopeMembers,
    admin,
    teams,
    connectorStatusCache,
    isCurrentSharedScopeMember,
    environments,
    leaderLease,
    skillPacks,
    slackInstallation,
    principalLinks,
  } = buildStores({ databaseUrl, config, connectorSecretKey });
  const { gatewayCatalog, modelCredentials, gatewayTransport, directProviderAvailability } = buildModelCredentials({
    config,
    overrides,
    artifactMap,
    connectorSecretKey,
  });
  const {
    toolOutput,
    errors,
    blobTransfer,
    workspace,
    mcpServers,
    byteStore,
    s3Bytes,
    acl,
    resolution,
    files,
    rateLimiter,
    budget,
    fileUploads,
  } = buildFiles({ databaseUrl, managesArtifactHome, config, configStore, artifactMap, pgArtifactMap });
  const { deploymentLayerStore, installCatalogs, deploymentLayer, auditLog, brokeredTools, deploymentLayerChanged } =
    buildDeploymentLayer({ config, databaseUrl, artifactMap, skills, skillBundles, advisoryLock });
  const { sandboxBackends, sandboxOnError, e2bClient } = buildSandboxBackends({
    errors,
    config,
    advisoryLock,
    blobTransfer,
    deploymentLayer,
    artifactMap,
    pgArtifactMap,
    workspace,
  });
  const { sandbox, sandboxResources } = buildSandbox({
    artifactMap,
    sandboxBackends,
    config,
    advisoryLock,
    late,
    canUseSandboxScope,
    sandboxOnError,
  });
  const {
    warnShadowedBrokerCredentials,
    keychain,
    serviceCreds,
    userModelCredentials,
    connectorTokens,
    modelGateway,
    mcpToolService,
    resolveClient,
    consentLinks,
    oauthFlows,
    secretDrops,
    browserSessionStore,
  } = buildCredentials({
    overrides,
    configStore,
    config,
    connectorSecretKey,
    artifactMap,
    advisoryLock,
    mcpServers,
    auditLog,
  });
  const {
    resolveMemoryEmbedder,
    resolvePiProviderKeys,
    refreshModels,
    customProviders,
    refreshCustomProviders,
    resolveBrowserCompanyKeys,
  } = buildModelKeys({
    advisoryLock,
    artifactMap,
    connectorSecretKey,
    gatewayCatalog,
    modelCredentials,
    gatewayTransport,
    overrides,
    config,
    keychain,
  });
  const {
    runStoreKind,
    harness,
    runSignals,
    runtimeOrgScope,
    fallback,
    hydrateModelCatalog,
    orgBaseModelId,
    judgeModelId,
  } = buildHarness({
    config,
    databaseUrl,
    configStore,
    gatewayTransport,
    directProviderAvailability,
    overrides,
    resolvePiProviderKeys,
    decisions,
    serviceCreds,
    auditLog,
    refreshModels,
    modelCredentials,
  });
  const { skillsReady, startOnce } = buildStartup({
    deploymentLayerStore,
    config,
    installCatalogs,
    warnShadowedBrokerCredentials,
    identity,
    configStore,
  });
  const { memory, memoryStrategy, baseMemory, semanticMemory } = buildMemory({
    databaseUrl,
    configStore,
    resolveMemoryEmbedder,
    late,
    harness,
    config,
    artifactMap,
    errors,
  });
  const {
    runs,
    sessionStateBus,
    productAnalytics,
    ledgerEventBus,
    maxAttempts,
    ledger,
    leaseTtlMs,
    blockingApprovalSessions,
    turnLedger,
  } = buildRuns({ config, databaseUrl, runStoreKind, featureFlags, late, identity, sessions, advisoryLock });
  const {
    turnStream,
    runActivity,
    credentialUsage,
    processes,
    runStreamEvents,
    contextRequestEvents,
    stopStreamSync,
    egressAudit,
    replayDedupe,
    brokerSessions,
    appPageViews,
  } = buildRunStreams({ sandbox, databaseUrl, late, config, runs, runStoreKind });
  const { outbound, chatSurfaces, recentDmPosts, slackSurface, idempotency } = buildOutbound({
    artifactMap,
    sessions,
    sessionStateBus,
    config,
    late,
  });
  const { deployService } = buildDeploy({
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
  });
  const { securityScreener, approvals, monitors, crons, webhooks, inboxItems, recordInboxEvent } = buildCrons({
    artifactMap,
    ledgerEventBus,
    late,
    databaseUrl,
    config,
    outbound,
    chatSurfaces,
    overrides,
  });
  registerLegacyMigrations({ pgArtifactMap });
  const { uiState, sessionSyscalls, layerBrokerFor, sessionMailbox, prepareSessionRequest } = buildSessionSyscalls({
    config,
    overrides,
    resolution,
    canWriteScope,
    projects,
    currentScopeMembers,
    artifactMap,
    databaseUrl,
    featureFlags,
    sessions,
    runs,
    runSignals,
    maxAttempts,
    advisoryLock,
    late,
    configStore,
    runtimeOrgScope,
    fallback,
    hydrateModelCatalog,
  });
  const { orchestrator, surfaceCache, channelPolicy, orchestratorDeps } = buildOrchestrator({
    databaseUrl,
    chatSurfaces,
    uiState,
    late,
    auditLog,
    sessionStateBus,
    config,
    sessionSyscalls,
    refreshModels,
    identity,
    resolution,
    configStore,
    userModelCredentials,
    sessions,
    workspace,
    files,
    toolOutput,
    sandbox,
    sandboxResources,
    connectorTokens,
    modelGateway,
    rateLimiter,
    budget,
    harness,
    memory,
    deployService,
    acl,
    admin,
    mcpToolService,
    securityScreener,
    gatewayTransport,
    memoryStrategy,
    skills,
    skillBundles,
    skillsReady,
    advisoryLock,
    errors,
    ledger,
    runSignals,
    turnStream,
    runActivity,
    runs,
    blobTransfer,
    featureFlags,
    teams,
    credentialUsage,
    connectorStatusCache,
    resolveClient,
    keychain,
    serviceCreds,
    outbound,
    recentDmPosts,
    approvals,
    artifactMap,
    processes,
    monitors,
    crons,
    webhooks,
    orgBaseModelId,
    fallback,
    directory,
    isCurrentSharedScopeMember,
    projects,
    environments,
    brokeredTools,
    deploymentLayer,
    layerBrokerFor,
  });
  const {
    skillFetcher,
    engaged,
    pokeReaper,
    screenSecurity,
    ambientJudgments,
    ackEmojiPicks,
    providerKeys,
    runResultRecovery,
    reaper,
  } = buildAppServices({
    config,
    runs,
    outbound,
    sessions,
    chatSurfaces,
    serviceCreds,
    keychain,
    leaderLease,
    errors,
    databaseUrl,
    directProviderAvailability,
    harness,
    modelGateway,
    budget,
  });
  const { app } = buildApiApp({
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
    late,
  });
  const inboxRealtime = createInboxRealtime({
    crons,
    items: inboxItems,
    record: recordInboxEvent,
  });
  const keychainApprovals = createKeychainApprovals({
    keychain,
    app,
    identity,
    sessions,
    audit: auditLog,
    outbound,
    resume: (ask, grant) => askResolution(ask, grant),
  });
  const slackHandledEvents = artifactMap<HandledEvent>("slack_handled_events");
  const slackCore = createSlackCoreClient({
    identity,
    memory,
    ...(keychainApprovals ? { keychainApprovals } : {}),
    surfaceCache,
    taskAcknowledgements: artifactMap<TaskAckState>("slack_task_acknowledgements"),
    sessionStatus: artifactMap<SlackSessionStatusState>("slack_session_status"),
    statusActivity: { processes, monitors, sessions, publicWebUrl: config.publicWebUrl },
    featureFlags,
    inboxEvent: (event) => inboxRealtime.onConversationEvent(event),
    app,
    leaderLease,
    stagedEnvelopes: artifactMap<StagedEnvelope>("slack_staged_envelopes"),
    handledEvents: slackHandledEvents,
    config: configStore,
    runtimeFallback: fallback,
    blobTransfer,
    slack: slackSurface.slack,
    errors,
    runs,
    turnStream,
    ackPicks: ackEmojiPicks,
    ackModelId: () => auxiliaryModelForProvider("anthropic"),
    ...(config.brandingDefault ? { brandingDefault: config.brandingDefault } : {}),
    ...(harness.models.pickAckEmoji ? { pickAckEmoji: (t, c) => harness.models.pickAckEmoji!(t, c) } : {}),
  });
  runs.onTerminal((run) => {
    void runs
      .activeForThread(run.sessionId)
      .then((live) => {
        if (!live) engaged.settle(run.sessionId);
      })
      .catch(swallowAs("wake: settle on terminal", undefined));
  });
  runs.onTerminal((run) => {
    void app.replayOrphanedRunSignals(run.id).catch(swallowAs("wake: orphaned-signal replay", undefined));
  });
  runs.onTerminal((run) => {
    void (async () => {
      const session = await sessions.getByThread(run.sessionId);
      const at = run.finishedAt ?? Date.now();
      if (!session) {
        if (!(await runs.activeForThread(run.sessionId)))
          sessionStateBus.emit({ threadRef: run.sessionId, state: "idle", at });
        return;
      }
      const settle = async (target: Session): Promise<boolean> => {
        if (await runs.activeForThread(target.threadRef)) return false;
        const waiting = (await blockingApprovalSessions([target.id])).has(target.id);
        if (!waiting && (await sessionTreeWorking(sessions, runs, target))) return false;
        const participants = await sessions.participantsOf(target.id);
        sessionStateBus.emit({
          threadRef: target.threadRef,
          sessionId: target.id,
          state: waiting ? "awaiting_approval" : "idle",
          at,
          ...(participants.length ? { participants } : {}),
        });
        return true;
      };
      if (!(await settle(session))) return;
      for (const ancestor of await stoppableAncestors(sessions, session)) if (!(await settle(ancestor))) return;
    })().catch(swallowAs("session-state: terminal emit", undefined));
  });
  const returnSessionRun = (run: Run) =>
    advisoryLock
      .withLock("session-tree-admission", async () => {
        const settled = await deliverSubagentMail(
          {
            sessions,
            runs,
            maxAttempts,
            mailbox: sessionMailbox,
            prepareRequest: prepareSessionRequest,
            delegationEnabled: (actorId) => featureFlags.enabled("responsive_spine", scopeId("personal", actorId)),
            outbound,
            signals: runSignals,
          },
          run,
        );
        if (settled) await runs.markReturned(run.id);
      })
      .catch(async (error: unknown) => {
        await runs.deferReturn(run.id, 60_000);
        throw error;
      });
  runs.onTerminal((run) => {
    if (isSubagentThreadRef(run.sessionId)) void returnSessionRun(run).catch(swallowAs("sessions: return", undefined));
  });
  const sweepSessionReturns = async () => {
    let afterId: string | undefined;
    for (;;) {
      const batch = await runs.pendingReturns(100, afterId);
      if (!batch.length) return;
      for (const run of batch) await returnSessionRun(run).catch(swallowAs("sessions: recover return", undefined));
      afterId = batch.at(-1)!.id;
    }
  };
  const wakeSweep: WakeSweep = createWakeSweep(
    {
      async engagedSessions() {
        return engaged.list();
      },
      async sweepSession(threadRef) {
        const live = await runs.activeForThread(threadRef);
        if (!live) {
          pokeReaper();
          engaged.settle(threadRef);
          return 1;
        }
        return 0;
      },
    },
    { intervalMs: config.reaperIntervalMs, leaderLease },
  );
  orchestratorDeps.surfaceContext = createSurfaceContextPuller(app, {
    searchToken: async (source, viewer) =>
      source === "slack" && viewer
        ? ((await keychain.connectorAccessToken("slack.com", viewer, "personal")) ??
          (await keychain.connectorAccessToken("slack.com", viewer)) ??
          keychain.connectorAccessToken("slack.com", viewer, "company"))
        : null,
  });
  const resolveRecipient = (query: string) => app.resolveRecipient(query);
  const triggerDeps = {
    outbound,
    idempotency,
    identity,
    run: (req: TurnRequest) => app.turn(req),
    directory,
    resolveRecipient,
    currentScopeMembers,
    sessions,
  };
  const askResolution = (ask: KeychainAsk, grant?: KeychainGrant) =>
    fireAskResolution(
      {
        ...triggerDeps,
        getCron: (id) => crons.get(id),
        getAsk: (id) => keychain.getAsk(id),
        getGrant: (id) => keychain.getGrant(id),
      },
      ask,
      grant,
    );
  const dropResolution = (drop: DropResolution) => fireDropResolution(triggerDeps, drop);
  const inbox: InboxServiceDeps = {
    lock: advisoryLock,
    items: inboxItems,
    record: recordInboxEvent,
    chat: createInboxChat({
      items: inboxItems,
      trigger: triggerDeps,
    }),
  };
  const sweepAsks = createAskExpirySweep({ keychain, fire: askResolution, auditLog });
  const suggestedActivityProfiles = artifactMap<SuggestedActivityProfile>("suggested_activity_profiles");
  const memoryTidy = createMemoryTidyService({
    store: artifactMap<MemoryTidyProfile>("memory_tidy_profiles"),
    memory: baseMemory,
    timezone: async (principalId) => (await suggestedActivityProfiles.get(principalId))?.timezone,
    crons,
    scheduler: { notifyChanged: (id) => scheduler.notifyChanged(id) },
  });
  late.memoryTidy = memoryTidy;
  const jobs = createJobWorker(databaseUrl);
  const scheduler = createScheduler({
    admittedWork,
    skipFire: async (cron) => (await memoryTidy.skipFire(cron)) ?? suggestedActivities.skipFire(cron),
    deleteCron: (id) => app.deleteCron(id),
    advisoryLock,
    crons,
    ...triggerDeps,
    jobs,
    fireConcurrency: config.cronFireConcurrency,
  });
  late.scheduler = scheduler;
  const suggestedActivities = createSuggestedActivityService({
    store: suggestedActivityProfiles,
    sessions,
    crons,
    scheduler,
    enabled: config.suggestedActivitiesEnabled === true,
    ...(config.suggestedActivitiesContext ? { context: config.suggestedActivitiesContext } : {}),
  });
  orchestratorDeps.control = createControlService(app, scheduler, admin);
  orchestratorDeps.validateScheduledRuntime = (scope, choice, purpose) =>
    availableRuntimeError(
      {
        deps: {
          config: configStore,
          baseModelDefault: fallback.modelId,
          providerKeys: providerKeysPresent(config),
          modelCredentials,
          modelCredentialFetch: overrides.modelCredentialFetch,
          refreshModels,
        },
      },
      scope,
      choice,
      purpose,
    );
  orchestratorDeps.runtime = createRuntimeService(
    {
      config: configStore,
      get baseModelDefault() {
        return fallback.modelId;
      },
      providerKeys: providerKeysPresent(config),
      modelCredentials,
      modelCredentialFetch: overrides.modelCredentialFetch,
      refreshModels,
    },
    app,
  );
  const finishCredentials = (handle: SandboxHandle, processId: string) =>
    finishProcessCredentials({ sandbox, processes: processes!, keychain }, handle, processId);
  const monitorPoller: MonitorPoller | null =
    processes && supportsProcessSessions(sandbox)
      ? createMonitorPoller({
          admittedWork,
          monitors,
          processes,
          sandbox,
          ...triggerDeps,
          onProcessExit: finishCredentials,
        })
      : null;
  const skillSyncEngine = createSkillSyncEngine({
    packs: skillPacks,
    fetcher: skillFetcher,
    reconcile: (id) => app.syncSkillPack(id),
  });
  const webhookReceiver = createWebhookReceiver({
    webhooks,
    ...triggerDeps,
    jobs,
  });
  const backgroundOwnership: BackgroundOwnershipControl | undefined = config.backgroundDeploymentId
    ? {
        store: createBackgroundOwnershipStore(artifactMap<BackgroundOwnership>("background_ownership")),
        instanceId: randomUUID(),
        deploymentId: config.backgroundDeploymentId,
        active: () => gates.backgroundActive(),
      }
    : undefined;
  const instanceRegistry: InstanceRegistry =
    !backgroundOwnership && config.buildSha && config.backgroundWorkEnabled
      ? createPostgresInstanceRegistry(pgArtifactMap.pool, {
          instanceId: randomUUID(),
          buildSha: config.buildSha,
          startedAt: Date.now(),
        })
      : createNoopInstanceRegistry();
  const drain: DrainController = createDrainController({ registry: instanceRegistry });
  const canClaimRuns = () => gates.backgroundAdmission() && drain.canClaim();
  const turnReady = turnLedger
    ? createPostgresNotifyBus<string>(databaseUrl, TURN_READY_CHANNEL, "turn readiness")
    : undefined;
  const turnCancels = turnLedger
    ? createPostgresNotifyBus<string>(databaseUrl, TURN_CANCEL_CHANNEL, "turn cancels")
    : undefined;
  const turnYields = turnLedger
    ? createPostgresNotifyBus<string>(databaseUrl, TURN_YIELD_CHANNEL, "turn yields")
    : undefined;
  const turnRunner: TurnRunner | undefined = turnLedger
    ? createTurnRunner({
        ledger: turnLedger,
        orchestrator,
        queues: TURN_QUEUES,
        slots: Math.max(1, config.workers),
        capacity: () => Math.max(1, config.workers) - workers.filter((worker) => worker.held()).length,
        ...(turnReady ? { ready: turnReady } : {}),
        ...(turnCancels ? { cancels: turnCancels } : {}),
        ...(turnYields ? { yields: turnYields } : {}),
        canClaim: canClaimRuns,
        errors,
        maxClaims: RUN_MAX_CLAIMS,
      })
    : undefined;
  const busyRuns = () => workers.filter((worker) => worker.held()).length + (turnRunner?.held().length ?? 0);
  const canClaimRunSlot = () => canClaimRuns() && busyRuns() < Math.max(1, config.workers);
  const workers: Worker[] = Array.from({ length: Math.max(1, config.workers) }, () =>
    createWorker({
      admittedWork,
      runs,
      orchestrator,
      leaseTtlMs,
      errors,
      pollMs: 250,
      canClaim: canClaimRunSlot,
    }),
  );
  const preemption = createRunPreemption({ runs, workers, canClaim: canClaimRuns });
  const preemptionSweeper = createSweeper(() => preemption.sweep(), 1_000, { label: "run-preemption" });
  const processReaper: ProcessReaper | null = processes
    ? createProcessReaper(processes, {
        ...(supportsProcessSessions(sandbox)
          ? { kill: createReaperKillHook(sandbox, { onExit: finishCredentials }) }
          : {}),
      })
    : null;
  const composioReturns = artifactMap<ComposioReturn>("composio_returns");
  const deepIdleMachineMs = 3 * 24 * 60 * 60_000;
  const devIdleMachineMs = 2 * 60 * 60_000;
  const reapDeepIdle = deepIdleMachineMs > 0 || devIdleMachineMs > 0 ? sandbox.reapDeepIdle : undefined;
  const every = (name: string, everyMs: number, fn: () => unknown) =>
    jobs.every(name, everyMs, () => admittedWork.run(fn));
  every("cron:repair", 60_000, () => scheduler.repair());
  every("cron:asks", 5_000, () => sweepAsks(Date.now()));
  every("cron:stranded-fires", 10 * 60_000, async () => {
    const swept = await crons.sweepStrandedFires(Date.now());
    if (swept > 0) console.warn(`[scheduler] closed ${swept} stranded running fire(s) as failed`);
  });
  every("cron:fire-gc", 6 * 60 * 60_000, async () => {
    const pruned = await crons.pruneFires(Date.now());
    if (pruned > 0) console.log(`[scheduler] pruned ${pruned} old cron fire row(s)`);
  });
  if (monitorPoller) every("monitor:poll", MONITOR_POLL_MS, () => monitorPoller.tick());
  if (processReaper) every("processes:reaper", PROCESS_REAPER_INTERVAL_MS, () => processReaper.sweep());
  if (fileUploads) every("file-uploads", 60_000, () => fileUploads.sweep());
  every("memory-vector-index", 30_000, () => semanticMemory.index());
  every("slack:envelope-replay", 60_000, () => slackCore.upkeep.run("replayEnvelopes"));
  every("slack:session-status", 60_000, () => slackCore.upkeep.run("reconcileStatus"));
  every("slack:task-acks", 60_000, () => slackCore.upkeep.run("reconcileTaskAcks"));
  every("slack:emoji-catalog", 6 * 60 * 60_000, () => slackCore.upkeep.run("publishEmojiCatalog"));
  const handledEventCutoff = () => Date.now() - 24 * 60 * 60_000;
  every("slack:handled-events", 60 * 60_000, () => slackHandledEvents.deleteBelow("at", handledEventCutoff()));
  every("monitor:retention:sweep", 24 * 60 * 60_000, () => monitors.deleteDefunct(Date.now()));
  every("memory:capture-sweep", 60_000, () => memoryStrategy.sweep());
  every("spend:refresh", 60_000, () => sessions.refreshSpendRollup());
  every("llm-capture:retention", 5 * 60_000, async () => {
    const purged = await sessions.purgeLlmCaptures(Date.now() - LLM_CAPTURE_RETENTION_MS, {
      deadline: Date.now() + 30_000,
    });
    if (purged) console.log(`[llm-capture] purged ${purged} prompt envelope(s) past retention`);
  });
  every("blob-transfer", 30 * 60_000, () => blobTransfer.sweep(6 * 60 * 60_000));
  every("Composio consent returns", 30 * 60_000, async () => {
    for (const [id, entry] of await composioReturns.entries())
      if (entry.expiresAt <= Date.now()) await composioReturns.delete(id);
  });
  every("deploy-maintenance", 5 * 60_000, () => app.maintainDeployments());
  if (reapDeepIdle)
    every("sandbox:deep-idle-reaper", 5 * 60_000, () => reapDeepIdle(deepIdleMachineMs, devIdleMachineMs));
  every("orphaned-signals", config.reaperIntervalMs, async () => {
    for (const runId of await runSignals.pendingRunIds()) {
      const run = await runs.get(runId);
      if (!run || isTerminal(run.status))
        await app.replayOrphanedRunSignals(runId).catch(swallowAs("sessions: recover signal", undefined));
    }
  });
  every("run-signals:prune", 60 * 60_000, () => runSignals.prune(7 * 24 * 60 * 60_000));
  every("session-return-sweep", 1_000, sweepSessionReturns);
  every("run-result-sweep", 60_000, () => runResultRecovery.sweep());
  every("queued-post-retry", 30_000, () => outbound.retryQueued());
  every("approval-deliveries", 30_000, () => approvals.deliverPending());
  if (turnLedger) {
    every("turns:pointer-repair", 60_000, () => repairStaleTurns({ ledger: turnLedger, sessions, errors }));
    every("turns:cleanup", 60 * 60_000, () => turnLedger.cleanup());
  }
  // Started together once background work is admitted, and stopped together.
  const periodicServices: { start(): void; stop(): Promise<unknown> }[] = [reaper, wakeSweep];
  let backgroundRunning = false;
  let backgroundStopping: Promise<void> | null = null;
  let backgroundClaimsStopping: Promise<void> = Promise.resolve();
  let backgroundGeneration = 0;
  function startBackground(): void {
    if (backgroundRunning) return;
    backgroundRunning = true;
    admittedWork.resume();
    drain.start();
    const generation = ++backgroundGeneration;
    for (const worker of workers) {
      const drained = worker.drained();
      worker.start();
      void drained
        .then(() => {
          if (backgroundRunning && generation === backgroundGeneration) worker.start();
        })
        .catch(swallowAs("wiring: worker resume failed", undefined));
    }
    preemptionSweeper.start();
    turnRunner?.start();
    const startPeriodic = () => {
      if (!backgroundRunning || generation !== backgroundGeneration) return;
      for (const service of periodicServices) service.start();
      void jobs
        .start()
        .catch(reportFailureAs("jobs: start (background jobs will not run from this process)", undefined));
    };
    if (backgroundStopping)
      void backgroundClaimsStopping.then(startPeriodic).catch(swallowAs("wiring: periodic resume failed", undefined));
    else startPeriodic();
  }
  function stopBackground(): Promise<void> {
    admittedWork.pause();
    backgroundRunning = false;
    const previous = backgroundStopping;
    backgroundGeneration++;
    void semanticMemory.stop();
    const stopping = [
      ...periodicServices.map((service) => service.stop()),
      jobs.stopClaims(),
      preemptionSweeper.stop(),
      turnRunner?.stopClaims(),
      ...workers.map((worker) => worker.stopClaims()),
    ];
    backgroundClaimsStopping = Promise.all(stopping).then(() => {});
    const draining = Promise.all([previous, backgroundClaimsStopping])
      .then(() => {})
      .finally(() => {
        if (backgroundStopping === draining) backgroundStopping = null;
      });
    backgroundStopping = draining;
    return draining;
  }
  async function releaseInFlightRuns(): Promise<void> {
    gates.inlineShutdown.abort();
    await Promise.all([
      withTimeout(() => admittedWork.drained(), 3_000, "inline turn handback").catch(
        swallowAs("wiring: inline turn handback failed", undefined),
      ),
      ...workers.map((w) => w.releaseInFlight()),
      turnRunner?.releaseInFlight(),
    ]);
  }
  const runtime: Runtime = {
    start() {
      if (gates.inlineShutdown.signal.aborted) gates.inlineShutdown = new AbortController();
      void blobTransfer
        .ensureExpiry?.(1)
        .catch(reportFailureAs("blob-transfer: S3 lifecycle expiry install (sweep is the fallback)", undefined));
      drain.start();
      if (config.backgroundWorkEnabled && !config.backgroundDeploymentId) startBackground();
    },
    startBackground,
    setBackgroundAdmission(canClaim, active) {
      gates.backgroundAdmission = canClaim;
      gates.backgroundActive = active;
    },
    async stopBackgroundClaims() {
      void stopBackground().catch(swallowAs("wiring: background drain failed", undefined));
      await Promise.all([backgroundClaimsStopping, ...workers.map((worker) => worker.stopClaims())]);
    },
    stopBackground,
    async backgroundDrained() {
      await backgroundStopping;
      await Promise.all([admittedWork.drained(), jobs.stop(), ...workers.map((worker) => worker.drained())]);
    },
    releaseInFlightRuns,
    async stop() {
      await turnRunner?.releaseInFlight();
      await stopBackground();
      await Promise.all([
        withTimeout(() => admittedWork.drained(), config.shutdownDrainMs, "admitted work drain").catch(
          swallowAs("wiring: admitted work drain failed", undefined),
        ),
        withTimeout(() => jobs.stop(), config.shutdownDrainMs, "background job drain"),
        ...workers.map((w) => w.stop(config.shutdownDrainMs)),
      ]).catch(swallowAs("wiring: worker drain failed", undefined));
      await releaseInFlightRuns();
      await drain.stop();
      stopStreamSync();
      await Promise.all(
        [
          runs.close?.(),
          runSignals.close?.(),
          turnLedger?.close(),
          turnReady?.close?.(),
          contextRequestEvents.close?.(),
          turnCancels?.close?.(),
          turnYields?.close?.(),
          sessionStateBus.close?.(),
          ledgerEventBus.close?.(),
          deploymentLayerChanged.close?.(),
          runActivity.close?.(),
          runStreamEvents.close?.(),
        ].map((closing) => closing?.catch(reportFailureAs("shutdown: close event stores", undefined))),
      );
      await semanticMemory.close();
      await errors.flush();
    },
  };

  return {
    app,
    checkReadiness: async (signal) => {
      await pgArtifactMap.pool.q("SELECT 1", [], { signal });
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
    admin,
    rateLimiter,
    errors,
    crons,
    credentialUsage,
    egressAudit,
    identity,
    principalLinks,
    slackAccounts: artifactMap<SlackAccountLink>("slack_accounts"),
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
    ...(monitorPoller ? { monitorPoller } : {}),
    ambientJudgments,
    ackEmojiPicks,
    channelPolicy,
    ...(config.suggestedActivitiesEnabled && (config.backgroundWorkEnabled || config.backgroundDeploymentId)
      ? { suggestedActivities }
      : {}),
    ...(backgroundOwnership ? { backgroundOwnership } : {}),
    uiState,
    sessionShares: artifactMap<SessionShare>("session_shares"),
    sessionShareBytes: byteStore("session-shares/", "session-shares"),
    skillSyncEngine,
    slackCore,
    chatSurfaces,
  };
}

export function serverDeps(
  config: Config,
  built: BuiltApp,
  slackEnvironmentState: "absent" | "configured" | "partial" = "absent",
  slackEnvBotToken?: string,
): Omit<ServerDeps, "control"> {
  const deploymentModel = configuredModel(config);
  const subscriptionAuth = companySubscriptionAuth(config);
  return {
    externalSlackPolicies: config.externalSlackPolicies,
    modelGatewayTransport: built.modelGatewayTransport,
    resolveBrowserCompanyKeys: built.resolveBrowserCompanyKeys,
    production: config.production,
    checkReadiness: built.checkReadiness,
    ...(built.backgroundOwnership
      ? {
          backgroundOwnership: built.backgroundOwnership,
          deploymentControlSecret: config.deploymentControlSecret,
          deploymentLiveSmoke: () => runSessionSmoke(config, `http://127.0.0.1:${config.port}`),
        }
      : {}),
    ...(config.spendExportToken ? { spendExportToken: config.spendExportToken } : {}),
    ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
    ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
    capabilityTokenCompression: config.capabilityTokenCompression,
    ...(config.portalIdentitySecret ? { portalIdentitySecret: config.portalIdentitySecret } : {}),
    ...(config.requireSignedPortalIdentity ? { requireSignedPortalIdentity: true } : {}),
    replayDedupe: built.replayDedupe,
    brokerSessions: built.brokerSessions,
    config: built.config,
    ...(built.screenSecurity ? { screenSecurity: built.screenSecurity } : {}),
    ...(deploymentModel ? { baseModelDefault: deploymentModel } : {}),
    providerKeys: providerKeysPresent(config),
    modelCredentials: built.modelCredentials,
    userModelCredentials: built.userModelCredentials,
    refreshModels: built.refreshModels,
    customProviders: built.customProviders,
    refreshCustomProviders: built.refreshCustomProviders,
    mcpServers: built.mcpServers,
    mcpToolService: built.mcpToolService,
    ...(config.brandingDefault ? { brandingDefault: config.brandingDefault } : {}),
    ...(subscriptionAuth ? { companySubscriptionAuth: subscriptionAuth } : {}),
    connectorTokens: built.connectorTokens,
    slackInstallation: built.slackInstallation,
    slackEnvironmentState,
    slackEvents: built.slackCore.slack.events,
    chatSurfaces: built.chatSurfaces,
    ...(slackEnvBotToken ? { slackEnvBotToken } : {}),
    resolveClient: built.resolveClient,
    consentLinks: built.consentLinks,
    oauthFlows: built.oauthFlows,
    secretDrops: built.secretDrops,
    fireDropResolution: built.fireDropResolution,
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
    ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
    ...(config.publicWebUrl ? { portalUrl: config.publicWebUrl } : {}),
    admin: built.admin,
    ...(config.emailAuthPrincipals ? { emailAuthPrincipals: config.emailAuthPrincipals } : {}),
    ...(config.emailAuthDomain ? { emailAuthDomain: config.emailAuthDomain } : {}),
    ...(config.slack ? { slackAllowFrom: config.slack.allowFrom ?? [] } : {}),
    ...(config.resendApiKey && config.emailFrom
      ? { inviteMailer: resendMailer(config.resendApiKey, config.emailFrom) }
      : {}),
    rateLimiter: built.rateLimiter,
    ...(built.budget ? { budget: built.budget } : {}),
    acl: built.acl,
    credentialUsage: built.credentialUsage,
    featureFlags: built.featureFlags,
    decisions: built.decisions,
    teams: built.teams,
    egressAudit: built.egressAudit,
    sessions: built.sessions,
    auditLog: built.auditLog,
    errors: built.errors,
    crons: built.crons,
    inbox: built.inbox,
    deploymentLayer: built.deploymentLayerStore,
    ...(config.awsDeploy.appsDomain ? { deployAppsDomain: config.awsDeploy.appsDomain } : {}),
    ...(config.awsDeploy.gateSecret ? { deployGateSecret: config.awsDeploy.gateSecret } : {}),
    ...(config.deployAppsSessionSecret ? { deployAppsSessionSecret: config.deployAppsSessionSecret } : {}),
    ...(config.deployAppsLoginUrl ? { deployAppsLoginUrl: config.deployAppsLoginUrl } : {}),
    ...(config.deployAppsLoginPath ? { deployAppsLoginPath: config.deployAppsLoginPath } : {}),
    ...(built.appPageViews ? { appPageViews: built.appPageViews } : {}),
    scheduler: built.scheduler,
    webhookReceiver: built.webhookReceiver,
    identity: built.identity,
    principalLinks: built.principalLinks,
    slackAccounts: built.slackAccounts,
    composioReturns: built.composioReturns,
    keychain: built.keychain,
    serviceCreds: built.serviceCreds,
    outbound: built.outbound,
    keychainApprovals: built.keychainApprovals,
    runs: built.runs,
    signals: built.signals,
    sessionStateBus: built.sessionStateBus,
    workspace: built.workspace,
    files: built.files,
    ...(built.fileUploads ? { fileUploads: built.fileUploads } : {}),
    filesDirectUploadsEnabled: config.filesDirectUploadsEnabled,
    memory: built.memory,
    blobTransfer: built.blobTransfer,
    sandboxBackend: built.sandbox.profile.backend,
    egressDeclaredEnforcement: built.sandbox.profile.egressEnforcement ?? "none",
    egressEnforcement: effectiveEgressEnforcement(built.sandbox.profile, {
      signingSecret: config.signingSecret,
      apiBaseUrl: config.apiBaseUrl,
    }),
    egressControlPlaneConfigured: Boolean(config.signingSecret && config.apiBaseUrl),
    sandbox: built.sandbox,
    advisoryLock: built.advisoryLock,
    ...(built.processes ? { processes: built.processes } : {}),
    browserSessionStore: built.browserSessionStore,
    directory: built.directory,
    ambientJudgments: built.ambientJudgments,
    ackEmojiPicks: built.ackEmojiPicks,
    channelPolicy: built.channelPolicy,
    ...(built.suggestedActivities ? { suggestedActivities: built.suggestedActivities } : {}),
    uiState: built.uiState,
    inboxSourceTokens: built.keychain,
    inboxSourceRefresh: createInboxSourceRefresh({
      featureFlags: built.featureFlags,
      items: built.inbox.items,
      errors: built.errors,
      record: built.inbox.record,
      tokens: built.keychain,
      directory: built.directory,
      ...(config.slack?.apiUrl ? { slackApiUrl: config.slack.apiUrl } : {}),
    }),
    inboxSlackClient: slackUserClientFactory(config.slack?.apiUrl),
    sessionShares: built.sessionShares,
    sessionShareBytes: built.sessionShareBytes,
    environments: built.environments,
    sandboxResources: built.sandboxResources,
  };
}
