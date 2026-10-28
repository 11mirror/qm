import { SideChatAnchorError } from "./app-types.ts";
import { isSideChatAnchor } from "../sessions/side-chat.ts";
import { composeInstructions } from "../resolution/resolution-service.ts";
import { notifyDeploymentShared } from "../deploy/share-notice.ts";
import { deploymentShareScope } from "../deploy/email-access.ts";
import { acquireLeaseWithin } from "../sessions/session-store.ts";
import { type ScopeId, parseScopeId } from "../types.ts";
import { type NewItem } from "../sessions/items.ts";
import { cancelGoal, goalCancelledItem, openGoal } from "../harness/goal.ts";
import { cronRef, deployRef, encodeRef, fileRef, parseRef, skillRef, type ResourceRef } from "../acl/resource-ref.ts";
import { samePerson } from "../directory/person.ts";
import { AdminError } from "../admin/admin-service.ts";
import { type ArtifactHome } from "./artifact-share.ts";
import { randomUUID } from "node:crypto";
import { projectIdFromGroupRef } from "../projects/project-store.ts";

import { type App, InstructionsUpdateDeniedError, InstructionsVersionConflictError } from "./app-types.ts";
import { tenant } from "../tenant.ts";
import { withSessionTreeLock } from "../subagents/tree.ts";
import { type SessionKit, continuable, GOAL_CANCEL_LEASE_WAIT_MS, withProjectMembers } from "./app-session-kit.ts";

export function sessionLifecycleMethods(k: SessionKit) {
  const { deps, h, transcripts } = k;
  return {
    async updateSession(sessionId, principalId, patch) {
      const session = await h.sessionForViewer(sessionId, principalId);
      if (!session) return null;
      await deps.sessions.updateParticipantView(sessionId, principalId, patch);
      const updated = await h.sessionForViewer(sessionId, principalId);
      return updated && continuable(k, principalId, updated);
    },

    async detachSession(sessionId, principalId) {
      const session = await h.sessionForViewer(sessionId, principalId);
      if (!session?.parentSessionId || !(await h.principalCanWriteScope(principalId, session.scopeId))) return null;
      return withSessionTreeLock(deps.advisoryLock, deps.sessions, session, async () => {
        await deps.sessions.setParentSession(sessionId, null);
        return { detached: true as const };
      });
    },

    async cancelSessionGoal(sessionId, principalId) {
      const session = await h.sessionForViewer(sessionId, principalId);
      if (!session || !(await h.mayWriteSession(principalId, session))) return null;
      const currentGoal = async () => openGoal((await deps.sessions.goals([session.id])).get(session.id));
      const before = await currentGoal();
      if (!before) return { cancelled: false as const, reason: "no_open_goal" as const };
      let { lease } = await deps.sessions.acquireLease(session.id, "append");
      if (!lease) {
        if (before.status === "active")
          for (const run of await deps.runs.inFlightForThread(session.threadRef))
            if (run.status === "running")
              await deps.signals?.send(run.id, { kind: "abort", reason: "because its goal was cancelled" });
        ({ lease } = await acquireLeaseWithin(deps.sessions, session.id, "append", GOAL_CANCEL_LEASE_WAIT_MS));
      }
      if (!lease) return { cancelled: false as const, reason: "busy" as const };
      try {
        const goal = await currentGoal();
        if (!goal) return { cancelled: false as const, reason: "no_open_goal" as const };
        cancelGoal(goal, "Cancelled from the goal bar.");
        await deps.sessions.setGoal(lease, goal, [goalCancelledItem(goal, principalId)]);
        return { cancelled: true as const };
      } finally {
        await deps.sessions.releaseLease(lease);
      }
    },

    async regenerateTitle(sessionId, principalId) {
      const session = await h.sessionForViewer(sessionId, principalId);
      if (!session) return null;
      const parsed = parseScopeId(session.scopeId);
      const projectMembers = parsed.kind === "group" ? await deps.projects?.members(parsed.ref) : undefined;
      return deps.orchestrator.regenerateTitle(sessionId, principalId, projectMembers);
    },

    async forkSession(sessionId, principalId, opts) {
      if (!(await h.sessionForViewer(sessionId, principalId))) return null;
      const source = await deps.sessions.get(sessionId);
      if (!source) return null;
      const parsed = parseScopeId(source.scopeId);
      const fork = async (projectMembers?: readonly string[]) => {
        let visible = (await transcripts.forViewer(sessionId, principalId)).items;
        if (projectMembers?.length) {
          const views = await Promise.all(
            projectMembers.map(async (memberId) => (await transcripts.forViewer(sessionId, memberId)).items),
          );
          const seqSets = views.map((view) => new Set(view.map((entry) => entry.seq)));
          visible = visible.filter((entry) => seqSets.every((seqs) => seqs.has(entry.seq)));
        }
        const upToSeq = opts?.upToSeq;
        const copied = upToSeq === undefined ? visible : visible.filter((entry) => entry.seq <= upToSeq);
        if (
          opts?.sideChat &&
          (!isSideChatAnchor(opts.sideChat) || !copied.some((entry) => entry.seq === opts.sideChat!.entrySeq))
        )
          throw new SideChatAnchorError();
        const threadRef = `web:${principalId}:${randomUUID()}`;
        const forked = await deps.sessions.getOrCreateByThread(
          threadRef,
          source.type,
          source.scopeId,
          source.channelName,
          "web",
        );
        await Promise.all(
          (projectMembers ?? [principalId]).map((memberId) => deps.sessions.addParticipant(forked.id, memberId)),
        );
        const { lease } = await deps.sessions.acquireLease(forked.id, "fork");
        if (!lease) throw new Error(`fork: could not lease fresh session ${forked.id}`);
        let forkBoundarySeq: number | null;
        try {
          const copiedEntries = await deps.sessions.appendMany(
            lease,
            copied.map(({ sessionId: _s, seq: _q, createdAt: _c, targetSeq: _t, ...item }) => item as NewItem),
          );
          forkBoundarySeq = copiedEntries.at(-1)?.seq ?? null;
        } finally {
          await deps.sessions.releaseLease(lease);
        }
        if (forkBoundarySeq !== null) {
          await deps.sessions.updateForkProvenance(forked.id, {
            forkedFrom: { sessionId, title: source.title ?? null },
            forkBoundarySeq,
            ...(opts?.sideChat ? { sideChat: { ...opts.sideChat, expanded: false } } : {}),
          });
        }
        const sourceTitle = source.title?.trim();
        if (sourceTitle && projectMembers === undefined)
          await deps.sessions.updateTitle(forked.id, `${sourceTitle} (fork)`);
        h.audit(principalId, "session.fork", sessionId, source.scopeId);
        const session = await continuable(k, principalId, (await deps.sessions.get(forked.id)) ?? forked);
        return { session, items: (await transcripts.forRender(forked.id)).items };
      };
      if (parsed.kind !== "group" || !projectIdFromGroupRef(parsed.ref)) return fork();
      return withProjectMembers(k, parsed.ref, principalId, (members) => fork(members));
    },

    async spawnSession(principalId, opts) {
      const scope = opts.scopeId;
      const parsed = parseScopeId(scope);
      const create = async (projectMembers?: readonly string[], channelName?: string) => {
        const threadRef = `web:${principalId}:${randomUUID()}`;
        const kind = parsed.kind === "group" || parsed.kind === "channel" ? parsed.kind : "dm";
        const session = await deps.sessions.getOrCreateByThread(threadRef, kind, scope, channelName, "web");
        await Promise.all(
          (projectMembers ?? [principalId]).map((memberId) => deps.sessions.addParticipant(session.id, memberId)),
        );
        if (opts.title?.trim()) await deps.sessions.updateTitle(session.id, opts.title.trim());
        h.audit(principalId, "session.spawn", session.id, scope);
        return { session: await continuable(k, principalId, (await deps.sessions.get(session.id)) ?? session) };
      };
      if (parsed.kind === "personal") {
        return parsed.ref === principalId ? create() : null;
      }
      if (parsed.kind === "group" && projectIdFromGroupRef(parsed.ref))
        return withProjectMembers(k, parsed.ref, principalId, (members, project) => create(members, project.name));
      if (!(await h.principalCanAccessCurrentScope(principalId, scope))) return null;
      return create();
    },

    async discardSession(sessionId, principalId) {
      const session = await h.sessionForViewer(sessionId, principalId);
      if (!session) return false;
      if (!(await deps.sessions.deleteSessionIfEmpty(sessionId))) return false;
      h.audit(principalId, "session.discard", sessionId, session.scopeId);
      return true;
    },
  } satisfies Partial<App>;
}

export function artifactMethods(k: SessionKit) {
  const { deps, h } = k;
  return {
    async grant(g) {
      if (parseRef(g.ref).kind === "deploy") {
        g = {
          ...g,
          granteeScopeId: await deploymentShareScope(
            g.granteeScopeId,
            g.permission,
            async (email) =>
              deps.identity.isInternal(deps.identity.classify(email)) &&
              (await h.directoryMember(email))?.type === "internal",
          ),
        };
        await deps.deploy.assertShareAllowed(g.ownerScopeId, g.granteeScopeId, g.permission);
      }
      await deps.acl.grant(g, await h.artifactAuthor(g.ownerScopeId, g.ref));
      h.audit(g.grantedBy, "grant", g.ref, g.granteeScopeId);
      const ref = parseRef(g.ref);
      if (ref.kind === "deploy")
        await notifyDeploymentShared(
          deps,
          deps.deploy.getDeployment(ref.id),
          g.granteeScopeId,
          g.permission,
          g.grantedBy,
        );
    },
    async promoteSkill(id, targetScopeId, actorId, liveActor) {
      if (parseScopeId(targetScopeId).kind !== "org")
        throw new Error("promote targets the org scope — use share or move for anything narrower");
      if (liveActor !== true)
        throw new AdminError(403, "promoting a skill org-wide takes a live person, never an autonomous trigger");
      if (!deps.admin) throw new Error("org promotion requires an admin service");
      const status = await deps.admin.adminStatusOf({ id: actorId, type: "internal" });
      if (!status.isAdmin) throw new AdminError(403, "only an org admin can promote a skill org-wide");
      const promoted = await deps.skills.promote(id, targetScopeId);
      h.audit(actorId, "skill_promote", id, targetScopeId);
      return promoted;
    },

    belongsToScope: (principalId, scope) => h.principalCanAccessCurrentScope(principalId, scope),

    canManageArtifactHome: (homeScopeId, createdBy, principalId) =>
      h.principalManagesArtifactHome(homeScopeId, createdBy, principalId),

    artifactGrantPermission: (ownerScopeId, ref, principalId) =>
      h.artifactGrantPermission(ownerScopeId, ref, principalId),

    async getArtifactHome(type, idOrName): Promise<ArtifactHome | null> {
      const home = (a: { id: string; createdBy: string }, ownerScopeId: ScopeId, ref: ResourceRef) => ({
        id: a.id,
        ownerScopeId,
        createdBy: a.createdBy,
        grantRef: encodeRef(ref),
      });
      if (type === "skill") {
        const s = await deps.skills.get(idOrName);
        return s ? home(s, s.scopeId, skillRef(s.id)) : null;
      }
      if (type === "cron") {
        const c = await deps.crons.get(idOrName);
        return c ? home(c, c.ownerScopeId, cronRef(c.id)) : null;
      }
      if (type === "file") {
        const f = await deps.files.get(idOrName);
        return f ? home(f, f.ownerScopeId, fileRef(f.id)) : null;
      }
      const d = await deps.deploy.getDeployment(idOrName);
      return d ? home(d, d.ownerScopeId, deployRef(d.id)) : null;
    },

    async moveArtifactHome(type, id, toScope, movedBy) {
      if (type === "deploy") {
        await deps.deploy.transferDeploymentOwner(id, toScope, { callerId: movedBy });
        return;
      }
      if (type !== "skill") {
        throw new Error(`moving a ${type}'s home isn't supported — share it instead (add a grant)`);
      }
      await deps.skills.move(id, toScope);
      h.audit(movedBy, "skill_move", id, toScope);
    },

    getInstructions(scopeIdValue) {
      const orgScopeId = tenant().orgScope;
      const orgInstructions = deps.config.getInstructions(orgScopeId);
      const instructions = deps.config.getInstructions(scopeIdValue);
      return {
        scopeId: scopeIdValue,
        instructions,
        instructionsVersion: deps.config.instructionsVersion(scopeIdValue),
        orgScopeId,
        orgInstructions,
        orgInstructionsVersion: deps.config.instructionsVersion(orgScopeId),
        effectiveInstructions: composeInstructions(orgInstructions, scopeIdValue === orgScopeId ? null : instructions),
      };
    },

    async updateInstructions(scopeIdValue, content, actorId, opts) {
      const { kind, ref } = parseScopeId(scopeIdValue);
      const allowedPersonal = kind === "personal" && samePerson(ref, actorId);
      const allowedShared = opts?.allowSharedScope && (kind === "channel" || kind === "group");
      if (!allowedPersonal && !allowedShared) {
        throw new InstructionsUpdateDeniedError();
      }
      const write = async (): Promise<number> => {
        let snapshot: Awaited<ReturnType<typeof deps.config.captureInstructionsSnapshot>> | undefined;
        try {
          await deps.config.refreshScope(scopeIdValue);
          snapshot = await deps.config.captureInstructionsSnapshot(scopeIdValue);
          const version =
            opts?.expectedVersion === undefined
              ? await deps.config.setInstructions(scopeIdValue, content, actorId)
              : await deps.config.setInstructionsIfVersion(scopeIdValue, opts.expectedVersion, content, actorId);
          if (version === null) throw new InstructionsVersionConflictError();
          h.audit(actorId, "soul_update", scopeIdValue, scopeIdValue);
          return version;
        } catch (error) {
          if (snapshot !== undefined) deps.config.restoreInstructionsCacheSnapshot(scopeIdValue, snapshot);
          if (opts?.expectedVersion !== undefined) await deps.config.refreshScope(scopeIdValue);
          throw error;
        }
      };
      return deps.advisoryLock.withLock(`admin-governance:${scopeIdValue}`, write);
    },
  } satisfies Partial<App>;
}
