import { swallow, errMessage, reportFailure, reportFailureAs } from "../util/errors.ts";
import { decodeSlackEntities } from "./mrkdwn.ts";
import { buildReactionTurnText, shouldSurfaceReaction } from "./reactions.ts";
import { dedupeKey, dedupedRun, threadHasBotStake } from "./message-gating.ts";
import { reactionTallies } from "./conversation-view.ts";
import type { SlackReactionEvent } from "./payloads.ts";
import { compact, handleIncoming, type Incoming, type TurnHandlerDeps } from "./incoming-turn.ts";

export type TurnHandler = ReturnType<typeof createTurnHandler>;

export function createTurnHandler(deps: TurnHandlerDeps) {
  const reactionsInFlight = new Set<string>();
  return {
    handleIncoming: (inc: Incoming, client: any) => handleIncoming(deps, inc, client),
    dispatch: (key: string, inc: Incoming, client: any) => dispatch(deps, key, inc, client),
    handleReactionEvent: (evt: SlackReactionEvent, eventId: string | undefined, client: any, added: boolean) =>
      handleReactionEvent(deps, reactionsInFlight, evt, eventId, client, added),
    botHasStakeInThread: (client: any, channel: string, threadTs: string, before?: string) =>
      botHasStakeInThread(deps, client, channel, threadTs, before),
  };
}

async function botHasStakeInThread(
  deps: TurnHandlerDeps,
  client: any,
  channel: string,
  threadTs: string,
  before?: string,
): Promise<boolean> {
  const { threads, ids } = deps;
  const cached = threads.get(channel, threadTs);
  if (cached !== undefined) return cached;
  try {
    const messages = (await deps.readHistory(client, channel, threadTs, before)).raw;
    const present = threadHasBotStake(messages, ids.botUserId, ids.ownBotId);
    threads.mark(channel, threadTs, present);
    return present;
  } catch (err) {
    swallow("slack: thread stake history read", err);
    return false;
  }
}

async function dispatch(deps: TurnHandlerDeps, key: string, inc: Incoming, client: any): Promise<void> {
  const { deduper } = deps;
  const gate = inc.ackGate;
  const stamped: Incoming = gate
    ? {
        ...inc,
        ackGate: {
          persisted: () => gate.persisted(),
          failed: (reason?: string) => {
            deduper.forget(key);
            gate.failed(reason);
          },
        },
      }
    : inc;
  const ran = await dedupedRun(
    deduper,
    key,
    () => handleIncoming(deps, stamped, client),
    (err) => {
      stamped.ackGate?.failed(errMessage(err));
      reportFailure("slack: incoming handler", err);
    },
  );
  if (!ran) gate?.failed("already in flight on this instance");
}

async function getReactedMessage(client: any, channel: string, ts: string, full: boolean) {
  try {
    const res = await client.reactions.get({ channel, timestamp: ts, full });
    const m = res?.message;
    if (!m) return undefined;
    return compact({
      text: decodeSlackEntities(String(m.text ?? "").trim()),
      threadTs: m.thread_ts && m.thread_ts !== ts ? String(m.thread_ts) : undefined,
      reactions: reactionTallies(m.reactions),
      authorId: m.user ? String(m.user) : undefined,
    });
  } catch (err) {
    swallow("slack: reacted message lookup", err);
    return undefined;
  }
}

async function handleReactionEvent(
  deps: TurnHandlerDeps,
  reactionsInFlight: Set<string>,
  evt: SlackReactionEvent,
  eventId: string | undefined,
  client: any,
  added: boolean,
): Promise<void> {
  const { ids, threads, deduper, externalParticipantsEnabled } = deps;
  const { classifyUserCached, classifyActor, getChannelInfo, channelMembership } = deps.directory;
  const reactorId = evt.user;
  const channel = evt.item?.channel;
  const messageTs = evt.item?.ts;
  const emoji = evt.reaction;
  if (!reactorId || !channel || !messageTs || !emoji) return;

  const isDM = channel.startsWith("D");
  const onBotMessage = Boolean(ids.botUserId && evt.item_user === ids.botUserId);
  const onFollowedRoot = threads.get(channel, messageTs) === true;
  if (
    !shouldSurfaceReaction({
      itemType: evt.item?.type,
      reactorId,
      botUserId: ids.botUserId,
      isDM,
      onBotMessage,
      onFollowedRoot,
    })
  ) {
    return;
  }

  const sign = added ? "+" : "-";
  const flightKey = `${channel}:${messageTs}:${emoji}:${reactorId}:${sign}`;
  if (reactionsInFlight.has(flightKey)) return;
  reactionsInFlight.add(flightKey);
  try {
    const key = dedupeKey({
      event_id: eventId,
      channel,
      ts: `${messageTs}:${emoji}:${sign}:${reactorId}:${evt.event_ts ?? ""}`,
    });
    await dedupedRun(
      deduper,
      key,
      async () => {
        const reactorUser = await classifyUserCached(client, reactorId);
        const reactor = reactorUser.actor;
        if (reactor.isExternalGuest) return;
        if (deps.allowActor && !deps.allowActor(reactor)) return;
        let prefetched: Incoming["prefetched"];
        if (!isDM) {
          const observedAt = Date.now();
          const info = await getChannelInfo(client, channel);
          const membership = await channelMembership(client, channel, reactor, reactorId, info, observedAt);
          if (membership.audience.some((a) => a.isExternalGuest) && !(await externalParticipantsEnabled())) return;
          prefetched = compact({
            actor: reactor,
            timezone: reactorUser.timezone || undefined,
            info,
            audience: membership.audience,
            publishMembers: membership.publishMembers || undefined,
            slackIdsByPrincipal: membership.slackIdsByPrincipal || undefined,
          });
        }
        const reactorName = reactor.displayName || "Someone";

        const msg = await getReactedMessage(client, channel, messageTs, added);
        const authorName =
          !onBotMessage && msg?.authorId && msg.authorId !== reactorId
            ? (await classifyActor(client, msg.authorId)).displayName
            : undefined;

        const inc: Incoming = compact({
          kind: isDM ? "dm" : "channel",
          channel,
          userId: reactorId,
          rawText: buildReactionTurnText(
            compact({
              reactorName,
              emoji,
              added,
              onBotMessage,
              authorName: authorName || undefined,
              messageText: msg?.text || undefined,
              reactions: msg?.reactions?.length ? msg.reactions : undefined,
            }),
          ),
          files: [],
          threadTs: msg?.threadTs || undefined,
          ts: messageTs,
          unprompted: true,
          synthetic: true,
          prefetched,
        });
        let heardWhere = onBotMessage ? "on my message" : "followed thread";
        if (isDM) heardWhere = "dm";
        console.log(`[slack-plugin] heard reaction ${sign}:${emoji}: from ${reactorName} (${heardWhere}) → turn`);
        await handleIncoming(deps, inc, client);
      },
      reportFailureAs("slack: reaction handler", undefined),
    );
  } finally {
    reactionsInFlight.delete(flightKey);
  }
}
