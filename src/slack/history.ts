import { escapeSlackText } from "./mrkdwn.ts";
import { isOwnStatusCard } from "./message-gating.ts";
import { slackMessageToIngestEvent } from "./mirror.ts";
import { SHARED_SLACK_HISTORY_LIMIT, slackHistoryRateLimitMessage } from "./rate-limit-notice.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { CachedMessage } from "../surface-cache/types.ts";
import type { BotIdentity } from "./directory.ts";
import type { SlackHistoryMessage } from "./payloads.ts";
import { parseMessageList } from "./payloads.ts";
import { swallow } from "../util/errors.ts";

interface SlackHistoryPage {
  raw: SlackHistoryMessage[];
  hasMore: boolean;
  expansionFailures?: number;
  truncatedExpansions?: number;
  note?: string;
}

export type SlackHistoryReader = (
  client: any,
  channel: string,
  threadTs?: string,
  before?: string,
  expandThreads?: boolean,
  live?: boolean,
) => Promise<SlackHistoryPage>;

const MIRROR_CONTEXT_NOTE =
  "Context comes from stored Slack events. Earlier messages, missed events, reactions, and attachment details may be absent; this is not a complete Slack history.";

type HistoryDeps = {
  core: SlackCoreClient;
  ids: BotIdentity;
  managed?: boolean;
  historyLimit?: number;
  setupUrl?: string;
  historyClient?: { conversations: { history(args: any): Promise<unknown>; replies(args: any): Promise<unknown> } };
};

const historyLimit = (deps: HistoryDeps): number =>
  deps.managed ? SHARED_SLACK_HISTORY_LIMIT : (deps.historyLimit ?? 200);

async function fetchPage(
  deps: HistoryDeps,
  client: any,
  channel: string,
  threadTs?: string,
  before?: string,
  pageLimit = historyLimit(deps),
) {
  const historyClient = deps.historyClient ?? client;
  const paging = { channel, limit: pageLimit, ...(before ? { latest: before, inclusive: false } : {}) };
  const page = parseMessageList(
    threadTs
      ? await historyClient.conversations.replies({ ...paging, ts: threadTs })
      : await historyClient.conversations.history(paging),
  );
  page.messages = page.messages.filter((m) => !isOwnStatusCard(m, deps.ids.botUserId, deps.ids.ownBotId));
  return page;
}

async function liveHistory(
  deps: HistoryDeps,
  client: any,
  channel: string,
  threadTs?: string,
  before?: string,
  expandThreads = false,
): Promise<SlackHistoryPage> {
  const page = await fetchPage(deps, client, channel, threadTs, before);
  const raw = threadTs ? page.messages : page.messages.slice().reverse();
  if (threadTs || !expandThreads) return { raw, hasMore: page.hasMore };
  const parents = raw.filter((m) => m.ts && Number(m.reply_count) > 0).slice(-5);
  const expanded = await Promise.all(
    parents.map((m) =>
      fetchPage(deps, client, channel, m.ts).then(
        (page) => ({ page, failed: false }),
        () => ({ page: { messages: [] as SlackHistoryMessage[], hasMore: false }, failed: true }),
      ),
    ),
  );
  const byTs = new Map<string, SlackHistoryMessage>();
  for (const m of [...raw, ...expanded.flatMap((result) => result.page.messages)]) if (m.ts) byTs.set(m.ts, m);
  return {
    raw: [...byTs.values()],
    hasMore: page.hasMore,
    expansionFailures: expanded.filter((result) => result.failed).length,
    truncatedExpansions: expanded.filter((result) => result.page.hasMore).length,
  };
}

async function mirrorHistory(
  deps: HistoryDeps,
  channel: string,
  threadTs?: string,
  before?: string,
  expandThreads = false,
  pageLimit = 200,
): Promise<{ rows: CachedMessage[]; hasMore: boolean; truncatedExpansions?: number }> {
  const read = deps.core.readSurfaceMessages!;
  const options = { limit: pageLimit + 1, noFallback: true, ...(before ? { before } : {}) };
  if (threadTs) {
    const [parents, replies] = await Promise.all([
      read(channel, { at: threadTs, noFallback: true, ...(before ? { before } : {}) }),
      read(channel, { ...options, sub: threadTs, oldestFirst: true }),
    ]);
    const rows = [...parents, ...replies];
    return { rows: rows.slice(0, pageLimit), hasMore: rows.length > pageLimit };
  }
  const rootPage = await read(channel, { ...options, channelHistory: true });
  const roots = rootPage.slice(-pageLimit);
  const hasMore = rootPage.length > pageLimit;
  if (!expandThreads) return { rows: roots, hasMore };
  const parents = roots.filter((m) => (m.replyCount ?? 0) > 0).slice(-5);
  const expanded = await Promise.all(
    parents.map((m) => mirrorHistory(deps, channel, m.ts, undefined, false, pageLimit)),
  );
  return {
    rows: [...new Map([...roots, ...expanded.flatMap((page) => page.rows)].map((m) => [m.ts, m])).values()],
    hasMore,
    truncatedExpansions: expanded.filter((page) => page.hasMore).length,
  };
}

function mirroredMessage(deps: HistoryDeps, m: CachedMessage): SlackHistoryMessage {
  return {
    ts: m.ts,
    ...(m.subtype !== undefined ? { subtype: m.subtype } : {}),
    text: escapeSlackText(m.text),
    ...(m.mentionsSelf ? { mentionsSelf: true } : {}),
    ...(m.sub ? { thread_ts: m.sub } : {}),
    ...(m.self || m.authorId ? { user: m.self ? deps.ids.botUserId : m.authorId } : {}),
    ...(m.authorName ? { username: m.authorName } : {}),
    ...(m.bot ? { bot_id: m.botId ?? (m.self ? deps.ids.ownBotId : "mirrored-bot") } : {}),
    ...(m.files?.length
      ? {
          files: m.files.map((f) => ({
            id: f.fileId,
            name: f.name,
            title: f.title,
            size: f.size,
            mimetype: f.mimetype,
          })),
        }
      : {}),
  };
}

export function createSlackHistoryReader(deps: HistoryDeps): SlackHistoryReader {
  const limit = historyLimit(deps);
  const readStored = (channel: string, timestamps: string[]): Promise<CachedMessage[]> =>
    deps.core.readSurfaceMessages!(channel, { timestamps, noFallback: true, includeDeleted: true });

  const backfilled = new Set<string>();
  return async (client, channel, threadTs, before, expandThreads, live) => {
    if (live) {
      const page = await liveHistory(deps, client, channel, threadTs, before, expandThreads);
      if (threadTs && page.hasMore)
        throw new Error("Live Slack thread exceeds the history limit; its replies could not be read completely.");
      return page;
    }
    const key = threadTs ? `${channel}:${threadTs}` : channel;
    let mirrored: SlackHistoryMessage[] = [];
    let mirrorResult: SlackHistoryPage | undefined;
    if (deps.core.readSurfaceMessages) {
      try {
        const mirrorPage = await mirrorHistory(deps, channel, threadTs, before, expandThreads);
        const rows = mirrorPage.rows;
        mirrored = rows.filter((m) => !m.deleted && (!before || m.ts < before)).map((m) => mirroredMessage(deps, m));
        if (mirrored.length && (!threadTs || rows.some((m) => m.ts === threadTs) || before)) {
          mirrorResult = {
            raw: mirrored,
            hasMore: mirrorPage.hasMore,
            ...(mirrorPage.truncatedExpansions !== undefined
              ? { truncatedExpansions: mirrorPage.truncatedExpansions }
              : {}),
            note: MIRROR_CONTEXT_NOTE,
          };
          if (before) return mirrorResult;
        }
      } catch (error) {
        swallow("slack: mirror context read", error);
      }
    }
    const fallback = mirrorResult ?? { raw: mirrored, hasMore: true, note: MIRROR_CONTEXT_NOTE };
    if (!before && backfilled.has(key)) return fallback;
    try {
      if (!before) backfilled.add(key);
      const page = await fetchPage(
        deps,
        client,
        channel,
        threadTs,
        before,
        mirrorResult ? Math.min(limit, SHARED_SLACK_HISTORY_LIMIT) : limit,
      );
      if (page.messages.length && deps.core.rememberSurfaceHistory)
        await deps.core
          .rememberSurfaceHistory(
            page.messages
              .filter((m) => m.ts)
              .map((m) => slackMessageToIngestEvent({ ...m, channel }, deps.ids, { handled: true })),
          )
          .catch((error) => swallow("slack: history mirror ingest", error));
      const deleted = new Set<string>();
      if (deps.core.readSurfaceMessages && page.messages.length) {
        const stored = await readStored(
          channel,
          page.messages.flatMap((m) => (m.ts ? [m.ts] : [])),
        );
        for (const row of stored) if (row.deleted) deleted.add(row.ts);
      }
      const byTs = new Map<string, SlackHistoryMessage>();
      for (const message of [...mirrored, ...page.messages])
        if (message.ts && !deleted.has(message.ts)) byTs.set(message.ts, message);
      return {
        raw: [...byTs.values()],
        hasMore: page.hasMore,
        ...(page.hasMore ? { note: "Slack history is truncated; older messages may be absent." } : {}),
      };
    } catch (error) {
      if (!before && slackHistoryRateLimitMessage(error) && deps.core.noteSurfaceHistoryGap)
        await deps.core
          .noteSurfaceHistoryGap(
            channel,
            `Slack rate-limited the initial history pull for ${threadTs ? `thread ${threadTs} in ` : ""}this channel, so messages from before QM joined were not loaded.`,
          )
          .catch((noteError) => swallow("slack: history gap memory note", noteError));
      if (!mirrored.length) throw error;
      swallow("slack: incomplete mirror history fallback", error);
      return {
        ...fallback,
        note: [MIRROR_CONTEXT_NOTE, slackHistoryRateLimitMessage(error, deps)].filter(Boolean).join(" "),
      };
    }
  };
}
