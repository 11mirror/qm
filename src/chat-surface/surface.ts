import type { IncomingHttpHeaders } from "node:http";
import type { Tenant } from "../tenant.ts";
import type { ActorAssertion, ConversationKind } from "../types.ts";
import type { SurfaceSender } from "../surfaces/outbound.ts";

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

export interface Surface {
  readonly name: string;
  readonly label: string;
  readonly destinationTypes: readonly string[];
  deliver: SurfaceSender;
}

export interface InboundSurface extends Surface {
  normalize(request: SurfaceRequest): Promise<InboundOutcome>;
  principalFor(user: SurfaceUser): ActorAssertion;
}
