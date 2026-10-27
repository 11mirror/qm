import {
  type PendingApproval,
  type PendingApprovalRecord,
  type ScopeId,
  type Session,
  type TurnResult,
  parseScopeId,
  scopeId,
} from "../types.ts";
import { type ListOwnedOptions } from "../files/file-artifact-store.ts";
import { samePerson } from "../directory/person.ts";
import { actorAssertionActive } from "../identity/identity-service.ts";
import { swallow } from "../util/errors.ts";
import {
  isProjectGroupRef,
  projectGroupRef,
  projectIdFromGroupRef,
  projectScopeId,
  type Project,
} from "../projects/project-store.ts";

import type { ParticipantScope } from "../sessions/session-store.ts";
import { type AppDeps, type ContextSummary, type ProjectView, type FileListPage, toFileItem } from "./app-types.ts";
import { tenant } from "../tenant.ts";

import type { ScopeAccess } from "./app-scope-access.ts";

export function createViewerScopes(deps: AppDeps) {
  async function projectView(project: Project): Promise<ProjectView> {
    const memberIds = (await deps.projects?.members(projectGroupRef(project.id))) ?? project.memberIds;
    const manual = new Set([project.ownerId, ...project.memberIds]);
    const members = await Promise.all(
      memberIds.map(async (principalId) => {
        const member = await deps.directory.get(principalId).catch(() => null);
        return {
          principalId,
          displayName: member?.displayName?.trim() || principalId,
          ...(member?.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
          ...(manual.has(principalId) ? {} : { viaChannel: true }),
        };
      }),
    );
    return { ...project, memberIds, scopeId: projectScopeId(project.id), members };
  }

  async function projectsForViewer(principalId: string): Promise<ProjectView[]> {
    if (!deps.projects || !deps.identity.isInternal(deps.identity.classify(principalId))) return [];
    const projects = (await deps.projects.listForMember(principalId)).filter((project) =>
      deps.identity.isInternal(deps.identity.classify(project.ownerId)),
    );
    return Promise.all(projects.map(projectView));
  }

  async function managedProjectMembership(scope: ScopeId, principalId: string): Promise<boolean | undefined> {
    const { kind, ref } = parseScopeId(scope);
    if (kind !== "group" || projectIdFromGroupRef(ref) === null) return undefined;
    if (!deps.projects) return false;
    const project = await deps.projects.get(projectIdFromGroupRef(ref)!);
    if (!project || project.orgId !== tenant().orgId) return false;
    if (!deps.identity.isInternal(deps.identity.classify(project.ownerId))) return false;
    if (!deps.identity.isInternal(deps.identity.classify(principalId))) return false;
    return (await deps.projects.membership(ref, principalId).catch(() => false)) === true;
  }

  async function viewableRows<T extends { scopeId: ScopeId }>(principalId: string, rows: T[]): Promise<T[]> {
    const allowed = new Map(
      await Promise.all(
        [...new Set(rows.map((row) => row.scopeId))].map(
          async (scope) => [scope, (await managedProjectMembership(scope, principalId)) !== false] as const,
        ),
      ),
    );
    return rows.filter((row) => allowed.get(row.scopeId));
  }

  async function sessionsForViewer(principalId: string): Promise<Session[]> {
    return viewableRows(principalId, await deps.sessions.listByParticipant(principalId));
  }

  async function scopesForViewer(principalId: string): Promise<ParticipantScope[]> {
    return viewableRows(principalId, await deps.sessions.participantScopes(principalId));
  }

  async function sessionForViewer(sessionId: string, principalId: string): Promise<Session | null> {
    const session = await deps.sessions.getForParticipant(sessionId, principalId);
    if (!session) return null;
    return (await managedProjectMembership(session.scopeId, principalId)) === false ? null : session;
  }

  return {
    projectView,
    projectsForViewer,
    managedProjectMembership,
    viewableRows,
    sessionsForViewer,
    scopesForViewer,
    sessionForViewer,
  };
}

type ViewerScopes = ReturnType<typeof createViewerScopes>;

export function createViewerResources(deps: AppDeps, viewers: ViewerScopes) {
  const { projectsForViewer, scopesForViewer } = viewers;
  async function contextsFor(principalId: string): Promise<ContextSummary[]> {
    const personal = scopeId("personal", principalId);
    const byScope = new Map<ScopeId, ContextSummary>();
    const noSessions = { sessionCount: 0, lastActivityAt: null };
    byScope.set(personal, { scopeId: personal, kind: "personal", name: null, ...noSessions });
    if (deps.identity.isInternal(deps.identity.classify(principalId))) {
      for (const c of await deps.directory.listChannelsFor(principalId)) {
        const sid = scopeId("channel", c.channelId);
        byScope.set(sid, {
          scopeId: sid,
          kind: "channel",
          name: c.name,
          ...(c.isPrivate !== undefined ? { isPrivate: c.isPrivate } : {}),
          ...noSessions,
        });
      }
    }
    for (const project of await projectsForViewer(principalId)) {
      const sid = projectScopeId(project.id);
      byScope.set(sid, { scopeId: sid, kind: "group", name: project.name, ...noSessions, project });
    }
    for (const scope of await scopesForViewer(principalId)) {
      const { kind, ref } = parseScopeId(scope.scopeId);
      if (scope.scopeId !== personal && kind !== "channel" && kind !== "group") continue;
      let ctx = byScope.get(scope.scopeId);
      if (!ctx && kind === "group" && (await deps.directory.groupMember(ref, principalId))) {
        ctx = { scopeId: scope.scopeId, kind: "group", name: scope.channelName ?? null, ...noSessions };
      }
      if (!ctx) continue;
      if (!ctx.name && scope.channelName) ctx.name = scope.channelName;
      ctx.sessionCount += scope.sessionCount;
      if (scope.lastActivityAt !== null) ctx.lastActivityAt = Math.max(ctx.lastActivityAt ?? 0, scope.lastActivityAt);
      byScope.set(scope.scopeId, ctx);
    }
    return [...byScope.values()].sort((a, b) => {
      if (a.kind === "personal") return -1;
      if (b.kind === "personal") return 1;
      return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
    });
  }

  async function filesForViewer(
    principalId: string,
    opts?: ListOwnedOptions,
    inScope?: ScopeId,
  ): Promise<FileListPage> {
    const myScopes = await currentResourceScopesForViewer(principalId);
    const handles = await deps.acl.handlesFor(myScopes);
    const page = await deps.files.listDocuments(
      myScopes,
      handles.map((h) => ({ ownerScopeId: h.ownerScopeId, id: h.fileId })),
      {
        ...opts,
        ...(inScope ? { createdInScope: inScope } : {}),
      },
    );
    return {
      owned: page.files.filter((f) => myScopes.includes(f.ownerScopeId)).map(toFileItem),
      shared: page.files.filter((f) => !myScopes.includes(f.ownerScopeId)).map(toFileItem),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async function currentResourceScopesForViewer(principalId: string): Promise<ScopeId[]> {
    const actor = deps.identity?.classify(principalId);
    if (actor && !deps.identity?.isInternal(actor)) return [];
    const scopes = new Set<ScopeId>([
      scopeId("personal", principalId),
      ...(actor?.teamIds ?? []).map((teamId) => scopeId("team", teamId)),
      tenant().orgScope,
    ]);
    try {
      const [sessionScopes, channels, groups, projects] = await Promise.all([
        deps.sessions ? scopesForViewer(principalId) : Promise.resolve([]),
        deps.directory ? deps.directory.listChannelsFor(principalId) : Promise.resolve([]),
        deps.directory?.listGroupsFor?.(principalId) ?? Promise.resolve([]),
        projectsForViewer(principalId),
      ]);
      const historical = new Set(sessionScopes.map((scope) => scope.scopeId));
      for (const channel of channels) {
        const scope = scopeId("channel", channel.channelId);
        if (channel.isPrivate === true || historical.has(scope)) scopes.add(scope);
      }
      for (const groupId of groups) scopes.add(scopeId("group", groupId));
      for (const project of projects) scopes.add(project.scopeId);
    } catch (error) {
      swallow("app: current resource scopes for viewer", error);
    }
    return [...scopes];
  }

  return { contextsFor, filesForViewer, currentResourceScopesForViewer };
}

export function createApprovalAccess(
  deps: AppDeps,
  authorizesCapabilityScope: ScopeAccess["authorizesCapabilityScope"],
  viewers: ViewerScopes,
) {
  const { managedProjectMembership, sessionForViewer } = viewers;
  async function approvalCurrentForSession(session: Session, record: PendingApprovalRecord): Promise<boolean> {
    if (!actorAssertionActive(deps.identity, record.request?.actor)) return false;
    const parsed = parseScopeId(session.scopeId);
    if (parsed.kind !== "group" || !isProjectGroupRef(parsed.ref)) return true;
    return authorizesCapabilityScope({
      actorId: record.request!.actor.externalId,
      scopeId: session.scopeId,
      scopeVersion: record.request?.scopeVersion,
    });
  }

  async function approvalRecordIsCurrent(record: PendingApprovalRecord, knownSession?: Session): Promise<boolean> {
    const session = knownSession ?? (await deps.sessions.get(record.sessionId));
    return !!session && approvalCurrentForSession(session, record);
  }

  async function approvalsVisibleToViewer<T extends { record: PendingApprovalRecord }>(
    session: Session,
    viewer: string,
    candidates: T[],
  ): Promise<T[]> {
    const own = candidates.filter(({ record }) => samePerson(record.request?.actor.externalId, viewer));
    if (!own.length) return [];
    if ((await managedProjectMembership(session.scopeId, viewer)) === false) return [];
    const parsed = parseScopeId(session.scopeId);
    if (parsed.kind !== "group" || !isProjectGroupRef(parsed.ref)) return own;
    const window = (await deps.sessions.participantWindowsOf(session.id)).find((candidate) =>
      samePerson(candidate.principalId, viewer),
    );
    if (!window) return [];
    return own.filter(
      ({ record }) =>
        record.createdAt !== undefined &&
        record.createdAt >= window.validFrom &&
        (window.validTo === null || record.createdAt < window.validTo),
    );
  }

  async function approvalVisibleToViewer(
    session: Session,
    viewer: string,
    record: PendingApprovalRecord,
  ): Promise<boolean> {
    return (await approvalsVisibleToViewer(session, viewer, [{ record }])).length === 1;
  }

  async function approvalResumable(
    session: Session,
    actorId: string,
    record: PendingApprovalRecord | null | undefined,
  ): Promise<"ok" | "expired" | "foreign_session" | "stale" | "not_requester"> {
    if (!record) return "expired";
    if (record.sessionId !== session.id) return "foreign_session";
    if (!(await approvalRecordIsCurrent(record, session))) return "stale";
    if (!(await approvalVisibleToViewer(session, actorId, record))) return "not_requester";
    return "ok";
  }

  async function pendingApprovalForSession(
    sessionId: string,
    opts: { blockingOnly: boolean; viewer?: string },
  ): Promise<PendingApproval[]> {
    if (!deps.approvals) return [];
    const [entries, session] = await Promise.all([
      deps.approvals.forSessions([sessionId]),
      deps.sessions.get(sessionId),
    ]);
    if (!session) return [];
    const candidates: Array<{ key: string; record: PendingApprovalRecord }> = [];
    for (const [key, record] of entries) {
      if (opts.blockingOnly && record.blocksInput === false) continue;
      if (await approvalRecordIsCurrent(record, session)) candidates.push({ key, record });
    }
    const visible = opts.viewer ? await approvalsVisibleToViewer(session, opts.viewer, candidates) : candidates;
    return visible.map(({ key, record: r }) => ({
      requestId: key,
      command: r.command,
      reason: r.reason ?? "requires approval",
      ...(r.matched ? { matched: r.matched } : {}),
      ...(r.purpose ? { purpose: r.purpose } : {}),
      ...(r.summary ? { summary: r.summary } : {}),
      ...(r.summaryDetail ? { summaryDetail: r.summaryDetail } : {}),
      ...(r.grantModes ? { grantModes: r.grantModes } : {}),
      blocksInput: r.blocksInput !== false,
      ...(r.kind === "approval" ? { kind: r.kind } : {}),
    }));
  }

  async function pendingApprovalResultForThread(
    threadRef: string,
    viewer?: string,
    opts: { alwaysBlock?: boolean } = {},
  ): Promise<TurnResult | null> {
    const session = await deps.sessions.getByThread(threadRef);
    if (!session) return null;
    if (!opts.alwaysBlock && viewer && !(await sessionForViewer(session.id, viewer))) return null;
    const all = await pendingApprovalForSession(session.id, { blockingOnly: true });
    if (!all.length) return null;
    const approvals = viewer ? await pendingApprovalForSession(session.id, { blockingOnly: true, viewer }) : all;
    if (!approvals.length) {
      return {
        status: "pending_approval",
        sessionId: session.id,
        reason: "This conversation is waiting for someone else to resolve a pending approval.",
      };
    }
    return {
      status: "pending_approval",
      sessionId: session.id,
      reason: "Approve or deny the pending command to continue.",
      pendingApprovals: approvals,
    };
  }

  return {
    approvalRecordIsCurrent,
    approvalResumable,
    approvalVisibleToViewer,
    pendingApprovalForSession,
    pendingApprovalResultForThread,
  };
}
