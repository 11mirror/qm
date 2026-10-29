import {
  channelPrivacyChange,
  type Deduper,
  dedupeKey,
  dedupedRun,
  isGroupMembershipMessage,
  isOwnStatusCard,
  isThreadReply,
  mentionsBot,
  shouldMirrorMessage,
  shouldProcessMessage,
} from "./message-gating.ts";
import { onBotJoinedChannel, type SurfaceHeaderClient } from "./delivery.ts";
import {
  parseEventId,
  parseLifecycleEvent,
  parseMessageEvent,
  parseReactionEvent,
  type SlackMessageEvent,
} from "./payloads.ts";
import type { AckGate } from "./deferred-ack.ts";
import { messageWithForwardedContent } from "./forwards.ts";
import type { BotIdentity, Directory } from "./directory.ts";
import type { ActorAssertion } from "./identity.ts";
import type { DenyResponder } from "./allow-from.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import type { Mirror } from "./mirror.ts";
import type { TurnHandler } from "./turn-handler.ts";

interface EventArgs {
  event: unknown;
  message: unknown;
  body: unknown;
  client: any;
  context: { ackGate?: AckGate };
}

type EventIdentity = { userId: string; actor?: { externalId: string; isBot: true; displayName?: string } };

type SlackEventDeps = {
  handler: TurnHandler;
  mirror: Mirror;
  directory: Directory;
  ids: BotIdentity;
  deduper: Deduper;
  allowActor?: (actor: ActorAssertion) => boolean;
  denyResponder?: DenyResponder;
  webUiPublicUrl?: string;
  backfillHistory?: (client: unknown, channel: string) => Promise<unknown>;
  ensureHeader?: (
    client: SurfaceHeaderClient,
    channel: string,
    scopeId: string,
    kind: "dm" | "channel",
    ensureOpts?: { pinNew?: boolean },
  ) => void;
};

type SlackEventContext = ReturnType<typeof slackEventContext>;

function slackEventContext(deps: SlackEventDeps) {
  const { handler, mirror, directory, ids, deduper, allowActor, denyResponder } = deps;
  const { dispatch, handleReactionEvent, botHasStakeInThread } = handler;
  const { mirrorMessageEvent, pushSurfaceEvents } = mirror;
  const { syncForUnseenGroup, forceDirectorySync } = directory;
  const ownMessage = (event: { user?: string; bot_id?: string }): boolean =>
    Boolean((ids.botUserId && event.user === ids.botUserId) || (ids.ownBotId && event.bot_id === ids.ownBotId));
  const actorAllowed = async (client: any, userId: string | undefined): Promise<boolean> => {
    if (!allowActor) return true;
    if (!userId) return false;
    if (userId === ids.botUserId) return true;
    const { actor, ok } = await directory.classifyUserCached(client, userId);
    if (ok === false) throw new Error("Slack event actor lookup unavailable");
    return allowActor(actor);
  };
  const denyDirectApproach = async (
    client: any,
    opts: { channel: string; userId?: string; kind: "dm" | "channel"; threadTs?: string; isBot?: boolean },
  ): Promise<void> => {
    if (!denyResponder || !opts.userId || opts.isBot) return;
    if (!denyResponder.shouldSend(`${opts.channel}:${opts.userId}`)) return;
    const text = denyResponder.message;
    await (
      opts.kind === "channel"
        ? client.chat.postEphemeral({ channel: opts.channel, user: opts.userId, text })
        : client.chat.postMessage({
            channel: opts.channel,
            text,
            ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
          })
    ).catch(swallowAs(opts.kind === "channel" ? "slack: deny ephemeral" : "slack: deny reply", undefined));
  };
  const eventIdentity = async (client: any, event: { user?: string; bot_id?: string }): Promise<EventIdentity> => {
    if (event.user) return { userId: event.user };
    if (!event.bot_id) return { userId: "" };
    try {
      const bot = (await client.bots.info({ bot: event.bot_id })).bot;
      if (bot?.user_id) return { userId: String(bot.user_id) };
      if (bot?.id === event.bot_id && bot.deleted !== true) {
        return {
          userId: event.bot_id,
          actor: { externalId: event.bot_id, isBot: true, ...(bot.name ? { displayName: String(bot.name) } : {}) },
        };
      }
    } catch (err) {
      swallow("slack: bots.info", err);
      return { userId: event.bot_id };
    }
    return { userId: event.bot_id };
  };
  const dispatchMessage = async (
    client: any,
    m: SlackMessageEvent,
    opts: { kind: "dm" | "channel"; eventId?: string; ackGate?: AckGate; identity?: EventIdentity; unprompted?: true },
  ): Promise<void> => {
    const key = dedupeKey({ event_id: opts.eventId, client_msg_id: m.client_msg_id, channel: m.channel, ts: m.ts });
    const identity = opts.identity ?? (await eventIdentity(client, m));
    const content = messageWithForwardedContent(m);
    await dispatch(
      key,
      {
        kind: opts.kind,
        channel: m.channel,
        userId: identity.userId,
        ...(identity.actor ? { actor: identity.actor } : {}),
        ...(m.bot_id ? { botId: m.bot_id } : {}),
        ...(m.bot_profile?.name || m.username ? { authorName: String(m.bot_profile?.name || m.username) } : {}),
        rawText: content.text,
        subtype: m.subtype ?? "",
        files: content.files,
        threadTs: m.thread_ts,
        ts: m.ts,
        ...(opts.unprompted ? { unprompted: true } : {}),
        ...(m.bot_id || m.subtype === "bot_message" ? { botAuthored: true } : {}),
        ackGate: opts.ackGate,
      },
      client,
    );
  };

  return {
    deps,
    ids,
    deduper,
    directory,
    allowActor,
    handleReactionEvent,
    botHasStakeInThread,
    mirrorMessageEvent,
    pushSurfaceEvents,
    syncForUnseenGroup,
    forceDirectorySync,
    ownMessage,
    actorAllowed,
    denyDirectApproach,
    eventIdentity,
    dispatchMessage,
  };
}

function onAppMention(ctx: SlackEventContext) {
  const { ids, deduper, allowActor, actorAllowed, denyDirectApproach, eventIdentity, dispatchMessage } = ctx;
  return async ({ event, body, client, context }: EventArgs) => {
    try {
      const e = parseMessageEvent(event);
      if (!shouldProcessMessage(e, ids.botUserId, ids.ownBotId)) return;
      const identity = await eventIdentity(client, e);
      if (allowActor && !(await actorAllowed(client, identity.userId))) {
        const key = dedupeKey({ event_id: parseEventId(body), channel: e.channel, ts: e.ts });
        if (await deduper.seen(key)) return;
        await denyDirectApproach(client, {
          channel: e.channel,
          userId: identity.userId,
          kind: "channel",
          isBot: Boolean(e.bot_id || identity.actor?.isBot),
        });
        await deduper.done(key);
        return;
      }
      await dispatchMessage(client, e, {
        kind: "channel",
        eventId: parseEventId(body),
        ackGate: context.ackGate,
        identity,
      });
    } catch (error) {
      context.ackGate?.failed("Slack mention processing failed");
      throw error;
    }
  };
}

function onMessage(ctx: SlackEventContext) {
  const {
    ids,
    directory,
    botHasStakeInThread,
    mirrorMessageEvent,
    pushSurfaceEvents,
    syncForUnseenGroup,
    forceDirectorySync,
    ownMessage,
    actorAllowed,
    denyDirectApproach,
    dispatchMessage,
  } = ctx;
  return async ({ message, body, client, context }: EventArgs) => {
    try {
      const m = parseMessageEvent(message);
      if (isOwnStatusCard(m.message ?? m.previous_message ?? m, ids.botUserId, ids.ownBotId)) return;
      if (
        m.channel &&
        !m.channel_type &&
        (shouldMirrorMessage(m) || m.subtype === "message_changed" || m.subtype === "message_deleted")
      ) {
        const info = await directory.getChannelInfo(client, m.channel);
        if (!info) throw new Error("Slack message channel lookup unavailable");
        if (info.is_im) m.channel_type = "im";
        else if (info.is_mpim) m.channel_type = "mpim";
        else m.channel_type = info.is_private ? "group" : "channel";
      }
      const eventId = parseEventId(body);
      const privacyChange = channelPrivacyChange(m);
      if (privacyChange) await forceDirectorySync(client, privacyChange.channel);
      if (isGroupMembershipMessage(m)) await forceDirectorySync(client);
      const { ackGate } = context;
      const dm = m.channel_type === "im" ? { kind: "dm" as const } : {};
      if (m.subtype === "message_changed" && m.message?.subtype === "tombstone" && m.message.ts && m.channel) {
        await pushSurfaceEvents([{ container: m.channel, ts: m.message.ts, deleted: true }]);
        return;
      }
      const author = ownMessage(m.message ?? m.previous_message ?? m)
        ? ids.botUserId
        : (m.user ?? m.message?.user ?? m.previous_message?.user);
      if (!(await actorAllowed(client, author))) {
        if (m.channel_type === "im" && shouldProcessMessage(m, ids.botUserId, ids.ownBotId)) {
          await denyDirectApproach(client, {
            channel: m.channel,
            userId: m.user,
            kind: "dm",
            threadTs: m.thread_ts,
            isBot: Boolean(m.bot_id || m.subtype === "bot_message"),
          });
        }
        return;
      }
      if (m.subtype === "message_changed" && m.message) {
        const textChanged = m.previous_message?.text === undefined || m.previous_message.text !== m.message.text;
        const editedAt = Number(m.message.edited?.ts) || (textChanged ? Number(m.ts) : 0);
        if (shouldMirrorMessage(m.message))
          await mirrorMessageEvent({ ...m.message, channel: m.channel, channel_type: m.channel_type }, client, {
            partial: true,
            ...(!shouldProcessMessage(m.message, "", "") ? { handled: true } : {}),
            ...(editedAt > 0 ? { editedAt: Math.round(editedAt * 1000) } : {}),
            ...dm,
          });
        return;
      }
      if (m.subtype === "message_deleted" && m.deleted_ts) {
        const prev = m.previous_message;
        if (m.channel && ["channel", "group", "mpim", "im"].includes(m.channel_type ?? ""))
          await pushSurfaceEvents([
            {
              container: m.channel,
              ts: m.deleted_ts,
              deleted: true,
              ...(prev?.thread_ts && prev.thread_ts !== m.deleted_ts ? { sub: prev.thread_ts } : {}),
              ...(prev && ownMessage(prev) ? { self: true } : {}),
            },
          ]);
        return;
      }
      if (!shouldMirrorMessage(m)) return;
      if (ownMessage(m) || !shouldProcessMessage(m, ids.botUserId, ids.ownBotId)) {
        await mirrorMessageEvent(m, client, { handled: true, ...dm });
        return;
      }
      if (m.channel_type === "im") {
        await dispatchMessage(client, m, { kind: "dm", eventId, ackGate });
        return;
      }
      if (m.channel_type !== "channel" && m.channel_type !== "group" && m.channel_type !== "mpim") return;
      if (m.channel_type === "mpim" && m.channel) syncForUnseenGroup(client, m.channel);
      const threadReply = isThreadReply(m);
      const isMention = mentionsBot(m.text ?? "", ids.botUserId);
      const willDispatch = Boolean(
        threadReply && !isMention && m.thread_ts && (await botHasStakeInThread(client, m.channel, m.thread_ts, m.ts)),
      );
      await mirrorMessageEvent(m, client, willDispatch ? { handled: true } : {});
      if (!threadReply || isMention) return;
      if (!willDispatch) {
        console.error(
          `[slack-plugin] thread-follow skipped: no bot stake detected in thread ch=${m.channel} thread_ts=${m.thread_ts} ts=${m.ts}`,
        );
        return;
      }
      await dispatchMessage(client, m, { kind: "channel", eventId, ackGate, unprompted: true });
    } catch (error) {
      context.ackGate?.failed("Slack message processing failed");
      throw error;
    }
  };
}

function registerLifecycle(
  app: { event(name: string, handler: (args: any) => Promise<void>): void },
  ctx: SlackEventContext,
): void {
  const { deps, ids, deduper, directory, allowActor, handleReactionEvent, forceDirectorySync } = ctx;
  const lifecycle = (name: string, run: (client: any, e: ReturnType<typeof parseLifecycleEvent>) => Promise<void>) =>
    app.event(name, async ({ event, body, client }: EventArgs) => {
      const e = parseLifecycleEvent(event);
      await dedupedRun(
        deduper,
        dedupeKey({ event_id: parseEventId(body), channel: e.channel, ts: e.eventTs }),
        () => run(client, e),
        (error) => {
          throw error;
        },
      );
    });

  lifecycle("member_joined_channel", async (client, e) => {
    if (e.user !== ids.botUserId) return forceDirectorySync(client, e.channel);
    if (e.channel && deps.backfillHistory)
      await deps.backfillHistory(client, e.channel).catch(swallowAs("slack: backfill history on bot join", undefined));
    if (allowActor) return forceDirectorySync(client);
    await onBotJoinedChannel({
      client,
      channel: e.channel,
      joinerUserId: e.user,
      botUserId: ids.botUserId,
      webUiPublicUrl: deps.webUiPublicUrl,
      syncDirectory: () => forceDirectorySync(client),
      ...(deps.ensureHeader
        ? {
            ensureHeader: (channel: string) =>
              deps.ensureHeader!(client as SurfaceHeaderClient, channel, `channel:${channel}`, "channel", {
                pinNew: true,
              }),
          }
        : {}),
    });
  });
  for (const evt of ["channel_created", "channel_rename", "channel_unarchive"])
    lifecycle(evt, (client, e) => forceDirectorySync(client, e.channel));
  lifecycle("member_left_channel", async (client, e) => {
    const principalId = e.user ? (await directory.classifyUserCached(client, e.user)).actor.externalId : undefined;
    await forceDirectorySync(client, e.channel, principalId);
  });

  for (const evt of ["assistant_thread_started", "assistant_thread_context_changed"]) app.event(evt, async () => {});

  for (const [evt, added] of [
    ["reaction_added", true],
    ["reaction_removed", false],
  ] as const) {
    app.event(evt, async ({ event, body, client }: EventArgs) => {
      const reaction = parseReactionEvent(event);
      if (reaction.user === ids.botUserId) return;
      await handleReactionEvent(reaction, parseEventId(body), client, added);
    });
  }
}

export function registerSlackEvents(
  app: {
    event(name: string, handler: (args: any) => Promise<void>): void;
    message(handler: (args: any) => Promise<void>): void;
  },
  deps: SlackEventDeps,
): void {
  const ctx = slackEventContext(deps);
  app.event("app_mention", onAppMention(ctx));
  app.message(onMessage(ctx));
  registerLifecycle(app, ctx);
}
