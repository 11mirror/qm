import type { AdminToolAccess } from "./admin.ts";
import { type ToolOutputStore } from "../sessions/tool-output.ts";
import { type ExecutionFileCredential } from "../credentials/execute-files.ts";
import type { RuntimeRequest, RuntimeResult } from "../harness/runtime-types.ts";
import type { ComputerStatus, ExecResult } from "../sandbox/sandbox.ts";
import type { ApprovalGrantModes, ClientToolResult, Permission, ScopeId } from "../types.ts";
import { type PublishAudienceKind } from "../resolution/publish-audience.ts";
import type { BotPolicy } from "../surface-cache/channel-policy-store.ts";
import type { SessionSyscalls } from "../subagents/session-tools.ts";
import type {
  BackgroundStartResult,
  BackgroundPollResult,
  BackgroundStopResult,
  BackgroundWriteResult,
  BackgroundJobSummary,
} from "../connectors/background-exec-broker.ts";
import type { BackgroundWatchResult, BackgroundUnwatchResult } from "../monitors/monitor-broker.ts";
import { type OutboundFile } from "../core/attachments.ts";
import { type MemoryEdit } from "../memory/memory-service.ts";
import type {
  CronCreateRequest,
  CronCreateResult,
  CronPatchRequest,
  CronRunsRequest,
  CronRunsResult,
  WebhookCreateRequest,
  WebhookCreateResult,
} from "../api/control-service.ts";
import type { ControlOk, ControlErr } from "../api/control-result.ts";
import type { ShareArtifactRequest, ShareArtifactResult } from "../api/artifact-share.ts";
import type { Cron, Webhook } from "../types.ts";
import type { VisibleCron } from "../api/app.ts";

export interface PublishInput {
  dir?: string;
  entrypoint?: string;
  name?: string;
  renameFrom?: string;
  env?: Record<string, string>;
  rollbackTo?: number;
  alwaysOn?: boolean;
  embedAncestors?: string[];
  public?: boolean;
  share?: Array<{ scope: ScopeId; permission: Permission }>;
  sandboxId?: string;
}

export interface PublishAudienceDescriptor {
  kind: PublishAudienceKind;
  orgId?: string;
  channelRef?: string;
  memberCount?: number;
  snapshotAt?: number;
  note?: string;
}

export interface PublishResult {
  id: string;
  name?: string;
  version: number;
  url: string;
  audience?: PublishAudienceDescriptor;
  dataDir?: string;
  alwaysOn?: boolean;
  embedAncestors?: string[];
  public?: boolean;
}

export class NeedsApproval extends Error {
  command: string;
  approvalReason: string;
  kind: "approval";
  matched?: string;
  approvalKey?: string;
  grantModes?: ApprovalGrantModes;
  constructor(
    command: string,
    reason: string,
    kind: "approval" = "approval",
    matched?: string,
    approvalKey?: string,
    grantModes?: ApprovalGrantModes,
  ) {
    super(`command requires approval: ${command}`);
    this.name = "NeedsApproval";
    this.command = command;
    this.approvalReason = reason;
    this.kind = kind;
    this.matched = matched;
    this.approvalKey = approvalKey;
    this.grantModes = grantModes;
  }
}

export class CommandDenied extends Error {
  constructor(command: string, reason: string) {
    super(`command denied (${reason}): ${command}`);
    this.name = "CommandDenied";
  }
}

export interface ReadResult {
  content: string | null;
  sourceScopeId: ScopeId | null;
  shared?: true;
  outsideWorkspace?: true;
}

export interface SkillResult {
  content: string | null;
  sourceScopeId: ScopeId | null;
  dir?: string;
  packDir?: string;
}

export interface ReachedProvenance {
  scopeId: ScopeId;
  label: string;
}

export interface CommandCredential {
  handle: string;
  scratchOnly?: boolean;
  env?: Array<{ key: string; value: string; secret?: boolean }>;
  resolve?: () => Promise<{
    commit?: () => Promise<void>;
    singleUse?: boolean;
    files?: ExecutionFileCredential;
    env: Array<{ key: string; value: string; secret?: boolean }>;
  }>;
}

interface AttachedFileMeta {
  name: string;
  mimetype: string;
  sizeBytes: number;
  artifactId?: string;
}

export type AttachResult = { ok: true; files: AttachedFileMeta[]; staged: number } | { ok: false; message: string };

export type AttachFiles = (files: readonly OutboundFile[], sandboxId?: string) => Promise<AttachResult>;

export interface ToolContext extends SurfaceToolDeps {
  installSharedCanvas?: (fileId: string) => Promise<string | null>;
  admin?: AdminToolAccess;
  runtime?(request: RuntimeRequest, signal?: AbortSignal): Promise<RuntimeResult>;
  attach: AttachFiles;
  sessionSyscalls?: SessionSyscalls;
  humanTurn?: boolean;
  toolOutput?: Pick<ToolOutputStore, "inlineTokens" | "save">;
  commandCredentialHandles?: readonly string[];
  execute(
    command: string,
    opts?: {
      timeoutSeconds?: number;
      sandboxId?: string;
      scratch?: boolean;
      reachTarget?: string;
      signal?: AbortSignal;
      credentials?: string[];
    },
  ): Promise<ExecResult & { reached?: ReachedProvenance; scratchReroute?: boolean }>;
  sandboxResources?(
    action: "list" | "create" | "default" | "retire",
    input?: { backend?: string; name?: string; sandboxId?: string | null },
  ): Promise<unknown>;
  computerStatus(sandboxId?: string): Promise<ComputerStatus>;
  restartComputer(sandboxId?: string): Promise<void>;
  read(path: string, signal?: AbortSignal, sandboxId?: string): Promise<ReadResult>;
  listSkills(
    query?: string,
    offset?: number,
    limit?: number,
    source?: string,
  ): Promise<{
    sourceScopeId: ScopeId | null;
    skills: Array<{ name: string; description: string; source?: string }>;
    nextOffset?: number;
  }>;
  skill(
    name: string,
    opts?: { path?: string; sandboxId?: string; source?: string; signal?: AbortSignal },
  ): Promise<SkillResult>;
  write(path: string, data: string, sandboxId?: string): Promise<void>;
  publish(input: PublishInput): Promise<PublishResult>;
  setDeploymentPublic(id: string, isPublic: boolean): Promise<{ id: string; name?: string; public: boolean }>;
  memorySearch(q: string, limit?: number, scope?: ScopeId): Promise<string[] | null>;
  memoryRead(scope?: ScopeId): Promise<string | null>;
  memoryAdd(facts: string[]): Promise<number | null>;
  memoryEdit(edits: MemoryEdit[]): Promise<true | null>;
  memoryDelete(ids: string[]): Promise<true | null>;
  history(q: string, limit?: number): Promise<string[]>;
  historyOpen(seq: number): Promise<string | null>;
  callMcpTool(name: string, args: Record<string, unknown>, approval?: string): Promise<string>;
  mcpToolNeedsApproval(name: string, args: Record<string, unknown>): Promise<boolean>;
  awaitClientResult(
    callId: string,
    timeoutMs: number,
    signal?: AbortSignal,
    toolName?: string,
  ): Promise<ClientToolResult | "timeout" | "cancelled">;
  backgroundStart(
    command: string,
    opts: { purpose: string; ttlSeconds?: number; sandboxId?: string; credentials?: string[] },
  ): Promise<BackgroundStartResult & { jobComputer?: boolean }>;
  backgroundPoll(
    processId: string,
    opts?: { sinceCursor?: number; maxBytes?: number; waitSeconds?: number },
  ): Promise<BackgroundPollResult>;
  backgroundStop(processId: string, signal?: string): Promise<BackgroundStopResult>;
  backgroundWrite(processId: string, data: string): Promise<BackgroundWriteResult>;
  backgroundList(): Promise<BackgroundJobSummary[]>;
  backgroundWatch(
    processId: string,
    opts?: { instructions?: string; pattern?: string; sinceCursor?: number },
  ): Promise<BackgroundWatchResult>;
  backgroundUnwatch(monitorId: string): Promise<BackgroundUnwatchResult>;
  cronCreate(req: CronCreateRequest): Promise<CronCreateResult | ControlUnavailable>;
  cronList(): Promise<{ crons: Cron[]; visible: VisibleCron[] } | ControlUnavailable>;
  cronGet(id: string): Promise<ControlOk<{ cron: Cron }> | ControlErr<"not_found" | "forbidden"> | ControlUnavailable>;
  cronRuns(
    id: string,
    req?: CronRunsRequest,
  ): Promise<ControlOk<CronRunsResult> | ControlErr<"not_found" | "forbidden" | "bad_request"> | ControlUnavailable>;
  cronPatch(
    id: string,
    req: CronPatchRequest,
  ): Promise<
    | ControlOk<{ cron: Cron }>
    | ControlErr<"not_found" | "forbidden" | "bad_request" | "cron_update_failed">
    | ControlUnavailable
  >;
  cronNote(
    id: string,
    note: string,
  ): Promise<
    ControlOk<{ applied: boolean }> | ControlErr<"not_found" | "forbidden" | "bad_request"> | ControlUnavailable
  >;
  cronDelete(
    id: string,
  ): Promise<ControlOk<Record<never, never>> | ControlErr<"not_found" | "forbidden"> | ControlUnavailable>;
  cronSetEnabled(
    id: string,
    enabled: boolean,
  ): Promise<ControlOk<{ cron: Cron }> | ControlErr<"not_found" | "forbidden"> | ControlUnavailable>;
  cronRun(
    id: string,
  ): Promise<
    | ControlOk<{ fireKey: string }>
    | ControlErr<"not_found" | "forbidden" | "unavailable" | "bad_request" | "already_running">
    | ControlUnavailable
  >;
  webhookCreate(req: WebhookCreateRequest): Promise<WebhookCreateResult | ControlUnavailable>;
  webhookList(): Promise<Webhook[] | ControlUnavailable>;
  webhookDisable(
    id: string,
  ): Promise<ControlOk<Record<never, never>> | ControlErr<"not_found" | "forbidden"> | ControlUnavailable>;
  webhookUpdate(
    id: string,
    action: string,
  ): Promise<
    ControlOk<{ webhook: Webhook }> | ControlErr<"not_found" | "forbidden" | "bad_request"> | ControlUnavailable
  >;
  instructionsRead():
    { effectiveInstructions: string; instructions: string | null; instructionsVersion: number } | ControlUnavailable;
  instructionsWrite(
    content: string,
    expectedVersion?: number,
  ): Promise<
    | ControlOk<{ version: number }>
    | ControlErr<"instructions_update_denied" | "instructions_version_conflict" | "instructions_update_failed">
    | ControlUnavailable
  >;
  shareArtifact(req: ShareArtifactRequest): Promise<ShareArtifactResult | ControlUnavailable>;
}

interface SurfaceSearchToolOpts {
  limit?: number;
  source?: "mirror" | "slack";
}

interface SurfacePostOpts {
  ts?: string;
  broadcast?: boolean;
}

interface SurfaceReachTarget {
  channel?: string;
  recipient?: string;
  participants?: readonly string[];
}

export interface SurfaceReactInput {
  ts: string;
  emoji: string;
  channel?: string;
  participants?: readonly string[];
}

export interface SurfaceEditInput {
  ref: string;
  text: string;
  channel?: string;
  participants?: readonly string[];
}

export interface SurfaceDeleteInput {
  ref: string;
  channel?: string;
  participants?: readonly string[];
}

export interface PostedFileMeta {
  name: string;
  mimetype: string;
  sizeBytes: number;
  artifactId?: string;
}

export interface SurfacePostResult {
  ok: boolean;
  message?: string;
  matched?: string;
  attachments?: PostedFileMeta[];
}

interface SurfaceReadResult {
  ok: boolean;
  messages?: unknown[];
  message?: string;
}

interface SurfaceWhatsNewResult {
  ok: boolean;
  hereNew?: number;
  activeSubConversations?: number;
  latest?: string;
  coverageSince?: string;
  message?: string;
}

interface SurfaceSearchHit {
  ref?: string;
  author?: string;
  when?: string;
  snippet: string;
}
export interface SurfaceSearchResult {
  ok: boolean;
  hits?: SurfaceSearchHit[];
  source?: "cache" | "live" | "slack";
  coverageSince?: string;
  message?: string;
}

interface SurfaceMembersResult {
  ok: boolean;
  members?: Array<{ displayName: string }>;
  message?: string;
}

interface SurfaceFileResult {
  ok: boolean;
  content?: string;
  nextOffset?: number;
  name?: string;
  sizeBytes?: number;
  contentType?: string;
  message?: string;
}

type ChannelBehaviorResult =
  { ok: true; bots?: Record<string, BotPolicy>; ambientEnabled?: boolean } | { ok: false; message: string };

export interface SurfaceToolDeps {
  post(
    text: string,
    opts?: SurfacePostOpts,
    files?: readonly OutboundFile[],
    sandboxId?: string,
  ): Promise<SurfacePostResult>;
  reach(
    text: string,
    target: SurfaceReachTarget,
    files?: readonly OutboundFile[],
    sandboxId?: string,
  ): Promise<SurfacePostResult>;
  react(input: SurfaceReactInput): Promise<SurfacePostResult>;
  edit(input: SurfaceEditInput): Promise<SurfacePostResult>;
  delete(input: SurfaceDeleteInput): Promise<SurfacePostResult>;
  readThread(opts?: { limit?: number }): Promise<SurfaceReadResult>;
  whatsNew(opts?: { since?: string }): Promise<SurfaceWhatsNewResult>;
  search(query: string, opts?: SurfaceSearchToolOpts): Promise<SurfaceSearchResult>;
  readMembers(): Promise<SurfaceMembersResult>;
  readFile(ref: string, offset?: number): Promise<SurfaceFileResult>;
  getChannelBehavior(): Promise<ChannelBehaviorResult>;
  setChannelBehavior(bots?: Record<string, BotPolicy>, ambientEnabled?: boolean | null): Promise<ChannelBehaviorResult>;
}

export interface ControlUnavailable {
  ok: false;
  code: "control_unavailable";
  message: string;
}
export const CONTROL_UNAVAILABLE: ControlUnavailable = {
  ok: false,
  code: "control_unavailable",
  message: "the control plane (crons, webhooks, standing instructions) isn't available on this turn",
};
