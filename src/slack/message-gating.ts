import { isObj } from "../util/objects.ts";
import { LRUCache } from "lru-cache";
import type { DurableMap } from "../persistence/durable-map.ts";
import { swallowAs } from "../util/errors.ts";

export const SLACK_STATUS_TASK_PREFIX = "qm_status:";

export function isOwnStatusCard(
  message: { user?: string; bot_id?: string; blocks?: unknown[] },
  botUserId: string,
  ownBotId = "",
): boolean {
  const own = (botUserId && message.user === botUserId) || (ownBotId && message.bot_id === ownBotId);
  return Boolean(
    own &&
    Array.isArray(message.blocks) &&
    message.blocks.some(
      (block) =>
        isObj(block) &&
        block.type === "task_card" &&
        typeof block.task_id === "string" &&
        block.task_id.startsWith(SLACK_STATUS_TASK_PREFIX),
    ),
  );
}

export function mentionsBot(text: string, botUserId: string): boolean {
  return botUserId ? text.includes(`<@${botUserId}>`) : false;
}

export function threadHasBotStake(
  messages: readonly { user?: string; bot_id?: string; text?: string; mentionsSelf?: boolean }[],
  botUserId: string,
  ownBotId = "",
): boolean {
  return messages.some((m) =>
    Boolean(
      m.mentionsSelf ||
      (botUserId && (m.user === botUserId || mentionsBot(m.text ? String(m.text) : "", botUserId))) ||
      (ownBotId && m.bot_id === ownBotId),
    ),
  );
}

export function shouldProcessMessage(
  m: { subtype?: string; bot_id?: string; user?: string },
  botUserId: string,
  ownBotId = "",
): boolean {
  if (botUserId && m.user === botUserId) return false;
  if (ownBotId && m.bot_id === ownBotId) return false;
  if (m.subtype && m.subtype !== "file_share" && m.subtype !== "thread_broadcast" && m.subtype !== "bot_message")
    return false;
  return true;
}

export function shouldMirrorMessage(m: { hidden?: boolean; subtype?: string; ts?: string }): boolean {
  return (
    Boolean(m.ts) &&
    m.hidden !== true &&
    !["message_changed", "message_deleted", "message_replied", "tombstone"].includes(m.subtype ?? "")
  );
}

export function isGroupMembershipMessage(m: { channel_type?: string; subtype?: string }): boolean {
  return m.channel_type === "mpim" && (m.subtype === "group_join" || m.subtype === "group_leave");
}

export function channelPrivacyChange(m: {
  channel?: string;
  subtype?: string;
}): { channel: string; isPrivate: boolean } | null {
  if (!m.channel) return null;
  if (m.subtype === "channel_convert_to_private") return { channel: m.channel, isPrivate: true };
  if (m.subtype === "channel_convert_to_public") return { channel: m.channel, isPrivate: false };
  return null;
}

export function createRefreshCoalescer(run: () => Promise<void>): () => Promise<void> {
  let requested = 0;
  let active: Promise<void> | undefined;
  return function refresh(): Promise<void> {
    requested++;
    if (!active) {
      active = (async function drain(): Promise<void> {
        let completed: number;
        try {
          do {
            completed = requested;
            await run();
          } while (completed !== requested);
        } finally {
          active = undefined;
        }
        if (completed !== requested) return refresh();
      })();
    }
    return active;
  };
}

export function hasContent(text: string, files: readonly unknown[]): boolean {
  return text.trim().length > 0 || files.length > 0;
}

export function isThreadReply(m: { thread_ts?: string; ts?: string }): boolean {
  return Boolean(m.thread_ts) && m.thread_ts !== m.ts;
}

export interface ThreadTracker {
  get(channel: string, threadTs: string): boolean | undefined;
  mark(channel: string, threadTs: string, present: boolean): void;
}

const THREAD_NO_STAKE_TTL_MS = 5 * 60_000;

export function createThreadTracker(opts: { negativeTtlMs?: number } = {}): ThreadTracker {
  const negativeTtlMs = opts.negativeTtlMs ?? THREAD_NO_STAKE_TTL_MS;
  const cache = new LRUCache<string, boolean>({ max: 10_000 });
  return {
    get: (channel, threadTs) => cache.get(`${channel}:${threadTs}`),
    mark: (channel, threadTs, present) =>
      void cache.set(`${channel}:${threadTs}`, present, present ? undefined : { ttl: negativeTtlMs }),
  };
}

export type SlackConversationKind = "dm" | "channel" | "group";

export function dmThreadRef(channel: string, threadTs?: string): string {
  return threadTs ? `dm:${channel}:${threadTs}` : `dm:${channel}`;
}

export function channelThreadRef(conversationKind: SlackConversationKind, channel: string, root: string): string {
  return `${conversationKind === "group" ? "grp" : "ch"}:${channel}:${root}`;
}

export function slackThreadRefCandidates(channel: string, ts: string, threadTs?: string): string[] {
  const root = threadTs || ts;
  return [
    ...new Set([
      dmThreadRef(channel),
      dmThreadRef(channel, root),
      channelThreadRef("channel", channel, root),
      channelThreadRef("group", channel, root),
    ]),
  ];
}

export interface SlackThreadRef {
  container: string;
  root?: string;
}

export function parseSlackThreadRef(threadRef: string): SlackThreadRef | null {
  const m = /^(?:dm|ch|grp):([^:]+)(?::(.+))?$/.exec(threadRef);
  if (!m) return null;
  return { container: m[1]!, ...(m[2] ? { root: m[2] } : {}) };
}

export function dedupeKey(e: { event_id?: string; client_msg_id?: string; channel?: string; ts?: string }): string {
  if (e.channel && e.ts) return `${e.channel}:${e.ts}`;
  return e.event_id || e.client_msg_id || `${e.channel ?? ""}:${e.ts ?? ""}`;
}

export interface HandledEvent {
  at: number;
}

export interface Deduper {
  seen(key: string): Promise<boolean>;
  done(key: string): Promise<void>;
  forget(key: string): void;
}

export function createDeduper(max = 500, handled?: DurableMap<HandledEvent>, now = Date.now): Deduper {
  const cache = new LRUCache<string, true>({ max });
  return {
    async seen(key) {
      if (cache.has(key)) return true;
      cache.set(key, true);
      if (!handled) return false;
      return (await handled.get(key).catch(swallowAs("slack: handled-event lookup", null))) !== null;
    },
    async done(key) {
      await handled?.put(key, { at: now() }).catch(swallowAs("slack: handled-event record", undefined));
    },
    forget(key) {
      cache.delete(key);
      void handled?.delete(key).catch(swallowAs("slack: handled-event forget", undefined));
    },
  };
}

export async function dedupedRun(
  deduper: Deduper,
  key: string,
  run: () => Promise<void>,
  onError: (err: unknown) => void,
): Promise<boolean> {
  if (await deduper.seen(key)) return false;
  try {
    await run();
    await deduper.done(key);
  } catch (err) {
    deduper.forget(key);
    onError(err);
  }
  return true;
}

export function isBareStop(text: string, botHandle = ""): boolean {
  const trimmed = text.trim();
  const tag = botHandle ? `@${botHandle}` : "";
  const afterTag = tag && trimmed.startsWith(tag) ? trimmed.slice(tag.length) : undefined;
  const rest = afterTag !== undefined && /^\s/.test(afterTag) ? afterTag : trimmed;
  return /^stop[.!]?$/i.test(rest.trim());
}
