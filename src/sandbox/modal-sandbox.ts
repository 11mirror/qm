import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { cols, type MapConversion } from "../persistence/typed-table.ts";
import { sleep } from "../util/async.ts";
import {
  MODAL_CHECKPOINT_RETENTION_MS,
  ModalNameConflictError,
  ModalSandboxGoneError,
  type ModalClient,
  type ModalSession,
} from "./modal-client.ts";
import {
  createProviderSandbox,
  sandboxOwnership,
  type SandboxShared,
  type StoredSandboxRecord,
} from "./provider-sandbox.ts";
import type { BackendSandbox } from "./sandbox.ts";
import { sandboxBodiesMigration, type SandboxBodies } from "./sandbox-bodies.ts";

const HOME_DIR = "/root";
const NAME_RELEASE_WAIT_MS = 30_000;
const NAME_RETRY_MS = 500;

export type StoredModalSandbox = StoredSandboxRecord;

export interface ModalSandboxOptions extends SandboxShared {
  client: ModalClient;
  store: SandboxBodies<StoredModalSandbox>;
}

const RETIRED_KEYS = [
  "hydrationPending",
  "nativeSnapshotId",
  "nativeSnapshotExpiresAtMs",
  "recoveryError",
  "snapshotGeneration",
  "lastSnapshotAttemptMs",
].map((k) => `'${k}'`);

const typed = sandboxBodiesMigration(
  "modal_sandbox_bodies",
  cols(`sandboxId text, createdAtMs bigint, expiresAtMs bigint, lastActivityMs bigint, orgId text`),
);

export const MODAL_BODIES: MapConversion = {
  ...typed,
  statements: [
    `DO $legacy$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('modal_sandbox_bodies') AND attname = 'json' AND NOT attisdropped) THEN
        UPDATE modal_sandbox_bodies SET json = (json - ${RETIRED_KEYS.join(" - ")})
          || CASE WHEN json->>'hydrationPending' = 'true' THEN '{"initializationPending": true}'::jsonb ELSE '{}'::jsonb END
          || CASE WHEN coalesce(json->>'nativeSnapshotId', '') <> '' THEN jsonb_strip_nulls(jsonb_build_object(
               'checkpointId', json->'nativeSnapshotId',
               'checkpointAtMs', coalesce(
                 (nullif(json->>'nativeSnapshotExpiresAtMs', '0'))::bigint - ${MODAL_CHECKPOINT_RETENTION_MS},
                 (json->>'lastSnapshotMs')::bigint)))
             ELSE '{}'::jsonb END
          || CASE WHEN coalesce(json->>'recoveryError', '') <> '' THEN jsonb_build_object('snapshotError', json->'recoveryError')
             ELSE '{}'::jsonb END
         WHERE json ?| array[${RETIRED_KEYS.join(", ")}];
      END IF;
    END $legacy$`,
    ...typed.statements,
  ],
};

async function claimName(client: ModalClient, opts: ModalSandboxOptions, name: string): Promise<ModalSession> {
  const deadline = Date.now() + NAME_RELEASE_WAIT_MS;
  for (;;) {
    try {
      return await client.create({ name, tags: sandboxOwnership(opts, "scope") });
    } catch (e) {
      if (!(e instanceof ModalNameConflictError)) throw e;
      const adopted = await client.fromName(name);
      if (adopted) return adopted;
      if (Date.now() >= deadline) throw e;
      await sleep(NAME_RETRY_MS);
    }
  }
}

export function createModalSandbox(workspace: WorkspaceStore, opts: ModalSandboxOptions): BackendSandbox {
  const { client, store } = opts;
  const sessions = new Map<string, ModalSession>();
  const scratchNames = new Set<string>();
  async function current(name: string): Promise<ModalSession> {
    const cached = sessions.get(name);
    if (cached) return cached;
    const found = scratchNames.has(name) ? null : await client.fromName(name);
    if (!found) throw new ModalSandboxGoneError(name, "no running sandbox holds this name");
    sessions.set(name, found);
    return found;
  }
  return createProviderSandbox(
    workspace,
    {
      backend: "modal",
      identityField: "sandboxId",
      homeDir: HOME_DIR,
      os: "Debian 12 — Modal sandbox (24h max lifetime; home checkpoints have limited retention; publish durable work to git or Files)",
      ...(opts.cpus ? { cpus: opts.cpus } : {}),
      ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
      writablePersistence: "provider_managed",
      egressEnforcement: opts.egressProxyUrl ? "domain" : "none",
      envViaExec: true,
      lifetimeMs: client.lifetimeMs,
      isGone: (e) => e instanceof ModalSandboxGoneError,
      async exec(name, script, timeoutSec, env) {
        const r = await (
          await current(name)
        ).runCommand(script, { timeoutMs: timeoutSec * 1000, ...(env ? { env } : {}) });
        return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode, timedOut: r.exitCode === 124 };
      },
      writeAbsBytes: async (name, absPath, data) => (await current(name)).writeFileBytes(absPath, data),
      readAbsBytes: async (name, absPath) => (await current(name)).readFileBytes(absPath),
      async inspect(name, identity) {
        let found = await client.fromName(name);
        if (!found && identity) {
          try {
            found = await client.fromId(identity);
          } catch (error) {
            if (!(error instanceof ModalSandboxGoneError)) throw error;
          }
        }
        if (!found) {
          sessions.delete(name);
          return null;
        }
        sessions.set(name, found);
        return { id: found.sandboxId, state: "running", detail: `modal sandbox ${found.sandboxId}` };
      },
      async create(name, { scratch }) {
        const session = scratch
          ? await client.create({ tags: sandboxOwnership(opts, "scratch") })
          : await claimName(client, opts, name);
        sessions.set(name, session);
        if (scratch) scratchNames.add(name);
        return { id: session.sandboxId };
      },
      resume: async () => {},
      async destroy(name, stored) {
        const cached = sessions.get(name);
        if (cached) await cached.terminate();
        if (!scratchNames.has(name)) {
          const ids = new Set<string>();
          const found = await client.fromName(name);
          if (found) ids.add(found.sandboxId);
          if (stored) ids.add(stored);
          if (cached) ids.delete(cached.sandboxId);
          for (const id of ids) await client.terminate(id);
        }
        sessions.delete(name);
        scratchNames.delete(name);
      },
      isLive: (name) => scratchNames.has(name) && sessions.has(name),
      forget: (name) => {
        sessions.delete(name);
      },
      ...(client.listRunning ? { listRunning: (tags: Record<string, string>) => client.listRunning!(tags) } : {}),
      terminateById: (id) => client.terminate(id),
      knownIds: () => Array.from(sessions.values(), (session) => session.sandboxId),
      checkpoints: {
        kind: "directory",
        capture: async (name) => (await current(name)).snapshotHome(),
        retentionMs: MODAL_CHECKPOINT_RETENTION_MS,
        restore: async (name, checkpointId) => (await current(name)).restoreHome(checkpointId),
      },
    },
    opts,
    store,
  );
}
