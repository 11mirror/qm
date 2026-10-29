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
export { EXEC_TIMEOUT_DEFAULT_MS, EXEC_TIMEOUT_MAX_MS } from "./agent-tools/computer.ts";
import { withRetrySafety, withToolApprovalGate, withRuntimeBarrier } from "./agent-tools/wrappers.ts";
import { CONNECTOR_SHADOWED, CRON_ACTIONS, toolManifest, type ToolManifestEntry } from "./tool-manifest.ts";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Config } from "../config.ts";
import type { ClientToolDeclaration } from "../types.ts";
import type { TurnHalt, TurnToolState } from "./turn-tool-state.ts";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import { isObj } from "../util/objects.ts";

export interface AgentToolsOptions {
  sessionTools?: boolean;
  reachExec?: boolean;
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
    reachExec: config.reachExecEnabled,
    controlTools: Boolean(config.signingSecret),
  };
}

export function pauseStampAfterToolCall(
  halt: Pick<TurnHalt, "stopsTools">,
  prior?: (
    info: unknown,
    signal?: unknown,
  ) => Promise<{ terminate?: boolean } | undefined> | { terminate?: boolean } | undefined,
): (info: unknown, signal?: unknown) => Promise<{ terminate?: boolean } | undefined> {
  return async (info, signal) => {
    const upstream = prior ? await prior(info, signal) : undefined;
    if (halt.stopsTools()) return { ...upstream, terminate: true };
    return upstream;
  };
}

export function createAgentTools(state: TurnToolState, opts?: AgentToolsOptions): ToolDefinition[] {
  const { tools: ref, goal, halt } = state;
  const kit = createToolKit(ref, opts);
  const { controlTools, surfaceTools, delegateWork, retryMarks, recordCall, recordResult } = kit;
  const { execute, sandboxManagement, background, validateSandboxTool } = computerTools(kit, halt);

  const { discoverSkills, skill, read, installCanvas, write, publish } = workspaceTools(kit);

  const { memory, history } = memoryTools(kit);

  const { subagentTool, swarmTool, sessionTool } = conversationTools(kit);

  const { cron, webhook } = schedulingTools(kit);

  const { instructionsTool, sharingTool, resourceTool, adminTool } = controlPlaneTools(kit);

  const { surface, attach, finishSilently } = replyTools(kit, halt);

  const { createGoal, getGoal, updateGoal } = goalTools(kit, goal);

  const { mcpDefs, mcpCandidates, clientTools } = externalTools(kit);

  const { context, runtime } = runtimeTools(kit, goal, halt);

  const adminOperations = ref.current === null || Boolean(ref.current.admin?.operationsAvailable);
  const manifest = toolManifest({
    controlTools,
    surfaceTools,
    surfaceName: opts?.surfaceName,
    delegateWork,
    sessionTools: opts?.sessionTools !== false,
    readOnly: opts?.readOnly === true,
    canvasInstall: Boolean(ref.current?.installSharedCanvas),
    adminOperations,
    connectorTools: mcpDefs,
    clientTools: clientTools.map((tool) => tool.name),
  });
  const manifestActions = (name: string): string[] =>
    manifest.find((entry) => entry.source === "native" && entry.name === name)?.actions ?? [];
  const actionsOf = (name: string, all: Record<string, ToolDefinition>): Record<string, ToolDefinition> =>
    Object.fromEntries(manifestActions(name).map((action) => [action, all[action]!]));
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
    admin: adminTool(manifestActions("admin"), adminOperations),
    instructions: instructionsTool,
    [surface.name]: surface,
    attach,
    finish_silently: finishSilently,
    goal: resourceTool("goal", actionsOf("goal", { create: createGoal, get: getGoal, update: updateGoal })),
    runtime,
    context,
  };
  const client = new Map(clientTools.map((tool) => [tool.name, tool]));
  const connectors = manifest.filter((entry) => entry.source === "connector");
  const bySource = {
    native: (entry: ToolManifestEntry) => native[entry.name]!,
    client: (entry: ToolManifestEntry) => client.get(entry.name)!,
    connector: (entry: ToolManifestEntry) => mcpCandidates[connectors.indexOf(entry)]!,
  };
  const tools: ToolDefinition[] = [];
  for (const entry of manifest) {
    if (entry.present) tools.push(bySource[entry.source](entry));
    else if (entry.source === "connector" && entry.reason === CONNECTOR_SHADOWED)
      console.warn(`[mcp] ${entry.name} is hidden because a built-in tool has the same name`);
  }
  return tools.map((tool) => {
    const wrapped = withRuntimeBarrier(
      withToolApprovalGate(validateSandboxTool(tool), ref, halt, { recordCall, recordResult }),
      ref,
      halt,
    );
    return client.has(tool.name) ? wrapped : withRetrySafety(wrapped, retryMarks);
  });
}
