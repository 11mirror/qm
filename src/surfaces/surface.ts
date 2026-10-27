import type { IncomingHttpHeaders } from "node:http";
import type { Tenant } from "../tenant.ts";
import type { ActorAssertion, ConversationKind } from "../types.ts";
import type { SurfaceSender } from "./outbound.ts";

export interface SurfaceUser {
  id: string;
  email?: string;
  displayName?: string;
  guest?: boolean;
  bot?: boolean;
  timezone?: string;
}

interface SurfaceAttachment {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url?: string;
}

interface SurfaceConversationRef {
  kind: ConversationKind;
  key: string;
  name?: string;
  thread?: string;
  members?: SurfaceUser[];
}

export interface InboundMessage {
  tenant: Tenant;
  account: string;
  conversation: SurfaceConversationRef;
  messageId: string;
  author: SurfaceUser;
  text: string;
  attachments: SurfaceAttachment[];
  mentions: Record<string, string>;
  mentionsSelf: boolean;
  threadEngaged: boolean;
}

export interface SurfaceRequest {
  headers: IncomingHttpHeaders;
  pathWithQuery: string;
  rawBody: string;
}

export type InboundOutcome =
  { status: 401; reason: string } | { status: 400; reason: string } | { status: 200; messages: InboundMessage[] };

export interface SurfaceTraits {
  transcript: boolean;
  sidebar: boolean;
  pickModel: boolean;
  editableTurns: boolean;
  memberGate: boolean;
  externalParticipants: boolean;
  earlyAck: boolean;
  nativeActorIds: boolean;
  revisions: boolean;
  delegates: boolean;
  nativeApprovals: boolean;
  quarantineNotice: boolean;
}

const NO_TRAITS: SurfaceTraits = {
  transcript: false,
  sidebar: false,
  pickModel: false,
  editableTurns: false,
  memberGate: false,
  externalParticipants: false,
  earlyAck: false,
  nativeActorIds: false,
  revisions: false,
  delegates: false,
  nativeApprovals: false,
  quarantineNotice: false,
};

interface SurfaceProfile {
  label?: string;
  promptFlavor?: "web" | "slack";
  toolHint?: string;
  traits: SurfaceTraits;
}

const PROFILES: Readonly<Record<string, SurfaceProfile>> = {
  web: {
    promptFlavor: "web",
    traits: { ...NO_TRAITS, transcript: true, sidebar: true, pickModel: true, editableTurns: true, memberGate: true },
  },
  slack: {
    label: "Slack",
    promptFlavor: "slack",
    toolHint:
      " To @-mention on Slack, use `<@U…>` for a person or `<!subteam^S…>` for a user group (ids appear in People here / read / search results). A typed `@name` is plain text and pings no one; @here/@channel/@everyone never ping.",
    traits: {
      ...NO_TRAITS,
      externalParticipants: true,
      earlyAck: true,
      nativeActorIds: true,
      revisions: true,
      delegates: true,
      nativeApprovals: true,
      quarantineNotice: true,
    },
  },
};

export const isNamedSurface = (name: string | undefined): name is string =>
  name !== undefined && Object.hasOwn(PROFILES, name);

export const surfaceProfile = (name: string | undefined): SurfaceProfile =>
  isNamedSurface(name) ? PROFILES[name]! : { traits: NO_TRAITS };

export const surfaceTraits = (name: string | undefined): SurfaceTraits => surfaceProfile(name).traits;

export interface Surface {
  readonly name: string;
  readonly label: string;
  readonly destinationTypes: readonly string[];
  readonly traits: SurfaceTraits;
  deliver: SurfaceSender;
}

export interface InboundSurface extends Surface {
  normalize(request: SurfaceRequest): Promise<InboundOutcome>;
  principalFor(user: SurfaceUser): ActorAssertion;
}
