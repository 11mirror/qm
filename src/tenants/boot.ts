import { createBackgroundController } from "../runs/background-controller.ts";
import { createManagedSlack } from "../surfaces/slack-managed.ts";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { Server } from "node:http";
import { loadConfig, type Config } from "../config.ts";
import { buildApp, serverDeps } from "../wiring.ts";
import { createServer } from "../api/server.ts";
import { dockerDaemonFailure } from "../deploy/docker-deploy-provider.ts";
import { errMessage, reportFailureAs } from "../util/errors.ts";
import { slackAccountConfigsFromEnv, slackPluginConfigFromEnv, startSlackPlugin } from "../slack/index.ts";
import { createSlackRuntimeReconciler } from "../surfaces/slack-runtime.ts";
import { migrateRegisteredPgSchemas } from "../persistence/pg-pool.ts";
import { ensureTenantQueues } from "../turns/absurd-schema.ts";

export interface BootedTenant {
  config: Config;
  server: Server;
  beginShutdown(): void;
  stop(): Promise<void>;
  releaseInFlightRuns(): Promise<unknown>;
}

export async function bootTenant(
  env: NodeJS.ProcessEnv,
  serve: (server: Server, config: Config) => Promise<void>,
): Promise<BootedTenant> {
  const config = loadConfig(env);
  const slackIngress = config.backgroundWorkEnabled && !config.backgroundDeploymentId;

  const built = buildApp(config, { env });
  await migrateRegisteredPgSchemas(config.databaseUrl);
  if (config.databaseUrl) await ensureTenantQueues(config.databaseUrl);
  const rewrittenCredentials = (await built.keychain?.rewriteTargetUsernameCredentials()) ?? 0;
  if (rewrittenCredentials > 0)
    console.log(`[qm] rewrote ${rewrittenCredentials} keychain credential(s) to the current shape`);
  const slackConfig = slackPluginConfigFromEnv(env);
  let slackEnvironmentState: "absent" | "configured" | "partial" = slackConfig ? "configured" : "absent";
  if (!slackConfig && (env.SLACK_BOT_TOKEN || env.SLACK_APP_TOKEN)) slackEnvironmentState = "partial";
  const managedSlack = env.QM_SLACK_SERVICE_URL
    ? createManagedSlack({
        serviceUrl: env.QM_SLACK_SERVICE_URL,
        token: env.QM_SLACK_SERVICE_TOKEN ?? "",
        appId: env.QM_SLACK_APP_ID ?? "",
        store: built.slackInstallation,
        reconcile: slackIngress || config.backgroundDeploymentId ? () => slackRuntime.reconcile() : undefined,
      })
    : undefined;
  const server = createServer(built.app, {
    ...serverDeps(config, built, slackEnvironmentState, slackConfig?.botToken),
    managedSlack,
  });

  await built.start();
  await built.refreshCustomProviders();
  built.deploymentLayerRefresh.start();
  built.runtime.start();

  await serve(server, config);

  warnAboutUnreachableFeatures(config);

  if (!config.backgroundWorkEnabled && !config.backgroundDeploymentId)
    console.log("[qm] background work disabled; scheduler and runtime loops will not start");

  const slackRuntime = createSlackRuntimeReconciler({
    startPaused: Boolean(config.backgroundDeploymentId),
    load: async () => {
      const status = await built.slackInstallation.status();
      const stored = await built.slackInstallation.get();
      if (stored) {
        if (stored.installId && !managedSlack) return null;
        const dynamic = slackPluginConfigFromEnv(
          {
            ...env,
            SLACK_BOT_TOKEN: stored.botToken,
            SLACK_APP_TOKEN: stored.appToken,
          },
          stored.installId && managedSlack ? (staging) => managedSlack.receiver(stored.installId!, staging) : undefined,
        );
        if (dynamic && stored.installId) dynamic.installationId = stored.installId;
        return dynamic ? { version: stored.version, config: dynamic } : null;
      }
      if (status.managed) return null;
      if (slackConfig) return { version: "environment", config: slackConfig };
      return null;
    },
    startPlugin: (desired) => startSlackPlugin(desired, built.slackCore),
    onError: reportFailureAs("slack plugin reconciliation", undefined),
  });
  if (slackIngress) slackRuntime.start();

  const slackAccountRuntimes = slackAccountConfigsFromEnv(env).map((account) =>
    createSlackRuntimeReconciler({
      startPaused: Boolean(config.backgroundDeploymentId),
      load: () => Promise.resolve({ version: `environment:${account.accountId}`, config: account }),
      startPlugin: (desired) => startSlackPlugin(desired, built.slackCore),
      onError: reportFailureAs("slack account reconciliation", undefined, `account=${account.accountId}`),
    }),
  );
  if (slackIngress) for (const runtime of slackAccountRuntimes) runtime.start();

  const backgroundController = built.backgroundOwnership
    ? startBackgroundOwnership(built, built.backgroundOwnership, [slackRuntime, ...slackAccountRuntimes])
    : undefined;

  return {
    config,
    server,
    beginShutdown() {
      void slackRuntime.stop().catch((e: unknown) => console.error("[qm] slack plugin stop failed:", errMessage(e)));
      for (const runtime of slackAccountRuntimes)
        void runtime.stop().catch((e: unknown) => console.error("[qm] slack account stop failed:", errMessage(e)));
      built.deploymentLayerRefresh.stop();
    },
    async stop() {
      await backgroundController?.stop();
      await built.runtime.stop();
    },
    releaseInFlightRuns: () => built.runtime.releaseInFlightRuns(),
  };
}

function warnAboutUnreachableFeatures(config: Config): void {
  if (config.deployAppsDomain) {
    const domain = config.deployAppsDomain;
    const probe = `qm-probe-${randomBytes(4).toString("hex")}.${domain}`;
    void lookup(probe).catch(() => {
      console.warn(
        `[qm] app subdomains are configured but *.${domain} does not resolve (probed ${probe}) — ` +
          `add a wildcard DNS record for *.${domain} pointing at this instance's ingress, or apps will only be reachable at /d/<app>/`,
      );
    });
  }

  if (config.databaseUrl && !config.adminGrants) {
    console.warn(
      "[qm] ADMIN_GRANTS is unset with a durable store — if this deployment has never named an admin, the admin console is unreachable and cannot be unlocked from inside the product; set ADMIN_GRANTS=<email>:org_admin (ignore this if an admin was already promoted in the Users tab).",
    );
  }

  if (config.deployProvider === "docker") {
    void dockerDaemonFailure().then((failure) => {
      if (failure)
        console.warn(
          `[qm] publishing is unavailable: the docker deploy provider is selected but no Docker daemon is reachable from core (${failure}) — make a daemon reachable, or set DEPLOY_PROVIDER to aws`,
        );
    });
  }
}

type SlackRuntime = ReturnType<typeof createSlackRuntimeReconciler>;

/** Run background work (and the Slack runtimes) only while this deployment owns it. */
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
      void built.runtime
        .stopBackgroundClaims()
        .catch((error) => console.error("[qm] background claim stop failed:", errMessage(error)));
      for (const runtime of slackRuntimes)
        void runtime.stop().catch((error) => console.error("[qm] Slack background stop failed:", errMessage(error)));
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
