import { mock } from "node:test";
import type { SlackCoreClient } from "../../src/slack/index.ts";
import type { TurnResult } from "../../src/types.ts";
import type { SurfaceSender } from "../../src/surfaces/outbound.ts";
import type { SlackNative } from "../../src/surfaces/slack-surface.ts";
import { collectBytes, type ByteSource } from "../../src/util/bytes.ts";

export type Handler = (args: any) => Promise<void>;

export class FakeSocketModeClient {
  on(): void {}
  async start(): Promise<void> {}
  async disconnect(): Promise<void> {}
}

export class FakeSlackClient {
  readonly posts: any[] = [];
  readonly ephemerals: any[] = [];
  readonly updates: any[] = [];
  readonly deletes: any[] = [];
  readonly reactionsAdded: any[] = [];
  readonly reactionsRemoved: any[] = [];
  readonly usersById = new Map<string, any>();
  readonly channelsById = new Map<string, any>();
  readonly membersByChannel = new Map<string, string[]>();
  readonly messagesByChannel = new Map<string, any[]>();
  readonly membershipFailures = new Set<string>();
  readonly membershipListings = new Map<string, number>();
  readonly botsById = new Map<string, any>();
  membershipDelayMs = 0;
  activeMembershipListings = 0;
  maxActiveMembershipListings = 0;
  firstMembershipListingStartedAt: number | undefined;
  groupListings = 0;
  failGroupListing = false;
  private postSequence = 0;

  readonly auth = {
    test: async () => ({
      team_id: "T1",
      user_id: "UBOT",
      bot_id: "BBOT",
      user: "qmbot",
      team: "Acme",
      url: "https://acme.slack.com/",
    }),
  };
  readonly emoji = { list: async () => ({ emoji: {} }) };
  readonly users = {
    info: async ({ user }: { user: string }) => ({ user: this.usersById.get(user) }),
    lookupByEmail: async ({ email }: { email: string }) => ({
      user: [...this.usersById.values()].find((u) => u.profile?.email === email),
    }),
  };
  readonly conversations = {
    info: async ({ channel }: { channel: string }) => ({ channel: this.channelsById.get(channel) }),
    replies: async ({ channel, ts }: { channel: string; ts: string }) => ({
      messages: (this.messagesByChannel.get(channel) ?? []).filter((m) => m.ts === ts || m.thread_ts === ts),
      has_more: false,
    }),
    history: async ({ channel, latest }: { channel: string; latest?: string }) => ({
      messages: (this.messagesByChannel.get(channel) ?? []).filter((m) => !latest || m.ts === latest),
      has_more: false,
    }),
    open: async () => ({ channel: { id: "DOPEN" } }),
    setTopic: async ({ channel, topic }: { channel: string; topic: string }) => {
      this.topics.push({ channel, topic });
      const existing = this.channelsById.get(channel) ?? { id: channel };
      this.channelsById.set(channel, { ...existing, topic: { value: topic, creator: "UBOT" } });
      return { ok: true };
    },
  };
  readonly topics: { channel: string; topic: string }[] = [];
  readonly pinnedByChannel = new Map<string, { ts: string; user: string; text: string }[]>();
  readonly pins = {
    list: async ({ channel }: { channel: string }) => ({
      items: (this.pinnedByChannel.get(channel) ?? []).map((message) => ({ message })),
    }),
    add: async ({ channel, timestamp }: { channel: string; timestamp: string }) => {
      const lastPost = this.posts.filter((p) => p.channel === channel).at(-1);
      const pinned = this.pinnedByChannel.get(channel) ?? [];
      pinned.push({ ts: timestamp, user: "UBOT", text: lastPost?.text ?? "" });
      this.pinnedByChannel.set(channel, pinned);
      return { ok: true };
    },
    remove: async ({ channel, timestamp }: { channel: string; timestamp: string }) => {
      this.pinnedByChannel.set(
        channel,
        (this.pinnedByChannel.get(channel) ?? []).filter((m) => m.ts !== timestamp),
      );
      return { ok: true };
    },
  };
  readonly chat = {
    postMessage: async (body: any) => {
      this.posts.push(body);
      return { ok: true, ts: `posted-${++this.postSequence}` };
    },
    postEphemeral: async (body: any) => {
      this.ephemerals.push(body);
      return { ok: true, message_ts: `ephemeral-${this.ephemerals.length}` };
    },
    update: async (body: any) => {
      this.updates.push(body);
      return { ok: true, ts: body.ts };
    },
    delete: async (body: any) => {
      this.deletes.push(body);
      return { ok: true };
    },
  };
  readonly reactions = {
    add: async (body: any) => {
      this.reactionsAdded.push(body);
      return { ok: true };
    },
    remove: async (body: any) => {
      this.reactionsRemoved.push(body);
      return { ok: true };
    },
    get: async () => ({}),
  };
  readonly filesById = new Map<string, any>();
  readonly fileInfoCalls: string[] = [];
  readonly files = {
    uploadV2: async () => ({ ok: true }),
    info: async ({ file }: { file: string }) => {
      this.fileInfoCalls.push(file);
      return { file: this.filesById.get(file) ?? {} };
    },
  };
  readonly bots = { info: async ({ bot }: { bot: string }) => ({ bot: this.botsById.get(bot) }) };

  async *paginate(method: string, args: any): AsyncGenerator<any> {
    if (method === "users.list") {
      yield { members: [...this.usersById.values()] };
      return;
    }
    if (method === "conversations.list") {
      const types = String(args.types ?? "");
      if (types === "mpim") {
        this.groupListings++;
        if (this.failGroupListing) throw new Error("missing mpim:read");
      }
      yield {
        channels: [...this.channelsById.values()].filter((c) => (types === "mpim" ? c.is_mpim : !c.is_mpim)),
      };
      return;
    }
    if (method === "conversations.members") {
      this.firstMembershipListingStartedAt ??= Date.now();
      this.membershipListings.set(args.channel, (this.membershipListings.get(args.channel) ?? 0) + 1);
      this.activeMembershipListings++;
      this.maxActiveMembershipListings = Math.max(this.maxActiveMembershipListings, this.activeMembershipListings);
      try {
        if (this.membershipDelayMs) await new Promise((resolve) => setTimeout(resolve, this.membershipDelayMs));
        if (this.membershipFailures.has(args.channel)) throw new Error("missing conversations:read");
        yield { members: this.membersByChannel.get(args.channel) ?? [] };
      } finally {
        this.activeMembershipListings--;
      }
      return;
    }
    throw new Error(`unexpected pagination method: ${method}`);
  }
}

export class FakeApp {
  static instances: FakeApp[] = [];
  readonly client = new FakeSlackClient();
  readonly receiver: any;
  readonly messageHandlers: Handler[] = [];
  readonly eventHandlers = new Map<string, Handler[]>();
  readonly actionHandlers: Array<{ pattern: RegExp | string; handler: Handler }> = [];
  started = false;

  constructor(opts: any) {
    this.receiver = opts.receiver;
    FakeApp.instances.push(this);
  }

  message(handler: Handler): void {
    this.messageHandlers.push(handler);
  }

  event(name: string, handler: Handler): void {
    this.eventHandlers.set(name, [...(this.eventHandlers.get(name) ?? []), handler]);
  }

  action(pattern: RegExp | string, handler: Handler): void {
    this.actionHandlers.push({ pattern, handler });
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async emitMessage(message: any, eventId = `Ev-${message.channel}-${message.ts}`, context: any = {}): Promise<void> {
    for (const handler of this.messageHandlers) {
      await handler({ message, body: { event_id: eventId }, client: this.client, context });
    }
  }

  async emitEvent(name: string, event: any, eventId = `Ev-${name}-${event.channel}-${event.ts}`): Promise<void> {
    for (const handler of this.eventHandlers.get(name) ?? []) {
      await handler({ event, body: { event_id: eventId }, client: this.client, context: {} });
    }
  }
}

mock.module("@slack/bolt", { defaultExport: { App: FakeApp, LogLevel: { INFO: "info" } } });
mock.module("@slack/socket-mode", { namedExports: { SocketModeClient: FakeSocketModeClient } });
mock.module("@slack/web-api", {
  namedExports: {
    WebClient: class {
      get conversations() {
        return FakeApp.instances.at(-1)!.client.conversations;
      }
    },
  },
});

export const { slackPluginConfigFromEnv, startSlackPlugin } = await import("../../src/slack/index.ts");

export class FakeCore implements SlackCoreClient {
  async decideDeploymentAccess(): Promise<string> {
    throw new Error("not used");
  }
  async inboxSlackMessage(): Promise<void> {}
  readonly turns: any[] = [];
  readonly ingests: any[][] = [];
  readonly directories: any[] = [];
  readonly ackPicks: Array<{ text: string; candidates: readonly string[] }> = [];
  externalParticipants = false;
  result: TurnResult = { status: "ok", reply: "agent reply" };
  submitError: Error | undefined;
  activeRun: string | undefined;
  abortedRuns: string[] = [];
  queuedRunId: string | undefined;
  engageRun = false;
  sessionStatus?: SlackCoreClient["sessionStatus"];
  private heldRunClaimed = false;
  readonly polled: string[] = [];
  private runGate: Promise<void> | undefined;
  private releaseRun: (() => void) | undefined;
  readonly modelChangeListeners: Array<(scope: any) => void> = [];
  readonly headerPinChangeListeners: Array<(scope: any) => void> = [];
  readonly headerPinScopes = new Set<string>();

  async externalSlackParticipants(): Promise<boolean> {
    return this.externalParticipants;
  }
  async ackEmojiOverride(): Promise<string[] | null> {
    return null;
  }
  readonly publishedEmojiCatalogs: Array<Record<string, string>> = [];
  async publishEmojiCatalog(emoji: Record<string, string>): Promise<void> {
    this.publishedEmojiCatalogs.push(emoji);
  }
  async surfaceHeaderFacts(): Promise<{ agentLabel?: string; modelName: string }> {
    return { agentLabel: "Quartermaster", modelName: "Claude Opus 4.8" };
  }
  onScopeModelChanged(listener: (scope: any) => void): void {
    this.modelChangeListeners.push(listener);
  }
  async channelHeaderPinEnabled(scope: any): Promise<boolean> {
    return this.headerPinScopes.has(String(scope));
  }
  onChannelHeaderPinChanged(listener: (scope: any) => void): void {
    this.headerPinChangeListeners.push(listener);
  }
  async stageBlob(source: ByteSource): Promise<{ blobId: string; sizeBytes: number }> {
    return { blobId: "blob-1", sizeBytes: (await collectBytes(source)).sizeBytes };
  }
  async readBlob(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async readFileArtifact(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async pickAckEmoji(text: string, candidates: readonly string[]): Promise<undefined> {
    this.ackPicks.push({ text, candidates });
    return undefined;
  }
  async recordAckPick(): Promise<void> {}
  async ingestSurfaceEvents(events: any[]): Promise<void> {
    this.ingests.push(events);
  }
  async submitTurn(body: any): Promise<TurnResult> {
    this.turns.push(body);
    if (this.submitError) throw this.submitError;
    if (this.queuedRunId) {
      // The first submit enqueues the run; a later one arrives while it is live, so core folds
      // it in as a steer and answers with the LIVE run's id (src/api/app-turn.ts).
      const steered = this.heldRunClaimed;
      this.heldRunClaimed = true;
      return { status: "queued", runId: this.queuedRunId, ...(steered ? { steered: true as const } : {}) };
    }
    return this.result;
  }
  async waitRun(runId: string, hooks?: { onReplying?(): void }): Promise<TurnResult | null> {
    this.polled.push(runId);
    if (this.engageRun) hooks?.onReplying?.();
    if (this.runGate) await this.runGate;
    return this.result;
  }
  /** Enqueue `runId` on the first submit and hold waitRun open; every later submit is a
   *  mid-turn STEER answered with that same live run's id. `finishRun` releases the waiters. */
  holdRun(runId: string): void {
    this.queuedRunId = runId;
    this.heldRunClaimed = false;
    this.runGate = new Promise<void>((resolve) => (this.releaseRun = resolve));
  }
  finishRun(result: TurnResult): void {
    this.result = result;
    this.releaseRun?.();
  }
  async stopConversation(): Promise<boolean> {
    if (!this.activeRun) return false;
    this.abortedRuns.push(this.activeRun);
    return true;
  }
  async ackRunDelivery(): Promise<void> {}
  async reportRunEditRef(): Promise<void> {}
  async getApproval(): Promise<null> {
    return null;
  }

  async pushDirectory(body: any): Promise<boolean> {
    this.directories.push(body);
    return true;
  }
  holdDirectorySync<T>(fn: (lost: Promise<void>) => Promise<T>): Promise<T | null> {
    return fn(new Promise<void>(() => {}));
  }

  readonly upkeep: SlackCoreClient["upkeep"] = { attach: () => async () => {}, run: async () => {} };

  readonly senders: SurfaceSender[] = [];
  readonly slack: SlackNative = {
    accounts: new Map(),
    attach: (send) => {
      this.senders.push(send);
      return () => void this.senders.splice(this.senders.indexOf(send), 1);
    },
    serveEvents: () => () => {},
    events: () => undefined,
    signingSecret: () => undefined,
    ready: async () => {},
    onDemand: () => {},
  };
  async pendingContextRequests(): Promise<[]> {
    return [];
  }
  contextSubscriptions = 0;
  onContextRequest(): () => void {
    this.contextSubscriptions++;
    return () => {};
  }
  async fulfillContextRequest(): Promise<void> {}
}

export const internalUser = (id: string, name: string) => ({
  id,
  team_id: "T1",
  name: name.toLowerCase(),
  real_name: name,
  profile: { display_name: name, real_name: name, email: `${name.toLowerCase()}@example.com` },
});

export async function fixture(
  options: {
    externalParticipants?: boolean;
    webUiPublicUrl?: string;
    identityEmail?: "0" | "1";
    extraChannels?: number;
    membershipDelayMs?: number;
    allowFrom?: string[];
    denyMessage?: string;
    coreSingleton?: boolean;
  } = {},
) {
  const core = new FakeCore();
  core.externalParticipants = options.externalParticipants ?? false;
  const started = startSlackPlugin(
    {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      identityEmail: options.identityEmail ?? "0",
      ...(options.allowFrom ? { allowFrom: options.allowFrom } : {}),
      ...(options.denyMessage ? { denyMessage: options.denyMessage } : {}),
      ...(options.coreSingleton === undefined ? {} : { coreSingleton: options.coreSingleton }),
      ...(options.webUiPublicUrl ? { webUiPublicUrl: options.webUiPublicUrl } : {}),
    },
    core,
  );
  const app = FakeApp.instances.at(-1)!;
  app.client.membershipDelayMs = options.membershipDelayMs ?? 0;
  app.client.usersById.set("U1", internalUser("U1", "Alice"));
  app.client.usersById.set("U2", internalUser("U2", "Bob"));
  app.client.usersById.set("UX", { id: "UX", team_id: "T2", name: "mallory", profile: { display_name: "Mallory" } });
  app.client.channelsById.set("C1", { id: "C1", name: "engineering", is_member: true, is_private: false });
  app.client.channelsById.set("CX", {
    id: "CX",
    name: "shared",
    is_member: true,
    is_private: false,
    is_ext_shared: true,
  });
  app.client.channelsById.set("CPX", {
    id: "CPX",
    name: "private-shared",
    is_member: true,
    is_private: true,
    is_ext_shared: true,
  });
  app.client.membersByChannel.set("C1", ["U1", "U2", "UBOT"]);
  app.client.membersByChannel.set("CX", ["U1", "UX", "UBOT"]);
  app.client.membersByChannel.set("CPX", ["U1", "UX", "UBOT"]);
  for (let i = 0; i < (options.extraChannels ?? 0); i++) {
    const id = `CE${i}`;
    app.client.channelsById.set(id, { id, name: `extra-${i}`, is_member: true, is_private: false });
    app.client.membersByChannel.set(id, ["U1", "UBOT"]);
  }
  const plugin = await started;
  await new Promise((resolve) => setImmediate(resolve));
  return { app, client: app.client, core, stop: () => plugin.stop() };
}
