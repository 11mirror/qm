import { createExecProcessSessions } from "./exec-process-session.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import {
  sandboxOwnership,
  type SandboxDriver,
  type SandboxShared,
  type StoredSandboxRecord,
} from "./provider-sandbox.ts";
import type { SandboxBodies } from "./sandbox-bodies.ts";
import type { SandboxHandle } from "./sandbox.ts";
const ROTATE_MARGIN_MS = 4 * 3600_000;
const RETIRE_MARGIN_MS = 30 * 60_000;
const ROTATION_HOLD_MS = 10 * 60_000;
const RENEW_MARGIN_MS = 7 * 24 * 3600_000;
const ORPHAN_GRACE_MS = 10 * 60_000;
const ACTIVITY_TOUCH_INTERVAL_MS = 10 * 60_000;
const DEFAULT_IDLE_REAP_MS = 6 * 3600_000;
interface MaintenanceDeps {
  nameFor(scope: string): Promise<string>;
  scopeOf(name: string): Promise<string | undefined>;
  lifecycle<T>(scope: string, fn: () => Promise<T>): Promise<T>;
  ensureResident(scope: string): Promise<void>;
  captureCheckpoint(scope: string, name: string): Promise<void>;
  report(category: string, code: string, error: unknown, scope?: string): void;
}
export function createProviderMaintenance(
  driver: SandboxDriver,
  store: SandboxBodies<StoredSandboxRecord>,
  shared: SandboxShared,
  deps: MaintenanceDeps,
) {
  const rotationHold = new Map<string, number>();
  const lastTouch = new Map<string, number>();
  const refreshAttempt = new Map<string, number>();
  const orphanFirstSeen = new Map<string, number>();
  const snapshotIntervalMs = (shared.snapshotIntervalSec ?? 300) * 1000;
  const exclusive = <T>(scope: string, fn: () => Promise<T>): Promise<T> =>
    exclusiveProviderUse(driver, shared, scope, fn);
  const report = (category: string, code: string, error: unknown, scope?: string): void => {
    if (!driver.isGone?.(error)) deps.report(category, code, error, scope);
  };
  async function touch(name: string, force = false): Promise<void> {
    if (!driver.lifetimeMs) return;
    const scope = await deps.scopeOf(name);
    if (!scope) return;
    const now = Date.now();
    if (!force && now - (lastTouch.get(name) ?? 0) < ACTIVITY_TOUCH_INTERVAL_MS) return;
    lastTouch.set(name, now);
    await store
      .update(scope, { lastActivityMs: now })
      .catch(swallowAs(`${driver.backend}-sandbox: record activity`, undefined));
  }
  const rotationDue = (name: string, rec: StoredSandboxRecord | null | undefined): boolean => {
    const now = Date.now();
    if (
      !driver.lifetimeMs ||
      !rec?.expiresAtMs ||
      rec.expiresAtMs - now > ROTATE_MARGIN_MS ||
      now < (rotationHold.get(name) ?? 0)
    )
      return false;
    rotationHold.set(name, now + ROTATION_HOLD_MS);
    return true;
  };
  async function destroy(name: string): Promise<void> {
    await driver.destroy(name);
    driver.forget?.(name);
  }
  async function renew(scope: string, name: string, rec: StoredSandboxRecord): Promise<void> {
    try {
      await deps.ensureResident(scope);
      await deps.lifecycle(scope, () => deps.captureCheckpoint(scope, name));
      await deps.lifecycle(scope, () =>
        exclusive(scope, async () => {
          const after = await store.get(scope);
          if (after && !after.initializationPending && after.lastActivityMs === rec.lastActivityMs) await destroy(name);
        }),
      );
    } catch (e) {
      report("sandbox_snapshot", "checkpoint_renewal_failed", e, scope);
    }
  }
  function retire(scope: string, name: string, rec: StoredSandboxRecord, idleCutoffMs?: number): Promise<number> {
    return deps.lifecycle(scope, () =>
      exclusive(scope, async () => {
        const now = await store.get(scope);
        if (!now || now.initializationPending || now.sandboxId !== rec.sandboxId) return 0;
        if (idleCutoffMs !== undefined && (!now.lastActivityMs || now.lastActivityMs > idleCutoffMs)) return 0;
        try {
          if (driver.checkpoints) await deps.captureCheckpoint(scope, name);
          await destroy(name);
          return 1;
        } catch (e) {
          if (driver.isGone?.(e)) driver.forget?.(name);
          else report("sandbox_reap", "deep_idle_reap_failed", e, scope);
          return 0;
        }
      }),
    );
  }
  async function forgetGone(scope: string, name: string, rec: StoredSandboxRecord, now: number): Promise<void> {
    driver.forget?.(name);
    if (rec.checkpointId) {
      if (renewalDue(driver, rec, now)) await renew(scope, name, rec);
      return;
    }
    await deps.lifecycle(scope, async () => {
      const after = await store.get(scope);
      if (after && !after.checkpointId && !after.initializationPending && !(await driver.inspect(name)))
        await store.delete(scope);
    });
  }
  async function busy(name: string): Promise<boolean> {
    const handle: SandboxHandle = {
      id: name,
      rootDir: `${driver.homeDir}/workspace`,
      homeDir: driver.homeDir,
      coldStart: false,
    };
    const live = await createExecProcessSessions({ run: (h, command) => driver.exec(h.id, command, 60) }).listProcesses(
      handle,
    );
    return live.some((p) => p.status.state === "running");
  }
  async function refresh(scope: string, name: string, rec: StoredSandboxRecord, now: number): Promise<void> {
    if (
      !driver.checkpoints ||
      now - Math.max(rec.lastSnapshotMs ?? 0, refreshAttempt.get(name) ?? 0) <= snapshotIntervalMs
    )
      return;
    refreshAttempt.set(name, now);
    await deps
      .lifecycle(scope, async () => {
        const after = await store.get(scope);
        if (after && after.sandboxId === rec.sandboxId && !after.initializationPending)
          await deps.captureCheckpoint(scope, name);
      })
      .catch((e) => report("sandbox_snapshot", "periodic_snapshot_failed", e, scope));
  }
  const sweepOrphans = () => reapProviderOrphans(driver, store, shared, deps.report, orphanFirstSeen);
  async function reapDeepIdle(idleMs: number): Promise<{ reaped: number }> {
    if (!(idleMs > 0)) return { reaped: 0 };
    const now = Date.now();
    const cutoff = now - Math.min(idleMs, shared.idleParkSec ? shared.idleParkSec * 1000 : DEFAULT_IDLE_REAP_MS);
    let reaped = 0;
    for (const [scope, rec] of await store.entries()) {
      if (rec.initializationPending) continue;
      const name = await deps.nameFor(scope);
      try {
        const machine = await driver.inspect(name);
        if (!machine) {
          await forgetGone(scope, name, rec, now);
          continue;
        }
        if (rec.expiresAtMs && rec.expiresAtMs - now <= RETIRE_MARGIN_MS) {
          reaped += await retire(scope, name, rec);
          continue;
        }
        if (rec.lastActivityMs && rec.lastActivityMs <= cutoff && !(await busy(name))) {
          reaped += await retire(scope, name, rec, cutoff);
          continue;
        }
        await refresh(scope, name, rec, now);
      } catch (e) {
        report("sandbox_reap", "deep_idle_probe_failed", e, scope);
      }
    }
    return { reaped: reaped + (await sweepOrphans()) };
  }
  return { touch, rotationDue, exclusive, reapDeepIdle };
}
async function reapProviderOrphans(
  driver: SandboxDriver,
  store: SandboxBodies<StoredSandboxRecord>,
  shared: SandboxShared,
  report: MaintenanceDeps["report"],
  firstSeen: Map<string, number>,
): Promise<number> {
  if (!driver.listRunning || !driver.terminateById) return 0;
  const tracked = async (): Promise<Set<string>> =>
    new Set([
      ...Array.from(driver.knownIds?.() ?? []),
      ...(await store.entries()).flatMap(([, rec]) => (rec.sandboxId ? [rec.sandboxId] : [])),
    ]);
  let known = await tracked();
  const listed = new Set<string>();
  const candidates: string[] = [];
  const now = Date.now();
  try {
    for await (const id of driver.listRunning(sandboxOwnership(shared, "scope"))) {
      listed.add(id);
      if (known.has(id)) continue;
      const at = firstSeen.get(id) ?? now;
      firstSeen.set(id, at);
      if (now - at >= ORPHAN_GRACE_MS) candidates.push(id);
    }
  } catch (e) {
    report("sandbox_reap", "orphan_list_failed", e);
    return 0;
  }
  for (const id of firstSeen.keys()) if (!listed.has(id) || known.has(id)) firstSeen.delete(id);
  if (!candidates.length) return 0;
  known = await tracked();
  let reaped = 0;
  for (const id of candidates) {
    if (known.has(id)) continue;
    try {
      await driver.terminateById(id);
      firstSeen.delete(id);
      reaped++;
    } catch (e) {
      report("sandbox_reap", "orphan_terminate_failed", new Error(errMessage(e)));
    }
  }
  return reaped;
}

function exclusiveProviderUse<T>(
  driver: SandboxDriver,
  shared: SandboxShared,
  scope: string,
  fn: () => Promise<T>,
): Promise<T> {
  return shared.advisoryLock.withLock(`${driver.backend}-use:${scope}`, fn);
}

function renewalDue(driver: SandboxDriver, rec: StoredSandboxRecord, now: number): boolean {
  const retentionMs = driver.checkpoints?.retentionMs;
  if (!rec.checkpointId || !rec.checkpointAtMs || retentionMs == null) return false;
  const remaining = rec.checkpointAtMs + retentionMs - now;
  return remaining > 0 && remaining <= RENEW_MARGIN_MS;
}
