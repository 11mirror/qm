import { extractPrivateContinuation } from "./external-access.ts";
import {
  type ReactionDirective,
  MAX_REACTIONS_PER_TURN,
  applyReactions,
  extractReactions,
  stripReactionDirectives,
} from "./reactions.ts";
import { SLACK_TEXT_LIMIT, botIdentityArgs } from "./delivery.ts";
import { parseBlockAction, parseInteractionBody } from "./payloads.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import type { Directory } from "./directory.ts";
import type { ActorAssertion } from "../types.ts";

import type { SlackConversationKind } from "./message-gating.ts";
export type { SlackConversationKind } from "./message-gating.ts";

export async function updateSlackMessage(
  client: any,
  channel: string,
  ts: string | undefined,
  text: string,
  blocks?: Array<Record<string, unknown>>,
): Promise<boolean> {
  if (!ts) return false;
  await client.chat.update({
    channel,
    ts,
    text: text.length > SLACK_TEXT_LIMIT ? `${text.slice(0, SLACK_TEXT_LIMIT - 1)}…` : text,
    ...botIdentityArgs(),
    unfurl_links: false,
    unfurl_media: false,
    blocks: blocks ?? [],
  });
  return true;
}

export type ActionApp = { action(pattern: RegExp, handler: (args: any) => Promise<void>): void };

export function registerDecisionButtons<T extends string>(
  app: ActionApp,
  pattern: RegExp,
  actionIds: readonly T[],
  opts: { directory: Directory; ready?: () => boolean; failure: string; label: string },
  decide: (
    actionId: T,
    value: string,
    actor: ActorAssertion,
    client: any,
  ) => Promise<{ text: string; blocks: Array<Record<string, unknown>> }>,
): void {
  app.action(pattern, async ({ ack, body, action, client }) => {
    await ack();
    const parsed = parseBlockAction(action, actionIds);
    const { clickerId, channel, messageTs } = parseInteractionBody(body);
    if (!parsed || !clickerId || !channel || !messageTs || opts.ready?.() === false) return;
    try {
      const actor = await opts.directory.classifyActor(client, clickerId);
      const card = await decide(parsed.actionId, parsed.value, actor, client);
      await updateSlackMessage(client, channel, messageTs, card.text, card.blocks);
    } catch (error) {
      await client.chat
        .postEphemeral({
          channel,
          user: clickerId,
          text: `${opts.failure}: ${errMessage(error)} You can try the button again.`,
        })
        .catch(swallowAs(opts.label, undefined));
    }
  });
}

export const HANDOFF_INSTRUCTION =
  "When work needs another person's own logins, files or memory, follow the `hand-off` skill.";

export function cleanAgentReplyForSlack(text: string): { text: string; reactions: ReactionDirective[] } {
  const extracted = extractReactions(text);
  return { text: extractPrivateContinuation(extracted.text).text, reactions: extracted.reactions };
}

export function stripSlackDirectives(text: string): string {
  return extractPrivateContinuation(stripReactionDirectives(text)).text;
}

export async function applyAndLogReactions(
  client: any,
  channel: string,
  defaultTs: string | undefined,
  directives: readonly ReactionDirective[],
): Promise<void> {
  let budget = MAX_REACTIONS_PER_TURN;
  for (const d of directives) {
    if (budget <= 0) break;
    const timestamp = d.target ?? defaultTs;
    if (!d.names.length || !timestamp) continue;
    const { added, failed } = await applyReactions(client, channel, timestamp, d.names.slice(0, budget));
    budget -= added.length + failed.length;
    if (failed.length) {
      console.error(
        `[slack-plugin] couldn't add reaction(s): ${failed.join(", ")} on ${timestamp} (check the reactions:write scope / message ts)`,
      );
    }
  }
}

export function conversationPlaceLabel(
  kind: SlackConversationKind,
  channelName: string | undefined,
  channel: string,
): string {
  if (kind === "group") return channelName ? `group DM (${channelName})` : "group DM";
  return channelName ? `#${channelName}` : `channel ${channel}`;
}
