import type { AdminToolAccess } from "./admin.ts";
import { type ToolOutputStore } from "../sessions/tool-output.ts";
import type { SkillResolution } from "../skills/skill-store.ts";
import type { MemoryCaptureMetadata } from "../memory/facts.ts";
import { withTimeout } from "../util/async.ts";
import { type TurnContext } from "../resolution/turn-context.ts";
import type { SandboxAccessPlan, SandboxResources } from "../sandbox/sandbox-resources.ts";
import type { CredentialPathSpec } from "../credentials/resident-paths.ts";
import type { ComputerStatus, Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import { CapabilityUnsupportedError } from "../sandbox/sandbox.ts";
import type {
  CommandPolicy,
  CommandRule,
  ConversationKind,
  GrantedHandle,
  Principal,
  ScopeId,
  WorkspaceLayer,
} from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { GapWork } from "../sessions/session-store.ts";
import type { SessionSyscalls } from "../subagents/session-tools.ts";
import { type ToolLedger } from "../runs/tool-ledger.ts";
import { type RunSignalStore } from "../runs/run-signal-store.ts";
import type { BackgroundExecBroker } from "../connectors/background-exec-broker.ts";
import type { MonitorBroker } from "../monitors/monitor-broker.ts";
import { type DeployService } from "../deploy/deploy-service.ts";
import type { AclStore } from "../acl/acl-store.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import type { ScopedConfigStore } from "../resolution/config-store.ts";
import { type MemoryService } from "../memory/memory-service.ts";
import type { McpToolService } from "../mcp/mcp-tool-service.ts";
import type { ReachResolution } from "../resolution/scope-reach.ts";
import type { ControlService } from "../api/control-service.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import {
  type SkillResult,
  type CommandCredential,
  type AttachFiles,
  type ToolContext,
  type SurfaceToolDeps,
} from "./primitives.ts";
import {
  executeOp,
  fileOps,
  publishOps,
  memoryAndHistoryOps,
  COMMAND_PATH_PROBE_TIMEOUT_MS,
} from "./tool-context-ops.ts";
import { backgroundOps, controlOps, surfaceOps } from "./tool-context-calls.ts";
import { sandboxAccess, callLedger, credentialStaging } from "./tool-context-env.ts";

export interface ToolContextDeps {
  desktopClientId?: string;
  admin?: AdminToolAccess;
  installSharedCanvas?: (fileId: string) => Promise<string | null>;
  sandbox: Sandbox;
  commandCredentials?: readonly CommandCredential[];
  resolveCommandCredentials?: (handles: readonly string[]) => Promise<readonly CommandCredential[]>;
  provision: () => Promise<SandboxHandle>;
  provisionScratch?: () => Promise<SandboxHandle>;
  provisionJobComputer?: () => Promise<SandboxHandle>;
  provisionResource?: (
    input: string | SandboxAccessPlan,
    authorize?: (access: SandboxAccessPlan) => void,
  ) => Promise<SandboxHandle>;
  accessSandboxResource?: (id: string) => Promise<SandboxAccessPlan>;
  listSkills?: (source?: string) => Promise<SkillResolution[]>;
  useSkill?: (name: string, path: string, sandboxId?: string, source?: string) => Promise<SkillResult>;
  reach?: {
    resolveChannel(query: string): Promise<ReachResolution>;
    provisionFor(scopeId: ScopeId): Promise<SandboxHandle>;
  };
  layers: WorkspaceLayer[];
  commandPolicy: () => CommandPolicy;
  layerCommandRules?: () => readonly CommandRule[];
  authorizeCommand: (command: string, approvalKey?: string, exactApprovalKey?: boolean) => boolean;
  grantedHandles: GrantedHandle[];
  context?: TurnContext;
  sandboxResources?: SandboxResources;
  invalidateProvision?: () => void;
  workspace: WorkspaceStore;
  deploy: DeployService;
  acl: AclStore;
  files?: FileArtifactStore;
  auditLog?: AuditLog;
  createdBy: string;
  publicWebUrl?: string;
  publishContext?: {
    conversationKind: ConversationKind;
    channelRef?: string;
    isPrivate?: boolean;
    isMpim?: boolean;
    publishMembers?: Principal[];
  };
  config?: ScopedConfigStore;
  memory?: MemoryService;
  memoryScopeId?: ScopeId;
  memoryCaptureMetadata?: () => MemoryCaptureMetadata;
  memoryAccess?: { write?: ScopeId; read: ScopeId[] };
  mcp?: McpToolService;
  sessionHistory?: {
    search(q: string, limit?: number): Promise<string[]>;
    open(seq: number): Promise<string | null>;
  };
  actingSlackUserId?: string;
  layerAuth?: {
    credentialPaths: readonly CredentialPathSpec[];
    splitEnvTemplates: ReadonlyArray<Record<string, string>>;
  };
  execTimeoutMs?: number;
  execTimeoutCeilingMs?: number;
  ledger?: ToolLedger;
  signals?: RunSignalStore;
  runId?: string;
  attempt?: number;
  backgroundBroker?: BackgroundExecBroker;
  monitorBroker?: MonitorBroker;
  onGapWork?: (work: GapWork) => void;
  control?: ControlService;
  controlClaims?: CapabilityClaims;
  webhookPublicUrl?: string;
  surface?: SurfaceToolDeps;
  attach?: AttachFiles;
  sessionSyscalls?: SessionSyscalls;
  humanTurn?: boolean;
  toolOutput?: ToolOutputStore;
  sessionId?: string;
}

export function createToolContext(deps: ToolContextDeps): ToolContext {
  const {
    writableScopeId,
    memory,
    fallbackMounts,
    persistExclude,
    accessSandbox,
    machine,
    provisionForCommand,
    authorizeExecution,
  } = sandboxAccess(deps);
  const { runId, timed, once, controlOp, surfaceOp } = callLedger(deps);
  const { selectCredentials, stageCredentials } = credentialStaging(deps, { writableScopeId });
  return {
    ...contextBasics(deps, { writableScopeId, accessSandbox }),
    ...computerOps(deps, { writableScopeId, accessSandbox }),
    ...executeOp(deps, { writableScopeId, provisionForCommand, timed, once, selectCredentials, stageCredentials }),
    ...fileOps(deps, { writableScopeId, memory, fallbackMounts, persistExclude, machine, timed, once }),
    ...publishOps(deps, { writableScopeId, accessSandbox, machine, once }),
    ...memoryAndHistoryOps(deps, { writableScopeId, memory, runId, timed, once }),
    ...backgroundOps(deps, {
      writableScopeId,
      provisionForCommand,
      authorizeExecution,
      once,
      selectCredentials,
      stageCredentials,
    }),
    ...controlOps(deps, { controlOp }),
    ...surfaceOps(deps, { surfaceOp }),
  };
}

function contextBasics(
  deps: ToolContextDeps,
  { writableScopeId, accessSandbox }: Pick<ReturnType<typeof sandboxAccess>, "writableScopeId" | "accessSandbox">,
) {
  return {
    ...(deps.admin ? { admin: deps.admin } : {}),
    ...(deps.installSharedCanvas ? { installSharedCanvas: deps.installSharedCanvas } : {}),
    ...(deps.toolOutput ? { toolOutput: deps.toolOutput } : {}),
    ...(deps.commandCredentials?.length
      ? { commandCredentialHandles: deps.commandCredentials.map((credential) => credential.handle) }
      : {}),
    ...(deps.sandboxResources && deps.accessSandboxResource
      ? {
          async sandboxResources(
            action: "list" | "create" | "default" | "retire",
            input?: { backend?: string; name?: string; sandboxId?: string | null },
          ): Promise<unknown> {
            if (!writableScopeId) throw new Error("sandbox management requires an owning scope");
            const resources = deps.sandboxResources!;
            if (action === "list") {
              const listed = await resources.list(deps.createdBy, writableScopeId);
              return {
                ...listed,
                sandboxes: (
                  await Promise.all(
                    listed.sandboxes.map(async (record) =>
                      deps.accessSandboxResource!(record.id)
                        .then((access) => access.resource)
                        .catch(swallowAs("sandbox list: access check", null)),
                    ),
                  )
                ).filter((record) => record !== null),
              };
            }
            if (action === "retire") {
              if (!input?.sandboxId) throw new Error("retire requires sandbox_id");
              const { resource } = await accessSandbox(input.sandboxId);
              await resources.retire(deps.createdBy, resource.id);
              return { retired: resource.id };
            }
            if (action === "default") {
              if (input?.sandboxId === undefined) throw new Error("default requires sandbox_id or null");
              await resources.setDefault(deps.createdBy, writableScopeId, input.sandboxId);
              deps.invalidateProvision?.();
              return { defaultSandboxId: input.sandboxId };
            }
            if (!input?.backend || !deps.provisionResource) throw new Error("create requires an available backend");
            const record = await resources.create(deps.createdBy, writableScopeId, input.backend, input.name);
            await deps.provisionResource(record.id);
            return record;
          },
        }
      : {}),
  } satisfies Partial<ToolContext>;
}

function computerOps(
  deps: ToolContextDeps,
  { writableScopeId, accessSandbox }: Pick<ReturnType<typeof sandboxAccess>, "writableScopeId" | "accessSandbox">,
) {
  return {
    async computerStatus(sandboxId?: string): Promise<ComputerStatus> {
      const probe = async (status: ComputerStatus, provision: () => Promise<SandboxHandle>) => {
        if (!status.provisioned || status.lifecycleState === "paused") return status;
        try {
          const code = await withTimeout(
            async () =>
              (await deps.sandbox.run(await provision(), "true", { timeoutMs: COMMAND_PATH_PROBE_TIMEOUT_MS })).code,
            COMMAND_PATH_PROBE_TIMEOUT_MS * 2,
            "command probe",
          );
          return { ...status, guestResponsive: code === 0 };
        } catch (e) {
          return { ...status, guestResponsive: false, probeError: errMessage(e) };
        }
      };
      if (sandboxId !== undefined) {
        const resources = deps.sandboxResources;
        if (!resources || !deps.provisionResource) throw new Error("sandbox inventory unavailable");
        const access = await accessSandbox(sandboxId);
        return probe(await resources.status(deps.createdBy, sandboxId), () => deps.provisionResource!(access));
      }
      if (!deps.sandbox.computerStatus) {
        throw new CapabilityUnsupportedError(deps.sandbox.profile.backend, "reporting computer status");
      }
      if (!writableScopeId) throw new Error("this turn has no scoped computer");
      return probe(await deps.sandbox.computerStatus(writableScopeId), deps.provision);
    },
    async restartComputer(sandboxId?: string): Promise<void> {
      if (sandboxId !== undefined) {
        const resources = deps.sandboxResources;
        if (!resources) throw new Error("sandbox inventory unavailable");
        await accessSandbox(sandboxId);
        return resources.restart(deps.createdBy, sandboxId);
      }
      if (!deps.sandbox.restartComputer) {
        throw new CapabilityUnsupportedError(deps.sandbox.profile.backend, "restarting the computer");
      }
      if (!writableScopeId) throw new Error("this turn has no scoped computer to restart");
      await deps.sandbox.restartComputer(writableScopeId);
    },
  } satisfies Partial<ToolContext>;
}
