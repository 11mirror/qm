import { parseSlackThreadRef } from "../slack/message-gating.ts";
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
  | { status: 401; reason: string }
  | { status: 400; reason: string }
  | { status: 503; reason: string }
  | { status: 200; messages: InboundMessage[] };

export type SurfaceTrait =
  | "transcript"
  | "sidebar"
  | "pickModel"
  | "editableTurns"
  | "memberGate"
  | "externalParticipants"
  | "earlyAck"
  | "nativeActorIds"
  | "revisions"
  | "delegates"
  | "nativeApprovals"
  | "quarantineNotice";

interface SurfaceProfile {
  label?: string;
  promptFlavor?: "web" | "slack";
  dmContainer?: (threadRef: string) => string | null;
  toolHint?: string;
  whereNote?: string;
  traits: readonly SurfaceTrait[];
}

const PROFILES: Readonly<Record<string, SurfaceProfile>> = {
  web: {
    promptFlavor: "web",
    whereNote:
      "A cron, reminder, or watch you create here with no explicit destination posts back into this web conversation, and the person sees it here. Leave the destination unset by default; use `recipient` or `channel` only when the person asks for delivery somewhere else.",
    traits: ["transcript", "sidebar", "pickModel", "editableTurns", "memberGate"],
  },
  slack: {
    label: "Slack",
    promptFlavor: "slack",
    dmContainer: (threadRef) =>
      threadRef.startsWith("dm:") ? (parseSlackThreadRef(threadRef)?.container ?? null) : null,
    toolHint:
      " To @-mention on Slack, use `<@U…>` for a person or `<!subteam^S…>` for a user group (ids appear in People here / read / search results). A typed `@name` is plain text and pings no one; @here/@channel/@everyone never ping.",
    traits: [
      "externalParticipants",
      "earlyAck",
      "nativeActorIds",
      "revisions",
      "delegates",
      "nativeApprovals",
      "quarantineNotice",
    ],
  },
};

export const isNamedSurface = (name: string | undefined): name is string =>
  name !== undefined && Object.hasOwn(PROFILES, name);

export const surfaceProfile = (name: string | undefined): SurfaceProfile =>
  isNamedSurface(name) ? PROFILES[name]! : { traits: [] };

export const surfaceHas = (name: string | undefined, trait: SurfaceTrait): boolean =>
  surfaceProfile(name).traits.includes(trait);

export interface Surface {
  readonly name: string;
  readonly label: string;
  readonly destinationTypes: readonly string[];
  readonly traits: readonly SurfaceTrait[];
  deliver: SurfaceSender;
}

export interface InboundSurface extends Surface {
  normalize(request: SurfaceRequest): Promise<InboundOutcome>;
  principalFor(user: SurfaceUser): ActorAssertion;
}
