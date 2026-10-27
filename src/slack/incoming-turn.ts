import {
  externalSlackNamespace,
  extractPrivateContinuation,
  PRIVATE_CONTINUATION_INSTRUCTION,
  type ExternalSlackAccess,
} from "./external-access.ts";
import type { SlackRateLimitNotice } from "./rate-limit-notice.ts";
import type { SlackHistoryReader } from "./history.ts";
import { slackFailureText, type CoreTurnBody, type TurnFlow } from "./turn-flow.ts";
import { errMessage, reportFailure, swallowAs } from "../util/errors.ts";
import { type ActorAssertion, type ChannelMeta, groupDmDisplayName, isExternallyShared, isMpim } from "./identity.ts";
import { renderConversationView, resolveMentions } from "./conversation.ts";
import { REACTION_DETECT_GUIDANCE, REACTION_INSTRUCTION, resolveReactionTargets } from "./reactions.ts";
import {
  type AckPresenter,
  type GoalNoticeView,
  type GoalNoticePresenter,
  createGoalNoticePresenter,
  DEFAULT_ACK_REACTIONS,
  createAckPresenter,
} from "./presenters.ts";
import {
  type SlackFile,
  downloadSlackFile,
  hydrateSlackFiles,
  processInboundFiles,
  uploadAttachments,
  uploadFailureNote,
} from "./attachments.ts";
import {
  botIdentityArgs,
  deliveryCandidatesFor,
  statusPlaceholderKey,
  encodeDeliveryTarget,
  type createSurfaceHeaderEnsurer,
  type PostMessageArgs,
  postWithVerify,
  SLACK_POST_SPLIT_LIMIT,
  slackReplyArgs,
} from "./delivery.ts";
import {
  type Deduper,
  createThreadTracker,
  channelThreadRef,
  dmThreadRef,
  hasContent,
  isBareStop,
} from "./message-gating.ts";
import { decodeSlackEntities, toSlackMrkdwn } from "./mrkdwn.ts";
import { postThenAckRunDelivery, refusalDelivery, refusalNote } from "./refusals.ts";
import { safeChunks } from "./safe-cut.ts";
import type { GatewayContext, TurnResult } from "../types.ts";
import type { AckGate } from "./deferred-ack.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { BotIdentity, Directory } from "./directory.ts";
import type { Mirror } from "./mirror.ts";
import { type ConversationSerializer } from "./conversation-view.ts";
import type { AckEmojiPicker } from "./ack-emoji.ts";
import {
  type SlackConversationKind,
  applyAndLogReactions,
  HANDOFF_INSTRUCTION,
  cleanAgentReplyForSlack,
  conversationPlaceLabel,
} from "./messaging.ts";

export interface Incoming {
  kind: "dm" | "channel";
  channel: string;
  userId: string | undefined;
  actor?: ActorAssertion;
  authorName?: string;
  botId?: string;
  rawText: string;
  subtype?: string;
  files: SlackFile[];
  threadTs?: string;
  ts: string;
  unprompted?: boolean;
  botAuthored?: boolean;
  synthetic?: boolean;
  ackGate?: AckGate;
  prefetched?: {
    actor: ActorAssertion;
    timezone?: string;
    info: ChannelMeta | undefined;
    audience: ActorAssertion[];
    publishMembers?: ActorAssertion[];
    slackIdsByPrincipal?: Map<string, string>;
  };
}

export interface TurnHandlerDeps {
  accountId?: string;
  externalAccess?: ExternalSlackAccess;
  continuePrivate?: (runId: string, task: string) => Promise<void>;
  rateLimitNotice?: SlackRateLimitNotice;
  onEngaged?: (runId: string, channel: string, threadTs?: string) => void;
  onSettled?: () => void;
  core: SlackCoreClient;
  flow: TurnFlow;
  directory: Directory;
  mirror: Mirror;
  readHistory: SlackHistoryReader;
  serializer: ConversationSerializer;
  ackEmoji: AckEmojiPicker;
  ackEmojiCandidates?: () => readonly string[] | null;
  ids: BotIdentity;
  threads: ReturnType<typeof createThreadTracker>;
  deduper: Deduper;
  externalParticipantsEnabled(): Promise<boolean>;
  allowActor?: (actor: ActorAssertion) => boolean;
  markEvent?: () => void;
  botToken: string;
  trustedFileHost?: string;
  ensureHeader?: ReturnType<typeof createSurfaceHeaderEnsurer>;
}

export const compact = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };

type SlackConversation = Awaited<ReturnType<typeof resolveConversation>>;

interface IncomingTurn {
  deps: TurnHandlerDeps;
  inc: Incoming;
  client: any;
  actor: ActorAssertion;
  conv: SlackConversation;
  run: { queuedRunId: string | undefined; accepted: boolean };
  replies: ReturnType<typeof slackReplier>;
  acks: ReturnType<typeof turnAcks>;
}

export async function handleIncoming(deps: TurnHandlerDeps, inc: Incoming, client: any): Promise<void> {
  const { core, ids, threads } = deps;
  const { classifyUserCached } = deps.directory;
  deps.markEvent?.();
  const { actor, timezone } = inc.actor
    ? { actor: inc.actor, timezone: undefined }
    : (inc.prefetched ?? (await classifyUserCached(client, inc.userId)));
  if (deps.externalAccess && (actor.isExternalGuest || actor.isBot || !inc.userId || inc.synthetic)) return;
  if (deps.externalAccess && inc.unprompted) inc = { ...inc, unprompted: false };
  if (deps.allowActor && !deps.allowActor(actor)) return;
  const text = resolveMentions(
    decodeSlackEntities(inc.rawText).trim(),
    ids.botUserId && ids.botHandle ? new Map([[ids.botUserId, ids.botHandle]]) : undefined,
  );
  if (!hasContent(text, inc.files)) return;
  const conv = await resolveConversation(deps, inc, client, actor);
  const { audience, threadRef, replyThreadTs } = conv;
  const replies = slackReplier(inc, client, replyThreadTs);
  const gatewayContext = slackGatewayContext(deps, inc, conv);
  if (audience.some((a) => a.isExternalGuest) && !(await deps.externalParticipantsEnabled())) {
    if (!inc.unprompted)
      await replies.ephemeralOrSay(
        "I can't respond here — this conversation isn't fully internal. Try a DM or a fully-internal channel.",
      );
    return;
  }
  const run = { queuedRunId: undefined as string | undefined, accepted: false };
  const acks = turnAcks(deps, inc, client, text, actor, run, replies.postReply);
  if (
    !inc.unprompted &&
    isBareStop(text, ids.botHandle) &&
    (await core.stopConversation(threadRef).catch(swallowAs("slack: abort signal", true)))
  )
    return;
  acks.begin();
  const t: IncomingTurn = { deps, inc, client, actor, conv, run, replies, acks };
  if (!inc.synthetic) await mirrorIncoming(t);
  if (inc.kind === "channel" && replyThreadTs) threads.mark(inc.channel, replyThreadTs, true);
  const rendered = inc.kind === "channel" || inc.threadTs ? await renderIncoming(t) : undefined;
  const allowedTs = rendered?.allowedTs ?? new Set<string>();

  const ownFiles = inc.files.map((f) => (f.user || !inc.userId ? f : { ...f, user: inc.userId }));
  const inboundFiles = await hydrateSlackFiles(ownFiles, async (id) => {
    const response = await client.files.info({ file: id });
    return response?.file as SlackFile | undefined;
  });
  const { attachments, issues } = await processInboundFiles(
    inboundFiles,
    (f) => downloadSlackFile(f, compact({ token: deps.botToken, trustedHost: deps.trustedFileHost || undefined })),
    (source) => core.stageBlob(source),
    async (userId) => (userId ? (await classifyUserCached(client, userId)).actor.displayName : undefined),
  );

  if (inc.unprompted && !text.trim() && attachments.length === 0) return;
  const turn = coreTurnBody(t, { text, timezone, gatewayContext, rendered, attachments, issues });
  const result = await runCoreTurn(t, turn);
  if (result) await deliverTurnResult(t, result, allowedTs);
}

async function resolveConversation(deps: TurnHandlerDeps, inc: Incoming, client: any, actor: ActorAssertion) {
  const { ids } = deps;
  const { getChannelInfo, channelMembership } = deps.directory;
  let audience: ActorAssertion[] = [actor];
  let channelRef: string | undefined;
  let channelName: string | undefined;
  let threadRef: string;
  let replyThreadTs: string | undefined;
  let isPrivate: boolean | undefined;
  let isMpimChannel: boolean | undefined;
  let publishMembers: ActorAssertion[] | undefined;
  let slackIdsByPrincipal: Map<string, string> | undefined;
  let conversationKind: SlackConversationKind = inc.kind;
  const headerable = !actor.isBot && !actor.isExternalGuest;

  if (inc.kind === "dm") {
    threadRef = dmThreadRef(inc.channel, inc.threadTs);
    if (deps.externalAccess) threadRef = `slack-account:${ids.ownTeamId}:${threadRef}`;
    replyThreadTs = inc.threadTs;
    if (headerable) deps.ensureHeader?.(client, inc.channel, `personal:${actor.externalId}`, "dm");
  } else {
    channelRef = inc.channel;
    const channelObservedAt = Date.now();
    const info = inc.prefetched ? inc.prefetched.info : await getChannelInfo(client, inc.channel);
    isPrivate = info?.is_private;
    isMpimChannel = isMpim(info);
    if (isMpimChannel) conversationKind = "group";
    channelName = info?.name;
    if (!isMpimChannel && !isExternallyShared(info) && headerable)
      deps.ensureHeader?.(client, inc.channel, `channel:${inc.channel}`, "channel");
    const root = inc.threadTs ?? inc.ts;
    threadRef = channelThreadRef(conversationKind, inc.channel, root);
    replyThreadTs = root;
    const membership =
      inc.prefetched ?? (await channelMembership(client, inc.channel, actor, inc.userId, info, channelObservedAt));
    audience = membership.audience;
    publishMembers = membership.publishMembers;
    slackIdsByPrincipal = membership.slackIdsByPrincipal;
    if (conversationKind === "group") channelName = groupDmDisplayName(audience) ?? channelName;
    if (deps.externalAccess) {
      const namespace = externalSlackNamespace(ids.ownTeamId, deps.externalAccess);
      threadRef = `${namespace}:${threadRef}`;
      channelRef = `${namespace}:${inc.channel}`;
      publishMembers = undefined;
      audience = [...audience, { externalId: "slack-external", isExternalGuest: true }];
    }
  }
  return {
    audience,
    channelRef,
    channelName,
    threadRef,
    replyThreadTs,
    isPrivate,
    isMpimChannel,
    publishMembers,
    slackIdsByPrincipal,
    conversationKind,
  };
}

function slackReplier(inc: Incoming, client: any, replyThreadTs: string | undefined) {
  const postReply = async (
    msg: string,
    blocks?: Array<Record<string, unknown>>,
    idempotencyKey?: string,
  ): Promise<string | undefined> => {
    const replyArgs = (text: string, withBlocks: boolean): Record<string, unknown> => ({
      ...slackReplyArgs(inc.channel, text, replyThreadTs, { threadOnly: inc.kind === "channel", unfurlLinks: false }),
      ...(withBlocks && blocks ? { blocks } : {}),
    });
    if (idempotencyKey)
      return (await postWithVerify(client, replyArgs(msg, true) as PostMessageArgs, idempotencyKey)).ts;
    const parts = blocks ? [msg] : safeChunks(msg, SLACK_POST_SPLIT_LIMIT);
    let firstTs: string | undefined;
    for (const [i, part] of parts.entries()) {
      const ts = (await client.chat.postMessage(replyArgs(part, parts.length === 1))).ts as string | undefined;
      if (i === 0) firstTs = ts;
    }
    return firstTs;
  };

  const ephemeralOrSay = async (msg: string): Promise<void> => {
    if (inc.kind === "dm") return void (await postReply(msg));
    await client.chat
      .postEphemeral({ channel: inc.channel, user: inc.userId, text: msg })
      .catch(swallowAs("slack: chat.postEphemeral", undefined));
  };
  return { postReply, ephemeralOrSay };
}

function slackGatewayContext(deps: TurnHandlerDeps, inc: Incoming, conv: SlackConversation): GatewayContext {
  const { ids } = deps;
  const { channelName, conversationKind, replyThreadTs } = conv;
  const channelLocation = () => {
    if (conversationKind === "group") return "a group direct message";
    return channelName ? `#${channelName}` : `channel ${inc.channel}`;
  };
  const channelInstructions = deps.externalAccess
    ? PRIVATE_CONTINUATION_INSTRUCTION
    : `${REACTION_INSTRUCTION}\n\n${HANDOFF_INSTRUCTION}`;
  return compact({
    location: inc.kind === "dm" ? "a direct message with the user" : channelLocation(),
    details:
      inc.kind === "dm"
        ? compact({ channel: inc.channel, thread_ts: inc.threadTs || undefined })
        : compact({
            channel: inc.channel,
            channel_name: channelName ? conversationPlaceLabel(conversationKind, channelName, inc.channel) : undefined,
            thread_ts: replyThreadTs || undefined,
          }),
    instructions: inc.kind === "dm" ? REACTION_INSTRUCTION : channelInstructions,
    reactionGuidance: REACTION_DETECT_GUIDANCE,
    botHandle: ids.botHandle || undefined,
  });
}

function turnAcks(
  deps: TurnHandlerDeps,
  inc: Incoming,
  client: any,
  text: string,
  actor: ActorAssertion,
  run: IncomingTurn["run"],
  postReply: ReturnType<typeof slackReplier>["postReply"],
) {
  const { core, ackEmoji } = deps;
  const taskManaged = !inc.unprompted && !actor.isBot && inc.kind === "dm" && !!core.taskAcknowledgements;
  const pickAckEmoji = () =>
    ackEmoji.requestAckEmoji(text, ackEmoji.ackPickCandidates(client), { channel: inc.channel, ts: inc.ts });
  const moveTaskAck = async (runId: string, ts: string, pick = false) => {
    if (!taskManaged) return;
    await core
      .taskAcknowledgements!.move(client, runId, inc.channel, ts, pick ? pickAckEmoji : undefined)
      .catch(swallowAs("slack: task ack move", undefined));
  };
  const finishTaskAck = async () => {
    if (taskManaged && run.queuedRunId) await core.taskAcknowledgements!.finish(client, run.queuedRunId);
  };
  let ack: AckPresenter | undefined;
  const startAck = (): AckPresenter =>
    (ack ??= createAckPresenter({
      taskManaged,
      postAck: async (text) => {
        const ts = await postReply(
          toSlackMrkdwn(text),
          undefined,
          run.queuedRunId ? statusPlaceholderKey(run.queuedRunId) : undefined,
        );
        if (!ts || !run.queuedRunId || inc.unprompted) return;
        try {
          await core.reportRunEditRef(run.queuedRunId, ts);
        } catch (error) {
          await client.chat
            .delete({ channel: inc.channel, ts })
            .catch(swallowAs("slack: delete status message after edit-ref failure", undefined));
          throw error;
        }
      },
      addReaction: (name) => client.reactions.add({ channel: inc.channel, timestamp: inc.ts, name }).then(() => {}),
      removeReaction: (name) =>
        client.reactions.remove({ channel: inc.channel, timestamp: inc.ts, name }).then(() => {}),
      emojiCandidates: ((override) => [...(override?.length ? override : DEFAULT_ACK_REACTIONS)])(
        deps.ackEmojiCandidates?.(),
      ),
      emojiPick: taskManaged ? undefined : pickAckEmoji(),
    }));
  const acknowledges = !inc.unprompted || !inc.synthetic;
  let goalNotice: GoalNoticePresenter | undefined;
  const begin = () => {
    if (!inc.unprompted) {
      startAck();
      goalNotice = createGoalNoticePresenter({
        post: (text, blocks) => postReply(text, blocks),
        update: (ts, text, blocks) =>
          client.chat.update({ channel: inc.channel, ts, text, blocks, ...botIdentityArgs() }).then(() => {}),
        onError: (error) => console.error("[slack-plugin] goal notice update failed:", (error as Error).message),
      });
    }
  };
  const settleAck = async (): Promise<void> => {
    await ack?.settle().catch(swallowAs("slack: ack settle", undefined));
  };
  return {
    get ack() {
      return ack;
    },
    get goalNotice() {
      return goalNotice;
    },
    startAck,
    acknowledges,
    moveTaskAck,
    finishTaskAck,
    begin,
    settleAck,
  };
}

async function mirrorIncoming({ deps, inc, client, actor, conv }: IncomingTurn): Promise<void> {
  const { mirrorMessageEvent } = deps.mirror;
  const { channelName, conversationKind } = conv;
  const containerName = inc.kind === "dm" ? actor.displayName?.trim() || undefined : channelName;
  await mirrorMessageEvent(
    {
      channel: inc.channel,
      ts: inc.ts,
      text: inc.rawText,
      subtype: inc.subtype,
      files: inc.files,
      user: inc.userId,
      bot_id: inc.botId,
      username: inc.authorName,
      ...(inc.botAuthored ? { bot_profile: { name: inc.authorName } } : {}),
      thread_ts: inc.threadTs,
      channel_type: inc.kind === "dm" ? "im" : { group: "mpim", dm: "channel", channel: "channel" }[conversationKind],
    },
    client,
    compact({ partial: true, kind: conversationKind, handled: true, containerName: containerName || undefined }),
  );
}

async function renderIncoming({ deps, inc, client, actor, conv }: IncomingTurn) {
  const { serializer } = deps;
  const { audience, channelName, isPrivate, conversationKind, slackIdsByPrincipal, replyThreadTs } = conv;
  const serialize = () =>
    serializer.serializeSlackConversation(
      client,
      inc,
      compact({
        audience,
        channelName: channelName || undefined,
        isPrivate,
        kind: conversationKind,
        slackIdsByPrincipal,
      }),
    );
  const serialized = deps.rateLimitNotice
    ? await deps.rateLimitNotice.run(
        client,
        !inc.unprompted && !inc.synthetic && !actor.isBot && inc.userId
          ? { target: encodeDeliveryTarget(inc.channel, replyThreadTs), user: inc.userId }
          : undefined,
        serialize,
      )
    : await serialize();
  return renderConversationView(serialized.view);
}
function coreTurnBody(
  { deps, inc, actor, conv }: IncomingTurn,
  input: {
    text: string;
    timezone: string | undefined;
    gatewayContext: GatewayContext;
    rendered: ReturnType<typeof renderConversationView> | undefined;
    attachments: Awaited<ReturnType<typeof processInboundFiles>>["attachments"];
    issues: Awaited<ReturnType<typeof processInboundFiles>>["issues"];
  },
): Omit<CoreTurnBody, "approval"> {
  const { ids } = deps;
  const { text, timezone, gatewayContext, rendered, attachments, issues } = input;
  const { conversationKind, threadRef, channelRef, channelName, audience, replyThreadTs } = conv;
  const { isPrivate, isMpimChannel, publishMembers } = conv;
  const policyNamespace = deps.externalAccess ? externalSlackNamespace(ids.ownTeamId, deps.externalAccess) : undefined;
  return compact({
    actor,
    source: inc.userId
      ? compact({
          account: deps.accountId ?? "default",
          workspaceId: ids.ownTeamId,
          userId: inc.userId,
          policyNamespace,
          replyThread: replyThreadTs || undefined,
        })
      : undefined,
    externalSlack:
      deps.externalAccess && inc.kind === "channel" && inc.userId
        ? {
            accountId: deps.accountId ?? "default",
            teamId: ids.ownTeamId,
            userId: inc.userId,
            ...deps.externalAccess,
          }
        : undefined,
    conversation: compact({
      kind: conversationKind,
      threadRef,
      channelRef: channelRef || undefined,
      channelName: channelName || undefined,
      audience,
      isPrivate,
      isMpim: isMpimChannel,
      publishMembers,
    }),
    deliveryTarget: encodeDeliveryTarget(inc.channel, replyThreadTs),
    deliveryCandidates: deliveryCandidatesFor(conversationKind, inc.channel, replyThreadTs, channelName) || undefined,
    text,
    gatewayContext,
    origin: inc.unprompted
      ? compact({
          kind: "ambient" as const,
          entryTs: inc.synthetic ? undefined : inc.ts,
          live: inc.synthetic || actor.isBot || inc.botAuthored ? undefined : true,
        })
      : { kind: "human", messageTs: inc.ts },
    botActor: actor.isBot ? true : undefined,
    conversationHeader: rendered?.header || undefined,
    priorTurns: rendered?.priorTurns.length ? rendered.priorTurns : undefined,
    overheard: rendered?.overheard.length ? rendered.overheard : undefined,
    detectContext: rendered?.detectContext || undefined,
    detectOpener: rendered?.detectOpener || undefined,
    attachments: attachments.length ? attachments : undefined,
    inboundNotes: issues.length ? issues : undefined,
    timezone: timezone || undefined,
    redeliveryKey: inc.ts && !inc.synthetic ? `slack:${ids.botUserId || "bot"}:${inc.channel}:${inc.ts}` : undefined,
  });
}

async function runCoreTurn(
  { deps, inc, conv, run, acks, replies }: IncomingTurn,
  turn: Omit<CoreTurnBody, "approval">,
): Promise<TurnResult | undefined> {
  const { callCore } = deps.flow;
  const { replyThreadTs } = conv;
  const { postReply, ephemeralOrSay } = replies;
  let result: TurnResult;
  try {
    result = await callCore(
      turn,
      compact({
        deferDeliveryAck: true,
        onReplying: inc.synthetic
          ? undefined
          : () => {
              if (acks.acknowledges) acks.startAck();
              if (run.queuedRunId && replyThreadTs) deps.onEngaged?.(run.queuedRunId, inc.channel, replyThreadTs);
            },
        onQueued: async (runId: string) => {
          run.queuedRunId = runId;
          run.accepted = true;
          inc.ackGate?.persisted();
          await acks.moveTaskAck(runId, inc.ts, true);
        },
        onSteered: async (runId: string) => {
          run.accepted = true;
          inc.ackGate?.persisted();
          await acks.moveTaskAck(runId, inc.ts);
        },
        onFirstBlock: acks.acknowledges
          ? (blockText: string) =>
              acks.startAck().onFirstBlock(extractPrivateContinuation(cleanAgentReplyForSlack(blockText).text).text)
          : undefined,
        onSurfacePosted: acks.acknowledges ? () => acks.startAck().onSurfacePosted() : undefined,
        onGoal: acks.goalNotice
          ? (goal: GoalNoticeView) => {
              void acks.goalNotice?.onGoal(goal);
            }
          : undefined,
      }),
    );
    await acks.goalNotice?.settle();
  } catch (err) {
    await acks.settleAck();
    if (inc.unprompted) {
      if (!run.accepted) inc.ackGate?.failed(errMessage(err));
      reportFailure("slack: unprompted turn (staying quiet)", err, `ch=${inc.channel} ts=${inc.ts}`);
    } else {
      console.error(`[slack-plugin] turn errored ch=${inc.channel} ts=${inc.ts}: ${errMessage(err)}`);
      const note = `⚠️ ${slackFailureText(err)}`;
      if (acks.ack?.postedAck()) await postReply(note);
      else await ephemeralOrSay(note);
    }
    return undefined;
  } finally {
    if (run.queuedRunId) deps.onSettled?.();
  }
  return result;
}

async function deliverTurnResult(
  { deps, inc, client, conv, run, acks, replies }: IncomingTurn,
  result: TurnResult,
  allowedTs: Set<string>,
): Promise<void> {
  const { core, threads } = deps;
  const { inFlightRuns, ackRunDelivery } = deps.flow;
  const { replyThreadTs } = conv;
  const { postReply, ephemeralOrSay } = replies;
  const runKey = run.queuedRunId ? `run:${run.queuedRunId}` : undefined;
  const postThenAck = async (post: () => Promise<void>): Promise<void> => {
    const runId = run.queuedRunId;
    if (!runId) return post();
    await postThenAckRunDelivery({
      post,
      ack: () => ackRunDelivery(runId),
      release: () => inFlightRuns.delete(runId),
    });
  };

  if (result.status === "ok") {
    const continuation = extractPrivateContinuation(result.reply ?? "");
    if (continuation.task && deps.externalAccess && inc.kind === "channel" && run.queuedRunId && deps.continuePrivate) {
      await deps.continuePrivate(run.queuedRunId, continuation.task);
      ackRunDelivery(run.queuedRunId);
      await acks.settleAck();
      return acks.finishTaskAck();
    }
    if (inc.kind === "channel" && replyThreadTs) threads.mark(inc.channel, replyThreadTs, true);
    const { text: replyBody, reactions } = cleanAgentReplyForSlack(result.reply ?? "");
    const hasNonText = !!(result.attachments?.length || reactions.length || result.pendingApprovals?.length);
    let reply = result.stopped ? "Stopped." : "(no response)";
    if (replyBody) reply = toSlackMrkdwn(replyBody);
    else if (hasNonText) reply = "";
    try {
      await postThenAck(async () => {
        let uploadError: unknown;
        if (result.attachments?.length) {
          try {
            await uploadAttachments(client, inc.channel, replyThreadTs, result.attachments, core);
          } catch (err) {
            uploadError = err;
            reportFailure("slack: reply file upload", err);
          }
        }
        await acks.ack?.drain();
        if (reply) await postReply(reply, undefined, runKey);
        if (uploadError) await postReply(uploadFailureNote(uploadError));
        const { directives, dropped } = resolveReactionTargets(reactions, allowedTs);
        if (dropped) console.error(`[slack-plugin] dropped ${dropped} reaction(s) with an unresolvable message id`);
        await applyAndLogReactions(client, inc.channel, inc.ts, directives);
        await acks.settleAck();
        await acks.finishTaskAck();
      });
    } catch (err) {
      await acks.settleAck();
      if (!run.queuedRunId) throw err;
      console.error(
        `[slack-plugin] reply post failed after run ${run.queuedRunId} finished (ch=${inc.channel} ts=${inc.ts}): ${(err as Error).message} — leaving delivery run:${run.queuedRunId} for the recovery poller`,
      );
    }
    return;
  }

  await acks.settleAck();
  if (result.steered) return;
  if (result.status === "silent") {
    if (inc.unprompted) console.error(`[slack-plugin] turn.silent (no reply) ch=${inc.channel} ts=${inc.ts}`);
  } else if (result.status === "react") {
    const names = result.reactions ?? [];
    if (names.length) await applyAndLogReactions(client, inc.channel, inc.ts, [{ names }]);
    console.error(`[slack-plugin] turn.react (acknowledged) ch=${inc.channel} ts=${inc.ts} emoji=${names.join(",")}`);
  } else if (result.status === "pending_approval") {
    if (!result.pendingApprovals?.length) {
      const note = result.reason ?? "This conversation is waiting on a pending approval.";
      if (inc.unprompted)
        console.error(`[slack-plugin] turn.pending_approval (no card) ch=${inc.channel} ts=${inc.ts}: ${note}`);
      else if (acks.ack?.postedAck()) await postReply(note);
      else await ephemeralOrSay(note);
    }
  } else {
    const delivery = refusalDelivery(result, inc.unprompted === true);
    if (delivery === "silent") {
      await acks.finishTaskAck();
      if (run.queuedRunId && result.refusalKind === "security_quarantine") inFlightRuns.delete(run.queuedRunId);
      console.error(
        `[slack-plugin] unprompted turn ${result.status} (staying quiet) ch=${inc.channel} ts=${inc.ts}: ${result.reason ?? "refused"}`,
      );
      return;
    }
    await postThenAck(async () => {
      const note = refusalNote(result, inc.kind);
      if (delivery === "thread" || inc.kind === "dm" || acks.ack?.postedAck()) await postReply(note, undefined, runKey);
      else await ephemeralOrSay(note);
      await acks.finishTaskAck();
    });
  }
}
