import { createPostgresSwarmBoard } from "./swarms/swarm-board.ts";
import { nonDeploymentCredential } from "./credentials/deployment-credentials.ts";
import { type TeamStore } from "./teams/teams.ts";
import { type DecisionStore } from "./decisions/store.ts";
import type { SlackSessionStatusState } from "./slack/session-status.ts";
import { availableRuntimeError } from "./api/runtime-config.ts";
import { createApprovalStore } from "./core/approval-store.ts";
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
import { createPostgresResourceSearch } from "./search/resource-search.ts";
import { createSessionMailbox, type SessionMessage } from "./sessions/session-mailbox.ts";
import type { TaskAckState } from "./slack/task-ack.ts";
import { createSuggestedActivityService, type SuggestedActivityProfile } from "./suggestions/activities.ts";
import { createMemoryTidyService, type MemoryTidyProfile } from "./memory/tidy.ts";
import { createRuntimeService } from "./harness/runtime-control.ts";
import { createSessionSyscalls } from "./subagents/session-tools.ts";
import { deliverSubagentMail } from "./subagents/mail.ts";
import { sessionTreeWorking, stoppableAncestors } from "./subagents/tree.ts";
import { isSubagentThreadRef } from "./sessions/thread-ref.ts";
import { type BrokerSessionStore } from "./auth/broker-sessions.ts";
import { type DirectFileUploads } from "./files/direct-file-upload.ts";
import { type SandboxResources } from "./sandbox/sandbox-resources.ts";
import { createAwsRoleBroker, type AwsRoleBroker } from "./auth/aws-role-broker.ts";
import type { SessionShare, SessionShareStore } from "./sessions/session-share.ts";
import { mkdirSync } from "node:fs";
import type { StagedEnvelope } from "./slack/envelope-staging.ts";
import type { HandledEvent } from "./slack/message-gating.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
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
import { createGitFetcher, resolvePackAuth, type SkillPackFetcher } from "./skills/pack-fetcher.ts";
import { type DurableMap } from "./persistence/durable-map.ts";
import type { PersistedUiState, UiStateStore } from "./surfaces/ui-state.ts";
import { installSharedCanvas } from "./surfaces/ui-canvas.ts";
import { slackUserClientFactory } from "./inbox/sources/slack.ts";
import { configurePgCaTrust, configurePgPooling } from "./persistence/pg-pool.ts";
import { type AdvisoryLock } from "./persistence/advisory-lock.ts";
import type {
  CommandApprovalGrant,
  Cron,
  InboxItem,
  Monitor,
  PendingApprovalRecord,
  Session,
  SurfaceContextRequest,
  TurnRequest,
  Webhook,
} from "./types.ts";
import { personalScope, scopeId } from "./types.ts";
import type { AuditLog } from "./audit/audit-log.ts";
import { type AppPageViewLog } from "./deploy/page-views.ts";
import type { RateLimiter } from "./ratelimit/rate-limiter.ts";
import { estimateCostUsd } from "./ratelimit/budget.ts";
import type { SecurityScreenProbe } from "./security/security-screener.ts";
import { createCronStore, type CronStore } from "./cron/cron-store.ts";
import { LOOPS_TO_CRONS_MIGRATION } from "./cron/migrations.ts";
import { createPostgresCronFireStore } from "./cron/fire-store.ts";
import {
  createInboxLedger,
  inboxConversationKeyMigration,
  INBOX_ITEM_SOURCE_MIGRATION,
  type InboxEventSink,
} from "./inbox/ledger.ts";
import { type LedgerEvent, type LedgerEventBus } from "./inbox/events.ts";
import { createInboxSourceRefresh } from "./inbox/source-refresh.ts";
import { createInboxRealtime } from "./inbox/realtime.ts";
import { createInboxChat } from "./inbox/item-chat.ts";
import type { InboxServiceDeps } from "./api/routes/cron-items.ts";
import { createOutbound, createWebSender, type Outbound, type QueuedPost } from "./surfaces/outbound.ts";
import { rememberDmPost, type RecentDmPosts } from "./surfaces/recent-dm-posts.ts";
import { wireRunResultPosts } from "./runs/run-results.ts";
import { adminSessionUrl } from "./util/admin-links.ts";
import type { DirectoryStore } from "./directory/directory-store.ts";
import { type EnvironmentStore } from "./environments/environment-store.ts";
import { createIdempotencyStore, type IdempotencyRecord } from "./idempotency/idempotency-store.ts";
import { createScheduler, type Scheduler } from "./cron/scheduler.ts";
import { cronJobQueue } from "./cron/job-queue.ts";
import { createJobWorker, type JobWorker } from "./jobs/job-worker.ts";
import { createWebhookStore, type WebhookHistory } from "./webhooks/webhook-store.ts";
import { createWebhookReceiver, type WebhookReceiver } from "./webhooks/webhook-receiver.ts";
import { createDeployStore, type Deployment } from "./deploy/deploy-store.ts";
import { viewerIdentityKey } from "./deploy/access-token.ts";
import { deploymentCredentialSlugs } from "./deploy/deployment-credentials.ts";
import { createDockerDeployProvider } from "./deploy/docker-deploy-provider.ts";
import { createAwsDeployProvider, type StoredDeployBody } from "./deploy/aws-deploy-provider.ts";
import { createPorterDeployProvider, type StoredPorterDeployBody } from "./deploy/porter-deploy-provider.ts";
import { createE2bDeployProvider, type StoredE2bDeployBody } from "./deploy/e2b-deploy-provider.ts";
import type { DeployProvider } from "./deploy/deploy-provider.ts";
import { createDeployService } from "./deploy/deploy-service.ts";
import { createCurrentScopeMembers, rosterAdmits } from "./resolution/scope-membership.ts";
import type { DeployGitArchive } from "./deploy/deploy-git-store.ts";
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
import { externalAppSharingAllowed, type FeatureFlagStore } from "./feature-flags.ts";
import { type OAuthClientResolver } from "./connectors/oauth.ts";
import { deriveConnectorKey } from "./connectors/connector-client-store.ts";
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
import { type ProviderKeys } from "./harness/pi-harness.ts";
import { resolveRuntimeChoiceDurable } from "./harness/runtime-choice.ts";
import type { Harness } from "./harness/harness.ts";
import { createSecurityScreenProxy, type SecurityScreener } from "./security/security-screener.ts";
import { classifiedMemory } from "./memory/classification.ts";
import { createPerTurnStrategy, type PendingCapture } from "./memory/strategies/per-turn.ts";
import { createOrchestrator, type OrchestratorDeps } from "./core/orchestrator.ts";
import { mintCapabilityToken, CREDENTIAL_BROKER_AUD, DEPLOYMENT_CREDENTIAL_TTL_MS } from "./auth/capability-token.ts";
import { createControlService } from "./api/control-service.ts";
import { TURN_QUEUES } from "./turns/absurd-schema.ts";
import { type RunSignalStore } from "./runs/run-signal-store.ts";
import { isTerminal, type Run, type RunStore } from "./runs/run-store.ts";
import { TURN_CANCEL_CHANNEL, TURN_READY_CHANNEL, TURN_YIELD_CHANNEL } from "./turns/turn-ledger.ts";
import { createTurnRunner, type TurnRunner } from "./turns/turn-runner.ts";
import { repairStaleTurns } from "./turns/turn-engine.ts";
import { createRunPreemption, createWorker, RUN_MAX_CLAIMS, type Worker } from "./runs/worker.ts";
import { EXEC_TIMEOUT_DEFAULT_MS, EXEC_TIMEOUT_MAX_MS } from "./harness/agent-tools.ts";
import { BACKGROUND_JOB_TTL_MAX_MS, BACKGROUND_JOB_TTL_MS } from "./connectors/background-exec-broker.ts";
import {
  createNoopInstanceRegistry,
  createPostgresInstanceRegistry,
  type InstanceRegistry,
} from "./runs/instance-registry.ts";
import { createDrainController, type DrainController } from "./runs/drain.ts";
import { createReaper, REAPER_LEASE_KEY, RUN_MAX_AGE_MS, type Reaper } from "./runs/reaper.ts";
import { createSweeper as createUntrackedSweeper, type Sweeper } from "./util/sweeper.ts";
import { createPeriodicJobs } from "./util/periodic-jobs.ts";
import { type ProcessRegistry } from "./processes/process-registry.ts";
import {
  createProcessReaper,
  createReaperKillHook,
  PROCESS_REAPER_INTERVAL_MS,
  type ProcessReaper,
} from "./processes/process-reaper.ts";
import { createMonitorStore, type MonitorStore } from "./monitors/monitor-store.ts";
import { createMonitorPoller, MONITOR_POLL_MS, type MonitorPoller } from "./monitors/monitor-poller.ts";
import { createSkillSyncEngine, type SkillSyncEngine } from "./skills/skill-sync-engine.ts";
import { supportsProcessSessions, type SandboxHandle } from "./sandbox/sandbox.ts";
import { finishProcessCredentials } from "./credentials/execute-files.ts";
import { type SessionStateBus } from "./runs/session-state-bus.ts";
import { createApp, type App } from "./api/app.ts";
import { startSession } from "./api/start-session.ts";
import { createSlackCoreClient, type SlackCoreClient } from "./api/slack-core-client.ts";
import { createSlackSurface } from "./chat-surface/slack.ts";
import { createHttpChatSurface } from "./chat-surface/http-chat.ts";
import { createSurfaceRegistry, type SurfaceRegistry } from "./chat-surface/registry.ts";
import { createSurfaceContextPuller } from "./api/surface-context-puller.ts";
import { createEngagedRegistry } from "./wake/engaged-registry.ts";
import { createWakeSweep, type WakeSweep } from "./wake/sweep.ts";
import { createPostgresSurfaceCache, type SurfaceCache } from "./surface-cache/surface-cache.ts";
import { createPostgresChannelPolicyStore, type ChannelPolicyStore } from "./surface-cache/channel-policy-store.ts";
import {
  createPostgresAmbientJudgmentStore,
  type AmbientJudgmentStore,
} from "./surface-cache/ambient-judgment-store.ts";
import { createPostgresAckEmojiPickStore, type AckEmojiPickStore } from "./surface-cache/ack-emoji-pick-store.ts";
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

import { buildStores } from "./wiring/stores.ts";
import type { Late } from "./wiring/late.ts";

import { buildModelCredentials } from "./wiring/model-credentials.ts";

import { buildDeploymentLayer } from "./wiring/deployment-layer.ts";

import { buildFiles } from "./wiring/files.ts";

import { buildSandboxBackends } from "./wiring/sandbox.ts";

import { buildSandbox } from "./wiring/sandbox.ts";

import { buildCredentials } from "./wiring/credentials.ts";

import { buildModelKeys } from "./wiring/model-keys.ts";

import { buildHarness } from "./wiring/harness.ts";

import { buildStartup } from "./wiring/startup.ts";

import { buildMemory } from "./wiring/memory.ts";

import { buildRuns } from "./wiring/runs.ts";

import { buildRunStreams } from "./wiring/run-streams.ts";

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
  deploymentLayerRefresh: Sweeper;
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
  browserModelGateway?: ModelGatewayTransportConfig;
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
  inbox: InboxServiceDeps;
  webhookReceiver: WebhookReceiver;
  jobs: JobWorker;
  admin: AdminService;
  rateLimiter: RateLimiter;
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
  let backgroundAdmission = () => !config.backgroundDeploymentId;
  let backgroundActive = () => false;
  const admittedWork = createAdmittedWork({
    canStart: () => !config.backgroundDeploymentId || backgroundAdmission(),
  });
  let inlineShutdown = new AbortController();
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
    environments,
    artifactMap,
    managesArtifactHome,
    skills,
    skillBundles,
    advisoryLock,
    identity,
    configStore,
    leaderLease,
    pgArtifactMap,
    sessions,
    canUseSandboxScope,
    decisions,
    featureFlags,
    canReadScope,
    canWriteScope,
    directory,
    projects,
    currentScopeMembers,
    admin,
    teams,
    connectorStatusCache,
    isCurrentSharedScopeMember,
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
  const { deploymentLayerStore, installCatalogs, deploymentLayer, auditLog, brokeredTools, deploymentLayerRefresh } =
    buildDeploymentLayer({ config, databaseUrl, artifactMap, skills, skillBundles, advisoryLock });
  const { sandboxBackends, e2bBodies, modalBodies, sandboxOnError, e2bClient } = buildSandboxBackends({
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
    advisoryLock,
    config,
    sessions,
    environments,
    e2bBodies,
    modalBodies,
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
  const { baseMemory, semanticMemory } = buildMemory({
    databaseUrl,
    configStore,
    resolveMemoryEmbedder,
    leaderLease,
    createSweeper,
    late,
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
  const memory = classifiedMemory(baseMemory, harness.models);
  const memoryStrategy = createPerTurnStrategy({
    harness: harness.models,
    memory,
    captureQuietMs: config.memoryCaptureQuietMs,
    pending: artifactMap<PendingCapture>("memory_capture_pending"),
    onCaptureError: (e, scope) =>
      errors.record({ category: "memory", code: "capture_failed", message: errMessage(e), scopeLabel: scope }, e),
  });
  const deployGitSecret = config.signingSecret;
  const deployGitBase = config.apiBaseUrl;
  const idempotency = createIdempotencyStore(artifactMap<IdempotencyRecord>("idempotency"));
  const transcripts = { sessions, sessionStates: sessionStateBus };
  const recentDmPosts = artifactMap<RecentDmPosts>("recent_dm_posts");
  const outbound = createOutbound({
    idempotency,
    retries: artifactMap<QueuedPost>("queued_posts"),
    afterSend: (post, receipt) => {
      const recipientId = post.destination.target;
      const threadRef = receipt.recipientThreadRef;
      if (post.destination.type !== "principal" || !threadRef) return;
      void (async () => {
        const session = await sessions.getOrCreateByThread(
          threadRef,
          "dm",
          scopeId("personal", recipientId),
          undefined,
          "slack",
        );
        await sessions.addParticipant(session.id, recipientId);
        await rememberDmPost(recentDmPosts, threadRef, {
          key: post.idempotencyKey,
          text: post.text,
          at: Date.now(),
          ...(post.destination.onBehalfOf ? { onBehalfOf: post.destination.onBehalfOf } : {}),
          ...(post.provenance?.trigger ? { trigger: post.provenance.trigger } : {}),
        });
      })().catch(swallowAs("outbound: remember DM post", undefined));
    },
  });
  outbound.register(["web"], createWebSender(transcripts));
  const slackSurface = createSlackSurface();
  const chatSurfaces = createSurfaceRegistry({
    surfaces: [
      slackSurface,
      ...(config.chatSurfaces ?? []).map((surface) =>
        createHttpChatSurface(surface, { mirror: (events) => app.ingestSurfaceEvents(events, surface.surface) }),
      ),
    ],
    outbound,
    turn: (request) => app.turn(request),
  });
  pgArtifactMap.pool.registerMigration({
    id: "delivery/store/0007-drop",
    statements: ["DROP TABLE IF EXISTS deliveries"],
  });
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
    leaderLease,
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
  const monitors = createMonitorStore(artifactMap<Monitor>("monitors"));
  const cronOwnerCache = new Map<string, string>();
  const publishInboxEvent = (event: LedgerEvent): void => {
    void (async () => {
      let owner = cronOwnerCache.get(event.cronId);
      if (owner === undefined) {
        owner = (await crons.get(event.cronId))?.owner ?? "";
        cronOwnerCache.set(event.cronId, owner);
      }
      if (owner) ledgerEventBus.emit({ ...event, owner });
    })().catch(swallowAs("inbox: publish ledger event", undefined));
  };
  const inboxItems = createInboxLedger(
    artifactMap<InboxItem>("cron_items", ["cronId", "conversationKey"]),
    publishInboxEvent,
  );
  const recordInboxEvent: InboxEventSink = async (item, event) => {
    if (await inboxItems.recordEvent(item, event)) await scheduler.runNow(item.cronId);
  };
  const cronFires = createPostgresCronFireStore(databaseUrl);
  const cronsBase = createCronStore(artifactMap<Cron>("crons"), {
    staleRunningMs: RUN_MAX_AGE_MS,
    fires: cronFires,
  });
  const crons: CronStore = {
    ...cronsBase,
    async create(input) {
      const cron = await cronsBase.create(input);
      scheduler.notifyChanged(cron.id);
      return cron;
    },
    async update(id, patch) {
      const cron = await cronsBase.update(id, patch);
      scheduler.notifyChanged(id);
      return cron;
    },
    async setEnabled(id, enabled) {
      await cronsBase.setEnabled(id, enabled);
      scheduler.notifyChanged(id);
    },
    async delete(id) {
      await cronsBase.delete(id);
      await inboxItems.deleteByCron(id);
    },
  };
  pgArtifactMap.pool.registerMigration(LOOPS_TO_CRONS_MIGRATION);
  pgArtifactMap.pool.registerMigration(INBOX_ITEM_SOURCE_MIGRATION);
  pgArtifactMap.pool.registerMigration(inboxConversationKeyMigration());
  pgArtifactMap.pool.registerMigration({
    id: "durable-map/model_registry/0002-drop",
    statements: [
      "DROP TABLE IF EXISTS model_registry",
      "DELETE FROM durable_map_versions WHERE tbl = 'model_registry'",
    ],
  });
  pgArtifactMap.pool.registerMigration({
    id: "runtime/0002-drop-harness-choice",
    statements: [
      "DROP TABLE IF EXISTS approved_harness_configs",
      "DELETE FROM durable_map_versions WHERE tbl = 'approved_harness_configs'",
      `DO $$ BEGIN IF to_regclass('base_model_configs') IS NOT NULL THEN UPDATE base_model_configs SET json = (CASE WHEN json ? 'harnessId' AND NOT json ? 'orgRevision' THEN json || '{"orgRevision":0}'::jsonb ELSE json END) - 'harnessId' #- '{cronRuntime,harnessId}' #- '{subagentRuntime,harnessId}' #- '{fallbackRuntime,harnessId}' WHERE json ? 'harnessId' OR (json -> 'cronRuntime') ? 'harnessId' OR (json -> 'subagentRuntime') ? 'harnessId' OR (json -> 'fallbackRuntime') ? 'harnessId'; END IF; END $$`,
      `DO $$ BEGIN IF to_regclass('auto_flagger_configs') IS NOT NULL THEN UPDATE auto_flagger_configs SET json = json - 'harnessId' WHERE json ? 'harnessId'; END IF; END $$`,
      `DO $$ BEGIN IF to_regclass('crons') IS NOT NULL THEN UPDATE crons SET json = json #- '{runtime,harnessId}' WHERE (json -> 'runtime') ? 'harnessId'; END IF; END $$`,
      `DO $$ BEGIN IF to_regclass('swarms') IS NOT NULL THEN UPDATE swarms SET json = json #- '{template,harness}' WHERE (json -> 'template') ? 'harness'; END IF; END $$`,
    ],
  });
  pgArtifactMap.pool.registerMigration({
    id: "runtime/0003-promote-legacy-base-models",
    statements: [
      `DO $$ BEGIN IF to_regclass('base_model_configs') IS NOT NULL THEN UPDATE base_model_configs SET json = json || '{"orgRevision":0}'::jsonb WHERE json ? 'modelId' AND NOT json ? 'orgRevision'; END IF; END $$`,
    ],
  });
  pgArtifactMap.pool.registerMigration({
    id: "durable-map/swarms/0002-drop",
    statements: [
      `DO $$ BEGIN IF to_regclass('runs') IS NOT NULL THEN UPDATE runs SET status = 'failed', result = json_build_object('status', 'failed', 'sessionId', session_id, 'reason', 'swarms were removed')::text, lease_token = NULL, lease_expires_at = NULL, worker_id = NULL, finished_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint WHERE status IN ('pending', 'running') AND (session_id LIKE 'swarm:%' OR request LIKE '%"swarm":%'); END IF; END $$`,
      "DROP TABLE IF EXISTS swarms",
      "DELETE FROM durable_map_versions WHERE tbl = 'swarms'",
      "DO $$ BEGIN IF to_regclass('feature_flags') IS NOT NULL THEN DELETE FROM feature_flags WHERE id = 'swarms'; END IF; END $$",
    ],
  });
  const webhooks = createWebhookStore(artifactMap<Webhook>("webhooks"), artifactMap<WebhookHistory>("webhook_history"));
  const webUiBase = (config.slack?.webUiPublicUrl ?? config.publicWebUrl)?.replace(/\/+$/, "");
  const approvals = createApprovalStore(artifactMap<PendingApprovalRecord>("approvals", ["sessionId"]), outbound, {
    surfaces: chatSurfaces,
    webSessionUrl: (sessionId) => (webUiBase ? `${webUiBase}/s/${encodeURIComponent(sessionId)}` : undefined),
  });
  late.approvals = approvals;
  let securityScreener = overrides.securityScreener;
  if (!securityScreener && config.securityScreenProxy) {
    securityScreener = createSecurityScreenProxy({
      ...config.securityScreenProxy,
      timeoutMs: config.securityScreenTimeoutMs,
    });
  }
  const layerEnv = config.layerEnv ?? {};
  const layerBrokerCache = new Map<string, AwsRoleBroker>();
  const layerBrokerFor = (tool: BrokeredLayerTool): AwsRoleBroker | undefined => {
    const override = overrides.credentialBrokers?.[tool.service];
    if (override) return override;
    const roleArn = layerEnv[tool.broker.roleArnEnv];
    if (!roleArn) return undefined;
    const region = (tool.broker.regionEnv ? layerEnv[tool.broker.regionEnv] : undefined) ?? tool.broker.region;
    if (!region) return undefined;
    const key = JSON.stringify([roleArn, region, tool.broker.sessionActions]);
    let broker = layerBrokerCache.get(key);
    if (!broker) {
      broker = createAwsRoleBroker({ roleArn, region, sessionActions: tool.broker.sessionActions });
      layerBrokerCache.set(key, broker);
    }
    return broker;
  };
  const prepareSessionRequest = async (request: Parameters<RunStore["enqueue"]>[0]["request"]) => {
    const scope = resolution.scopeFor(request.conversation, request.actor);
    if (!(await canWriteScope(request.actor.id, scope))) throw new Error("session actor no longer has scope access");
    const ref = request.conversation.channelRef;
    if (request.conversation.kind !== "group" || !ref || !projects.recognizes(ref)) return request;
    const version = await projects.version(ref);
    const audience = await currentScopeMembers(scope);
    if (
      !version ||
      !audience ||
      !rosterAdmits(
        audience.map((p) => p.id),
        request.actor.id,
        scope,
      )
    )
      throw new Error("session owner is no longer a member of this project");
    return {
      ...request,
      scopeVersion: version,
      sessionParticipantIds: audience.map((p) => p.id),
      conversation: { ...request.conversation, audience, publishMembers: audience },
    };
  };
  const sessionMailbox = createSessionMailbox(artifactMap<SessionMessage>("session_mailbox", ["recipientId"]));
  const sessionSyscalls = createSessionSyscalls({
    mailbox: sessionMailbox,
    board: createPostgresSwarmBoard(databaseUrl),
    enabled: async (actorId) =>
      (await featureFlags.enabled("persistent_subagents", scopeId("personal", actorId))) ||
      (await featureFlags.enabled("responsive_spine", scopeId("personal", actorId))),
    sessions,
    runs,
    signals: runSignals,
    maxAttempts,
    advisoryLock,
    prepareRequest: prepareSessionRequest,
    authorize: (session, actorId) => canWriteScope(actorId, session.scopeId),
    conversations: {
      search: ({ query, principals, limit }) => app.searchConversations(query, principals, limit),
      list: (actorId) => app.listSessions(actorId),
      start: (actorId, input) => startSession(app, sessions, actorId, input),
    },
    async validateRuntime(input, scope) {
      await resolveRuntimeChoiceDurable(
        configStore,
        runtimeOrgScope,
        scope,
        fallback,
        {
          ...(input.model ? { modelId: input.model } : {}),
          ...(input.thinkingLevel ? { effortLevel: input.thinkingLevel } : {}),
          ...(typeof input.fastMode === "boolean" ? { fastMode: input.fastMode } : {}),
        },
        hydrateModelCatalog,
        "subagent",
      );
    },
  });
  const uiState = artifactMap<PersistedUiState>("web_ui_state");
  const liveFallback = async (
    container: string,
    opts?: { limit?: number },
  ): Promise<Array<{
    container: string;
    ts: string;
    authorId?: string;
    authorName?: string;
    text: string;
    createdAt: number;
  }> | null> => {
    const puller = orchestratorDeps.surfaceContext;
    if (!puller) return null;
    const result = await puller.pull("slack", {
      conversationTarget: container,
      ...(opts?.limit !== undefined ? { count: opts.limit } : {}),
    });
    if (!result) return null;
    return (result.messages as Array<Record<string, unknown>>).map((m) => ({
      container,
      ts: String(m.ts ?? ""),
      ...(m.authorId ? { authorId: String(m.authorId) } : {}),
      ...((m.author ?? m.authorName) ? { authorName: String(m.author ?? m.authorName) } : {}),
      text: String(m.text ?? ""),
      createdAt: Date.now(),
    }));
  };
  const surfaceCache: SurfaceCache = createPostgresSurfaceCache(databaseUrl, { liveFallback });
  const channelPolicy: ChannelPolicyStore = createPostgresChannelPolicyStore(databaseUrl);
  const orchestratorDeps: OrchestratorDeps = {
    channelPolicy,
    surfaceCache,
    surfaceLabel: chatSurfaces.label,
    installSharedCanvas: async (actorId, fileId, where) => {
      const canvas = await installSharedCanvas(uiState, actorId, await app.openFileForViewer(fileId, actorId));
      if (typeof canvas === "string") return canvas;
      auditLog.record({
        at: Date.now(),
        principalId: actorId,
        action: "ui.canvas.install",
        resource: `file:${fileId}`,
        scopeLabel: personalScope(actorId),
        detail: `rev ${canvas.rev}`,
      });
      sessionStateBus.emit({ ...where, participants: [actorId], state: "ui", at: Date.now(), ui: { kind: "canvas" } });
      return null;
    },
    sessionStateBus,
    externalSlackPolicies: config.externalSlackPolicies,
    sessionSyscalls,
    refreshModels,
    identity,
    resolution,
    config: configStore,
    defaultTurnWallClockMs: config.turnWallClockMs,
    userModelCredentials,
    ...(config.brandingDefault ? { brandingDefault: config.brandingDefault } : {}),
    sessions,
    workspace,
    files,
    toolOutput,
    sandbox,
    sandboxResources,
    connectorTokens,
    modelGateway,
    auditLog,
    rateLimiter,
    budget,
    harness,
    memory,
    deploy: deployService,
    acl,
    admin,
    mcp: mcpToolService,
    ...(config.maxContextTokens !== undefined ? { maxContextTokens: config.maxContextTokens } : {}),
    execTimeoutMs: EXEC_TIMEOUT_DEFAULT_MS,
    execTimeoutCeilingMs: EXEC_TIMEOUT_MAX_MS,
    approvalSummaryTimeoutMs: config.approvalSummaryTimeoutMs,
    turnLeaseWaitMs: config.turnLeaseWaitMs,
    securityScreenTimeoutMs: config.securityScreenTimeoutMs,
    ...(securityScreener ? { securityScreener } : {}),
    backgroundJobTtlMs: BACKGROUND_JOB_TTL_MS,
    backgroundJobTtlMaxMs: BACKGROUND_JOB_TTL_MAX_MS,
    ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
    ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
    capabilityTokenCompression: config.capabilityTokenCompression,
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
    ...(config.publicWebUrl ? { publicWebUrl: config.publicWebUrl } : {}),
    ...(config.deployAppsDomain ? { deployAppsDomain: config.deployAppsDomain } : {}),
    ...(config.resendApiKey && config.emailFrom
      ? { inviteMailer: resendMailer(config.resendApiKey, config.emailFrom) }
      : {}),
    ...(config.publicUrl ? { webhookPublicUrl: config.publicUrl } : {}),
    memoryPolicy: { recall: config.memoryRecall, capture: config.memoryCapture },
    memoryStrategy,
    skills,
    skillBundles,
    skillsReady,
    advisoryLock,
    errors,
    ledger,
    signals: runSignals,
    turnStream,
    runActivity,
    runs,
    blobTransfer,
    featureFlags,
    teams,
    credentialUsage,
    connectorStatusCache,
    resolveConnectorClient: resolveClient,
    keychain,
    serviceCreds,
    outbound,
    recentDmPosts,
    approvals,
    approvalGrants: artifactMap<CommandApprovalGrant>("approval_grants"),
    ...(processes ? { processes } : {}),
    monitors,
    crons,
    webhooks,
    resolveBaseModelId: () => orgBaseModelId() ?? fallback.modelId,
    ...(config.scratchExecEnabled ? { scratchExec: true } : {}),
    directory,
    isCurrentSharedScopeMember,
    currentScopeMembers: createCurrentScopeMembers({ managedGroups: projects, directory, identity }, true),
    managedGroups: projects,
    projects,
    ...(config.reachExecEnabled ? { reachExec: true } : {}),
    ...(config.eagerProvisionEnabled ? { eagerProvision: true } : {}),
    environments,
    brokeredTools,
    deploymentLayer,
    layerBrokerFor,
  };
  const orchestrator = createOrchestrator(orchestratorDeps);

  const uuidId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const recoveryAdminBase = config.publicWebUrl?.replace(/\/$/, "");
  const recoveryAdminUrlFor = recoveryAdminBase
    ? (sessionId: string): string | undefined =>
        uuidId.test(sessionId) ? adminSessionUrl(recoveryAdminBase, sessionId) : undefined
    : undefined;
  const runResultRecovery = wireRunResultPosts(runs, outbound, {
    ...(recoveryAdminUrlFor ? { adminUrlFor: recoveryAdminUrlFor } : {}),
    sessions,
    postsImmediately: chatSurfaces.receives,
  });
  const skillFetcher = createGitFetcher({
    allowLocalRepos: !config.production,
    resolveAuth: (pack) =>
      resolvePackAuth(
        {
          serviceCredential: async (slug) => {
            const record = nonDeploymentCredential(
              await serviceCreds.getServiceCredentialSecret(scopeId("org", config.orgId), slug),
            );
            return record && record.delivery !== "env" ? record : undefined;
          },
          connectorToken: async (host, principalId) =>
            (await keychain.connectorAccessToken(host, principalId)) ?? undefined,
        },
        pack,
      ),
  });
  const reaper: Reaper = createReaper(runs, sessions, {
    intervalMs: config.reaperIntervalMs,
    leaderLease,
    maxAgeMs: RUN_MAX_AGE_MS,
    errors,
  });
  const engaged = createEngagedRegistry();
  let reapInFlight = false;
  let lastReapAt = 0;
  const REAP_POKE_COOLDOWN_MS = 1_000;
  const pokeReaper = (): void => {
    if (reapInFlight || Date.now() - lastReapAt < REAP_POKE_COOLDOWN_MS) return;
    reapInFlight = true;
    void leaderLease
      .hold(REAPER_LEASE_KEY, () => reaper.sweep())
      .catch(swallowAs("wake: reaper poke", null))
      .finally(() => {
        reapInFlight = false;
        lastReapAt = Date.now();
      });
  };
  const ambientJudgments: AmbientJudgmentStore = createPostgresAmbientJudgmentStore(databaseUrl);
  const ackEmojiPicks: AckEmojiPickStore = createPostgresAckEmojiPickStore(databaseUrl);
  const providerKeys = directProviderAvailability;
  const screenSecurity: SecurityScreenProbe | undefined = harness.models.screenSecurity
    ? ({ payload, modelId, systemPrompt, actorId, scopeLabel, signal }) =>
        harness.models.screenSecurity!({
          payload,
          modelId,
          systemPrompt,
          signal,
          recordModelCall: (rec) => {
            modelGateway.recordCall({ at: Date.now(), scopeLabel, ...rec });
            void budget
              ?.record(actorId, estimateCostUsd(rec.inputTokens))
              .catch(swallowAs("budget: record screen spend", undefined));
          },
        })
    : undefined;
  const app = createApp({
    teams,
    externalSlackPolicies: config.externalSlackPolicies,
    admittedWork,
    shutdown: () => inlineShutdown.signal,
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
    handledEvents: artifactMap<HandledEvent>("slack_handled_events"),
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
    leaderLease,
    jobQueue: cronJobQueue(jobs, config.cronFireConcurrency),
    sweepAsks,
  });
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
          leaderLease,
          onProcessExit: finishCredentials,
        })
      : null;
  const skillSyncEngine = createSkillSyncEngine({
    packs: skillPacks,
    fetcher: skillFetcher,
    reconcile: (id) => app.syncSkillPack(id),
    leaderLease,
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
        active: () => backgroundActive(),
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
  const canClaimRuns = () => backgroundAdmission() && drain.canClaim();
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
        intervalMs: PROCESS_REAPER_INTERVAL_MS,
        ...(supportsProcessSessions(sandbox)
          ? { kill: createReaperKillHook(sandbox, { onExit: finishCredentials }) }
          : {}),
        leaderLease,
      })
    : null;
  const composioReturns = artifactMap<ComposioReturn>("composio_returns");
  const deepIdleMachineMs = 3 * 24 * 60 * 60_000;
  const devIdleMachineMs = 2 * 60 * 60_000;
  const reapDeepIdle = deepIdleMachineMs > 0 || devIdleMachineMs > 0 ? sandbox.reapDeepIdle : undefined;
  const periodicJobs = createPeriodicJobs(
    [
      {
        name: "monitor:retention:sweep",
        everyMs: 24 * 60 * 60_000,
        lock: "leader",
        immediate: true,
        run: () => monitors.deleteDefunct(Date.now()),
      },
      {
        name: "memory:capture-sweep",
        everyMs: 60_000,
        lock: "leader",
        run: () => memoryStrategy.sweep(),
      },
      {
        name: "spend:refresh",
        everyMs: 60_000,
        lock: "leader",
        immediate: true,
        run: () => sessions.refreshSpendRollup(),
      },
      {
        name: "llm-capture:retention",
        everyMs: 5 * 60_000,
        lock: "leader",
        run: async (lost) => {
          let leaseLost = false;
          void lost.then(() => (leaseLost = true));
          const purged = await sessions.purgeLlmCaptures(Date.now() - LLM_CAPTURE_RETENTION_MS, {
            deadline: Date.now() + 30_000,
            stop: () => leaseLost,
          });
          if (purged) console.log(`[llm-capture] purged ${purged} prompt envelope(s) past retention`);
        },
      },
      { name: "blob-transfer", everyMs: 30 * 60_000, lock: "none", run: () => blobTransfer.sweep(6 * 60 * 60_000) },
      {
        name: "Composio consent returns",
        everyMs: 30 * 60_000,
        lock: "none",
        immediate: true,
        run: async () => {
          for (const [id, entry] of await composioReturns.entries())
            if (entry.expiresAt <= Date.now()) await composioReturns.delete(id);
        },
      },
      { name: "deploy-maintenance", everyMs: 5 * 60_000, lock: "none", run: () => app.maintainDeployments() },
      ...(reapDeepIdle
        ? [
            {
              name: "sandbox:deep-idle-reaper",
              everyMs: 5 * 60_000,
              lock: "leader",
              immediate: true,
              run: () => reapDeepIdle(deepIdleMachineMs, devIdleMachineMs),
            } as const,
          ]
        : []),
      {
        name: "orphaned-signals",
        everyMs: config.reaperIntervalMs,
        lock: "none",
        run: async () => {
          for (const runId of await runSignals.pendingRunIds()) {
            const run = await runs.get(runId);
            if (!run || isTerminal(run.status))
              await app.replayOrphanedRunSignals(runId).catch(swallowAs("sessions: recover signal", undefined));
          }
        },
      },
      {
        name: "run-signals:prune",
        everyMs: 60 * 60_000,
        lock: "none",
        run: () => runSignals.prune(7 * 24 * 60 * 60_000),
      },
      { name: "session-return-sweep", everyMs: 1_000, lock: "advisory", immediate: true, run: sweepSessionReturns },
      { name: "run-result-sweep", everyMs: 60_000, lock: "advisory", run: () => runResultRecovery.sweep() },
      { name: "queued-post-retry", everyMs: 30_000, lock: "advisory", run: () => outbound.retryQueued() },
      {
        name: "approval-deliveries",
        everyMs: 30_000,
        lock: "advisory",
        immediate: true,
        run: () => approvals.deliverPending(),
      },
      ...(turnLedger
        ? [
            {
              name: "turns:pointer-repair",
              everyMs: 60_000,
              lock: "leader",
              run: () => repairStaleTurns({ ledger: turnLedger, sessions, errors }),
            } as const,
            { name: "turns:cleanup", everyMs: 60 * 60_000, lock: "leader", run: () => turnLedger.cleanup() } as const,
          ]
        : []),
    ],
    { createSweeper, leaderLease, advisoryLock },
  );
  // Started together once background work is admitted, and stopped together.
  const periodicServices: { start(): void; stop(): Promise<unknown> }[] = [
    reaper,
    ...(processReaper ? [processReaper] : []),
    semanticMemory,
    ...(fileUploads ? [fileUploads] : []),
    wakeSweep,
    periodicJobs,
  ];
  let backgroundRunning = false;
  let backgroundStopping: Promise<void> | null = null;
  let backgroundClaimsStopping: Promise<void> = Promise.resolve();
  let monitorDrained: Promise<void> = Promise.resolve();
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
      monitorPoller?.start(MONITOR_POLL_MS);
      void monitorDrained
        .then(() => {
          if (backgroundRunning && generation === backgroundGeneration) monitorPoller?.start(MONITOR_POLL_MS);
        })
        .catch(swallowAs("wiring: monitor resume failed", undefined));
      for (const service of periodicServices) service.start();
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
    const monitorStopping = monitorPoller?.stop();
    monitorDrained = monitorStopping ?? Promise.resolve();
    const stopping = [
      ...periodicServices.map((service) => service.stop()),
      preemptionSweeper.stop(),
      turnRunner?.stopClaims(),
      ...workers.map((worker) => worker.stopClaims()),
    ];
    backgroundClaimsStopping = Promise.all(stopping).then(() => {});
    const draining = Promise.all([previous, backgroundClaimsStopping, monitorStopping])
      .then(() => {})
      .finally(() => {
        if (backgroundStopping === draining) backgroundStopping = null;
      });
    backgroundStopping = draining;
    return draining;
  }
  async function releaseInFlightRuns(): Promise<void> {
    inlineShutdown.abort();
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
      if (inlineShutdown.signal.aborted) inlineShutdown = new AbortController();
      void blobTransfer
        .ensureExpiry?.(1)
        .catch((e) =>
          console.error(
            "[blob-transfer] S3 lifecycle expiry install failed (sweep remains the fallback):",
            errMessage(e),
          ),
        );
      drain.start();
      if (config.backgroundWorkEnabled && !config.backgroundDeploymentId) startBackground();
    },
    startBackground,
    setBackgroundAdmission(canClaim, active) {
      backgroundAdmission = canClaim;
      backgroundActive = active;
    },
    async stopBackgroundClaims() {
      void stopBackground().catch(swallowAs("wiring: background drain failed", undefined));
      await Promise.all([backgroundClaimsStopping, ...workers.map((worker) => worker.stopClaims())]);
    },
    stopBackground,
    async backgroundDrained() {
      await backgroundStopping;
      await Promise.all([admittedWork.drained(), ...workers.map((worker) => worker.drained())]);
    },
    releaseInFlightRuns,
    async stop() {
      await turnRunner?.releaseInFlight();
      await stopBackground();
      await Promise.all([
        withTimeout(() => admittedWork.drained(), config.shutdownDrainMs, "admitted work drain").catch(
          swallowAs("wiring: admitted work drain failed", undefined),
        ),
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
    deploymentLayerRefresh,
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
    browserModelGateway: gatewayTransport,
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
    browserModelGateway: built.browserModelGateway,
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
