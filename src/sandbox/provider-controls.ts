import { shq } from "../util/shell.ts";
import { processSessionDir } from "./exec-process-session.ts";
import type { Sandbox, ExecPressure } from "./sandbox.ts";
import { errMessage } from "../util/errors.ts";
import { sandboxPolicy } from "./provider-policy.ts";
import type { SandboxDriver, SandboxShared, StoredSandboxRecord } from "./provider-sandbox.ts";

export interface SandboxNetwork {
  allowHosts: string[];
  allowCidrs: string[];
  denyAll: boolean;
}

export interface ProviderControls {
  network?: {
    read(name: string): Promise<SandboxNetwork>;
    write?(name: string, network: SandboxNetwork): Promise<void>;
  };
  errorDetail?(error: unknown): string;
}

export function createProviderEgress(driver: SandboxDriver, shared: SandboxShared) {
  const policy = sandboxPolicy(driver.backend, shared);
  const desired: SandboxNetwork = {
    allowHosts: policy.egressHost ? [policy.egressHost] : [],
    allowCidrs: [],
    denyAll: !!policy.egressHost,
  };
  const normalized = (value: SandboxNetwork): string =>
    JSON.stringify([
      value.allowHosts.map((h) => h.toLowerCase().replace(/\.$/, "")).sort(),
      value.allowCidrs.toSorted(),
      value.denyAll,
    ]);
  const expected = normalized(desired);
  async function ensureEgress(name: string): Promise<void> {
    if (!driver.network) return driver.ensureEgress?.(name);
    const current = await driver.network.read(name);
    if (normalized(current) === expected) return;
    if (driver.network.write) {
      await driver.network.write(name, desired);
      if (normalized(await driver.network.read(name)) === expected) return;
    }
    throw new Error(
      `${driver.backend} egress policy ${name}: readback mismatch; destroy the sandbox so it is recreated with the allow list`,
    );
  }
  return { ensureEgress };
}

export async function restartWithCheckpointFallback(
  driver: SandboxDriver,
  name: string,
  stored: StoredSandboxRecord | null | undefined,
  report: (message: string) => void,
): Promise<void> {
  const detail = driver.errorDetail ?? errMessage;
  if (stored?.initializationPending && driver.checkpoints?.machineBound)
    throw new Error(
      `${driver.backend} ${name}: initialization is incomplete; refusing to capture or restore a checkpoint`,
    );
  driver.forget?.(name);
  try {
    await driver.restart!(name, { initializationPending: !!stored?.initializationPending });
    return;
  } catch (error) {
    if (!driver.checkpoints?.latest) throw error;
    const failure = detail(error);
    let fault: string | undefined;
    try {
      fault = (await driver.inspect(name))?.fault;
    } catch (e) {
      throw new Error(
        `${driver.backend} restart ${name}: ${failure}; check failed: ${detail(e)}; no checkpoint was restored`,
        { cause: e },
      );
    }
    if (!fault)
      throw new Error(
        `${driver.backend} restart ${name}: ${failure}; the health check reports no fault, so no checkpoint was restored`,
        { cause: error },
      );
    let restored: { id: string; createdAt: string } | undefined;
    try {
      restored = await driver.checkpoints.latest(name);
      if (restored) await driver.checkpoints.restore(name, restored.id);
    } catch (e) {
      throw new Error(
        `${driver.backend} restart ${name}: ${failure}; ${fault}; checkpoint restore failed: ${errMessage(e)}`,
        { cause: e },
      );
    }
    if (!restored)
      throw new Error(`${driver.backend} restart ${name}: ${failure}; ${fault}; no checkpoint to restore`, {
        cause: error,
      });
    report(
      `${driver.backend} ${name}: restart failed (${failure}); ${fault}; restored checkpoint ${restored.id} from ${restored.createdAt}`,
    );
  }
}

export function processHoldScript(
  processId: string,
  api: { refresh(processId: string): string; release(processId: string): string },
): string {
  const loop = [
    `P="${processSessionDir(processId)}"`,
    `while [ ! -f "$P/code" ] && kill -0 "$(cat "$P/pid" 2>/dev/null)" 2>/dev/null; do`,
    `  ${api.refresh(processId)} >/dev/null 2>&1 || true`,
    `  i=0; while [ $i -lt 60 ] && [ ! -f "$P/code" ]; do sleep 1; i=$((i+1)); done`,
    `done`,
    `${api.release(processId)} >/dev/null 2>&1 || true`,
  ].join("\n");
  return `LOOP=${shq(loop)}; if command -v setsid >/dev/null 2>&1; then setsid sh -c "$LOOP" >/dev/null 2>&1 & else sh -c "$LOOP" >/dev/null 2>&1 & fi; echo OK`;
}

export function createPressureObserver(report: (name: string, pressure: ExecPressure) => void) {
  const episodes = new Set<string>();
  return (name: string, pressure: ExecPressure | undefined): void => {
    if (!pressure) return;
    if (pressure.ioFull60 >= 75 && !episodes.has(name)) {
      episodes.add(name);
      report(name, pressure);
    } else if (pressure.ioFull60 < 40) episodes.delete(name);
  };
}

export function withProcessHold(
  driver: SandboxDriver,
  exec: SandboxDriver["exec"],
  start: NonNullable<Sandbox["startProcess"]>,
  report: (category: string, code: string, error: unknown, scope?: string) => void,
  scopeFor: (name: string) => string | undefined,
): NonNullable<Sandbox["startProcess"]> {
  return async (handle, command, opts) => {
    const started = await start(handle, command, opts);
    if (driver.processHold) {
      try {
        const result = await exec(handle.id, processHoldScript(started.processId, driver.processHold), 20);
        if (result.code !== 0 || !result.stdout.includes("OK"))
          throw new Error(result.stderr.trim() || `exit ${result.code}`);
      } catch (error) {
        report(
          "agent_computer",
          "process_keepalive_failed",
          `${driver.backend} ${handle.id}: process ${started.processId} runs without a Tasks hold and may freeze when the computer idles: ${errMessage(error)}`,
          scopeFor(handle.id),
        );
      }
    }
    return started;
  };
}
