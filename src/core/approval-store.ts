import { swallowAs } from "../util/errors.ts";
import { type PendingApprovalRecord, sourceDestination, type TurnRequest, turnSource } from "../types.ts";
import type { SurfaceRegistry } from "../chat-surface/registry.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { Outbound } from "../surfaces/outbound.ts";
import { principalDestination } from "../reach/reach.ts";

export function approvalDeliveryKey(id: string, record: Pick<PendingApprovalRecord, "createdAt">): string {
  return `command-approval:${id}:${record.createdAt ?? 0}`;
}

export function approvalDeliveryRecipient(actor: { externalId?: string } | undefined): string | undefined {
  const id = actor?.externalId;
  return id && !id.startsWith("system:") ? id : undefined;
}

export function createApprovalStore(
  backing: DurableMap<PendingApprovalRecord>,
  outbound: Pick<Outbound, "send">,
  opts: { surfaces?: Pick<SurfaceRegistry, "get">; webSessionUrl?: (sessionId: string) => string | undefined } = {},
) {
  async function deliverText(id: string, record: PendingApprovalRecord, request: TurnRequest): Promise<void> {
    if (!request.deliveryTarget) return;
    const url = record.sessionId ? opts.webSessionUrl?.(record.sessionId) : undefined;
    await outbound.send({
      destination: { type: request.surface, target: request.deliveryTarget, ...sourceDestination(turnSource(request)) },
      text: [
        `Approval needed: ${record.summary ?? record.command}`,
        url ? `Approve or deny it here: ${url}` : "Approve or deny it in the web app.",
      ].join("\n"),
      idempotencyKey: approvalDeliveryKey(id, record),
    });
  }

  async function deliver(id: string, record: PendingApprovalRecord): Promise<void> {
    const request = record.request;
    if (!request?.surface) return;
    if (request.surface !== "slack") {
      if (opts.surfaces?.get(request.surface)) await deliverText(id, record, request);
      return;
    }
    const actorId = approvalDeliveryRecipient(request.actor);
    if (!actorId) return;
    const source = turnSource(request);
    const threadTs = request.conversation?.kind === "dm" ? source?.replyThread : undefined;
    await outbound.send({
      destination: {
        ...principalDestination(actorId, actorId),
        commandApprovalId: id,
        ...(threadTs ? { threadTs } : {}),
        ...(source ? { account: source.account, workspaceId: source.workspaceId } : {}),
      },
      text: `Approval needed: ${record.summary ?? record.command}`,
      idempotencyKey: approvalDeliveryKey(id, record),
    });
  }
  return {
    ...backing,
    async put(id: string, record: PendingApprovalRecord): Promise<void> {
      await backing.put(id, record);
      await deliver(id, record).catch(swallowAs("approvals: post approval request (the sweep retries)", undefined));
    },
    async deliverPending(): Promise<void> {
      for (const [id, record] of await backing.entries())
        await deliver(id, record).catch(swallowAs("approvals: post approval request (the sweep retries)", undefined));
    },
  };
}
