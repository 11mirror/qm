import { createHash } from "node:crypto";
import { canonicalJson } from "../util/canonical-json.ts";
import { parseDeliveryTarget } from "../slack/delivery.ts";
import type { Delivery, SlackDeliveryProviderReceipt } from "../types.ts";

const ACTIONS = new Set(["post", "update", "attachments"]);
const SLACK_DESTINATIONS = new Set(["slack", "group"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalNonblank(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return nonblank(value) ? value : null;
}

function optionalFiles(value: unknown): Array<{ id: string; sha256: string }> | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const files: Array<{ id: string; sha256: string }> = [];
  for (const file of value) {
    if (!file || typeof file !== "object" || Array.isArray(file)) return null;
    const input = file as Record<string, unknown>;
    if (!nonblank(input.id) || typeof input.sha256 !== "string" || !SHA256_PATTERN.test(input.sha256)) return null;
    files.push({ id: input.id, sha256: input.sha256 });
  }
  if (new Set(files.map(({ id }) => id)).size !== files.length) return null;
  return files;
}

export function parseSlackProviderReceipt(value: unknown): SlackDeliveryProviderReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.provider !== "slack" || !nonblank(input.action) || !ACTIONS.has(input.action)) return null;
  if (!nonblank(input.channelId) || !nonblank(input.messageTs)) return null;
  const threadTs = optionalNonblank(input.threadTs);
  const slackAccountId = optionalNonblank(input.slackAccountId);
  const slackTeamId = optionalNonblank(input.slackTeamId);
  const files = optionalFiles(input.files);
  if (
    threadTs === null ||
    slackAccountId === null ||
    slackTeamId === null ||
    typeof input.renderedBodySha256 !== "string" ||
    !SHA256_PATTERN.test(input.renderedBodySha256) ||
    files === null
  )
    return null;
  return {
    provider: "slack",
    action: input.action as SlackDeliveryProviderReceipt["action"],
    channelId: input.channelId,
    messageTs: input.messageTs,
    renderedBodySha256: input.renderedBodySha256,
    ...(threadTs ? { threadTs } : {}),
    ...(slackAccountId ? { slackAccountId } : {}),
    ...(slackTeamId ? { slackTeamId } : {}),
    ...(files ? { files } : {}),
  };
}

export function validateSlackProviderReceipt(delivery: Delivery, value: unknown): SlackDeliveryProviderReceipt | null {
  if (!SLACK_DESTINATIONS.has(delivery.destination.type)) return null;
  const receipt = parseSlackProviderReceipt(value);
  if (!receipt) return null;
  const target = parseDeliveryTarget(delivery.destination.target);
  if (receipt.channelId !== target.channel || receipt.threadTs !== target.threadTs) return null;
  if (receipt.slackAccountId !== delivery.destination.slackAccountId) return null;
  if (receipt.slackTeamId !== delivery.destination.slackTeamId) return null;
  if (delivery.destination.editRef) {
    if (receipt.action !== "update" || receipt.messageTs !== delivery.destination.editRef) return null;
  } else if (receipt.action === "update") return null;
  if (receipt.action === "attachments" && (!delivery.attachments?.length || delivery.text.trim())) return null;
  const attachmentCount = delivery.attachments?.length ?? 0;
  if (attachmentCount === 0 && receipt.files !== undefined) return null;
  if (attachmentCount > 0 && receipt.files?.length !== attachmentCount) return null;
  return receipt;
}

export function deliveryAttestationEvidence(
  delivery: Delivery,
  input: { issuedAt: number; audienceServerId: string; attestationKeyId: string },
): { claims: Record<string, unknown>; outputReceipts: string[] } | null {
  if (delivery.deliveredAt === null) return null;
  const providerReceipt = validateSlackProviderReceipt(delivery, delivery.providerReceipt);
  if (!providerReceipt) return null;
  const matchingRefs = (delivery.provenance?.mcpEvidenceRefs ?? []).filter(
    (ref) => ref.serverId === input.audienceServerId,
  );
  if (!matchingRefs.length) return null;
  const outputSha256 = createHash("sha256").update(delivery.text).digest("hex");
  const mcpEvidenceRefs: Array<{
    serverId: string;
    callId: string;
    outputReceiptSha256: string;
    outputSha256: string;
    contextSha256: string;
  }> = [];
  const outputReceipts: string[] = [];
  for (const ref of matchingRefs) {
    const refOutputSha256 = ref.outputSha256;
    const refContextSha256 = ref.contextSha256;
    if (
      !nonblank(ref.callId) ||
      !nonblank(ref.outputReceipt) ||
      !SHA256_PATTERN.test(ref.outputReceiptSha256) ||
      typeof refOutputSha256 !== "string" ||
      !SHA256_PATTERN.test(refOutputSha256) ||
      typeof refContextSha256 !== "string" ||
      !SHA256_PATTERN.test(refContextSha256) ||
      refOutputSha256 !== outputSha256 ||
      createHash("sha256").update(ref.outputReceipt).digest("hex") !== ref.outputReceiptSha256
    )
      return null;
    mcpEvidenceRefs.push({
      serverId: ref.serverId,
      callId: ref.callId,
      outputReceiptSha256: ref.outputReceiptSha256,
      outputSha256: refOutputSha256,
      contextSha256: refContextSha256,
    });
    outputReceipts.push(ref.outputReceipt);
  }
  const attachmentMetadataSha256 = createHash("sha256")
    .update(canonicalJson(delivery.attachments ?? []))
    .digest("hex");
  return {
    claims: {
      kind: "qm.slack-delivery-attestation",
      version: 1,
      deliveryId: delivery.id,
      idempotencyKey: delivery.idempotencyKey,
      destinationType: delivery.destination.type,
      providerReceipt,
      mcpEvidenceRefs,
      attachmentMetadataSha256,
      requestedBodySha256: createHash("sha256")
        .update(canonicalJson({ text: delivery.text, attachments: delivery.attachments ?? [] }))
        .digest("hex"),
      acknowledgedAt: delivery.deliveredAt,
      issuedAt: input.issuedAt,
      audienceServerId: input.audienceServerId,
      attestationKeyId: input.attestationKeyId,
    },
    outputReceipts,
  };
}
