import { hashId } from "../../util/crypto.ts";
import type { Principal, Resolution, ScopeId, Session } from "../../types.ts";
import { personalScope } from "../../types.ts";
import { intersectEgressPolicies } from "../../resolution/egress-policy.ts";
import { isOpenScopeMember } from "../../resolution/sharing-access.ts";
import { type SandboxHandle, supportsProcessSessions, SandboxProvisionCleanupError } from "../../sandbox/sandbox.ts";
import {
  accessConversationSandbox,
  type SandboxAccessPlan,
  type SandboxResource,
} from "../../sandbox/sandbox-resources.ts";
import { reconcileProcesses } from "../../processes/reconcile.ts";
import { finishProcessCredentials } from "../../credentials/execute-files.ts";
import {
  materializeSkillTree as laySkillTree,
  packRoot,
  rehomeSkillPaths,
  renderSkillBody,
  skillDir,
  SKILLS_ROOT,
} from "../../skills/materialize.ts";
import { safeSkillFilePath, type SkillResolution } from "../../skills/skill-store.ts";
import { isSafeSkillName } from "../../skills/skill-name.ts";
import type { SkillResult } from "../../tools/primitives.ts";
import { TURN_FILES_DIR } from "../attachments.ts";
import { errMessage, swallow, swallowAs } from "../../util/errors.ts";
import { loadActiveBundles } from "./turn-helpers.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";

const TURN_FILES_MAX_AGE_MS = 24 * 60 * 60_000;

export interface TurnSandboxContext {
  deps: OrchestratorDeps;
  input: OrchestratorInput;
  actor: Principal;
  session: Session;
  resolution: Resolution;
  scopeId: ScopeId;
  memoryScopeId: ScopeId;
  transferId: string;
  turnSessionDir: string;
  turnFilesDir: string;
  connectorEnv: Record<string, string>;
  egressTokenForTurn: string | undefined;
  egressTokenForPolicy?: (policy: Resolution["egress"]) => Promise<string | undefined>;
  openResourceAccess?: boolean;
  visibleSkillsForTurn: (sources?: readonly string[]) => Promise<SkillResolution[]>;
}

export function createTurnSandboxes(ctx: TurnSandboxContext) {
  const t = createTurnSandboxState(ctx);
  const { box, scratch, resourceHandles, resourcePendingHandles, laidTrees } = t;
  return {
    scratchBox: scratch.state,
    provision: provision.bind(null, t),
    provisionScratch: scratch.provision,
    accessResource: accessResource.bind(null, t),
    provisionResource: provisionResource.bind(null, t),
    provisionJobComputer: provisionJobComputer.bind(null, t),
    provisionJobSandbox: provisionJobSandbox.bind(null, t),
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
      laidTrees.clear();
    },
  };
}

type SandboxBase = TurnSandboxContext & { onSandboxStatus?: (text: string) => void };
type TurnSandboxState = ReturnType<typeof createTurnSandboxState>;

function createTurnSandboxState(ctx: TurnSandboxContext) {
  const { deps, input, session, resolution, transferId, connectorEnv } = ctx;
  let sandboxStatusSeq = 2_000_000;
  const onSandboxStatus =
    input.runId && deps.runActivity
      ? (text: string): void => {
          void deps
            .runActivity!.append(input.runId!, {
              marker: "sandbox_status",
              seq: sandboxStatusSeq++,
              createdAt: Date.now(),
              text,
            })
            .catch(swallowAs("orchestrator: sandbox status append", undefined));
        }
      : undefined;
  const base: SandboxBase = { ...ctx, onSandboxStatus };
  const turnKey = `turn:${session.id}:${transferId}`;
  return {
    ...base,
    box: { handle: null, pending: null, used: false } as {
      handle: SandboxHandle | null;
      pending: SandboxHandle | null;
      used: boolean;
    },
    turnKey,
    scratch: scratchBox(base, turnKey, connectorEnv),
    resourceHandles: new Map<string, SandboxHandle>(),
    resourcePolicy: new Map<string, string>(),
    resourcePendingHandles: new Map<string, SandboxHandle>(),
    resourcePending: new Map<string, Promise<SandboxHandle>>(),
    provisionInFlight: null as Promise<SandboxHandle> | null,
    laidTrees: new Set<string>(),
    writableScopeId: resolution.layers.find((layer) => layer.mode === "rw")?.scopeId,
    reachBoxes: new Map<ScopeId, SandboxHandle>(),
  };
}

function scratchBox(t: SandboxBase, key: string, env?: Record<string, string>) {
  const { deps, input, actor, session, resolution, scopeId, memoryScopeId, egressTokenForTurn, onSandboxStatus } = t;
  const state: {
    handle: SandboxHandle | null;
    pending: SandboxHandle | null;
    inFlight: Promise<SandboxHandle> | null;
    startedAt?: number;
    readyAt?: number;
    provisionMs?: number;
  } = { handle: null, pending: null, inFlight: null };
  const record = (
    action: string,
    handle?: SandboxHandle,
    extra?: { releasedAt?: number; cleanupMs?: number; error?: string },
  ): void => {
    deps.auditLog?.record({
      at: Date.now(),
      principalId: actor.id,
      action: `sandbox.scratch.${action}`,
      resource: key,
      scopeLabel: scopeId,
      detail: JSON.stringify({
        runId: input.runId,
        sessionId: session.id,
        backend: handle?.backend,
        sandboxId: handle?.id,
        startedAt: state.startedAt,
        readyAt: state.readyAt,
        provisionMs: state.provisionMs,
        ...extra,
      }),
    });
  };
  const provision = (): Promise<SandboxHandle> => {
    if (state.handle) return Promise.resolve(state.handle);
    if (state.pending && !state.inFlight)
      return Promise.reject(new Error("Disposable sandbox initialization cleanup is still pending"));
    state.inFlight ??= (async () => {
      state.startedAt = Date.now();
      record("provision_started");
      const handle = await deps.sandbox.provision(
        resolution.layers.filter((l) => l.mode === "ro" && l.mountPath === "global"),
        {
          ...(env ? { env } : {}),
          egress: resolution.egress,
          ...(egressTokenForTurn ? { egressToken: egressTokenForTurn } : {}),
          scratch: { key },
          routeScopeId: memoryScopeId,
          ...(onSandboxStatus ? { onStatus: onSandboxStatus } : {}),
        },
      );
      state.readyAt = Date.now();
      state.provisionMs = state.readyAt - state.startedAt;
      state.handle = handle;
      record("provision_ready", handle);
      return handle;
    })().catch((error: unknown) => {
      state.inFlight = null;
      if (error instanceof SandboxProvisionCleanupError) state.pending = error.handle;
      record("provision_failed", state.pending ?? undefined, { error: errMessage(error) });
      throw error;
    });
    return state.inFlight;
  };
  const release = async (): Promise<void> => {
    await state.inFlight?.catch(() => undefined);
    state.inFlight = null;
    const handle = state.handle ?? state.pending;
    if (!handle) return;
    const cleanupStart = Date.now();
    try {
      await deps.sandbox.teardown(handle, { destroy: true });
    } catch (error) {
      record("release_failed", handle, {
        releasedAt: Date.now(),
        cleanupMs: Date.now() - cleanupStart,
        error: errMessage(error),
      });
      reportSandboxError(t, "scratch_destroy_failed", error);
      throw error;
    }
    state.handle = null;
    state.pending = null;
    record("released", handle, { releasedAt: Date.now(), cleanupMs: Date.now() - cleanupStart });
  };
  return { state, provision, release };
}

function reportSandboxError(t: SandboxBase, code: string, error: unknown): void {
  const { deps, session, scopeId } = t;
  deps.errors?.record(
    { category: "sandbox", code, message: errMessage(error), scopeLabel: scopeId, sessionId: session.id },
    error,
  );
}

async function holdResource(t: TurnSandboxState, handle: SandboxHandle): Promise<void> {
  const { deps, input } = t;
  if (handle.resourceId && deps.runs && input.runId) await deps.sandboxResources?.hold(handle.resourceId, input.runId);
}

async function releaseHold(t: TurnSandboxState, handle: SandboxHandle): Promise<boolean> {
  const { deps, input } = t;
  const runs = deps.runs;
  if (!handle.resourceId || !runs || !deps.sandboxResources) return false;
  return deps.sandboxResources.release(handle.resourceId, input.runId, async (runId) => {
    const run = await runs.get(runId);
    return run?.status === "running";
  });
}

function provision(t: TurnSandboxState, eager = false): Promise<SandboxHandle> {
  const { box } = t;
  if (!eager) box.used = true;
  t.provisionInFlight ??= doProvision(t, eager).catch((err: unknown) => {
    t.provisionInFlight = null;
    recordProvisionFailure(t, err, eager);
    throw err;
  });
  return t.provisionInFlight;
}

function recordProvisionFailure(t: TurnSandboxState, error: unknown, eager: boolean): void {
  const { deps, input, actor, session, scopeId, turnKey } = t;
  deps.auditLog?.record({
    at: Date.now(),
    principalId: actor.id,
    action: "sandbox.scoped.provision_failed",
    resource: turnKey,
    scopeLabel: scopeId,
    detail: JSON.stringify({ runId: input.runId, sessionId: session.id, eager, error: errMessage(error) }),
  });
  reportSandboxError(t, "provision_failed", error);
}

async function doProvision(t: TurnSandboxState, eager: boolean): Promise<SandboxHandle> {
  const {
    deps,
    input,
    actor,
    session,
    resolution,
    scopeId,
    memoryScopeId,
    connectorEnv,
    egressTokenForTurn,
    box,
    onSandboxStatus,
    turnKey,
  } = t;
  const provisionStart = Date.now();
  if (input.externalSlack) {
    const resource = await deps.sandboxResources?.resolve(memoryScopeId);
    if (resource && resource.ownerScopeId !== scopeId) throw new Error("External Slack requires its own sandbox.");
  }
  const handle = await deps.sandbox.provision(resolution.layers, {
    env: connectorEnv,
    egress: resolution.egress,
    ...(egressTokenForTurn ? { egressToken: egressTokenForTurn } : {}),
    ...(onSandboxStatus ? { onStatus: onSandboxStatus } : {}),
  });
  box.pending = handle;
  await holdResource(t, handle);
  const provisionMs = Date.now() - provisionStart;
  deps.auditLog?.record({
    at: Date.now(),
    principalId: actor.id,
    action: "sandbox.scoped.provision_ready",
    resource: turnKey,
    scopeLabel: scopeId,
    detail: JSON.stringify({
      runId: input.runId,
      sessionId: session.id,
      backend: handle.backend,
      sandboxId: handle.id,
      provisionMs,
      coldStart: handle.coldStart,
      eager,
    }),
  });
  await prepareTurnFiles(t, handle);
  const { sandbox, processes, keychain } = deps;
  if (processes && supportsProcessSessions(sandbox)) {
    try {
      await reconcileProcesses(sandbox, handle, processes, memoryScopeId, (exited, processId) =>
        finishProcessCredentials({ sandbox, processes, keychain }, exited, processId),
      );
    } catch (err) {
      deps.errors?.record(
        {
          category: "process_session",
          code: "reconcile_failed",
          message: errMessage(err),
          scopeLabel: scopeId,
          sessionId: session.id,
        },
        err,
      );
    }
  }
  box.handle = handle;
  return handle;
}

function skillsRoot(t: TurnSandboxState, r: SkillResolution) {
  const { turnSessionDir } = t;
  return `${SKILLS_ROOT}/${turnSessionDir.split("/").at(-1)}/${hashId([r.skill!.id, String(r.skill!.version)], 16)}`;
}

async function materializeSkillTree(t: TurnSandboxState, handle: SandboxHandle, r: SkillResolution): Promise<void> {
  const { deps, session, scopeId, laidTrees } = t;
  const treeKey = `${handle.resourceId ?? handle.id}:${skillDir(skillsRoot(t, r), r)}`;
  if (laidTrees.has(treeKey)) return;
  try {
    const bundles = deps.skillBundles ? await loadActiveBundles(deps.skillBundles, [r]) : [];
    await laySkillTree(deps.sandbox, handle, skillsRoot(t, r), r, bundles);
    laidTrees.add(treeKey);
  } catch (err) {
    deps.errors?.record(
      {
        category: "skills",
        code: "tree_materialize_failed",
        message: errMessage(err),
        scopeLabel: scopeId,
        sessionId: session.id,
      },
      err,
    );
    throw err;
  }
}

async function useSkill(
  t: TurnSandboxState,
  name: string,
  file: string,
  sandboxId?: string,
  source?: string,
): Promise<SkillResult> {
  const { deps, visibleSkillsForTurn } = t;
  const missing = { content: null, sourceScopeId: null };
  if (!isSafeSkillName(name)) return missing;
  try {
    if (safeSkillFilePath(file) !== file) return missing;
  } catch {
    return missing;
  }
  const resolution = (await visibleSkillsForTurn(source ? [source] : undefined)).find(
    (r) => r.skill?.manifest.name === name,
  );
  if (!resolution?.skill) return missing;
  const shipsFiles = (resolution.skill.manifest.files?.length ?? 0) > 0 || resolution.skill.pack !== undefined;
  const asset = resolution.skill.manifest.files?.find((f) => {
    try {
      return safeSkillFilePath(f.path) === file;
    } catch {
      return false;
    }
  })?.content;
  if (file !== "SKILL.md" && asset === undefined) return missing;
  if (deps.skills)
    void deps.skills.recordUse(resolution.skill.id).catch((e) => swallow("orchestrator: skill recordUse", e));
  const render = (root?: string) =>
    file === "SKILL.md"
      ? renderSkillBody(resolution, root)
      : rehomeSkillPaths(resolution, asset!, root ?? skillsRoot(t, resolution));
  if (!shipsFiles) return { content: render(), sourceScopeId: resolution.skill.scopeId };
  const access = sandboxId !== undefined ? await accessResource(t, sandboxId) : undefined;
  if (access?.crossScope)
    return { content: render(skillsRoot(t, resolution)), sourceScopeId: resolution.skill.scopeId };
  const handle = access ? await provisionResource(t, access) : await provision(t);
  await materializeSkillTree(t, handle, resolution);
  const root = `${handle.rootDir}/${skillsRoot(t, resolution)}`;
  const pack = packRoot(root, resolution);
  return {
    content: render(root),
    sourceScopeId: resolution.skill.scopeId,
    dir: skillDir(root, resolution),
    ...(pack ? { packDir: pack } : {}),
  };
}

async function canUseSandboxScope(t: TurnSandboxState, target: ScopeId): Promise<boolean> {
  const { deps, actor, scopeId, openResourceAccess, writableScopeId } = t;
  if (target === writableScopeId || target === scopeId) return true;
  if (!openResourceAccess || actor.type !== "internal" || !deps.isCurrentSharedScopeMember) return false;
  const personal = personalScope(actor.id);
  for (const scope of new Set([scopeId, target])) {
    if (
      scope !== personal &&
      !(await isOpenScopeMember({
        actorId: actor.id,
        scope,
        isCurrentSharedScopeMember: deps.isCurrentSharedScopeMember,
      }))
    )
      return false;
  }
  return true;
}

async function accessResource(t: TurnSandboxState, id: string): Promise<SandboxAccessPlan> {
  const { deps, actor, resolution, scopeId, writableScopeId } = t;
  const resource = await accessConversationSandbox(deps.sandboxResources, actor.id, id, (target: ScopeId) =>
    canUseSandboxScope(t, target),
  );
  const crossScope = resource.ownerScopeId !== writableScopeId && resource.ownerScopeId !== scopeId;
  if (!crossScope) return { resource, crossScope: false, egress: resolution.egress, commandPolicy: null };
  await deps.config!.refreshSecurity([resource.ownerScopeId]);
  const credentialScopeId = resource.ownerScopeId === personalScope(actor.id) ? resource.ownerScopeId : undefined;
  return {
    resource,
    crossScope: true,
    egress: intersectEgressPolicies(resolution.egress, deps.config!.setting("egress", resource.ownerScopeId)),
    commandPolicy: deps.config!.setting("commandPolicy", resource.ownerScopeId),
    ...(credentialScopeId ? { credentialScopeId } : {}),
  };
}

function jobComputerPlan(t: TurnSandboxState, resource: SandboxResource): SandboxAccessPlan {
  return { resource, crossScope: false, egress: t.resolution.egress, commandPolicy: null };
}

async function provisionJobComputer(t: TurnSandboxState): Promise<SandboxHandle> {
  const { deps, actor, memoryScopeId } = t;
  const resources = deps.sandboxResources!;
  const backend = (await resources.resolve(memoryScopeId))?.backend ?? resources.defaultBackend();
  const resource = await resources.create(actor.id, memoryScopeId, backend, "background job", undefined, true);
  return provisionResource(t, jobComputerPlan(t, resource));
}

async function provisionJobSandbox(t: TurnSandboxState, id: string): Promise<SandboxHandle> {
  const resource = await t.deps.sandboxResources!.get(id);
  return resource.jobOnly ? provisionResource(t, jobComputerPlan(t, resource)) : provisionResource(t, id);
}

async function provisionResource(
  t: TurnSandboxState,
  input: string | SandboxAccessPlan,
  authorize?: (access: SandboxAccessPlan) => void,
): Promise<SandboxHandle> {
  const {
    deps,
    resolution,
    connectorEnv,
    egressTokenForTurn,
    egressTokenForPolicy,
    resourceHandles,
    resourcePolicy,
    resourcePendingHandles,
    resourcePending,
  } = t;
  const access = typeof input === "string" ? await accessResource(t, input) : input;
  const { resource, crossScope, egress, credentialScopeId } = access;
  const id = resource.id;
  const pending = resourcePending.get(id);
  if (pending) {
    await pending;
    return provisionResource(t, id, authorize);
  }
  authorize?.(access);
  const policyKey = JSON.stringify({ egress, credentialScopeId });
  const existing = resourceHandles.get(id);
  if (existing && resourcePolicy.get(id) === policyKey) {
    return existing;
  }
  const provisioned = (async () => {
    const layers = crossScope
      ? resolution.layers
          .filter((layer) => layer.mode === "rw" || layer.mountPath === "global")
          .map((layer) => (layer.mode === "rw" ? { ...layer, scopeId: resource.ownerScopeId } : layer))
      : resolution.layers;
    if (crossScope && egressTokenForTurn && !egressTokenForPolicy)
      throw new Error("target sandbox egress authorization unavailable");
    const egressToken = crossScope ? await egressTokenForPolicy?.(egress) : egressTokenForTurn;
    const handle = await deps.sandbox.provision(layers, {
      sandboxId: id,
      ...(!crossScope ? { env: connectorEnv } : {}),
      ...(access.env ? { env: { ...access.env } } : {}),
      egress,
      ...(egressToken ? { egressToken } : {}),
    });
    resourcePendingHandles.set(id, handle);
    await holdResource(t, handle);
    if (!crossScope) {
      await prepareTurnFiles(t, handle);
    }
    resourceHandles.set(id, handle);
    resourcePolicy.set(id, policyKey);
    resourcePendingHandles.delete(id);
    return handle;
  })().finally(() => {
    resourcePending.delete(id);
  });
  resourcePending.set(id, provisioned);
  return provisioned;
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

async function clearTurnFiles(t: TurnSandboxState, handle: SandboxHandle): Promise<void> {
  const { deps, turnFilesDir } = t;
  await deps.sandbox
    .removeDir(handle, turnFilesDir)
    .catch((error: unknown) => reportSandboxError(t, "turn_files_cleanup_failed", error));
}

async function pruneSkills(t: TurnSandboxState, handle: SandboxHandle): Promise<void> {
  const { deps, visibleSkillsForTurn } = t;
  const visible = (await visibleSkillsForTurn()).flatMap((r) => (r.skill ? [r.skill, ...r.shadowed] : []));
  const keep = new Set(visible.map((skill) => hashId([skill.id, String(skill.version)], 16)));
  const stale = new Set<string>();
  const listed = await deps.sandbox
    .listDir(handle, SKILLS_ROOT)
    .catch(swallowAs("orchestrator: list skills to prune", [] as string[]));
  for (const path of listed) {
    const [root, conversation, identity] = path.split("/");
    if (root === SKILLS_ROOT && conversation && identity && !keep.has(identity))
      stale.add(`${SKILLS_ROOT}/${conversation}/${identity}`);
  }
  await Promise.all(
    [...stale].map((dir) =>
      deps.sandbox.removeDir(handle, dir).catch(swallowAs("orchestrator: stale skill cleanup", undefined)),
    ),
  );
}

async function clearStaleTurnFiles(t: TurnSandboxState, handle: SandboxHandle): Promise<void> {
  const { deps, turnSessionDir } = t;
  const cutoff = Date.now() - TURN_FILES_MAX_AGE_MS;
  const paths = deps.sandbox.removeDirAndList
    ? await deps.sandbox.removeDirAndList(handle, turnSessionDir, TURN_FILES_DIR)
    : await (async () => {
        await deps.sandbox.removeDir(handle, turnSessionDir);
        return deps.sandbox
          .listDir(handle, TURN_FILES_DIR)
          .catch(swallowAs("orchestrator: list stale turn files", [] as string[]));
      })();
  const stale = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    const startedAt = Number.parseInt(parts[2]?.split("-")[0] ?? "", 36);
    if (parts[0] === TURN_FILES_DIR && parts[1] && parts[2] && Number.isFinite(startedAt) && startedAt < cutoff) {
      stale.add(`${TURN_FILES_DIR}/${parts[1]}/${parts[2]}`);
    }
  }
  await Promise.all(
    [...stale].map((dir) =>
      deps.sandbox.removeDir(handle, dir).catch(swallowAs("orchestrator: stale turn file cleanup", undefined)),
    ),
  );
}

async function prepareTurnFiles(t: TurnSandboxState, handle: SandboxHandle): Promise<void> {
  await Promise.all([pruneSkills(t, handle), clearStaleTurnFiles(t, handle)]);
}

async function keepWarmAfterTurn(t: TurnSandboxState, handle: SandboxHandle): Promise<boolean> {
  const { deps } = t;
  const held = await releaseHold(t, handle).catch((error: unknown) => {
    reportSandboxError(t, "hold_release_failed", error);
    return true;
  });
  if (held) return true;
  if (!deps.processes || !handle.resourceId) return false;
  return deps.processes.hasLive(handle.resourceId).catch((error: unknown) => {
    reportSandboxError(t, "live_process_check_failed", error);
    return true;
  });
}

async function reclaimBox(t: TurnSandboxState): Promise<void> {
  const {
    deps,
    scopeId,
    box,
    scratch,
    resourceHandles,
    resourcePendingHandles,
    resourcePending,
    writableScopeId,
    reachBoxes,
  } = t;
  const reachHandles = [...reachBoxes.values()];
  reachBoxes.clear();
  await Promise.all(
    reachHandles.map(async (h) => {
      const keepWarm = await keepWarmAfterTurn(t, h);
      await deps.sandbox
        .teardown(h, keepWarm ? { keepWarm: true } : undefined)
        .catch((error: unknown) => reportSandboxError(t, "reach_teardown_failed", error));
    }),
  );
  const scratchFailure = await scratch.release().then(
    () => undefined,
    (error: unknown) => ({ error }),
  );
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
          await deps.sandbox.teardown(handle, { keepWarm: await keepWarmAfterTurn(t, handle) });
        }
      })(),
    );
  }
  const releasedResults = await Promise.allSettled(releases);
  for (const result of releasedResults)
    if (result.status === "rejected") reportSandboxError(t, "resource_teardown_failed", result.reason);
  resourceHandles.clear();
  resourcePendingHandles.clear();
  if (t.provisionInFlight) await t.provisionInFlight.catch(swallowAs("orchestrator: provision", undefined));
  t.provisionInFlight = null;
  const handle = box.handle ?? box.pending;
  box.handle = null;
  box.pending = null;
  if (!handle) {
    if (scratchFailure) throw scratchFailure.error;
    return;
  }
  await clearTurnFiles(t, handle);
  const keepWarm = await keepWarmAfterTurn(t, handle);
  await deps.sandbox.teardown(handle, {
    ...(keepWarm ? { keepWarm: true } : {}),
    ...(box.used ? {} : { homeUnchanged: true }),
  });
  if (scratchFailure) throw scratchFailure.error;
}
