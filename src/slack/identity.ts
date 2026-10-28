import { isValidTimezone } from "../util/time.ts";
import { LRUCache } from "lru-cache";

export interface ActorAssertion {
  externalId: string;
  isExternalGuest?: boolean;
  isBot?: boolean;
  displayName?: string;
}

export interface SlackUser {
  id?: string;
  team_id?: string;
  tz?: string;
  deleted?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
  is_bot?: boolean;
  real_name?: string;
  name?: string;
  profile?: { display_name?: string; email?: string; tz?: string; image_72?: string };
}

export type SlackIdentityMode = "slack-id" | "email";

export interface CachedUser {
  actor: ActorAssertion;
  timezone?: string;
  avatarUrl?: string;
}

export interface ChannelMembership {
  audience: ActorAssertion[];
  publishMembers?: ActorAssertion[];
  slackIdsByPrincipal?: Map<string, string>;
}

export function createUserCache(opts: { ttlMs?: number; max?: number } = {}): LRUCache<string, CachedUser> {
  return new LRUCache<string, CachedUser>({ max: opts.max ?? 5000, ttl: opts.ttlMs ?? 5 * 60_000 });
}

export function classifyUser(
  u: SlackUser | undefined,
  ownTeamId: string,
  identity: SlackIdentityMode = "slack-id",
): ActorAssertion {
  const user = u ?? {};
  let isGuest = Boolean(
    !u ||
    user.deleted ||
    user.is_restricted ||
    user.is_ultra_restricted ||
    user.is_stranger ||
    (user.team_id && ownTeamId && user.team_id !== ownTeamId),
  );
  const displayName = user.profile?.display_name || user.real_name || user.name || user.id || "";
  let externalId = String(user.id ?? "");
  if (identity === "email" && !user.is_bot) {
    const email = (user.profile?.email ?? "").trim().toLowerCase();
    if (email.includes("@")) externalId = email;
    else isGuest = true;
  }
  return {
    externalId,
    isExternalGuest: isGuest,
    ...(user.is_bot ? { isBot: true } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

export function slackUserTimezone(u: SlackUser | undefined): string | undefined {
  const raw = [u?.tz, u?.profile?.tz].find((tz) => typeof tz === "string") ?? "";
  const timezone = raw.trim();
  return isValidTimezone(timezone) ? timezone : undefined;
}

export function externalMarker(): ActorAssertion {
  return { externalId: "slack-external", isExternalGuest: true };
}

export function probeIdentityMode(members: SlackUser[], ownTeamId: string): SlackIdentityMode | "undecided" {
  const own = members.filter((u) => u?.id && !u.is_bot && !u.deleted && u.team_id === ownTeamId);
  if (own.length === 0) return "undecided";
  return own.some((u) => (u.profile?.email ?? "").includes("@")) ? "email" : "slack-id";
}

export interface ChannelMeta {
  is_im?: boolean;
  name?: string;
  is_ext_shared?: boolean;
  is_pending_ext_shared?: boolean;
  is_member?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  purpose?: { value?: string };
  topic?: { value?: string; creator?: string };
}

export function isMpim(info: ChannelMeta | undefined): boolean {
  return Boolean(info?.is_mpim);
}

export function groupDmDisplayName(members: readonly ActorAssertion[]): string | undefined {
  const names = new Set<string>();
  for (const member of members) {
    const name = (member.displayName ?? member.externalId).trim();
    if (!member.isExternalGuest && name) names.add(name);
  }
  return names.size ? [...names].join(", ") : undefined;
}

export function isExternallyShared(info: ChannelMeta | undefined): boolean {
  return Boolean(info?.is_ext_shared || info?.is_pending_ext_shared);
}

function uniqueById(members: ActorAssertion[]): ActorAssertion[] {
  const byId = new Map<string, ActorAssertion>();
  for (const m of members) if (m.externalId) byId.set(m.externalId, m);
  return [...byId.values()];
}

export function computeChannelAudience(
  actor: ActorAssertion,
  members: ActorAssertion[] | null,
  info: ChannelMeta | undefined,
): ActorAssertion[] {
  if (!members?.length) return isExternallyShared(info) ? [actor, externalMarker()] : [actor];
  const audience = uniqueById([actor, ...members]);
  if (isExternallyShared(info) && audience.every((m) => !m.isExternalGuest)) audience.push(externalMarker());
  return audience;
}

export function computePublishMembers(
  actor: ActorAssertion,
  members: ActorAssertion[],
  complete: boolean,
  info: ChannelMeta | undefined,
): ActorAssertion[] | undefined {
  const all = [actor, ...members];
  if (!complete || isExternallyShared(info) || all.some((m) => m.isExternalGuest)) return undefined;
  return uniqueById(all);
}

export function allInternalChannelMembers(
  members: ActorAssertion[],
  complete: boolean,
  info: ChannelMeta | undefined,
): string[] | undefined {
  if (isExternallyShared(info) || members.some((m) => m.isExternalGuest)) return undefined;
  return internalChannelMembers(members, complete);
}

export function internalChannelMembers(members: ActorAssertion[], complete: boolean): string[] | undefined {
  if (!complete) return undefined;
  return [...new Set(members.filter((m) => m.externalId && !m.isExternalGuest).map((m) => m.externalId))];
}

export async function resolveChannelMembership(opts: {
  memberIds: readonly string[];
  actor: ActorAssertion;
  actorSlackId: string | undefined;
  info: ChannelMeta | undefined;
  classify(id: string): Promise<{ actor: ActorAssertion; ok: boolean }>;
}): Promise<ChannelMembership> {
  const { memberIds, actor, info } = opts;
  if (!actor.isBot && (opts.actorSlackId === undefined || !memberIds.includes(opts.actorSlackId)))
    return { audience: [actor, externalMarker()] };
  const members: ActorAssertion[] = [];
  const slackIdsByPrincipal = new Map<string, string>();
  let complete = true;
  for (const id of memberIds) {
    const { actor: member, ok } = await opts.classify(id);
    members.push(member);
    if (member.externalId && !member.isExternalGuest) slackIdsByPrincipal.set(member.externalId, id);
    if (!ok) complete = false;
  }
  const publishMembers = computePublishMembers(actor, members, complete, info);
  return {
    audience: computeChannelAudience(actor, members, info),
    ...(publishMembers ? { publishMembers } : {}),
    slackIdsByPrincipal,
  };
}
