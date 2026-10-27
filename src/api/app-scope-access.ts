import { isSubagentThreadRef } from "../sessions/thread-ref.ts";
import {
  type Permission,
  type Principal,
  type ScopeId,
  type Session,
  isManageableCreationScope,
  parseScopeId,
  scopeId,
} from "../types.ts";
import type { Run } from "../runs/run-store.ts";
import { deployRef, encodeRef, parseRef } from "../acl/resource-ref.ts";
import type { Skill } from "../skills/skill-store.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import {
  createCanReadScope,
  createCanManageScope,
  createCanWriteScope,
  createIsCurrentSharedScopeMember,
  createManagesArtifactHome,
  createMembershipControlsScope,
} from "../resolution/scope-membership.ts";
import { samePerson } from "../directory/person.ts";
import type { Deployment } from "../deploy/deploy-store.ts";
import { reportFailureAs } from "../util/errors.ts";
import { isProjectGroupRef } from "../projects/project-store.ts";

import type { AppDeps } from "./app-types.ts";

export function createScopeAccess(deps: AppDeps, channelPrivacy: (ref: string) => Promise<boolean | undefined>) {
  const scopeMembershipDeps = {
    ...(deps.projects ? { managedGroups: deps.projects } : {}),
    ...(deps.directory ? { directory: deps.directory } : {}),
    ...(deps.identity ? { identity: deps.identity } : {}),
    ...(deps.teams ? { teams: deps.teams } : {}),
  };

  const principalCanReadScope = createCanReadScope(scopeMembershipDeps);

  const principalCanWriteScope = createCanWriteScope(scopeMembershipDeps);

  async function mayWriteSession(
    principalId: string,
    session: Pick<Session, "threadRef" | "scopeId">,
    sharedAccess = new Map<string, Promise<boolean>>(),
  ): Promise<boolean> {
    const actor = deps.identity.classify(principalId);
    if (!deps.identity.isInternal(actor)) return false;
    const { kind, ref } = parseScopeId(session.scopeId);
    if (kind === "personal") return session.scopeId === scopeId("personal", actor.id);
    if (kind !== "channel" && kind !== "group") return false;
    const subagent = isSubagentThreadRef(session.threadRef);
    const key = subagent ? `subagent ${session.scopeId}` : session.scopeId;
    if (!sharedAccess.has(key))
      sharedAccess.set(
        key,
        subagent ? principalCanWriteScope(actor.id, session.scopeId) : mayUseSharedScope(kind, ref, actor),
      );
    return sharedAccess.get(key)!;
  }

  async function canContinueOnWeb(
    principalId: string,
    session: Pick<Session, "threadRef" | "scopeId">,
    sharedAccess?: Map<string, Promise<boolean>>,
  ): Promise<boolean> {
    if (!session.threadRef.startsWith("web:") && !isSubagentThreadRef(session.threadRef)) return false;
    return mayWriteSession(principalId, session, sharedAccess);
  }

  async function principalCanAccessCurrentScope(principalId: string, targetScope: ScopeId): Promise<boolean> {
    if (await principalCanWriteScope(principalId, targetScope)) return true;
    const { kind, ref } = parseScopeId(targetScope);
    if (kind !== "channel") return false;
    if (!deps.identity.isInternal(deps.identity.classify(principalId))) return false;
    if ((await channelPrivacy(ref)) !== false) return false;
    return principalCanReadScope(principalId, targetScope);
  }

  async function principalCanUseWriteGrant(principalId: string, targetScope: ScopeId): Promise<boolean> {
    const { kind, ref } = parseScopeId(targetScope);
    const publicChannel = kind === "channel" && (await channelPrivacy(ref)) === false;
    return publicChannel
      ? principalCanAccessCurrentScope(principalId, targetScope)
      : principalCanWriteScope(principalId, targetScope);
  }

  const principalIsCurrentSharedScopeMember = createIsCurrentSharedScopeMember(scopeMembershipDeps);

  const principalCanManageScope = createCanManageScope(scopeMembershipDeps);
  const membershipControlsScope = createMembershipControlsScope(scopeMembershipDeps);

  async function authorizesCapabilityScope(
    claims: Pick<CapabilityClaims, "actorId" | "scopeId" | "scopeVersion" | "botActor" | "liveActor" | "members">,
  ): Promise<boolean> {
    const { kind, ref } = parseScopeId(claims.scopeId);
    if (kind === "channel" && !deps.identity.isInternal(deps.identity.classify(claims.actorId))) return false;
    const privateChannel = kind === "channel" && (await channelPrivacy(ref)) === true;
    const capabilityMembership = privateChannel
      ? await deps.directory.channelMembership(ref, claims.actorId).catch(reportFailureAs("api: membership", undefined))
      : undefined;
    const attestedBot =
      privateChannel &&
      claims.botActor === true &&
      claims.liveActor === true &&
      claims.members?.some((member) => member.id === claims.actorId && member.type === "internal") === true;
    if (
      (kind === "channel" &&
        !(
          attestedBot ||
          (capabilityMembership ?? (await principalCanAccessCurrentScope(claims.actorId, claims.scopeId)))
        )) ||
      (kind === "group" && !(await principalCanWriteScope(claims.actorId, claims.scopeId)))
    ) {
      return false;
    }
    if (kind !== "group" || deps.projects?.recognizes(ref) !== true) return true;
    return (
      (await principalCanManageScope(claims.actorId, claims.scopeId)) &&
      claims.scopeVersion === (await deps.projects.version(ref))
    );
  }

  async function mayUseSharedScope(kind: "channel" | "group", ref: string, actor: Principal): Promise<boolean> {
    if (!deps.identity.isInternal(actor)) return false;
    return principalCanAccessCurrentScope(actor.id, scopeId(kind, ref));
  }

  async function viewerMayUseRun(run: Run, viewer: string): Promise<boolean> {
    const conversation = run.request.conversation;
    if (conversation.kind === "dm") return samePerson(run.request.actor.id, viewer);
    if (!conversation.channelRef) return false;
    const scope = scopeId(conversation.kind, conversation.channelRef);
    if (await principalIsCurrentSharedScopeMember(viewer, scope)) {
      if (conversation.kind !== "group" || !isProjectGroupRef(conversation.channelRef)) return true;
      return run.request.scopeVersion === (await deps.projects?.version(conversation.channelRef));
    }
    if (conversation.kind !== "channel") return false;
    const isPublic = (await channelPrivacy(conversation.channelRef)) === false;
    const active = deps.identity.isInternal(deps.identity.classify(viewer));
    return isPublic && active && principalCanReadScope(viewer, scope);
  }

  return {
    scopeMembershipDeps,
    principalCanReadScope,
    principalCanWriteScope,
    mayWriteSession,
    canContinueOnWeb,
    principalCanAccessCurrentScope,
    principalCanUseWriteGrant,
    principalIsCurrentSharedScopeMember,
    principalCanManageScope,
    membershipControlsScope,
    authorizesCapabilityScope,
    mayUseSharedScope,
    viewerMayUseRun,
  };
}

export type ScopeAccess = ReturnType<typeof createScopeAccess>;

export function createArtifactAccess(
  deps: AppDeps,
  audit: (principalId: string, action: string, resource: string, scopeLabel: ScopeId) => void,
  scopes: ScopeAccess,
) {
  const {
    scopeMembershipDeps,
    principalCanManageScope,
    principalCanAccessCurrentScope,
    principalCanUseWriteGrant,
    principalCanWriteScope,
  } = scopes;
  const principalManagesArtifactHome = createManagesArtifactHome(scopeMembershipDeps, principalCanManageScope);

  async function artifactAuthor(ownerScopeId: ScopeId, ref: string): Promise<string | undefined> {
    const { kind } = parseScopeId(ownerScopeId);
    if (kind !== "channel" && kind !== "group") return undefined;
    const r = parseRef(ref);
    if (r.kind === "skill") return (await deps.skills.get(r.id))?.createdBy;
    if (r.kind === "cron") return (await deps.crons.get(r.id))?.createdBy;
    if (r.kind === "deploy") {
      const deployment = await deps.deploy.getDeployment(r.id);
      return deployment?.id === r.id ? deployment.createdBy : undefined;
    }
    if (r.kind === "file") return (await deps.files.resolveByIds([{ ownerScopeId, id: r.id }]))[0]?.createdBy;
    return undefined;
  }

  function canManageSkill(skill: Pick<Skill, "scopeId" | "createdBy">, principalId: string): Promise<boolean> {
    return principalManagesArtifactHome(skill.scopeId, skill.createdBy, principalId);
  }

  async function republishIfShared(skill: Skill, editorId: string): Promise<Skill> {
    if (skill.status === "published") return skill;
    const { kind } = parseScopeId(skill.scopeId);
    if (kind !== "channel" && kind !== "group") return skill;
    await deps.skills.review(skill.id, "system:skill-authoring", skill.manifest.requiredCapabilities);
    const published = await deps.skills.publish(skill.id);
    audit(editorId, "skill_review", skill.id, skill.scopeId);
    return published;
  }

  async function artifactGrantPermission(
    ownerScopeId: ScopeId,
    ref: string,
    principalId: string,
  ): Promise<Permission | null> {
    let best: Permission | null = null;
    const grants = (await deps.acl?.grantsFor(ownerScopeId, ref).catch(reportFailureAs("artifact grants", []))) ?? [];
    for (const g of grants) {
      if (g.permission !== "read" && g.permission !== "write") continue;
      if (
        g.permission === "read" &&
        principalId.includes("@") &&
        g.granteeScopeId === `personal:${principalId.trim().toLowerCase()}`
      ) {
        best = "read";
        continue;
      }
      if (!(await principalCanAccessCurrentScope(principalId, g.granteeScopeId))) continue;
      if (g.permission === "write" && (await principalCanUseWriteGrant(principalId, g.granteeScopeId))) return "write";
      best = "read";
    }
    return best;
  }

  async function effectiveDeploymentPermission(d: Deployment, principalId: string): Promise<Permission | null> {
    if (!principalId || deps.identity.deactivationSource?.(principalId) === "manual") return null;
    if (await principalCanWriteScope(principalId, d.ownerScopeId)) return "write";
    const granted = await artifactGrantPermission(d.ownerScopeId, encodeRef(deployRef(d.id)), principalId);
    if (granted) return granted;
    return (await principalCanAccessCurrentScope(principalId, d.ownerScopeId)) ? "read" : null;
  }

  async function principalCanReadDeployment(d: Deployment, principalId: string): Promise<boolean> {
    return (await effectiveDeploymentPermission(d, principalId)) != null;
  }

  async function principalGitPermission(
    d: Pick<Deployment, "id" | "ownerScopeId" | "createdBy" | "createdInScope">,
    principalId: string,
  ): Promise<"read" | "write" | null> {
    if (!principalId) return null;
    const { kind } = parseScopeId(d.ownerScopeId);
    if (await principalManagesArtifactHome(d.ownerScopeId, d.createdBy, principalId)) return "write";
    if (isManageableCreationScope(d.createdInScope) && (await principalCanWriteScope(principalId, d.createdInScope!)))
      return "write";
    let canRead = kind === "org" && (await principalCanAccessCurrentScope(principalId, d.ownerScopeId));
    const grants = (await deps.acl?.grantsFor(d.ownerScopeId, encodeRef(deployRef(d.id))).catch(() => [])) ?? [];
    for (const g of grants) {
      if (g.permission !== "read" && g.permission !== "write") continue;
      if (!(await principalCanAccessCurrentScope(principalId, g.granteeScopeId))) continue;
      if (g.permission === "write" && (await principalCanUseWriteGrant(principalId, g.granteeScopeId))) return "write";
      canRead = true;
    }
    if (canRead) return "read";
    return (await principalCanAccessCurrentScope(principalId, d.ownerScopeId)) ? "read" : null;
  }

  return {
    principalManagesArtifactHome,
    artifactAuthor,
    canManageSkill,
    republishIfShared,
    effectiveDeploymentPermission,
    artifactGrantPermission,
    principalCanReadDeployment,
    principalGitPermission,
  };
}
