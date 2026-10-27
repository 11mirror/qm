import type { ScopeId } from "../../types.ts";
import { type SandboxHandle, supportsProcessSessions, SandboxProvisionCleanupError } from "../../sandbox/sandbox.ts";
import { errMessage, swallow, swallowAs } from "../../util/errors.ts";
import { sleep } from "../../util/async.ts";
import {
  accessResource,
  clearTurnFiles,
  createTurnSandboxState,
  hasLiveProcesses,
  holdResource,
  provision,
  provisionResource,
  releaseHold,
  scratchKey,
  useSkill,
  type TurnSandboxContext,
  type TurnSandboxState,
} from "./turn-sandbox-state.ts";

export type { TurnSandboxContext } from "./turn-sandbox-state.ts";

export function createTurnSandboxes(ctx: TurnSandboxContext) {
  const t = createTurnSandboxState(ctx);
  const { box, resourceHandles, resourcePendingHandles } = t;
  return {
    scratchBox: t.scratchBox,
    ownerAuthBox: t.ownerAuthBox,
    ownerAuthCommand: ctx.ownerAuthAvailable ? ownerAuthCommand(t) : undefined,
    provision: provision.bind(null, t),
    provisionScratch: provisionScratch.bind(null, t),
    accessResource: accessResource.bind(null, t),
    provisionResource: provisionResource.bind(null, t),
    provisionOwnerAuth: ctx.ownerAuthAvailable ? provisionOwnerAuth.bind(null, t) : undefined,
    useSkill: useSkill.bind(null, t),
    provisionForReach: provisionForReach.bind(null, t),
    reclaimBox: reclaimBox.bind(null, t),
    invalidateProvision: () => {
      const previous = box.handle ?? box.pending;
      if (previous)
        (box.handle ? resourceHandles : resourcePendingHandles).set(previous.resourceId ?? previous.id, previous);
      box.handle = null;
      box.pending = null;
      t.provisionInFlight = null;
      t.laidTrees.clear();
    },
  };
}

const brokerEnvKeys = [
  "AGENT_CREDENTIAL_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
];

const unsetBrokerEnv = (env: Record<string, string>): string => {
  const keys = brokerEnvKeys.filter((key) => !(key in env));
  return keys.length ? `unset ${keys.join(" ")}; ` : "";
};

function ownerAuthCommand(t: TurnSandboxState) {
  const { deps, actor, scopeId, openSpeakerKeychain } = t;
  return (command: string, env: Record<string, string> = {}): string => {
    if (openSpeakerKeychain)
      deps.auditLog.record({
        at: Date.now(),
        principalId: actor.id,
        action: "keychain.open_speaker_use",
        resource: "isolated owner execution",
        scopeLabel: scopeId,
      });
    return `unset AGENT_API_TOKEN AGENT_OAUTH_CONSENT_TOKEN; ${unsetBrokerEnv(env)}${command}`;
  };
}

function recordScratchLifecycle(
  t: TurnSandboxState,
  action: string,
  handle?: SandboxHandle,
  extra?: { releasedAt?: number; cleanupMs?: number; error?: string },
): void {
  const { deps, actor, scopeId, input, session } = t;
  deps.auditLog?.record({
    at: Date.now(),
    principalId: actor.id,
    action: `sandbox.scratch.${action}`,
    resource: scratchKey(t),
    scopeLabel: scopeId,
    detail: JSON.stringify({
      runId: input.runId,
      sessionId: session.id,
      backend: handle?.backend,
      sandboxId: handle?.id,
      startedAt: t.scratchStartedAt,
      readyAt: t.scratchReadyAt,
      provisionMs: t.scratchBox.provisionMs,
      ...extra,
    }),
  });
}

async function destroyEphemeralHandle(t: TurnSandboxState, handle: SandboxHandle): Promise<void> {
  const { deps } = t;
  const errors: unknown[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await deps.sandbox.teardown(handle, { destroy: true });
      return;
    } catch (error) {
      errors.push(error);
      if (attempt < 3) await sleep(50 * attempt);
    }
  }
  throw new AggregateError(errors, "Disposable sandbox destruction failed");
}

function provisionScratch(t: TurnSandboxState): Promise<SandboxHandle> {
  const { deps, resolution, connectorEnv, egressTokenForTurn, memoryScopeId, onSandboxStatus, scratchBox } = t;
  if (scratchBox.pending)
    return Promise.reject(new Error("Disposable sandbox initialization cleanup is still pending"));
  if (scratchBox.handle) return Promise.resolve(scratchBox.handle);
  t.scratchProvisionInFlight ??= (async () => {
    const provisionStart = Date.now();
    t.scratchStartedAt = provisionStart;
    recordScratchLifecycle(t, "provision_started");
    const handle = await deps.sandbox.provision(
      resolution.layers.filter((l) => l.mode === "ro" && l.mountPath === "global"),
      {
        env: connectorEnv,
        egress: resolution.egress,
        ...(egressTokenForTurn ? { egressToken: egressTokenForTurn } : {}),
        scratch: { key: scratchKey(t) },
        routeScopeId: memoryScopeId,
        ...(onSandboxStatus ? { onStatus: onSandboxStatus } : {}),
      },
    );
    scratchBox.provisionMs = Date.now() - provisionStart;
    scratchBox.handle = handle;
    t.scratchReadyAt = Date.now();
    recordScratchLifecycle(t, "provision_ready", handle);
    return handle;
  })().catch((error) => {
    t.scratchProvisionInFlight = null;
    if (error instanceof SandboxProvisionCleanupError) scratchBox.pending = error.handle;
    recordScratchLifecycle(t, "provision_failed", scratchBox.pending ?? undefined, { error: errMessage(error) });
    throw error;
  });
  return t.scratchProvisionInFlight;
}

async function provisionOwnerAuth(t: TurnSandboxState): Promise<SandboxHandle> {
  const { deps, actor, scopeId, session, transferId, resolution, memoryScopeId, ownerAuthBox } = t;
  const { openSpeakerKeychain, egressTokenForTurn, onSandboxStatus } = t;
  // Recheck each command, including commands reusing this turn's isolated computer.
  if (openSpeakerKeychain && !(await deps.isCurrentSharedScopeMember?.(actor.id, scopeId)))
    throw new Error("Open speaker keychain access is no longer authorized");
  if (ownerAuthBox.handle) return ownerAuthBox.handle;
  if (ownerAuthBox.pending && !t.ownerAuthProvisionInFlight) {
    return Promise.reject(new Error("owner-auth box initialization failed and cleanup is still pending"));
  }
  t.ownerAuthProvisionInFlight ??= (async () => {
    const handle = await deps.sandbox.provision(
      resolution.layers.filter((l) => l.mode === "ro" && l.mountPath === "global"),
      {
        egress: resolution.egress,
        ...(egressTokenForTurn ? { egressToken: egressTokenForTurn } : {}),
        scratch: { key: `owner-auth:${session.id}:${transferId}` },
        routeScopeId: memoryScopeId,
        ...(onSandboxStatus ? { onStatus: onSandboxStatus } : {}),
      },
    );
    ownerAuthBox.pending = handle;
    ownerAuthBox.handle = handle;
    return handle;
  })().catch(async (err) => {
    t.ownerAuthProvisionInFlight = null;
    if (err instanceof SandboxProvisionCleanupError) ownerAuthBox.pending = err.handle;
    const pendingHandle = ownerAuthBox.pending;
    if (pendingHandle) {
      try {
        await destroyEphemeralHandle(t, pendingHandle);
        if (ownerAuthBox.pending === pendingHandle) ownerAuthBox.pending = null;
      } catch (cleanupErr) {
        deps.errors?.record(
          {
            category: "sandbox",
            code: "owner_auth_init_cleanup_failed",
            message: errMessage(cleanupErr),
            scopeLabel: scopeId,
            sessionId: session.id,
          },
          cleanupErr,
        );
      }
    }
    throw err;
  });
  return t.ownerAuthProvisionInFlight;
}

async function provisionForReach(t: TurnSandboxState, target: ScopeId): Promise<SandboxHandle> {
  const { deps, resolution, egressTokenForTurn, onSandboxStatus, reachBoxes } = t;
  const cached = reachBoxes.get(target);
  if (cached) return cached;
  const handle = await deps.sandbox.provision(
    [
      { scopeId: resolution.orgScopeId, mountPath: "global", mode: "ro" },
      { scopeId: target, mountPath: "", mode: "rw" },
    ],
    {
      egress: resolution.egress,
      ...(egressTokenForTurn ? { egressToken: egressTokenForTurn } : {}),
      ...(onSandboxStatus ? { onStatus: onSandboxStatus } : {}),
    },
  );
  reachBoxes.set(target, handle);
  await holdResource(t, handle);
  return handle;
}

async function keepWarmAfterRelease(
  t: TurnSandboxState,
  handle: SandboxHandle,
  label: "reach " | "",
): Promise<boolean> {
  const { deps } = t;
  let keepWarm = await releaseHold(t, handle).catch(swallowAs(`orchestrator: ${label}hold release`, true));
  if (!keepWarm && deps.processes && supportsProcessSessions(deps.sandbox)) {
    try {
      keepWarm = await hasLiveProcesses(t, handle);
    } catch (e) {
      swallow(`orchestrator: ${label}live process check`, e);
      keepWarm = false;
    }
  }
  return keepWarm;
}

async function reclaimReach(t: TurnSandboxState): Promise<void> {
  const { deps, reachBoxes } = t;
  const reachHandles = [...reachBoxes.values()];
  reachBoxes.clear();
  await Promise.all(
    reachHandles.map(async (h) => {
      if (await keepWarmAfterRelease(t, h, "reach ")) {
        await deps.sandbox
          .teardown(h, { keepWarm: true })
          .catch(swallowAs("orchestrator: keep warm teardown", undefined));
        return;
      }
      await deps.sandbox.teardown(h).catch(swallowAs("orchestrator: teardown", undefined));
    }),
  );
}

async function reclaimOwnerAuth(t: TurnSandboxState): Promise<unknown> {
  const { deps, scopeId, session, ownerAuthBox } = t;
  const ownerHandle = ownerAuthBox.handle ?? ownerAuthBox.pending;
  if (!ownerHandle) return undefined;
  try {
    await destroyEphemeralHandle(t, ownerHandle);
    ownerAuthBox.handle = null;
    ownerAuthBox.pending = null;
    return undefined;
  } catch (err) {
    deps.errors?.record(
      {
        category: "sandbox",
        code: "owner_auth_destroy_failed",
        message: errMessage(err),
        scopeLabel: scopeId,
        sessionId: session.id,
      },
      err,
    );
    return err;
  }
}

async function reclaimScratch(t: TurnSandboxState): Promise<unknown> {
  const { deps, scopeId, session, scratchBox } = t;
  if (t.scratchProvisionInFlight)
    await t.scratchProvisionInFlight.catch(swallowAs("orchestrator: scratch provision", undefined));
  t.scratchProvisionInFlight = null;
  const scratchHandle = scratchBox.handle ?? scratchBox.pending;
  if (!scratchHandle) return undefined;
  const cleanupStart = Date.now();
  try {
    await destroyEphemeralHandle(t, scratchHandle);
    scratchBox.handle = null;
    scratchBox.pending = null;
    recordScratchLifecycle(t, "released", scratchHandle, {
      releasedAt: Date.now(),
      cleanupMs: Date.now() - cleanupStart,
    });
    return undefined;
  } catch (error) {
    const scratchCleanupError = error instanceof Error ? error : new Error(errMessage(error));
    recordScratchLifecycle(t, "release_failed", scratchHandle, {
      releasedAt: Date.now(),
      cleanupMs: Date.now() - cleanupStart,
      error: errMessage(error),
    });
    deps.errors?.record(
      {
        category: "sandbox",
        code: "scratch_destroy_failed",
        message: errMessage(error),
        scopeLabel: scopeId,
        sessionId: session.id,
      },
      scratchCleanupError,
    );
    return scratchCleanupError;
  }
}

async function reclaimResources(t: TurnSandboxState): Promise<void> {
  const { deps, scopeId, writableScopeId, box, resourcePending, resourceHandles, resourcePendingHandles } = t;
  await Promise.allSettled(resourcePending.values());
  const released = new Set<string>();
  const current = box.handle ?? box.pending;
  const releases: Promise<void>[] = [];
  for (const handle of [...resourceHandles.values(), ...resourcePendingHandles.values()]) {
    const key = `${handle.backend}:${handle.id}`;
    if (released.has(key) || (current?.id === handle.id && current.backend === handle.backend)) continue;
    released.add(key);
    releases.push(
      (async () => {
        try {
          if (handle.scopeId === undefined || handle.scopeId === writableScopeId || handle.scopeId === scopeId)
            await clearTurnFiles(t, handle);
        } finally {
          await deps.sandbox.teardown(handle, {
            keepWarm:
              (await releaseHold(t, handle).catch(swallowAs("orchestrator: resource hold release", true))) ||
              (await hasLiveProcesses(t, handle).catch(swallowAs("orchestrator: live process check", true))),
          });
        }
      })(),
    );
  }
  const releasedResults = await Promise.allSettled(releases);
  for (const result of releasedResults)
    if (result.status === "rejected") swallow("resource sandbox release", result.reason);
  resourceHandles.clear();
  resourcePendingHandles.clear();
}

async function reclaimPrimary(t: TurnSandboxState): Promise<void> {
  const { deps, box } = t;
  if (t.provisionInFlight) await t.provisionInFlight.catch(swallowAs("orchestrator: provision", undefined));
  t.provisionInFlight = null;
  const handle = box.handle ?? box.pending;
  box.handle = null;
  box.pending = null;
  if (!handle) return;
  await clearTurnFiles(t, handle);
  const keepWarm = await keepWarmAfterRelease(t, handle, "");
  await deps.sandbox.teardown(handle, {
    ...(keepWarm ? { keepWarm: true } : {}),
    ...(box.used ? {} : { homeUnchanged: true }),
  });
}

async function reclaimBox(t: TurnSandboxState): Promise<void> {
  if (t.ownerAuthProvisionInFlight)
    await t.ownerAuthProvisionInFlight.catch(swallowAs("orchestrator: owner auth provision", undefined));
  t.ownerAuthProvisionInFlight = null;
  await reclaimReach(t);
  const ownerCleanupError = await reclaimOwnerAuth(t);
  const scratchCleanupError = await reclaimScratch(t);
  await reclaimResources(t);
  await reclaimPrimary(t);
  if (ownerCleanupError) throw ownerCleanupError;
  if (scratchCleanupError) throw scratchCleanupError;
}
