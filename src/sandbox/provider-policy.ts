import { egressProxyHost } from "./sandbox-env.ts";
import type { SandboxShared } from "./provider-sandbox.ts";

interface ProviderCapabilities {
  cpus?: number;
  memoryMb?: number;
  diskGb?: number;
  maxLifetimeSec?: number;
  idleParkSec?: number;
  retentionSec?: number;
  scratchIdleParkSec?: number;
  scratchLifetimeSec?: number;
}

export const PROVIDER_CAPABILITIES: Readonly<Record<string, ProviderCapabilities>> = {
  modal: { cpus: 1, memoryMb: 2048, maxLifetimeSec: 24 * 3600, idleParkSec: 12 * 3600, retentionSec: 30 * 24 * 3600 },
  e2b: { maxLifetimeSec: 24 * 3600 },
  sprites: { cpus: 8, diskGb: 100 },
  "local-docker": {},
  "do-managed-agents": {},
  smolmachines: { cpus: 4, memoryMb: 8192, scratchLifetimeSec: 24 * 3600 },
  superserve: {
    idleParkSec: 15 * 60,
    retentionSec: 30 * 24 * 3600,
    scratchIdleParkSec: 10 * 60,
    scratchLifetimeSec: 24 * 3600,
  },
};

export const MODAL_CHECKPOINT_RETENTION_MS = PROVIDER_CAPABILITIES.modal!.retentionSec! * 1000;

export function sandboxPolicy(backend: string, shared: Partial<SandboxShared>) {
  const capabilities = PROVIDER_CAPABILITIES[backend] ?? {};
  const idleParkSec = shared.idleParkSec ?? capabilities.idleParkSec;
  const maxLifetimeSec =
    capabilities.maxLifetimeSec === undefined
      ? shared.maxLifetimeSec
      : Math.min(shared.maxLifetimeSec ?? capabilities.maxLifetimeSec, capabilities.maxLifetimeSec);
  return {
    cpus: shared.cpus ?? capabilities.cpus,
    memoryMb: shared.memoryMb ?? capabilities.memoryMb,
    diskGb: shared.diskGb ?? capabilities.diskGb,
    idleParkSec,
    maxLifetimeSec,
    keepWarmSec: Math.max(shared.keepWarmSec ?? 3600, idleParkSec ?? 0),
    retentionSec: capabilities.retentionSec,
    scratchIdleParkSec: capabilities.scratchIdleParkSec,
    scratchLifetimeSec: capabilities.scratchLifetimeSec,
    egressHost: shared.egressProxyUrl ? egressProxyHost(shared.egressProxyUrl) : undefined,
  };
}

export function modalLease(opts: { sandboxTimeoutMs?: number; idleTimeoutMs?: number; maxCommandMs?: number }) {
  const capabilities = PROVIDER_CAPABILITIES.modal!;
  const seconds = (ms: number): number => Math.max(1000, Math.ceil(ms / 1000) * 1000);
  const sandboxTimeoutMs = seconds(
    Math.min(opts.sandboxTimeoutMs ?? capabilities.maxLifetimeSec! * 1000, capabilities.maxLifetimeSec! * 1000),
  );
  return {
    sandboxTimeoutMs,
    idleTimeoutMs: seconds(Math.min(opts.idleTimeoutMs ?? capabilities.idleParkSec! * 1000, sandboxTimeoutMs)),
    maxCommandMs: opts.maxCommandMs ?? 3600_000,
  };
}

export const E2B_EXEC_MARGIN_MS = 60_000;
export const DEFAULT_MAX_COMMAND_MS = 3600_000;
export function e2bLease(opts: { sandboxTtlMs?: number; maxLifetimeMs?: number }) {
  const maxLifetimeMs = opts.maxLifetimeMs ?? PROVIDER_CAPABILITIES.e2b!.maxLifetimeSec! * 1000;
  if (!Number.isFinite(maxLifetimeMs) || maxLifetimeMs <= E2B_EXEC_MARGIN_MS)
    throw new Error(`e2b maxLifetimeMs must be a finite number of milliseconds above ${E2B_EXEC_MARGIN_MS}`);
  const maxCommandMs = Math.min(DEFAULT_MAX_COMMAND_MS, maxLifetimeMs - E2B_EXEC_MARGIN_MS);
  const requested = opts.sandboxTtlMs ?? Math.max(15 * 60_000, maxCommandMs + E2B_EXEC_MARGIN_MS);
  return { sandboxTtlMs: Math.min(maxLifetimeMs, requested), maxLifetimeMs, maxCommandMs };
}

export function createLeaseCoverage(
  ttlMs: number,
  maxLifetimeMs: number,
  maxCommandMs: number,
  commandMarginMs: number,
  setTimeout: (ms: number) => Promise<void>,
) {
  let expiresAtMs = Date.now() + ttlMs;
  async function extend(ms: number): Promise<void> {
    const bounded = Math.min(maxLifetimeMs, Math.max(ms, expiresAtMs - Date.now()));
    const at = Date.now() + bounded;
    await setTimeout(bounded);
    expiresAtMs = at;
  }
  async function cover(commandMs: number): Promise<void> {
    const needed = Math.min(commandMs, maxCommandMs) + commandMarginMs;
    if (Date.now() + needed > expiresAtMs) await extend(Math.max(ttlMs, needed));
  }
  return { extend, cover };
}
