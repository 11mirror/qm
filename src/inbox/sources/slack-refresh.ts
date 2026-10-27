import { ErrorCode, WebClient } from "@slack/web-api";
import type { InboxItem } from "../../types.ts";
import type { DirectoryStore } from "../../directory/directory-store.ts";
import { normalizeSlackApiUrl } from "../../slack/config.ts";
import { slackWebClient } from "../../slack/web-client.ts";
import { slackErrorCode } from "../../slack/payloads.ts";
import { isObj } from "../../util/objects.ts";
import { isResolved } from "../view.ts";
import type { RefreshKit, SourceRefresher } from "./refresh.ts";
import { tokenFor } from "./adapter.ts";

interface SlackParticipant {
  id: string;
  name: string;
  avatarUrl?: string;
}

export function createSlackRefresher(
  kit: RefreshKit,
  opts: { directory: Pick<DirectoryStore, "getBySlackId">; slackApiUrl?: string },
): SourceRefresher {
  const slackBase = normalizeSlackApiUrl(opts.slackApiUrl ?? "https://slack.com/api");

  async function slackCall(
    owner: string,
    method: string,
    params: Record<string, string | number>,
    token: string,
  ): Promise<Record<string, unknown>> {
    const rateLimit = kit.limiter(owner, `slack:${method}`);
    const client = slackWebClient(
      token,
      (t, options) => new WebClient(t, { ...options, slackApiUrl: slackBase }),
      3000,
    );
    let result: unknown;
    try {
      result = await client.apiCall(method, params);
    } catch (error) {
      if (!isObj(error)) throw error;
      if (error.code === ErrorCode.RateLimitedError) {
        rateLimit(Number(error.retryAfter));
        throw kit.failure(new Error(`slack ${method}: HTTP 429`, { cause: error }));
      }
      if (error.code === ErrorCode.HTTPError)
        throw kit.failure(new Error(`slack ${method}: HTTP ${String(error.statusCode)}`, { cause: error }));
      if (error.code === ErrorCode.PlatformError)
        throw kit.failure(
          new Error(`slack ${method}: ${slackErrorCode(error) ?? "Invalid response"}`, { cause: error }),
        );
      throw error;
    }
    if (!isObj(result)) throw kit.failure(new Error(`slack ${method}: Invalid response`));
    return result;
  }

  function slackInfo(
    owner: string,
    method: string,
    params: Record<string, string>,
    token: string,
  ): Promise<Record<string, unknown>> {
    return kit.cached(`${owner}:${method}:${new URLSearchParams(params)}`, () =>
      slackCall(owner, method, params, token),
    );
  }

  function imageUrl(profile: Record<string, unknown>): string | undefined {
    return [48, 72, 192, 512, 1024, 32, 24, "original", 36, 96, 128, 256]
      .map((size) => profile[`image_${size}`])
      .find((value): value is string => typeof value === "string" && value.startsWith("https://"));
  }

  function savedParticipants(payload: Record<string, unknown>): SlackParticipant[] {
    return Array.isArray(payload.participants)
      ? payload.participants.filter(
          (person): person is SlackParticipant =>
            isObj(person) && typeof person.id === "string" && typeof person.name === "string",
        )
      : [];
  }

  function messageParticipant(message: Record<string, unknown>): SlackParticipant | undefined {
    const bot = isObj(message.bot_profile) ? message.bot_profile : {};
    const profile = isObj(message.user_profile) ? message.user_profile : {};
    let id = typeof message.user === "string" ? message.user : undefined;
    if (!id && typeof message.bot_id === "string") id = `bot:${message.bot_id}`;
    if (!id) return;
    const avatarUrl = imageUrl(isObj(bot.icons) ? bot.icons : profile);
    return {
      id,
      name: String(bot.name || profile.display_name || profile.real_name || message.username || id),
      ...(avatarUrl ? { avatarUrl } : {}),
    };
  }

  async function participants(
    owner: string,
    ids: string[],
    previous: SlackParticipant[],
  ): Promise<{ people: SlackParticipant[]; refreshAt: number }> {
    let complete = true;
    const people = await Promise.all(
      [...new Set(ids)].slice(0, 8).map(async (id): Promise<SlackParticipant> => {
        const saved = previous.find((person) => person.id === id) ?? { id, name: id };
        if (id.startsWith("bot:")) return saved;
        try {
          const member = await opts.directory.getBySlackId(id);
          if (!member) return saved;
          const avatarUrl = member.avatarUrl?.startsWith("https://") ? member.avatarUrl : saved.avatarUrl;
          return { id, name: member.displayName || saved.name, ...(avatarUrl ? { avatarUrl } : {}) };
        } catch (error) {
          kit.recordFailure(owner, `Slack profile ${id}`, error);
          complete = false;
          return saved;
        }
      }),
    );
    return { people, refreshAt: kit.now() + (complete ? 86_400_000 : 60_000) };
  }

  async function refreshAvatars(owner: string, item: InboxItem): Promise<void> {
    const payload = item.sourcePayload ?? {};
    if (typeof payload.slackAvatarsRefreshAt === "number" && kit.now() < payload.slackAvatarsRefreshAt) return;
    const meta = isObj(payload.slack) ? payload.slack : {};
    if (typeof meta.channelId !== "string" || typeof meta.ts !== "string") return;
    const previous = savedParticipants(payload);
    const senderId = typeof meta.userId === "string" ? meta.userId : undefined;
    if (!senderId || senderId.startsWith("bot:")) return;
    if (!previous.some((person) => person.id === senderId))
      previous.unshift({ id: senderId, name: typeof payload.from === "string" ? payload.from : senderId });
    const profiles = await participants(owner, [senderId, ...previous.map((person) => person.id)], previous);
    await kit.items.annotate(
      item.id,
      {
        participants: profiles.people,
        slackAvatarsRefreshAt: profiles.refreshAt,
      },
      { expectedSourceAt: item.sourceAt, expectedSourcePayload: payload },
    );
  }

  return {
    connectorToken: (tokens, owner) => tokenFor(tokens, "slack.com", owner),
    connectorName: "Slack",
    refreshAvatars,
    async refresh(owner, item, connectorToken) {
      const token = await connectorToken();
      const payload = item.sourcePayload ?? {};
      const meta = isObj(payload.slack) ? payload.slack : {};
      if (typeof meta.channelId !== "string" || typeof meta.ts !== "string") return;
      const channel = meta.channelId;
      const channelInfo = await slackInfo(owner, "conversations.info", { channel }, token);
      if (!isObj(channelInfo.channel)) throw new Error("Couldn't identify the Slack conversation.");
      const direct = channelInfo.channel.is_im === true || channelInfo.channel.is_mpim === true;
      const defaultRoot = direct ? undefined : meta.ts;
      const root = typeof meta.threadTs === "string" ? meta.threadTs : defaultRoot;
      const body = root
        ? await slackCall(owner, "conversations.replies", { channel, ts: root, limit: 100 }, token)
        : await slackCall(owner, "conversations.history", { channel, limit: 100 }, token);
      if (!Array.isArray(body.messages)) throw new Error("Couldn't read the Slack conversation.");
      const messages = body.messages
        .filter(isObj)
        .filter((m) => !root || m.ts === root || m.thread_ts === root)
        .sort((a, b) => Number(a.ts) - Number(b.ts));
      if (root && !messages.some((m) => m.ts === root)) throw new Error("The original Slack message is unavailable.");
      const waiting = messages.find((message) => message.ts === meta.ts);
      const saved = savedParticipants(payload);
      const sender =
        (waiting && messageParticipant(waiting)) ??
        (typeof meta.userId === "string" ? { id: meta.userId, name: meta.userId } : undefined);
      const previous = new Map(saved.map((person) => [person.id, person]));
      for (const message of messages) {
        const person = messageParticipant(message);
        if (person)
          previous.set(person.id, {
            ...person,
            ...previous.get(person.id),
            ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
          });
      }
      if (sender && (!previous.has(sender.id) || previous.get(sender.id)?.name === sender.id))
        previous.set(sender.id, { ...sender, ...(typeof payload.from === "string" ? { name: payload.from } : {}) });
      const profiles = await participants(
        owner,
        [
          ...(sender ? [sender.id] : []),
          ...messages.toReversed().flatMap((message) => {
            const person = messageParticipant(message);
            return person ? [person.id] : [];
          }),
        ],
        [...previous.values()],
      );
      const people = new Map([...previous.values(), ...profiles.people].map((person) => [person.id, person]));
      const context = messages.map((m) => {
        const author = messageParticipant(m);
        const person = author && people.get(author.id);
        return {
          author: person?.name ?? String(m.user ?? m.username ?? "Slack"),
          ...(person ? { authorId: person.id } : {}),
          ...(person?.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
          text: typeof m.text === "string" ? m.text : "",
          at: Math.round(Number(m.ts) * 1000),
          ts: m.ts,
          ...(root && m.ts !== root ? { reply: true } : {}),
          images: (Array.isArray(m.files) ? m.files.filter(isObj) : [])
            .filter((f) => typeof f.mimetype === "string" && f.mimetype.startsWith("image/"))
            .map((f) => f.url_private)
            .filter((url): url is string => typeof url === "string" && url.startsWith("https://"))
            .slice(0, 4),
        };
      });
      const nearby =
        root && Array.isArray(payload.context)
          ? payload.context
              .filter(isObj)
              .filter((m) => m.nearby === true)
              .slice(0, 6)
          : [];
      const partial =
        body.has_more === true || (isObj(body.response_metadata) && Boolean(body.response_metadata.next_cursor));
      await kit.items.annotate(
        item.id,
        {
          slack: {
            ...meta,
            isDirectMessage: direct,
            ...(root ? { threadTs: root } : {}),
            ...(typeof waiting?.user === "string" ? { userId: waiting.user } : {}),
          },
          participants: sender ? profiles.people : saved,
          slackAvatarsRefreshAt: sender ? profiles.refreshAt : 0,
          context: [...nearby, ...context],
          sourceContextFetched: true,
          sourceContextPartial: partial,
          sourceRefreshError: null,
        },
        { expectedSourceAt: item.sourceAt },
      );
      const latest = messages.at(-1);
      if ((!root || !partial) && latest && !isResolved(item)) {
        const identity = await slackInfo(owner, "auth.test", {}, token);
        if (typeof identity.user_id === "string" && latest.user === identity.user_id) {
          await kit.ownerReplied(
            item,
            Math.round(Number(latest.ts) * 1000),
            typeof latest.text === "string" ? latest.text : "",
          );
        }
      }
    },
  };
}
