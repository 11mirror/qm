import { type TeamStore } from "./teams/teams.ts";
import { type DecisionStore } from "./decisions/store.ts";
import { type KeychainApprovals } from "./credentials/keychain-approval.ts";
import { flushErrorReporting } from "../plugins/chassis/src/error-reporting.ts";
import { createAdmittedWork } from "./util/admitted-work.ts";
import { runSessionSmoke } from "./deployment/postdeploy-smoke.ts";
import { type BackgroundOwnershipControl } from "./runs/background-ownership.ts";
import { createSuggestedActivityService } from "./suggestions/activities.ts";
import { type BrokerSessionStore } from "./auth/broker-sessions.ts";
import { type DirectFileUploads } from "./files/direct-file-upload.ts";
import { type SandboxResources } from "./sandbox/sandbox-resources.ts";
import { type AwsRoleBroker } from "./auth/aws-role-broker.ts";
import type { SessionShareStore } from "./sessions/session-share.ts";
import { mkdirSync } from "node:fs";
import { companySubscriptionAuth, configuredModel, providerKeysPresent, type Config } from "./config.ts";
import type { ServerDeps } from "./api/deps.ts";
import { type IdentityService } from "./identity/identity-service.ts";
import { type PrincipalLinkService } from "./identity/principal-links.ts";
import type { ComposioReturns, SlackAccounts } from "./connectors/composio-links.ts";
import { resendMailer } from "../plugins/chassis/src/resend.ts";
import { type ScopedConfigStore } from "./resolution/config-store.ts";
import { type AclStore } from "./acl/acl-store.ts";
import { type SkillStore } from "./skills/skill-store.ts";
import { type SkillBundleStore } from "./skills/skill-bundle-store.ts";
import { type SkillPackFetcher } from "./skills/pack-fetcher.ts";
import type { UiStateStore } from "./surfaces/ui-state.ts";
import { slackUserClientFactory } from "./inbox/sources/slack.ts";
import { configurePgCaTrust, configurePgPooling } from "./persistence/pg-pool.ts";
import { type AdvisoryLock } from "./persistence/advisory-lock.ts";
import type { AuditLog } from "./audit/audit-log.ts";
import { type AppPageViewLog } from "./deploy/page-views.ts";
import type { RateLimiter } from "./ratelimit/rate-limiter.ts";
import { type BudgetTracker } from "./ratelimit/budget.ts";
import type { SecurityScreenProbe } from "./security/security-screener.ts";
import { type CronStore } from "./cron/cron-store.ts";
import { type LedgerEventBus } from "./inbox/events.ts";
import { createInboxSourceRefresh } from "./inbox/source-refresh.ts";
import type { InboxServiceDeps } from "./api/routes/cron-items.ts";
import { type Outbound } from "./surfaces/outbound.ts";
import type { DirectoryStore } from "./directory/directory-store.ts";
import { type EnvironmentStore } from "./environments/environment-store.ts";
import { type Scheduler } from "./cron/scheduler.ts";
import { type JobWorker } from "./jobs/job-worker.ts";
import { type WebhookReceiver } from "./webhooks/webhook-receiver.ts";
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
import { type DropResolution } from "./triggers/keychain-ask.ts";
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
import { type SessionStore } from "./sessions/session-store.ts";
import { type ProviderKeys } from "./harness/pi-model-runtime.ts";
import type { Harness } from "./harness/harness.ts";
import { type SecurityScreener } from "./security/security-screener.ts";
import { type RunSignalStore } from "./runs/run-signal-store.ts";
import { type RunStore } from "./runs/run-store.ts";
import { createSweeper as createUntrackedSweeper } from "./util/sweeper.ts";
import { type ProcessRegistry } from "./processes/process-registry.ts";
import { type MonitorStore } from "./monitors/monitor-store.ts";
import { type SessionStateBus } from "./runs/session-state-bus.ts";
import { type App } from "./api/app.ts";
import { type SlackCoreClient } from "./api/slack-core-client.ts";
import { type SurfaceRegistry } from "./surfaces/registry.ts";
import { type SurfaceCache } from "./surface-cache/surface-cache.ts";
import { type ChannelPolicyStore } from "./surface-cache/channel-policy-store.ts";
import { type AmbientJudgmentStore } from "./surface-cache/ambient-judgment-store.ts";
import { type AckEmojiPickStore } from "./surface-cache/ack-emoji-pick-store.ts";
import { type AdminService } from "./admin/admin-service.ts";
import { type ProjectStore } from "./projects/project-store.ts";
import { type ErrorLog } from "./admin/error-log.ts";
import { type ReplayDedupe } from "./auth/replay-dedupe.ts";
import { type BrokeredLayerTool, type DeploymentLayerRuntime } from "./deployment/load-layer.ts";
import { type DeploymentLayerStore } from "./deployment/deployment-layer-store.ts";
import { errMessage } from "./util/errors.ts";
import { sleep } from "./util/async.ts";
import { type SlackInstallationStore } from "./surfaces/slack-installation.ts";

import type { Gates, Head, Late } from "./wiring/late.ts";

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

import { buildTriggers } from "./wiring/triggers.ts";

import { buildSlackCore } from "./wiring/slack-core.ts";

import { buildSessionReturns } from "./wiring/session-returns.ts";

import { buildScheduler } from "./wiring/scheduler.ts";

import { buildReceivers } from "./wiring/receivers.ts";

import { buildWorkers } from "./wiring/workers.ts";

import { registerEveryJobs } from "./wiring/every-jobs.ts";

import { buildBackground } from "./wiring/background.ts";

import { assembleBuiltApp } from "./wiring/built-app.ts";

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
  slackAccounts: SlackAccounts;
  composioReturns: ComposioReturns;
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
  ambientJudgments: AmbientJudgmentStore;
  ackEmojiPicks: AckEmojiPickStore;
  channelPolicy: ChannelPolicyStore;
  uiState: UiStateStore;
  sessionShares: SessionShareStore;
  sessionShareBytes: DurableByteStore;
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
  const w0: Head = { config, overrides, gates, admittedWork, createSweeper, late, databaseUrl, connectorSecretKey };
  const w1 = { ...w0, ...buildStores(w0) };
  const w2 = { ...w1, ...buildModelCredentials(w1) };
  const w3 = { ...w2, ...buildFiles(w2) };
  const w4 = { ...w3, ...buildDeploymentLayer(w3) };
  const w5 = { ...w4, ...buildSandboxBackends(w4) };
  const w6 = { ...w5, ...buildSandbox(w5) };
  const w7 = { ...w6, ...buildCredentials(w6) };
  const w8 = { ...w7, ...buildModelKeys(w7) };
  const w9 = { ...w8, ...buildHarness(w8) };
  const w10 = { ...w9, ...buildStartup(w9) };
  const w11 = { ...w10, ...buildMemory(w10) };
  const w12 = { ...w11, ...buildRuns(w11) };
  const w13 = { ...w12, ...buildRunStreams(w12) };
  const w14 = { ...w13, ...buildOutbound(w13) };
  const w15 = { ...w14, ...buildDeploy(w14) };
  const w16 = { ...w15, ...buildCrons(w15) };
  registerLegacyMigrations(w16);
  const w17 = { ...w16, ...buildSessionSyscalls(w16) };
  const w18 = { ...w17, ...buildOrchestrator(w17) };
  const w19 = { ...w18, ...buildAppServices(w18) };
  const w20 = { ...w19, ...buildApiApp(w19) };
  const w21 = { ...w20, ...buildTriggers(w20) };
  const w22 = { ...w21, ...buildSlackCore(w21) };
  const w23 = { ...w22, ...buildSessionReturns(w22) };
  const w24 = { ...w23, ...buildScheduler(w23) };
  const w25 = { ...w24, ...buildReceivers(w24) };
  const w26 = { ...w25, ...buildWorkers(w25) };
  registerEveryJobs(w26);
  const w27 = { ...w26, ...buildBackground(w26) };
  return assembleBuiltApp(w27);
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
