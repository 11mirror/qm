import { createBackgroundController } from "./runs/background-controller.ts";
import { createManagedSlack, type ManagedSlack } from "./surfaces/slack-managed.ts";
import type { Server } from "node:http";
import { loadConfig, type Config } from "./config.ts";
import { buildApp, serverDeps } from "./wiring.ts";
import { createServer } from "./api/server.ts";
import { dockerDaemonFailure } from "./deploy/docker-deploy-provider.ts";
import { errMessage, reportFailureAs } from "./util/errors.ts";
import { slackPluginConfigFromEnv, startSlackPlugin } from "./slack/index.ts";
import { createSlackRuntimeReconciler } from "./surfaces/slack-runtime.ts";
import { createPgPool, migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { setEdgeTenants } from "../plugins/chassis/src/tenant-hosts.ts";
import { tagErrorDeployment } from "../plugins/chassis/src/error-reporting.ts";
import { configureTenantConversion } from "./tenants/bootstrap.ts";
import {
  evictTenant,
  perTenant,
  scopedTenant,
  tenant,
  tenantSettings,
  withoutTenant,
  withTenant,
  type Tenant,
} from "./tenant.ts";
import {
  activeTenants,
  createTenantDirectory,
  taskTenant,
  useTenantDirectory,
  watchActiveTenants,
} from "./tenants/directory.ts";
import { tenantConfig } from "./tenants/tenant-config.ts";
import { assertRowSecurityEnforced } from "./tenants/registry.ts";
import { tenantSecretsKey } from "../plugins/chassis/src/tenant-settings.ts";

export interface BootedApp {
  config: Config;
  server: Server;
  beginShutdown(): void;
  stop(): Promise<void>;
  releaseInFlightRuns(): Promise<void>;
}

export async function bootApp(
  env: NodeJS.ProcessEnv,
  serve: (server: Server, config: Config) => Promise<void>,
): Promise<BootedApp> {
  const config = loadConfig(env);
  configureTenantConversion(env);
  return withoutTenant(() => bootConfiguredApp(config, env, serve));
}

async function bootConfiguredApp(
  config: Config,
  env: NodeJS.ProcessEnv,
  serve: (server: Server, config: Config) => Promise<void>,
): Promise<BootedApp> {
  const slackIngress = config.backgroundWorkEnabled && !config.backgroundDeploymentId;

  const built = buildApp(config, { env });
  await migrateRegisteredPgSchemas(config.databaseUrl);
  const publishEdge = edgeTenantFeed();
  const registry = await useRegistryTenants(config, env, built.start);
  watchActiveTenants(publishEdge);
  const slack = createTenantSlack({ env, config, built, running: slackIngress });
  const server = createServer(
    built.app,
    serverDeps(config, built, "absent", undefined, () => slack.managed()),
  );

  const tenants = await activeTenants();
  built.runtime.start();

  publishEdge(tenants);
  await serve(server, config);

  warnAboutUnreachableFeatures(config);

  if (!config.backgroundWorkEnabled && !config.backgroundDeploymentId)
    console.log("[qm] background work disabled; scheduler and runtime loops will not start");

  const syncSlack = async (active: Tenant[]) => {
    const { rows } = await (
      await registry.pool.deploymentPool()
    ).query("SELECT id::text FROM qm_tenants_with_rows(ARRAY['slack_installation']::regclass[])");
    slack.sync(
      active,
      rows.map((row) => String(row.id)),
    );
  };
  await syncSlack(tenants);
  watchActiveTenants((active) => {
    void syncSlack(active).catch(reportFailureAs("slack tenant discovery", undefined));
  });

  const backgroundController = built.backgroundOwnership
    ? startBackgroundOwnership(built, built.backgroundOwnership, [slack.runtimes])
    : undefined;

  return {
    config,
    server,
    beginShutdown() {
      void slack.runtimes.stop().catch((e: unknown) => console.error("[qm] slack plugin stop failed:", errMessage(e)));
    },
    async stop() {
      await backgroundController?.stop();
      await slack.close();
      await built.runtime.stop();
      await registry.close();
    },
    releaseInFlightRuns: () => built.runtime.releaseInFlightRuns(),
  };
}

function warnAboutUnreachableFeatures(config: Config): void {
  if (config.deployProvider === "docker") {
    void dockerDaemonFailure().then((failure) => {
      if (failure)
        console.warn(
          `[qm] publishing is unavailable: the docker deploy provider is selected but no Docker daemon is reachable from core (${failure}) — make a daemon reachable, or set DEPLOY_PROVIDER to aws`,
        );
    });
  }
}

type SlackRuntime = Omit<ReturnType<typeof createSlackRuntimeReconciler>, "ready">;

export function edgeTenantFeed(): (active: Tenant[]) => void {
  return (active) => setEdgeTenants(active.map((t) => tenantSettings(t)));
}

async function useRegistryTenants(config: Config, env: NodeJS.ProcessEnv, prepare: () => Promise<void>) {
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl) throw new Error("DATABASE_URL is required to read the tenant registry");
  const pool = createPgPool(databaseUrl);
  await assertRowSecurityEnforced(pool);
  tagErrorDeployment(() => (scopedTenant() ? (tenantConfig(config).sentryDeployment ?? tenant().orgId) : undefined));
  const directory = createTenantDirectory({
    databaseUrl,
    pool,
    secretsKey: tenantSecretsKey(env),
    sandboxPrefix: config.sandbox.namePrefix ?? "qm",
    prepare,
  });
  useTenantDirectory(directory);
  return {
    pool,
    close: async () => {
      useTenantDirectory(undefined);
      await directory.close();
      await pool.close();
    },
  };
}

const SHARED_SLACK_ENV = [
  "QM_SLACK_SERVICE_URL",
  "SLACK_API_URL",
  "SLACK_HISTORY_LIMIT",
  "SLACK_LOG_LEVEL",
  "DEV_HEALTH_PORT",
  "DEV_INSTANCE_NO_SLACK",
  "DEV_INTROSPECTION",
];

function slackEnvOf(env: NodeJS.ProcessEnv, config: Config): NodeJS.ProcessEnv {
  const shared = Object.fromEntries(SHARED_SLACK_ENV.map((name) => [name, env[name]]));
  return { ...shared, WEB_UI_PUBLIC_URL: tenantConfig(config).publicWebUrl };
}

interface TenantSlackEntry {
  tenant: Tenant;
  managed?: ManagedSlack;
  runtime: ReturnType<typeof createSlackRuntimeReconciler>;
  accounts: SlackRuntime[];
}

function slackAccountsFor(t: Tenant, config: Config, built: ReturnType<typeof buildApp>): SlackRuntime[] {
  return (tenantSettings(t).secrets.slackAccounts ?? []).map((account) =>
    createSlackRuntimeReconciler({
      startPaused: Boolean(config.backgroundDeploymentId),
      load: async () => ({ version: "tenant", config: account }),
      startPlugin: (desired) =>
        withTenant(t, async () => {
          await taskTenant(t.id, true);
          return startSlackPlugin(desired, built.slackCore);
        }),
      onError: reportFailureAs(
        "slack account reconciliation",
        undefined,
        `tenant=${t.slug ?? t.id} account=${account.accountId}`,
      ),
    }),
  );
}

export function createTenantSlack(opts: {
  env: NodeJS.ProcessEnv;
  config: Config;
  built: ReturnType<typeof buildApp>;
  running: boolean;
}) {
  const { env, config, built } = opts;
  const live = new Map<string, TenantSlackEntry>();
  const keyOf = (t: Tenant) => t.id ?? "";
  let running = opts.running;
  let closed = false;
  let installed = new Set<string>();

  async function load(entry: TenantSlackEntry) {
    const status = await built.slackInstallation.status();
    const stored = await built.slackInstallation.get();
    const managed = entry.managed;
    if (stored) {
      if (stored.installId && !managed) return null;
      const dynamic = slackPluginConfigFromEnv(
        { ...slackEnvOf(env, config), SLACK_BOT_TOKEN: stored.botToken, SLACK_APP_TOKEN: stored.appToken },
        stored.installId && managed ? (staging) => managed.receiver(stored.installId!, staging) : undefined,
      );
      if (dynamic && stored.installId) dynamic.installationId = stored.installId;
      return dynamic ? { version: stored.version, config: dynamic } : null;
    }
    if (status.managed) return null;
    const desired = tenantConfig(config).slack;
    if (desired) return { version: "tenant", config: desired };
    return null;
  }

  function create(): TenantSlackEntry {
    const t = tenant();
    const entry = { tenant: t } as TenantSlackEntry;
    const token = tenantConfig(config).slackServiceToken;
    if (env.QM_SLACK_SERVICE_URL && token !== undefined) {
      const managed = createManagedSlack({
        serviceUrl: env.QM_SLACK_SERVICE_URL,
        token,
        appId: env.QM_SLACK_APP_ID ?? "",
        store: built.slackInstallation,
        reconcile:
          opts.running || config.backgroundDeploymentId
            ? () => withTenant(t, () => entry.runtime.reconcile())
            : undefined,
      });
      entry.managed = {
        ...managed,
        async handle(req, res, value) {
          if (running && !entry.runtime.ready()) await entry.runtime.reconcile().catch(() => {});
          return managed.handle(req, res, value);
        },
      };
    }
    entry.runtime = createSlackRuntimeReconciler({
      startPaused: Boolean(config.backgroundDeploymentId),
      load: () => withTenant(t, () => load(entry)),
      startPlugin: (desired) =>
        withTenant(t, async () => {
          await taskTenant(t.id, true);
          return startSlackPlugin(desired, built.slackCore);
        }),
      onError: reportFailureAs("slack plugin reconciliation", undefined, `tenant=${t.slug ?? t.id}`),
    });
    entry.accounts = slackAccountsFor(t, config, built);
    live.set(keyOf(t), entry);
    if (running) for (const runtime of [entry.runtime, ...entry.accounts]) runtime.start();
    return entry;
  }

  const ensure = perTenant(create, (entry) => {
    if (live.get(keyOf(entry.tenant)) === entry) live.delete(keyOf(entry.tenant));
    return Promise.all([entry.runtime, ...entry.accounts].map((runtime) => runtime.stop())).then(() => {});
  });

  const all = (fn: (entry: TenantSlackEntry) => Promise<void>) =>
    Promise.all([...live.values()].map((entry) => withTenant(entry.tenant, () => fn(entry)))).then(() => {});

  const unsubscribe = withoutTenant(() =>
    built.slackInstallation.onChange(() => {
      const current = scopedTenant();
      if (!current) {
        if (running)
          void all((entry) => entry.runtime.reconcile()).catch(reportFailureAs("slack installation resync", undefined));
        return;
      }
      const entry = live.get(keyOf(current));
      if (running && !entry) {
        void taskTenant(current.id, true)
          .then((owner) => {
            if (owner && owner !== "retired" && !closed) withTenant(owner, () => ensure());
          })
          .catch(reportFailureAs("slack installation tenant lookup", undefined));
      }
      if (running && entry)
        void entry.runtime
          .reconcile()
          .catch(
            reportFailureAs("slack plugin reconciliation", undefined, `tenant=${entry.tenant.slug ?? entry.tenant.id}`),
          );
    }),
  );

  const runtimes: SlackRuntime = {
    start() {
      running = true;
      for (const entry of live.values())
        withTenant(entry.tenant, () => {
          for (const runtime of [entry.runtime, ...entry.accounts]) runtime.start();
        });
    },
    reconcile: () =>
      all((entry) =>
        Promise.all([entry.runtime, ...entry.accounts].map((runtime) => runtime.reconcile())).then(() => {}),
      ),
    stop() {
      running = false;
      return all((entry) =>
        Promise.all([entry.runtime, ...entry.accounts].map((runtime) => runtime.stop())).then(() => {}),
      );
    },
  };
  const close = async () => {
    closed = true;
    unsubscribe();
    await runtimes.stop();
    await built.slackInstallation.close();
  };

  const sync = (active: Tenant[], installationIds?: string[]) => {
    if (closed) return;
    if (installationIds) installed = new Set(installationIds);
    const keep = new Set(active.map(keyOf));
    for (const [key, entry] of live) if (!keep.has(key)) evictTenant(entry.tenant);
    for (const t of active) {
      const settings = tenantSettings(t);
      if (
        installed.has(t.id) ||
        settings.secrets.slack ||
        settings.secrets.slackAccounts?.length ||
        settings.secrets.slackServiceToken
      )
        withTenant(t, () => ensure());
    }
  };

  return { ensure, sync, close, managed: () => ensure().managed, runtimes };
}

function startBackgroundOwnership(
  built: ReturnType<typeof buildApp>,
  ownership: NonNullable<ReturnType<typeof buildApp>["backgroundOwnership"]>,
  slackRuntimes: SlackRuntime[],
) {
  const controller = createBackgroundController({
    store: ownership.store,
    deploymentId: ownership.deploymentId,
    async start(signal) {
      if (signal.aborted) return;
      built.runtime.startBackground();
      for (const runtime of slackRuntimes) {
        if (signal.aborted) return;
        runtime.start();
        await runtime.reconcile();
      }
    },
    fence() {
      void built.runtime.stopBackgroundClaims().catch(reportFailureAs("qm: background claim stop", undefined));
      for (const runtime of slackRuntimes)
        void runtime.stop().catch(reportFailureAs("qm: Slack background stop", undefined));
    },
    async relinquish() {
      await Promise.all([built.runtime.stopBackgroundClaims(), ...slackRuntimes.map((runtime) => runtime.stop())]);
    },
    drained: () => built.runtime.backgroundDrained(),
    onError: reportFailureAs("background ownership", undefined),
  });
  built.runtime.setBackgroundAdmission(controller.canClaim, controller.active);
  controller.start();
  return controller;
}
