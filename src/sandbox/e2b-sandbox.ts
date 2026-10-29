import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { swallowAs } from "../util/errors.ts";
import {
  E2bCommandLostError,
  E2bSandboxGoneError,
  runE2bScript,
  type E2bClient,
  type E2bSession,
} from "./e2b-client.ts";
import {
  createProviderSandbox,
  type MachineState,
  type SandboxDriver,
  type SandboxShared,
  type StoredSandboxRecord,
} from "./provider-sandbox.ts";
import type { BackendSandbox } from "./sandbox.ts";
import { sandboxBodiesMigration, withRetiredColumns, type SandboxBodies } from "./sandbox-bodies.ts";
import { cols } from "../persistence/typed-table.ts";

const HOME_DIR = "/home/user";

export const E2B_TEMPLATE_TOOLS = ["wget", "unzip", "gh", "aws", "x-api"];

export interface StoredE2bSandbox extends StoredSandboxRecord {
  sandboxId?: string;
}

const E2B_TYPED = sandboxBodiesMigration("e2b_sandbox_bodies", { sandboxId: { type: "text" } });

const E2B_RETIRED_COLUMNS =
  cols(`createdAtMs bigint, nativePause boolean, preservationState text, preservationError text,
  recoverySnapshotId text, recoveryError text, operatorFilesStagedAt bigint, operatorRecoveryCompletedAt bigint`);

export const E2B_BODIES = withRetiredColumns(E2B_TYPED, E2B_RETIRED_COLUMNS);

export interface E2bSandboxOptions extends SandboxShared {
  client: E2bClient;
  store: SandboxBodies<StoredE2bSandbox>;
}

interface E2bState {
  client: E2bClient;
  sessions: Map<string, E2bSession>;
  observed: Pick<SandboxDriver, "cpus" | "memoryMb" | "diskGb">;
}

async function locate(client: E2bClient, name: string): Promise<{ sandboxId: string; state: string } | null> {
  const listed = await client.list({ name });
  return listed.find((s) => s.state === "running") ?? listed[0] ?? null;
}

async function destroy(state: E2bState, name: string): Promise<void> {
  const { client, sessions } = state;
  const ids = new Set([sessions.get(name)?.sandboxId, ...(await client.list({ name })).map((s) => s.sandboxId)]);
  for (const id of ids) if (id) await client.kill(id);
  sessions.delete(name);
}

async function inspect(state: E2bState, name: string): Promise<MachineState | null> {
  const { client, sessions, observed } = state;
  const found = await locate(client, name);
  if (!found) return null;
  const running = found.state === "running";
  const session = sessions.get(name);
  const metrics = running && session ? await session.metrics().catch(swallowAs("e2b-sandbox: metrics", null)) : null;
  if (metrics?.diskTotalBytes) observed.diskGb = Math.round(metrics.diskTotalBytes / 2 ** 30);
  return {
    state: running ? "running" : "parked",
    detail: `e2b sandbox ${found.sandboxId} ${found.state}`,
    ...(metrics
      ? {
          resources: {
            cpuUsedPct: metrics.cpuUsedPct,
            memUsedMb: Math.round(metrics.memUsedBytes / 2 ** 20),
            memTotalMb: Math.round(metrics.memTotalBytes / 2 ** 20),
            diskUsedGb: Math.round((metrics.diskUsedBytes / 2 ** 30) * 10) / 10,
            diskTotalGb: Math.round((metrics.diskTotalBytes / 2 ** 30) * 10) / 10,
          },
        }
      : {}),
  };
}

export function createE2bSandbox(workspace: WorkspaceStore, opts: E2bSandboxOptions): BackendSandbox {
  const { client, store } = opts;
  const sessions = new Map<string, E2bSession>();
  const observed: Pick<SandboxDriver, "cpus" | "memoryMb" | "diskGb"> = {};
  const state: E2bState = { client, sessions, observed };

  async function adopt(name: string, session: E2bSession): Promise<E2bSession> {
    sessions.set(name, session);
    const info = await client.info?.(session.sandboxId).catch(swallowAs("e2b-sandbox: info", undefined));
    if (info?.cpuCount) observed.cpus = info.cpuCount;
    if (info?.memoryMb) observed.memoryMb = info.memoryMb;
    return session;
  }

  async function launch(name: string, scratch: boolean, fromSnapshot?: string): Promise<E2bSession> {
    const session = await client.create({
      metadata: { name, ...(scratch ? { scratch: "true" } : {}) },
      autoPause: !scratch,
      ...(fromSnapshot ? { fromSnapshot } : {}),
    });
    return adopt(name, session);
  }

  async function connect(name: string): Promise<E2bSession> {
    const cached = sessions.get(name);
    if (cached) return cached;
    const found = await locate(client, name);
    if (!found) throw new Error(`e2b sandbox ${name} is not provisioned`);
    return adopt(name, await client.connect(found.sandboxId));
  }

  const withSession = async <T>(name: string, action: (session: E2bSession) => Promise<T>): Promise<T> =>
    action(await connect(name));

  const sandbox = createProviderSandbox(
    workspace,
    {
      get cpus() {
        return observed.cpus;
      },
      get memoryMb() {
        return observed.memoryMb;
      },
      get diskGb() {
        return observed.diskGb;
      },
      backend: "e2b",
      homeDir: HOME_DIR,
      os: "Linux — E2B Firecracker sandbox (provider pause preserves state; publish durable work to git or Files)",
      writablePersistence: "provider_managed",
      egressEnforcement: opts.egressProxyUrl ? "domain" : "none",
      replacement: "checkpoint",
      isGone: (error) => error instanceof E2bSandboxGoneError,
      isCommandLost: (error) => error instanceof E2bCommandLostError,
      exec: (name, script, timeoutSec) => withSession(name, (s) => runE2bScript(s, script, timeoutSec)),
      writeAbsBytes: (name, absPath, data) => withSession(name, (s) => s.writeFileBytes(absPath, data)),
      readAbsBytes: (name, absPath) => withSession(name, (s) => s.readFileBytes(absPath)),
      inspect: (name) => inspect(state, name),
      async create(name, { scratch, scope, checkpointId }) {
        const session = await launch(name, scratch, checkpointId);
        if (scope) await store.update(scope, { sandboxId: session.sandboxId });
        return { homeRetained: !!checkpointId };
      },
      async resume(name) {
        sessions.delete(name);
        await connect(name);
      },
      keepWarm: async (name, seconds) => (await connect(name)).keepAlive(seconds * 1000),
      async park(name) {
        const session = sessions.get(name);
        if (!session) return;
        await session.pause();
        sessions.delete(name);
      },
      destroy: (name) => destroy(state, name),
      isLive: (name) => sessions.has(name),
      forget(name) {
        sessions.delete(name);
      },
      async restart(name) {
        const session = await connect(name);
        await session.pause({ keepMemory: false });
        sessions.delete(name);
        await adopt(name, await client.connect(session.sandboxId));
      },
      checkpoints: {
        capture: async (name) => (await (await connect(name)).createSnapshot()).snapshotId,
        async restore(name, checkpointId) {
          await destroy(state, name);
          await launch(name, false, checkpointId);
        },
        drop: (_name, checkpointId) => client.deleteSnapshot(checkpointId),
      },
    },
    opts,
    opts.store,
  );
  return sandbox;
}
