import type { TraceCarrier } from "../../../plugins/chassis/src/error-reporting.ts";
import type { RunStop } from "../../runs/run-store.ts";
import type { ExternalSlackPolicies } from "../../resolution/external-slack.ts";
import type { RuntimeService } from "../../harness/runtime-types.ts";
import type { SandboxResources } from "../../sandbox/sandbox-resources.ts";
import type { AwsRoleBroker } from "../../auth/aws-role-broker.ts";
import type {
  Conversation,
  Principal,
  SurfaceContextQuery,
  SurfaceContextResult,
  TurnRequest,
  TurnResult,
} from "../../types.ts";
import type { IdentityService } from "../../identity/identity-service.ts";
import type { ResolutionService } from "../../resolution/resolution-service.ts";
import type { ModelAccount, OrgBranding, ScopedConfigStore } from "../../resolution/config-store.ts";
import type { UserModelCredentialStore } from "../../model/user-model-credential-store.ts";
import type { IsCurrentSharedScopeMember, ManagedGroupDirectory } from "../../resolution/scope-membership.ts";
import type { ProjectStore } from "../../projects/project-store.ts";
import type { DirectoryStore } from "../../directory/directory-store.ts";
import type { EnvironmentStore } from "../../environments/environment-store.ts";
import type { SessionStore } from "../../sessions/session-store.ts";
import type { SessionStateBus } from "../../runs/session-state-bus.ts";
import type { SessionSyscallsFactory } from "../../subagents/session-tools.ts";
import type { Outbound } from "../../surfaces/outbound.ts";
import type { RecentDmPosts } from "../../surfaces/recent-dm-posts.ts";
import type { WorkspaceStore } from "../../workspace/workspace-store.ts";
import type { Sandbox } from "../../sandbox/sandbox.ts";
import type { ProcessRegistry } from "../../processes/process-registry.ts";
import type { MonitorStore } from "../../monitors/monitor-store.ts";
import type { CronStore } from "../../cron/cron-store.ts";
import type { WebhookStore } from "../../webhooks/webhook-store.ts";
import type { ConnectorTokenStore, Keychain, ServiceCredentialStore } from "../../credentials/keychain.ts";
import type { FeatureFlagStore } from "../../feature-flags.ts";
import type { TeamStore } from "../../teams/teams.ts";
import type { CredentialUsageSink } from "../../admin/credential-usage-sink.ts";
import type { ConnectorStatusCache } from "../../credentials/connector-status.ts";
import type { ModelGateway } from "../../model/model-gateway.ts";
import type { AuditLog } from "../../audit/audit-log.ts";
import type { SecurityScreener } from "../../security/security-screener.ts";
import type { RateLimiter } from "../../ratelimit/rate-limiter.ts";
import type { BudgetTracker } from "../../ratelimit/budget.ts";
import type { ControlService } from "../../api/control-service.ts";
import type { Harness } from "../../harness/harness.ts";
import type { AdminService } from "../../admin/admin-service.ts";
import type { ErrorLog } from "../../admin/error-log.ts";
import type { JobWorker } from "../../jobs/job-worker.ts";
import type { ToolLedger } from "../../runs/tool-ledger.ts";
import type { RunSignalStore } from "../../runs/run-signal-store.ts";
import type { TurnStream } from "../../runs/turn-stream.ts";
import type { RunActivityStore } from "../../runs/postgres-run-activity-store.ts";
import type { RunStore } from "../../runs/run-store.ts";
import type { MemoryService } from "../../memory/memory-service.ts";
import type { McpToolService } from "../../mcp/mcp-tool-service.ts";
import type { MemoryStrategy } from "../../memory/strategy.ts";
import type { MemoryPolicy } from "../../memory/policy.ts";
import type { ApprovalGrants, ApprovalRecords } from "../approval-store.ts";
import type { BlobTransferStore } from "../../persistence/blob-transfer.ts";
import type { AdvisoryLock } from "../../persistence/advisory-lock.ts";
import type { SkillStore } from "../../skills/skill-store.ts";
import type { OAuthClientResolver } from "../../connectors/oauth.ts";
import type { SkillBundleStore } from "../../skills/skill-bundle-store.ts";
import type { BrokeredLayerTool, DeploymentLayerRuntime } from "../../deployment/load-layer.ts";
import type { FileArtifactStore } from "../../files/file-artifact-store.ts";
import type { ToolOutputStore } from "../../sessions/tool-output.ts";
import type { DeployService } from "../../deploy/deploy-service.ts";
import type { AclStore } from "../../acl/acl-store.ts";
import type { ChannelPolicyStore } from "../../surface-cache/channel-policy-store.ts";
import type { SurfaceCache } from "../../surface-cache/types.ts";

export interface OrchestratorInput extends Omit<
  TurnRequest,
  "surface" | "actor" | "conversation" | "idempotencyKey" | "spawned" | "async"
> {
  modelAccount?: ModelAccount;
  surface?: string;
  privateSessionMessage?: true;
  delegatingRunId?: string;
  sessionMessageDepth?: number;
  actor: Principal;
  conversation: Conversation;
  runId?: string;
  attempt?: number;
  resumeCause?: RunStop;
  runLeaseToken?: string;

  runStartedAt?: number;
  finalAttempt?: boolean;
  cancel?: AbortSignal;
  shutdown?: AbortSignal;
  sessionParticipantIds?: readonly string[];
  scopeVersion?: string;
  wakeCause?: "child_done";
  trace?: TraceCarrier;
}

export interface OrchestratorDeps {
  externalSlackPolicies?: ExternalSlackPolicies;
  refreshModels?: () => Promise<unknown>;
  identity: IdentityService;
  resolution: ResolutionService;
  config?: ScopedConfigStore;
  defaultTurnWallClockMs?: number;
  userModelCredentials?: UserModelCredentialStore;
  brandingDefault?: OrgBranding;
  resolveBaseModelId?: () => string | undefined;
  sessions: SessionStore;
  jobs: Pick<JobWorker, "handle" | "spawn">;
  sessionStateBus?: SessionStateBus;
  sessionSyscalls?: SessionSyscallsFactory;
  workspace: WorkspaceStore;
  files: FileArtifactStore;
  toolOutput?: ToolOutputStore;
  sandbox: Sandbox;
  sandboxResources?: SandboxResources;
  modelGateway: ModelGateway;
  auditLog: AuditLog;
  rateLimiter: RateLimiter;
  budget?: BudgetTracker;
  maxContextTokens?: number;
  execTimeoutMs?: number;
  execTimeoutCeilingMs?: number;
  approvalSummaryTimeoutMs?: number;
  turnLeaseWaitMs?: number;
  securityScreenTimeoutMs?: number;
  securityScreener?: SecurityScreener;
  backgroundJobTtlMs?: number;
  backgroundJobTtlMaxMs?: number;
  harness: Harness;
  signingSecret?: string;
  capabilitySecret?: string;
  apiBaseUrl?: string;
  sandboxModels?: boolean;
  publicWebUrl?: string;
  webhookPublicUrl?: string;
  deploy: DeployService;
  acl: AclStore;
  admin?: AdminService;
  memory: MemoryService;
  mcp?: McpToolService;
  memoryPolicy?: MemoryPolicy;
  memoryStrategy?: MemoryStrategy;
  skills?: SkillStore;
  skillBundles?: SkillBundleStore;
  skillsReady?: PromiseLike<void>;
  advisoryLock: AdvisoryLock;
  approvals: ApprovalRecords;
  approvalGrants: ApprovalGrants;
  errors?: ErrorLog;
  ledger?: ToolLedger;
  signals?: RunSignalStore;
  turnStream?: TurnStream;
  runActivity?: RunActivityStore;
  runs?: RunStore;
  blobTransfer: BlobTransferStore;
  processes?: ProcessRegistry;
  monitors?: MonitorStore;
  crons?: CronStore;
  webhooks?: WebhookStore;
  control?: ControlService;
  runtime?: RuntimeService;
  validateScheduledRuntime?: (
    scope: import("../../types.ts").ScopeId,
    choice: import("../../harness/harness.ts").RuntimeChoice,
    purpose?: import("../../resolution/config-store.ts").RuntimePurpose,
  ) => Promise<string | null>;
  connectorTokens?: ConnectorTokenStore;
  connectorStatusCache?: ConnectorStatusCache;
  resolveConnectorClient?: OAuthClientResolver;
  featureFlags?: FeatureFlagStore;
  installSharedCanvas?: (
    actorId: string,
    fileId: string,
    at: { threadRef: string; sessionId: string },
  ) => Promise<string | null>;
  teams?: TeamStore;
  credentialUsage?: CredentialUsageSink;
  keychain?: Keychain;
  serviceCreds?: ServiceCredentialStore;
  outbound?: Outbound;
  recentDmPosts?: RecentDmPosts;
  directory?: DirectoryStore;
  isCurrentSharedScopeMember?: IsCurrentSharedScopeMember;
  currentScopeMembers?: import("../../resolution/scope-membership.ts").CurrentScopeMembers;
  managedGroups?: Pick<ManagedGroupDirectory, "recognizes" | "members" | "version" | "withVersion" | "slackChannel"> &
    Pick<ProjectStore, "name">;
  reachExec?: boolean;
  environments?: EnvironmentStore;
  layerBrokerFor?: (tool: BrokeredLayerTool) => AwsRoleBroker | undefined;
  brokeredTools?: readonly BrokeredLayerTool[];
  deploymentLayer?: DeploymentLayerRuntime;
  surfaceContext?: SurfaceContextPuller;
  surfaceCache?: SurfaceCache;
  surfaceLabel?: (surface: string) => string | undefined;
  channelPolicy?: ChannelPolicyStore;
}

export interface SurfaceContextPuller {
  pull(source: string, query: SurfaceContextQuery): Promise<SurfaceContextResult | null>;
  searchLive?(source: string, query: SurfaceContextQuery): Promise<SurfaceContextResult | null>;
}

export interface Orchestrator {
  handleTurn(input: OrchestratorInput): Promise<TurnResult>;
  observeSecuritySteer(input: {
    payload: string;
    actor: Principal;
    conversation: Conversation;
    sessionId?: string;
  }): void;
  regenerateTitle(
    sessionId: string,
    principalId: string,
    participantIds?: readonly string[],
  ): Promise<{ title: string | null } | null>;
}
