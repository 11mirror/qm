import { bindProviderIdentity } from "./provider-identity.ts";
import {
  createProviderEgress,
  withProcessHold,
  restartWithCheckpointFallback,
  type ProviderControls,
} from "./provider-controls.ts";
import { sandboxPolicy } from "./provider-policy.ts";
import { createProviderMaintenance } from "./provider-maintenance.ts";
import { createProviderRecovery } from "./provider-recovery.ts";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { LayerInstallFile } from "../deployment/load-layer.ts";
import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import { ephemeralCredLinkPaths, type CredentialPathSpec } from "../credentials/resident-paths.ts";
import { createExecProcessSessions } from "./exec-process-session.ts";
import {
  createBackendBlobStaging,
  createExecExport,
  createExecFileOps,
  type BlobStagingOptions,
} from "./exec-file-ops.ts";
import { createExecSandboxBase, sandboxScopeName, type ExecSandboxBase } from "./exec-sandbox-base.ts";
import { createLayerToolInstaller } from "./layer-tool-install.ts";
import { withConnectorSdk, type ConnectorSdkBundle } from "./connector-sdk.ts";
import { isJobComputerScope, visibleNotInstalled, visibleTools } from "./sandbox.ts";
import type { SandboxBodies } from "./sandbox-bodies.ts";
import type {
  AgentComputerProfile,
  BackendSandbox,
  ComputerStatus,
  EgressEnforcement,
  ExecResult,
  ProvisionOptions,
  SandboxHandle,
  TeardownOptions,
  WritablePersistence,
} from "./sandbox.ts";

const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_SNAPSHOT_INTERVAL_SEC = 300;
const GUEST_PROBE_TIMEOUT_SEC = 15;
const BASE_TOOLS = ["git", "curl", "jq", "tar", "python3"];
const OPTIONAL_TOOLS = ["gh", "aws", "gcloud", "kubectl", "flyctl", "glab"];

type ErrorReport = (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;

export interface SandboxShared extends BlobStagingOptions {
  machineName?: (scope: string) => Promise<string | undefined>;
  defaultTimeoutSec?: number;
  egressProxyUrl?: string;
  snapshotIntervalSec?: number;
  cpus?: number;
  memoryMb?: number;
  diskGb?: number;
  idleParkSec?: number;
  maxLifetimeSec?: number;
  keepWarmSec?: number;
  advisoryLock: AdvisoryLock;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  layerToolFiles?: () => readonly LayerInstallFile[];
  connectorSdk?: () => Promise<ConnectorSdkBundle>;
  onError?: ErrorReport;
}

export const sandboxNamePrefix = (shared: BlobStagingOptions): string =>
  shared.tenantConfig?.().sandboxNamePrefix ?? "qm";

export const sandboxOwnership = (shared: BlobStagingOptions, kind: "scope" | "scratch"): Record<string, string> => ({
  "qm-org": shared.tenantConfig?.().orgId ?? "",
  "qm-prefix": sandboxNamePrefix(shared),
  "qm-kind": kind,
});

export interface StoredSandboxRecord {
  sandboxId?: string;
  sessionId?: string;
  createdAtMs?: number;
  expiresAtMs?: number;
  lastActivityMs?: number;
  orgId?: string;
  initializationPending?: boolean;
  lastSnapshotMs?: number;
  homeDirty?: boolean;
  snapshotError?: string;
  checkpointId?: string;
  checkpointAtMs?: number;
}

export interface MachineState {
  id?: string;
  fault?: string;
  replacementRequired?: boolean;
  state: "running" | "parked";
  detail: string;
  resources?: ComputerStatus["resources"];
  expiresAtMs?: number;
}

interface DriverCheckpoints {
  kind?: "directory" | "image" | "machine" | "session";
  retentionMs?: number | null;
  machineBound?: boolean;
  latest?(name: string): Promise<{ id: string; createdAt: string } | undefined>;
  capture(name: string): Promise<string>;
  restore(name: string, checkpointId: string): Promise<void | { detail: string }>;
  drop?(name: string, checkpointId: string): Promise<void>;
}

export interface SandboxDriver extends ProviderControls {
  backend: string;
  identityField?: "sandboxId" | "sessionId";
  homeDir: string;
  os: string;
  runtimes?: string[];
  tools?: string[];
  cpus?: number;
  memoryMb?: number;
  diskGb?: number;
  writablePersistence?: WritablePersistence;
  egressEnforcement: EgressEnforcement;
  combineRoundTrips?: boolean;
  envViaExec?: boolean;
  exec(name: string, script: string, timeoutSec: number, env?: Record<string, string>): Promise<ExecResult>;
  writeAbsBytes(name: string, absPath: string, data: Uint8Array): Promise<void>;
  readAbsBytes(name: string, absPath: string): Promise<Uint8Array | null>;
  inspect(name: string, identity?: string): Promise<MachineState | null>;
  create(
    name: string,
    opts: { scratch: boolean; scope?: string; checkpointId?: string },
  ): Promise<void | { homeRetained?: boolean; id?: string; expiresAtMs?: number }>;
  resume(name: string): Promise<void>;
  park?(name: string): Promise<void>;
  keepWarm?(name: string, seconds: number): Promise<void>;
  replace?(name: string): Promise<void>;
  processHold?: { refresh(processId: string): string; release(processId: string): string };
  configure?(name: string, resources: { cpus?: number; memoryMb?: number; diskGb?: number }): Promise<void>;
  destroy(name: string, identity?: string): Promise<void>;
  isLive(name: string): boolean;
  forget?(name: string): void;
  restart?(name: string, ctx: { initializationPending: boolean }): Promise<void>;
  lifetimeMs?: number;
  isGone?(error: unknown): boolean;
  isCommandLost?(error: unknown): boolean;
  replacement?: "checkpoint";
  listRunning?(tags: Record<string, string>): AsyncIterable<string>;
  terminateById?(id: string): Promise<void>;
  knownIds?(): Iterable<string>;
  ensureEgress?(name: string): Promise<void>;
  checkpoints?: DriverCheckpoints;
}

export type ProviderSandbox = BackendSandbox & {
  readonly scopeFor: (name: string) => string | undefined;
  readonly scopeOf: (name: string) => Promise<string | undefined>;
  readonly nameFor: (scopeId: string) => Promise<string>;
  readonly lifecycle: <T>(scopeId: string, fn: () => Promise<T>) => Promise<T>;
  readonly captureCheckpoint: (scopeId: string, name: string) => Promise<void>;
  readonly ensureResident: (scopeId: string) => Promise<void>;
};

export interface ProviderContext {
  driver: SandboxDriver;
  store: SandboxBodies<StoredSandboxRecord>;
  backend: string;
  lock: <T>(scope: string, fn: () => Promise<T>) => Promise<T>;
  rotationDue: (name: string, stored: StoredSandboxRecord | null | undefined) => boolean;
  report: (category: string, code: string, e: unknown, scopeLabel?: string) => void;
}

function createProviderCheckpointing({ driver, store, backend, report, rotationDue }: ProviderContext) {
  async function captureCheckpoint(scope: string, name: string): Promise<void> {
    if (isJobComputerScope(scope)) return;
    const previous = (await store.get(scope))?.checkpointId;
    try {
      const checkpointId = await driver.checkpoints!.capture(name);
      await store.upsert(scope, {
        checkpointId,
        checkpointAtMs: Date.now(),
        lastSnapshotMs: Date.now(),
        homeDirty: false,
        snapshotError: undefined,
      });
      if (previous && previous !== checkpointId)
        await driver.checkpoints
          ?.drop?.(name, previous)
          .catch(swallowAs(`${backend}-sandbox: drop checkpoint`, undefined));
    } catch (e) {
      await store.upsert(scope, { snapshotError: errMessage(e) });
      throw e;
    }
  }

  async function rotate(scope: string, name: string): Promise<boolean> {
    try {
      if (driver.checkpoints) await captureCheckpoint(scope, name);
      await driver.destroy(name);
      driver.forget?.(name);
      return true;
    } catch (e) {
      report("sandbox_snapshot", "rotate_failed", e, scope);
      return false;
    }
  }

  async function initialize(scope: string, name: string, onStatus?: (text: string) => void): Promise<boolean> {
    let stored = await store.get(scope);
    if (driver.isLive(name) && !stored?.initializationPending) return false;
    let existing = await driver.inspect(name);
    if (existing && !stored?.initializationPending && rotationDue(name, stored) && (await rotate(scope, name))) {
      existing = null;
      stored = await store.get(scope);
    }
    if (existing && !stored?.initializationPending) {
      if (existing.replacementRequired && driver.replace) await driver.replace(name);
      else if (existing.state === "parked") await driver.resume(name);
      return false;
    }
    if (!existing && driver.replacement === "checkpoint" && stored?.homeDirty && !stored.checkpointId)
      throw new Error(`${backend} sandbox is gone; explicitly import a recovery snapshot before replacing its home`);
    if (!existing && stored?.checkpointId && driver.checkpoints && !driver.checkpoints.machineBound)
      await assertProviderCheckpoint({ driver, store, backend }, scope);
    await store.upsert(scope, { initializationPending: true });
    onStatus?.("Preparing the sandbox…");
    let created = false;
    let booted = false;
    let retained = false;
    try {
      if (existing) await driver.resume(name);
      else {
        const made = await driver.create(name, { scratch: false, scope, checkpointId: stored?.checkpointId });
        retained = made?.homeRetained ?? false;
        if (driver.lifetimeMs)
          await store.update(scope, {
            sandboxId: made?.id,
            createdAtMs: Date.now(),
            expiresAtMs: made?.expiresAtMs ?? Date.now() + driver.lifetimeMs,
          });
        created = true;
      }
      booted = true;
      const checkpointId = stored?.checkpointId;
      const machineBound = !!driver.checkpoints?.machineBound;
      const restored =
        !retained && checkpointId && driver.checkpoints && !machineBound
          ? (await restoreProviderCheckpoint({ driver, store, backend }, scope, name, checkpointId), true)
          : false;
      const hydrated = restored || retained;
      await store.upsert(scope, {
        initializationPending: undefined,
        ...(hydrated ? { homeDirty: false } : {}),
        ...(created && machineBound ? { checkpointId: undefined, checkpointAtMs: undefined } : {}),
      });
      return !hydrated;
    } catch (e) {
      if (created)
        await driver.destroy(name).catch(swallowAs(`${backend}-sandbox: destroy after failed hydration`, undefined));
      driver.forget?.(name);
      if (!booted) throw e;
      report("sandbox_hydrate", "hydrate_failed", e, scope);
      throw new Error(
        `${backend} provision: checkpoint restore failed (${errMessage(e)}); not starting an empty home`,
        {
          cause: e,
        },
      );
    }
  }

  return { captureCheckpoint, initialize };
}

function createProviderBase(
  workspace: WorkspaceStore,
  { driver, backend, lock }: ProviderContext,
  shared: SandboxShared,
  deps: {
    prefix: () => string;
    defaultTimeoutSec: number;
    initialize: (scope: string, name: string, onStatus?: (text: string) => void) => Promise<boolean>;
    scopeOf: (name: string) => Promise<string | undefined>;
    nameFor: (scope: string) => Promise<string>;
  },
): ExecSandboxBase {
  const { homeDir } = driver;
  const { prefix, defaultTimeoutSec, initialize, scopeOf } = deps;
  return createExecSandboxBase({
    workspace,
    label: backend,
    prefix,
    nameFor: deps.nameFor,
    homeDir,
    defaultTimeoutSec,
    credentialPaths: shared.credentialPaths ?? [],
    ...(shared.layerToolFiles || shared.connectorSdk
      ? {
          installLayerTools: withConnectorSdk(
            homeDir,
            createLayerToolInstaller(shared.layerToolFiles ?? (() => [])),
            shared.connectorSdk,
          ),
        }
      : {}),
    ...(driver.combineRoundTrips ? { combineLayerToolPrep: true } : {}),
    ...(shared.egressProxyUrl ? { egressProxyUrl: shared.egressProxyUrl } : {}),
    deleteFailureCode: `${backend}_delete_failed`,
    ...(shared.onError ? { onError: shared.onError } : {}),
    exec: driver.exec,
    ...(driver.envViaExec ? { envViaExec: true } : {}),
    writeAbsBytes: driver.writeAbsBytes,
    readAbsBytes: driver.readAbsBytes,
    ensureResident: async (name, scope, onStatus) => {
      return { coldStart: await lock(scope, () => initialize(scope, name, onStatus)) };
    },
    isProvisioned: driver.isLive,
    async recreateScratch(name) {
      await driver.destroy(name).catch(swallowAs(`${backend}-sandbox: stale scratch destroy`, undefined));
      await driver.create(name, { scratch: true });
      await driver.configure?.(name, { cpus: shared.cpus, memoryMb: shared.memoryMb, diskGb: shared.diskGb });
    },
    deleteInstance: async (name) => {
      const scope = await scopeOf(name);
      return scope ? lock(scope, () => driver.destroy(name)) : driver.destroy(name);
    },
    ...(driver.forget ? { forgetInstance: driver.forget } : {}),
    ...(driver.ensureEgress || driver.network ? createProviderEgress(driver, shared) : {}),
  });
}

function providerProfile(driver: SandboxDriver, shared: SandboxShared, workdir: string): AgentComputerProfile {
  const { backend, homeDir } = driver;
  const extraTools = shared.extraTools ?? [];
  return {
    backend,
    writablePersistence: driver.writablePersistence ?? "resident_disk",
    processSessions: true,
    ...(driver.park ? { parksOnTeardown: true } : {}),
    egressEnforcement: driver.egressEnforcement,
    spec: {
      os: driver.os,
      runtimes: driver.runtimes ?? ["Node", "Python 3"],
      tools: visibleTools([...(driver.tools ?? BASE_TOOLS), ...extraTools]),
      notInstalled: visibleNotInstalled(
        OPTIONAL_TOOLS.filter((t) => !(driver.tools ?? []).includes(t)),
        extraTools,
      ),
      get cpus() {
        return driver.cpus;
      },
      get memoryMb() {
        return driver.memoryMb;
      },
      get diskGb() {
        return driver.diskGb;
      },
      homeDir,
      workdir,
    },
  };
}

async function providerRecovery(
  { driver, store }: ProviderContext,
  scope: string,
): Promise<Pick<ComputerStatus, "recovery">> {
  if (!driver.checkpoints) return {};
  const stored = await store.get(scope);
  const capturedAtMs = stored?.checkpointAtMs ?? stored?.lastSnapshotMs;
  const retentionMs = driver.checkpoints.retentionMs;
  const expiry =
    retentionMs !== undefined && retentionMs !== null && capturedAtMs
      ? { checkpointExpiresAtMs: capturedAtMs + retentionMs }
      : {};
  return {
    recovery: {
      strategy: "provider_snapshot",
      ...(stored?.checkpointId ? { checkpointId: stored.checkpointId } : {}),
      ...(capturedAtMs ? { checkpointAtMs: capturedAtMs } : {}),
      ...(retentionMs === null ? { checkpointExpiresAtMs: null } : expiry),
      ...(stored?.snapshotError ? { error: stored.snapshotError } : {}),
    },
  };
}

function createProviderResidency(
  { driver, store, lock, report }: ProviderContext,
  base: ExecSandboxBase,
  deps: {
    nameFor: (scope: string) => Promise<string>;
    requireScope: (name: string) => Promise<string>;
    checkpointDue: (stored: StoredSandboxRecord | null | undefined, opts?: TeardownOptions) => boolean;
    captureCheckpoint: (scope: string, name: string) => Promise<void>;
    keepWarmSec: number;
  },
) {
  const { nameFor, requireScope, checkpointDue, captureCheckpoint } = deps;
  const residents = new Map<string, number>();
  const hold = (name: string, delta: number): void => {
    const count = (residents.get(name) ?? 0) + delta;
    if (count > 0) residents.set(name, count);
    else residents.delete(name);
  };

  async function provision(layers: WorkspaceLayer[], opts?: ProvisionOptions): Promise<SandboxHandle> {
    if (opts?.scratch) return base.provision(layers, opts);
    const writable = layers.find((l) => l.mode === "rw") ?? layers[0];
    const name = await nameFor(writable?.scopeId ?? "default");
    hold(name, 1);
    try {
      return await base.provision(layers, opts);
    } catch (e) {
      hold(name, -1);
      throw e;
    }
  }

  async function teardown(handle: SandboxHandle, opts?: TeardownOptions): Promise<void> {
    if (!handle.scratch) hold(handle.id, -1);
    if (!handle.scratch && opts?.destroy && driver.checkpoints?.machineBound) {
      const scope = await requireScope(handle.id);
      await base.provisionQueue(scope, () =>
        lock(scope, () => store.upsert(scope, { checkpointId: undefined, checkpointAtMs: undefined })),
      );
    }
    if (!handle.scratch && !opts?.destroy) {
      const scope = await requireScope(handle.id);
      await base.provisionQueue(scope, () =>
        lock(scope, async () => {
          const stored = await store.get(scope);
          if (stored?.initializationPending) return;
          if (!opts?.homeUnchanged) await store.upsert(scope, { homeDirty: true });
          if (residents.has(handle.id)) return;
          if (driver.checkpoints && checkpointDue(stored, opts)) {
            await captureCheckpoint(scope, handle.id).catch((e) =>
              report("sandbox_snapshot", "teardown_snapshot_failed", e, scope),
            );
          }
          if (driver.park && (!opts?.keepWarm || driver.keepWarm)) {
            await driver[opts?.keepWarm && driver.keepWarm ? "keepWarm" : "park"]!(handle.id, deps.keepWarmSec).catch(
              (e) => report("sandbox_teardown", "park_failed", e, scope),
            );
          }
        }),
      );
    }
    return base.teardown(handle, opts);
  }

  return { provision, teardown };
}

function providerScopeMethods(
  ctx: ProviderContext,
  base: ExecSandboxBase,
  nameFor: (scope: string) => Promise<string>,
) {
  const { driver, store, backend, lock } = ctx;
  const recovery = (scope: string) => providerRecovery(ctx, scope);
  return {
    async computerStatus(scopeId: string): Promise<ComputerStatus> {
      const name = await nameFor(scopeId);
      const rec = await recovery(scopeId);
      const stored = await store.get(scopeId);
      let machine: MachineState | null;
      try {
        machine = await driver.inspect(name);
      } catch (e) {
        return { ...rec, machine: `lookup failed: ${errMessage(e)}`, guestResponsive: false };
      }
      if (!machine)
        return { ...rec, machine: "no machine provisioned yet", provisioned: false, guestResponsive: false };
      if (machine.state === "parked")
        return { ...rec, machine: machine.detail, lifecycleState: "paused", provisioned: true, guestResponsive: false };
      let guestResponsive = false;
      let pressure: ComputerStatus["pressure"];
      let probeError: string | undefined;
      try {
        const probe = await driver.exec(name, "true", GUEST_PROBE_TIMEOUT_SEC);
        guestResponsive = probe.code === 0;
        pressure = probe.pressure;
      } catch (e) {
        probeError = errMessage(e);
      }
      return {
        ...rec,
        machine: machine.detail,
        lifecycleState: "running",
        provisioned: true,
        guestResponsive,
        ...(probeError ? { probeError } : {}),
        ...(pressure ? { pressure } : {}),
        ...(machine.resources ? { resources: machine.resources } : {}),
        ...((machine.expiresAtMs ?? stored?.expiresAtMs)
          ? { expiresAtMs: machine.expiresAtMs ?? stored?.expiresAtMs }
          : {}),
      };
    },

    ...(driver.restart || driver.checkpoints
      ? {
          async restartComputer(scopeId: string): Promise<void> {
            const name = await nameFor(scopeId);
            await base.provisionQueue(scopeId, () =>
              lock(scopeId, async () => {
                const stored = await store.get(scopeId);
                if (driver.lifetimeMs) {
                  if (!stored) return;
                  if (!stored.initializationPending && (await driver.inspect(name)))
                    await createProviderCheckpointing(ctx).captureCheckpoint(scopeId, name);
                  await driver.destroy(name);
                  driver.forget?.(name);
                  await store.update(scopeId, { initializationPending: undefined, snapshotError: undefined });
                  return;
                }
                if (driver.restart)
                  return restartWithCheckpointFallback(driver, name, stored, (message) =>
                    ctx.report("agent_computer", "checkpoint_restored", message, scopeId),
                  );
                if (!stored?.checkpointId) throw new Error(`${backend} restart: no checkpoint to restore`);
                try {
                  const restored = await restoreProviderCheckpoint(
                    { driver, store, backend },
                    scopeId,
                    name,
                    stored.checkpointId,
                  );
                  if (restored) ctx.report("agent_computer", "checkpoint_restored", restored.detail, scopeId);
                } catch (error) {
                  if (driver.checkpoints?.kind === "session")
                    ctx.report("agent_computer", "checkpoint_rollback_failed", error, scopeId);
                  throw error;
                }
              }),
            );
          },
        }
      : {}),

    async destroyScope(scopeId: string): Promise<void> {
      const name = await nameFor(scopeId);
      await base.provisionQueue(scopeId, () =>
        lock(scopeId, async () => {
          const stored = await store.get(scopeId);
          await driver.destroy(name);
          driver.forget?.(name);
          if (stored?.checkpointId)
            await driver.checkpoints
              ?.drop?.(name, stored.checkpointId)
              .catch(swallowAs(`${backend}-sandbox: drop checkpoint on destroy`, undefined));
          await store.delete(scopeId);
        }),
      );
    },
  } satisfies Partial<ProviderSandbox>;
}

export function createProviderSandbox(
  workspace: WorkspaceStore,
  driver: SandboxDriver,
  shared: SandboxShared,
  store: SandboxBodies<StoredSandboxRecord>,
): ProviderSandbox {
  const { backend, homeDir } = driver;
  const policy = sandboxPolicy(backend, shared);
  const prefix = (): string => sandboxNamePrefix(shared);
  const defaultTimeoutSec = shared.defaultTimeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const snapshotIntervalMs = (shared.snapshotIntervalSec ?? DEFAULT_SNAPSHOT_INTERVAL_SEC) * 1000;
  const checkpointDue = (stored: StoredSandboxRecord | null | undefined, opts?: TeardownOptions): boolean => {
    if (stored?.lastSnapshotMs && Date.now() - stored.lastSnapshotMs < snapshotIntervalMs) return false;
    return !opts?.homeUnchanged || stored?.homeDirty !== false;
  };
  const lock = <T>(scope: string, fn: () => Promise<T>): Promise<T> =>
    shared.advisoryLock.withLock(`${backend}-provision:${prefix()}:${scope}`, fn);
  const scopeByName = new Map<string, string>();
  const nameFor = async (scope: string): Promise<string> => {
    const name = (await shared.machineName?.(scope)) ?? sandboxScopeName(prefix(), scope);
    scopeByName.set(name, scope);
    return name;
  };
  const scopeFor = (name: string): string | undefined => base.scopeFor(name) ?? scopeByName.get(name);
  async function scopeOf(name: string): Promise<string | undefined> {
    const known = scopeFor(name);
    if (known) return known;
    for (const [scope] of await store.entries()) await nameFor(scope);
    return scopeByName.get(name);
  }
  async function requireScope(name: string): Promise<string> {
    const scope = await scopeOf(name);
    if (!scope) throw new Error(`${backend} sandbox ${name}: no stored scope maps to this name`);
    return scope;
  }
  driver = bindProviderIdentity(driver, store, scopeOf);
  const credentialPrefixes = ephemeralCredLinkPaths(shared.credentialPaths ?? []).map(({ rel }) => rel);

  const report = (category: string, code: string, e: unknown, scopeLabel?: string): void => {
    try {
      shared.onError?.({ category, code, message: errMessage(e), ...(scopeLabel ? { scopeLabel } : {}) });
    } catch (error) {
      swallow(`${backend}-sandbox: ${code} report`, error);
    }
  };
  const maintenance = createProviderMaintenance(driver, store, shared, {
    nameFor,
    scopeOf,
    report,
    lifecycle: (scope, fn) => base.provisionQueue(scope, () => lock(scope, fn)),
    ensureResident: async (scope) => {
      const name = await nameFor(scope);
      await base.provisionQueue(scope, () => lock(scope, () => initialize(scope, name)));
    },
    captureCheckpoint: (scope, name) => captureCheckpoint(scope, name),
  });
  const ctx: ProviderContext = { driver, store, backend, lock, report, rotationDue: maintenance.rotationDue };
  const checkpointing = createProviderCheckpointing(ctx);
  const { captureCheckpoint } = checkpointing;
  const initialize = async (scope: string, name: string, onStatus?: (text: string) => void): Promise<boolean> => {
    const cold = await checkpointing.initialize(scope, name, onStatus);
    const desired = { cpus: shared.cpus, memoryMb: shared.memoryMb, diskGb: shared.diskGb };
    await driver.configure?.(name, desired);
    if (driver.network && (shared.egressProxyUrl || driver.network.reconcile === "always"))
      await createProviderEgress(driver, shared).ensureEgress(name);
    return cold;
  };
  const recovered = createProviderRecovery(driver, store, shared, {
    scopeOf,
    initialize: (scope, name) => base.provisionQueue(scope, () => lock(scope, () => initialize(scope, name))),
    touch: maintenance.touch,
    report,
    scopeFor,
  });
  const base = createProviderBase(workspace, { ...ctx, driver: recovered }, shared, {
    prefix,
    defaultTimeoutSec,
    initialize,
    scopeOf,
    nameFor,
  });
  const profile = providerProfile(driver, shared, base.workspaceDir);

  const procSessions = createExecProcessSessions({
    run: (handle, command, execOpts) =>
      recovered.exec(
        handle.id,
        command,
        execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec,
      ),
  });
  const fileOps = createExecFileOps({
    label: backend,
    exec: recovered.exec,
    writeInline: recovered.writeAbsBytes,
    ...(driver.combineRoundTrips ? { combineRemoveAndList: true } : {}),
  });
  const staging = createBackendBlobStaging(backend, recovered.exec, shared);
  const execExport = createExecExport({
    label: backend,
    exec: recovered.exec,
    readAbsBytes: recovered.readAbsBytes,
    defaultHomeDir: homeDir,
    ephemeralCredentialPrefixes: credentialPrefixes,
  });
  const { provision, teardown } = createProviderResidency(ctx, base, {
    nameFor,
    requireScope,
    checkpointDue,
    captureCheckpoint,
    keepWarmSec: policy.keepWarmSec,
  });

  return {
    profile,
    scopeFor,
    scopeOf,
    nameFor,
    lifecycle: (scope, fn) => base.provisionQueue(scope, () => lock(scope, fn)),
    captureCheckpoint,
    ensureResident: async (scope) => {
      const name = await nameFor(scope);
      await base.provisionQueue(scope, () => lock(scope, () => initialize(scope, name)));
    },
    provision,
    run: base.run,
    writeFile: base.writeFile,
    writeFileBytes: base.writeFileBytes,
    readFile: base.readFile,
    readFileBytes: base.readFileBytes,
    ...fileOps,
    ...staging,
    exportFiles: execExport.exportFiles,
    startProcess: withProcessHold(driver, recovered.exec, procSessions.startProcess, report, scopeFor),
    readProcess: procSessions.readProcess,
    writeStdin: procSessions.writeStdin,
    signalProcess: procSessions.signalProcess,
    listProcesses: procSessions.listProcesses,
    teardown: async (handle, opts) => {
      await teardown(handle, opts);
      if (!handle.scratch && !opts?.destroy) await maintenance.touch(handle.id, true);
    },
    ...providerScopeMethods(ctx, base, nameFor),
    ...(driver.lifetimeMs ? { reapDeepIdle: maintenance.reapDeepIdle } : {}),
  };
}

async function restoreProviderCheckpoint(
  { driver, store, backend }: Pick<ProviderContext, "driver" | "store" | "backend">,
  scope: string,
  name: string,
  checkpointId: string,
): Promise<void | { detail: string }> {
  await assertProviderCheckpoint({ driver, store, backend }, scope);
  const result = await driver.checkpoints!.restore(name, checkpointId);
  return result;
}

async function assertProviderCheckpoint(
  { driver, store, backend }: Pick<ProviderContext, "driver" | "store" | "backend">,
  scope: string,
): Promise<void> {
  const at = (await store.get(scope))?.checkpointAtMs;
  const retentionMs = driver.checkpoints!.retentionMs;
  if (at && retentionMs != null && at + retentionMs <= Date.now())
    throw new Error(
      `${backend} home checkpoint has expired; explicitly import a recovery snapshot before creating a replacement`,
    );
}
