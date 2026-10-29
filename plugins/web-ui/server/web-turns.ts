import { enc } from "./core-relay.ts";
import { appEditSlug } from "../src/app-edit.ts";
import { type IncomingMessage } from "node:http";

import { resolveIdentity } from "./identity.ts";

export const SUBAGENT_THREAD_PREFIX = "agent:main:subagent:";

export const isWebThread = (value: unknown): value is string =>
  typeof value === "string" && (value.startsWith("web:") || value.startsWith(SUBAGENT_THREAD_PREFIX));

export const approvalScope = (value: unknown) =>
  value === "once" || value === "session" || value === "always" ? value : undefined;

export const channelLabel = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;

export type WebConversation = {
  kind: "dm" | "channel" | "group";
  threadRef: string;
  channelRef?: string;
  channelName?: string;
};

function conversationForScope(
  threadRef: string,
  scope: string | undefined,
  channelName: string | undefined,
): WebConversation | null {
  if (!scope || scope.startsWith("personal:")) return { kind: "dm", threadRef };
  const sep = scope.indexOf(":");
  const kind = scope.slice(0, sep);
  const ref = scope.slice(sep + 1);
  if ((kind !== "channel" && kind !== "group") || !ref) return null;
  return { kind, channelRef: ref, threadRef, ...(channelName ? { channelName } : {}) };
}

export async function resolveWebConversation(
  user: string,
  threadRef: string,
  scope: string | undefined,
  channelName: string | undefined,
): Promise<{ conversation: WebConversation } | { error: string; message: string }> {
  const conversation = conversationForScope(threadRef, scope, channelName);
  if (!conversation) {
    return {
      error: "forbidden_scope",
      message: "you can only chat in your personal context or a shared context you're in",
    };
  }
  return { conversation };
}

export async function webTurnBase(
  req: IncomingMessage,
  user: string,
  conversation: WebConversation,
  threadRef: string,
  text: string,
) {
  const displayName = resolveIdentity(req)?.name ?? null;
  const appSlug = appEditSlug(threadRef, user);
  return {
    surface: "web",
    actor: { externalId: user, ...(displayName ? { displayName } : {}) },
    conversation,
    origin: { kind: "human" },
    deliveryTarget: threadRef,
    ...(appSlug
      ? {
          conversationHeader: `The user is chatting beside their deployed app ${JSON.stringify(appSlug)}. Requests about this app refer to that deployment. Use the existing app source and publish updates to the same deployment when requested. This context does not grant additional permissions.`,
        }
      : {}),
    text,
  };
}

const SEND_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function namespacedSendKey(user: string, raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.trim();
  return SEND_KEY_PATTERN.test(key) ? `web:${enc(user)}:${key}` : undefined;
}
