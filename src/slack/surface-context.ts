import type { SlackRateLimitNotice } from "./rate-limit-notice.ts";
import { SHARED_SLACK_HISTORY_LIMIT, slackHistoryRateLimitMessage } from "./rate-limit-notice.ts";
import type { SlackHistoryReader } from "./history.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import { WebClient } from "@slack/web-api";
import { type RecentMessage, buildContextWindow } from "./conversation.ts";
import {
  type SlackFile,
  downloadSlackFile,
  fileReadIssue,
  isOversize,
  oversizeMsg,
  slackFileName,
} from "./attachments.ts";
import { messageWithForwardedContent } from "./forwards.ts";
import { isExternallyShared } from "./identity.ts";
import { openConversationFor, parseDeliveryTarget } from "./delivery.ts";
import { SLACK_AUTH_ERRORS, type SlackHistoryMessage, parseMessageList, slackErrorCode } from "./payloads.ts";
import type { SlackCoreClient, SurfaceContextRequest } from "../api/slack-core-client.ts";
import type { Directory } from "./directory.ts";
import { type ConversationSerializer, RECENT_THREAD_LIMIT } from "./conversation-view.ts";

type ContextDeps = {
  rateLimitNotice?: SlackRateLimitNotice;
  core: SlackCoreClient;
  directory: Directory;
  serializer: ConversationSerializer;
  botToken: string;
  trustedFileHost?: string;
  userToken?: string;
  clientOptions: Record<string, unknown>;
  readHistory: SlackHistoryReader;
  historyClient?: any;
  historyLimit?: number;
  historyRateLimitOptions?: { managed?: boolean; setupUrl?: string };
};

async function fulfillLiveSearch(
  deps: ContextDeps,
  query: string,
  count: number,
  post: (body: unknown) => Promise<void>,
  viewerToken?: string,
): Promise<void> {
  const { userToken, clientOptions } = deps;
  const token = viewerToken || userToken;
  if (!token) {
    await post({ messages: [], liveSearch: "unconnected" });
    return;
  }
  try {
    const userClient = new WebClient(token, { ...clientOptions });
    const res = await userClient.search.messages({ query, count: Math.min(count, 100) });
    const matches = res.messages?.matches ?? [];
    const shaped: RecentMessage[] = matches
      .map((m) => ({
        ts: String(m?.ts ?? ""),
        name: String(m?.username || m?.user || "someone"),
        text: String(m?.text ?? ""),
        ...(m?.user ? { authorId: String(m.user) } : {}),
      }))
      .filter((m) => m.ts);
    await post(buildContextWindow(shaped, { count }));
  } catch (err) {
    if (viewerToken && SLACK_AUTH_ERRORS.has(slackErrorCode(err) ?? "")) {
      await post({ messages: [], liveSearch: "unconnected" });
      return;
    }
    await post({ error: `Slack search failed: ${(err as Error).message}` });
  }
}

async function findMessageAt(
  deps: ContextDeps,
  client: any,
  channel: string,
  ts: string,
  threadTs: string | undefined,
): Promise<SlackHistoryMessage | undefined> {
  client = deps.historyClient ?? client;
  if (threadTs) {
    const res = await client.conversations.replies({ channel, ts: threadTs, oldest: ts, inclusive: true, limit: 2 });
    const hit = parseMessageList(res).messages.find((m) => m?.ts === ts);
    if (hit) return hit;
  }
  const res = await client.conversations.history({ channel, latest: ts, inclusive: true, limit: 1 });
  return parseMessageList(res).messages.find((m) => m?.ts === ts);
}

async function fetchSurfaceFile(
  deps: ContextDeps,
  client: any,
  channel: string,
  conversationThreadTs: string | undefined,
  ref: { ts: string; threadTs?: string; name?: string; index?: number },
): Promise<Record<string, unknown>> {
  const threadTs = typeof ref.threadTs === "string" && ref.threadTs ? ref.threadTs : conversationThreadTs;
  const msg = await findMessageAt(deps, client, channel, ref.ts, threadTs);
  if (!msg) {
    return {
      error: "I couldn't find that message — if it's a thread reply, pass its threadTs (the parent message's ts) too",
    };
  }
  const attached = messageWithForwardedContent(msg).files;
  if (ref.index !== undefined) {
    const picked = attached[ref.index - 1];
    if (!picked?.id) return { error: `that message has no file #${ref.index}` };
    return stageSurfaceFile(deps, client, picked, slackFileName(picked));
  }
  const files = attached.filter((f) => f?.id);
  if (!files.length) return { error: "that message has no files attached" };
  const names = files.map(slackFileName);
  const want = ref.name?.toLowerCase();
  const exact = want ? names.findIndex((n) => n.toLowerCase() === want) : -1;
  let at = files.length === 1 ? 0 : -1;
  if (want) at = exact >= 0 ? exact : names.findIndex((n) => n.toLowerCase().includes(want));
  if (at < 0)
    return {
      error: want
        ? `that message has no file matching "${ref.name}" — it carries: ${names.join(", ")}`
        : `that message carries ${files.length} files — pass a name: ${names.join(", ")}`,
    };
  return stageSurfaceFile(deps, client, files[at]!, names[at]!);
}

async function stageSurfaceFile(
  deps: ContextDeps,
  client: any,
  file: SlackFile,
  name: string,
): Promise<Record<string, unknown>> {
  const { core, directory, botToken, trustedFileHost } = deps;
  if (isOversize(file)) return { error: oversizeMsg(name) };
  let staged: { blobId: string; sizeBytes: number };
  try {
    staged = await core.stageBlob(
      await downloadSlackFile(file, {
        token: botToken,
        ...(trustedFileHost ? { trustedHost: trustedFileHost } : {}),
      }),
    );
  } catch (err) {
    swallow("slack: surface-file fetch", err);
    return { error: fileReadIssue(name, err) };
  }
  const author = file.user
    ? await directory.classifyUserCached(client, file.user).then(
        (c) => c.actor.displayName,
        () => undefined,
      )
    : undefined;
  return {
    file: {
      blobId: staged.blobId,
      name,
      sizeBytes: staged.sizeBytes,
      ...(file.mimetype ? { mimetype: file.mimetype } : {}),
      ...(author ? { author } : {}),
    },
  };
}

async function openGroupDm(
  deps: ContextDeps,
  client: any,
  participants: readonly string[],
): Promise<Record<string, unknown>> {
  const { directory } = deps;
  const people = [...new Set(participants.filter(Boolean))];
  if (people.length < 2) return { error: "a group DM needs at least two people besides me" };
  let groupId: string;
  try {
    groupId = await openConversationFor(client, people);
  } catch (err) {
    const code = slackErrorCode(err);
    if (code === "method_not_supported_for_channel_type" || code === "missing_scope")
      return { error: "I'm not allowed to open group DMs in this workspace (the app needs the mpim:write scope)" };
    return { error: `I couldn't open that group DM: ${(err as Error).message}` };
  }
  void (async () => directory.forceDirectorySync(client))().catch(
    swallowAs("slack: sync after opening a group DM", undefined),
  );
  return { group: { groupId } };
}

async function fulfillSurfaceContext(deps: ContextDeps, client: any, r: SurfaceContextRequest): Promise<void> {
  const { core, directory, serializer } = deps;
  const managed = deps.historyRateLimitOptions?.managed === true;
  const post = async (body: unknown): Promise<void> => {
    const { error, ...rest } = (body ?? {}) as { error?: string; messages?: unknown[] } & Record<string, unknown>;
    await core.fulfillContextRequest(
      r.id,
      typeof error === "string" ? { error } : { result: { ...rest, messages: rest.messages ?? [] } },
    );
  };
  try {
    const q = r.query ?? {};
    if (q.syncDirectory) {
      await directory.forceDirectorySync(client).catch(swallowAs("slack: on-demand directory sync", undefined));
      return await post({ messages: [] });
    }
    if (q.openGroup) return await post(await openGroupDm(deps, client, q.openGroup.participants ?? []));
    if (typeof q.searchAll === "string" && q.searchAll) {
      return fulfillLiveSearch(
        deps,
        q.searchAll,
        Math.max(1, Math.min(RECENT_THREAD_LIMIT, Number(q.count) || 100)),
        post,
        typeof q.viewerToken === "string" && q.viewerToken ? q.viewerToken : undefined,
      );
    }
    let channel: string;
    let threadTs: string | undefined;
    if (typeof q.conversationTarget === "string" && q.conversationTarget) {
      ({ channel, threadTs } = parseDeliveryTarget(q.conversationTarget));
    } else if (typeof q.channelId === "string" && q.channelId) {
      channel = q.channelId;
      const info = await directory.getChannelInfo(client, channel);
      if (!info) return post({ error: "I can't see that channel" });
      if (isExternallyShared(info)) return post({ error: "that channel is externally shared, so I won't read it" });
      if (info.is_member === false)
        return post({ error: "I'm not a member of that channel — ask someone to /invite me there" });
    } else {
      return post({ error: "malformed context request" });
    }
    if (q.file && typeof q.file.ts === "string" && q.file.ts) {
      return await post(await fetchSurfaceFile(deps, client, channel, threadTs, q.file));
    }
    const count = Math.max(
      1,
      Math.min(
        RECENT_THREAD_LIMIT,
        Number(q.count) || (managed ? SHARED_SLACK_HISTORY_LIMIT : (deps.historyLimit ?? 100)),
      ),
    );
    const before = typeof q.before === "string" && q.before ? q.before : undefined;
    const outcomes = await Promise.allSettled([
      deps.readHistory(client, channel, undefined, before, false, q.live === true),
      threadTs
        ? deps.readHistory(client, channel, threadTs, before, false, q.live === true)
        : Promise.resolve({ raw: [] as SlackHistoryMessage[], hasMore: false, note: undefined }),
    ]);
    const byTs = new Map<string, SlackHistoryMessage>();
    const notes = new Set<string>();
    let hasMore = false;
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        hasMore = true;
        notes.add(
          slackHistoryRateLimitMessage(outcome.reason, deps.historyRateLimitOptions) ??
            "Some Slack context could not be read; earlier messages may be missing.",
        );
        continue;
      }
      for (const message of outcome.value.raw) if (message.ts) byTs.set(message.ts, message);
      hasMore ||= outcome.value.hasMore;
      if (outcome.value.note) notes.add(outcome.value.note);
    }
    const raw = [...byTs.values()];
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (q.live === true && failure?.status === "rejected") throw failure.reason;
    if (q.live === true && threadTs && outcomes[0]?.status === "fulfilled" && outcomes[0].value.hasMore)
      throw new Error("Live Slack thread context includes truncated channel history; read the channel separately.");
    if (!raw.length && failure?.status === "rejected") throw failure.reason;
    const note = [...notes].join(" ");
    const nameById = new Map<string, string>();
    const shaped = await serializer.shapeRecentMessages(client, channel, raw, "", nameById);
    if (q.live === true && hasMore && !shaped.length)
      throw new Error("Live Slack history contains only filtered messages; an earlier page could not be located.");
    if (q.live === true) for (const message of shaped) message.reactions ??= [];
    await post({
      ...buildContextWindow(shaped, {
        count,
        ...(typeof q.match === "string" && q.match ? { match: q.match } : {}),
        scanHasMore: hasMore,
        nameById,
      }),
      ...(note ? { note } : {}),
    });
  } catch (err) {
    const code = slackErrorCode(err);
    let msg =
      slackHistoryRateLimitMessage(err, deps.historyRateLimitOptions) ?? `Slack read failed: ${(err as Error).message}`;
    if (code === "not_in_channel") msg = "I'm not a member of that channel — ask someone to /invite me there";
    else if (code === "channel_not_found") msg = "I can't see that channel";
    await post({ error: msg });
  }
}

export function createSurfaceContextFulfiller(deps: ContextDeps): {
  fulfillSurfaceContext(client: any, r: SurfaceContextRequest): Promise<void>;
} {
  return {
    fulfillSurfaceContext: (client, request) =>
      deps.rateLimitNotice
        ? deps.rateLimitNotice.run(client, request.query.rateLimitRecipient, () =>
            fulfillSurfaceContext(deps, client, request),
          )
        : fulfillSurfaceContext(deps, client, request),
  };
}
