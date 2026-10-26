import { extractPrivateContinuation } from "./external-access.ts";
import { deployAccessMessage } from "./deploy-access.ts";
import { approvalDeliveryKey, approvalDeliveryRecipient } from "../core/approval-store.ts";
import { samePerson } from "../directory/person.ts";
import { approvalMessage } from "./approval-cards.ts";
import { deliverKeychainCard } from "./keychain-approvals.ts";
import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import { destinationSource } from "../types.ts";
import {
  botIdentityArgs,
  deliveryMetadata,
  openConversationFor,
  findPostedByKey,
  parseDeliveryTarget,
  statusPlaceholderKey,
  postWithVerify,
  recoveryVerifyOldest,
  slackReplyArgs,
} from "./delivery.ts";
import { createThreadTracker, dmThreadRef } from "./message-gating.ts";
import { escapeSlackText, slackSectionBlocks, toSlackMrkdwn } from "./mrkdwn.ts";
import { stripReactionDirectives, applyReactions } from "./reactions.ts";
import { uploadAttachments, uploadFailureNote } from "./attachments.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { OutboundPost, PostReceipt } from "../surfaces/outbound.ts";
import type { TurnFlow } from "./turn-flow.ts";
import { cleanAgentReplyForSlack, stripSlackDirectives } from "./messaging.ts";
import { cronIdOf } from "../sessions/thread-ref.ts";
import { slackErrorCode } from "./payloads.ts";

const PERMANENT_POST_ERRORS = new Set([
  "channel_not_found",
  "is_archived",
  "account_inactive",
  "user_not_found",
  "cannot_reply_to_message",
  "message_not_found",
]);

const SETTLED_PIN_ERRORS = new Set(["already_pinned", "no_pin", "not_pinned"]);

const STATUS_PLACEHOLDER_LOOKBACK_MS = 6 * 3_600_000;

type Post = OutboundPost;

export function createSlackSender(deps: {
  clientForAccount?: (accountId: string, teamId?: string) => any;
  externalNamespace?: (accountId: string) => string | undefined;
  continuePrivate?: (runId: string, task: string) => Promise<void>;
  core: SlackCoreClient;
  webUiPublicUrl?: string;
  flow: TurnFlow;
  runInFlight?: (runId: string) => boolean;
  threads: ReturnType<typeof createThreadTracker>;
  defaultClient?: any;
}): (post: Post) => Promise<PostReceipt | void> {
  const { core, flow, threads } = deps;
  const runInFlight = deps.runInFlight ?? ((runId: string) => flow.inFlightRuns.has(runId));

  function deliveryFooter(d: Post): Array<Record<string, unknown>> {
    const base = deps.webUiPublicUrl?.trim().replace(/\/+$/, "");
    const id = d.provenance?.trigger === "cron" ? cronIdOf(d.provenance.sourceThreadRef) : null;
    const sender = d.destination.relaySender?.trim().replace(/^@+/, "");
    const attribution = sender ? [{ type: "plain_text", text: `Sent for @${sender}`, emoji: false }] : [];
    if (!base || !id) return attribution;
    const title = escapeSlackText(d.provenance?.sourceTitle?.trim() || "Cron");
    return [
      ...attribution,
      { type: "mrkdwn", text: `${title} · <${base}/crons/${encodeURIComponent(id)}|Settings>`, verbatim: true },
    ];
  }

  const postError = (err: unknown): Error => {
    const error = err instanceof Error ? err : new Error(errMessage(err));
    const code = slackErrorCode(err);
    return code && PERMANENT_POST_ERRORS.has(code) ? Object.assign(error, { permanent: true }) : error;
  };

  function deliveryClient(destination: Post["destination"]): any {
    const { account, workspaceId } = destinationSource(destination);
    let client = account ? undefined : deps.defaultClient;
    if (deps.clientForAccount) client = deps.clientForAccount(account ?? "default", workspaceId);
    if (!client) throw new Error(`Slack account ${account ?? "default"} is not connected`);
    return client;
  }

  const runIdOf = (d: Post): string | undefined =>
    d.idempotencyKey.startsWith("run:") ? d.idempotencyKey.slice("run:".length) : undefined;

  function bodyOf(d: Post, text: string): { text: string; blocks?: Array<Record<string, unknown>> } {
    const footer = deliveryFooter(d);
    if (!text.trim() && !footer.length && d.attachments?.length) text = "Files attached.";
    if (!footer.length) return { text };
    return { text, blocks: [...(text.trim() ? slackSectionBlocks(text) : []), { type: "context", elements: footer }] };
  }

  async function uploadOrNote(client: any, channel: string, root: string | undefined, d: Post): Promise<void> {
    if (!d.attachments?.length) return;
    try {
      await uploadAttachments(client, channel, root, d.attachments, core);
    } catch (err) {
      console.error(`[slack-plugin] delivery ${d.idempotencyKey} attachment upload failed:`, errMessage(err));
      await client.chat
        .postMessage(slackReplyArgs(channel, uploadFailureNote(err), root))
        .catch(swallowAs("slack: post upload-failure note", undefined));
    }
  }

  const refused = (what: string): Error => Object.assign(new Error(what), { permanent: true });

  async function settle(op: () => Promise<unknown>, settledCodes: Set<string>, what: string, note = ""): Promise<void> {
    try {
      await op();
    } catch (err) {
      const code = slackErrorCode(err);
      if (!code) throw err;
      if (!settledCodes.has(code)) throw refused(`${what}: ${code}${note}`);
    }
  }

  async function postToConversation(d: Post): Promise<PostReceipt | void> {
    const client = deliveryClient(d.destination);
    const runId = runIdOf(d);
    const source = destinationSource(d.destination);
    const namespace = deps.externalNamespace?.(source.account ?? "default");
    const { channel, threadTs } = parseDeliveryTarget(d.destination.target);
    if (
      namespace &&
      (channel.startsWith("D")
        ? runId && source.policyNamespace !== namespace
        : !d.provenance?.sourceThreadRef.startsWith(`${namespace}:`))
    ) {
      console.error(
        `[slack-plugin] post ${d.idempotencyKey} is outside external account ${namespace}'s policy — dropped`,
      );
      return;
    }
    if (runId && runInFlight(runId)) return { deferred: true };
    const continuation = extractPrivateContinuation(d.text);
    if (
      runId &&
      continuation.task &&
      d.provenance?.sourceThreadRef.startsWith("external-slack:") &&
      deps.continuePrivate
    )
      return deps.continuePrivate(runId, continuation.task);
    const { keychainAskId, react, pin, delete: del } = d.destination;
    if (keychainAskId) return deliverKeychainCard(core, client, d, channel, threadTs, deps.webUiPublicUrl);
    if (react) {
      const { failed } = await applyReactions(client, channel, react.messageTs, [react.emoji]);
      if (failed.length) throw refused(`reaction(s) failed: ${failed.join(", ")} (check reactions:write / message ts)`);
      return;
    }
    if (pin) {
      const args = { channel, timestamp: pin.messageTs };
      return settle(
        () => (pin.remove ? client.pins.remove(args) : client.pins.add(args)),
        SETTLED_PIN_ERRORS,
        `native ${pin.remove ? "unpin" : "pin"} failed`,
      );
    }
    if (del)
      return settle(
        () => client.chat.delete({ channel, ts: del.messageTs }),
        new Set(["message_not_found"]),
        "delete failed",
        " (own messages only)",
      );
    let editRef = d.destination.editRef;
    if (!editRef && runId) {
      const placeholder = await findPostedByKey(
        client,
        { channel, ...(threadTs ? { thread_ts: threadTs } : {}) },
        statusPlaceholderKey(runId),
        String(((d.createdAt ?? Date.now()) - STATUS_PLACEHOLDER_LOOKBACK_MS) / 1000),
      ).catch(swallowAs("slack: status-placeholder probe", undefined));
      if (placeholder) {
        await core.reportRunEditRef(runId, placeholder.ts);
        editRef = placeholder.ts;
      }
    }
    const { text, blocks } = bodyOf(
      d,
      toSlackMrkdwn(runId ? cleanAgentReplyForSlack(d.text).text : stripSlackDirectives(d.text)),
    );
    if (!text.trim() && !(blocks && d.attachments?.length)) {
      if (editRef)
        await client.chat
          .delete({ channel, ts: editRef })
          .catch(swallowAs("slack: delete status placeholder", undefined));
      await uploadOrNote(client, channel, threadTs, d);
      if (d.attachments?.length && threadTs) threads.mark(channel, threadTs, true);
      return;
    }
    const verifyOldest = recoveryVerifyOldest(d.createdAt, editRef);
    const unfurlLinks = runId ? false : d.destination.unfurlLinks;
    if (editRef) {
      try {
        const alreadyDelivered = d.attachments?.length
          ? await findPostedByKey(
              client,
              { channel, ...(threadTs ? { thread_ts: threadTs } : {}) },
              d.idempotencyKey,
              verifyOldest ?? String(Date.now() / 1000 - 60),
            ).catch(swallowAs("slack: delivered-marker probe", undefined))
          : undefined;
        await client.chat.update({
          channel,
          ts: editRef,
          text,
          ...(blocks ? { blocks } : {}),
          ...botIdentityArgs(),
          metadata: deliveryMetadata(d.idempotencyKey),
          ...(unfurlLinks !== undefined ? { unfurl_links: unfurlLinks, unfurl_media: unfurlLinks } : {}),
        });
        if (threadTs) threads.mark(channel, threadTs, true);
        if (!alreadyDelivered) await uploadOrNote(client, channel, threadTs, d);
        return;
      } catch (e) {
        swallow("slack: finalize recovered reply in place", e);
      }
    }
    const res = await postWithVerify(
      client,
      { ...slackReplyArgs(channel, text, threadTs, { unfurlLinks }), ...(blocks ? { blocks } : {}) },
      d.idempotencyKey,
      runId || d.retry ? { verifyFirst: true, ...(verifyOldest ? { verifyOldest } : {}) } : undefined,
    );
    const root = threadTs ?? (res?.ts ? String(res.ts) : undefined);
    if (root) threads.mark(channel, root, true);
    if (!res.reused) await uploadOrNote(client, channel, root, d);
  }

  async function postToPrincipal(d: Post): Promise<PostReceipt | void> {
    const client = deliveryClient(d.destination);
    const { keychainAskId, commandApprovalId, deploymentAccess, target, threadTs } = d.destination;
    if (keychainAskId) {
      const dm = await openConversationFor(client, [target]);
      return deliverKeychainCard(core, client, d, dm, threadTs, deps.webUiPublicUrl);
    }
    const commandApproval = commandApprovalId ? await core.getApproval(commandApprovalId) : null;
    const requester = approvalDeliveryRecipient(commandApproval?.request?.actor as { externalId?: string } | undefined);
    if (
      commandApprovalId &&
      (!commandApproval ||
        !requester ||
        !samePerson(requester, target) ||
        d.idempotencyKey !== approvalDeliveryKey(commandApprovalId, commandApproval))
    )
      return;
    let card = deploymentAccess ? deployAccessMessage(deploymentAccess, d.text) : undefined;
    if (commandApproval)
      card = approvalMessage([
        {
          ...commandApproval,
          reason: commandApproval.reason ?? "Approval required",
          ...(deps.webUiPublicUrl && commandApproval.sessionId
            ? {
                originUrl: `${deps.webUiPublicUrl.trim().replace(/\/+$/, "")}/s/${encodeURIComponent(commandApproval.sessionId)}`,
              }
            : {}),
        },
      ]);
    const draft = card?.text ?? toSlackMrkdwn(stripReactionDirectives(d.text));
    if (!draft.trim() && !d.attachments?.length) return;
    const channel = await openConversationFor(client, [target]);
    const body = bodyOf(d, draft);
    const { text } = body;
    const blocks = card?.blocks ?? body.blocks;
    let reused = false;
    if (text.trim() || blocks) {
      const posted = await postWithVerify(
        client,
        {
          ...slackReplyArgs(channel, text, threadTs, { unfurlLinks: d.destination.unfurlLinks }),
          ...(blocks ? { blocks } : {}),
        },
        d.idempotencyKey,
        d.retry ? { verifyFirst: true, verifyOldest: recoveryVerifyOldest(d.createdAt, undefined) } : undefined,
      );
      reused = Boolean(posted.reused);
    }
    if (!reused) await uploadOrNote(client, channel, threadTs, d);
    return { recipientThreadRef: dmThreadRef(channel, threadTs) };
  }

  return async (post) => {
    try {
      const receipt =
        post.destination.type === "principal" ? await postToPrincipal(post) : await postToConversation(post);
      const runId = runIdOf(post);
      if (runId && !receipt?.deferred)
        await core.taskAcknowledgements
          ?.finish(deliveryClient(post.destination), runId)
          .catch(swallowAs("slack: finish task acknowledgement", undefined));
      return receipt;
    } catch (err) {
      throw postError(err);
    }
  };
}
