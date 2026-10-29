import { continueInPrivate } from "./private-continuation.ts";
import { externalSlackNamespace } from "./external-access.ts";
import { registerKeychainApprovalActions } from "./keychain-approvals.ts";
import { registerDeployAccessActions } from "./deploy-access.ts";
import { SlackPluginStartCleanupError } from "../surfaces/slack-runtime.ts";
import { createSlackRateLimitNotice } from "./rate-limit-notice.ts";
import { createSlackHistoryReader } from "./history.ts";
import { reportFailure, swallow, swallowAs } from "../util/errors.ts";
import { createEnvelopeStaging } from "./envelope-staging.ts";
import bolt from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { createDeduper, createThreadTracker } from "./message-gating.ts";
import { installDevIntrospection } from "./dev-introspection.ts";
import { setDefaultBotIdentity, createSurfaceHeaderEnsurer, type SurfaceHeaderClient } from "./delivery.ts";
import {
  NO_RETRY,
  HISTORY_NO_RETRY,
  type SlackPluginConfig,
  normalizeSlackApiUrl,
  slackAccountConfigsFromEnv,
  slackPluginConfigFromEnv,
} from "./config.ts";
import { createTurnFlow } from "./turn-flow.ts";
import { createActorGate, createDenyResponder } from "./allow-from.ts";
import { createAckEmojiPicker } from "./ack-emoji.ts";
import { type BotIdentity, createDirectory } from "./directory.ts";
import { createMirror } from "./mirror.ts";
import { createConversationSerializer } from "./conversation-view.ts";
import { createApprovals } from "./approvals.ts";
import { createTurnHandler } from "./turn-handler.ts";
import { registerSlackEvents } from "./events.ts";
import { createSurfaceContextFulfiller } from "./surface-context.ts";
import { createSlackSender } from "./sender.ts";
import { createDeferredAckReceiver } from "./deferred-ack.ts";
import { createHttpEventsReceiver } from "./http-events.ts";
import { parseChannelPage, parseLogLevel } from "./payloads.ts";
import type { SlackCoreClient, SlackUpkeep, SurfaceContextRequest } from "../api/slack-core-client.ts";
import type { AuthTestResponse } from "@slack/web-api";
const { App } = bolt;

export type { SlackCoreClient };
export type { SlackPluginConfig };
export { normalizeSlackApiUrl, slackAccountConfigsFromEnv, slackPluginConfigFromEnv };

type SlackApp = InstanceType<typeof App>;
type SlackDirectory = ReturnType<typeof createDirectory>;
type SlackConnection = ReturnType<typeof slackConnection>;
type SlackFlow = ReturnType<typeof createTurnFlow>;

function slackConnection(cfg: SlackPluginConfig) {
  if (!cfg.botToken) throw new Error("Slack plugin needs botToken (SLACK_BOT_TOKEN, xoxb-…)");
  if (!cfg.receiverFactory && !cfg.appToken && !cfg.signingSecret)
    throw new Error("Slack plugin needs appToken (SLACK_APP_TOKEN, xapp-…) or signingSecret (SLACK_SIGNING_SECRET)");
  const BOT_TOKEN = cfg.botToken;
  const APP_TOKEN = cfg.appToken;
  const SLACK_API_URL = cfg.apiUrl ? normalizeSlackApiUrl(cfg.apiUrl) : undefined;
  const TRUSTED_FILE_HOST = SLACK_API_URL ? new URL(SLACK_API_URL).hostname : undefined;
  const CLIENT_OPTIONS = {
    ...NO_RETRY,
    attachOriginalToWebAPIRequestError: false,
    ...(SLACK_API_URL ? { slackApiUrl: SLACK_API_URL } : {}),
  } as const;
  const webClient = (token: string, extra: Record<string, unknown> = {}) =>
    new WebClient(token, { ...CLIENT_OPTIONS, ...extra });
  return { BOT_TOKEN, APP_TOKEN, SLACK_API_URL, TRUSTED_FILE_HOST, CLIENT_OPTIONS, webClient };
}

function settingsCaches(cfg: SlackPluginConfig, core: SlackCoreClient) {
  let ackOverrideCache: { names: string[] | null; fetchedAt: number } | undefined;
  function ackEmojiOverride(): readonly string[] | null {
    if (!ackOverrideCache || Date.now() - ackOverrideCache.fetchedAt >= 60_000) {
      ackOverrideCache = { names: ackOverrideCache?.names ?? null, fetchedAt: Date.now() };
      core.ackEmojiOverride().then(
        (names) => void (ackOverrideCache = { names: names?.length ? names : null, fetchedAt: Date.now() }),
        (err) => swallow("slack: ack-emoji override read", err),
      );
    }
    return ackOverrideCache.names;
  }

  let externalParticipantsCache: { on: boolean; fetchedAt: number } | undefined;
  async function externalParticipantsEnabled(): Promise<boolean> {
    if (cfg.externalAccess) return true;
    if (externalParticipantsCache && Date.now() - externalParticipantsCache.fetchedAt < 30_000)
      return externalParticipantsCache.on;
    try {
      const on = await core.externalSlackParticipants();
      externalParticipantsCache = { on, fetchedAt: Date.now() };
      return on;
    } catch (err) {
      swallow("slack: surface-config read", err);
      return externalParticipantsCache?.on ?? false;
    }
  }

  return { ackEmojiOverride, externalParticipantsEnabled };
}

function createSlackApp(
  cfg: SlackPluginConfig,
  core: SlackCoreClient,
  conn: SlackConnection,
  ids: BotIdentity,
  stagingAccount: string,
) {
  const { BOT_TOKEN, APP_TOKEN, SLACK_API_URL, CLIENT_OPTIONS } = conn;
  const staging = core.stagedEnvelopes
    ? createEnvelopeStaging(core.stagedEnvelopes, { account: stagingAccount })
    : undefined;
  const receiver = () => {
    if (cfg.receiverFactory) return cfg.receiverFactory(staging);
    return !APP_TOKEN
      ? createHttpEventsReceiver({
          signingSecret: cfg.signingSecret!,
          staging,
          serve: (handler) => core.slack.serveEvents(cfg.accountId ?? "", handler),
        })
      : createDeferredAckReceiver({
          appToken: APP_TOKEN!,
          logLevel: cfg.logLevel,
          slackApiUrl: SLACK_API_URL,
          staging,
        });
  };
  const app = new App({
    token: BOT_TOKEN,
    ignoreSelf: false,
    receiver: receiver(),
    logLevel: parseLogLevel(cfg.logLevel),
    clientOptions: { ...CLIENT_OPTIONS },
  });
  if (cfg.externalAccess)
    app.use(async ({ body, next }) => {
      const envelope = body as unknown as { team_id?: string; team?: { id?: string } };
      const teamId = envelope.team_id ?? envelope.team?.id;
      if (!ids.ownTeamId || teamId !== ids.ownTeamId) return;
      await next();
    });
  const replayEnvelopes = staging
    ? () =>
        staging.sweep((body, ackGate) =>
          app.processEvent({ body, ack: async () => {}, retryNum: 99, customProperties: { ackGate } }),
        )
    : undefined;
  return { app, replayEnvelopes };
}

function slackHistory(cfg: SlackPluginConfig, core: SlackCoreClient, conn: SlackConnection, ids: BotIdentity) {
  const { BOT_TOKEN, webClient } = conn;
  const historyRateLimitOptions = {
    managed: Boolean(cfg.installationId && cfg.sharedServiceUrl?.trim()),
    ...(cfg.webUiPublicUrl ? { setupUrl: `${cfg.webUiPublicUrl}/settings/slack-settings?setup=slack` } : {}),
  };
  const rateLimitNotice = createSlackRateLimitNotice({
    ...historyRateLimitOptions,
    client: webClient(BOT_TOKEN, { ...HISTORY_NO_RETRY, timeout: 5000 }),
  });
  const historyApi = webClient(BOT_TOKEN, HISTORY_NO_RETRY);
  const historyClient = {
    conversations: Object.fromEntries(
      (["history", "replies"] as const).map((method) => [
        method,
        async (args: any) => {
          try {
            return await historyApi.conversations[method](args);
          } catch (error) {
            await rateLimitNotice.observe(error);
            throw error;
          }
        },
      ]),
    ) as Pick<typeof historyApi.conversations, "history" | "replies">,
  };
  const readHistory = createSlackHistoryReader({
    historyLimit: cfg.historyLimit,
    core,
    ids,
    historyClient,
    ...historyRateLimitOptions,
  });
  return { historyRateLimitOptions, rateLimitNotice, historyClient, readHistory };
}

function channelHeaders(cfg: SlackPluginConfig, core: SlackCoreClient, ids: BotIdentity, app: SlackApp) {
  const CORE_SINGLETON = cfg.coreSingleton !== false;
  const ensureHeader = createSurfaceHeaderEnsurer({
    headerFacts: (scope) => core.surfaceHeaderFacts(scope as Parameters<typeof core.surfaceHeaderFacts>[0]),
    channelPinEnabled: (scope) =>
      core.channelHeaderPinEnabled(scope as Parameters<typeof core.channelHeaderPinEnabled>[0]),
    webUiPublicUrl: cfg.webUiPublicUrl,
    ids,
  });
  const channelHeader = (channel: string, pinNew?: boolean) =>
    ensureHeader(
      app.client as unknown as SurfaceHeaderClient,
      channel,
      `channel:${channel}`,
      "channel",
      ...(pinNew ? [{ pinNew }] : []),
    );
  const scopeChannel = (scope: string) => (scope.startsWith("channel:") ? scope.slice("channel:".length) : "");
  if (CORE_SINGLETON) {
    core.onScopeModelChanged((scope) => {
      if (scopeChannel(scope)) channelHeader(scopeChannel(scope));
    });
    core.onChannelHeaderPinChanged((scope) => {
      if (scopeChannel(scope)) return void channelHeader(scopeChannel(scope), true);
      if (!scope.startsWith("org:")) return;
      void (async () => {
        for await (const res of app.client.paginate("conversations.list", {
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: 1000,
        }))
          for (const c of parseChannelPage(res)) if (c?.id && c.is_member) channelHeader(c.id, true);
      })().catch((err) => reportFailure("slack: channel header default sweep", err));
    });
  }
  return ensureHeader;
}

function sessionStatusSync(core: SlackCoreClient, conn: SlackConnection, ids: BotIdentity) {
  const { BOT_TOKEN, webClient } = conn;
  const statusClient = webClient(BOT_TOKEN, { timeout: 5_000, rejectRateLimitedCalls: true });
  const statusAccount = () => `${ids.ownTeamId}:${ids.botUserId}`;
  let statusSync: Promise<void> | undefined;
  const reconcileStatus = () => {
    statusSync ??= core.sessionStatus
      ?.reconcile(statusClient, statusAccount())
      .catch(swallowAs("slack: session status reconciliation", undefined))
      .finally(() => {
        statusSync = undefined;
      });
    return statusSync;
  };
  const statusHooks = {
    onEngaged: (runId: string, channel: string, threadTs?: string) => {
      void core.sessionStatus
        ?.start(statusClient, statusAccount(), runId, channel, threadTs)
        .catch(swallowAs("slack: session status start", undefined))
        .finally(() => {
          void reconcileStatus();
        });
    },
    onSettled: () => {
      void reconcileStatus();
    },
  };
  return { statusHooks, reconcileStatus: async () => reconcileStatus() };
}

async function connectAccount(
  cfg: SlackPluginConfig,
  app: SlackApp,
  ids: BotIdentity,
  directory: SlackDirectory,
  inFlightRuns: SlackFlow["inFlightRuns"],
  slackAccountClients: SlackCoreClient["slack"]["accounts"],
  ACCOUNT_LABEL: string,
): Promise<AuthTestResponse> {
  const auth = await app.client.auth.test();
  ids.ownTeamId = auth.team_id ?? "";
  ids.botUserId = auth.user_id ?? "";
  ids.ownBotId = auth.bot_id ?? "";
  ids.botHandle = typeof auth.user === "string" ? auth.user : "";
  ids.ownWorkspaceUrl = typeof auth.url === "string" ? auth.url.replace(/\/+$/, "") : "";
  if (!ids.ownTeamId || !ids.botUserId)
    throw new Error("auth.test returned no team_id/user_id — refusing to start (cannot classify members safely)");
  if (!cfg.identityEmail) {
    ids.identityMode = await directory.resolveAutoIdentityMode(app.client);
    if (ids.identityMode === "slack-id")
      console.warn(
        "[slack] no member emails visible (users:read.email scope missing?) — keying principals on Slack ids; add the scope or set SLACK_IDENTITY_EMAIL=1 to force email keying",
      );
  }
  await directory.getUserSnapshot(app.client);
  if (slackAccountClients.has(ACCOUNT_LABEL)) throw new Error(`Duplicate Slack account id: ${ACCOUNT_LABEL}`);
  slackAccountClients.set(ACCOUNT_LABEL, {
    client: app.client,
    inFlightRuns,
    teamId: ids.ownTeamId,
    ...(cfg.externalAccess ? { policy: cfg.externalAccess } : {}),
  });
  return auth;
}

function singletonUpkeep(core: SlackCoreClient, app: SlackApp): Partial<SlackUpkeep> {
  return {
    publishEmojiCatalog: () =>
      Promise.resolve(app.client.emoji.list())
        .then((res: { emoji?: Record<string, string> }) =>
          core.publishEmojiCatalog(
            Object.fromEntries(
              Object.entries(res.emoji ?? {}).filter(([, url]) => typeof url === "string" && !url.startsWith("alias:")),
            ),
          ),
        )
        .catch(swallowAs("slack: emoji catalog publish", undefined)),
    reconcileTaskAcks: async () =>
      core.taskAcknowledgements?.reconcile(app.client).catch(swallowAs("slack: task ack reconciliation", undefined)),
  };
}

async function startAccount(
  app: SlackApp,
  devIntrospection: ReturnType<typeof installDevIntrospection>,
  unwind: () => void,
  start: () => Promise<void>,
): Promise<void> {
  try {
    await start();
  } catch (err) {
    unwind();
    await devIntrospection?.close().catch(swallowAs("slack: dev-introspection close on failed start", undefined));
    try {
      await app.stop();
    } catch (cleanupError) {
      throw new SlackPluginStartCleanupError(err, cleanupError, async () => {
        await app.stop();
      });
    }
    throw err;
  }
}

function actorGate(cfg: SlackPluginConfig) {
  const configuredActorGate = createActorGate(cfg.allowFrom);
  const allowActor = cfg.externalAccess
    ? (actor: import("./identity.ts").ActorAssertion) =>
        !actor.isExternalGuest && !actor.isBot && (!configuredActorGate || configuredActorGate(actor))
    : configuredActorGate;
  return { allowActor, denyResponder: allowActor ? createDenyResponder(cfg.denyMessage) : undefined };
}

function slackSender(
  cfg: SlackPluginConfig,
  core: SlackCoreClient,
  app: SlackApp,
  flow: SlackFlow,
  threads: ReturnType<typeof createThreadTracker>,
  continuePrivate: (runId: string, task: string) => Promise<void>,
) {
  const slackAccountClients = core.slack.accounts;
  return createSlackSender({
    clientForAccount: (id, teamId) => {
      const account = slackAccountClients.get(id);
      if (!account || (teamId && account.teamId !== teamId)) return undefined;
      return account.client;
    },
    externalNamespace: (id) => {
      const account = slackAccountClients.get(id);
      return account?.policy ? externalSlackNamespace(account.teamId, account.policy) : undefined;
    },
    continuePrivate,
    core,
    flow,
    threads,
    webUiPublicUrl: cfg.webUiPublicUrl,
    defaultClient: app.client,
    runInFlight: (runId) =>
      flow.inFlightRuns.has(runId) || [...slackAccountClients.values()].some((a) => a.inFlightRuns?.has(runId)),
  });
}

function serveContextRequests(
  core: SlackCoreClient,
  app: SlackApp,
  deps: Omit<Parameters<typeof createSurfaceContextFulfiller>[0], "core">,
  isStopped: () => boolean,
): () => void {
  const surfaceContext = createSurfaceContextFulfiller({ ...deps, core });
  const contextRequestsInFlight = new Set<string>();
  const serviceContextRequest = (r: SurfaceContextRequest): void => {
    if (isStopped() || !r?.id || contextRequestsInFlight.has(r.id)) return;
    contextRequestsInFlight.add(r.id);
    void surfaceContext
      .fulfillSurfaceContext(app.client, r)
      .catch(swallowAs("slack: context request fulfillment", undefined))
      .finally(() => contextRequestsInFlight.delete(r.id));
  };
  const unsubscribe = core.onContextRequest(serviceContextRequest);
  void core
    .pendingContextRequests()
    .then((pending) => pending.forEach(serviceContextRequest))
    .catch(swallowAs("slack: context request drain", undefined));
  return unsubscribe;
}

function assembleSlackPlugin(cfg: SlackPluginConfig, core: SlackCoreClient) {
  const slackAccountClients = core.slack.accounts;
  const conn = slackConnection(cfg);
  const { BOT_TOKEN, TRUSTED_FILE_HOST, CLIENT_OPTIONS } = conn;
  const CORE_SINGLETON = cfg.coreSingleton !== false;
  const ACCOUNT_LABEL = cfg.accountId ?? "default";
  const { allowActor, denyResponder } = actorGate(cfg);

  const ids: BotIdentity = {
    ownTeamId: "",
    botUserId: "",
    ownBotId: "",
    botHandle: "",
    ownWorkspaceUrl: "",
    identityMode: cfg.identityEmail === "0" ? "slack-id" : "email",
  };
  const { ackEmojiOverride, externalParticipantsEnabled } = settingsCaches(cfg, core);
  const stagingAccount = cfg.installationId ? `${ACCOUNT_LABEL}:${cfg.installationId}` : ACCOUNT_LABEL;
  const { app, replayEnvelopes } = createSlackApp(cfg, core, conn, ids, stagingAccount);
  if (CORE_SINGLETON) setDefaultBotIdentity(cfg.botIdentity);
  const devIntrospection = installDevIntrospection(
    app,
    cfg.devIntrospection ? { enabled: true, port: cfg.devIntrospection.port } : {},
  );

  const deduper = createDeduper(1000, core.handledEvents);
  const threads = createThreadTracker();

  const flow = createTurnFlow(core);
  const ackEmoji = createAckEmojiPicker(core, { candidatesOverride: ackEmojiOverride });
  const directory = createDirectory({
    externalAccess: cfg.externalAccess,
    core,
    ids,
    coreSingleton: CORE_SINGLETON && !cfg.externalAccess,
  });
  const mirror = cfg.externalAccess
    ? { pushSurfaceEvents: async () => {}, mirrorMessageEvent: async () => {} }
    : createMirror({ core, ids, directory, externalParticipantsEnabled });
  const { historyRateLimitOptions, rateLimitNotice, historyClient, readHistory } = slackHistory(cfg, core, conn, ids);
  const serializer = createConversationSerializer({
    readHistory,
    historyRateLimitOptions,
    ids,
    directory,
    externalParticipantsEnabled,
  });
  const approvals = createApprovals({ core, flow, directory, threads, externalAccess: !!cfg.externalAccess });
  registerKeychainApprovalActions(app, { core, directory, webUiPublicUrl: cfg.webUiPublicUrl });
  registerDeployAccessActions(app, { core, directory });
  const ensureHeader = channelHeaders(cfg, core, ids, app);
  const { statusHooks, reconcileStatus } = sessionStatusSync(core, conn, ids);
  const continuePrivate = (runId: string, task: string) =>
    continueInPrivate(core, runId, task, (id) => slackAccountClients.get(id));
  const handler = createTurnHandler({
    accountId: ACCOUNT_LABEL,
    externalAccess: cfg.externalAccess,
    continuePrivate,
    ...statusHooks,
    rateLimitNotice,
    readHistory,
    core,
    flow,
    directory,
    mirror,
    serializer,
    ackEmoji,
    ackEmojiCandidates: ackEmojiOverride,
    ids,
    threads,
    deduper,
    externalParticipantsEnabled,
    allowActor,
    markEvent: devIntrospection ? () => devIntrospection.markEvent() : undefined,
    botToken: BOT_TOKEN,
    trustedFileHost: TRUSTED_FILE_HOST,
    ensureHeader,
  });
  approvals.registerActions(app);
  registerSlackEvents(app, {
    handler,
    mirror,
    directory,
    ids,
    deduper,
    allowActor,
    denyResponder,
    webUiPublicUrl: cfg.webUiPublicUrl || undefined,
    backfillHistory: (client: unknown, channel: string) => readHistory(client, channel),
    ensureHeader,
  });
  const sendToSlack = slackSender(cfg, core, app, flow, threads, continuePrivate);
  return {
    app,
    ids,
    directory,
    flow,
    replayEnvelopes,
    devIntrospection,
    ackEmoji,
    ackEmojiOverride,
    reconcileStatus,
    sendToSlack,
    ACCOUNT_LABEL,
    CORE_SINGLETON,
    contextDeps: {
      historyLimit: cfg.historyLimit,
      rateLimitNotice,
      historyClient,
      readHistory,
      historyRateLimitOptions,
      directory,
      serializer,
      botToken: BOT_TOKEN,
      trustedFileHost: TRUSTED_FILE_HOST,
      userToken: cfg.userToken,
      clientOptions: CLIENT_OPTIONS,
    },
  };
}

export async function startSlackPlugin(
  cfg: SlackPluginConfig,
  core: SlackCoreClient,
): Promise<{ stop(): Promise<void> }> {
  const plugin = assembleSlackPlugin(cfg, core);
  const slackAccountClients = core.slack.accounts;
  let stopped = false;
  const releaseAccount = (): void => {
    if (slackAccountClients.get(plugin.ACCOUNT_LABEL)?.client === plugin.app.client)
      slackAccountClients.delete(plugin.ACCOUNT_LABEL);
  };
  await startAccount(
    plugin.app,
    plugin.devIntrospection,
    () => {
      releaseAccount();
      stopped = true;
    },
    async () => {
      const auth = await connectAccount(
        cfg,
        plugin.app,
        plugin.ids,
        plugin.directory,
        plugin.flow.inFlightRuns,
        slackAccountClients,
        plugin.ACCOUNT_LABEL,
      );
      await plugin.app.start();
      plugin.devIntrospection?.ready({
        connectedAs: auth.user ?? "",
        botUserId: plugin.ids.botUserId,
        teamId: plugin.ids.ownTeamId,
      });
      console.log(
        `[slack-plugin] account ${plugin.ACCOUNT_LABEL} connected as @${auth.user} (bot ${plugin.ids.botUserId}) in team ${auth.team} (${plugin.ids.ownTeamId}); in-process core`,
      );
    },
  );

  plugin.ackEmoji.refreshAckEmoji(plugin.app.client);
  plugin.ackEmojiOverride();
  const upkeep: SlackUpkeep = {
    reconcileStatus: plugin.reconcileStatus,
    ...(plugin.replayEnvelopes ? { replayEnvelopes: plugin.replayEnvelopes } : {}),
    ...(plugin.CORE_SINGLETON ? singletonUpkeep(core, plugin.app) : {}),
  };
  void upkeep.reconcileStatus();
  void upkeep.publishEmojiCatalog?.();
  const detachUpkeep = core.upkeep.attach(upkeep);
  const unregisterSender = core.slack.attach(plugin.sendToSlack);
  const unsubscribeContextRequests = plugin.CORE_SINGLETON
    ? serveContextRequests(core, plugin.app, plugin.contextDeps, () => stopped)
    : () => {};
  return {
    async stop(): Promise<void> {
      if (stopped) {
        await plugin.app.stop();
        return;
      }
      stopped = true;
      releaseAccount();
      await detachUpkeep();
      unregisterSender();
      unsubscribeContextRequests();
      try {
        await plugin.app.stop();
      } finally {
        await plugin.devIntrospection?.close();
      }
    },
  };
}
