import { withTenant } from "../tenant.ts";
import type { Outbound } from "./outbound.ts";
import type { TurnRequest, TurnResult } from "../types.ts";
import type { InboundMessage, InboundSurface, Surface, SurfaceRequest } from "./surface.ts";
import { surfaceContainerRef, surfaceDeliveryTarget, surfaceThreadRef } from "./refs.ts";

export interface SurfaceRegistry {
  get(name: string): Surface | undefined;
  label(name: string): string | undefined;
  receives(name: string): boolean;
  receive(name: string, request: SurfaceRequest): Promise<{ status: number; body: Record<string, unknown> }>;
}

export function inboundTurn(surface: InboundSurface, message: InboundMessage): TurnRequest | undefined {
  if (message.author.bot) return undefined;
  const { conversation } = message;
  if (conversation.kind !== "dm" && !message.mentionsSelf && !message.threadEngaged) return undefined;
  const actor = surface.principalFor(message.author);
  const ref = {
    surface: surface.name,
    account: message.account,
    kind: conversation.kind,
    container: conversation.key,
    ...(conversation.thread ? { thread: conversation.thread } : {}),
  };
  return {
    surface: surface.name,
    source: {
      account: message.account,
      workspaceId: message.account,
      userId: message.author.id,
      ...(conversation.thread ? { replyThread: conversation.thread } : {}),
    },
    actor,
    conversation: {
      kind: conversation.kind,
      threadRef: surfaceThreadRef(ref),
      ...(conversation.kind === "dm" ? {} : { channelRef: surfaceContainerRef(ref) }),
      ...(conversation.name ? { channelName: conversation.name } : {}),
      audience: (conversation.members?.length ? conversation.members : [message.author]).map((user) =>
        surface.principalFor(user),
      ),
      isPrivate: conversation.kind !== "channel",
    },
    text: [
      message.text,
      ...message.attachments.map((a) => `[attachment: ${a.name ?? a.id}${a.url ? ` ${a.url}` : ""}]`),
    ].join("\n"),
    deliveryTarget: surfaceDeliveryTarget(ref),
    idempotencyKey: `${surface.name}:${message.account}:${message.messageId}`,
    addressed: true,
    origin: { kind: "human" },
    ...(message.author.timezone ? { timezone: message.author.timezone } : {}),
    async: true,
  };
}

export function createSurfaceRegistry(deps: {
  surfaces: readonly Surface[];
  outbound: Pick<Outbound, "register">;
  turn: (request: TurnRequest) => Promise<Pick<TurnResult, "runId">>;
}): SurfaceRegistry {
  const byName = new Map<string, Surface>();
  const inbound = (name: string): InboundSurface | undefined => {
    const surface = byName.get(name);
    return surface && "normalize" in surface ? (surface as InboundSurface) : undefined;
  };
  const destinationTypes = new Set<string>();
  for (const surface of deps.surfaces) {
    if (byName.has(surface.name)) throw new Error(`chat surface names must be unique: ${surface.name}`);
    byName.set(surface.name, surface);
    for (const type of surface.destinationTypes) {
      if (destinationTypes.has(type)) throw new Error(`destination type ${type} has two chat surfaces`);
      destinationTypes.add(type);
    }
    deps.outbound.register(surface.destinationTypes, surface.deliver);
  }
  return {
    get: (name) => byName.get(name),
    label: (name) => byName.get(name)?.label,
    receives: (name) => inbound(name) !== undefined,
    async receive(name, request) {
      const surface = inbound(name);
      if (!surface) return { status: 404, body: { error: "not_found" } };
      const outcome = await surface.normalize(request);
      if (outcome.status !== 200) return { status: outcome.status, body: { error: outcome.reason } };
      const runs: string[] = [];
      for (const message of outcome.messages) {
        const turn = inboundTurn(surface, message);
        if (!turn) continue;
        const result = await withTenant(message.tenant, () => deps.turn(turn));
        if (result.runId) runs.push(result.runId);
      }
      return { status: 200, body: { ok: true, runs } };
    },
  };
}
