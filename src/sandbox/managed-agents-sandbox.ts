import { randomUUID } from "node:crypto";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { swallowAs } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { hasParentPathSegment } from "./sandbox.ts";
import {
  createProviderSandbox,
  type SandboxDriver,
  type SandboxShared,
  type StoredSandboxRecord,
} from "./provider-sandbox.ts";
import { sandboxBodiesMigration, withRetiredColumns, type SandboxBodies } from "./sandbox-bodies.ts";
import { cols } from "../persistence/typed-table.ts";
import {
  ManagedAgentsCommandLostError,
  ManagedAgentsSandboxGoneError,
  type ManagedAgentsClient,
  type ManagedAgentsSession,
} from "./managed-agents-client.ts";
import type { BackendSandbox, ExecResult } from "./sandbox.ts";

const WORKSPACE_ROOT = "/workspace";
const HOME_DIR = `${WORKSPACE_ROOT}/home`;
const TRANSFER_RELAY_BASENAME = ".qm-transfer.";
const CHECKPOINT_LABEL = "qm teardown";

export const QM_TEMPLATE_TOOLS = ["jq", "rg", "unzip", "wget"];

function transfersDirectly(absPath: string): boolean {
  return (absPath === WORKSPACE_ROOT || absPath.startsWith(`${WORKSPACE_ROOT}/`)) && !hasParentPathSegment(absPath);
}

interface SessionFound {
  sessionId: string;
  paused: boolean;
  detail: string;
}

export type StoredManagedAgentsSandbox = StoredSandboxRecord & { sessionId?: string };

export const MANAGED_AGENTS_BODIES = withRetiredColumns(
  sandboxBodiesMigration("do_managed_agents_sandbox_bodies", { sessionId: { type: "text" } }),
  cols(`sandboxId text, createdAtMs bigint, preservationState text, preservationError text, checkpointError text,
    pendingCheckpointDeletes jsonb`),
);

export interface ManagedAgentsSandboxOptions extends SandboxShared {
  client: ManagedAgentsClient;
  store: SandboxBodies<StoredManagedAgentsSandbox>;
}

type ManagedAgentsSessions = ReturnType<typeof managedAgentsSessions>;

function managedAgentsSessions(client: ManagedAgentsClient) {
  const sessions = new Map<string, ManagedAgentsSession>();

  const idByName = new Map<string, string>();

  async function probe(sessionId: string): Promise<SessionFound | null> {
    try {
      const info = await client.info(sessionId);
      if (info.state === "destroyed" || info.state === "destroying" || info.state === "failed") return null;
      const detail = `do-managed-agents sandbox ${info.sandboxId || sessionId} ${info.state}`;
      return { sessionId, paused: info.state === "paused", detail };
    } catch (e) {
      if (e instanceof ManagedAgentsSandboxGoneError) return null;
      throw e;
    }
  }

  async function findSession(name: string, identity?: string): Promise<SessionFound | null> {
    const storedId = identity ?? idByName.get(name);
    const stored = storedId ? await probe(storedId) : null;
    if (stored) return stored;
    for (const summary of await client.list(name)) {
      const found = await probe(summary.sessionId);
      if (!found) continue;
      idByName.set(name, found.sessionId);
      return found;
    }
    return null;
  }

  async function connect(name: string): Promise<ManagedAgentsSession> {
    const cached = sessions.get(name);
    if (cached) return cached;
    const found = await findSession(name);
    if (!found) throw new ManagedAgentsSandboxGoneError(name, "no session is registered under this name");
    const session = await client.connect(found.sessionId);
    sessions.set(name, session);
    return session;
  }

  function forget(name: string): void {
    const session = sessions.get(name);
    sessions.delete(name);
    session?.close().catch(swallowAs("managed-agents-sandbox: close session", undefined));
  }

  const withSession = async <T>(name: string, action: (session: ManagedAgentsSession) => Promise<T>): Promise<T> =>
    action(await connect(name));

  async function exec(name: string, script: string, timeoutSec: number): Promise<ExecResult> {
    return withSession(name, async (session) => {
      const r = await session.runCommand(`sh -c ${shq(`timeout -k 5 ${timeoutSec} sh -c ${shq(script)}; exit $?`)}`, {
        timeoutMs: timeoutSec * 1000 + 30_000,
      });
      return {
        stdout: r.stdout,
        stderr: r.stderr,
        code: r.exitCode,
        timedOut: r.exitCode === 124 || r.exitCode === 137,
      };
    });
  }

  return { client, sessions, idByName, findSession, connect, forget, withSession, exec };
}

const relayFailure = (what: string, r: ExecResult): Error =>
  new Error(`do-managed-agents ${what} failed: ${r.stderr.trim() || `exit ${r.code}`}`);

async function writeAbsBytes(
  ctx: ManagedAgentsSessions,
  name: string,
  absPath: string,
  data: Uint8Array,
): Promise<void> {
  if (transfersDirectly(absPath)) return ctx.withSession(name, (session) => session.writeFileBytes(absPath, data));
  const relay = `${WORKSPACE_ROOT}/${TRANSFER_RELAY_BASENAME}${randomUUID()}`;
  await ctx.withSession(name, (session) => session.writeFileBytes(relay, data));
  const moved = await ctx.exec(
    name,
    `find ${WORKSPACE_ROOT} -maxdepth 1 -name ${shq(`${TRANSFER_RELAY_BASENAME}*`)} -mmin +120 -delete 2>/dev/null; mkdir -p "$(dirname ${shq(absPath)})" && mv -f ${shq(relay)} ${shq(absPath)} || { rm -f ${shq(relay)}; exit 1; }`,
    60,
  );
  if (moved.code !== 0) throw relayFailure(`write ${absPath}`, moved);
}

async function readAbsBytes(ctx: ManagedAgentsSessions, name: string, absPath: string): Promise<Uint8Array | null> {
  if (transfersDirectly(absPath)) return ctx.withSession(name, (session) => session.readFileBytes(absPath));
  const relay = `${WORKSPACE_ROOT}/${TRANSFER_RELAY_BASENAME}${randomUUID()}`;
  const copied = await ctx.exec(name, `test -f ${shq(absPath)} || exit 3; cp ${shq(absPath)} ${shq(relay)}`, 60);
  if (copied.code === 3) return null;
  if (copied.code !== 0) throw relayFailure(`read ${absPath}`, copied);
  try {
    return await ctx.withSession(name, (session) => session.readFileBytes(relay));
  } finally {
    await ctx
      .exec(name, `rm -f ${shq(relay)}`, 60)
      .catch(swallowAs("managed-agents-sandbox: transfer relay cleanup", undefined));
  }
}

async function destroy(ctx: ManagedAgentsSessions, name: string, storedId?: string): Promise<void> {
  const { client, sessions } = ctx;
  const cached = sessions.get(name);
  sessions.delete(name);
  const ids = new Set([cached?.sessionId, storedId].filter((id): id is string => !!id));
  if (!ids.size) for (const summary of await client.list(name)) ids.add(summary.sessionId);
  for (const id of ids) {
    try {
      if (cached && id === cached.sessionId) await cached.kill();
      else await client.kill(id);
    } catch (e) {
      if (!(e instanceof ManagedAgentsSandboxGoneError)) throw e;
    }
  }
}

async function rollback(ctx: ManagedAgentsSessions, name: string, checkpointId: string): Promise<{ detail: string }> {
  const found = await ctx.findSession(name);
  if (!found) throw new Error("do-managed-agents restart: no sandbox provisioned yet");
  ctx.forget(name);
  const restored = await ctx.client.rollback(found.sessionId, checkpointId);
  return {
    detail: `session ${found.sessionId}: restored checkpoint ${checkpointId} onto sandbox ${restored.sandboxId}`,
  };
}

function managedAgentsDriver(ctx: ManagedAgentsSessions, opts: ManagedAgentsSandboxOptions): SandboxDriver {
  const { client, sessions, idByName, findSession, connect, exec, forget } = ctx;
  return {
    backend: "do-managed-agents",
    identityField: "sessionId",
    homeDir: HOME_DIR,
    os: "Linux — DigitalOcean Managed Agents Firecracker microVM (provider pause preserves state; publish durable work to git or Files)",
    tools: ["git", "curl", "tar", "python3"],
    writablePersistence: "provider_managed",
    egressEnforcement: opts.egressProxyUrl ? "domain" : "none",
    isGone: (error) => error instanceof ManagedAgentsSandboxGoneError,
    isCommandLost: (error) => error instanceof ManagedAgentsCommandLostError,
    exec,
    writeAbsBytes: (name, absPath, data) => writeAbsBytes(ctx, name, absPath, data),
    readAbsBytes: (name, absPath) => readAbsBytes(ctx, name, absPath),
    async inspect(name, identity) {
      const found = await findSession(name, identity);
      if (found) idByName.set(name, found.sessionId);
      return found ? { id: found.sessionId, state: found.paused ? "parked" : "running", detail: found.detail } : null;
    },
    async create(name) {
      const session = await client.create({ name });
      sessions.set(name, session);
      idByName.set(name, session.sessionId);
      return { id: session.sessionId };
    },
    async resume(name) {
      await connect(name);
    },
    async park(name) {
      const session = sessions.get(name);
      if (!session) return;
      await session.pause();
      sessions.delete(name);
    },
    destroy: (name, identity) => destroy(ctx, name, identity),
    isLive: (name) => sessions.has(name),
    forget,
    checkpoints: {
      machineBound: true,
      capture: async (name) => (await (await connect(name)).createCheckpoint(CHECKPOINT_LABEL)).checkpointId,
      kind: "session",
      restore: (name, checkpointId) => rollback(ctx, name, checkpointId),
      async drop(name, checkpointId) {
        const found = await findSession(name);
        if (found) await client.deleteCheckpoint(found.sessionId, checkpointId);
      },
    },
  };
}

export function createManagedAgentsSandbox(
  workspace: WorkspaceStore,
  opts: ManagedAgentsSandboxOptions,
): BackendSandbox {
  const ctx = managedAgentsSessions(opts.client);
  return createProviderSandbox(workspace, managedAgentsDriver(ctx, opts), opts, opts.store);
}
