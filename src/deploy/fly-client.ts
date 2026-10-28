import { shq } from "../util/shell.ts";
import type { Exec } from "./shared-deploy-provider.ts";
const MACHINES_API_BASE_URL = "https://api.machines.dev/v1";
const API_TIMEOUT_MS = 30_000;
const GUEST = { cpu_kind: "shared", cpus: 1, memory_mb: 512 };

interface FlyApp {
  name: string;
  network: string;
  organization?: { slug?: string };
}

interface FlyIpAssignment {
  ip: string;
  network?: { name?: string; org_slug?: string };
}

interface FlyNetworkPolicy {
  netpolSelector?: { all?: boolean };
  rules?: Array<{
    action?: string;
    direction?: string;
    ports?: Array<{ protocol?: string; port?: number }>;
  }>;
}

interface FlyMachineExitEvent {
  exit_code?: number;
  oom_killed?: boolean;
}

export interface FlyMachine {
  id: string;
  state: string;
  config?: FlyMachineConfig;
  checks?: Array<{ name?: string; status?: string; output?: string }>;
  events?: Array<{ request?: { exit_event?: FlyMachineExitEvent } }>;
}

export interface FlyMachineConfig {
  image: string;
  metadata?: Record<string, string>;
  mounts?: Array<{ volume: string; path: string }>;
  env: Record<string, string>;
  guest: { cpu_kind: string; cpus: number; memory_mb: number };
  files: Array<{ guest_path: string; raw_value: string }>;
  services: Array<{
    protocol: "tcp";
    internal_port: number;
    autostop: "suspend";
    autostart: true;
    min_machines_running: number;
    ports: Array<{ port: number }>;
    checks: Array<{ type: "tcp"; interval: string; timeout: string; grace_period: string }>;
  }>;
  init: { exec: string[] };
}

export interface FlyMachinesApi {
  startMachine(appName: string, machineId: string): Promise<void>;
  hasVolumes(appName: string): Promise<boolean>;
  ensureVolume(appName: string, region: string, sizeGb: number, name: string): Promise<string>;
  updateMachine(appName: string, machineId: string, config: FlyMachineConfig): Promise<void>;
  ensureApp(appName: string, orgSlug: string): Promise<void>;
  ensurePrivateIngress(appName: string, provisioned: boolean, orgSlug: string): Promise<void>;
  assertOwnedApp(appName: string, orgSlug: string): Promise<boolean>;
  deleteApp(appName: string): Promise<void>;
  listMachines(appName: string): Promise<FlyMachine[]>;
  createMachine(
    appName: string,
    input: { region: string; config: FlyMachineConfig; skip_service_registration: true },
  ): Promise<FlyMachine>;
  getMachine(appName: string, machineId: string): Promise<FlyMachine | null>;
  setCordon(appName: string, machineId: string, cordoned: boolean): Promise<void>;
  destroyMachine(appName: string, machineId: string): Promise<void>;
  exec(appName: string, machineId: string, script: string, timeoutSec: number): ReturnType<Exec>;
}

interface FlyApiResponse {
  ok: boolean;
  status: number;
  text: string;
}

export function createFlyMachinesApi(opts: { token: string; fetchImpl?: typeof fetch }): FlyMachinesApi {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const request = async (
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = API_TIMEOUT_MS,
  ): Promise<FlyApiResponse> => {
    const res = await fetchImpl(`${MACHINES_API_BASE_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  };
  const failure = (what: string, r: FlyApiResponse): Error =>
    new Error(`fly ${what}: http ${r.status} ${r.text.slice(0, 200)}`);
  const parse = <T>(what: string, r: FlyApiResponse): T => {
    try {
      return JSON.parse(r.text) as T;
    } catch {
      throw new Error(`fly ${what}: unreadable response: ${r.text.slice(0, 200)}`);
    }
  };
  const app = (appName: string): string => `/apps/${encodeURIComponent(appName)}`;
  const machine = (appName: string, machineId: string): string =>
    `${app(appName)}/machines/${encodeURIComponent(machineId)}`;
  const getApp = async (appName: string): Promise<FlyApp | null> => {
    const r = await request("GET", app(appName));
    if (r.status === 404) return null;
    if (!r.ok) throw failure(`read app ${appName}`, r);
    return parse<FlyApp>(`read app ${appName}`, r);
  };
  const assertOwned = assertOwnedFlyApp;
  return {
    ...flyStorageApi({ request, failure, parse, app, machine }),
    async ensureApp(appName, orgSlug): Promise<void> {
      const existing = await getApp(appName);
      if (existing) {
        assertOwned(appName, orgSlug, existing);
        return;
      }
      const r = await request("POST", "/apps", { app_name: appName, org_slug: orgSlug, network: appName });
      if (r.ok) return;
      const found = await getApp(appName).catch((e: unknown) => {
        throw new Error(failure(`create app ${appName}`, r).message, { cause: e });
      });
      if (!found) throw failure(`create app ${appName}`, r);
      assertOwned(appName, orgSlug, found);
    },
    async ensurePrivateIngress(appName, provisioned, orgSlug): Promise<void> {
      const listed = await request("GET", `${app(appName)}/ip_assignments`);
      if (!listed.ok) throw failure(`list IP assignments for ${appName}`, listed);
      const ips = parse<{ ips: FlyIpAssignment[] }>(`list IP assignments for ${appName}`, listed).ips;
      if (ips.some((entry) => !entry.ip.toLowerCase().startsWith("fdaa:"))) {
        throw new Error(`fly app ${appName} has a public IP assignment; refusing to expose the published app`);
      }
      if (provisioned && ips.length) {
        if (
          ips.some(
            ({ network }) =>
              !network?.name || network.name === "default" || network.name === appName || network.org_slug !== orgSlug,
          )
        ) {
          throw new Error(`Fly shared app ${appName} requires ingress on a separate private network in ${orgSlug}`);
        }
        const response = await request("GET", `${app(appName)}/network_policies`);
        if (!response.ok) throw failure(`read network policies for ${appName}`, response);
        const policies = parse<FlyNetworkPolicy[]>(`read network policies for ${appName}`, response);
        const ingress = (policy: FlyNetworkPolicy) =>
          policy.rules?.filter((rule) => rule.direction === "ingress") ?? [];
        if (
          !policies.some(
            (policy) =>
              policy.netpolSelector?.all === true &&
              Object.keys(policy.netpolSelector).length === 1 &&
              ingress(policy).length > 0,
          ) ||
          policies.some((policy) =>
            ingress(policy).some(
              (rule) =>
                rule.action !== "allow" ||
                !rule.ports?.length ||
                rule.ports.some((port) => port.protocol !== "tcp" || port.port !== 22),
            ),
          )
        ) {
          throw new Error(`Fly shared app ${appName} requires all-machine ingress restricted to TCP port 22`);
        }
      }
      if (ips.length) return;
      if (provisioned) throw new Error(`Fly shared app ${appName} needs private ingress provisioned before publishing`);
      const assigned = await request("POST", `${app(appName)}/ip_assignments`, { type: "private_v6" });
      if (!assigned.ok) throw failure(`allocate private ingress for ${appName}`, assigned);
    },
    async assertOwnedApp(appName, orgSlug): Promise<boolean> {
      const found = await getApp(appName);
      if (!found) return false;
      assertOwned(appName, orgSlug, found);
      return true;
    },
    async deleteApp(appName): Promise<void> {
      const r = await request("DELETE", `${app(appName)}?force=true`);
      if (r.ok || r.status === 404) return;
      throw failure(`delete app ${appName}`, r);
    },
    async listMachines(appName): Promise<FlyMachine[]> {
      const r = await request("GET", `${app(appName)}/machines`);
      if (r.status === 404) return [];
      if (!r.ok) throw failure(`list machines in ${appName}`, r);
      return parse<FlyMachine[]>(`list machines in ${appName}`, r);
    },
    async createMachine(appName, input): Promise<FlyMachine> {
      const r = await request("POST", `${app(appName)}/machines`, input);
      if (!r.ok) throw failure(`create machine in ${appName}`, r);
      return parse<FlyMachine>(`create machine in ${appName}`, r);
    },
    async getMachine(appName, machineId): Promise<FlyMachine | null> {
      const r = await request("GET", machine(appName, machineId));
      if (r.status === 404) return null;
      if (!r.ok) throw failure(`get machine ${machineId}`, r);
      return parse<FlyMachine>(`get machine ${machineId}`, r);
    },
    async setCordon(appName, machineId, cordoned): Promise<void> {
      const action = cordoned ? "cordon" : "uncordon";
      const r = await request("POST", `${machine(appName, machineId)}/${action}`);
      if (r.ok || (cordoned && r.status === 404)) return;
      throw failure(`${action} machine ${machineId}`, r);
    },
    ...flyDestroyApi({ request, failure, parse, app, machine }),
    async exec(appName, machineId, script, timeoutSec) {
      const what = `exec in machine ${machineId}`;
      const r = await request(
        "POST",
        `${machine(appName, machineId)}/exec`,
        { cmd: `sh -c ${shq(script)}`, timeout: timeoutSec },
        (timeoutSec + 10) * 1000,
      );
      if (!r.ok) throw failure(what, r);
      const out = parse<{ exit_code?: number; stdout?: string; stderr?: string }>(what, r);
      return { code: out.exit_code ?? 0, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
    },
  };
}

function flyStorageApi({
  request,
  failure,
  parse,
  app,
  machine,
}: FlyHttp): Pick<FlyMachinesApi, "startMachine" | "hasVolumes" | "ensureVolume" | "updateMachine"> {
  return {
    async startMachine(appName, machineId): Promise<void> {
      const started = await request("POST", `${machine(appName, machineId)}/start`);
      if (!started.ok) throw failure(`start machine ${machineId}`, started);
    },
    async hasVolumes(appName): Promise<boolean> {
      const listed = await request("GET", `${app(appName)}/volumes`);
      if (!listed.ok) throw failure(`list volumes in ${appName}`, listed);
      return parse<unknown[]>(`list volumes in ${appName}`, listed).length > 0;
    },
    async ensureVolume(appName, region, sizeGb, name): Promise<string> {
      const path = `${app(appName)}/volumes`;
      const listed = await request("GET", path);
      if (!listed.ok) throw failure(`list volumes in ${appName}`, listed);
      const volumes = parse<Array<{ id: string; name: string; region: string }>>(
        `list volumes in ${appName}`,
        listed,
      ).filter((volume) => name === "qm_data" || volume.name === name);
      if (volumes.length) {
        if (volumes.length !== 1 || volumes[0]!.name !== name || volumes[0]!.region !== region) {
          throw new Error(`fly app ${appName} has unexpected volumes; reconcile storage before deploying`);
        }
        return volumes[0]!.id;
      }
      const created = await request("POST", path, {
        name,
        region,
        size_gb: sizeGb,
        encrypted: true,
        snapshot_retention: 5,
        auto_backup_enabled: true,
        compute: GUEST,
      });
      if (!created.ok) throw failure(`create volume in ${appName}`, created);
      return parse<{ id: string }>(`create volume in ${appName}`, created).id;
    },
    async updateMachine(appName, machineId, config): Promise<void> {
      const updated = await request("POST", machine(appName, machineId), { config, skip_launch: false });
      if (!updated.ok) throw failure(`update machine ${machineId}`, updated);
      const state = parse<FlyMachine>(`update machine ${machineId}`, updated).state;
      if (state === "stopped" || state === "suspended") {
        const started = await request("POST", `${machine(appName, machineId)}/start`);
        if (!started.ok) throw failure(`start updated machine ${machineId}`, started);
      }
    },
  };
}

type FlyHttp = {
  request(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<FlyApiResponse>;
  failure(what: string, r: FlyApiResponse): Error;
  parse<T>(what: string, r: FlyApiResponse): T;
  app(name: string): string;
  machine(app: string, id: string): string;
};

function flyDestroyApi({ request, failure, machine }: FlyHttp): Pick<FlyMachinesApi, "destroyMachine"> {
  return {
    async destroyMachine(appName, machineId): Promise<void> {
      const r = await request("DELETE", `${machine(appName, machineId)}?force=true`);
      if (r.ok || r.status === 404) return;
      throw failure(`destroy machine ${machineId}`, r);
    },
  };
}

function assertOwnedFlyApp(appName: string, orgSlug: string, found: FlyApp): void {
  if (found.name !== appName || found.organization?.slug !== orgSlug || found.network !== appName) {
    throw new Error(
      `fly app ${appName} already exists but is not the isolated app owned by this deployment; choose another FLY_DEPLOY_APP_PREFIX`,
    );
  }
}
