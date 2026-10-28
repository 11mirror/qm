import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { readTree } from "./deploy-fs.ts";
import { makeTar } from "../sandbox/tar.ts";
import { sleep } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";
import { replaceAppMachine, updateAppMachine } from "./machine-rollout.ts";
import { createFlyMachinesApi, type FlyMachine, type FlyMachineConfig } from "./fly-client.ts";
export type { FlyMachine, FlyMachineConfig } from "./fly-client.ts";
interface PortStore {
  putIfAbsent(key: string, value: string): Promise<string>;
}
import {
  appBoot,
  appGone,
  appLogs,
  appReporter,
  recentAppChecks,
  waitAppReady,
  type AppErrorSink,
  type Exec,
} from "./shared-deploy-provider.ts";

const DEFAULT_REGION = "lhr";
const APP_PORT = 8080;
const APP_DIR = "/app";
const BUNDLE_GUEST_PATH = "/app.tar.gz";
const MAX_BUNDLE_BASE64_BYTES = 2_000_000;
const MAX_BUNDLE_SOURCE_BYTES = 20_000_000;
const GUEST = { cpu_kind: "shared", cpus: 1, memory_mb: 512 };
const MACHINE_START_TIMEOUT_MS = 90_000;
const APP_READY_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1_000;

function exitDetail(machine: FlyMachine | null): string {
  const exit = machine?.events?.find((e) => e.request?.exit_event)?.request?.exit_event;
  if (!exit) return "; the machine reported no exit event";
  const parts = [`exit code ${exit.exit_code ?? "unknown"}`];
  if (exit.oom_killed) parts.push("killed for running out of memory");
  return `; last machine exit event: ${parts.join(", ")}`;
}

export interface FlyDeployProviderOptions {
  token: string;
  appPrefix: string;
  sharedAppName?: string;
  portStore?: PortStore;
  privateTransport?: { ensure(): Promise<number> };
  baseImage: string;
  org: string;
  region?: string;
  dataVolumeSizeGb?: number;
  machineStartTimeoutMs?: number;
  appReadyTimeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  onError?: AppErrorSink;
}

function flyDeployContext(opts: FlyDeployProviderOptions) {
  const region = opts.region ?? DEFAULT_REGION;
  const api = createFlyMachinesApi({
    token: opts.token,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const execIn =
    (appName: string, machineId: string): Exec =>
    (script, timeoutSec) =>
      api.exec(appName, machineId, script, timeoutSec);
  const checked = recentAppChecks();

  function ensureConfigured(): void {
    if (
      opts.sharedAppName &&
      (opts.sharedAppName.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(opts.sharedAppName))
    )
      throw new Error("Fly shared app name must be a lowercase DNS label no longer than 63 characters");
    if (opts.sharedAppName && (!opts.portStore || !opts.dataVolumeSizeGb))
      throw new Error("Fly shared apps require persistent port assignments and durable storage");
    if (
      opts.dataVolumeSizeGb !== undefined &&
      (!Number.isInteger(opts.dataVolumeSizeGb) || opts.dataVolumeSizeGb < 1)
    ) {
      throw new Error("FLY_DEPLOY_DATA_VOLUME_SIZE_GB must be a positive integer");
    }
    if (!opts.token) throw new Error("FLY_DEPLOY_API_TOKEN not set (DEPLOY_PROVIDER=fly)");
    if (!opts.appPrefix && !opts.sharedAppName) throw new Error("FLY_DEPLOY_APP_PREFIX not set (DEPLOY_PROVIDER=fly)");
    if (!opts.baseImage) throw new Error("FLY_DEPLOY_BASE_IMAGE not set (DEPLOY_PROVIDER=fly)");
    if (!opts.org) throw new Error("FLY_ORG not set (DEPLOY_PROVIDER=fly)");
    if (
      !opts.sharedAppName &&
      (opts.appPrefix.length > 26 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(opts.appPrefix))
    ) {
      throw new Error("FLY_DEPLOY_APP_PREFIX must be a lowercase DNS label no longer than 26 characters");
    }
  }

  const appNameFor = (d: Deployment): string => opts.sharedAppName ?? `${opts.appPrefix}-${d.id}`;
  const endpointFor = async (d: Deployment, port: number): Promise<DeployEndpoint> => ({
    host: `${appNameFor(d)}.flycast`,
    port,
    ...(opts.privateTransport ? { socksProxyPort: await opts.privateTransport.ensure() } : {}),
  });
  const volumeNameFor = (d: Deployment): string =>
    opts.sharedAppName ? `qm_${createHash("sha256").update(d.id).digest("hex").slice(0, 24)}` : "qm_data";
  const deploymentMachines = async (d: Deployment): Promise<FlyMachine[]> => {
    const machines = await api.listMachines(appNameFor(d));
    return opts.sharedAppName
      ? machines.filter((machine) => machine.config?.metadata?.qm_deployment_id === d.id)
      : machines;
  };
  async function portFor(d: Deployment): Promise<number> {
    if (!opts.sharedAppName) return APP_PORT;
    const first = createHash("sha256").update(d.id).digest().readUInt32BE(0) % 45536;
    for (let offset = 0; offset < 45536; offset++) {
      const port = 20000 + ((first + offset) % 45536);
      if ((await opts.portStore!.putIfAbsent(`${opts.sharedAppName}:${port}`, d.id)) === d.id) return port;
    }
    throw new Error("Fly shared app has no available deployment ports");
  }

  async function bundleBase64(version: DeploymentVersion): Promise<string> {
    const tree = await readTree(version.snapshotDir, { tolerateMissing: true });
    const encoded = gzipSync(await makeTar(tree)).toString("base64");
    if (encoded.length > MAX_BUNDLE_BASE64_BYTES) {
      throw new Error(
        `the app bundle is too large for the Fly deploy provider: ${encoded.length} bytes once packed and encoded, ` +
          `maximum ${MAX_BUNDLE_BASE64_BYTES} bytes — publish fewer or smaller files`,
      );
    }
    return encoded;
  }

  const machineConfig = (
    d: Deployment,
    version: DeploymentVersion,
    bundle: string,
    port: number,
  ): FlyMachineConfig => ({
    image: opts.baseImage,
    ...(opts.sharedAppName ? { metadata: { qm_deployment_id: d.id } } : {}),
    env: { ...version.env, PORT: String(APP_PORT) },
    guest: GUEST,
    files: [{ guest_path: BUNDLE_GUEST_PATH, raw_value: bundle }],
    services: [
      {
        protocol: "tcp",
        internal_port: APP_PORT,
        autostop: "suspend",
        autostart: true,
        min_machines_running: d.alwaysOn ? 1 : 0,
        ports: [{ port }],
        checks: [{ type: "tcp", interval: "2s", timeout: "1s", grace_period: "1s" }],
      },
    ],
    init: {
      exec: [
        "/bin/sh",
        "-lc",
        appBoot(
          `cd ${APP_DIR}; ${version.entrypoint}`,
          APP_PORT,
          `mkdir -p ${APP_DIR} && tar -xzf ${BUNDLE_GUEST_PATH} -C ${APP_DIR}`,
        ),
      ],
    },
  });

  const { waitStarted, waitServing } = flyReadiness(opts, api, execIn);
  const rollout = (d: Deployment, appName: string) => ({
    create: (config: FlyMachineConfig) =>
      api.createMachine(appName, { region, config, skip_service_registration: true }),
    update: (id: string, config: FlyMachineConfig) => api.updateMachine(appName, id, config),
    destroy: (id: string) => api.destroyMachine(appName, id),
    route: (id: string, serving: boolean) => api.setCordon(appName, id, !serving),
    ready: async (id: string, config: FlyMachineConfig) => {
      await waitStarted(appName, id);
      await waitServing(d, config.env, appName, id);
    },
  });

  return {
    region,
    api,
    execIn,
    checked,
    ensureConfigured,
    appNameFor,
    endpointFor,
    volumeNameFor,
    deploymentMachines,
    portFor,
    bundleBase64,
    machineConfig,
    rollout,
  };
}

function flyReadiness(
  opts: FlyDeployProviderOptions,
  api: ReturnType<typeof createFlyMachinesApi>,
  execIn: (appName: string, machineId: string) => Exec,
) {
  const machineStartTimeoutMs = opts.machineStartTimeoutMs ?? MACHINE_START_TIMEOUT_MS;
  const appReadyTimeoutMs = opts.appReadyTimeoutMs ?? APP_READY_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;
  async function waitStarted(appName: string, machineId: string): Promise<void> {
    const deadline = Date.now() + machineStartTimeoutMs;
    let last: FlyMachine | null = null;
    let requestedStart = false;
    while (Date.now() < deadline) {
      last = await api.getMachine(appName, machineId);
      if (last?.state === "started") return;
      if (!requestedStart && (last?.state === "stopped" || last?.state === "suspended")) {
        requestedStart = true;
        await api.startMachine(appName, machineId);
      }
      await sleep(pollIntervalMs);
    }
    throw new Error(
      `fly machine ${machineId} never reached state "started" within ${seconds(machineStartTimeoutMs)} ` +
        `(last state: ${last?.state ?? "unknown"})${exitDetail(last)}`,
    );
  }

  async function waitServing(
    d: Deployment,
    env: Record<string, string> | undefined,
    appName: string,
    machineId: string,
  ): Promise<void> {
    await waitAppReady(execIn(appName, machineId), {
      appPort: APP_PORT,
      windowSec: Math.ceil(appReadyTimeoutMs / 1000),
      report: appReporter(opts.onError, d, env),
    });
    const deadline = Date.now() + appReadyTimeoutMs;
    let machine: FlyMachine | null = null;
    while (Date.now() < deadline) {
      machine = await api.getMachine(appName, machineId);
      if (machine?.state === "started" && machine.checks?.some((check) => check.status === "passing")) return;
      await sleep(pollIntervalMs);
    }
    machine = await api
      .getMachine(appName, machineId)
      .catch(swallowAs<FlyMachine | null>("fly-deploy: read machine after readiness timeout", machine));
    const why =
      machine && machine.state !== "started"
        ? `the version's entrypoint exited without binding port ${APP_PORT} (fly machine ${machineId} is ${machine.state})`
        : `the app never listened on port ${APP_PORT} within ${seconds(appReadyTimeoutMs)}`;
    throw new Error(`${why}${exitDetail(machine)}`);
  }

  return { waitStarted, waitServing };
}

export function createFlyDeployProvider(opts: FlyDeployProviderOptions): DeployProvider {
  const {
    region,
    api,
    execIn,
    checked,
    ensureConfigured,
    appNameFor,
    endpointFor,
    volumeNameFor,
    deploymentMachines,
    portFor,
    bundleBase64,
    machineConfig,
    rollout,
  } = flyDeployContext(opts);
  return {
    profile: {
      managedScaleToZero: !!opts.sharedAppName,
      maxAppBytes: MAX_BUNDLE_SOURCE_BYTES,
      ...(opts.dataVolumeSizeGb ? { dataDir: "/data" } : {}),
    },

    async resolveEndpoint(d, version) {
      if (!checked.has(d.id)) {
        ensureConfigured();
        const machines = await deploymentMachines(d).catch(
          swallowAs<FlyMachine[]>("fly-deploy: list app machines", []),
        );
        const appName = appNameFor(d);
        const report = appReporter(opts.onError, d, version.env);
        if (
          machines.length === 1 &&
          machines[0]!.state === "started" &&
          (await appGone(execIn(appName, machines[0]!.id), { appPort: APP_PORT, report }))
        )
          return null;
        checked.set(d.id, true);
      }
      if (!opts.privateTransport) return d.endpoint;
      return endpointFor(d, await portFor(d));
    },

    async logs(d, logOpts): Promise<string | null> {
      ensureConfigured();
      const machines = await deploymentMachines(d);
      if (machines.length !== 1 || machines[0]!.state !== "started") return null;
      return appLogs(execIn(appNameFor(d), machines[0]!.id), logOpts.tailLines);
    },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      ensureConfigured();
      const appName = appNameFor(d);
      const bundle = await bundleBase64(version);
      if (opts.sharedAppName) {
        if (!(await api.assertOwnedApp(appName, opts.org)))
          throw new Error(`Fly shared app ${appName} must be provisioned before publishing`);
      } else {
        await api.ensureApp(appName, opts.org);
      }
      await api.ensurePrivateIngress(appName, Boolean(opts.sharedAppName), opts.org);
      const stale = await deploymentMachines(d);
      const port = await portFor(d);
      if (!opts.dataVolumeSizeGb && (await api.hasVolumes(appName))) {
        throw new Error(
          `fly app ${appName} has durable storage; restore FLY_DEPLOY_DATA_VOLUME_SIZE_GB before deploying`,
        );
      }
      if (opts.dataVolumeSizeGb) {
        if (stale.length > 1) throw new Error(`fly app ${appName} has multiple machines; reconcile before deploying`);
        const previous = stale[0] ? await api.getMachine(appName, stale[0].id) : null;
        if (stale.length && !previous?.config?.mounts?.some((mount) => mount.path === "/data")) {
          throw new Error(`fly app ${appName} requires an explicit migration from ephemeral storage`);
        }
        const volume = await api.ensureVolume(appName, region, opts.dataVolumeSizeGb, volumeNameFor(d));
        if (previous && (previous.config!.mounts!.length !== 1 || previous.config!.mounts![0]!.volume !== volume)) {
          throw new Error(`fly app ${appName} has an unexpected volume attachment`);
        }
        const config = machineConfig(d, version, bundle, port);
        config.env.DATA_DIR = "/data";
        config.mounts = [{ volume, path: "/data" }];
        await updateAppMachine(rollout(d, appName), previous, config);
        return endpointFor(d, port);
      }
      await replaceAppMachine(rollout(d, appName), stale, machineConfig(d, version, bundle, port));
      return endpointFor(d, port);
    },

    async destroy(d: Deployment): Promise<void> {
      ensureConfigured();
      const appName = appNameFor(d);
      if (!(await api.assertOwnedApp(appName, opts.org))) return;
      if (opts.dataVolumeSizeGb || (await api.hasVolumes(appName))) {
        for (const machine of await deploymentMachines(d)) await api.destroyMachine(appName, machine.id);
        return;
      }
      await api.deleteApp(appName);
    },
  };
}
