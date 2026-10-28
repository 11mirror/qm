import { z } from "zod";
import { hashId } from "../util/crypto.ts";
import { readTextPrefix } from "../util/response-body.ts";
import { canonicalPayload } from "../../plugins/chassis/src/source-auth-sign.ts";
import { isStrongSigningSecret, SOURCE_AUTH_REPLAY_WINDOW_MS, verifySignature } from "../auth/source-auth.ts";
import { tenant } from "../tenant.ts";
import { destinationSource, type ActorAssertion } from "../types.ts";
import { parseSurfaceDeliveryTarget, surfaceContainerRef } from "./refs.ts";
import type { IngestEvent } from "../surface-cache/types.ts";
import { errMessage } from "../util/errors.ts";
import type { InboundMessage, InboundOutcome, InboundSurface, SurfaceUser } from "./surface.ts";

const RESERVED_SURFACES = new Set([
  "slack",
  "slack-account",
  "external-slack",
  "web",
  "principal",
  "group",
  "dm",
  "cron",
  "webhook",
  "monitor",
  "swarm",
  "loop",
  "inbox",
  "agent",
  "unknown",
]);
const POST_TIMEOUT_MS = 15_000;

const id = z
  .union([z.string().regex(/^[A-Za-z0-9_.-]+$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
  .transform(String);

const userSchema = z.object({
  id,
  email: z.string().optional(),
  name: z.string().optional(),
  guest: z.boolean().optional(),
  bot: z.boolean().optional(),
  timezone: z.string().optional(),
});

const messageEventSchema = z.object({
  type: z.literal("message"),
  chat: z.object({
    id,
    kind: z.enum(["dm", "group", "channel"]),
    name: z.string().optional(),
    members: z.array(userSchema).optional(),
  }),
  message: z.object({
    id,
    thread_id: id.nullish(),
    text: z.string(),
    mentions_bot: z.boolean().optional(),
    attachments: z
      .array(
        z.object({
          id,
          name: z.string().optional(),
          mimetype: z.string().optional(),
          size: z.number().int().nonnegative().optional(),
          url: z.url().optional(),
        }),
      )
      .optional(),
    thread_has_bot: z.boolean().optional(),
    sent_at: z.number().int().positive().optional(),
  }),
  author: userSchema,
});

const configSchema = z.object({
  surface: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .refine((surface) => !RESERVED_SURFACES.has(surface), { message: "is reserved" }),
  account: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+$/)
    .default("default"),
  label: z.string().min(1),
  apiUrl: z.url().refine((url) => ["http:", "https:"].includes(new URL(url).protocol), { message: "must be http(s)" }),
  apiToken: z.string().min(16),
  signingSecret: z.string().refine(isStrongSigningSecret, { message: "must be at least 32 characters" }),
  internalEmailDomains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).default([]),
});

export type HttpChatConfig = z.output<typeof configSchema>;

export function httpChatConfigsFromEnv(env: Record<string, string | undefined>): HttpChatConfig[] {
  const raw = env.HTTP_CHAT_SURFACES?.trim();
  if (!raw) return [];
  const parsed = z.array(configSchema).safeParse(JSON.parse(raw));
  if (!parsed.success)
    throw new Error(
      `HTTP_CHAT_SURFACES is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  return parsed.data;
}

function header(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

const FAILURE_BODY_CHARS = 300;

function permanent(message: string): Error {
  return Object.assign(new Error(message), { permanent: true });
}

function surfaceUser(internalDomains: ReadonlySet<string>, u: z.output<typeof userSchema>): SurfaceUser {
  const internal = u.guest !== true && internalDomains.has(u.email?.trim().toLowerCase().split("@")[1] ?? "");
  return {
    id: u.id,
    ...(u.email ? { email: u.email } : {}),
    ...(u.name ? { displayName: u.name } : {}),
    ...(internal ? {} : { guest: true }),
    ...(u.bot ? { bot: true } : {}),
    ...(u.timezone ? { timezone: u.timezone } : {}),
  };
}

function httpChatPrincipal(config: HttpChatConfig, u: SurfaceUser): ActorAssertion {
  return {
    externalId: u.email?.trim() || `${config.surface}:${config.account}:user:${u.id}`,
    ...(u.guest ? { isExternalGuest: true } : {}),
    ...(u.bot ? { isBot: true } : {}),
    ...(u.displayName ? { displayName: u.displayName } : {}),
  };
}

export function createHttpChatSurface(
  config: HttpChatConfig,
  opts: { fetch?: typeof fetch; now?: () => number; mirror?: (events: IngestEvent[]) => Promise<unknown> } = {},
): InboundSurface {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const apiBase = config.apiUrl.replace(/\/+$/, "");
  const mirrorTs = (at: number, key: string): string =>
    `${(at / 1000).toFixed(3)}${String(parseInt(hashId([key], 8), 16) % 1000).padStart(3, "0")}`;
  const conversationKey = (container: string): string =>
    surfaceContainerRef({ surface: config.surface, account: config.account, container });
  const mirror = async (event: IngestEvent): Promise<void> => {
    await opts.mirror?.([event]);
  };

  const internalDomains = new Set(config.internalEmailDomains);
  const user = (u: z.output<typeof userSchema>): SurfaceUser => surfaceUser(internalDomains, u);
  const principalFor = (u: SurfaceUser): ActorAssertion => httpChatPrincipal(config, u);

  function normalizeEvent(event: z.output<typeof messageEventSchema>): InboundMessage {
    return {
      tenant: tenant(),
      account: config.account,
      conversation: {
        kind: event.chat.kind,
        key: event.chat.id,
        ...(event.chat.name ? { name: event.chat.name } : {}),
        ...(event.message.thread_id ? { thread: event.message.thread_id } : {}),
        ...(event.chat.members ? { members: event.chat.members.map(user) } : {}),
      },
      messageId: event.message.id,
      author: user(event.author),
      text: event.message.text,
      attachments: (event.message.attachments ?? []).map((a) => ({
        id: a.id,
        ...(a.name ? { name: a.name } : {}),
        ...(a.mimetype ? { mimetype: a.mimetype } : {}),
        ...(a.size !== undefined ? { size: a.size } : {}),
        ...(a.url ? { url: a.url } : {}),
      })),
      mentions: {},
      mentionsSelf: event.message.mentions_bot === true,
      threadEngaged: event.message.thread_has_bot === true,
    };
  }

  return {
    name: config.surface,
    label: config.label,
    traits: [],
    destinationTypes: [config.surface],
    async normalize({ headers, pathWithQuery, rawBody }): Promise<InboundOutcome> {
      const verified = verifySignature(
        config.signingSecret,
        {
          signature: header(headers["x-signature"]),
          timestamp: Number(header(headers["x-timestamp"])),
          body: canonicalPayload("POST", pathWithQuery, rawBody),
        },
        now(),
        SOURCE_AUTH_REPLAY_WINDOW_MS,
      );
      if (!verified.ok) return { status: 401, reason: verified.reason };
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return { status: 400, reason: "invalid JSON body" };
      }
      if (body && typeof body === "object" && (body as { type?: unknown }).type !== "message")
        return { status: 200, messages: [] };
      const event = messageEventSchema.safeParse(body);
      if (!event.success) return { status: 400, reason: event.error.issues[0]?.message ?? "invalid event" };
      if (event.data.chat.kind !== "dm") return { status: 200, messages: [] };
      const message = normalizeEvent(event.data);
      const { conversation } = message;
      const recorded = mirror({
        container: conversationKey(conversation.key),
        ts: mirrorTs(event.data.message.sent_at ?? now(), `in:${event.data.message.id}`),
        sub: conversation.thread ?? null,
        authorId: message.author.id,
        ...(message.author.displayName ? { authorName: message.author.displayName } : {}),
        text: message.text,
        ...(message.author.bot ? { bot: true } : {}),
        ...(message.mentionsSelf ? { mentionsSelf: true } : {}),
        files: message.attachments.map((a) => ({
          fileId: a.id,
          ...(a.name ? { name: a.name } : {}),
          ...(a.mimetype ? { mimetype: a.mimetype } : {}),
          ...(a.size !== undefined ? { size: a.size } : {}),
        })),
        kind: conversation.kind,
        ...(conversation.name ? { containerName: conversation.name } : {}),
        members: (conversation.members ?? [message.author]).map((u) => principalFor(u).externalId),
      });
      try {
        await recorded;
      } catch (error) {
        return { status: 503, reason: `could not record the message: ${errMessage(error)}` };
      }
      return { status: 200, messages: [message] };
    },
    async deliver(post) {
      const { account } = destinationSource(post.destination);
      if (account !== undefined && account !== config.account)
        throw permanent(`${config.surface} account ${account} is not configured`);
      const target = parseSurfaceDeliveryTarget(post.destination.target);
      if (!target) throw permanent(`${config.surface} cannot post to ${JSON.stringify(post.destination.target)}`);
      const text = [post.text.trim(), ...(post.attachments ?? []).map((a) => `[attachment: ${a.name}]`)]
        .filter(Boolean)
        .join("\n");
      if (!text) return;
      const response = await doFetch(`${apiBase}/chats/${encodeURIComponent(target.container)}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          text,
          ...(target.thread ? { thread_id: target.thread } : {}),
          idempotency_key: post.idempotencyKey,
        }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = (await readTextPrefix(response, FAILURE_BODY_CHARS)).trim();
        const status = `HTTP ${response.status}${body ? `: ${body}` : ""}`;
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429)
          throw permanent(`${config.surface} refused the post: ${status}`);
        throw new Error(`${config.surface} post failed: ${status}`);
      }
      await mirror({
        container: conversationKey(target.container),
        ts: mirrorTs(post.createdAt ?? now(), `out:${post.idempotencyKey}`),
        sub: target.thread ?? null,
        text,
        self: true,
        handled: true,
      });
    },
    principalFor,
  };
}
