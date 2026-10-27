import { swallowAs } from "../util/errors.ts";
import { createCurrentScopeMembers } from "../resolution/scope-membership.ts";
import { parseScopeId, scopeId } from "../types.ts";
import { isOpenScopeMember } from "../resolution/sharing-access.ts";
import { projectScopeId } from "../projects/project-store.ts";

import { type App, type ScopeDeployment } from "./app-types.ts";
import { type SessionKit, editableProject, withProjectView } from "./app-session-kit.ts";
import { bareChannelName } from "../util/text.ts";

export function projectMethods(k: SessionKit) {
  const { deps, h } = k;
  return {
    listContexts: (principalId) => h.contextsFor(principalId),

    listProjects: async (principalId) => h.projectsForViewer(principalId),

    async createProject(principalId, name) {
      const principal = deps.identity.classify(principalId);
      if (!deps.projects || !deps.identity.isInternal(principal) || !name.trim()) return null;
      const project = await deps.projects.create({ name, ownerId: principalId });
      h.audit(principalId, "project.create", project.id, projectScopeId(project.id));
      return h.projectView(project);
    },

    async addProjectMember(id, principalId, memberId) {
      const gate = await editableProject(k, id, principalId);
      if (gate.status !== "ok") return gate;
      const directoryMember = await h.directoryMember(memberId);
      const principal = deps.identity.classify(memberId);
      if (!directoryMember || directoryMember.type !== "internal" || !deps.identity.isInternal(principal))
        return { status: "invalid_member" };
      return withProjectView(
        k,
        await gate.projects.addMember(id, principalId, memberId, async ({ project, changed }) => {
          if (changed) h.audit(principalId, "project.member.add", memberId, projectScopeId(project.id));
          await h.reconcileProjectMember(project, memberId, true);
        }),
      );
    },

    async removeProjectMember(id, principalId, memberId) {
      const gate = await editableProject(k, id, principalId);
      if (gate.status !== "ok") return gate;
      return withProjectView(
        k,
        await gate.projects.removeMember(id, principalId, memberId, async ({ project, changed }) => {
          if (changed) h.audit(principalId, "project.member.remove", memberId, projectScopeId(project.id));
          await h.reconcileProjectMember(project, memberId, false);
        }),
      );
    },

    async setProjectSlackChannel(id, principalId, channel) {
      const gate = await editableProject(k, id, principalId);
      if (gate.status !== "ok") return gate;
      const { existing, projects } = gate;
      let link: { channelId: string; channelName: string } | null = null;
      if (channel !== null) {
        const wanted = bareChannelName(channel.trim());
        if (!wanted) return { status: "invalid_channel" };
        const findChannel = async () => {
          const reachable = await deps.directory.listChannelsFor(principalId).catch(() => []);
          return (
            reachable.find((c) => c.channelId === wanted) ??
            reachable.find((c) => c.name.toLowerCase() === wanted.toLowerCase())
          );
        };
        let match = await findChannel();
        if (!match) {
          await h.refreshSurfaceDirectory().catch(swallowAs("api: directory refresh", undefined));
          match = await findChannel();
        }
        if (!match) return { status: "invalid_channel" };
        if (await deps.sessions.scopeHasSessions(scopeId("channel", match.channelId)))
          return { status: "channel_in_use" };
        link = { channelId: match.channelId, channelName: match.name };
      }
      const prevDerived = existing.channelMemberIds ?? [];
      const manual = new Set([existing.ownerId, ...existing.memberIds]);
      const result = await projects.setSlackChannel(id, principalId, link, async ({ project, changed }) => {
        if (changed)
          h.audit(
            principalId,
            link ? "project.slack_channel.link" : "project.slack_channel.unlink",
            link?.channelId ?? existing.slackChannel?.channelId ?? "",
            projectScopeId(project.id),
          );
        if (!link) {
          for (const m of prevDerived) {
            if (manual.has(m)) continue;
            h.audit(principalId, "project.member.remove", m, projectScopeId(project.id));
            await h.reconcileProjectMember(project, m, false);
          }
        }
      });
      if (result.status !== "ok") return result;
      if (link) await h.syncProjectChannelRoster(result.project, principalId);
      return withProjectView(k, { ...result, project: (await projects.get(id)) ?? result.project });
    },

    async renameProject(id, principalId, name) {
      const gate = await editableProject(k, id, principalId);
      if (gate.status !== "ok") return gate;
      return withProjectView(
        k,
        await gate.projects.rename(id, principalId, name, async ({ project, changed }) => {
          if (changed) h.audit(principalId, "project.rename", project.id, projectScopeId(project.id));
        }),
      );
    },
  } satisfies Partial<App>;
}

export function scopeMethods(k: SessionKit) {
  const { deps, h } = k;
  return {
    async listScopeResources(principalId, scope) {
      if (!(await h.principalCanAccessCurrentScope(principalId, scope))) return null;
      const [page, allCrons, allWebhooks, allDeployments, allSkills] = await Promise.all([
        h.filesForViewer(principalId, undefined, scope),
        deps.crons.list(),
        deps.webhooks.list(),
        deps.deploy.listDeployments(),
        deps.skills.list(),
      ]);
      const files = [...page.owned, ...page.shared];
      let cursor = page.nextCursor;
      while (cursor) {
        const next = await h.filesForViewer(principalId, { limit: 200, cursor }, scope);
        files.push(...next.owned, ...next.shared);
        cursor = next.nextCursor;
      }
      files.sort((a, b) => b.createdAt - a.createdAt);
      const deployments = (
        await Promise.all(
          allDeployments
            .filter((d) => d.createdInScope === scope || d.ownerScopeId === scope)
            .map(async (d): Promise<ScopeDeployment | null> => {
              const permission = await h.principalGitPermission(d, principalId);
              return permission
                ? {
                    id: d.id,
                    name: d.displayName ?? d.name ?? d.id,
                    status: d.status,
                    permission,
                    currentVersion: d.currentVersion,
                  }
                : null;
            }),
        )
      ).filter((d): d is ScopeDeployment => d != null);
      const skills = allSkills
        .filter((s) => s.scopeId === scope)
        .map((s) => ({ id: s.id, name: s.manifest.name, description: s.manifest.description, status: s.status }));
      return {
        files,
        webhooks: allWebhooks.filter((w) => w.ownerScopeId === scope),
        crons: allCrons.filter((c) => c.ownerScopeId === scope),
        deployments,
        skills,
        manageable: await h.principalCanManageScope(principalId, scope),
      };
    },

    managesScope: (principalId, scope) => h.principalCanManageScope(principalId, scope),

    currentScopeMembers: createCurrentScopeMembers(
      {
        managedGroups: deps.projects,
        directory: deps.directory,
        identity: deps.identity,
      },
      true,
    ),
    isCurrentSharedScopeMember(principalId, scope) {
      const { kind } = parseScopeId(scope);
      return kind === "channel" || kind === "group"
        ? h.principalCanWriteScope(principalId, scope)
        : Promise.resolve(false);
    },

    isOpenScopeMember(principalId, scope) {
      return isOpenScopeMember({
        actorId: principalId,
        scope,
        isCurrentSharedScopeMember: h.principalCanWriteScope,
      });
    },

    membershipControlsScope: (scope) => h.membershipControlsScope(scope),

    authorizesCapabilityScope: async (claims) => h.authorizesCapabilityScope(claims),
  } satisfies Partial<App>;
}
