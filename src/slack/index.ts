import { continueInPrivate } from "./private-continuation.ts";
import { externalSlackNamespace } from "./external-access.ts";
import { registerKeychainApprovalActions } from "./keychain-approvals.ts";
import { registerDeployAccessActions } from "./deploy-access.ts";
import { SlackPluginStartCleanupError } from "../surfaces/slack-runtime.ts";
import { createSlackRateLimitNotice } from "./rate-limit-notice.ts";
import { createSlackHistoryReader } from "./history.ts";
import { reportFailure, swallow, swallowAs } from "../util/errors.ts";
import { createEnvelopeStaging } from "./envelope-staging.ts";
import { createSweeper } from "../util/sweeper.ts";
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
import type { SlackCoreClient, SurfaceContextRequest } from "../api/slack-core-client.ts";
import type { AuthTestResponse } from "@slack/web-api";
const { App } = bolt;
const HANDLED_EVENT_TTL_MS = 24 * 60 * 60_000;

export type { SlackCoreClient };
export type { SlackPluginConfig };
export { normalizeSlackApiUrl, slackAccountConfigsFromEnv, slackPluginConfigFromEnv };

export async function startSlackPlugin(
  cfg: SlackPluginConfig,
  core: SlackCoreClient,
): Promise<{ stop(): Promise<void> }> {
  const slackAccountClients = core.slack.accounts;
  const EVENTS_MODE = cfg.eventsMode ?? "socket";
  if (!cfg.botToken) throw new Error("Slack plugin needs botToken (SLACK_BOT_TOKEN, xoxb-…)");
  if (!cfg.receiverFactory && EVENTS_MODE === "socket" && !cfg.appToken)
    throw new Error("Slack plugin needs appToken (SLACK_APP_TOKEN, xapp-…) in socket events mode");
  if (!cfg.receiverFactory && EVENTS_MODE === "http" && !cfg.signingSecret)
    throw new Error("Slack plugin needs signingSecret (SLACK_SIGNING_SECRET) in http events mode");
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
  let stopped = false;
  const CORE_SINGLETON = cfg.coreSingleton !== false;
  const ACCOUNT_LABEL = cfg.accountId ?? "default";
  const configuredActorGate = createActorGate(cfg.allowFrom);
  const allowActor = cfg.externalAccess
    ? (actor: import("./identity.ts").ActorAssertion) =>
        !actor.isExternalGuest && !actor.isBot && (!configuredActorGate || configuredActorGate(actor))
    : configuredActorGate;
  const denyResponder = allowActor ? createDenyResponder(cfg.denyMessage) : undefined;

  const ids: BotIdentity = {
    ownTeamId: "",
    botUserId: "",
    ownBotId: "",
    botHandle: "",
    ownWorkspaceUrl: "",
    identityMode: cfg.identityEmail === "0" ? "slack-id" : "email",
  };

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

  const stagingAccount = cfg.installationId ? `${ACCOUNT_LABEL}:${cfg.installationId}` : ACCOUNT_LABEL;
  const staging = core.stagedEnvelopes
    ? createEnvelopeStaging(core.stagedEnvelopes, { account: stagingAccount })
    : undefined;
  const receiver = () => {
    if (cfg.receiverFactory) return cfg.receiverFactory(staging);
    return EVENTS_MODE === "http"
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
  const replaySweeper = staging
    ? createSweeper(
        () =>
          core.holdEnvelopeReplay(stagingAccount, () =>
            staging.sweep((body, ackGate) =>
              app.processEvent({
                body,
                ack: async () => {},
                retryNum: 99,
                customProperties: { ackGate },
              }),
            ),
          ),
        60_000,
        { label: "slack envelope replay" },
      )
    : undefined;
  if (CORE_SINGLETON) setDefaultBotIdentity(cfg.botIdentity);
  const devIntrospection = installDevIntrospection(
    app,
    cfg.devIntrospection ? { enabled: true, port: cfg.devIntrospection.port } : {},
  );

  const deduper = createDeduper(1000, core.handledEvents);
  const handledPrune = core.handledEvents
    ? createSweeper(() => core.handledEvents!.deleteBelow("at", Date.now() - HANDLED_EVENT_TTL_MS), 60 * 60_000, {
        label: "slack handled events",
      })
    : undefined;
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
  const historyRateLimitOptions = {
    managed: Boolean(cfg.installationId && cfg.sharedServiceUrl?.trim()),
    ...(cfg.webUiPublicUrl
      ? { setupUrl: `${cfg.webUiPublicUrl.replace(/\/$/, "")}/settings/slack-settings?setup=slack` }
      : {}),
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
  const statusSweep = createSweeper(reconcileStatus, 60_000, { label: "slack session status", immediate: true });
  const continuePrivate = (runId: string, task: string) =>
    continueInPrivate(core, runId, task, (id) => slackAccountClients.get(id));
  const handler = createTurnHandler({
    accountId: ACCOUNT_LABEL,
    externalAccess: cfg.externalAccess,
    continuePrivate,
    onEngaged: (runId, channel, threadTs) => {
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
    inboxMessage: cfg.externalAccess
      ? undefined
      : (client, msg) =>
          void (async () => {
            const actor = msg.senderSlackId
              ? await directory
                  .classifyActor(client, msg.senderSlackId)
                  .catch(swallowAs("slack: classify inbox message sender", undefined))
              : undefined;
            await core.inboxSlackMessage({
              channel: msg.channel,
              ts: msg.ts,
              isDirectMessage: msg.isDirectMessage,
              threadTs: msg.threadTs,
              text: msg.text,
              senderEmail: actor?.externalId.includes("@") ? actor.externalId : undefined,
            });
          })().catch((e) => swallow("slack: forward message to inbox", e)),
    allowActor,
    denyResponder,
    webUiPublicUrl: cfg.webUiPublicUrl || undefined,
    backfillHistory: (client: unknown, channel: string) => readHistory(client, channel),
    ensureHeader,
  });
  const surfaceContext = createSurfaceContextFulfiller({
    historyLimit: cfg.historyLimit,
    rateLimitNotice,
    historyClient,
    readHistory,
    historyRateLimitOptions,
    core,
    directory,
    serializer,
    botToken: BOT_TOKEN,
    trustedFileHost: TRUSTED_FILE_HOST,
    userToken: cfg.userToken,
    clientOptions: CLIENT_OPTIONS,
  });
  const sendToSlack = createSlackSender({
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

  const releaseAccount = (): void => {
    if (slackAccountClients.get(ACCOUNT_LABEL)?.client === app.client) slackAccountClients.delete(ACCOUNT_LABEL);
  };
  let auth: AuthTestResponse;
  try {
    auth = await app.client.auth.test();
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
      inFlightRuns: flow.inFlightRuns,
      teamId: ids.ownTeamId,
      ...(cfg.externalAccess ? { policy: cfg.externalAccess } : {}),
    });
    await app.start();
    replaySweeper?.start();
    handledPrune?.start();
  } catch (err) {
    releaseAccount();
    stopped = true;
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
  devIntrospection?.ready({ connectedAs: auth.user ?? "", botUserId: ids.botUserId, teamId: ids.ownTeamId });
  console.log(
    `[slack-plugin] account ${ACCOUNT_LABEL} connected as @${auth.user} (bot ${ids.botUserId}) in team ${auth.team} (${ids.ownTeamId}); in-process core`,
  );

  ackEmoji.refreshAckEmoji(app.client);
  ackEmojiOverride();

  const emojiCatalogSweep = createSweeper(
    () =>
      Promise.resolve(app.client.emoji.list())
        .then((res: { emoji?: Record<string, string> }) =>
          core.publishEmojiCatalog(
            Object.fromEntries(
              Object.entries(res.emoji ?? {}).filter(([, url]) => typeof url === "string" && !url.startsWith("alias:")),
            ),
          ),
        )
        .catch(swallowAs("slack: emoji catalog publish", undefined)),
    6 * 60 * 60_000,
    { label: "slack emoji catalog", immediate: true },
  );
  if (CORE_SINGLETON) emojiCatalogSweep.start();

  statusSweep.start();
  const unregisterSender = core.slack.attach(sendToSlack);
  const taskAckSweep = createSweeper(
    () =>
      core.taskAcknowledgements?.reconcile(app.client).catch(swallowAs("slack: task ack reconciliation", undefined)),
    60_000,
    { label: "slack task ack reconciliation" },
  );
  if (CORE_SINGLETON) taskAckSweep.start();

  const contextRequestsInFlight = new Set<string>();

  const serviceContextRequest = (r: SurfaceContextRequest): void => {
    if (stopped || !r?.id || contextRequestsInFlight.has(r.id)) return;
    contextRequestsInFlight.add(r.id);
    void surfaceContext
      .fulfillSurfaceContext(app.client, r)
      .catch(swallowAs("slack: context request fulfillment", undefined))
      .finally(() => contextRequestsInFlight.delete(r.id));
  };
  const unsubscribeContextRequests = CORE_SINGLETON ? core.onContextRequest(serviceContextRequest) : () => {};
  if (CORE_SINGLETON)
    void core
      .pendingContextRequests()
      .then((pending) => pending.forEach(serviceContextRequest))
      .catch(swallowAs("slack: context request drain", undefined));

  return {
    async stop(): Promise<void> {
      if (stopped) {
        await replaySweeper?.stop();
        await handledPrune?.stop();
        await app.stop();
        return;
      }
      stopped = true;
      releaseAccount();
      await statusSweep.stop();
      await replaySweeper?.stop();
      await emojiCatalogSweep.stop();
      await taskAckSweep.stop();
      await handledPrune?.stop();
      unregisterSender();
      unsubscribeContextRequests();
      try {
        await app.stop();
      } finally {
        await devIntrospection?.close();
      }
    },
  };
}
