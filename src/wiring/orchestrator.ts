import { type SurfaceCache, createPostgresSurfaceCache } from "../surface-cache/surface-cache.ts";
import { type ChannelPolicyStore, createPostgresChannelPolicyStore } from "../surface-cache/channel-policy-store.ts";
import { type OrchestratorDeps, createOrchestrator } from "../core/orchestrator.ts";
import { installSharedCanvas } from "../surfaces/ui-canvas.ts";
import { personalScope, type CommandApprovalGrant } from "../types.ts";
import { EXEC_TIMEOUT_DEFAULT_MS, EXEC_TIMEOUT_MAX_MS } from "../harness/agent-tools.ts";
import { BACKGROUND_JOB_TTL_MS, BACKGROUND_JOB_TTL_MAX_MS } from "../connectors/background-exec-broker.ts";
import { resendMailer } from "../../plugins/chassis/src/resend.ts";
import { createCurrentScopeMembers } from "../resolution/scope-membership.ts";
import type { OutboundModule } from "./outbound.ts";
import type { SessionSyscallsModule } from "./session-syscalls.ts";
import type { Late } from "./late.ts";
import type { DeploymentLayerModule } from "./deployment-layer.ts";
import type { RunsModule } from "./runs.ts";
import type { Config } from "../config.ts";
import type { ModelKeysModule } from "./model-keys.ts";
import type { StoresModule } from "./stores.ts";
import type { FilesModule } from "./files.ts";
import type { CredentialsModule } from "./credentials.ts";
import type { SandboxModule } from "./sandbox.ts";
import type { HarnessModule } from "./harness.ts";
import type { MemoryModule } from "./memory.ts";
import type { DeployModule } from "./deploy.ts";
import type { CronsModule } from "./crons.ts";
import type { ModelCredentialsModule } from "./model-credentials.ts";
import type { StartupModule } from "./startup.ts";
import type { RunStreamsModule } from "./run-streams.ts";

type BuildOrchestratorInputs = Pick<OutboundModule, "chatSurfaces" | "outbound" | "recentDmPosts"> &
  Pick<SessionSyscallsModule, "uiState" | "sessionSyscalls" | "layerBrokerFor"> &
  Pick<DeploymentLayerModule, "auditLog" | "brokeredTools" | "deploymentLayer"> &
  Pick<RunsModule, "sessionStateBus" | "ledger" | "runs"> &
  Pick<ModelKeysModule, "refreshModels"> &
  Pick<
    StoresModule,
    | "identity"
    | "configStore"
    | "sessions"
    | "admin"
    | "skills"
    | "skillBundles"
    | "advisoryLock"
    | "featureFlags"
    | "teams"
    | "connectorStatusCache"
    | "artifactMap"
    | "directory"
    | "isCurrentSharedScopeMember"
    | "projects"
    | "environments"
  > &
  Pick<
    FilesModule,
    "resolution" | "workspace" | "files" | "toolOutput" | "rateLimiter" | "budget" | "acl" | "errors" | "blobTransfer"
  > &
  Pick<
    CredentialsModule,
    | "userModelCredentials"
    | "connectorTokens"
    | "modelGateway"
    | "mcpToolService"
    | "resolveClient"
    | "keychain"
    | "serviceCreds"
  > &
  Pick<SandboxModule, "sandbox" | "sandboxResources"> &
  Pick<HarnessModule, "harness" | "runSignals" | "orgBaseModelId" | "fallback"> &
  Pick<MemoryModule, "memory" | "memoryStrategy"> &
  Pick<DeployModule, "deployService"> &
  Pick<CronsModule, "securityScreener" | "approvals" | "monitors" | "crons" | "webhooks"> &
  Pick<ModelCredentialsModule, "gatewayTransport"> &
  Pick<StartupModule, "skillsReady"> &
  Pick<RunStreamsModule, "turnStream" | "runActivity" | "credentialUsage" | "processes"> & {
    databaseUrl: string;
    late: Late;
    config: Config;
  };

export function buildOrchestrator(w: BuildOrchestratorInputs) {
  const { databaseUrl } = w;

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
    ...orchestratorDepsHead({ ...w, channelPolicy, surfaceCache }),
    ...orchestratorDepsTail(w),
  };
  const orchestrator = createOrchestrator(orchestratorDeps);
  return { orchestrator, surfaceCache, channelPolicy, orchestratorDeps };
}

function orchestratorDepsHead(
  w: BuildOrchestratorInputs & { channelPolicy: ChannelPolicyStore; surfaceCache: SurfaceCache },
) {
  const {
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
    channelPolicy,
    surfaceCache,
  } = w;
  return {
    channelPolicy,
    surfaceCache,
    surfaceLabel: chatSurfaces.label,
    installSharedCanvas: async (actorId, fileId, where) => {
      const canvas = await installSharedCanvas(uiState, actorId, await late.app.openFileForViewer(fileId, actorId));
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
  } satisfies Partial<OrchestratorDeps>;
}

function orchestratorDepsTail(w: BuildOrchestratorInputs) {
  const {
    config,
    identity,
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
  } = w;
  return {
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
  } satisfies Partial<OrchestratorDeps>;
}

export type OrchestratorModule = ReturnType<typeof buildOrchestrator>;
