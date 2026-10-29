import { sandboxPolicy } from "./provider-policy.ts";
import { cols } from "../persistence/typed-table.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { shq } from "../util/shell.ts";
import { createProviderSandbox, type SandboxShared, type StoredSandboxRecord } from "./provider-sandbox.ts";
import {
  SuperserveSandboxGoneError,
  type SuperserveClient,
  type SuperserveNetwork,
  type SuperserveSandboxInfo,
  type SuperserveSession,
} from "./superserve-client.ts";
import { sandboxBodiesMigration, type SandboxBodies } from "./sandbox-bodies.ts";
import type { BackendSandbox, ExecResult } from "./sandbox.ts";

const HOME_DIR = "/root";
const TIMEOUT_EXIT_CODE = 124;
const TIMEOUT_KILLED_EXIT_CODE = 137;
const KILL_AFTER_SEC = 10;
const OUTPUT_CAP_BYTES = 2 * 1024 * 1024;
const TRUNCATED_NOTICE = "[superserve: output truncated at 2 MiB; redirect large output to a file]";
const TEMPLATE_TOOLS = ["git", "curl", "jq", "tar", "python3", "node", "npm", "gh", "aws", "claude", "codex", "x-api"];
const PAUSED_STATES = new Set(["paused", "pausing"]);

export const SUPERSERVE_METADATA = {
  scope: "qm_scope",
  template: "qm_template",
} as const;

export interface StoredSuperserveSandbox extends StoredSandboxRecord {
  sandboxId?: string;
}

export const SUPERSERVE_BODIES = sandboxBodiesMigration("superserve_sandbox_bodies", cols("sandboxId text"));

export interface SuperserveSandboxOptions extends SandboxShared {
  client: SuperserveClient;
  template: string;
  store: SandboxBodies<StoredSuperserveSandbox>;
}

function spooledScript(script: string, timeoutSec: number): string {
  const capture = (file: string): string => `{ head -c ${OUTPUT_CAP_BYTES} >"${file}"; wc -c >"${file}.rest"; }`;
  return [
    `o=$(mktemp) && e=$(mktemp) && r=$(mktemp) || exit 1`,
    `{ { timeout -k ${KILL_AFTER_SEC} ${timeoutSec} sh -c ${shq(script)}; echo $? >"$r"; } 2>&1 1>&3 3>&- | ${capture("$e")}; } 3>&1 | ${capture("$o")}`,
    `cat "$o"`,
    `cat "$e" >&2`,
    `if [ "$(cat "$o.rest")" -gt 0 ] || [ "$(cat "$e.rest")" -gt 0 ]; then echo ${shq(TRUNCATED_NOTICE)} >&2; fi`,
    `rc=$(cat "$r")`,
    `rm -f "$o" "$e" "$r" "$o.rest" "$e.rest"`,
    `exit "\${rc:-1}"`,
  ].join("; ");
}

export function createSuperserveSandbox(workspace: WorkspaceStore, opts: SuperserveSandboxOptions): BackendSandbox {
  const { client, template } = opts;
  const policy = sandboxPolicy("superserve", opts);
  const egressProxyHost = policy.egressHost;
  const network: SuperserveNetwork | undefined = egressProxyHost
    ? { allowOut: [egressProxyHost], denyOut: ["0.0.0.0/0"] }
    : undefined;

  const idByName = new Map<string, string>();
  const live = new Map<string, SuperserveSession>();

  const stamp = async (name: string): Promise<Record<string, string>> => ({
    [SUPERSERVE_METADATA.scope]: name,
    [SUPERSERVE_METADATA.template]: template,
  });

  const listed = (name: string): Promise<SuperserveSandboxInfo[]> => client.list({ [SUPERSERVE_METADATA.scope]: name });

  const { session, forget, withSession, exec } = superserveSessions(client, listed, idByName, live);

  async function create(name: string, { scratch }: { scratch: boolean }): Promise<void> {
    const created = await client.create({
      name,
      metadata: await stamp(name),
      template,
      timeoutSeconds: (scratch ? policy.scratchIdleParkSec : policy.idleParkSec)!,
      autoDeleteSeconds: (scratch ? policy.scratchLifetimeSec : policy.retentionSec)!,
      ...(network ? { network } : {}),
    });
    idByName.set(name, created.id);
    live.set(name, created);
  }

  async function destroy(name: string): Promise<void> {
    const ids = new Set((await listed(name)).map((s) => s.id));
    const cached = idByName.get(name);
    if (cached) ids.add(cached);
    for (const id of ids) await client.kill(id);
    forget(name);
  }

  async function park(name: string): Promise<void> {
    const cached = live.get(name);
    if (!cached) return;
    const info = (await listed(name)).find((s) => s.id === cached.id);
    if (!info) return forget(name);
    await withSession(name, (s) => s.pause());
  }

  const sandbox = createProviderSandbox(
    workspace,
    {
      backend: "superserve",
      homeDir: HOME_DIR,
      os: "Ubuntu — Superserve sandbox (disk persists across pause/resume; publish durable work to git or Files)",
      tools: TEMPLATE_TOOLS,
      egressEnforcement: egressProxyHost ? "domain" : "none",
      exec,
      writeAbsBytes: (name, absPath, data) => withSession(name, (s) => s.writeFileBytes(absPath, data)),
      readAbsBytes: (name, absPath) => withSession(name, (s) => s.readFileBytes(absPath)),
      async inspect(name) {
        for (const candidate of await listed(name)) {
          const info = candidate;
          if (info.metadata[SUPERSERVE_METADATA.template] !== template)
            throw new Error(`superserve sandbox ${info.id} uses another template; reconcile it before provisioning`);
          await client.update(info.id, {
            metadata: { ...info.metadata, ...(await stamp(name)) },
            autoDeleteSeconds: policy.retentionSec,
          });
          idByName.set(name, info.id);
          return {
            state: PAUSED_STATES.has(info.status) ? "parked" : "running",
            detail: `superserve sandbox ${info.id} ${info.status}${info.autoDeleteAtMs ? ` (deleted at ${new Date(info.autoDeleteAtMs).toISOString()} unless resumed)` : ""}`,
          };
        }
        forget(name);
        return null;
      },
      create,
      async resume(name) {
        live.delete(name);
        await session(name);
      },
      park,
      keepWarm: (name, seconds) => withSession(name, (s) => client.update(s.id, { timeoutSeconds: seconds })),
      destroy,
      isLive: (name) => live.has(name),
      forget,
      async restart(name) {
        await withSession(name, (s) => s.pause());
        live.delete(name);
        await session(name);
      },
      network: {
        async read(name) {
          const info = (await listed(name)).find((s) => s.id === idByName.get(name));
          return {
            allowHosts: info?.network?.allowOut ?? [],
            allowCidrs: [],
            denyAll: info?.network?.denyOut?.includes("0.0.0.0/0") ?? false,
          };
        },
        async write(name, desired) {
          const id = idByName.get(name) ?? (await listed(name))[0]?.id;
          if (!id) throw new SuperserveSandboxGoneError(name, "no sandbox is registered under this name");
          await client.update(id, {
            network: { allowOut: desired.allowHosts, denyOut: desired.denyAll ? ["0.0.0.0/0"] : [] },
          });
        },
      },
    },
    opts,
    opts.store,
  );
  return sandbox;
}

function superserveSessions(
  client: SuperserveClient,
  listed: (name: string) => Promise<SuperserveSandboxInfo[]>,
  idByName: Map<string, string>,
  live: Map<string, SuperserveSession>,
) {
  async function session(name: string): Promise<SuperserveSession> {
    const cached = live.get(name);
    if (cached) return cached;
    const id = idByName.get(name) ?? (await listed(name))[0]?.id;
    if (!id) throw new Error(`superserve sandbox for ${name} is gone; the next provision creates a replacement`);
    const connected = await client.connect(id);
    idByName.set(name, id);
    live.set(name, connected);
    return connected;
  }

  function forget(name: string): void {
    live.delete(name);
    idByName.delete(name);
  }

  async function withSession<T>(name: string, action: (s: SuperserveSession) => Promise<T>): Promise<T> {
    try {
      return await action(await session(name));
    } catch (err) {
      if (!(err instanceof SuperserveSandboxGoneError)) throw err;
      forget(name);
      throw new Error(`superserve sandbox for ${name} is gone; the next provision creates a replacement`, {
        cause: err,
      });
    }
  }

  const exec = (name: string, script: string, timeoutSec: number): Promise<ExecResult> =>
    withSession(name, async (s) => {
      const t0 = Date.now();
      const r = await s.run(spooledScript(`export HOME=${shq(HOME_DIR)}; ${script}`, timeoutSec), {
        timeoutMs: timeoutSec * 1000 + 30_000,
        maxOutputBytes: OUTPUT_CAP_BYTES,
      });
      return {
        stdout: r.stdout,
        stderr: r.truncated ? `${r.stderr}\n${TRUNCATED_NOTICE}` : r.stderr,
        code: r.exitCode,
        timedOut:
          r.exitCode === TIMEOUT_EXIT_CODE ||
          (r.exitCode === TIMEOUT_KILLED_EXIT_CODE && Date.now() - t0 >= timeoutSec * 1000),
      };
    });

  return { session, forget, withSession, exec };
}
