// Wrappers applied to every agent tool: retry-safety marks, the approval gate, body timing and the runtime barrier.

import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { canonicalJson } from "../../../cli/src/canonical-json.ts";
import { redactSecrets } from "../../../plugins/chassis/src/redact-secrets.ts";
import { toolCallApprovalKey } from "../../core/approval-id.ts";
import { redactCommand } from "../../sandbox/exec-process-session.ts";
import { errMessage, reportFailure, swallow } from "../../util/errors.ts";
import { isObj } from "../../util/objects.ts";
import { type ToolContextRef } from "../agent-tools.ts";
import { optionalBoolean, text } from "./shared.ts";

const RETRY_SAFE_FIELD = "retrySafe";

const RETRY_SAFE_SCHEMA = optionalBoolean(
  "true if re-running this call is harmless (read or idempotent); false if it repeats a side effect like sending, charging or creating.",
);
const RERUN_INPUT_MAX_CHARS = 4_000;

export interface RetryMark {
  safe: boolean;
  rerun?: { tool: string; input: Record<string, unknown> };
}

function withRetrySafeField(parameters: unknown): unknown | null {
  if (!isObj(parameters) || parameters.type !== "object" || !isObj(parameters.properties)) return null;
  if (RETRY_SAFE_FIELD in parameters.properties) return null;
  return { ...parameters, properties: { ...parameters.properties, [RETRY_SAFE_FIELD]: RETRY_SAFE_SCHEMA } };
}

function stripRetrySafeField(params: unknown): { params: unknown; retrySafe?: boolean } {
  if (!isObj(params) || !(RETRY_SAFE_FIELD in params)) return { params };
  const { [RETRY_SAFE_FIELD]: retrySafe, ...rest } = params;
  return { params: rest, ...(typeof retrySafe === "boolean" ? { retrySafe } : {}) };
}

export function withRetrySafety(tool: ToolDefinition, marks: Map<string, RetryMark>): ToolDefinition {
  const parameters = withRetrySafeField(tool.parameters);
  if (!parameters) return tool;
  const inner = tool.execute.bind(tool);
  return {
    ...tool,
    parameters: parameters as ToolDefinition["parameters"],
    async execute(callId: string, params: unknown, ...rest: unknown[]) {
      const stripped = stripRetrySafeField(params);
      if (stripped.retrySafe !== undefined && isObj(stripped.params)) {
        const replayable = stripped.retrySafe && JSON.stringify(stripped.params).length <= RERUN_INPUT_MAX_CHARS;
        marks.set(callId, {
          safe: stripped.retrySafe,
          ...(replayable ? { rerun: { tool: tool.name, input: stripped.params } } : {}),
        });
      }
      try {
        return await (inner as (...args: unknown[]) => unknown)(callId, stripped.params, ...rest);
      } finally {
        marks.delete(callId);
      }
    },
  } as ToolDefinition;
}

const TOOL_APPROVAL_EXEMPT = new Set(["finish_silently"]);
const RESOURCE_TOOL_NAMES = new Set(["sandbox", "background", "files", "apps", "skills", "goal", "cron", "admin"]);
const STRICT_TOOL_APPROVAL_REASON = "strict posture: this tool call requires human approval";
const DECLARED_TOOL_APPROVAL_REASON = "this tool asks for approval before each call";
const APPROVAL_ARGS_MAX_CHARS = 16_000;

interface ToolApprovalDeclaration {
  needsApproval?: boolean | ((params: unknown) => boolean | Promise<boolean>);
  approvalReason?: string;
}

async function declaredApprovalReason(tool: ToolApprovalDeclaration, params: unknown): Promise<string | undefined> {
  const needed =
    typeof tool.needsApproval === "function" ? await tool.needsApproval(params) : tool.needsApproval === true;
  return needed ? (tool.approvalReason ?? DECLARED_TOOL_APPROVAL_REASON) : undefined;
}

function approvalCallText(label: string, params: unknown): string {
  return `${label} ${redactCommand(redactSecrets(canonicalJson(params ?? {})))}`;
}

export function withToolApprovalGate(
  tool: ToolDefinition & ToolApprovalDeclaration,
  ref: ToolContextRef,
  rec: {
    recordCall: (callId: string, payload: Record<string, unknown>) => Promise<void>;
    recordResult: <T extends { content: Array<{ type: string; text?: string }>; details?: unknown }>(
      callId: string,
      summary: Record<string, unknown>,
      ret: T,
      isError?: boolean,
    ) => Promise<T>;
  },
): ToolDefinition {
  if (TOOL_APPROVAL_EXEMPT.has(tool.name)) return tool;
  const inner = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(callId: string, params: unknown) {
      const gate = ref.toolApprovalGate;
      const resourceTool = RESOURCE_TOOL_NAMES.has(tool.name);
      const resourceAction =
        resourceTool && isObj(params) && typeof params.action === "string" ? params.action : undefined;
      const approvalIdentity = resourceTool ? `${tool.name}:${resourceAction ?? "invalid"}` : tool.name;
      const commandLabel = resourceAction ? `${tool.name} ${resourceAction}` : tool.name;
      let declaredReason: string | undefined;
      try {
        declaredReason = await declaredApprovalReason(tool, params);
      } catch (error) {
        reportFailure("tool approval: needsApproval check", error, tool.name);
        await rec.recordCall(callId, { tool: tool.name, blocked: "approval_check_failed", error: errMessage(error) });
        return rec.recordResult(
          callId,
          { tool: tool.name, blocked: "approval_check_failed" },
          text(`[error] could not check whether this call needs approval: ${errMessage(error)}`),
          true,
        );
      }
      const callKey = declaredReason ? toolCallApprovalKey(approvalIdentity, params) : undefined;
      if (callKey && canonicalJson(params ?? {}).length > APPROVAL_ARGS_MAX_CHARS) {
        const reason = `the arguments are too long to show on an approval card (over ${APPROVAL_ARGS_MAX_CHARS} characters); split the work into smaller calls`;
        await rec.recordCall(callId, { tool: tool.name, blocked: "approval_args_too_long" });
        return rec.recordResult(
          callId,
          { tool: tool.name, blocked: "approval_args_too_long" },
          text(`[blocked] ${reason}`),
          true,
        );
      }
      if (callKey ? !gate?.(approvalIdentity, callKey) : gate && !gate(approvalIdentity)) {
        const reason = declaredReason ?? STRICT_TOOL_APPROVAL_REASON;
        ref.pendingApprovals?.push(
          callKey
            ? {
                command: approvalCallText(commandLabel, params),
                reason,
                kind: "approval",
                approvalKey: callKey,
                summary: commandLabel,
                grantModes: { session: false, always: false },
                ...(isObj(params) && typeof params.purpose === "string" ? { purpose: params.purpose } : {}),
              }
            : {
                command: commandLabel,
                reason,
                kind: "approval",
                approvalKey: `tool:${approvalIdentity}`,
                ...(params === undefined ? {} : { summary: redactCommand(redactSecrets(JSON.stringify(params))) }),
                ...(isObj(params) && typeof params.purpose === "string" ? { purpose: params.purpose } : {}),
              },
        );
        ref.pausedOnApproval = true;
        await rec.recordCall(callId, {
          tool: tool.name,
          ...(resourceAction ? { action: resourceAction } : {}),
          ...(isObj(params) && typeof params.purpose === "string" ? { purpose: params.purpose } : {}),
          blocked: "needs_approval",
          reason,
        });
        return rec.recordResult(
          callId,
          {
            tool: tool.name,
            ...(resourceAction ? { action: resourceAction } : {}),
            blocked: "needs_approval",
            reason,
          },
          { ...text(`[blocked: needs human approval] ${reason}`), terminate: true },
          true,
        );
      }
      if (!callKey) return (inner as (callId: string, params: unknown) => unknown)(callId, params);
      const approved = (ref.approvedToolCalls ??= new Map());
      approved.set(callId, callKey);
      try {
        return await (inner as (callId: string, params: unknown) => unknown)(callId, params);
      } finally {
        approved.delete(callId);
      }
    },
  } as ToolDefinition;
}

export function withToolBodyTiming(tool: ToolDefinition, ref: ToolContextRef): ToolDefinition {
  const inner = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(callId: string, params: unknown) {
      const start = Date.now();
      try {
        return await (inner as (callId: string, params: unknown) => unknown)(callId, params);
      } finally {
        try {
          ref.onGapWork?.({ phase: "tool_body", tool: tool.name, start, end: Date.now() });
        } catch (error) {
          swallow("tool body timing sink", error);
        }
      }
    },
  } as ToolDefinition;
}

export function withRuntimeBarrier(tool: ToolDefinition, ref: ToolContextRef): ToolDefinition {
  return {
    ...tool,
    async execute(...args) {
      const [, params] = args;
      if (ref.runtimeHandoff || ref.runtimeMutationPending)
        return {
          ...text(
            "Runtime handoff in progress; this call was not executed. Resume unfinished work on the selected runtime.",
          ),
          terminate: !!ref.runtimeHandoff,
        };
      const mutation =
        tool.name === "context" || (tool.name === "runtime" && (!isObj(params) || params.action !== "get"));
      if (mutation) {
        ref.runtimeMutationPending = true;
        try {
          await Promise.allSettled(ref.runtimeInFlight ?? []);
          if (ref.abortSignal?.aborted || ref.pausedOnApproval || ref.silentRequested)
            return { ...text("Runtime change cancelled before execution."), terminate: true };
          return await tool.execute(...args);
        } finally {
          ref.runtimeMutationPending = false;
        }
      }
      const inFlight = (ref.runtimeInFlight ??= new Set());
      const result = Promise.resolve().then(() => tool.execute(...args));
      inFlight.add(result);
      try {
        return await result;
      } finally {
        inFlight.delete(result);
      }
    },
  };
}
