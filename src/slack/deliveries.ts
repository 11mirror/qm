import { escapeSlackText } from "./mrkdwn.ts";
import { extractPrivateContinuation } from "./external-access.ts";
import { deployAccessMessage } from "./deploy-access.ts";
import { approvalDeliveryKey, approvalDeliveryRecipient } from "../core/approval-store.ts";
import { samePerson } from "../directory/person.ts";
import { approvalMessage } from "./approval-cards.ts";
import { deliverKeychainCard } from "./keychain-approvals.ts";
import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import { performance } from "node:perf_hooks";
import {
  botIdentityArgs,
  createDeliveryTracker,
  createThreadTracker,
  deliverWithRetry,
  deliveryMetadata,
  dmThreadRef,
  openConversationFor,
  findPostedByKey,
  parseDeliveryTarget,
  statusPlaceholderKey,
  postWithVerify,
  recoveryVerifyOldest,
  slackReplyArgs,
  slackSectionBlocks,
  stripReactionDirectives,
  toSlackMrkdwn,
  uploadAttachments,
  uploadFailureNote,
  applyReactions,
  downloadSlackFile,
  type SlackFile,
} from "./lib.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { Delivery, SlackDeliveryProviderReceipt } from "../types.ts";
import type { TurnFlow } from "./turn-flow.ts";
import { cleanAgentReplyForSlack, stripSlackDirectives } from "./messaging.ts";
import { cronIdOf } from "../sessions/session-store.ts";
import { slackErrorCode } from "./payloads.ts";
import { createHash } from "node:crypto";
import { canonicalJson } from "../util/canonical-json.ts";

const DELIVERY_CLAIM_MS = 15_000;
const SLOW_DRAIN_ALARM_MS = 120_000;
const PERMANENT_POST_ERRORS = new Set([
  "channel_not_found",
  "is_archived",
  "account_inactive",
  "user_not_found",
  "cannot_reply_to_message",
  "message_not_found",
]);

const SETTLED_PIN_ERRORS = new Set(["already_pinned", "no_pin", "not_pinned"]);

const DELIVERY_CLAIM_MARGIN_MS = 2_000;

const RUN_RECOVERY_GRACE_MS = 15_000;
const STATUS_PLACEHOLDER_LOOKBACK_MS = 6 * 3_600_000;

function mergeSlackApiMs(body: unknown, slackApiMs: number | undefined): unknown {
  if (slackApiMs === undefined) return body;
  if (body == null) return { slackApiMs };
  if (typeof body === "object") return { ...(body as object), slackApiMs };
  return body;
}

function slackProviderReceipt(
  delivery: Delivery,
  action: SlackDeliveryProviderReceipt["action"],
  channelId: string,
  messageTs: string,
  renderedBodySha256: string,
  threadTs?: string,
  files?: Array<{ id: string; sha256: string }>,
): { providerReceipt: SlackDeliveryProviderReceipt } {
  return {
    providerReceipt: {
      provider: "slack",
      action,
      channelId,
      messageTs,
      renderedBodySha256,
      ...(threadTs ? { threadTs } : {}),
      ...(delivery.destination.slackAccountId ? { slackAccountId: delivery.destination.slackAccountId } : {}),
      ...(delivery.destination.slackTeamId ? { slackTeamId: delivery.destination.slackTeamId } : {}),
      ...(files ? { files } : {}),
    },
  };
}

function slackRequestSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createDeliveryPoller(deps: {
  clientForAccount?: (accountId: string, teamId?: string) => any;
  externalNamespace?: (accountId: string) => string | undefined;
  continuePrivate?: (runId: string, task: string) => Promise<void>;
  core: SlackCoreClient;
  webUiPublicUrl?: string;
  flow: TurnFlow;
  threads: ReturnType<typeof createThreadTracker>;
  clientForIdentity(identity: string): any;
  downloadRecoveredFile?: (client: any, file: SlackFile) => Promise<Uint8Array>;
  claimMs?: number;
  slowDrainMs?: number;
}): { pollDeliveries(client: any): Promise<boolean> } {
  const { core, flow, threads, clientForIdentity } = deps;
  const downloadRecoveredFile =
    deps.downloadRecoveredFile ??
    ((client: any, file: SlackFile) =>
      downloadSlackFile(file, {
        token: client.token,
        ...(client.slackApiUrl ? { trustedHost: new URL(client.slackApiUrl).hostname } : {}),
      }));
  const claimMs = deps.claimMs ?? DELIVERY_CLAIM_MS;
  const slowDrainMs = deps.slowDrainMs ?? SLOW_DRAIN_ALARM_MS;
  const claimMargin = Math.min(DELIVERY_CLAIM_MARGIN_MS, Math.floor(claimMs / 3));
  const recoveredRow = (d: Delivery): boolean => typeof d.createdAt === "number" && Date.now() - d.createdAt > claimMs;
  const { inFlightRuns } = flow;

  async function drainClaimed(
    types: string[],
    deliver: (d: Delivery) => Promise<void>,
    leaseLost?: () => boolean,
  ): Promise<number> {
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    const expiresAt = new Map<string, number>();

    const claim = async (): Promise<{ rows: Delivery[]; complete: boolean }> => {
      const rows: Delivery[] = [];
      let complete = true;
      for (const t of types) {
        try {
          const claimed = await core.claimDeliveries(t, claimMs);
          const at = Date.now();
          for (const r of claimed) expiresAt.set(r.id, at + claimMs);
          rows.push(...claimed);
        } catch {
          complete = false;
        }
      }
      return { rows, complete };
    };
    const t0 = Date.now();
    const queue = (await claim()).rows;
    const seen = new Set(queue.map((d) => d.id));
    const absorb = (fresh: Delivery[]): void => {
      for (const f of fresh) {
        if (!seen.has(f.id)) {
          seen.add(f.id);
          queue.push(f);
        }
      }
    };

    const reclaimOwnership = async (id: string): Promise<boolean> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (leaseLost?.()) return false;
        if (attempt > 0) await sleep(Math.min(300, claimMargin));
        const { rows, complete } = await claim();
        absorb(rows);
        if (rows.some((f) => f.id === id)) return true;
        if (!complete) continue;
      }
      return false;
    };
    for (let i = 0; i < queue.length; i++) {
      if (leaseLost?.()) {
        console.error("[slack-plugin] delivery dispatch lease lost mid-drain — stopping; rows recover after claim TTL");
        return queue.length;
      }
      const d = queue[i]!;
      const exp = expiresAt.get(d.id) ?? 0;
      if (Date.now() >= exp - claimMargin) {
        const remaining = exp - Date.now();
        if (remaining > 0) await sleep(remaining);
        if (!(await reclaimOwnership(d.id))) {
          seen.delete(d.id);
          console.log(
            `[slack-plugin] delivery ${d.id} claim lost after ${Date.now() - t0}ms (another relay owns it, or it was acked) — skipping`,
          );
          continue;
        }
      }
      if (leaseLost?.()) {
        console.error("[slack-plugin] delivery dispatch lease lost mid-drain — stopping; rows recover after claim TTL");
        return queue.length;
      }
      await deliver(d);
    }
    return queue.length;
  }

  const ackDelivery = (id: string, body?: unknown): Promise<void> =>
    core.ackDelivery(
      id,
      body as
        | { recipientThreadRef?: string; slackApiMs?: number; providerReceipt?: SlackDeliveryProviderReceipt }
        | undefined,
    );

  function deliveryFooter(d: Delivery): Array<Record<string, unknown>> {
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

  const deliveryTracker = createDeliveryTracker();
  const undeliverableReported = new Set<string>();

  const logDeliveryError =
    (id: string) =>
    (stage: "post" | "ack", err: unknown, gaveUp: boolean): void => {
      const code = slackErrorCode(err);
      if (stage === "post" && gaveUp && code && PERMANENT_POST_ERRORS.has(code) && !undeliverableReported.has(id)) {
        if (undeliverableReported.size >= 5000) undeliverableReported.clear();
        undeliverableReported.add(id);
        void core
          .reportDeliveryUndeliverable?.(id, code)
          .catch(swallowAs("slack-plugin: undeliverable report", undefined));
      }
      console.error(
        `[slack-plugin] delivery ${id} ${stage} failed${gaveUp ? " (giving up)" : ""}:`,
        (err as Error).message,
      );
    };

  function deliveryClient(defaultClient: any, destination: Delivery["destination"]): any {
    if (deps.clientForAccount)
      return deps.clientForAccount(destination.slackAccountId ?? "default", destination.slackTeamId);
    return destination.slackAccountId ? undefined : defaultClient;
  }

  async function deliverToConversations(defaultClient: any, leaseLost?: () => boolean): Promise<number> {
    return drainClaimed(
      ["slack", "group"],
      async (d) => {
        const destinationClient = deliveryClient(defaultClient, d.destination);
        if (!destinationClient) return;
        const client = destinationClient;
        const runId = d.idempotencyKey?.startsWith("run:") ? d.idempotencyKey.slice("run:".length) : undefined;
        const namespace = deps.externalNamespace?.(d.destination.slackAccountId ?? "default");
        if (
          namespace &&
          (parseDeliveryTarget(d.destination.target).channel.startsWith("D")
            ? runId && d.destination.slackPolicyNamespace !== namespace
            : !d.provenance?.sourceThreadRef.startsWith(`${namespace}:`))
        ) {
          await ackDelivery(d.id);
          return;
        }
        if (runId && inFlightRuns.has(runId)) return;
        if (runId && typeof d.createdAt === "number" && Date.now() - d.createdAt < RUN_RECOVERY_GRACE_MS) return;
        let slackApiMs: number | undefined;
        await deliverWithRetry({
          tracker: deliveryTracker,
          id: d.id,
          post: async () => {
            const tPost = performance.now();
            try {
              const continuation = extractPrivateContinuation(d.text);
              if (
                runId &&
                continuation.task &&
                d.provenance?.sourceThreadRef.startsWith("external-slack:") &&
                deps.continuePrivate
              ) {
                await deps.continuePrivate(runId, continuation.task);
                return undefined;
              }
              const postClient = d.destination.identity ? clientForIdentity(d.destination.identity) : client;
              const { channel, threadTs } = parseDeliveryTarget(d.destination.target);
              if (d.destination.keychainAskId) {
                await deliverKeychainCard(core, client, d, channel, threadTs, deps.webUiPublicUrl);
                return undefined;
              }
              if (d.destination.react) {
                const { messageTs, emoji } = d.destination.react;
                const { failed } = await applyReactions(client, channel, messageTs, [emoji]);
                if (failed.length)
                  console.error(
                    `[slack-plugin] delivery ${d.id} reaction(s) failed: ${failed.join(", ")} (check reactions:write / message ts)`,
                  );
                return undefined;
              }
              if (d.destination.pin) {
                const { messageTs, remove } = d.destination.pin;
                try {
                  if (remove) await client.pins.remove({ channel, timestamp: messageTs });
                  else await client.pins.add({ channel, timestamp: messageTs });
                } catch (err) {
                  const code = slackErrorCode(err);
                  if (!code || !SETTLED_PIN_ERRORS.has(code)) {
                    console.error(
                      `[slack-plugin] delivery ${d.id} native ${remove ? "unpin" : "pin"} failed: ${code ?? (err as Error).message}`,
                    );
                  }
                }
                return undefined;
              }
              if (d.destination.delete) {
                const { messageTs } = d.destination.delete;
                try {
                  await client.chat.delete({ channel, ts: messageTs });
                } catch (err) {
                  const code = slackErrorCode(err);
                  if (code !== "message_not_found") {
                    console.error(
                      `[slack-plugin] delivery ${d.id} delete failed: ${code ?? (err as Error).message} (own messages only)`,
                    );
                  }
                }
                return undefined;
              }
              let editRef = d.destination.editRef;
              if (!editRef && runId) {
                const placeholder = await findPostedByKey(
                  client,
                  { channel, ...(threadTs ? { thread_ts: threadTs } : {}) },
                  statusPlaceholderKey(runId),
                  String((d.createdAt - STATUS_PLACEHOLDER_LOOKBACK_MS) / 1000),
                ).catch(swallowAs("slack: status-placeholder probe", undefined));
                if (placeholder) {
                  await core.reportRunEditRef(runId, placeholder.ts);
                  editRef = placeholder.ts;
                }
              }
              let text = toSlackMrkdwn(runId ? cleanAgentReplyForSlack(d.text).text : stripSlackDirectives(d.text));
              const replayAttachments = async (
                root?: string,
              ): Promise<
                | {
                    messageTs?: string;
                    files: Array<{ id: string; sha256: string }>;
                    renderedBodySha256: string;
                  }
                | undefined
              > => {
                if (!d.attachments?.length) return undefined;
                try {
                  const uploaded = await uploadAttachments(client, channel, root, d.attachments, core);
                  return uploaded.uploaded && uploaded.files.length === d.attachments.length ? uploaded : undefined;
                } catch (err) {
                  console.error(
                    "%s",
                    `[slack-plugin] delivery ${d.id} attachment upload failed:`,
                    (err as Error).message,
                  );
                  await client.chat
                    .postMessage(slackReplyArgs(channel, uploadFailureNote(err), root))
                    .catch(swallowAs("slack: post upload-failure note", undefined));
                  return undefined;
                }
              };
              const recoverAttachmentEvidence = async (
                observed: Array<{ id: string; name: string }> | undefined,
              ): Promise<Array<{ id: string; sha256: string }> | undefined> => {
                if (!d.attachments?.length) return [];
                const remaining = [...(observed ?? [])];
                const files: Array<{ id: string; sha256: string }> = [];
                for (const attachment of d.attachments) {
                  let bytes: Buffer;
                  try {
                    bytes = await core.readBlob(attachment.blobId);
                  } catch (error) {
                    if (!attachment.artifactId || !attachment.artifactViewerId) throw error;
                    bytes = await core.readFileArtifact(attachment.artifactId, attachment.artifactViewerId);
                  }
                  const intendedSha256 = createHash("sha256").update(bytes).digest("hex");
                  let matchedIndex = -1;
                  for (const [index, observedFile] of remaining.entries()) {
                    if (observedFile.name !== attachment.name) continue;
                    const info = (await client.files.info({ file: observedFile.id })) as { file?: SlackFile };
                    const providerFile = info.file;
                    if (!providerFile || providerFile.id !== observedFile.id || providerFile.name !== attachment.name)
                      continue;
                    const providerBytes = await downloadRecoveredFile(client, providerFile);
                    if (createHash("sha256").update(providerBytes).digest("hex") === intendedSha256) {
                      matchedIndex = index;
                      files.push({ id: observedFile.id, sha256: intendedSha256 });
                      break;
                    }
                  }
                  if (matchedIndex < 0) return undefined;
                  remaining.splice(matchedIndex, 1);
                }
                return remaining.length ? undefined : files;
              };
              const exactMessage = async (
                messageTs: string,
              ): Promise<
                | {
                    ts?: string;
                    files?: Array<{ id?: string; name?: string }>;
                    metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
                  }
                | undefined
              > => {
                const paging = {
                  channel,
                  limit: 1,
                  include_all_metadata: true,
                  oldest: messageTs,
                  latest: messageTs,
                  inclusive: true,
                };
                const page = threadTs
                  ? await client.conversations.replies({ ...paging, ts: threadTs })
                  : await client.conversations.history(paging);
                return (
                  page as {
                    messages?: Array<{
                      ts?: string;
                      files?: Array<{ id?: string; name?: string }>;
                      metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
                    }>;
                  }
                ).messages?.find((message) => message.ts === messageTs);
              };
              const recoverEditedAttachments = async (): Promise<
                | {
                    messageTs?: string;
                    files?: Array<{ id: string; sha256: string }>;
                  }
                | undefined
              > => {
                if (!editRef || !d.attachments?.length) return undefined;
                const edited = await exactMessage(editRef);
                const payload = edited?.metadata?.event_payload;
                if (
                  edited?.metadata?.event_type !== "qm_delivery" ||
                  payload?.idempotency_key !== (d.idempotencyKey ?? d.id)
                )
                  return undefined;
                const messageTs = payload.file_message_ts;
                if (typeof messageTs !== "string") return {};
                const fileMessage = await exactMessage(messageTs);
                const observed = fileMessage?.files?.flatMap((file) =>
                  file.id && file.name ? [{ id: file.id, name: file.name }] : [],
                );
                return { messageTs, files: await recoverAttachmentEvidence(observed) };
              };
              const editMetadata = (fileMessageTs?: string) => {
                const metadata = deliveryMetadata(d.idempotencyKey ?? d.id);
                return fileMessageTs
                  ? {
                      ...metadata,
                      event_payload: { ...metadata.event_payload, file_message_ts: fileMessageTs },
                    }
                  : metadata;
              };
              const messageFooter = deliveryFooter(d);
              if (!text.trim() && !messageFooter.length && d.attachments?.length) text = "Files attached.";
              const footer = [
                ...messageFooter,
                ...(d.destination.debugFooter ? [{ type: "mrkdwn", text: d.destination.debugFooter }] : []),
              ];
              const footerBlocks = footer.length
                ? [...(text.trim() ? slackSectionBlocks(text) : []), { type: "context", elements: footer }]
                : undefined;
              if (!text.trim() && !(messageFooter.length && d.attachments?.length)) {
                if (editRef) {
                  await client.chat
                    .delete({ channel, ts: editRef })
                    .catch(swallowAs("slack: delete status placeholder", undefined));
                }
                const uploaded = await replayAttachments(threadTs);
                if (d.attachments?.length && threadTs) threads.mark(channel, threadTs, true);
                return uploaded?.messageTs
                  ? slackProviderReceipt(
                      d,
                      "attachments",
                      channel,
                      uploaded.messageTs,
                      uploaded.renderedBodySha256,
                      threadTs,
                      uploaded.files,
                    )
                  : undefined;
              }
              const verifyOldest = recoveryVerifyOldest(
                typeof d.createdAt === "number" ? d.createdAt : undefined,
                editRef,
              );
              if (editRef) {
                const unfurlLinks = runId ? false : d.destination.unfurlLinks;
                const recovered = await recoverEditedAttachments();
                if (recovered && !recovered.files) throw new Error("Recovered Slack attachment evidence is incomplete");
                let updateArgs = {
                  channel,
                  ts: editRef,
                  text,
                  ...(footerBlocks ? { blocks: footerBlocks } : {}),
                  ...botIdentityArgs(),
                  metadata: editMetadata(recovered?.messageTs),
                  ...(unfurlLinks !== undefined ? { unfurl_links: unfurlLinks, unfurl_media: unfurlLinks } : {}),
                };
                let updated = false;
                try {
                  await client.chat.update(updateArgs);
                  updated = true;
                } catch (e) {
                  swallow("slack: finalize recovered reply in place", e);
                }
                if (updated) {
                  if (threadTs) threads.mark(channel, threadTs, true);
                  const uploaded = recovered ? undefined : await replayAttachments(threadTs);
                  if (d.attachments?.length && !recovered && !uploaded) return undefined;
                  if (uploaded?.messageTs) {
                    updateArgs = { ...updateArgs, metadata: editMetadata(uploaded.messageTs) };
                    await client.chat.update(updateArgs);
                  }
                  return slackProviderReceipt(
                    d,
                    "update",
                    channel,
                    editRef,
                    slackRequestSha256(updateArgs),
                    threadTs,
                    recovered?.files ?? uploaded?.files,
                  );
                }
              }
              const postArgs = {
                ...slackReplyArgs(channel, text, threadTs, {
                  unfurlLinks: runId ? false : d.destination.unfurlLinks,
                }),
                ...(footerBlocks ? { blocks: footerBlocks } : {}),
              };
              const res = await postWithVerify(
                postClient,
                postArgs,
                d.idempotencyKey ?? d.id,
                runId || recoveredRow(d)
                  ? {
                      verifyFirst: true,
                      ...(verifyOldest ? { verifyOldest } : {}),
                      ...(d.attachments?.length ? { recoverFiles: true } : {}),
                    }
                  : undefined,
              );
              const root = threadTs ?? (res?.ts ? String(res.ts) : undefined);
              if (root) threads.mark(channel, root, true);
              const recoveredFiles =
                res.reused && res.files?.length ? await recoverAttachmentEvidence(res.files) : undefined;
              const uploaded = !res.reused || res.files?.length === 0 ? await replayAttachments(root) : undefined;
              const providerFiles = res.reused ? (recoveredFiles ?? uploaded?.files) : uploaded?.files;
              if (!res.ts || res.parts?.length) return undefined;
              if (d.attachments?.length && !providerFiles) {
                if (res.reused) throw new Error("Recovered Slack attachment evidence is incomplete");
                return undefined;
              }
              return slackProviderReceipt(
                d,
                "post",
                res.channel,
                res.ts,
                slackRequestSha256(postArgs),
                threadTs,
                providerFiles,
              );
            } finally {
              slackApiMs = Math.round(performance.now() - tPost);
            }
          },
          ack: async (body) => {
            if (runId) await core.taskAcknowledgements?.finish(client, runId);
            return ackDelivery(d.id, mergeSlackApiMs(body, slackApiMs));
          },
          onError: logDeliveryError(d.id),
        });
      },
      leaseLost,
    );
  }

  async function deliverToPrincipals(defaultClient: any, leaseLost?: () => boolean): Promise<number> {
    return drainClaimed(
      ["principal"],
      async (d) => {
        const client = deliveryClient(defaultClient, d.destination);
        if (!client) return;
        let slackApiMs: number | undefined;
        await deliverWithRetry({
          tracker: deliveryTracker,
          id: d.id,
          post: async () => {
            const tPost = performance.now();
            try {
              if (d.destination.keychainAskId) {
                const dm = await openConversationFor(client, [d.destination.target]);
                await deliverKeychainCard(core, client, d, dm, d.destination.threadTs, deps.webUiPublicUrl);
                return undefined;
              }
              const commandApproval = d.destination.commandApprovalId
                ? await core.getApproval(d.destination.commandApprovalId)
                : null;
              const requester = approvalDeliveryRecipient(
                commandApproval?.request?.actor as { externalId?: string } | undefined,
              );
              if (
                d.destination.commandApprovalId &&
                (!commandApproval ||
                  !requester ||
                  !samePerson(requester, d.destination.target) ||
                  d.idempotencyKey !== approvalDeliveryKey(d.destination.commandApprovalId, commandApproval))
              )
                return undefined;
              let card: { text: string; blocks: Array<Record<string, unknown>> } | null = null;
              if (d.destination.deploymentAccess) card = deployAccessMessage(d.destination.deploymentAccess, d.text);
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
              let text = card?.text ?? toSlackMrkdwn(stripReactionDirectives(d.text));
              if (!text.trim() && !d.attachments?.length) return undefined;
              const channel = await openConversationFor(client, [d.destination.target]);
              const threadTs = d.destination.threadTs;
              const footer = deliveryFooter(d);
              if (!text.trim() && !footer.length && d.attachments?.length) text = "Files attached.";
              const blocks =
                card?.blocks ??
                (footer.length
                  ? [...(text.trim() ? slackSectionBlocks(text) : []), { type: "context", elements: footer }]
                  : undefined);
              let uploadError: unknown;
              let reused = false;
              if (text.trim() || blocks) {
                const posted = await postWithVerify(
                  client,
                  {
                    ...slackReplyArgs(channel, text, threadTs, { unfurlLinks: d.destination.unfurlLinks }),
                    ...(blocks ? { blocks } : {}),
                  },
                  d.idempotencyKey ?? d.id,
                  recoveredRow(d)
                    ? { verifyFirst: true, verifyOldest: String((d.createdAt! - 5_000) / 1000) }
                    : undefined,
                );
                reused = Boolean(posted.reused);
              }
              if (d.attachments?.length && !reused) {
                try {
                  await uploadAttachments(client, channel, threadTs, d.attachments, core);
                } catch (error) {
                  uploadError = error;
                  console.error(
                    `[slack-plugin] principal delivery ${d.id} attachment upload failed:`,
                    errMessage(error),
                  );
                }
              }
              if (uploadError) {
                await client.chat
                  .postMessage(slackReplyArgs(channel, uploadFailureNote(uploadError), threadTs))
                  .catch(swallowAs("slack: post principal upload-failure note", undefined));
              }
              return {
                recipientThreadRef: dmThreadRef(channel, threadTs),
              };
            } finally {
              slackApiMs = Math.round(performance.now() - tPost);
            }
          },
          ack: (body) => ackDelivery(d.id, mergeSlackApiMs(body, slackApiMs)),
          onError: logDeliveryError(d.id),
        });
      },
      leaseLost,
    );
  }

  async function pollDeliveries(client: any): Promise<boolean> {
    const ran = await core.holdDeliveryDispatch(async (lost) => {
      let lostFlag = false;
      void lost.then(() => {
        lostFlag = true;
      });
      const leaseLost = (): boolean => lostFlag;
      const cycleStart = Date.now();
      const rowCounts = await Promise.all([
        deliverToConversations(client, leaseLost),
        deliverToPrincipals(client, leaseLost),
      ]);
      if (!lostFlag)
        await core.taskAcknowledgements
          ?.reconcile(client)
          .catch(swallowAs("slack: task ack reconciliation", undefined));
      const cycleMs = Date.now() - cycleStart;
      if (cycleMs >= slowDrainMs) {
        void core
          .reportSlowDeliveryDrain?.({ durationMs: cycleMs, rows: rowCounts.reduce((a, b) => a + b, 0) })
          .catch(swallowAs("slack-plugin: slow-drain report", undefined));
      }

      return !lostFlag;
    });
    return ran === true;
  }

  return { pollDeliveries };
}
