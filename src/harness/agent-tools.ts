import { runtimeTools } from "./agent-tools/runtime.ts";
import { externalTools } from "./agent-tools/external.ts";
import { goalTools } from "./agent-tools/goal.ts";
import { replyTools } from "./agent-tools/surface.ts";
import { controlPlaneTools } from "./agent-tools/control.ts";
import { schedulingTools } from "./agent-tools/cron.ts";
import { conversationTools } from "./agent-tools/sessions.ts";
import { memoryTools } from "./agent-tools/memory.ts";
import { workspaceTools } from "./agent-tools/workspace.ts";
import { computerTools } from "./agent-tools/computer.ts";
import { createToolKit } from "./agent-tools/kit.ts";
export { EXEC_TIMEOUT_DEFAULT_MS, EXEC_TIMEOUT_MAX_MS } from "./agent-tools/kit.ts";
import {
  withRetrySafety,
  withToolApprovalGate,
  withToolBodyTiming,
  withRuntimeBarrier,
} from "./agent-tools/wrappers.ts";
import { CONNECTOR_SHADOWED, CRON_ACTIONS, toolManifest } from "./tool-manifest.ts";
import type { DocumentInput } from "../core/document-inputs.ts";
import type { HarnessHandoff } from "./runtime-types.ts";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Config } from "../config.ts";
import type { ClientToolDeclaration, ScopeId } from "../types.ts";
import type { NewItem } from "../sessions/items.ts";
import type { ToolContext } from "../tools/primitives.ts";
import type { GapWork } from "../sessions/session-store.ts";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import { isObj } from "../util/objects.ts";
import { type GoalGovernor, type GoalRecord } from "./goal.ts";
import { type ToolResultScreenInput } from "../security/security-screen.ts";

export interface ToolContextRef {
  documents?: DocumentInput[];
  documentsStubbed?: boolean;
  runtimeHandoff?: HarnessHandoff;
  runtimeActorId?: string;
  runtimeMutationPending?: boolean;
  runtimeInFlight?: Set<Promise<unknown>>;
  current: ToolContext | null;
  pendingApprovals?: Array<{
    command: string;
    reason: string;
    kind?: "approval";
    matched?: string;
    purpose?: string;
    approvalKey?: string;
    summary?: string;
    grantModes?: { session: boolean; always: boolean };
  }>;
  pausedOnApproval?: boolean;
  emit?: (item: NewItem) => void | Promise<unknown>;
  scopeLabel?: ScopeId;
  orgScopeId?: ScopeId;
  llmCapture?: Array<{
    envelope: unknown;
    truncated: boolean;
    transport?: { modelId?: string; headers?: Record<string, string> };
  }>;
  modelCalls?: number;
  modelDispatch?: Array<{
    start: number;
    first?: number;
    gateway?: Record<string, string>;
    streamStart?: number;
    prepareNextTurn?: number;
    transformContext?: number;
  }>;
  pendingPrepareNextTurn?: number;
  pendingTransformContext?: number;
  onGapWork?: (work: GapWork) => void;
  fast?: boolean;
  abortSignal?: AbortSignal;
  shutdown?: AbortSignal;
  pollFire?: boolean;
  silentRequested?: boolean;

  goal?: GoalRecord | null;
  saveGoal?: (goal: GoalRecord) => Promise<void>;
  goalOpenedThisTurn?: boolean;

  goalRound?: number;

  goalMeter?: import("./grind.ts").GrindMeter;
  modelHasPrices?: () => boolean;
  governGoal?: GoalGovernor;
  /** The agent's recent work for the governor, newest last. */
  goalRecentWork?: () => string;
  observeToolResult?: (input: ToolResultScreenInput) => void;
  toolApprovalGate?: (callKey: string) => boolean;
  approvedToolCalls?: Map<string, string>;
}

export interface AgentToolsOptions {
  sessionTools?: boolean;
  scratchExec?: boolean;
  reachExec?: boolean;
  execTimeoutMs?: number;
  execTimeoutCeilingMs?: number;
  backgroundJobTtlMs?: number;
  backgroundJobTtlMaxMs?: number;
  mcpTools?: McpToolDescriptor[];
  controlTools?: boolean;
  readOnly?: boolean;
  surfaceTools?: boolean;
  delegateWork?: boolean;
  surfaceName?: string;
  clientTools?: readonly ClientToolDeclaration[];
}

export type CoreToolOptions = Omit<
  AgentToolsOptions,
  "readOnly" | "surfaceTools" | "surfaceName" | "delegateWork" | "clientTools"
>;

export function coreToolOptions(config: Config): CoreToolOptions {
  return {
    scratchExec: config.scratchExecEnabled,
    reachExec: config.reachExecEnabled,
    controlTools: Boolean(config.signingSecret && config.apiBaseUrl),
  };
}

export function pauseStampAfterToolCall(
  ref: Pick<ToolContextRef, "pausedOnApproval" | "silentRequested" | "runtimeHandoff">,
  prior?: (
    info: unknown,
    signal?: unknown,
  ) => Promise<{ terminate?: boolean } | undefined> | { terminate?: boolean } | undefined,
): (info: unknown, signal?: unknown) => Promise<{ terminate?: boolean } | undefined> {
  return async (info, signal) => {
    const upstream = prior ? await prior(info, signal) : undefined;
    if (ref.pausedOnApproval || ref.silentRequested || ref.runtimeHandoff) return { ...upstream, terminate: true };
    return upstream;
  };
}

export function createAgentTools(ref: ToolContextRef, opts?: AgentToolsOptions): ToolDefinition[] {
  const kit = createToolKit(ref, opts);
  const { controlTools, surfaceTools, delegateWork, retryMarks, recordCall, recordResult } = kit;
  const { execute, sandboxManagement, background, validateSandboxTool } = computerTools(kit);

  const { discoverSkills, skill, read, installCanvas, write, publish } = workspaceTools(kit);

  const { memory, history } = memoryTools(kit);

  const { subagentTool, swarmTool, sessionTool } = conversationTools(kit);

  const { cron, webhook } = schedulingTools(kit);

  const { instructionsTool, sharingTool, resourceTool, adminActions, adminPreamble } = controlPlaneTools(kit);

  const { surface, attach, finishSilently } = replyTools(kit);

  const { createGoal, getGoal, updateGoal } = goalTools(kit);

  const { mcpDefs, mcpCandidates, clientTools } = externalTools(kit);

  const { context, runtime } = runtimeTools(kit);

  const manifest = toolManifest({
    controlTools,
    surfaceTools,
    surfaceName: opts?.surfaceName,
    delegateWork,
    sessionTools: opts?.sessionTools !== false,
    readOnly: opts?.readOnly === true,
    canvasInstall: Boolean(ref.current?.installSharedCanvas),
    adminOperations: ref.current === null || Boolean(ref.current.admin?.operationsAvailable),
    connectorTools: mcpDefs,
    clientTools: clientTools.map((tool) => tool.name),
  });
  const actionsOf = (name: string, all: Record<string, ToolDefinition>): Record<string, ToolDefinition> =>
    Object.fromEntries(
      (manifest.find((entry) => entry.source === "native" && entry.name === name)?.actions ?? []).map((action) => [
        action,
        all[action]!,
      ]),
    );
  const admin = resourceTool("admin", actionsOf("admin", adminActions));
  if (ref.current === null || ref.current.admin?.operationsAvailable)
    admin.description = adminPreamble + admin.description;
  const files = {
    ...resourceTool(
      "files",
      actionsOf("files", { read, write, share: sharingTool("file"), install_canvas: installCanvas }),
    ),
    needsApproval: (params: unknown) => isObj(params) && params.action === "install_canvas",
    approvalReason: "install an always-on canvas someone shared with you; its code runs in your QM web UI",
  };
  const native: Record<string, ToolDefinition> = {
    execute,
    skills: resourceTool(
      "skills",
      actionsOf("skills", {
        list: discoverSkills(false),
        search: discoverSkills(true),
        read: skill,
        share: sharingTool("skill"),
        move: sharingTool("skill", true),
      }),
    ),
    files,
    apps: resourceTool(
      "apps",
      actionsOf("apps", { publish, share: sharingTool("deploy"), move: sharingTool("deploy", true) }),
    ),
    memory,
    history,
    background,
    subagents: subagentTool,
    swarm: swarmTool,
    sessions: sessionTool,
    sandbox: sandboxManagement,
    cron: resourceTool(
      "cron",
      actionsOf("cron", {
        ...Object.fromEntries(CRON_ACTIONS.map((action) => [action, cron])),
        share: sharingTool("cron"),
      }),
    ),
    webhook,
    admin,
    instructions: instructionsTool,
    [surface.name]: surface,
    attach,
    finish_silently: finishSilently,
    goal: resourceTool("goal", actionsOf("goal", { create: createGoal, get: getGoal, update: updateGoal })),
    runtime,
    context,
  };
  const bySource = {
    native: (entry: { name: string }) => native[entry.name]!,
    client: (_entry: unknown, index: number) => clientTools[index]!,
    connector: (_entry: unknown, index: number) => mcpCandidates[index]!,
  };
  const seen = { native: 0, client: 0, connector: 0 };
  const tools: ToolDefinition[] = [];
  for (const entry of manifest) {
    const index = seen[entry.source]++;
    if (entry.present) tools.push(bySource[entry.source](entry, index));
    else if (entry.source === "connector" && entry.reason === CONNECTOR_SHADOWED)
      console.warn(`[mcp] ${entry.name} is hidden because a built-in tool has the same name`);
  }
  const clientNames = new Set(clientTools.map((tool) => tool.name));
  return tools.map((tool) => {
    const wrapped = withRuntimeBarrier(
      withToolBodyTiming(withToolApprovalGate(validateSandboxTool(tool), ref, { recordCall, recordResult }), ref),
      ref,
    );
    return clientNames.has(tool.name) ? wrapped : withRetrySafety(wrapped, retryMarks);
  });
}
