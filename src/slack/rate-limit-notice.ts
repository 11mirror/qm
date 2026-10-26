import { AsyncLocalStorage } from "node:async_hooks";
import { LRUCache } from "lru-cache";
import { swallow } from "../util/errors.ts";
import { parseDeliveryTarget } from "./delivery.ts";

export const SHARED_SLACK_HISTORY_LIMIT = 15;

export function slackHistoryRateLimitMessage(
  error: unknown,
  opts: { setupUrl?: string; managed?: boolean; format?: "slack" } = {},
): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; retryAfter?: unknown; data?: { error?: unknown } };
  if (value.code !== "slack_webapi_rate_limited_error" && value.data?.error !== "ratelimited") return undefined;
  const seconds = Number(value.retryAfter);
  const retry = Number.isFinite(seconds) && seconds > 0 ? `in ${Math.ceil(seconds)} seconds` : "shortly";
  const message = `Slack is temporarily limiting history reads, so I may be missing earlier context. Try again ${retry}`;
  if (!opts.managed) return opts.format === "slack" ? undefined : `${message}.`;
  let setupUrl: string | undefined;
  try {
    const url = new URL(opts.setupUrl ?? "");
    if (url.protocol === "https:" && !url.username && !url.password) setupUrl = url.href;
  } catch {
    setupUrl = undefined;
  }
  if (!setupUrl) return opts.format === "slack" ? undefined : `${message}.`;
  const setup =
    opts.format === "slack"
      ? `<${setupUrl.replace(/&/g, "&amp;").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\|/g, "%7C")}|set up your own Slack app>`
      : `[set up your own Slack app](${setupUrl})`;
  return `${message}, or ${setup}.`;
}

interface Recipient {
  target: string;
  user: string;
}

export function createSlackRateLimitNotice(opts: { managed?: boolean; setupUrl?: string; client?: any }) {
  const recentlyNotified = new LRUCache<string, true>({ max: 1000, ttl: 60_000, ttlResolution: 0 });
  const active = new AsyncLocalStorage<{ client: any; recipient: Recipient; sent: boolean } | undefined>();
  return {
    run<T>(client: any, recipient: Recipient | undefined, fn: () => Promise<T>): Promise<T> {
      return active.run(recipient ? { client, recipient, sent: false } : undefined, fn);
    },
    async observe(error: unknown): Promise<void> {
      const request = active.getStore();
      if (!request || request.sent || !opts.managed) return;
      const text = slackHistoryRateLimitMessage(error, { ...opts, format: "slack" });
      if (!text) return;
      request.sent = true;
      try {
        const client = opts.client ?? request.client;
        const { channel, threadTs } = parseDeliveryTarget(request.recipient.target);
        if (!/^[CDG][A-Z0-9]+$/.test(channel)) return;
        const user = /^[UW][A-Z0-9]+$/.test(request.recipient.user)
          ? request.recipient.user
          : (await client.users.lookupByEmail({ email: request.recipient.user })).user?.id;
        if (!user) return;
        const key = `${channel}:${user}`;
        if (recentlyNotified.has(key)) return;
        recentlyNotified.set(key, true);
        if (channel.startsWith("D")) {
          await client.chat.postMessage({
            channel,
            text,
            ...(threadTs ? { thread_ts: threadTs } : {}),
            unfurl_links: false,
            unfurl_media: false,
          });
        } else {
          await client.chat.postEphemeral({ channel, user, text });
        }
      } catch (error) {
        swallow("slack: rate-limit notice", error);
      }
    },
  };
}

export type SlackRateLimitNotice = ReturnType<typeof createSlackRateLimitNotice>;
