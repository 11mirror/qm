import { prepareExecutionFiles, type ExecutionFileCredential } from "../credentials/execute-files.ts";
import { disclosedMemory } from "../memory/disclosure.ts";
import type { SandboxAccessPlan, SandboxResource } from "../sandbox/sandbox-resources.ts";
import { DROPPED_PROXY_ENV } from "../sandbox/sandbox-env.ts";
import type { SandboxHandle } from "../sandbox/sandbox.ts";
import { evaluateCommandWithLayer } from "../policy/command-policy.ts";
import { TURN_FILES_DIR } from "../core/attachments.ts";
import { withCleanup } from "../util/errors.ts";
import type { ControlService } from "../api/control-service.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import {
  NeedsApproval,
  CommandDenied,
  type CommandCredential,
  type SurfaceToolDeps,
  type ControlUnavailable,
  CONTROL_UNAVAILABLE,
} from "./primitives.ts";
import { type ToolContextDeps } from "./tool-context.ts";

export const scratchOnlyHandles = (credentials: readonly CommandCredential[]): string =>
  credentials
    .filter((credential) => credential.scratchOnly)
    .map((credential) => credential.handle)
    .join(", ");

export function sandboxAccess(deps: ToolContextDeps) {
  const writableScopeId = deps.layers.find((l) => l.mode === "rw")?.scopeId ?? null;
  const memory =
    deps.context?.memory ??
    (deps.memory
      ? disclosedMemory(deps.memory, {
          actor: { id: deps.createdBy, type: "internal" },
          targetScope: writableScopeId ?? `personal:${deps.createdBy}`,
          nativeScopes: [
            ...deps.layers.map((layer) => layer.scopeId),
            ...(deps.memoryAccess?.read ?? []).filter((scope) => scope.startsWith("org:")),
          ],
          audience: deps.publishContext?.publishMembers ?? [{ id: deps.createdBy, type: "internal" }],
          open: false,
        })
      : undefined);
  const fallbackMounts = deps.layers.filter((l) => l.mode === "ro" && l.mountPath);
  const persistExclude = [...fallbackMounts.map((mount) => mount.mountPath!), TURN_FILES_DIR];

  const accessSandbox = async (id: string): Promise<SandboxAccessPlan> => {
    if (!deps.sandboxResources || !deps.accessSandboxResource) throw new Error("sandbox inventory unavailable");
    if (!id.trim()) throw new Error("sandbox_id must name a sandbox; omit it to use the default");
    return deps.accessSandboxResource(id);
  };

  const machine = async (
    id: string | undefined,
  ): Promise<{
    handle: SandboxHandle;
    resource?: SandboxResource;
    crossScope: boolean;
    durableRef: (path: string) => string;
  }> => {
    if (id === undefined) {
      const handle = await deps.provision();
      const resource = handle.resourceId ? await deps.sandboxResources?.get(handle.resourceId) : undefined;
      return { handle, ...(resource ? { resource } : {}), crossScope: false, durableRef: (path) => path };
    }
    let access = await accessSandbox(id);
    if (!deps.provisionResource) throw new Error("sandbox inventory unavailable");
    const handle = await deps.provisionResource(access, (current) => {
      access = current;
    });
    const resource = access.resource;
    const fallback = writableScopeId ? await deps.sandboxResources!.resolve(writableScopeId) : null;
    const durableRef =
      fallback?.id === resource.id ? (path: string) => path : (path: string) => `sandbox-files/${resource.id}/${path}`;
    return { handle, resource, crossScope: access.crossScope, durableRef };
  };

  const authorizeExecution = (command: string, access?: SandboxAccessPlan, policy = deps.commandPolicy()): void => {
    const source = evaluateCommandWithLayer(command, policy, deps.layerCommandRules?.() ?? []);
    if (source.decision === "deny") throw new CommandDenied(command, source.reason ?? "denied by policy");
    if (!access?.crossScope) {
      if (source.decision === "require_approval" && !deps.authorizeCommand(command, source.approvalKey))
        throw new NeedsApproval(
          command,
          source.reason ?? "requires approval",
          "approval",
          source.matched,
          source.approvalKey,
        );
      return;
    }
    const target = access.commandPolicy
      ? evaluateCommandWithLayer(command, access.commandPolicy, [])
      : { decision: "allow" as const };
    if (target.decision === "deny")
      throw new CommandDenied(command, target.reason ?? "denied by target sandbox policy");
    if (source.decision !== "require_approval" && target.decision !== "require_approval") return;
    const approvalKey = `sandbox:${JSON.stringify([
      access.resource.ownerScopeId,
      source.approvalKey ?? command,
      target.approvalKey ?? command,
    ])}`;
    const required = target.decision === "require_approval" ? target : source;
    const grantModes = { session: false, always: false };
    if (!deps.authorizeCommand(command, approvalKey, true))
      throw new NeedsApproval(
        command,
        required.reason ?? "requires sandbox approval",
        "approval",
        required.matched,
        approvalKey,
        grantModes,
      );
  };

  const provisionForCommand = async (
    command: string,
    sandboxId: string | undefined,
    withCredentials: boolean,
    otherwise: () => Promise<SandboxHandle>,
  ): Promise<SandboxHandle> => {
    const policy = deps.commandPolicy;
    if (sandboxId === undefined) {
      authorizeExecution(command, undefined, policy());
      return otherwise();
    }
    if (!deps.sandboxResources || !deps.provisionResource) throw new Error("sandbox inventory unavailable");
    const access = await accessSandbox(sandboxId);
    return deps.provisionResource(access, (current) => {
      if (current.crossScope && withCredentials)
        throw new Error("command credentials cannot be copied to another scope's computer");
      authorizeExecution(command, current, policy());
    });
  };
  return {
    writableScopeId,
    memory,
    fallbackMounts,
    persistExclude,
    accessSandbox,
    machine,
    provisionForCommand,
    authorizeExecution,
  };
}

export function controlAccess(deps: ToolContextDeps) {
  function controlOp<R>(
    run: (control: ControlService, claims: CapabilityClaims) => Promise<R>,
  ): Promise<R | ControlUnavailable> {
    if (!deps.control || !deps.controlClaims) return Promise.resolve(CONTROL_UNAVAILABLE);
    return run(deps.control, deps.controlClaims);
  }
  function surfaceOp<R>(run: (surface: SurfaceToolDeps) => Promise<R>): Promise<R | { ok: false; message: string }> {
    if (!deps.surface) return Promise.resolve({ ok: false, message: SURFACE_UNAVAILABLE_MESSAGE });
    return run(deps.surface);
  }
  return { controlOp, surfaceOp };
}

export function credentialStaging(
  deps: ToolContextDeps,
  { writableScopeId }: Pick<ReturnType<typeof sandboxAccess>, "writableScopeId">,
) {
  const selectCredentials = async (handles: readonly string[]) => {
    const available = new Map(
      (
        (handles.length ? await deps.resolveCommandCredentials?.(handles) : undefined) ??
        deps.commandCredentials ??
        []
      ).map((credential) => [credential.handle, credential] as const),
    );
    return handles.map((handle) => {
      const credential = available.get(handle);
      if (!credential) throw new Error(`credential handle is not available on this turn: ${handle}`);
      return credential;
    });
  };

  const stageCredentials = async (
    requested: readonly CommandCredential[],
    handle: SandboxHandle,
    use: "command" | "background",
    signal?: AbortSignal,
  ) => {
    const commandEnv: Record<string, string> = {};
    const addCommandEnv = (key: string, value: string) => {
      if (DROPPED_PROXY_ENV.has(key) || (Object.hasOwn(handle.env ?? {}, key) && handle.env![key] !== value))
        throw new Error(`requested credentials may not override the computer's environment key: ${key}`);
      if (Object.hasOwn(commandEnv, key) && commandEnv[key] !== value)
        throw new Error(`requested credentials provide conflicting environment key: ${key}`);
      commandEnv[key] = value;
    };
    const prepared: Array<{
      commit?: () => Promise<void>;
      singleUse?: boolean;
      files?: ExecutionFileCredential;
      env: Array<{ key: string; value: string; secret?: boolean }>;
    }> = [];
    for (const credential of new Set(requested)) {
      const materialized = credential.resolve ? await credential.resolve() : { env: credential.env ?? [] };
      prepared.push(materialized);
      for (const { key, value } of materialized.env) addCommandEnv(key, value);
      deps.auditLog?.record({
        at: Date.now(),
        principalId: deps.createdBy,
        action: "keychain.materialize",
        resource: `${credential.handle} (${use})`,
        scopeLabel: writableScopeId!,
      });
    }
    signal?.throwIfAborted();
    const singleUse = prepared.filter((credential) => credential.singleUse);
    if (singleUse.length > 1) throw new Error("An execution may use at most one single-use grant");
    for (const credential of prepared.filter((credential) => !credential.singleUse)) await credential.commit?.();
    signal?.throwIfAborted();
    for (const credential of singleUse) await credential.commit?.();
    const fileCredentials = prepared.flatMap((credential) => (credential.files ? [credential.files] : []));
    const fileExecution = fileCredentials.length
      ? await prepareExecutionFiles(deps.sandbox, handle, fileCredentials)
      : undefined;
    for (const [key, value] of Object.entries(fileExecution?.env ?? {})) {
      try {
        addCommandEnv(key, value);
      } catch (error) {
        return withCleanup(
          () => Promise.reject(error),
          () => fileExecution!.finish(),
        );
      }
    }
    return {
      commandEnv,
      secretValues: prepared.flatMap((credential) => credential.env),
      fileExecution,
      fileCredentials,
    };
  };
  return { selectCredentials, stageCredentials };
}

const SURFACE_UNAVAILABLE_MESSAGE =
  "the chat surface isn't reachable from this turn — there's no conversation to post to or read here";
