import type { ExternalSlackAccess } from "../slack/external-access.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { perTenant } from "../tenant.ts";
import type { SurfaceSender } from "./outbound.ts";
import { surfaceProfile, type Surface } from "./surface.ts";

interface SlackAccountHandle {
  client: any;
  teamId: string;
  policy?: ExternalSlackAccess;
  inFlightRuns?: { add(id: string): void; delete(id: string): void; has(id: string): boolean };
}

export interface SlackEventsEndpoint {
  signingSecret: string;
  dispatch(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): Promise<void>;
}

export interface SlackDemand {
  signingSecret(account: string): string | undefined;
  ready(): Promise<void>;
}

export interface SlackNative {
  readonly accounts: Map<string, SlackAccountHandle>;
  attach(sender: SurfaceSender): () => void;
  serveEvents(account: string, endpoint: SlackEventsEndpoint): () => void;
  events(account: string): SlackEventsEndpoint | undefined;
  signingSecret(account: string): string | undefined;
  ready(): Promise<void>;
  onDemand(demand: SlackDemand): void;
}

export interface SlackSurface extends Surface {
  readonly slack: SlackNative;
}

export function createSlackSurface(): SlackSurface {
  const state = perTenant(() => ({
    accounts: new Map<string, SlackAccountHandle>(),
    senders: [] as SurfaceSender[],
    events: new Map<string, SlackEventsEndpoint>(),
  }));
  let demand: SlackDemand | undefined;
  const slack: SlackNative = {
    get accounts() {
      return state().accounts;
    },
    attach(sender) {
      const own = state();
      own.senders = [...own.senders, sender];
      return () => {
        own.senders = own.senders.filter((s) => s !== sender);
      };
    },
    serveEvents(account, endpoint) {
      const { events } = state();
      events.set(account, endpoint);
      return () => {
        if (events.get(account) === endpoint) events.delete(account);
      };
    },
    events: (account) => state().events.get(account),
    signingSecret: (account) => demand?.signingSecret(account) ?? state().events.get(account)?.signingSecret,
    ready: () => demand?.ready() ?? Promise.resolve(),
    onDemand(next) {
      demand = next;
    },
  };
  return {
    name: "slack",
    label: surfaceProfile("slack").label!,
    traits: surfaceProfile("slack").traits,
    destinationTypes: ["slack", "group", "principal"],
    slack,
    async deliver(post) {
      const own = state();
      if (!own.senders.length) await slack.ready();
      const sender = own.senders.at(-1);
      if (!sender) throw new Error(`no ${post.destination.type} connection is available to post this message`);
      return sender(post);
    },
  };
}
