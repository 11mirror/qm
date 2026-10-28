import { parkedOutputKey } from "../sessions/tool-output.ts";
import { rankedSkills } from "../skills/materialize.ts";
import { MaskedExecutionError, executionSecretEnv, createExactSecretValueMasker } from "../security/secret-masking.ts";
import { withAbort } from "../util/async.ts";
import { readContextFile } from "../resolution/context-files.ts";
import { canReadNotebook, readNotebook, searchNotebooks } from "../memory/cross-scope.ts";
import { join } from "node:path";
import { workspacePathOf } from "../sandbox/exec-file-ops.ts";
import { interpolateSplitEnv } from "../deployment/deployment-layer.ts";
import type { ExecResult, Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import { CapabilityUnsupportedError, hasParentPathSegment, supportsAgentComputerExport } from "../sandbox/sandbox.ts";
import type { ScopeId } from "../types.ts";
import { parseScopeId, scopeId } from "../types.ts";
import { waitForClientResult } from "../runs/run-signal-store.ts";
import { deploymentEntrypoint } from "../deploy/deploy-service-support.ts";
import { type DeployFile } from "../deploy/deploy-service.ts";
import { publicUrlOf } from "../deploy/deploy-store.ts";
import { carriesGitMetadata } from "../deploy/deploy-fs.ts";
import { errMessage, withCleanup } from "../util/errors.ts";
import { MEMORY_FILE, type MemoryEdit } from "../memory/memory-service.ts";
import {
  type PublishInput,
  type PublishAudienceDescriptor,
  type PublishResult,
  type ReadResult,
  type SkillResult,
  type ReachedProvenance,
  type ToolContext,
} from "./primitives.ts";
import { type ToolContextDeps } from "./tool-context.ts";
import { scratchOnlyHandles, type sandboxAccess, type callLedger, type credentialStaging } from "./tool-context-env.ts";

export function executeOp(
  deps: ToolContextDeps,
  {
    writableScopeId,
    provisionForCommand,
    timed,
    once,
    selectCredentials,
    stageCredentials,
  }: Pick<ReturnType<typeof sandboxAccess>, "writableScopeId" | "provisionForCommand"> &
    Pick<ReturnType<typeof callLedger>, "timed" | "once"> &
    Pick<ReturnType<typeof credentialStaging>, "selectCredentials" | "stageCredentials">,
) {
  return {
    async execute(
      command: string,
      execOpts?: {
        timeoutSeconds?: number;
        sandboxId?: string;
        scratch?: boolean;
        reachTarget?: string;
        signal?: AbortSignal;
        credentials?: string[];
      },
    ): Promise<ExecResult & { reached?: ReachedProvenance; scratchReroute?: boolean }> {
      return once(async () => {
        const scratch = execOpts?.scratch === true;
        const requestedCredentials = execOpts?.credentials ?? [];
        if (requestedCredentials.length && (execOpts?.reachTarget !== undefined || !writableScopeId)) {
          throw new Error("command credentials are available only on scoped or scratch computers");
        }
        const requested = await selectCredentials(requestedCredentials);
        const scratchOnly = scratchOnlyHandles(requested);
        const reachTarget = execOpts?.reachTarget;
        if ([scratch, reachTarget !== undefined, execOpts?.sandboxId !== undefined].filter(Boolean).length > 1) {
          throw new Error("a command runs on one computer — choose scoped, scratch, or a reached room");
        }
        if ((scratch || scratchOnly) && !deps.provisionScratch) {
          throw new Error('scratch execution is not available on this computer — run without scope:"scratch"');
        }
        const scratchReroute = Boolean(scratchOnly) && !scratch;
        let reached: ReachedProvenance | undefined;
        if (reachTarget !== undefined) {
          if (!deps.reach) {
            throw new Error(
              "visiting another conversation's computer works from a DM — here, ask in that channel instead",
            );
          }
          const target = await deps.reach.resolveChannel(reachTarget);
          if (target.kind === "error") throw new Error(target.message);
          reached = { scopeId: target.scopeId, label: `#${target.channelName}` };
        }
        const handle = await provisionForCommand(
          command,
          scratchOnly ? undefined : execOpts?.sandboxId,
          requestedCredentials.length > 0,
          () => {
            if (reached) return deps.reach!.provisionFor(reached.scopeId);
            if (scratch || scratchOnly) return deps.provisionScratch!();
            return deps.provision();
          },
        );
        const resolvedMs = execOpts?.timeoutSeconds != null ? execOpts.timeoutSeconds * 1000 : deps.execTimeoutMs;
        const timeoutMs =
          resolvedMs != null && deps.execTimeoutCeilingMs != null
            ? Math.min(resolvedMs, deps.execTimeoutCeilingMs)
            : resolvedMs;
        const opts =
          timeoutMs !== undefined || execOpts?.signal
            ? {
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                ...(execOpts?.signal ? { signal: execOpts.signal } : {}),
              }
            : undefined;
        if (reached) {
          deps.auditLog?.record({
            at: Date.now(),
            principalId: deps.createdBy,
            action: "reach_exec",
            resource: command,
            scopeLabel: reached.scopeId,
          });
        }
        const executed = timed("exec", async () => {
          execOpts?.signal?.throwIfAborted();
          const { commandEnv, secretValues, fileExecution } = await stageCredentials(
            requested,
            handle,
            "command",
            execOpts?.signal,
          );
          const r = await withCleanup(
            async (): Promise<ExecResult> => {
              const commandHandle = Object.keys(commandEnv).length
                ? { ...handle, env: { ...handle.env, ...commandEnv } }
                : handle;
              const secretEnv = executionSecretEnv(commandHandle.env, secretValues);
              const mask = createExactSecretValueMasker(Object.values(secretEnv));
              try {
                const result = await deps.sandbox.run(commandHandle, command, opts);
                return { ...result, stdout: mask(result.stdout), stderr: mask(result.stderr) };
              } catch (error) {
                const message = errMessage(error);
                const masked = mask(message);
                if (masked !== message) throw new MaskedExecutionError(error, mask, masked);
                throw error;
              }
            },
            async () => {
              await fileExecution?.finish();
            },
          );
          return { ...r, ...(reached ? { reached } : {}), ...(scratchReroute ? { scratchReroute } : {}) };
        });
        return executed;
      });
    },
  } satisfies Partial<ToolContext>;
}

export function fileOps(
  deps: ToolContextDeps,
  {
    writableScopeId,
    memory,
    fallbackMounts,
    persistExclude,
    machine,
    timed,
    once,
  }: Pick<
    ReturnType<typeof sandboxAccess>,
    "writableScopeId" | "memory" | "fallbackMounts" | "persistExclude" | "machine"
  > &
    Pick<ReturnType<typeof callLedger>, "timed" | "once">,
) {
  return {
    async read(path: string, signal?: AbortSignal, sandboxId?: string): Promise<ReadResult> {
      signal?.throwIfAborted();
      if (path === MEMORY_FILE && memory && deps.memoryScopeId) {
        if (!deps.memoryAccess?.read.includes(deps.memoryScopeId)) {
          throw new Error("memory recall is not enabled for this conversation; use the `memory` tool when enabled");
        }
        const content = await withAbort(() => memory.read(deps.memoryScopeId!), signal);
        return { content, sourceScopeId: deps.memoryScopeId };
      }
      const sharedFile = deps.context
        ? await withAbort(() => deps.context!.readFile(path), signal)
        : await withAbort(() => readContextFile(path, deps.grantedHandles, deps.files), signal);
      if (sharedFile && "error" in sharedFile) return { content: sharedFile.error, sourceScopeId: null };
      if (sharedFile) {
        const { grant: granted, bytes } = sharedFile;
        if (bytes === null) return { content: null, sourceScopeId: granted.ownerScopeId };
        const asText = tryDecodeUtf8(bytes);
        if (asText !== null) return { content: asText, sourceScopeId: granted.ownerScopeId, shared: true };
        return {
          content: `[binary file ${granted.handlePath.split("/").pop()}, Files ID ${granted.fileId}; send it by ID]`,
          sourceScopeId: granted.ownerScopeId,
          shared: true,
        };
      }
      if (path.startsWith("shared/open-")) return { content: null, sourceScopeId: null };
      const parkedKey = parkedOutputKey(path);
      if (parkedKey && deps.toolOutput && deps.sessionId) {
        const parked = await withAbort(() => deps.toolOutput!.read(deps.sessionId!, parkedKey), signal);
        if (parked && "expired" in parked)
          return {
            content: `[the full output in ${path} expired after 30 days; only the cut shown in the transcript remains]`,
            sourceScopeId: writableScopeId,
          };
        if (parked) {
          const { handle } = await machine(sandboxId);
          await withAbort(() => deps.sandbox.writeFile(handle, path, parked.text), signal);
          return {
            content: `[copied the full output (${parked.text.length} chars) to ${path} on the computer; read the parts you need with execute, e.g. sed -n or grep]`,
            sourceScopeId: writableScopeId,
          };
        }
      }
      signal?.throwIfAborted();
      const { handle, resource, crossScope } = await machine(sandboxId);
      const mounts = crossScope ? fallbackMounts.filter((mount) => mount.mountPath === "global") : fallbackMounts;
      const rel = path.startsWith("/") ? workspacePathOf(handle.rootDir, path) : path;
      if (rel === null) return { content: null, sourceScopeId: null, outsideWorkspace: true };
      return timed("file_op", async () => {
        const direct = await withAbort(() => deps.sandbox.readFile(handle, rel), signal);
        if (direct !== null) return { content: direct, sourceScopeId: resource?.ownerScopeId ?? writableScopeId };
        for (const mount of mounts) {
          const v = await withAbort(() => deps.sandbox.readFile(handle, join(mount.mountPath, rel)), signal);
          if (v !== null) return { content: v, sourceScopeId: mount.scopeId };
        }
        return { content: null, sourceScopeId: null };
      });
    },
    async listSkills(query = "", offset = 0, limit = 50, source?: string) {
      const available = (await deps.listSkills?.(source)) ?? [];
      const matches = rankedSkills(available, query, [], Boolean(query));
      const start = Math.max(0, Math.floor(offset));
      const selected = matches.slice(start, start + Math.max(1, Math.min(100, Math.floor(limit))));
      const sourceScopeId = selected.length && source ? selected[0]!.skill!.scopeId : null;
      const end = start + selected.length;
      return {
        sourceScopeId,
        skills: selected.map(({ skill }) => ({
          id: skill!.id,
          name: skill!.manifest.name,
          description: skill!.manifest.description,
          source: skill!.scopeId,
        })),
        ...(end < matches.length ? { nextOffset: end } : {}),
      };
    },
    async skill(
      name: string,
      opts?: { path?: string; sandboxId?: string; source?: string; signal?: AbortSignal },
    ): Promise<SkillResult> {
      opts?.signal?.throwIfAborted();
      if (!deps.useSkill) return { content: null, sourceScopeId: null };
      if (opts?.sandboxId !== undefined && (!deps.sandboxResources || !deps.provisionResource))
        throw new Error("named sandboxes are not available here");
      return withAbort(
        () => deps.useSkill!(name, opts?.path ?? "SKILL.md", opts?.sandboxId, opts?.source),
        opts?.signal,
      );
    },
    async write(path: string, data: string, sandboxId?: string): Promise<void> {
      if (deps.memory && deps.memoryScopeId && isUnderAnyDir(path, ["memory"])) {
        throw new Error(
          `your durable memory isn't a file — use the \`memory\` tool instead (actions "add", "edit" and "delete")`,
        );
      }
      const { handle, resource, crossScope, durableRef } = await machine(sandboxId);
      if (crossScope) throw new Error("files write needs a computer owned by this conversation");
      const ownerScopeId = resource?.ownerScopeId ?? writableScopeId;
      const rel = path.startsWith("/") ? workspacePathOf(handle.rootDir, path) : path;
      if (rel === null)
        throw new Error(
          `${path} is not in the computer's workspace; only workspace files can be written, so name it relative to the workspace`,
        );
      await once(() =>
        timed("file_op", async () => {
          await deps.sandbox.writeFile(handle, rel, data);
          if (ownerScopeId && !isUnderAnyDir(rel, persistExclude))
            await deps.workspace.write(ownerScopeId, durableRef(rel), data);
        }),
      );
    },
  } satisfies Partial<ToolContext>;
}

export function publishOps(
  deps: ToolContextDeps,
  {
    writableScopeId,
    accessSandbox,
    machine,
    once,
  }: Pick<ReturnType<typeof sandboxAccess>, "writableScopeId" | "accessSandbox" | "machine"> &
    Pick<ReturnType<typeof callLedger>, "once">,
) {
  return {
    async publish(input: PublishInput): Promise<PublishResult> {
      if (!writableScopeId) throw new Error("publish needs a writable scope to own the app");
      if (input.share !== undefined || input.public !== undefined)
        throw new Error("publish does not accept sharing options; use apps action share to change access");
      const owner: ScopeId = scopeId("personal", deps.createdBy);
      const createdInScope: ScopeId = writableScopeId;
      let effectiveEntrypoint = input.entrypoint;
      if (effectiveEntrypoint === undefined && input.rollbackTo === undefined) {
        const shouldInheritForRename = input.renameFrom !== undefined && input.dir !== undefined;
        const priorName =
          input.renameFrom === undefined || shouldInheritForRename ? (input.renameFrom ?? input.name) : undefined;
        const prior = priorName ? await deps.deploy.getDeployment(priorName) : null;
        effectiveEntrypoint = deploymentEntrypoint(prior);
        if (!effectiveEntrypoint && input.renameFrom === undefined) {
          throw new Error('publish requires an entrypoint, e.g. "node server.js"');
        }
      }
      if (effectiveEntrypoint && input.dir && hasParentPathSegment(input.dir)) {
        throw new Error("publish directory must stay inside the workspace — no .. path segments");
      }
      if (!effectiveEntrypoint && input.sandboxId !== undefined) await accessSandbox(input.sandboxId);
      const files: DeployFile[] = effectiveEntrypoint
        ? filesUnder(await collectTree(deps.sandbox, (await machine(input.sandboxId)).handle, input.dir), input.dir)
        : [];
      if (effectiveEntrypoint && files.length === 0) {
        throw new Error(`publish: no files found under ${input.dir ?? "."} - nothing to deploy`);
      }
      const authEnv = effectiveEntrypoint
        ? Object.assign(
            {},
            ...(deps.layerAuth?.splitEnvTemplates ?? []).map((template) =>
              interpolateSplitEnv(template, { actingSlackUserId: deps.actingSlackUserId }),
            ),
          )
        : {};

      return once(async () => {
        const d = await deps.deploy.deployOrUpdate({
          ownerScopeId: owner,
          createdBy: deps.createdBy,
          createdInScope,
          files,
          ...(input.entrypoint ? { entrypoint: input.entrypoint } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.renameFrom !== undefined ? { renameFrom: input.renameFrom } : {}),
          ...(input.env !== undefined ? { env: input.env } : {}),
          ...(Object.keys(authEnv).length ? { stampEnv: authEnv } : {}),
          ...(input.rollbackTo !== undefined ? { rollbackTo: input.rollbackTo } : {}),
          ...(input.alwaysOn !== undefined ? { alwaysOn: input.alwaysOn } : {}),
          ...(input.embedAncestors !== undefined ? { embedAncestors: input.embedAncestors } : {}),
        });
        const ref = d.name ?? d.id;
        const grantees = await deps.deploy.deploymentGrantees(d.id);
        const audience = audienceFromGrantees(
          grantees.map((g) => g.scope),
          d.createdInScope,
        );
        const urlBase = deps.publicWebUrl ?? "";
        const url = publicUrlOf(d.endpoint) ?? `${urlBase}/d/${ref}/`;
        const dataDir = effectiveEntrypoint ? deps.deploy.providerProfile?.dataDir : undefined;
        return {
          id: d.id,
          ...(d.name ? { name: d.name } : {}),
          version: d.currentVersion,
          url,
          audience,
          ...(dataDir ? { dataDir } : {}),
          ...(d.alwaysOn ? { alwaysOn: true } : {}),
          ...(d.embedAncestors?.length ? { embedAncestors: d.embedAncestors } : {}),
          ...(d.public ? { public: true } : {}),
        };
      });
    },
    async setDeploymentPublic(id: string, isPublic: boolean) {
      const d = await deps.deploy.setDeploymentPublic(id, isPublic, { createdBy: deps.createdBy });
      return { id: d.id, ...(d.name ? { name: d.name } : {}), public: d.public === true };
    },
  } satisfies Partial<ToolContext>;
}

export function memoryAndHistoryOps(
  deps: ToolContextDeps,
  {
    writableScopeId,
    memory,
    runId,
    timed,
    once,
  }: Pick<ReturnType<typeof sandboxAccess>, "writableScopeId" | "memory"> &
    Pick<ReturnType<typeof callLedger>, "runId" | "timed" | "once">,
) {
  return {
    async memorySearch(q: string, limit?: number, scope?: ScopeId): Promise<string[] | null> {
      if (deps.context) return timed("recall", () => deps.context!.searchMemory(q, limit, scope));
      if (!memory) return null;
      return timed("recall", () =>
        searchNotebooks(memory!, deps.memoryAccess?.read ?? [], q, limit, scope, deps.createdBy),
      );
    },
    async memoryRead(scope?: ScopeId): Promise<string | null> {
      const target = scope ?? deps.memoryAccess?.write ?? deps.memoryScopeId;
      if (!memory || !target || !canReadNotebook(deps.memoryAccess ?? { read: [] }, target)) return null;
      const body = await timed("recall", async () => {
        if (deps.context && deps.memoryAccess?.read.includes(target)) return deps.context.readMemory(target);
        return readNotebook(memory!, target);
      });
      if (body === null) return null;
      return scope !== undefined ? `### ${target}\n${body}` : body;
    },
    async memoryAdd(facts: string[]): Promise<number | null> {
      const write = deps.memoryAccess?.write;
      if (!memory || !write) return null;
      return once(() =>
        timed("memory_write", () =>
          memory!.capture(write, facts, Date.now(), deps.createdBy, {
            ...deps.memoryCaptureMetadata?.(),
            mode: "explicit",
            actorId: deps.createdBy,
            conversationScopeId: writableScopeId ?? write,
          }),
        ),
      );
    },
    async memoryEdit(edits: MemoryEdit[]): Promise<true | null> {
      const write = deps.memoryAccess?.write;
      if (!memory?.edit || !write) return null;
      return once(() =>
        timed("memory_write", async () => {
          await memory!.edit!(write, edits, deps.createdBy, {
            ...deps.memoryCaptureMetadata?.(),
            conversationScopeId: writableScopeId ?? write,
          });
          return true as const;
        }),
      );
    },
    async memoryDelete(ids: string[]): Promise<true | null> {
      const write = deps.memoryAccess?.write;
      if (!memory?.delete || !write) return null;
      return once(() =>
        timed("memory_write", async () => {
          await memory!.delete!(write, ids, deps.createdBy);
          return true as const;
        }),
      );
    },
    ...(deps.humanTurn ? { humanTurn: true } : {}),
    ...(deps.sessionSyscalls ? { sessionSyscalls: deps.sessionSyscalls } : {}),
    async history(q: string, limit?: number): Promise<string[]> {
      if (!deps.sessionHistory) return [];
      return deps.sessionHistory.search(q, limit);
    },
    async historyOpen(seq: number): Promise<string | null> {
      if (!deps.sessionHistory) return null;
      return deps.sessionHistory.open(seq);
    },
    async callMcpTool(name: string, args: Record<string, unknown>, approval?: string): Promise<string> {
      if (!deps.mcp) throw new Error("no MCP connectors are configured");
      return deps.mcp.call(name, args, deps.createdBy, approval);
    },
    async mcpToolNeedsApproval(name: string, args: Record<string, unknown>): Promise<boolean> {
      if (!deps.mcp) throw new Error("no MCP connectors are configured");
      return deps.mcp.needsApproval(name, args, deps.createdBy);
    },
    async awaitClientResult(callId, timeoutMs, signal, toolName) {
      if (toolName === "desktop" && !deps.desktopClientId)
        return { content: "Computer access unavailable; continue from QM desktop.", isError: true };
      if (!deps.signals || runId === undefined) throw new Error("client tools need a queued run");
      return waitForClientResult(deps.signals, runId, callId, { timeoutMs, ...(signal ? { signal } : {}) });
    },
  } satisfies Partial<ToolContext>;
}

function audienceFromGrantees(
  granteeScopeIds: readonly ScopeId[],
  createdInScope?: ScopeId,
): PublishAudienceDescriptor {
  if (granteeScopeIds.length === 0) return { kind: "owner" };
  const orgGrant = granteeScopeIds.find((g) => parseScopeId(g).kind === "org");
  if (orgGrant) return { kind: "org", orgId: parseScopeId(orgGrant).ref };
  const origin = createdInScope ? parseScopeId(createdInScope) : { kind: null, ref: "" };
  return {
    kind: "members",
    ...(origin.kind === "channel" ? { channelRef: origin.ref } : {}),
    ...(granteeScopeIds.every((g) => parseScopeId(g).kind === "personal")
      ? { memberCount: granteeScopeIds.length }
      : {}),
  };
}

function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export const COMMAND_PATH_PROBE_TIMEOUT_MS = 10_000;

const trimSlashes = (path: string): string => path.replace(/^\.?\/+/, "").replace(/\/+$/, "");

async function collectTree(
  sandbox: Sandbox,
  handle: SandboxHandle,
  dir?: string,
): Promise<Array<{ path: string; data: Uint8Array }>> {
  const base = trimSlashes(dir ?? "");
  if (supportsAgentComputerExport(sandbox)) {
    try {
      const entries = await sandbox.exportFiles(handle, {
        include: ["workspace"],
        ...(base && base !== "." ? { includePaths: [base] } : {}),
        exclude: (entry) => carriesGitMetadata(entry.path),
        keepContentCaches: true,
      });
      return entries.filter((e) => !carriesGitMetadata(e.path)).map((e) => ({ path: e.path, data: e.data }));
    } catch (e) {
      if (!(e instanceof CapabilityUnsupportedError)) throw e;
      console.warn(`[publish] ${e.message}; falling back to per-file reads`);
    }
  }
  const out: Array<{ path: string; data: Uint8Array }> = [];
  for (const path of await sandbox.listDir(handle, base || ".")) {
    if (carriesGitMetadata(path)) continue;
    const data = await sandbox.readFileBytes(handle, path);
    if (data === null) throw new Error(`publish: could not read ${path} from the app tree`);
    out.push({ path, data });
  }
  return out;
}

function isUnderAnyDir(path: string, dirs: readonly string[]): boolean {
  const p = trimSlashes(path);
  return dirs.some((raw) => {
    const dir = trimSlashes(raw);
    return dir !== "" && (p === dir || p.startsWith(`${dir}/`));
  });
}

function filesUnder(snapshot: Array<{ path: string; data: Uint8Array }>, dir?: string): DeployFile[] {
  const d = trimSlashes(dir ?? "");
  if (!d || d === ".") return snapshot.map((f) => ({ path: f.path, data: f.data }));
  const prefix = `${d}/`;
  return snapshot
    .filter((f) => f.path.startsWith(prefix))
    .map((f) => ({ path: f.path.slice(prefix.length), data: f.data }));
}
