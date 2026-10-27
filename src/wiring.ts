import type { MemoryEmbedder } from "./model/embeddings.ts";
import { createPostgresSwarmBoard } from "./swarms/swarm-board.ts";
import { nonDeploymentCredential, withDeploymentCredentials } from "./credentials/deployment-credentials.ts";
import { resolveEmbeddingModel } from "./model/pi-models.ts";
import { createPostgresTeamStore, type TeamStore } from "./teams/teams.ts";
import { createDecisionHooks, routeTurnRuntime, turnStartState } from "./decisions/hooks.ts";
import { createDecisionBackend } from "./decisions/providers.ts";
import { createPostgresDecisionStore, type DecisionStore } from "./decisions/store.ts";
import type { SlackSessionStatusState } from "./slack/session-status.ts";
import { availableRuntimeError } from "./api/runtime-config.ts";
import { createApprovalStore } from "./core/approval-store.ts";
import { createKeychainApprovals, type KeychainApprovals } from "./credentials/keychain-approval.ts";
import { flushErrorReporting } from "../plugins/chassis/src/error-reporting.ts";
import { createProductAnalytics } from "./util/product-analytics.ts";
import { createAdmittedWork } from "./util/admitted-work.ts";
import { runSessionSmoke } from "./deployment/postdeploy-smoke.ts";
import {
  createBackgroundOwnershipStore,
  type BackgroundOwnershipControl,
  type BackgroundOwnership,
} from "./runs/background-ownership.ts";
import { loadConnectorSdk } from "./sandbox/connector-sdk.ts";
import { createPostgresNotifyBus } from "./persistence/postgres-notify-bus.ts";
import { emitRunReasoning, emitRunText, reasoningKey, type RunStreamEvent } from "./runs/run-stream-events.ts";
import { createPostgresResourceSearch } from "./search/resource-search.ts";
import { createSessionMailbox } from "./sessions/session-mailbox.ts";
import type { TaskAckState } from "./slack/task-ack.ts";
import { createGatewayCatalog } from "./model/gateway-catalog.ts";
import { createSuggestedActivityService, type SuggestedActivityProfile } from "./suggestions/activities.ts";
import { createMemoryTidyService, withMemoryTidy, type MemoryTidyProfile } from "./memory/tidy.ts";
import { createRuntimeService } from "./harness/runtime-control.ts";
import { createSessionSyscalls } from "./subagents/session-tools.ts";
import { deliverSubagentMail } from "./subagents/mail.ts";
import {
  sessionTreeRoot,
  sessionTreeRunCount,
  sessionTreeWorking,
  stoppableAncestors,
  SUBAGENT_TREE_RUN_CAP,
} from "./subagents/tree.ts";
import { isSubagentThreadRef } from "./sessions/thread-ref.ts";
import { createMemoryEmbedder } from "./model/embeddings.ts";
import { createSemanticMemory } from "./memory/semantic-memory.ts";
import { createPostgresBrokerSessions, type BrokerSessionStore } from "./auth/broker-sessions.ts";
import { createDirectFileUploads, type DirectFileUploads } from "./files/direct-file-upload.ts";
import { createPostgresFileUploadStore } from "./files/file-upload-store.ts";
import {
  createSandboxResources,
  type SandboxResource,
  type SandboxDefault,
  type SandboxResources,
} from "./sandbox/sandbox-resources.ts";
import { createAwsRoleBroker, type AwsRoleBroker } from "./auth/aws-role-broker.ts";
import type { SessionShare, SessionShareStore } from "./sessions/session-share.ts";
import { mkdirSync } from "node:fs";
import type { StagedEnvelope } from "./slack/envelope-staging.ts";
import type { HandledEvent } from "./slack/message-gating.ts";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  baseModelProviders,
  companySubscriptionAuth,
  configuredModel,
  enabledSandboxBackends,
  providerKeysPresent,
  type Config,
} from "./config.ts";
import type { ServerDeps } from "./api/deps.ts";
import {
  actorAssertionActive,
  createIdentityService,
  type DeactivationRecord,
  type IdentityService,
} from "./identity/identity-service.ts";
import {
  createPrincipalLinkService,
  type PrincipalLink,
  type PrincipalLinkService,
} from "./identity/principal-links.ts";
import type { SlackAccountLink, ComposioReturn } from "./api/routes/composio.ts";
import { installPrincipalLinks } from "./directory/person.ts";
import type { ExternalMember } from "./identity/external-members.ts";
import { resendMailer } from "../plugins/chassis/src/resend.ts";
import { createConfigStore, type ScopedConfigStore } from "./resolution/config-store.ts";
import { createResolutionService } from "./resolution/resolution-service.ts";
import { createAclStore, type AclStore } from "./acl/acl-store.ts";
import { createPostgresGrantStore } from "./acl/postgres-grant-store.ts";
import { createSkillStore, type SkillStore, type Skill } from "./skills/skill-store.ts";
import { createSkillPackStore, type SkillPack } from "./skills/skill-pack-store.ts";
import { createSkillBundleStore, type SkillBundle, type SkillBundleStore } from "./skills/skill-bundle-store.ts";
import { createGitFetcher, resolvePackAuth, type SkillPackFetcher } from "./skills/pack-fetcher.ts";
import { installSeedSkills } from "./skills/seed.ts";
import { createPostgresMapFactory, type DurableMap } from "./persistence/durable-map.ts";
import type { PersistedUiState, UiStateStore } from "./surfaces/ui-state.ts";
import { installSharedCanvas } from "./surfaces/ui-canvas.ts";
import { slackUserClientFactory } from "./inbox/sources/slack.ts";
import { configurePgCaTrust, configurePgPooling } from "./persistence/pg-pool.ts";
import { createPostgresLeaderLease, type LeaderLease } from "./persistence/leader-lease.ts";
import { createPostgresAdvisoryLock, type AdvisoryLock } from "./persistence/advisory-lock.ts";
import type {
  CommandApprovalGrant,
  Cron,
  InboxItem,
  Monitor,
  PendingApprovalRecord,
  ScopeId,
  Session,
  SurfaceContextRequest,
  TurnRequest,
  Webhook,
} from "./types.ts";
import { personalScope, scopeId } from "./types.ts";
import type { AuditLog } from "./audit/audit-log.ts";
import { createPostgresAuditLog } from "./admin/postgres-audit-log.ts";
import { createPostgresAppPageViewLog, type AppPageViewLog } from "./deploy/page-views.ts";
import type { RateLimiter } from "./ratelimit/rate-limiter.ts";
import { createPostgresRateLimiter, RATE_LIMIT } from "./ratelimit/postgres-rate-limiter.ts";
import { estimateCostUsd, type BudgetTracker } from "./ratelimit/budget.ts";
import type { SecurityScreenProbe } from "./security/security-screener.ts";
import { createPostgresBudgetTracker } from "./ratelimit/postgres-budget.ts";
import { createCronStore, type CronStore } from "./cron/cron-store.ts";
import { LOOPS_TO_CRONS_MIGRATION } from "./cron/migrations.ts";
import { createPostgresCronFireStore } from "./cron/fire-store.ts";
import {
  createInboxLedger,
  inboxConversationKeyMigration,
  INBOX_ITEM_SOURCE_MIGRATION,
  type InboxEventSink,
} from "./inbox/ledger.ts";
import { createPostgresLedgerEventBus, type LedgerEvent, type LedgerEventBus } from "./inbox/events.ts";
import { createInboxSourceRefresh } from "./inbox/source-refresh.ts";
import { createInboxRealtime } from "./inbox/realtime.ts";
import { createInboxChat } from "./inbox/item-chat.ts";
import type { InboxServiceDeps } from "./api/routes/cron-items.ts";
import { createOutbound, createWebSender, type Outbound, type QueuedPost } from "./surfaces/outbound.ts";
import { rememberDmPost, type RecentDmPosts } from "./surfaces/recent-dm-posts.ts";
import { wireRunResultPosts } from "./runs/run-results.ts";
import { adminSessionUrl } from "./util/admin-links.ts";
import type { DirectoryStore } from "./directory/directory-store.ts";
import { createPostgresDirectoryStore } from "./directory/postgres-directory-store.ts";
import { createPostgresEnvironmentStore, type EnvironmentStore } from "./environments/environment-store.ts";
import { createIdempotencyStore } from "./idempotency/idempotency-store.ts";
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
import {
  createE2bDeployProvider,
  E2B_DEPLOY_IDLE_TIMEOUT_SEC,
  type StoredE2bDeployBody,
} from "./deploy/e2b-deploy-provider.ts";
import type { DeployProvider } from "./deploy/deploy-provider.ts";
import { createDeployService } from "./deploy/deploy-service.ts";
import {
  createCanReadScope,
  createCanManageScope,
  createCanWriteScope,
  createCurrentScopeMembers,
  createIsCurrentSharedScopeMember,
  createManagesArtifactHome,
  rosterAdmits,
  type CanManageScope,
} from "./resolution/scope-membership.ts";
import type { DeployGitArchive } from "./deploy/deploy-git-store.ts";
import { createLocalWorkspaceStore, type WorkspaceStore } from "./workspace/workspace-store.ts";
import type { MemoryService } from "./memory/memory-service.ts";
import { createPostgresMemoryService } from "./memory/postgres-memory-service.ts";
import { createMcpServerStore, type McpServer, type McpServerStore } from "./mcp/mcp-server-store.ts";
import { createMcpToolService, type McpToolService } from "./mcp/mcp-tool-service.ts";
import {
  createLocalBlobTransferStore,
  createS3BlobTransferStore,
  type BlobTransferStore,
} from "./persistence/blob-transfer.ts";
import {
  createLocalDurableByteStore,
  createS3DurableByteStore,
  type DurableByteStore,
} from "./files/durable-byte-store.ts";
import type { FileArtifactStore } from "./files/file-artifact-store.ts";
import { createPostgresFileArtifactStore } from "./files/postgres-file-artifact-store.ts";
import { createLocalSandbox, type StoredLocalSandbox } from "./sandbox/local-sandbox.ts";
import { createSpritesSandbox, type StoredSpritesSandbox } from "./sandbox/sprites-sandbox.ts";
import { createSmolmachinesSandbox, type StoredSmolmachinesSandbox } from "./sandbox/smolmachines-sandbox.ts";
import { createE2bSandbox, E2B_TEMPLATE_TOOLS, type StoredE2bSandbox } from "./sandbox/e2b-sandbox.ts";
import { createSdkE2bClient, type E2bClient } from "./sandbox/e2b-client.ts";
import {
  createManagedAgentsSandbox,
  QM_TEMPLATE_TOOLS,
  type StoredManagedAgentsSandbox,
} from "./sandbox/managed-agents-sandbox.ts";
import { createSdkManagedAgentsClient } from "./sandbox/managed-agents-client.ts";
import { createModalSandbox, modalLegacyRecordMigration, type StoredModalSandbox } from "./sandbox/modal-sandbox.ts";
import { createSdkModalClient } from "./sandbox/modal-client.ts";
import { createSandboxRouter, type SandboxBackendName } from "./sandbox/sandbox-routing.ts";
import {
  upgradeLegacySandboxes,
  legacySandboxBackendForScope,
  type LegacyRoute,
} from "./sandbox/sandbox-resource-upgrade.ts";
import { effectiveEgressEnforcement, type BackendSandbox, type Sandbox } from "./sandbox/sandbox.ts";
import { createEnvSecretSource } from "./credentials/secret-source.ts";
import {
  credentialRequestHeaders,
  createKeychain,
  type ConnectorTokenStore,
  type OAuthToken,
  type Keychain,
  type KeychainAsk,
  type KeychainCredential,
  type KeychainGrant,
  type ServiceCredentialStore,
} from "./credentials/keychain.ts";
import {
  fireAskResolution,
  fireDropResolution,
  createAskExpirySweep,
  type DropResolution,
} from "./triggers/keychain-ask.ts";
import { createSecretDropStore, type SecretDropStore, type SecretDropRecord } from "./credentials/secret-drop.ts";
import { createConnectorStatusCache, type ConnectorStatusRecord } from "./credentials/connector-status.ts";
import { createFeatureFlagStore, externalAppSharingAllowed, type FeatureFlagStore } from "./feature-flags.ts";
import { makeRefresh, withPublicOAuthClients, type OAuthClientResolver, type OAuthState } from "./connectors/oauth.ts";
import {
  createConnectorClientResolver,
  deriveConnectorKey,
  type SecretKey,
} from "./connectors/connector-client-store.ts";
import {
  createBrowserSessionStore,
  type BrowserSessionStore,
  type StoredBrowserSession,
} from "./connectors/browser-session-store.ts";
import type { CredentialUsageSink } from "./admin/credential-usage-sink.ts";
import { createPostgresCredentialUsageSink } from "./admin/postgres-credential-usage-sink.ts";
import type { EgressAuditSink } from "./admin/egress-audit-sink.ts";
import { createPostgresEgressAuditSink } from "./admin/postgres-egress-audit-sink.ts";
import { createConsentLinkStore, type ConsentLinkStore, type ConsentLinkRecord } from "./connectors/consent-link.ts";
import { createOAuthFlowStore, type OAuthFlowStore } from "./connectors/oauth-flow-store.ts";
import { createModelGateway, type ModelGateway } from "./model/model-gateway.ts";
import { createModelCredentialStore, type ModelCredentialStore } from "./model/model-credential-store.ts";
import { refreshChatGPTTokens, refreshClaudeTokens } from "./model/subscription-oauth.ts";
import { createUserModelCredentialStore, type UserModelCredentialStore } from "./model/user-model-credential-store.ts";
import type { ModelGatewayTransportConfig } from "./model/provider-endpoints.ts";
import { setCustomProviders } from "./model/custom-providers.ts";
import { createCustomProviderStore, type CustomProviderStore } from "./model/custom-provider-store.ts";
import { createPostgresSessionStore } from "./sessions/postgres-session-store.ts";
import { createPostgresToolOutputStore } from "./sessions/tool-output.ts";
import { LLM_CAPTURE_RETENTION_MS, type SessionStore } from "./sessions/session-store.ts";
import { keychainCompanyChatGPTAuth, type CompanyChatGPTAuth } from "./model/company-chatgpt-auth.ts";
import { keychainHarnessAuthEnv } from "./credentials/harness-auth-env.ts";
import { createPiHarness, piHarnessConfigOptions, type ProviderKeys } from "./harness/pi-harness.ts";
import { withResolvedRuntime, resolveRuntimeChoiceDurable } from "./harness/runtime-choice.ts";
import { selectableModelCatalog } from "./model/model-catalog.ts";
import type { Harness } from "./harness/harness.ts";
import { createSecurityScreenProxy, type SecurityScreener } from "./security/security-screener.ts";
import { classifiedMemory } from "./memory/classification.ts";
import { createPerTurnStrategy, type PendingCapture } from "./memory/strategies/per-turn.ts";
import { createOrchestrator, egressClaimAllowingControlPlane, type OrchestratorDeps } from "./core/orchestrator.ts";
import {
  mintCapabilityToken,
  CAPABILITY_TTL_MS,
  CREDENTIAL_BROKER_AUD,
  DEPLOYMENT_CREDENTIAL_TTL_MS,
  EGRESS_PROXY_AUD,
} from "./auth/capability-token.ts";
import { createControlService } from "./api/control-service.ts";
import { createMemoryRunStore } from "./runs/memory-run-store.ts";
import { createPostgresRunStore } from "./runs/postgres-run-store.ts";
import { registerAbsurdSchema, TURN_QUEUES } from "./turns/absurd-schema.ts";
import { createMemoryRunSignalStore, type RunSignalStore } from "./runs/run-signal-store.ts";
import { createPostgresRunSignalStore } from "./runs/postgres-run-signal-store.ts";
import { isTerminal, type Run, type RunStore } from "./runs/run-store.ts";
import { createTurnLedger, TURN_CANCEL_CHANNEL, TURN_READY_CHANNEL, TURN_YIELD_CHANNEL } from "./turns/turn-ledger.ts";
import { createTurnRunner, type TurnRunner } from "./turns/turn-runner.ts";
import { repairStaleTurns, routeTurns } from "./turns/turn-engine.ts";
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
import { createPostgresProcessRegistry, type ProcessRegistry } from "./processes/process-registry.ts";
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
import { createTurnStream } from "./runs/turn-stream.ts";
import { createMemorySessionStateBus, type SessionStateBus } from "./runs/session-state-bus.ts";
import { createPostgresSessionStateBus } from "./runs/postgres-session-state-bus.ts";
import { createMemoryRunActivityStore, type RunActivityStore } from "./runs/run-activity-store.ts";
import { createPostgresRunActivityStore } from "./runs/postgres-run-activity-store.ts";
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
import {
  auxiliaryModelFor,
  CODEX_SUBSCRIPTION_PROVIDER,
  codexSubscriptionModelId,
  modelRequestOverrides,
  auxiliaryModelForProvider,
  defaultModel,
  resolveModel,
  modelSupported,
} from "./model/pi-models.ts";
import { createAdminService, parseAdminGrants, type AdminService } from "./admin/admin-service.ts";
import { createAdminGrantStore } from "./admin/admin-grant-store.ts";
import { createPostgresAdminGrantStore } from "./admin/postgres-admin-grant-store.ts";
import { createProjectStore, type Project, type ProjectStore } from "./projects/project-store.ts";
import { withErrorReporting, type ErrorLog } from "./admin/error-log.ts";
import { createPostgresReplayDedupe, type ReplayDedupe } from "./auth/replay-dedupe.ts";
import {
  emptyDeploymentLayer,
  loadDeploymentLayer,
  type BrokeredLayerTool,
  type DeploymentLayerRuntime,
} from "./deployment/load-layer.ts";
import {
  createDeploymentLayerStore,
  LAYER_CREATED_BY,
  LAYER_REVIEWER,
  type DeploymentLayerStore,
  type StoredDeploymentLayer,
} from "./deployment/deployment-layer-store.ts";
import { createPostgresErrorLog } from "./admin/postgres-error-log.ts";
import { errMessage, reportFailureAs, swallowAs } from "./util/errors.ts";
import { sleep, withTimeout } from "./util/async.ts";
import { createSlackInstallationStore, type SlackInstallationStore } from "./surfaces/slack-installation.ts";
import type { ContextRequestEvent } from "./api/app-types.ts";

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

export function buildApp(
  config: Config,
  overrides: {
    securityScreener?: SecurityScreener;
    credentialBrokers?: Record<string, AwsRoleBroker>;
    modelCredentialFetch?: typeof fetch;
    harness?: Harness;
    env?: NodeJS.ProcessEnv;
  } = {},
): BuiltApp {
  let backgroundAdmission = () => !config.backgroundDeploymentId;
  let backgroundActive = () => false;
  const admittedWork = createAdmittedWork({
    canStart: () => !config.backgroundDeploymentId || backgroundAdmission(),
  });
  let inlineShutdown = new AbortController();
  const createSweeper: typeof createUntrackedSweeper = (work, interval, options) =>
    createUntrackedSweeper(() => admittedWork.run(work), interval, options);
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

  const pgArtifactMap = createPostgresMapFactory(databaseUrl);
  registerAbsurdSchema(databaseUrl);
  const artifactMap = <T>(table: string, indexedFields?: readonly Extract<keyof T, string>[]): DurableMap<T> =>
    pgArtifactMap.map<T>(table, indexedFields);
  const unknownGatewayModels = Object.keys(config.modelGateway?.models ?? {}).filter((id) => !resolveModel(id));
  if (unknownGatewayModels.length) {
    throw new Error(`MODEL_GATEWAY_MODELS contains unsupported models: ${unknownGatewayModels.join(", ")}`);
  }
  const gatewayCatalog = config.modelGateway
    ? createGatewayCatalog(config.modelGateway, overrides.modelCredentialFetch)
    : undefined;
  const gatewayTransport = gatewayCatalog?.transport;
  const directProviderAvailability = providerKeysPresent(config);
  const directModelCredentials = createModelCredentialStore({
    backing: artifactMap("model_credentials"),
    keyMaterial: connectorSecretKey,
    fallback: {
      ...(config.anthropicApiKey ? { anthropic: config.anthropicApiKey } : {}),
      ...(config.openaiApiKey ? { openai: config.openaiApiKey } : {}),
      ...(config.openrouterApiKey ? { openrouter: config.openrouterApiKey } : {}),
    },
  });
  const modelCredentials: ModelCredentialStore = {
    ...directModelCredentials,
    async availability() {
      await gatewayCatalog?.refresh();
      const direct = await directModelCredentials.availability();
      return {
        ...direct,
        ...(directProviderAvailability.codexOAuth ? { codexOAuth: true } : {}),
        ...(config.claudeAuthCredential ? { anthropic: true } : {}),
        modelIds: new Set(Object.keys(gatewayTransport?.models ?? {})),
      };
    },
  };
  const advisoryLock: AdvisoryLock = createPostgresAdvisoryLock(pgArtifactMap.pool);
  const principalLinks = createPrincipalLinkService(artifactMap<PrincipalLink>("principal_links"), advisoryLock);
  installPrincipalLinks(principalLinks);
  const identity = createIdentityService(artifactMap<DeactivationRecord>("deactivated_principals"), {
    directorySyncProtected: config.emailAuthPrincipals,
    externalMembers: artifactMap<ExternalMember>("external_members"),
    principalLinks,
  });
  const leaderLease: LeaderLease = createPostgresLeaderLease(pgArtifactMap.pool);
  const configStore = createConfigStore(config.orgId, { databaseUrl, connectorSecretKey });
  const skills: SkillStore = createSkillStore({
    backing: artifactMap<Skill>("skills"),
    advisoryLock,
  });
  const skillPacks = createSkillPackStore({ backing: artifactMap<SkillPack>("skill_packs") });
  const skillBundles = createSkillBundleStore({ backing: artifactMap<SkillBundle>("skill_bundles") });
  const featureFlags = createFeatureFlagStore(databaseUrl);
  const teams = createPostgresTeamStore(databaseUrl, featureFlags, scopeId("org", config.orgId));
  const sessions: SessionStore = createPostgresSessionStore(databaseUrl);
  const adminGrantStore = createAdminGrantStore(createPostgresAdminGrantStore(databaseUrl), {
    seed: parseAdminGrants(config.adminGrants, config.orgId) ?? [],
  });
  const admin = createAdminService(adminGrantStore, { trustedOidcAdminIssuer: config.trustedOidcAdminIssuer });
  const directory = createPostgresDirectoryStore(databaseUrl);
  const projects = createProjectStore(artifactMap<Project>("projects"), {
    isActiveMember: (principalId) => identity.isInternal(identity.classify(principalId)),
    advisoryLock,
  });
  const canReadScope = createCanReadScope({ managedGroups: projects, directory, identity, teams, sessions });
  const canWriteScope = createCanWriteScope({ managedGroups: projects, directory, identity, teams });
  const canManageScope = createCanManageScope({ managedGroups: projects, directory, identity, sessions });
  const managesArtifactHome = createManagesArtifactHome(
    { managedGroups: projects, directory, identity, teams },
    canManageScope,
  );
  const currentScopeMembers = createCurrentScopeMembers({ managedGroups: projects, directory, identity });
  const isCurrentSharedScopeMember = createIsCurrentSharedScopeMember({ managedGroups: projects, directory, identity });
  const canUseSandboxScope: CanManageScope = async (actorId, scopeId) =>
    identity.isInternal(identity.classify(actorId)) &&
    ((await admin.adminStatusOf(identity.classify(actorId))).isAdmin || (await canWriteScope(actorId, scopeId)));
  const acl = createAclStore(createPostgresGrantStore(databaseUrl), {
    manages: (principalId, scopeId, authoredBy) => managesArtifactHome(scopeId, authoredBy ?? "", principalId),
    resolveFiles: (refs) => files.resolveByIds(refs),
  });
  const decisions = createPostgresDecisionStore(databaseUrl);
  const connectorStatusCache = createConnectorStatusCache(artifactMap<ConnectorStatusRecord>("connector_status"));
  const slackInstallation = createSlackInstallationStore(
    config.orgId,
    artifactMap("slack_installation"),
    connectorSecretKey,
  );
  const deploymentLayer = config.deploymentLayerDir
    ? loadDeploymentLayer(config.deploymentLayerDir)
    : emptyDeploymentLayer();
  const layerSkillsDir = config.deploymentLayerDir ? resolve(deploymentLayer.dir, "skills") : undefined;
  const brokeredTools = deploymentLayer.brokeredTools;
  const orgScope = scopeId("org", config.orgId);
  const auditLog = createPostgresAuditLog(databaseUrl);
  const deploymentLayerStore = createDeploymentLayerStore({
    backing: artifactMap<StoredDeploymentLayer>("deployment_layer"),
    runtime: deploymentLayer,
    skills,
    skillBundles,
    scopeId: orgScope,
    advisoryLock,
    auditPersisted: (record) =>
      auditLog.recordOnce!(`deployment-layer:${orgScope}:${record.version}`, {
        at: record.updatedAt,
        principalId: record.updatedBy,
        action: "deployment_layer.updated",
        resource: record.contentHash,
        scopeLabel: orgScope,
      }),
    ...(config.seedSkills && layerSkillsDir
      ? {
          seedFallback: () =>
            installSeedSkills(skills, {
              dir: layerSkillsDir,
              scopeId: orgScope,
              createdBy: LAYER_CREATED_BY,
              reviewer: LAYER_REVIEWER,
            }),
        }
      : {}),
  });
  const deploymentLayerRefresh = createUntrackedSweeper(() => deploymentLayerStore.hydrate(), 30_000, {
    label: "deployment layer refresh",
  });
  const installCatalogs = async (): Promise<void> => {
    await installSeedSkills(skills, { dir: resolve("./skills-seed"), scopeId: orgScope, respectArchived: true });
    for (const dir of config.pluginSkillDirs) {
      if (layerSkillsDir && resolve(dir) === layerSkillsDir) continue;
      await installSeedSkills(skills, {
        dir,
        scopeId: orgScope,
        createdBy: "system:plugin-skills",
        reviewer: "system:plugin-skills-reviewer",
        respectArchived: true,
      });
    }
  };
  let started: { ready: Promise<void>; skillsReady: Promise<void> } | undefined;
  // Startup I/O: hydrate stores, load the deployment layer, seed skill catalogs. Runs once, on the first call.
  const startOnce = () => {
    if (started) return started;
    const layerReady = deploymentLayerStore.hydrate();
    const layerSettled = layerReady.then(
      () => undefined,
      (e: unknown) => console.error("[seed] deployment layer not ready:", errMessage(e)),
    );
    const skillsReady = config.seedSkills
      ? Promise.all([
          installCatalogs().catch((e) => console.error("[seed] failed to install seed skills:", errMessage(e))),
          layerSettled,
        ]).then(() => undefined)
      : layerSettled;
    if (config.brokerCredentials?.length) warnShadowedBrokerCredentials(config.brokerCredentials);
    const identityReady = identity.hydrate();
    const configReady = configStore.hydrate?.();
    identityReady.catch(reportFailureAs("startup: hydrate identity", undefined));
    configReady?.catch(reportFailureAs("startup: hydrate configuration", undefined));
    const ready = Promise.all([identityReady, configReady, layerReady]).then(() => {});
    ready.catch(() => {}); // each part reports its own failure; start() callers still see the rejection
    started = { ready, skillsReady };
    return started;
  };
  const skillsReady: PromiseLike<void> = { then: (resolve, reject) => startOnce().skillsReady.then(resolve, reject) };
  const rateLimiter = createPostgresRateLimiter(databaseUrl, RATE_LIMIT);
  const budgetOpts = {
    ...(config.budgetUsdPerWindow !== undefined ? { limitUsd: config.budgetUsdPerWindow } : {}),
    ...(config.orgBudgetUsdPerWindow !== undefined ? { orgLimitUsd: config.orgBudgetUsdPerWindow } : {}),
  };
  const budget =
    config.budgetUsdPerWindow !== undefined || config.orgBudgetUsdPerWindow !== undefined
      ? createPostgresBudgetTracker(databaseUrl, budgetOpts)
      : undefined;
  const resolution = createResolutionService(config.orgId, configStore, acl);

  const workspace = createLocalWorkspaceStore(config.dataDir);
  const blobTransfer: BlobTransferStore = config.s3Bucket
    ? createS3BlobTransferStore({
        bucket: config.s3Bucket,
        ...(config.s3Region ? { region: config.s3Region } : {}),
        ...(config.s3Prefix ? { prefix: config.s3Prefix } : {}),
      })
    : createLocalBlobTransferStore(join(config.dataDir, "transfer"));
  const s3Bytes = (bucket: string, prefix: string): DurableByteStore =>
    createS3DurableByteStore({
      bucket,
      ...(config.s3Region ? { region: config.s3Region } : {}),
      prefix: `${config.s3Prefix ?? ""}${prefix}`,
    });
  // S3 under `prefix` when a bucket is configured, else local disk under dataDir/localDir.
  const byteStore = (prefix: string, localDir: string): DurableByteStore =>
    config.s3Bucket ? s3Bytes(config.s3Bucket, prefix) : createLocalDurableByteStore(join(config.dataDir, localDir));
  const fileBytes = byteStore("", "docstore");
  const files: FileArtifactStore = createPostgresFileArtifactStore(databaseUrl, fileBytes);
  const fileUploads = config.s3Bucket
    ? createDirectFileUploads({
        bucket: config.s3Bucket,
        ...(config.s3Region ? { region: config.s3Region } : {}),
        ...(config.s3Prefix ? { prefix: config.s3Prefix } : {}),
        store: createPostgresFileUploadStore(databaseUrl),
        files,
      })
    : undefined;
  const notebookMemory: MemoryService = createPostgresMemoryService(databaseUrl);
  const semanticMemory = createSemanticMemory({
    notebook: notebookMemory,
    databaseUrl,
    embeddingModel: () => configStore.getEmbeddingModelDurable(),
    resolveEmbedder: (id) => resolveMemoryEmbedder(id),
    leaderLease,
    createSweeper,
  });
  const baseMemory: MemoryService = withMemoryTidy(semanticMemory.memory, (scope) => memoryTidy.ensure(scope));
  const mcpServers = createMcpServerStore(artifactMap<McpServer>("mcp_servers"));
  const errors = withErrorReporting(createPostgresErrorLog(databaseUrl));
  const sandboxOnError = (
    e: { category: string; code: string; message: string; scopeLabel?: string },
    error?: unknown,
  ) =>
    errors.record(
      {
        category: e.category,
        code: e.code,
        message: e.message,
        scopeLabel: (e.scopeLabel ?? "unknown") as ScopeId,
      },
      error,
    );
  const sandboxShared = {
    ...config.sandbox,
    keepWarmSec: Math.ceil(BACKGROUND_JOB_TTL_MAX_MS / 1000),
    advisoryLock,
    blobTransfer,
    extraTools: deploymentLayer.advertisedTools,
    credentialPaths: deploymentLayer.credentialPaths,
    layerToolFiles: () => deploymentLayer.installFiles,
    ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
    ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
    onError: sandboxOnError,
  };
  const e2bBodies = artifactMap<StoredE2bSandbox>("e2b_sandbox_bodies");
  const modalBodies = artifactMap<StoredModalSandbox>("modal_sandbox_bodies");
  pgArtifactMap.pool.registerMigration(modalLegacyRecordMigration("modal_sandbox_bodies"));
  const buildLocal = (): BackendSandbox =>
    createLocalSandbox(workspace, {
      ...sandboxShared,
      ...config.localSandbox,
      store: artifactMap<StoredLocalSandbox>("local_sandbox_bodies"),
    });
  const buildSprites = (): BackendSandbox =>
    createSpritesSandbox(workspace, {
      ...sandboxShared,
      ...config.spritesSandbox,
      store: artifactMap<StoredSpritesSandbox>("sprites_initialization"),
      connectorSdk: loadConnectorSdk,
    });
  const buildSmolmachines = (): BackendSandbox =>
    createSmolmachinesSandbox(workspace, {
      ...sandboxShared,
      ...config.smolmachinesSandbox,
      store: artifactMap<StoredSmolmachinesSandbox>("smolmachines_sandbox_bodies"),
    });
  const e2bClient = (use: "computers" | "apps"): E2bClient => {
    const e2b = config.e2bSandbox;
    if (!e2b.apiKey)
      throw new Error(`${use === "apps" ? "DEPLOY_PROVIDER" : "SANDBOX_BACKEND"}=e2b requires E2B_API_KEY`);
    return createSdkE2bClient({
      apiKey: e2b.apiKey,
      ...(e2b.templateId ? { templateId: e2b.templateId } : {}),
      ...(use === "apps" ? { sandboxTtlMs: E2B_DEPLOY_IDLE_TIMEOUT_SEC * 1000 } : {}),
      ...(use === "computers" && config.sandbox.idleParkSec ? { sandboxTtlMs: config.sandbox.idleParkSec * 1000 } : {}),
      ...(config.sandbox.maxLifetimeSec ? { maxLifetimeMs: config.sandbox.maxLifetimeSec * 1000 } : {}),
      ...(use === "computers" && config.sandbox.egressProxyUrl
        ? { egressProxyUrl: config.sandbox.egressProxyUrl }
        : {}),
    });
  };
  const buildE2b = (): BackendSandbox =>
    createE2bSandbox(workspace, {
      ...sandboxShared,
      client: e2bClient("computers"),
      extraTools: [...(config.e2bSandbox.templateId ? E2B_TEMPLATE_TOOLS : []), ...deploymentLayer.advertisedTools],
      store: e2bBodies,
    });
  const buildManagedAgents = (): BackendSandbox => {
    const managedAgents = config.managedAgentsSandbox;
    if (!managedAgents.apiToken) throw new Error("SANDBOX_BACKEND=do-managed-agents requires DO_AGENTS_API_TOKEN");
    return createManagedAgentsSandbox(workspace, {
      ...sandboxShared,
      client: createSdkManagedAgentsClient({
        apiToken: managedAgents.apiToken,
        ...(managedAgents.template ? { template: managedAgents.template } : {}),
        ...(config.sandbox.idleParkSec ? { idleTimeoutSec: config.sandbox.idleParkSec } : {}),
        ...(config.sandbox.egressProxyUrl ? { egressProxyUrl: config.sandbox.egressProxyUrl } : {}),
      }),
      extraTools: [...(managedAgents.template ? QM_TEMPLATE_TOOLS : []), ...deploymentLayer.advertisedTools],
      store: artifactMap<StoredManagedAgentsSandbox>("do_managed_agents_sandbox_bodies"),
    });
  };
  const buildModal = (): BackendSandbox => {
    const modal = config.modalSandbox;
    if (!modal.tokenId || !modal.tokenSecret)
      throw new Error("SANDBOX_BACKEND=modal requires MODAL_TOKEN_ID and MODAL_TOKEN_SECRET");
    return createModalSandbox(workspace, {
      ...sandboxShared,
      client: createSdkModalClient({
        tokenId: modal.tokenId,
        tokenSecret: modal.tokenSecret,
        appName: modal.appName ?? "qm",
        ...(modal.image ? { image: modal.image } : {}),
        ...(modal.environment ? { environment: modal.environment } : {}),
        ...(config.sandbox.cpus !== undefined ? { cpus: config.sandbox.cpus } : {}),
        ...(config.sandbox.memoryMb !== undefined ? { memoryMb: config.sandbox.memoryMb } : {}),
        ...(config.sandbox.maxLifetimeSec ? { sandboxTimeoutMs: config.sandbox.maxLifetimeSec * 1000 } : {}),
        ...(config.sandbox.idleParkSec ? { idleTimeoutMs: 2 * config.sandbox.idleParkSec * 1000 } : {}),
        ...(config.sandbox.egressProxyUrl ? { egressProxyUrl: config.sandbox.egressProxyUrl } : {}),
      }),
      connectorSdk: loadConnectorSdk,
      store: modalBodies,
    });
  };
  const buildBackend: Record<Config["sandboxBackend"], () => BackendSandbox> = {
    local: buildLocal,
    sprites: buildSprites,
    smolmachines: buildSmolmachines,
    e2b: buildE2b,
    modal: buildModal,
    "do-managed-agents": buildManagedAgents,
  };
  const enabledBackends = new Set(enabledSandboxBackends(config));
  const sandboxBackends: Partial<Record<SandboxBackendName, BackendSandbox>> = {
    [config.sandboxBackend]: buildBackend[config.sandboxBackend](),
  };
  for (const name of Object.keys(buildBackend) as Array<Config["sandboxBackend"]>) {
    if (name !== config.sandboxBackend && enabledBackends.has(name)) sandboxBackends[name] = buildBackend[name]();
  }
  const sandboxRecords = artifactMap<SandboxResource>("sandbox_resources");
  const sandboxDefaults = artifactMap<SandboxDefault>("sandbox_defaults");
  const sandboxResources = createSandboxResources({
    records: sandboxRecords,
    defaults: sandboxDefaults,
    upgrade: () =>
      upgradeLegacySandboxes({
        availableBackends: Object.keys(sandboxBackends) as SandboxBackendName[],
        records: sandboxRecords,
        defaults: sandboxDefaults,
        marker: artifactMap<{ activatedAt: string }>("sandbox_resource_rollout"),
        routes: () => artifactMap<LegacyRoute>("sandbox_routing").entries(),
        lock: advisoryLock,
        legacyBackend: (scope) =>
          legacySandboxBackendForScope(scope, config.sandboxBackend, config.legacySandboxScopeDefaults),
        specFor: (backend) => sandboxBackends[backend]?.profile.spec,
        legacyScopes: async () => [
          ...(await sessions.distinctScopes()).map((scope) => scope.scopeId),
          ...(await environments.list()).map((environment) => environment.id),
        ],
        legacySandboxes: async () => {
          const [e2b, modal] = await Promise.all([e2bBodies.entries(), modalBodies.entries()]);
          return [
            ...e2b.map(([scopeId, body]) => ({ scopeId, backend: "e2b" as const, machineId: body.sandboxId })),
            ...modal.flatMap(([scopeId, body]) =>
              body.sandboxId ? [{ scopeId, backend: "modal" as const, machineId: body.sandboxId }] : [],
            ),
          ];
        },
      }),
    backends: sandboxBackends,
    defaultBackend: config.sandboxBackend,
    lock: advisoryLock,
    beforeRetire: async (record) => {
      if ((await processes?.liveByScope(record.ownerScopeId))?.some((process) => process.sandboxId === record.id))
        throw new Error("stop this sandbox's background jobs before retiring it");
    },
    provisionOptions: async (scopeId) => {
      const secret = config.capabilitySecret ?? config.signingSecret;
      if (!secret) return {};
      const egressToken = await mintCapabilityToken(
        {
          actorId: "system:sandbox-create",
          scopeId,
          aud: EGRESS_PROXY_AUD,
          egress: egressClaimAllowingControlPlane({ allowedHosts: [] }, config.apiBaseUrl ?? ""),
          exp: Date.now() + CAPABILITY_TTL_MS,
        },
        secret,
        config.capabilityTokenCompression,
      );
      return { egressToken };
    },
    canUseScope: canUseSandboxScope,
  });
  const sandbox: Sandbox = createSandboxRouter({
    resources: sandboxResources,
    backends: sandboxBackends,
    defaultBackend: config.sandboxBackend,
    onError: sandboxOnError,
  });
  const secretSource = createEnvSecretSource(overrides.env);
  const resolveClient: OAuthClientResolver = withPublicOAuthClients(
    createConnectorClientResolver({
      reader: configStore,
      orgScopeId: (o) => scopeId("org", o),
      secrets: secretSource,
    }),
  );
  const legacyCredentialKey =
    config.signingSecret && config.signingSecret !== connectorSecretKey
      ? deriveConnectorKey(config.signingSecret, "keychain")
      : undefined;
  const credentialKey: SecretKey = {
    ...deriveConnectorKey(connectorSecretKey, "keychain"),
    ...(legacyCredentialKey ? { fallbacks: [legacyCredentialKey] } : {}),
  };
  const credentialStore: Keychain = createKeychain({
    creds: artifactMap<KeychainCredential>("keychain_credentials", ["ownerId"]),
    grants: artifactMap<KeychainGrant>("keychain_grants", ["ownerId"]),
    asks: artifactMap<KeychainAsk>("keychain_asks"),
    key: credentialKey,
    lock: advisoryLock,
    refreshConnector: (() => {
      const base = makeRefresh({ resolveClient });
      // AI subscription logins ride the same connector-refresh machinery:
      // the keychain calls this single-flight when a token is stale.
      return async (host: string, token: OAuthToken, ctx?: { accountType?: string; clientRef?: string }) => {
        if (token.refreshToken && host === "auth.openai.com") {
          const fresh = await refreshChatGPTTokens(token.refreshToken);
          return oauthTokenFromUserTokens(fresh);
        }
        if (token.refreshToken && host === "claude.ai") {
          const fresh = await refreshClaudeTokens(token.refreshToken);
          return oauthTokenFromUserTokens(fresh);
        }
        return base(host, token, ctx);
      };
    })(),
  });
  const oauthTokenFromUserTokens = (fresh: {
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    accountId?: string;
    expiresAt?: number;
  }): OAuthToken => ({
    accessToken: fresh.accessToken,
    ...(fresh.refreshToken ? { refreshToken: fresh.refreshToken } : {}),
    ...(fresh.idToken ? { idToken: fresh.idToken } : {}),
    ...(fresh.accountId ? { accountId: fresh.accountId } : {}),
    ...(fresh.expiresAt !== undefined ? { expiresAt: fresh.expiresAt } : {}),
  });
  // Per-user AI accounts live in the keychain itself (unified custody):
  // same encryption, ownership, admin visibility, and removal flows as
  // every other personal credential.
  const userModelCredentials = createUserModelCredentialStore({ keychain: credentialStore });
  const keychain: Keychain = credentialStore;
  const serviceCreds = withDeploymentCredentials(
    credentialStore,
    scopeId("org", config.orgId),
    config.brokerCredentials ?? [],
  );
  const warnShadowedBrokerCredentials = (brokerCredentials: NonNullable<Config["brokerCredentials"]>) => {
    const reserved = new Set(brokerCredentials.map((c) => c.slug));
    void credentialStore.listServiceCredentials(scopeId("org", config.orgId)).then(
      (stored) => {
        const shadowed = stored.filter((c) => reserved.has(c.slug)).map((c) => c.slug);
        if (shadowed.length)
          console.warn(`[broker-credentials] BROKER_CREDENTIALS overrides stored credentials: ${shadowed.join(", ")}`);
      },
      (error) =>
        console.warn(`[broker-credentials] could not check for overridden stored credentials: ${errMessage(error)}`),
    );
  };
  const mcpToolService = createMcpToolService({
    servers: mcpServers,
    audit: auditLog,
    userTokens: keychain,
    ...(config.publicWebUrl
      ? {
          signInUrl: (id: string) =>
            `${config.publicWebUrl!.replace(/\/$/, "")}/connect/${encodeURIComponent(id)}/self-connect`,
        }
      : {}),
  });
  const browserSessionStore: BrowserSessionStore = createBrowserSessionStore({
    sessions: artifactMap<StoredBrowserSession>("browser_sessions"),
    key: credentialKey,
  });
  const connectorTokens = credentialStore;
  const consentLinks: ConsentLinkStore = createConsentLinkStore(artifactMap<ConsentLinkRecord>("consent_links"));
  const oauthFlows: OAuthFlowStore = createOAuthFlowStore(artifactMap<OAuthState>("oauth_flows"));
  const secretDrops: SecretDropStore = createSecretDropStore(artifactMap<SecretDropRecord>("secret_drops"));
  const modelGateway = createModelGateway();

  const toolOutput = createPostgresToolOutputStore({
    pool: pgArtifactMap.pool,
    bytesFor: (prefix) => byteStore(prefix, prefix),
  });
  const runStoreKind = config.runStore;
  const runSignals: RunSignalStore =
    runStoreKind === "postgres" ? createPostgresRunSignalStore(databaseUrl) : createMemoryRunSignalStore();
  const writeModelRegistry = <T>(fn: () => Promise<T>): Promise<T> =>
    advisoryLock.withLock("model-registry", async () => {
      await refreshModels();
      return fn();
    });
  const customProviders = createCustomProviderStore({
    write: writeModelRegistry,
    backing: artifactMap("custom_model_providers"),
    keyMaterial: connectorSecretKey,
  });
  const refreshCustomProviders = async () => {
    setCustomProviders(await customProviders.enabled());
  };
  const refreshModels = async () => {
    await gatewayCatalog?.refresh();
    await refreshCustomProviders();
  };
  const resolveMemoryEmbedder = async (id: string): Promise<MemoryEmbedder> => {
    const model = resolveEmbeddingModel(id);
    if (!model) throw new Error(`Embedding model unavailable: ${id}`);
    const key = model.provider === "openai" ? await modelCredentials.resolve("openai") : null;
    return createMemoryEmbedder(model, key, gatewayTransport, overrides.modelCredentialFetch);
  };
  const resolveModelProviderKeys = async () => {
    await refreshModels();
    const [anthropic, openai, openrouter, enabledCustom] = await Promise.all([
      modelCredentials.resolve("anthropic"),
      modelCredentials.resolve("openai"),
      modelCredentials.resolve("openrouter"),
      customProviders.enabled(),
    ]);
    const customKeys = Object.fromEntries(
      (
        await Promise.all(
          enabledCustom.map(async (p) => {
            try {
              return [p.id, await customProviders.resolveKey(p.id)] as const;
            } catch (e) {
              // A corrupt/undecryptable custom key must degrade that one
              // provider, never the whole turn (built-ins included).
              console.error(`[model] custom provider ${p.id}: key unreadable: ${errMessage(e)}`);
              return [p.id, null] as const;
            }
          }),
        )
      ).filter(([, key]) => key),
    );
    return {
      ...(anthropic ? { anthropic } : {}),
      ...(openai ? { openai } : {}),
      ...(openrouter ? { openrouter } : {}),
      ...customKeys,
    };
  };
  const companyChatGPTAuth: CompanyChatGPTAuth | undefined = config.codexAuthCredential
    ? keychainCompanyChatGPTAuth({ keychain, credentialId: config.codexAuthCredential })
    : undefined;
  const resolveCompanySubscriptionKeys = async (): Promise<ProviderKeys> => {
    if (!companyChatGPTAuth) return {};
    try {
      const token = await companyChatGPTAuth.accessToken();
      return token ? { [CODEX_SUBSCRIPTION_PROVIDER]: token } : {};
    } catch (e) {
      console.error(`[model] company ChatGPT auth (${companyChatGPTAuth.description}) unreadable: ${errMessage(e)}`);
      return {};
    }
  };
  const companyClaudeAuthEnv = config.claudeAuthCredential
    ? keychainHarnessAuthEnv(keychain, config.claudeAuthCredential, ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"])
    : undefined;
  const resolveCompanyClaudeKeys = async (): Promise<ProviderKeys> => {
    if (!companyClaudeAuthEnv) return {};
    const env = await companyClaudeAuthEnv();
    const token = env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN;
    if (!token)
      console.error(
        `[model] company Claude subscription credential ${config.claudeAuthCredential} yielded no token (missing, expired, or not an env credential)`,
      );
    return token ? { anthropic: token } : {};
  };
  const resolvePiProviderKeys = async (): Promise<ProviderKeys> => ({
    ...(await resolveCompanyClaudeKeys()),
    ...(await resolveModelProviderKeys()),
    ...(await resolveCompanySubscriptionKeys()),
  });
  const resolveBrowserCompanyKeys = async (includeSubscription = true): Promise<ProviderKeys> =>
    includeSubscription ? resolvePiProviderKeys() : resolveModelProviderKeys();
  const companyModelId = (id: string): string => {
    if (resolveModel(id)?.provider !== "openai" || modelRequestOverrides(id)) return id;
    const subscription = codexSubscriptionModelId(id);
    return resolveModel(subscription) ? subscription : id;
  };
  const runtimeOrgScope = scopeId("org", config.orgId);
  const orgBaseModelId = (): string | undefined => configStore.getRuntimeSelection(runtimeOrgScope)?.modelId;
  const deploymentDefaultModel = () =>
    defaultModel(
      configuredModel(config),
      baseModelProviders(config) ??
        (gatewayTransport
          ? { ...directProviderAvailability, modelIds: new Set(Object.keys(gatewayTransport.models)) }
          : undefined),
    );
  const pi =
    overrides.harness ??
    createPiHarness({
      ...piHarnessConfigOptions(config),
      modelGateway: gatewayTransport,
      resolveBaseModelId: () => orgBaseModelId() ?? deploymentDefaultModel(),
      resolveFallbackRuntime: () => configStore.getPurposeRuntime("fallback"),
      resolveProviderKeys: resolvePiProviderKeys,
      ...(directProviderAvailability.codexOAuth ? { companyModelId } : {}),
      signals: runSignals,
    });
  const fallback = {
    get modelId() {
      return deploymentDefaultModel();
    },
  };
  const decide = createDecisionHooks(
    decisions,
    createDecisionBackend({
      providers: (ids) => decisions.providers(ids),
      ...(config.modelGateway?.apiKey
        ? {
            gateway: {
              url: config.modelGateway.url,
              apiKey: config.modelGateway.apiKey,
              ...(config.modelGateway.apiKeyHeader ? { apiKeyHeader: config.modelGateway.apiKeyHeader } : {}),
            },
          }
        : {}),
      credential: async (slug) => {
        const rec = nonDeploymentCredential(
          await serviceCreds.getServiceCredentialSecret(scopeId("org", config.orgId), slug),
        );
        return rec ? { host: rec.host, enabled: rec.enabled, headers: credentialRequestHeaders(rec) } : null;
      },
    }),
    auditLog,
  );
  const judgeModelId = (): string => config.judgeModelId ?? auxiliaryModelFor(orgBaseModelId() ?? fallback.modelId);
  const hydrateModelCatalog = async (): Promise<unknown> => {
    await refreshModels();
    if (!(await modelCredentials.availability()).openrouter) return undefined;
    return selectableModelCatalog(overrides.modelCredentialFetch);
  };
  const harness = withResolvedRuntime(pi, async (input, routedBy) => {
    await refreshModels();
    const resolve = (requested: typeof input.runtime) =>
      resolveRuntimeChoiceDurable(
        configStore,
        runtimeOrgScope,
        input.scopeLabel,
        fallback,
        requested,
        hydrateModelCatalog,
        input.runtimePurpose,
      );
    const decision = await decide("turn_start", turnStartState(input), {
      ...(input.runtimeActorId ? { actorId: input.runtimeActorId } : {}),
      scopeLabel: input.scopeLabel,
      sessionId: input.session.id,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.cancel ? { cancel: input.cancel } : {}),
    });
    const routed = await routeTurnRuntime(decision, resolve, async () => {
      if (input.runtimePinned && input.runtime?.modelId) {
        if (!modelSupported(input.runtime.modelId)) throw new Error(`Unsupported model: ${input.runtime.modelId}`);
        return { ...input.runtime, modelId: input.runtime.modelId };
      }
      return resolve(input.runtime);
    });
    if (routed.routedBy) routedBy(routed.routedBy);
    return routed.choice;
  });

  if (config.securityScreenProxy) {
    delete harness.models.screenSecurity;
  }

  const leaseTtlMs = config.leaseTtlMs;
  const maxAttempts = config.maxAttempts;
  const runStore =
    runStoreKind === "postgres"
      ? createPostgresRunStore(databaseUrl, { maxClaims: RUN_MAX_CLAIMS })
      : createMemoryRunStore({ maxClaims: RUN_MAX_CLAIMS });
  const turnLedger =
    runStoreKind === "postgres"
      ? createTurnLedger(databaseUrl, { onTerminal: (run) => runStore.runs.emitTerminal?.(run) })
      : undefined;
  const turnRouting = routeTurns(runStore.runs, turnLedger, featureFlags);

  const blockingApprovalSessions = async (sessionIds: readonly string[]): Promise<Set<string>> => {
    if (!sessionIds.length) return new Set();
    const wanted = new Set(sessionIds);
    return new Set(
      (await approvals.select({ where: { field: "sessionId", anyOfFold: sessionIds } }))
        .filter(
          (r) => wanted.has(r.sessionId) && r.blocksInput !== false && actorAssertionActive(identity, r.request?.actor),
        )
        .map((r) => r.sessionId),
    );
  };
  const workingAncestors = async (session: Session) => {
    const candidates = await stoppableAncestors(sessions, session);
    const awaiting = await blockingApprovalSessions(candidates.map((ancestor) => ancestor.id));
    const ancestors = candidates.filter((ancestor) => !awaiting.has(ancestor.id));
    return Promise.all(
      ancestors.map(async (ancestor) => ({
        session: ancestor,
        participants: await sessions.participantsOf(ancestor.id),
      })),
    );
  };
  const runs: RunStore = {
    ...runStore.runs,
    cancelTurn: turnRouting.cancelTurn,
    cancelTree: turnRouting.cancelTree,
    withdraw: turnRouting.withdraw,
    leaseHeld: turnRouting.leaseHeld,
    async enqueue(input) {
      const enqueue = async () => {
        const known = await sessions.getByThread(input.sessionId);
        if (
          known &&
          (known.parentSessionId || (await sessions.childrenOf(known.id)).length > 0) &&
          !(input.dedupKey && (await runStore.runs.getByDedupKey(input.dedupKey))) &&
          (await sessionTreeRunCount(sessions, runStore.runs, await sessionTreeRoot(sessions, known))) >=
            SUBAGENT_TREE_RUN_CAP
        )
          throw new Error(`all ${SUBAGENT_TREE_RUN_CAP} session run slots are in use`);
        const participants = known ? await sessions.participantsOf(known.id) : [];
        const ancestors = known?.parentSessionId ? await workingAncestors(known) : [];
        const result = (await turnRouting.admit(input)) ?? (await runStore.runs.enqueue(input));
        if (result.deduped) return result;
        sessionStateBus.emit({
          threadRef: input.sessionId,
          ...(known ? { sessionId: known.id } : {}),
          state: "working",
          at: result.run.createdAt,
          participants: participants.length ? participants : [input.request.actor.id],
        });
        for (const ancestor of ancestors)
          sessionStateBus.emit({
            threadRef: ancestor.session.threadRef,
            sessionId: ancestor.session.id,
            state: "working",
            at: result.run.createdAt,
            participants: ancestor.participants,
          });
        return result;
      };
      return advisoryLock.withLock("session-run-admission", enqueue);
    },
  };
  const productAnalytics = createProductAnalytics(config.orgId, config.productAnalytics);
  runs.onTerminal((run) => void productAnalytics.responseFinished(run));
  const ledger = runStore.ledger;

  const processes = supportsProcessSessions(sandbox) ? createPostgresProcessRegistry(databaseUrl) : undefined;

  const appPageViews = config.awsDeploy.appsDomain ? createPostgresAppPageViewLog(databaseUrl) : undefined;
  const brokerSessions = createPostgresBrokerSessions(databaseUrl);
  const replayDedupe = createPostgresReplayDedupe(databaseUrl);
  const credentialUsage = createPostgresCredentialUsageSink(databaseUrl);
  const egressAudit = createPostgresEgressAuditSink(databaseUrl);
  const runStreamEvents = createPostgresNotifyBus<RunStreamEvent>(databaseUrl, "run_stream", "run-stream");
  const contextRequestEvents = createPostgresNotifyBus<ContextRequestEvent>(
    databaseUrl,
    "context_request_events",
    "context requests",
  );
  const refreshRunStream = (runId: string): void => runStreamEvents.emit({ runId, kind: "refresh" });
  const turnStream = createTurnStream({
    onDelta: (runId, text, offset, startOffset) => emitRunText(runStreamEvents, runId, text, offset, startOffset),
    onReasoning: (runId, block, text, offset) => emitRunReasoning(runStreamEvents, runId, block, text, offset),
    onChange: refreshRunStream,
  });
  const stopStreamSync = runStreamEvents.subscribe((event) => {
    if (event.kind !== "sync") return;
    const text = turnStream.snapshot(event.runId);
    const startOffset = turnStream.startOffset(event.runId);
    const offset = Math.max(event.offset, startOffset);
    if (text) emitRunText(runStreamEvents, event.runId, text.slice(offset - startOffset), offset, startOffset);
    for (const block of turnStream.reasoning(event.runId)) {
      const sent = event.reasoning?.[reasoningKey(block)] ?? 0;
      if (block.text.length > sent) emitRunReasoning(runStreamEvents, event.runId, block, block.text.slice(sent), sent);
    }
  });
  runs.onTerminal((run) => refreshRunStream(run.id));
  const sessionStateBus: SessionStateBus = config.databaseUrl
    ? createPostgresSessionStateBus(config.databaseUrl)
    : createMemorySessionStateBus();
  const ledgerEventBus: LedgerEventBus = createPostgresLedgerEventBus(databaseUrl);
  const activityStore: RunActivityStore =
    runStoreKind === "postgres" ? createPostgresRunActivityStore(databaseUrl) : createMemoryRunActivityStore();
  const runActivity: RunActivityStore = {
    ...activityStore,
    async append(runId, entry) {
      await activityStore.append(runId, entry);
      refreshRunStream(runId);
    },
  };
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
  const idempotency = createIdempotencyStore(databaseUrl);
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
  const environments = createPostgresEnvironmentStore(databaseUrl);
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
    id: "runtime/0002-drop-harness-choice",
    // The first release also dropped approved_harness_configs; that moved to CONTRACT_MIGRATIONS so older images still boot.
    acceptedChecksums: ["2e7a8523090c84d00b557197f2e3038b5b2fd418e6b3b4b08c10ef0cf596a792"],
    statements: [
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
    // The first release also dropped the swarms table; that moved to CONTRACT_MIGRATIONS so older images still boot.
    acceptedChecksums: ["6fd03996fb6c9b0b5ea06db198f83a16cf39dafbf7bc9fddb8965e54b3030635"],
    statements: [
      `DO $$ BEGIN IF to_regclass('runs') IS NOT NULL THEN UPDATE runs SET status = 'failed', result = json_build_object('status', 'failed', 'sessionId', session_id, 'reason', 'swarms were removed')::text, lease_token = NULL, lease_expires_at = NULL, worker_id = NULL, finished_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint WHERE status IN ('pending', 'running') AND (session_id LIKE 'swarm:%' OR request LIKE '%"swarm":%'); END IF; END $$`,
      "DO $$ BEGIN IF to_regclass('feature_flags') IS NOT NULL THEN DELETE FROM feature_flags WHERE id = 'swarms'; END IF; END $$",
    ],
  });
  const webhooks = createWebhookStore(artifactMap<Webhook>("webhooks"), artifactMap<WebhookHistory>("webhook_history"));
  const webUiBase = (config.slack?.webUiPublicUrl ?? config.publicWebUrl)?.replace(/\/+$/, "");
  const approvals = createApprovalStore(artifactMap<PendingApprovalRecord>("approvals", ["sessionId"]), outbound, {
    surfaces: chatSurfaces,
    webSessionUrl: (sessionId) => (webUiBase ? `${webUiBase}/s/${encodeURIComponent(sessionId)}` : undefined),
  });
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
  const sessionMailbox = createSessionMailbox(databaseUrl);
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
    ...(gatewayTransport ? { sandboxModels: true } : {}),
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
