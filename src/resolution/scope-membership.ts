import type { Principal, ScopeId } from "../types.ts";
import { actsAsScope, parseScopeId, scopeId } from "../types.ts";
import { samePerson } from "../directory/person.ts";
import { swallowAs } from "../util/errors.ts";

export interface ManagedGroupDirectory {
  recognizes(groupId: string): boolean;
  membership(groupId: string, principalId: string): Promise<boolean | undefined>;
  members(groupId: string): Promise<string[] | undefined>;
  version(groupId: string): Promise<string | undefined>;
  withVersion<T>(groupId: string, version: string | undefined, fn: () => Promise<T>): Promise<T | undefined>;
  slackChannel?(groupId: string): Promise<{ channelId: string; channelName: string } | undefined>;
}

export interface ScopeMembershipDeps {
  managedGroups?: Pick<ManagedGroupDirectory, "recognizes" | "membership" | "members">;
  directory?: {
    channelMember(channelId: string, principalId: string): Promise<boolean>;
    groupMember(groupId: string, principalId: string): Promise<boolean>;
    channelMembership?(channelId: string, principalId: string): Promise<boolean | undefined>;
    groupMembership?(groupId: string, principalId: string): Promise<boolean | undefined>;
    channelPrivacy?(channelId: string): Promise<boolean | undefined>;
    conversationMembers?(
      kind: "channel" | "group",
      id: string,
    ): Promise<Array<{ principalId: string; displayName?: string; type: string }> | undefined>;
    get?(principalId: string): Promise<{ principalId?: string; slackId?: string } | null>;
  };
  identity?: {
    classify(externalId: string, isExternalGuest?: boolean): { type?: string; teamIds?: readonly string[] };
  };
  teams?: { isMember(principalId: string, teamId: string): Promise<boolean> };
}

async function teamMember(deps: ScopeMembershipDeps, principalId: string, teamId: string): Promise<boolean> {
  return activePrincipal(deps, principalId) && (await deps.teams?.isMember(principalId, teamId)) === true;
}

function activePrincipal(deps: ScopeMembershipDeps, principalId: string): boolean {
  const type = deps.identity?.classify(principalId).type;
  return type === undefined || type === "internal";
}

async function currentSharedScopeMember(
  deps: ScopeMembershipDeps,
  kind: "channel" | "group",
  ref: string,
  principalId: string,
): Promise<boolean> {
  if (actsAsScope(principalId, scopeId(kind, ref))) return true;
  if (!activePrincipal(deps, principalId)) return false;
  const member = await deps.directory?.get?.(principalId).catch(swallowAs("scope membership: directory lookup", null));
  const ids = [...new Set([principalId, member?.principalId, member?.slackId].filter((id): id is string => !!id))];
  if (kind === "group" && deps.managedGroups?.recognizes(ref)) {
    for (const id of ids)
      if (
        (await deps.managedGroups.membership(ref, id).catch(swallowAs("scope membership: group membership", false))) ===
        true
      )
        return true;
    return false;
  }
  const direct = kind === "channel" ? deps.directory?.channelMember : deps.directory?.groupMember;
  for (const id of ids)
    if (
      (await direct?.call(deps.directory, ref, id).catch(swallowAs("scope membership: channel membership", false))) ===
      true
    )
      return true;
  return false;
}

function directoryMembership(
  directory: ScopeMembershipDeps["directory"],
  kind: "channel" | "group",
  ref: string,
  principalId: string,
): Promise<boolean | undefined> | undefined {
  if (kind === "channel") {
    return directory?.channelMembership
      ? directory.channelMembership(ref, principalId)
      : directory?.channelMember(ref, principalId);
  }
  return directory?.groupMembership
    ? directory.groupMembership(ref, principalId)
    : directory?.groupMember(ref, principalId);
}

async function memberOfSharedScope(
  deps: ScopeMembershipDeps,
  kind: "channel" | "group",
  ref: string,
  principalId: string,
): Promise<boolean> {
  if (actsAsScope(principalId, scopeId(kind, ref))) return true;
  if (!activePrincipal(deps, principalId)) return false;
  const membership =
    kind === "group" && deps.managedGroups?.recognizes(ref)
      ? deps.managedGroups.membership(ref, principalId)
      : directoryMembership(deps.directory, kind, ref, principalId);
  return (await membership?.catch(swallowAs("scope membership: shared scope membership", undefined))) === true;
}

export type CanReadScope = (principalId: string, targetScope: ScopeId) => Promise<boolean>;
export type CanWriteScope = (principalId: string, targetScope: ScopeId) => Promise<boolean>;
export type IsCurrentSharedScopeMember = (principalId: string, scope: ScopeId) => Promise<boolean>;

export function createIsCurrentSharedScopeMember(deps: ScopeMembershipDeps): IsCurrentSharedScopeMember {
  return async function isCurrentSharedScopeMember(principalId, scope) {
    if (!principalId) return false;
    const { kind, ref } = parseScopeId(scope);
    return (kind === "channel" || kind === "group") && currentSharedScopeMember(deps, kind, ref, principalId);
  };
}

export function withLiveTurnMembership(
  stored: IsCurrentSharedScopeMember | undefined,
  turn: { actorId: string; scopeId: ScopeId; verified: boolean },
): IsCurrentSharedScopeMember {
  return async (principalId, scope) =>
    (turn.verified && scope === turn.scopeId && samePerson(principalId, turn.actorId)) ||
    (await stored?.(principalId, scope)) === true;
}

export type CurrentScopeMembers = (scope: ScopeId) => Promise<Principal[] | undefined>;

export function createCurrentScopeMembers(deps: ScopeMembershipDeps, requireComplete = false): CurrentScopeMembers {
  const principal = (id: string, displayName?: string): Principal | null => {
    const classified = deps.identity?.classify(id);
    if (classified?.type !== undefined && classified.type !== "internal") return null;
    return {
      id,
      type: "internal",
      ...(classified?.teamIds ? { teamIds: [...classified.teamIds] } : {}),
      ...(displayName ? { displayName } : {}),
    };
  };

  return async function currentScopeMembers(scope): Promise<Principal[] | undefined> {
    const { kind, ref } = parseScopeId(scope);
    if (kind !== "channel" && kind !== "group") return undefined;

    if (kind === "group" && deps.managedGroups?.recognizes(ref)) {
      const memberIds = await deps.managedGroups.members(ref);
      const members = (memberIds ?? []).map((id) => principal(id));
      if (requireComplete && (!memberIds?.length || members.some((member) => member === null))) return undefined;
      return members.filter((member): member is Principal => member !== null);
    }

    if (!requireComplete && kind === "channel" && (await deps.directory?.channelPrivacy?.(ref)) !== true) {
      return undefined;
    }
    const roster = await deps.directory?.conversationMembers?.(kind, ref);
    if (!roster) return undefined;
    const members = roster.map((member) =>
      member.type === "internal" ? principal(member.principalId, member.displayName) : null,
    );
    if (requireComplete) {
      return roster.length && members.every((member) => member !== null) ? (members as Principal[]) : undefined;
    }
    const present = members.filter((member): member is Principal => member !== null);
    return kind === "group" && present.length === 0 ? undefined : present;
  };
}

export function createCanReadScope(deps: ScopeMembershipDeps): CanReadScope {
  return async function canReadScope(principalId: string, targetScope: ScopeId): Promise<boolean> {
    if (!principalId) return false;
    const { kind, ref } = parseScopeId(targetScope);
    if (kind === "org") return deps.identity?.classify(principalId).type === "internal";
    if (kind === "personal") return samePerson(ref, principalId);
    if (kind === "team") return teamMember(deps, principalId, ref);
    if (kind === "group") return memberOfSharedScope(deps, kind, ref, principalId);
    if (kind === "channel") {
      if (await memberOfSharedScope(deps, kind, ref, principalId)) return true;
      const isPrivate = await deps.directory
        ?.channelPrivacy?.(ref)
        .catch(swallowAs("scope membership: channel privacy", undefined));
      if (isPrivate === false) return activePrincipal(deps, principalId);
      return false;
    }
    return false;
  };
}

export function createCanWriteScope(deps: ScopeMembershipDeps): CanWriteScope {
  return async function canWriteScope(principalId, targetScope) {
    if (!principalId || !activePrincipal(deps, principalId)) return false;
    const { kind, ref } = parseScopeId(targetScope);
    if (kind === "org") return true;
    if (kind === "personal") return samePerson(ref, principalId);
    if (kind === "team") return teamMember(deps, principalId, ref);
    if (kind === "channel" || kind === "group") return currentSharedScopeMember(deps, kind, ref, principalId);
    return false;
  };
}

export type CanManageScope = (principalId: string, scope: ScopeId) => Promise<boolean>;
export type MembershipControlsScope = (scope: ScopeId) => Promise<boolean>;

export function createMembershipControlsScope(deps: ScopeMembershipDeps): MembershipControlsScope {
  return async function membershipControlsScope(scope) {
    const { kind, ref } = parseScopeId(scope);
    if (kind === "group") return true;
    return (
      kind === "channel" &&
      (await deps.directory?.channelPrivacy?.(ref).catch(swallowAs("scope membership: channel privacy", undefined))) ===
        true
    );
  };
}

export function createCanManageScope(deps: ScopeMembershipDeps): CanManageScope {
  return async function canManageScope(principalId: string, scope: ScopeId): Promise<boolean> {
    if (!principalId || !activePrincipal(deps, principalId)) return false;
    const { kind, ref } = parseScopeId(scope);
    if (kind === "personal") return samePerson(ref, principalId);
    if (kind === "group") return currentSharedScopeMember(deps, kind, ref, principalId);
    if (kind === "channel") {
      const isPrivate = await deps.directory
        ?.channelPrivacy?.(ref)
        .catch(swallowAs("scope membership: channel privacy", undefined));
      if (isPrivate !== true) return false;
      return currentSharedScopeMember(deps, kind, ref, principalId);
    }
    return false;
  };
}

export type ManagesArtifactHome = (homeScopeId: ScopeId, createdBy: string, principalId: string) => Promise<boolean>;

export function createManagesArtifactHome(
  deps: ScopeMembershipDeps,
  canManageScope: CanManageScope,
): ManagesArtifactHome {
  return async function managesArtifactHome(homeScopeId, createdBy, principalId): Promise<boolean> {
    if (!principalId || !activePrincipal(deps, principalId)) return false;
    if (await canManageScope(principalId, homeScopeId)) return true;
    const { kind, ref } = parseScopeId(homeScopeId);
    if (kind === "team") return teamMember(deps, principalId, ref);
    if (!samePerson(createdBy, principalId)) return false;
    if (kind === "personal") return true;
    if (kind === "channel")
      return (
        (await deps.directory
          ?.channelPrivacy?.(ref)
          .catch(swallowAs("scope membership: channel privacy", undefined))) === false
      );
    return false;
  };
}

export function rosterAdmits(roster: readonly string[], principalId: string, scope: ScopeId): boolean {
  return actsAsScope(principalId, scope) || roster.includes(principalId);
}
