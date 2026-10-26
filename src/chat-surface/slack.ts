import type { ExternalSlackAccess } from "../slack/external-access.ts";
import type { SlackEventsHandler } from "../slack/http-events.ts";
import type { SurfaceSender } from "../surfaces/outbound.ts";
import type { ActorAssertion } from "../types.ts";
import type { Surface, SurfaceUser } from "./surface.ts";

interface SlackAccountHandle {
  client: any;
  teamId: string;
  policy?: ExternalSlackAccess;
  inFlightRuns?: { add(id: string): void; delete(id: string): void; has(id: string): boolean };
}

export interface SlackNative {
  accounts: Map<string, SlackAccountHandle>;
  attach(sender: SurfaceSender): () => void;
  serveEvents(account: string, handler: SlackEventsHandler): () => void;
  events(account: string): SlackEventsHandler | undefined;
}

export interface SlackSurface extends Surface {
  readonly slack: SlackNative;
}

export function createSlackSurface(): SlackSurface {
  const accounts = new Map<string, SlackAccountHandle>();
  let senders: SurfaceSender[] = [];
  const events = new Map<string, SlackEventsHandler>();
  const slack: SlackNative = {
    accounts,
    attach(sender) {
      senders = [...senders, sender];
      return () => {
        senders = senders.filter((s) => s !== sender);
      };
    },
    serveEvents(account, handler) {
      events.set(account, handler);
      return () => {
        if (events.get(account) === handler) events.delete(account);
      };
    },
    events: (account) => events.get(account),
  };
  return {
    kind: "slack",
    name: "slack",
    label: "Slack",
    destinationTypes: ["slack", "group", "principal"],
    capabilities: { threads: true, edits: true, reactions: true, richCards: true, format: "mrkdwn" },
    slack,
    async deliver(ctx, item) {
      const sender = senders.at(-1);
      if (!sender) throw new Error(`no ${ctx.destination.type} connection is available to post this message`);
      return sender({
        destination: ctx.destination,
        text: item.text,
        ...(item.attachments ? { attachments: item.attachments } : {}),
        idempotencyKey: ctx.idempotencyKey,
        ...(ctx.provenance ? { provenance: ctx.provenance } : {}),
        ...(ctx.createdAt !== undefined ? { createdAt: ctx.createdAt } : {}),
        ...(ctx.retry ? { retry: true } : {}),
      });
    },
    principalFor(user: SurfaceUser): ActorAssertion {
      return {
        externalId: user.email?.trim() || `slack:${user.id}`,
        ...(user.guest ? { isExternalGuest: true } : {}),
        ...(user.bot ? { isBot: true } : {}),
        ...(user.displayName ? { displayName: user.displayName } : {}),
      };
    },
    native(kind) {
      return kind === "slack" ? slack : null;
    },
  };
}
