import { hashId } from "../../util/crypto.ts";
import type { Principal, Resolution, ScopeId, Session } from "../../types.ts";
import { personalScope } from "../../types.ts";
import { intersectEgressPolicies } from "../../resolution/egress-policy.ts";
import { isOpenScopeMember } from "../../resolution/sharing-access.ts";
import type { GapPhase } from "../../sessions/session-store.ts";
import { type SandboxHandle, supportsProcessSessions } from "../../sandbox/sandbox.ts";
import { accessConversationSandbox, type SandboxAccessPlan } from "../../sandbox/sandbox-resources.ts";
import { reconcileProcesses } from "../../processes/reconcile.ts";
import { leaseLapsed } from "../../runs/run-store.ts";
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
import { sleep } from "../../util/async.ts";
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
  openSpeakerKeychain?: boolean;
  openResourceAccess?: boolean;
  ownerAuthAvailable: boolean;
  visibleSkillsForTurn: (sources?: readonly string[]) => Promise<SkillResolution[]>;
  emitGapWork: (phase: GapPhase, start: number, end: number) => void;
}

export function createTurnSandboxState(ctx: TurnSandboxContext) {
  const { deps, input } = ctx;
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
  return {
    ...ctx,
    box: {
      handle: null as SandboxHandle | null,
      pending: null as SandboxHandle | null,
      used: false,
      provisionMs: undefined as number | undefined,
    },
    scratchBox: {
      handle: null as SandboxHandle | null,
      pending: null as SandboxHandle | null,
      provisionMs: undefined as number | undefined,
    },
    ownerAuthBox: { handle: null as SandboxHandle | null, pending: null as SandboxHandle | null },
    provisionInFlight: null as Promise<SandboxHandle> | null,
    scratchProvisionInFlight: null as Promise<SandboxHandle> | null,
    ownerAuthProvisionInFlight: null as Promise<SandboxHandle> | null,
    scratchStartedAt: undefined as number | undefined,
    scratchReadyAt: undefined as number | undefined,
    onSandboxStatus,
    resourceHandles: new Map<string, SandboxHandle>(),
    resourcePolicy: new Map<string, string>(),
    resourcePendingHandles: new Map<string, SandboxHandle>(),
    resourcePending: new Map<string, Promise<SandboxHandle>>(),
    laidTrees: new Set<string>(),
    reachBoxes: new Map<ScopeId, SandboxHandle>(),
    writableScopeId: ctx.resolution.layers.find((layer) => layer.mode === "rw")?.scopeId,
  };
}

export type TurnSandboxState = ReturnType<typeof createTurnSandboxState>;

export const scratchKey = (t: TurnSandboxState) => `turn:${t.session.id}:${t.transferId}`;

export async function holdResource(t: TurnSandboxState, handle: SandboxHandle): Promise<void> {
  if (handle.resourceId && t.deps.runs && t.input.runId)
    await t.deps.sandboxResources?.hold(handle.resourceId, t.input.runId);
}

export async function releaseHold(t: TurnSandboxState, handle: SandboxHandle): Promise<boolean> {
  const runs = t.deps.runs;
  if (!handle.resourceId || !runs || !t.deps.sandboxResources) return false;
  return t.deps.sandboxResources.release(handle.resourceId, t.input.runId, async (runId) => {
    const run = await runs.get(runId);
    return run?.status === "running" && !leaseLapsed(run, Date.now());
  });
}

export function provision(t: TurnSandboxState, eager = false): Promise<SandboxHandle> {
  if (!eager) t.box.used = true;
  t.provisionInFlight ??= doProvision(t, eager ? () => {} : t.emitGapWork, eager).catch((err) => {
    t.provisionInFlight = null;
    throw err;
  });
  return t.provisionInFlight;
}

async function doProvision(
  t: TurnSandboxState,
  emit: TurnSandboxContext["emitGapWork"],
  eager: boolean,
): Promise<SandboxHandle> {
  const { deps, input, actor, session, resolution, scopeId, memoryScopeId, connectorEnv, box } = t;
  const { egressTokenForTurn, onSandboxStatus } = t;
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
  emit("provision", provisionStart, Date.now());
  box.provisionMs = Date.now() - provisionStart;
  deps.auditLog?.record({
    at: Date.now(),
    principalId: actor.id,
    action: "sandbox.scoped.provision_ready",
    resource: scratchKey(t),
    scopeLabel: scopeId,
    detail: JSON.stringify({
      runId: input.runId,
      sessionId: session.id,
      backend: handle.backend,
      sandboxId: handle.id,
      provisionMs: box.provisionMs,
      coldStart: handle.coldStart,
      eager,
    }),
  });
  const dirCleanupStart = Date.now();
  await prepareTurnFiles(t, handle);
  emit("dir_cleanup", dirCleanupStart, Date.now());
  if (deps.processes && supportsProcessSessions(deps.sandbox)) {
    const procReconcileStart = Date.now();
    try {
      await reconcileProcesses(deps.sandbox, handle, deps.processes, memoryScopeId, (exited, processId) =>
        finishProcessCredentials(
          {
            sandbox: deps.sandbox,
            processes: deps.processes!,
            ...(deps.keychain ? { keychain: deps.keychain } : {}),
          },
          exited,
          processId,
        ),
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
    } finally {
      emit("proc_reconcile", procReconcileStart, Date.now());
    }
  }
  box.handle = handle;
  return handle;
}

export async function clearTurnFiles(t: TurnSandboxState, handle: SandboxHandle): Promise<void> {
  const { deps, turnFilesDir } = t;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await deps.sandbox.removeDir(handle, turnFilesDir);
      return;
    } catch (err) {
      if (attempt === 3) swallow("orchestrator: turn file cleanup", err);
      else await sleep(50);
    }
  }
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

export async function hasLiveProcesses(t: TurnSandboxState, handle: SandboxHandle): Promise<boolean> {
  if (!t.deps.processes || !handle.resourceId) return false;
  return (await t.deps.processes.listLive()).some((process) => process.sandboxId === handle.resourceId);
}

const skillsRoot = (t: TurnSandboxState, r: SkillResolution) =>
  `${SKILLS_ROOT}/${t.turnSessionDir.split("/").at(-1)}/${hashId([r.skill!.id, String(r.skill!.version)], 16)}`;

async function materializeSkillTree(t: TurnSandboxState, handle: SandboxHandle, r: SkillResolution): Promise<void> {
  const { deps, scopeId, session, laidTrees, emitGapWork } = t;
  const treeKey = `${handle.resourceId ?? handle.id}:${skillDir(skillsRoot(t, r), r)}`;
  if (laidTrees.has(treeKey)) return;
  const start = Date.now();
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
  } finally {
    emitGapWork("skills_materialize", start, Date.now());
  }
}

export async function useSkill(
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
  const { deps, actor, scopeId, writableScopeId, openResourceAccess } = t;
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

export async function accessResource(t: TurnSandboxState, id: string): Promise<SandboxAccessPlan> {
  const { deps, actor, scopeId, writableScopeId, resolution } = t;
  const resource = await accessConversationSandbox(deps.sandboxResources, actor.id, id, (target) =>
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

export async function provisionResource(
  t: TurnSandboxState,
  input: string | SandboxAccessPlan,
  authorize?: (access: SandboxAccessPlan) => void,
): Promise<SandboxHandle> {
  const { deps, resolution, connectorEnv, egressTokenForTurn, egressTokenForPolicy } = t;
  const { resourcePending, resourceHandles, resourcePolicy, resourcePendingHandles } = t;
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
