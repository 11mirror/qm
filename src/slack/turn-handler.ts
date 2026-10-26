import {
  externalSlackNamespace,
  extractPrivateContinuation,
  PRIVATE_CONTINUATION_INSTRUCTION,
  type ExternalSlackAccess,
} from "./external-access.ts";
import type { SlackRateLimitNotice } from "./rate-limit-notice.ts";
import type { SlackHistoryReader } from "./history.ts";
import { slackFailureText, type CoreTurnBody, type TurnFlow } from "./turn-flow.ts";
import { errMessage, reportFailure, reportFailureAs, swallow, swallowAs } from "../util/errors.ts";
import { type ActorAssertion, type ChannelMeta, groupDmDisplayName, isExternallyShared, isMpim } from "./identity.ts";
import { renderConversationView, resolveMentions } from "./conversation.ts";
import {
  REACTION_DETECT_GUIDANCE,
  REACTION_INSTRUCTION,
  buildReactionTurnText,
  resolveReactionTargets,
  shouldSurfaceReaction,
} from "./reactions.ts";
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
  dedupeKey,
  dedupedRun,
  channelThreadRef,
  dmThreadRef,
  hasContent,
  isBareStop,
  threadHasBotStake,
} from "./message-gating.ts";
import { decodeSlackEntities, toSlackMrkdwn } from "./mrkdwn.ts";
import { postThenAckRunDelivery, refusalDelivery, refusalNote } from "./refusals.ts";
import { safeChunks } from "./safe-cut.ts";
import type { GatewayContext, TurnResult } from "../types.ts";
import type { AckGate } from "./deferred-ack.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { BotIdentity, Directory } from "./directory.ts";
import type { Mirror } from "./mirror.ts";
import { reactionTallies, type ConversationSerializer } from "./conversation-view.ts";
import type { SlackReactionEvent } from "./payloads.ts";
import type { AckEmojiPicker } from "./ack-emoji.ts";
import {
  type SlackConversationKind,
  applyAndLogReactions,
  HANDOFF_INSTRUCTION,
  cleanAgentReplyForSlack,
  conversationPlaceLabel,
} from "./messaging.ts";

interface Incoming {
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

export type TurnHandler = ReturnType<typeof createTurnHandler>;

const compact = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };

export function createTurnHandler(deps: {
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
}) {
  const { core, flow, directory, mirror, serializer, ackEmoji, ids, threads, deduper, externalParticipantsEnabled } =
    deps;
  const { classifyUserCached, classifyActor, getChannelInfo, channelMembership } = directory;
  const { mirrorMessageEvent } = mirror;
  const { callCore, inFlightRuns, ackRunDelivery } = flow;

  const reactionsInFlight = new Set<string>();

  async function botHasStakeInThread(
    client: any,
    channel: string,
    threadTs: string,
    before?: string,
  ): Promise<boolean> {
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

  async function handleIncoming(inc: Incoming, client: any): Promise<void> {
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
    let queuedRunId: string | undefined;
    let accepted = false;
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

    const channelLocation = () => {
      if (conversationKind === "group") return "a group direct message";
      return channelName ? `#${channelName}` : `channel ${inc.channel}`;
    };
    const channelInstructions = deps.externalAccess
      ? PRIVATE_CONTINUATION_INSTRUCTION
      : `${REACTION_INSTRUCTION}\n\n${HANDOFF_INSTRUCTION}`;
    const gatewayContext: GatewayContext = compact({
      location: inc.kind === "dm" ? "a direct message with the user" : channelLocation(),
      details:
        inc.kind === "dm"
          ? compact({ channel: inc.channel, thread_ts: inc.threadTs || undefined })
          : compact({
              channel: inc.channel,
              channel_name: channelName
                ? conversationPlaceLabel(conversationKind, channelName, inc.channel)
                : undefined,
              thread_ts: replyThreadTs || undefined,
            }),
      instructions: inc.kind === "dm" ? REACTION_INSTRUCTION : channelInstructions,
      reactionGuidance: REACTION_DETECT_GUIDANCE,
      botHandle: ids.botHandle || undefined,
    });

    if (audience.some((a) => a.isExternalGuest) && !(await externalParticipantsEnabled())) {
      if (!inc.unprompted)
        await ephemeralOrSay(
          "I can't respond here — this conversation isn't fully internal. Try a DM or a fully-internal channel.",
        );
      return;
    }

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
      if (taskManaged && queuedRunId) await core.taskAcknowledgements!.finish(client, queuedRunId);
    };
    if (
      !inc.unprompted &&
      isBareStop(text, ids.botHandle) &&
      (await core.stopConversation(threadRef).catch(swallowAs("slack: abort signal", true)))
    )
      return;

    let ack: AckPresenter | undefined;
    const startAck = (): AckPresenter =>
      (ack ??= createAckPresenter({
        taskManaged,
        postAck: async (text) => {
          const ts = await postReply(
            toSlackMrkdwn(text),
            undefined,
            queuedRunId ? statusPlaceholderKey(queuedRunId) : undefined,
          );
          if (!ts || !queuedRunId || inc.unprompted) return;
          try {
            await core.reportRunEditRef(queuedRunId, ts);
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
    if (!inc.unprompted) {
      startAck();
      goalNotice = createGoalNoticePresenter({
        post: (text, blocks) => postReply(text, blocks),
        update: (ts, text, blocks) =>
          client.chat.update({ channel: inc.channel, ts, text, blocks, ...botIdentityArgs() }).then(() => {}),
        onError: (error) => console.error("[slack-plugin] goal notice update failed:", (error as Error).message),
      });
    }
    const settleAck = async (): Promise<void> => {
      await ack?.settle().catch(swallowAs("slack: ack settle", undefined));
    };

    if (!inc.synthetic) {
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
          channel_type:
            inc.kind === "dm" ? "im" : { group: "mpim", dm: "channel", channel: "channel" }[conversationKind],
        },
        client,
        compact({ partial: true, kind: conversationKind, handled: true, containerName: containerName || undefined }),
      );
    }

    if (inc.kind === "channel" && replyThreadTs) threads.mark(inc.channel, replyThreadTs, true);

    let rendered: ReturnType<typeof renderConversationView> | undefined;
    if (inc.kind === "channel" || inc.threadTs) {
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
      rendered = renderConversationView(serialized.view);
    }
    const allowedTs = rendered?.allowedTs ?? new Set<string>();

    const ownFiles = inc.files.map((f) => (f.user || !inc.userId ? f : { ...f, user: inc.userId }));
    const inboundFiles = await hydrateSlackFiles(ownFiles, async (id) => {
      const response = await client.files.info({ file: id });
      return response?.file as SlackFile | undefined;
    });
    const { attachments, issues } = await processInboundFiles(
      inboundFiles,
      (f) => downloadSlackFile(f, compact({ token: deps.botToken, trustedHost: deps.trustedFileHost || undefined })),
      (bytes) => core.stageBlob(bytes),
      async (userId) => (userId ? (await classifyUserCached(client, userId)).actor.displayName : undefined),
    );

    if (inc.unprompted && !text.trim() && attachments.length === 0) return;

    const policyNamespace = deps.externalAccess
      ? externalSlackNamespace(ids.ownTeamId, deps.externalAccess)
      : undefined;
    const turn: Omit<CoreTurnBody, "approval"> = compact({
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
      ...(inc.unprompted
        ? {
            unprompted: true,
            entryTs: inc.synthetic ? undefined : inc.ts,
            liveActor: inc.synthetic || actor.isBot || inc.botAuthored ? undefined : true,
          }
        : { liveActor: true, triggerTs: inc.ts }),
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
    let result: TurnResult;
    try {
      result = await callCore(
        turn,
        compact({
          deferDeliveryAck: true,
          onReplying: inc.synthetic
            ? undefined
            : () => {
                if (acknowledges) startAck();
                if (queuedRunId && replyThreadTs) deps.onEngaged?.(queuedRunId, inc.channel, replyThreadTs);
              },
          onQueued: async (runId: string) => {
            queuedRunId = runId;
            accepted = true;
            inc.ackGate?.persisted();
            await moveTaskAck(runId, inc.ts, true);
          },
          onSteered: async (runId: string) => {
            accepted = true;
            inc.ackGate?.persisted();
            await moveTaskAck(runId, inc.ts);
          },
          onFirstBlock: acknowledges
            ? (blockText: string) =>
                startAck().onFirstBlock(extractPrivateContinuation(cleanAgentReplyForSlack(blockText).text).text)
            : undefined,
          onSurfacePosted: acknowledges ? () => startAck().onSurfacePosted() : undefined,
          onGoal: goalNotice
            ? (goal: GoalNoticeView) => {
                void goalNotice?.onGoal(goal);
              }
            : undefined,
        }),
      );
      await goalNotice?.settle();
    } catch (err) {
      await settleAck();
      if (inc.unprompted) {
        if (!accepted) inc.ackGate?.failed(errMessage(err));
        console.error(
          `[slack-plugin] unprompted turn errored (staying quiet) ch=${inc.channel} ts=${inc.ts}: ${(err as Error).message}`,
        );
      } else {
        console.error(`[slack-plugin] turn errored ch=${inc.channel} ts=${inc.ts}: ${errMessage(err)}`);
        const note = `⚠️ ${slackFailureText(err)}`;
        if (ack?.postedAck()) await postReply(note);
        else await ephemeralOrSay(note);
      }
      return;
    } finally {
      if (queuedRunId) deps.onSettled?.();
    }

    const runKey = queuedRunId ? `run:${queuedRunId}` : undefined;
    const postThenAck = async (post: () => Promise<void>): Promise<void> => {
      const runId = queuedRunId;
      if (!runId) return post();
      await postThenAckRunDelivery({
        post,
        ack: () => ackRunDelivery(runId),
        release: () => inFlightRuns.delete(runId),
      });
    };

    if (result.status === "ok") {
      const continuation = extractPrivateContinuation(result.reply ?? "");
      if (continuation.task && deps.externalAccess && inc.kind === "channel" && queuedRunId && deps.continuePrivate) {
        await deps.continuePrivate(queuedRunId, continuation.task);
        ackRunDelivery(queuedRunId);
        await settleAck();
        return finishTaskAck();
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
              console.error("[slack-plugin] file upload failed:", (err as Error).message);
            }
          }
          await ack?.drain();
          if (reply) await postReply(reply, undefined, runKey);
          if (uploadError) await postReply(uploadFailureNote(uploadError));
          const { directives, dropped } = resolveReactionTargets(reactions, allowedTs);
          if (dropped) console.error(`[slack-plugin] dropped ${dropped} reaction(s) with an unresolvable message id`);
          await applyAndLogReactions(client, inc.channel, inc.ts, directives);
          await settleAck();
          await finishTaskAck();
        });
      } catch (err) {
        await settleAck();
        if (!queuedRunId) throw err;
        console.error(
          `[slack-plugin] reply post failed after run ${queuedRunId} finished (ch=${inc.channel} ts=${inc.ts}): ${(err as Error).message} — leaving delivery run:${queuedRunId} for the recovery poller`,
        );
      }
      return;
    }

    await settleAck();
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
        else if (ack?.postedAck()) await postReply(note);
        else await ephemeralOrSay(note);
      }
    } else {
      const delivery = refusalDelivery(result, inc.unprompted === true);
      if (delivery === "silent") {
        await finishTaskAck();
        if (queuedRunId && result.refusalKind === "security_quarantine") inFlightRuns.delete(queuedRunId);
        console.error(
          `[slack-plugin] unprompted turn ${result.status} (staying quiet) ch=${inc.channel} ts=${inc.ts}: ${result.reason ?? "refused"}`,
        );
        return;
      }
      await postThenAck(async () => {
        const note = refusalNote(result, inc.kind);
        if (delivery === "thread" || inc.kind === "dm" || ack?.postedAck()) await postReply(note, undefined, runKey);
        else await ephemeralOrSay(note);
        await finishTaskAck();
      });
    }
    await finishTaskAck();
  }

  async function dispatch(key: string, inc: Incoming, client: any): Promise<void> {
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
      () => handleIncoming(stamped, client),
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
    evt: SlackReactionEvent,
    eventId: string | undefined,
    client: any,
    added: boolean,
  ): Promise<void> {
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
          await handleIncoming(inc, client);
        },
        reportFailureAs("slack: reaction handler", undefined),
      );
    } finally {
      reactionsInFlight.delete(flightKey);
    }
  }

  return { handleIncoming, dispatch, handleReactionEvent, botHasStakeInThread };
}
