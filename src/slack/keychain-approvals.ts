import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { KeychainApprovalView } from "../credentials/keychain-approval.ts";
import type { Directory } from "./directory.ts";
import { registerDecisionButtons, updateSlackMessage, type ActionApp } from "./messaging.ts";
import { escapeSlackText } from "./mrkdwn.ts";
import { slackLink } from "./approval-cards.ts";
import { findPostedByKey, postWithVerify, slackReplyArgs } from "./delivery.ts";
import { swallowAs } from "../util/errors.ts";
import { parseScopeId } from "../types.ts";

const DECISIONS = { keychain_allow_once: "once", keychain_allow_always: "standing", keychain_deny: "deny" } as const;
type KeychainAction = keyof typeof DECISIONS;

export function keychainApprovalMessage(
  view: KeychainApprovalView,
  originUrl?: string,
): { text: string; blocks: Array<Record<string, unknown>> } {
  const { ask } = view;
  const place = `in ${escapeSlackText(view.conversation).replaceAll("|", "&#124;")}`;
  const origin = slackLink(originUrl, place);
  const pending = ask.status === "pending";
  const kind = parseScopeId(ask.requesterScopeId).kind;
  const audience = { personal: "your personal conversations", channel: "this channel" }[kind as string] ?? "this group";
  const standing = `ongoing access across ${audience}`;
  const duration = pending ? ` (${ask.requestedMode === "once" ? "one-time access" : standing})` : "";
  const summary = `Use your *${escapeSlackText(view.service.slice(0, 150))}* credential ${origin}${duration}.`;
  let status = "This request expired.";
  if (ask.status === "approved") status = `Approved — ${view.mode === "standing" ? standing : "one-time access"}.`;
  if (ask.status === "declined") status = "Denied.";
  const text = pending
    ? `Approval needed: use your ${view.service} credential in ${view.conversation}${duration}.`
    : status;
  const button = (action_id: KeychainAction, label: string, style?: string) => ({
    type: "button",
    text: { type: "plain_text", text: label },
    action_id,
    value: ask.id,
    ...(style ? { style } : {}),
  });
  const once = button("keychain_allow_once", "Allow once", ask.requestedMode === "once" ? "primary" : undefined);
  const always = button("keychain_allow_always", "Allow", ask.requestedMode === "once" ? undefined : "primary");
  return {
    text,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `${pending ? ":lock: *Approval needed.*" : `*${status}*`}\n${summary}` },
      },
      ...(pending
        ? [
            {
              type: "actions",
              block_id: `keychain_ask:${ask.id}`,
              elements: [
                ...(ask.requestedMode === "once" ? [once, always] : [always, once]),
                button("keychain_deny", "Deny", "danger"),
              ],
            },
          ]
        : []),
    ],
  };
}

export async function keychainApprovalOrigin(
  view: KeychainApprovalView,
  client: any,
  webUrl?: string,
): Promise<string | undefined> {
  if (view.slack) {
    const result = await client.chat
      .getPermalink({ channel: view.slack.channel, message_ts: view.slack.ts })
      .catch(swallowAs("slack: approval origin link", null));
    if (typeof result?.permalink === "string") return result.permalink;
  }
  if (!webUrl || !view.sessionId) return undefined;
  const url = new URL(`${webUrl}/s/${encodeURIComponent(view.sessionId)}`);
  if (view.seq !== undefined) url.searchParams.set("seq", String(view.seq));
  return url.toString();
}

export async function deliverKeychainCard(
  core: SlackCoreClient,
  client: any,
  delivery: { idempotencyKey?: string; destination: { keychainAskId?: string } },
  channel: string,
  threadTs: string | undefined,
  webUrl?: string,
): Promise<void> {
  const id = delivery.destination.keychainAskId!;
  const view = await core.keychainApprovals?.card(id);
  if (!view) return;
  const card = keychainApprovalMessage(view, await keychainApprovalOrigin(view, client, webUrl));
  const key = `ask:${id}:notice`;
  if (delivery.idempotencyKey === key) {
    await postWithVerify(client, { ...slackReplyArgs(channel, card.text, threadTs), blocks: card.blocks }, key, {
      verifyFirst: true,
    });
    return;
  }
  const where = { channel, ...(threadTs ? { thread_ts: threadTs } : {}) };
  const posted = await findPostedByKey(client, where, key, String((view.ask.createdAt - 60_000) / 1000));
  if (posted) await updateSlackMessage(client, channel, posted.ts, card.text, card.blocks);
}

export function registerKeychainApprovalActions(
  app: ActionApp,
  deps: { core: SlackCoreClient; directory: Directory; webUiPublicUrl?: string },
): void {
  registerDecisionButtons(
    app,
    /^keychain_/,
    Object.keys(DECISIONS) as KeychainAction[],
    {
      directory: deps.directory,
      ready: () => Boolean(deps.core.keychainApprovals),
      failure: "Couldn't complete this approval",
      label: "slack: credential approval failure",
    },
    async (actionId, value, actor, client) => {
      const view = await deps.core.keychainApprovals!.decide(value, actor, DECISIONS[actionId]);
      return keychainApprovalMessage(view, await keychainApprovalOrigin(view, client, deps.webUiPublicUrl));
    },
  );
}
