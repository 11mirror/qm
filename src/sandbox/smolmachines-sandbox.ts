import { SandboxNotRunningError } from "./provider-controls.ts";
import { sandboxPolicy } from "./provider-policy.ts";
import { randomUUID } from "node:crypto";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { fetchWithRetry, sleep } from "../util/async.ts";
import { httpFailure } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { createProviderSandbox, type SandboxShared, type StoredSandboxRecord } from "./provider-sandbox.ts";
import { sandboxBodiesMigration, type SandboxBodies } from "./sandbox-bodies.ts";
import type { BackendSandbox, ExecResult } from "./sandbox.ts";

const HOME_DIR = "/root";
const FILE_TRANSFER_TIMEOUT_MS = 300_000;
const EXEC_SYNC_MAX_SEC = 240;
const EXEC_POLL_MS = 2_000;
const EXIT_GRACE_MS = 60_000;
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 1_000;
const BASE_URL = "https://api.smolmachines.com";
const IMAGE = "codex";
const RUNNING_STATES = new Set(["running", "started", "ready"]);

type MachineNetwork =
  { mode: "open" } | { mode: "blocked" } | { mode: "allowCidrs"; cidrs?: string[]; hosts?: string[] };

interface MachineInfo {
  id: string;
  name?: string | null;
  state: string;
  ready?: boolean;
  error?: string | null;
  network?: MachineNetwork;
}

interface MachineExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutB64?: string;
  stderrB64?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export type StoredSmolmachinesSandbox = StoredSandboxRecord;

export const SMOLMACHINES_BODIES = sandboxBodiesMigration("smolmachines_sandbox_bodies");

export interface SmolmachinesSandboxOptions extends SandboxShared {
  token?: string;
  baseUrl?: string;
  store: SandboxBodies<StoredSmolmachinesSandbox>;
  fetchImpl?: typeof fetch;
}

const isRunning = (info: MachineInfo): boolean => RUNNING_STATES.has(info.state.toLowerCase());
const machinePath = (id: string): string => `/v1/machines/${encodeURIComponent(id)}`;

function decodeStream(name: string, label: string, b64: string | undefined, text: string, truncated?: boolean): string {
  if (b64 !== undefined) return Buffer.from(b64, "base64").toString("utf8");
  if (truncated) throw new Error(`smolmachines exec ${name}: ${label} truncated and no byte-exact stream returned`);
  return text;
}

interface SmolmachinesClientDeps {
  opts: SmolmachinesSandboxOptions;
  baseUrl: string;
  resources: { cpus?: number; memoryMb?: number; diskGb?: number };
  network: MachineNetwork;
  idByName: Map<string, string>;
}

function createSmolmachinesClient({ opts, baseUrl, resources, network, idByName }: SmolmachinesClientDeps) {
  const policy = sandboxPolicy("smolmachines", opts);
  const fetchImpl = opts.fetchImpl ?? fetch;

  function api(method: string, path: string, req: { body?: unknown; timeoutMs?: number } = {}): Promise<Response> {
    const raw = req.body instanceof Uint8Array;
    const send = (signal?: AbortSignal): Promise<Response> =>
      fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${opts.token ?? ""}`,
          ...(req.body !== undefined ? { "content-type": raw ? "application/octet-stream" : "application/json" } : {}),
        },
        ...(req.body !== undefined
          ? { body: raw ? (req.body as Uint8Array<ArrayBuffer>) : JSON.stringify(req.body) }
          : {}),
        signal: signal ?? AbortSignal.timeout(req.timeoutMs ?? 60_000),
      });
    return method === "POST" ? send() : fetchWithRetry(send, "idempotent", { timeoutMs: req.timeoutMs ?? 60_000 });
  }

  async function apiJson<T>(method: string, path: string): Promise<T> {
    const res = await api(method, path);
    if (!res.ok) throw new Error(`smolmachines ${method} ${path}: ${await httpFailure(res)}`);
    return (await res.json()) as T;
  }

  async function findMachine(name: string): Promise<MachineInfo | null> {
    const machines = await apiJson<MachineInfo[]>("GET", "/v1/machines");
    return machines.find((m) => m.name === name) ?? null;
  }

  async function awaitReady(id: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const info = await apiJson<MachineInfo>("GET", machinePath(id));
      if (info.state.toLowerCase() === "error") {
        throw new Error(`smolmachines machine ${id}: entered error state${info.error ? `: ${info.error}` : ""}`);
      }
      if (info.ready === true || (info.ready === undefined && isRunning(info))) return;
      if (Date.now() > deadline) {
        throw new Error(`smolmachines machine ${id}: not ready after ${READY_TIMEOUT_MS}ms (state=${info.state})`);
      }
      await sleep(READY_POLL_MS);
    }
  }

  async function createMachine(name: string, ephemeral: boolean): Promise<{ info: MachineInfo; created: boolean }> {
    const res = await api("POST", "/v1/machines", {
      body: {
        name,
        source: { type: "image", reference: IMAGE },
        ...(Object.keys(resources).length ? { resources } : {}),
        network,
        workdir: HOME_DIR,
        ephemeral,
        ...(ephemeral ? { ttlSeconds: policy.scratchLifetimeSec } : {}),
        ...(opts.idleParkSec ? { autoStopSeconds: opts.idleParkSec } : {}),
      },
    });
    if (res.status === 409) {
      const existing = await findMachine(name);
      if (!existing) throw new Error(`smolmachines create ${name}: http 409 but the machine is not listed`);
      await startMachine(existing.id);
      return { info: existing, created: false };
    }
    if (!res.ok) {
      throw new Error(`smolmachines create ${name}: ${await httpFailure(res)}`);
    }
    const info = (await res.json()) as MachineInfo;
    await startMachine(info.id);
    return { info, created: true };
  }

  async function startMachine(id: string): Promise<void> {
    const res = await api("POST", `${machinePath(id)}/start`);
    if (!res.ok && res.status !== 409) {
      throw new Error(`smolmachines start ${id}: ${await httpFailure(res)}`);
    }
    await awaitReady(id);
  }

  async function machineIdFor(name: string): Promise<string> {
    const cached = idByName.get(name);
    if (cached) return cached;
    const found = await findMachine(name);
    if (!found) throw new Error(`smolmachines machine ${name}: not found`);
    idByName.set(name, found.id);
    return found.id;
  }

  async function deleteMachine(name: string): Promise<void> {
    const found = (await findMachine(name))?.id;
    if (!found) {
      idByName.delete(name);
      return;
    }
    const res = await api("DELETE", machinePath(found));
    if (!res.ok && res.status !== 404) {
      throw new Error(`smolmachines delete ${name}: ${await httpFailure(res)}`);
    }
    idByName.delete(name);
  }

  return { api, apiJson, findMachine, createMachine, startMachine, machineIdFor, deleteMachine };
}

type SmolmachinesClient = ReturnType<typeof createSmolmachinesClient>;

function createSmolmachinesIo({ api, apiJson, machineIdFor }: SmolmachinesClient, idByName: Map<string, string>) {
  async function postExec(name: string, script: string, timeoutSec: number): Promise<ExecResult> {
    const id = await machineIdFor(name);
    const req = {
      body: { command: ["sh", "-c", script], timeoutSeconds: timeoutSec + Math.ceil(EXIT_GRACE_MS / 1000) },
      timeoutMs: timeoutSec * 1000 + 2 * EXIT_GRACE_MS,
    };
    const execPath = (machineId: string): string => `${machinePath(machineId)}/exec?output=b64`;
    const res = await api("POST", execPath(id), req);
    if (!res.ok) {
      const detail = await httpFailure(res);
      if (res.status === 404) {
        idByName.delete(name);
        throw new SandboxNotRunningError("gone", `smolmachines exec ${name}: ${detail}`);
      }
      if (res.status === 409 || !isRunning(await apiJson<MachineInfo>("GET", machinePath(id))))
        throw new SandboxNotRunningError("parked", `smolmachines exec ${name}: ${detail}`);
      throw new Error(`smolmachines exec ${name}: ${detail}`);
    }
    const r = (await res.json()) as MachineExecResponse;
    return {
      stdout: decodeStream(name, "stdout", r.stdoutB64, r.stdout, r.stdoutTruncated),
      stderr: decodeStream(name, "stderr", r.stderrB64, r.stderr, r.stderrTruncated),
      code: r.exitCode,
      timedOut: r.exitCode === 124,
    };
  }

  const filesUrl = (id: string, absPath: string): string =>
    `${machinePath(id)}/files${absPath.split("/").map(encodeURIComponent).join("/")}`;

  async function execRaw(name: string, script: string, timeoutSec: number): Promise<ExecResult> {
    const guarded = `timeout ${timeoutSec} sh -c ${shq(script)}`;
    if (timeoutSec <= EXEC_SYNC_MAX_SEC) return postExec(name, guarded, timeoutSec);
    const uid = randomUUID();
    const out = `${HOME_DIR}/.qm-exec-${uid}.out`;
    const err = `${HOME_DIR}/.qm-exec-${uid}.err`;
    const rcf = `${HOME_DIR}/.qm-exec-${uid}.rc`;
    const body = `${guarded} > ${out} 2> ${err}; echo $? > ${rcf}`;
    const start = await postExec(name, `nohup sh -c ${shq(body)} >/dev/null 2>&1 & echo launched`, 30);
    if (start.code !== 0 || !start.stdout.includes("launched")) {
      throw new Error(`smolmachines exec ${name}: background launch failed (rc=${start.code})`);
    }
    const deadline = Date.now() + timeoutSec * 1000 + EXIT_GRACE_MS;
    for (;;) {
      const p = await postExec(name, `[ -f ${rcf} ] && echo settled || echo running`, 30);
      if (p.stdout.includes("settled")) break;
      if (Date.now() > deadline) {
        throw new Error(`smolmachines exec ${name}: no exit after ${timeoutSec}s (+grace); leaving ${rcf}`);
      }
      await sleep(EXEC_POLL_MS);
    }
    return postExec(name, `__rc=$(cat ${rcf}); cat ${out}; cat ${err} >&2; rm -f ${out} ${err} ${rcf}; exit $__rc`, 60);
  }

  async function writeAbsBytes(name: string, absPath: string, data: Uint8Array): Promise<void> {
    const id = await machineIdFor(name);
    const res = await api("PUT", filesUrl(id, absPath), {
      body: data,
      timeoutMs: FILE_TRANSFER_TIMEOUT_MS,
    });
    if (!res.ok) {
      throw new Error(`smolmachines write ${absPath}: ${await httpFailure(res)}`);
    }
  }

  async function readAbsBytes(name: string, absPath: string): Promise<Uint8Array | null> {
    const id = await machineIdFor(name);
    const res = await api("GET", filesUrl(id, absPath), { timeoutMs: FILE_TRANSFER_TIMEOUT_MS });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`smolmachines read ${absPath}: ${await httpFailure(res)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  return { execRaw, writeAbsBytes, readAbsBytes };
}

export function createSmolmachinesSandbox(workspace: WorkspaceStore, opts: SmolmachinesSandboxOptions): BackendSandbox {
  if (!opts.token && !opts.fetchImpl) throw new Error("SANDBOX_BACKEND=smolmachines requires SMOLMACHINES_TOKEN");
  const baseUrl = (opts.baseUrl ?? BASE_URL).replace(/\/+$/, "");
  const resources = {
    ...(opts.cpus ? { cpus: opts.cpus } : {}),
    ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
    ...(opts.diskGb ? { diskGb: opts.diskGb } : {}),
  };
  const policy = sandboxPolicy("smolmachines", opts);
  const proxyHost = policy.egressHost;
  const network: MachineNetwork = proxyHost ? { mode: "allowCidrs", hosts: [proxyHost] } : { mode: "open" };

  const idByName = new Map<string, string>();
  const client = createSmolmachinesClient({ opts, baseUrl, resources, network, idByName });
  const { apiJson, findMachine, createMachine, startMachine, machineIdFor, deleteMachine } = client;
  const { execRaw, writeAbsBytes, readAbsBytes } = createSmolmachinesIo(client, idByName);

  const idleNote = opts.idleParkSec ? `; stops after ${opts.idleParkSec}s idle and restarts on the next command` : "";
  return createProviderSandbox(
    workspace,
    {
      backend: "smolmachines",
      homeDir: HOME_DIR,
      os: `smolmachines microVM booted from the ${IMAGE} image (the whole disk persists across stops${idleNote})`,
      cpus: policy.cpus,
      memoryMb: policy.memoryMb,
      ...(opts.diskGb ? { diskGb: opts.diskGb } : {}),
      egressEnforcement: proxyHost ? "domain" : "none",
      exec: execRaw,
      writeAbsBytes,
      readAbsBytes,
      async inspect(name) {
        const info = await findMachine(name);
        if (!info) return null;
        idByName.set(name, info.id);
        return {
          state: isRunning(info) ? "running" : "parked",
          detail: `machine ${info.id} ${info.state}${info.error ? `: ${info.error}` : ""}`,
        };
      },
      async create(name, { scratch }) {
        const { info, created } = await createMachine(name, scratch);
        idByName.set(name, info.id);
        return { homeRetained: !created };
      },
      resume: async (name) => startMachine(await machineIdFor(name)),
      destroy: deleteMachine,
      isLive: (name) => idByName.has(name),
      forget: (name) => idByName.delete(name),
      network: {
        async read(name) {
          const info = await apiJson<MachineInfo>("GET", machinePath(await machineIdFor(name)));
          return {
            allowHosts: info.network?.mode === "allowCidrs" ? (info.network.hosts ?? []) : [],
            allowCidrs: info.network?.mode === "allowCidrs" ? (info.network.cidrs ?? []) : [],
            denyAll: info.network?.mode === "allowCidrs" || info.network?.mode === "blocked",
          };
        },
      },
    },
    opts,
    opts.store,
  );
}
