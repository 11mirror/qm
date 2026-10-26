import type { ExternalSlackAccess } from "../slack/external-access.ts";
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
}

export interface SlackSurface extends Surface {
  readonly slack: SlackNative;
}

export function createSlackSurface(): SlackSurface {
  const accounts = new Map<string, SlackAccountHandle>();
  let senders: SurfaceSender[] = [];
  const slack: SlackNative = {
    accounts,
    attach(sender) {
      senders = [...senders, sender];
      return () => {
        senders = senders.filter((s) => s !== sender);
      };
    },
  };
  return {
    name: "slack",
    label: "Slack",
    destinationTypes: ["slack", "group", "principal"],
    slack,
    async deliver(post) {
      const sender = senders.at(-1);
      if (!sender) throw new Error(`no ${post.destination.type} connection is available to post this message`);
      return sender(post);
    },
    principalFor(user: SurfaceUser): ActorAssertion {
      return {
        externalId: user.email?.trim() || `slack:${user.id}`,
        ...(user.guest ? { isExternalGuest: true } : {}),
        ...(user.bot ? { isBot: true } : {}),
        ...(user.displayName ? { displayName: user.displayName } : {}),
      };
    },
  };
}
